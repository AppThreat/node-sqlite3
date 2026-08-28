// The v9 benchmark suite entry point (Deliverable 13).
//
//   node --expose-gc bench/index.js                  # run, print table + JSON
//   node --expose-gc bench/index.js --filter sync    # subset
//   node --expose-gc bench/index.js --compare        # vs bench/baseline.json (+ better-sqlite3 if installed)
//   node --expose-gc bench/index.js --write-baseline # regenerate this environment's baseline entry
//
// Design rule: the harness refuses rather than misreports. Cases whose
// relative margin of error exceeds the gate are REJECTED, ratios smaller
// than the same-run noise floor are marked as noise, and allocation
// counters too noisy to trust are published as exactly that.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';
import { buildSuite } from './cases/index.js';
import {
    DEFAULT_CONFIG,
    measure,
    measureAlloc,
    noiseFloor,
} from './harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(ROOT, 'bench', 'baseline.json');

/**
 * Parses the CLI flags this suite understands.
 *
 * @param {string[]} argv arguments after the script path.
 * @returns {{ filter: string[] | null, compare: boolean, baselinePath: string, writeBaseline: boolean, baselineFrom: string | null, jsonPath: string | null, strict: boolean, list: boolean }} parsed options.
 */
function parseArgs(argv) {
    /** @type {ReturnType<typeof parseArgs>} */
    const opts = {
        filter: null,
        compare: false,
        baselinePath: DEFAULT_BASELINE,
        writeBaseline: false,
        baselineFrom: null,
        jsonPath: null,
        strict: false,
        list: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        // pnpm forwards a bare `--` to the script rather than consuming
        // it, so `pnpm run bench:compare -- --json out.json` arrives with
        // the separator still in argv. Rejecting it made the CI bench step
        // exit 1 on a usage error and measure nothing — under
        // continue-on-error, silently.
        if (arg === '--') continue;
        if (arg === '--compare') opts.compare = true;
        else if (arg === '--write-baseline') opts.writeBaseline = true;
        else if (arg === '--baseline-from')
            opts.baselineFrom = argv[++i] ?? null;
        else if (arg === '--strict') opts.strict = true;
        else if (arg === '--list') opts.list = true;
        else if (arg === '--filter') {
            opts.filter = (argv[++i] ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        } else if (arg === '--baseline') {
            opts.baselinePath = argv[++i] ?? DEFAULT_BASELINE;
        } else if (arg === '--json') {
            opts.jsonPath = argv[++i] ?? null;
        } else {
            console.error(`unknown option: ${arg}`);
            console.error(USAGE);
            process.exit(1);
        }
    }
    return opts;
}

const USAGE = `usage: node --expose-gc bench/index.js [--filter substr[,substr...]] [--compare]
       [--baseline <path>] [--write-baseline] [--json <path>] [--strict] [--list]

  --compare         compare against the baseline (default bench/baseline.json)
                    and try to load better-sqlite3 as a mirror (never a
                    devDependency; npm i --no-save better-sqlite3 first)
  --write-baseline  write this run's results as the baseline entry for the
                    current platform/arch — a deliberate, separate act
  --baseline-from <results.json>
                    merge a recorded run's JSON output as the baseline entry
                    for ITS recorded environment (promote a CI artifact
                    without re-running there)
  --filter          run only cases whose name or group matches a substring
  --strict          exit non-zero if ANY case is rejected by the RME gate
  --json <path>     also write the JSON result block to a file

exit codes: 0 ok · 1 usage · 2 baseline regression(s) · 3 nothing measured`;

/**
 * Collects the pinned environment block (§2.1).
 *
 * @returns {Record<string, unknown>} environment description.
 */
function environment() {
    let gitSha = 'unknown';
    let gitDirty = false;
    try {
        gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: ROOT,
            encoding: 'utf8',
        }).trim();
        gitDirty =
            execFileSync('git', ['status', '--porcelain'], {
                cwd: ROOT,
                encoding: 'utf8',
            }).trim().length > 0;
    } catch {
        // not a git checkout — keep 'unknown'
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        container: existsSync('/.dockerenv') ? 'docker' : 'none',
        sqliteVersion: /** @type {any} */ (sqlite3).VERSION,
        packageVersion: pkg.version,
        gitSha: gitDirty ? `${gitSha}+dirty` : gitSha,
        exposeGc: typeof globalThis.gc === 'function',
    };
}

/**
 * Formats a per-operation duration for the human table.
 *
 * @param {number} ms milliseconds.
 * @returns {string} value with unit.
 */
function fmtDuration(ms) {
    if (ms < 0.001) return `${(ms * 1e6).toFixed(0)} ns`;
    if (ms < 1) return `${(ms * 1000).toFixed(2)} µs`;
    if (ms < 1000) return `${ms.toFixed(2)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Formats bytes per operation for the allocation table.
 *
 * @param {number} bytes bytes.
 * @returns {string} value with unit.
 */
function fmtBytes(bytes) {
    const sign = bytes < 0 ? '-' : '+';
    const abs = Math.abs(bytes);
    if (abs >= 1024 * 1024)
        return `${sign}${(abs / 1024 / 1024).toFixed(2)} MB`;
    if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
    return `${sign}${abs.toFixed(0)} B`;
}

/**
 * Formats a ratio for the ratios table.
 *
 * @param {number} r ratio.
 * @returns {string} formatted ratio.
 */
function fmtRatio(r) {
    if (!Number.isFinite(r)) return '∞';
    return `${r.toFixed(2)}×`;
}

/** @type {any[]} */ const results = [];
/** @type {{ case: string, alloc: any }[]} */ const allocResults = [];

/**
 * The main run: build fixtures, calibrate, measure every case, print.
 *
 * @returns {Promise<number>} process exit code.
 */
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const cfg = { ...DEFAULT_CONFIG };
    const env = environment();

    console.log('@appthreat/sqlite3 benchmark suite');
    console.log(
        `${env.node} | ${env.platform} | ${env.arch} | ${env.cpuModel} (${env.cpuCount} cpus)`,
    );
    console.log(
        `SQLite ${env.sqliteVersion} | package ${env.packageVersion} | git ${env.gitSha} | container: ${env.container}`,
    );
    console.log(
        `config: ${cfg.samples} samples/case, ${cfg.warmupMs} ms warmup, sample target ${cfg.targetSampleMs} ms (floor ${cfg.minSampleMs} ms), ` +
            `RME gate ${cfg.rmeThresholdPct}% (bootstrap 2000×, seeded), alloc samples ${cfg.allocSamples}`,
    );
    if (!env.exposeGc) {
        console.log(
            'WARNING: --expose-gc is off — allocation measurement will be skipped',
        );
    }
    console.log('');

    // Promotion path: --baseline-from merges an already-recorded run and
    // exits without measuring anything (used for CI artifacts).
    if (opts.baselineFrom) {
        promoteResultsToBaseline(opts.baselineFrom, opts.baselinePath);
        return 0;
    }

    const suite = await buildSuite(sqlite3, { compare: opts.compare });
    for (const skip of suite.skipped) console.log(`skipped: ${skip}`);
    if (suite.skipped.length > 0) console.log('');

    /** @type {any[]} */
    let cases = suite.cases;
    if (opts.filter) {
        cases = cases.filter(
            (c) =>
                opts.filter?.some(
                    (f) => c.name.includes(f) || c.group.includes(f),
                ) ?? false,
        );
    }

    if (opts.list) {
        for (const c of cases) console.log(`${c.group.padEnd(16)} ${c.name}`);
        await suite.dispose();
        return 0;
    }

    // Calibration: the first two cases are the A/A pair. Their same-run
    // difference is the noise floor every ratio is checked against.
    let floor = { relativePct: Number.POSITIVE_INFINITY };
    let lastGroup = '';

    for (const spec of cases) {
        if (spec.group !== lastGroup) {
            lastGroup = spec.group;
            console.log(
                `\n── ${spec.group} ${'─'.repeat(Math.max(1, 66 - spec.group.length))}`,
            );
        }
        /** @type {any} */
        let result;
        try {
            result = await measure(spec, cfg);
        } catch (err) {
            console.log(
                `  ERROR ${spec.name}: ${/** @type {Error} */ (err).message}`,
            );
            results.push({
                name: spec.name,
                group: spec.group,
                error: /** @type {Error} */ (err).message,
            });
            continue;
        }
        results.push(result);
        if (result.rejected) {
            // The range is disclosed on a rejection so a reader can still
            // see the magnitude — but no median is claimed for it.
            console.log(
                `  REJECTED ${spec.name}: RME ${(result.perOpMs.rme * 100).toFixed(1)}% exceeds ` +
                    `${cfg.rmeThresholdPct}% — no median reported (samples too noisy to trust; ` +
                    `observed ${fmtDuration(result.perOpMs.min)}–${fmtDuration(result.perOpMs.max)}/op)`,
            );
        } else {
            console.log(
                `  ${spec.name.padEnd(58)} ${fmtDuration(result.perOpMs.median).padStart(11)}/op` +
                    `  RME ${(result.perOpMs.rme * 100).toFixed(1)}%` +
                    `  p95 ${fmtDuration(result.perOpMs.p95)}` +
                    `  min ${fmtDuration(result.perOpMs.min)}` +
                    `  ×${result.batch}`,
            );
        }
        if (spec.note) console.log(`      · ${spec.note}`);

        if (spec.alloc) {
            const alloc = await measureAlloc(spec, cfg);
            allocResults.push({ case: spec.name, alloc });
        }

        if (
            results.length === 2 &&
            results[0].spec?.name === 'calibration/cached get (A)'
        ) {
            floor = noiseFloor(results[0], results[1]);
            console.log(
                `\n  noise floor: A vs A = ${floor.relativePct.toFixed(1)}% — ` +
                    'any smaller difference is noise, not a result\n',
            );
        }
    }

    // ── ratios ────────────────────────────────────────────────────────────
    const byName = new Map(
        results.filter((r) => r.spec).map((r) => [r.spec.name, r]),
    );
    /** @type {{ a: string, b: string, ratio: number, withinNoise: boolean }[]} */
    const ratios = [];
    for (const r of results) {
        if (!r.spec?.ratioTo || r.rejected) continue;
        const target = byName.get(r.spec.ratioTo);
        if (!target || target.rejected) continue;
        const ratio = target.perOpMs.median / r.perOpMs.median;
        const withinNoise = Math.abs(ratio - 1) * 100 < floor.relativePct;
        ratios.push({ a: r.spec.name, b: r.spec.ratioTo, ratio, withinNoise });
    }
    if (ratios.length > 0) {
        console.log(
            `\n── ratios (how much faster the case is than its target; must clear the ${floor.relativePct.toFixed(1)}% noise floor to count) ──`,
        );
        for (const r of ratios) {
            // ratio = target median ÷ case median: >1 means the case is
            // faster than its target, <1 means slower. The wording spells
            // out which, so an inverted-looking number cannot mislead.
            const faster = r.ratio >= 1;
            const magnitude = faster ? r.ratio : 1 / r.ratio;
            const word = faster ? 'faster' : 'slower';
            if (r.withinNoise) {
                console.log(
                    `  ${r.a.padEnd(58)} ${fmtRatio(magnitude).padStart(8)} ${word}  ~ within noise floor — not a result`,
                );
            } else {
                console.log(
                    `  ${r.a.padEnd(58)} ${fmtRatio(magnitude).padStart(8)} ${word} than ${r.b}`,
                );
            }
        }
    }

    // ── allocation ────────────────────────────────────────────────────────
    if (allocResults.length > 0) {
        console.log(
            '\n── allocation per op (forced-GC process.memoryUsage() deltas; heapUsed misses external buffers — watch external/arrayBuffers) ──',
        );
        for (const { case: name, alloc } of allocResults) {
            console.log(`  ${name}`);
            if ('skipped' in alloc) {
                console.log(`      skipped: ${alloc.skipped}`);
                continue;
            }
            for (const [counter, stats] of Object.entries(alloc)) {
                const s = /** @type {any} */ (stats);
                const line = `      ${counter.padEnd(13)} ${fmtBytes(s.bytesPerOp).padStart(11)}/op`;
                if (s.zero) {
                    console.log(`${line}  — nothing allocated on this counter`);
                } else if (s.rejected) {
                    console.log(
                        `${line}  RME ${(s.rme * 100).toFixed(0)}%  ✗ too noisy to publish`,
                    );
                } else {
                    console.log(`${line}  RME ${(s.rme * 100).toFixed(0)}%`);
                }
            }
        }
    }

    // ── JSON ─────────────────────────────────────────────────────────────
    const doc = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        environment: env,
        config: cfg,
        noiseFloorPct: Number.isFinite(floor.relativePct)
            ? Number(floor.relativePct.toFixed(2))
            : null,
        cases: results.map((r) =>
            r.spec
                ? {
                      name: r.spec.name,
                      group: r.spec.group,
                      ops: r.spec.ops ?? 1,
                      batch: r.batch,
                      perOpMs: {
                          median: r.perOpMs.median,
                          p95: r.perOpMs.p95,
                          min: r.perOpMs.min,
                          mean: r.perOpMs.mean,
                          rme: r.perOpMs.rme,
                          ciLow: r.perOpMs.ciLow,
                          ciHigh: r.perOpMs.ciHigh,
                          n: r.perOpMs.n,
                      },
                      rejected: r.rejected,
                      error: undefined,
                  }
                : { name: r.name, group: r.group, error: r.error },
        ),
        ratios,
        allocations: allocResults,
    };
    const json = JSON.stringify(doc, null, 2);
    if (opts.jsonPath) writeFileSync(opts.jsonPath, `${json}\n`);
    console.log('\n── results.json ──');
    console.log(json);

    // ── baseline write / compare ─────────────────────────────────────────
    let exitCode = 0;
    const sig = `${env.platform}-${env.arch}`;
    const measured = results.filter((r) => r.spec && !r.rejected && !r.error);
    if (opts.writeBaseline) {
        const cases = Object.fromEntries(
            measured.map((r) => [
                r.spec.name,
                {
                    medianPerOpMs: r.perOpMs.median,
                    rme: r.perOpMs.rme,
                    n: r.perOpMs.n,
                },
            ]),
        );
        writeBaselineEntry(opts.baselinePath, sig, {
            capturedAt: doc.generatedAt,
            environment: env,
            config: cfg,
            noiseFloorPct: doc.noiseFloorPct,
            cases,
        });
        console.log(
            `\nbaseline written: ${sig} → ${measured.length} cases (${opts.baselinePath})`,
        );
    }

    if (opts.compare) {
        exitCode = compareBaseline(
            opts.baselinePath,
            sig,
            measured,
            floor,
            cfg,
        );
    }

    await suite.dispose();

    const rejectedCount = results.filter((r) => r.rejected).length;
    if (measured.length === 0) {
        console.log('\nNOTHING MEASURED: every case was rejected or errored');
        exitCode = exitCode === 2 ? 2 : 3;
    } else if (opts.strict && rejectedCount > 0) {
        console.log(
            `\n--strict: ${rejectedCount} case(s) rejected by the RME gate`,
        );
        exitCode = exitCode === 2 ? 2 : 3;
    }

    return exitCode;
}

const BASELINE_NOTE =
    'Per-environment medians captured deliberately via `pnpm run bench:update`. ' +
    'Compare only within one platform-arch signature; ratios travel across ' +
    'platforms, absolute milliseconds do not. See docs/performance.md.';

/**
 * Upserts one environment entry in the baseline file.
 *
 * @param {string} path baseline file path.
 * @param {string} sig environment signature (platform-arch).
 * @param {{ capturedAt: string, environment: Record<string, unknown>, config: Record<string, unknown>, noiseFloorPct: number | null, cases: Record<string, { medianPerOpMs: number, rme: number, n: number }> }} entry the entry to write.
 * @returns {void}
 */
function writeBaselineEntry(path, sig, entry) {
    /** @type {any} */
    let baseline = { schemaVersion: 1, note: BASELINE_NOTE, environments: {} };
    if (existsSync(path)) {
        try {
            baseline = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
            console.error(`baseline file unreadable, starting fresh: ${path}`);
        }
    }
    baseline.environments ??= {};
    baseline.environments[sig] = entry;
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/**
 * Merges a recorded results JSON (from --json) into the baseline as the
 * entry for the environment it was recorded on — the promote-a-CI-artifact
 * path, so a linux-x64 baseline can be captured on a runner without
 * anyone hand-editing the file.
 *
 * @param {string} resultsPath path to a results JSON file.
 * @param {string} baselinePath baseline file path.
 * @returns {void}
 */
function promoteResultsToBaseline(resultsPath, baselinePath) {
    const doc = /** @type {any} */ (
        JSON.parse(readFileSync(resultsPath, 'utf8'))
    );
    const e = doc.environment ?? {};
    const sig = `${e.platform}-${e.arch}`;
    const cases = {};
    for (const c of doc.cases ?? []) {
        if (c.perOpMs && !c.rejected && !c.error) {
            cases[c.name] = {
                medianPerOpMs: c.perOpMs.median,
                rme: c.perOpMs.rme,
                n: c.perOpMs.n,
            };
        }
    }
    writeBaselineEntry(baselinePath, sig, {
        capturedAt: doc.generatedAt,
        environment: e,
        config: doc.config,
        noiseFloorPct: doc.noiseFloorPct ?? null,
        cases,
    });
    console.log(
        `\nbaseline merged from ${resultsPath}: ${sig} → ${Object.keys(cases).length} cases (${baselinePath})`,
    );
}

/**
 * Compares this run's medians against the baseline entry for the current
 * environment signature. FAIL needs Δ > max(10%, 2× the run's noise
 * floor) so a noisy run cannot manufacture a regression verdict.
 *
 * @param {string} path baseline file path.
 * @param {string} sig environment signature (platform-arch).
 * @param {any[]} measured non-rejected results.
 * @param {{ relativePct: number }} floor this run's noise floor.
 * @param {any} cfg harness config.
 * @returns {number} 2 when regression(s) were found, else 0.
 */
function compareBaseline(path, sig, measured, floor, _cfg) {
    if (!existsSync(path)) {
        console.log(
            `\nbaseline comparison: no baseline file at ${path} — reporting only`,
        );
        return 0;
    }
    /** @type {any} */
    let baseline;
    try {
        baseline = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        console.log(
            `\nbaseline comparison: unreadable baseline (${/** @type {Error} */ (err).message})`,
        );
        return 0;
    }
    const entry = baseline.environments?.[sig];
    if (!entry) {
        console.log(
            `\nbaseline comparison: no entry for ${sig} (have: ${Object.keys(baseline.environments ?? {}).join(', ') || 'none'}) — reporting only.\n` +
                'To make this environment comparable, run `pnpm run bench:update` and commit the file.',
        );
        return 0;
    }

    const failGate = Math.max(
        10,
        2 * (Number.isFinite(floor.relativePct) ? floor.relativePct : 0),
    );

    // Whole-machine drift, reported but deliberately NOT applied.
    //
    // The problem it describes is real: the A/A noise floor measures
    // variance *within* one process and is blind to the machine being
    // globally slower than when the baseline was captured. The first
    // committed baseline was captured on an exceptionally quiet run (its
    // recorded floor: 0.17%, against 1.6–3.4% for ordinary runs), and
    // re-running the unmodified tree against it produced 38 FAIL / 37 WARN
    // of 85. That is fixed by capturing baselines from representative runs,
    // not by arithmetic here — with a representative baseline the same tree
    // reports 0 FAIL.
    //
    // Dividing the calibration delta out as a drift correction was tried
    // and is unsound: `calibration/cached get` reads a row, so it runs the
    // same marshalling path most cases do. A real regression slows the
    // control too, the "drift" factor absorbs part of the regression, and
    // the correction subtracts it from every case. Measured: a 512 B
    // per-integer-cell pessimisation in CellToJS read +19–24% FAIL
    // uncorrected and collapsed to +6.1% WARN once corrected. A control
    // that shares the hot path cannot normalise that path.
    //
    // So the number is printed as a diagnostic — a large value means the
    // two runs are not comparable and the answer is a rerun — and every
    // verdict below is taken against the raw baseline.
    const calibration = measured
        .filter(
            (r) => r.spec.group === 'calibration' && entry.cases?.[r.spec.name],
        )
        .map((r) => r.perOpMs.median / entry.cases[r.spec.name].medianPerOpMs)
        .sort((a, b) => a - b);
    const driftPct = calibration.length
        ? (calibration[calibration.length >> 1] - 1) * 100
        : Number.NaN;
    console.log(
        `\n── vs baseline ${sig} (${entry.capturedAt}, git ${entry.environment?.gitSha ?? '?'}) — FAIL at >${failGate.toFixed(0)}%, WARN at >5% ──`,
    );
    if (calibration.length) {
        console.log(
            `  calibration vs baseline: ${driftPct >= 0 ? '+' : ''}${driftPct.toFixed(1)}% ` +
                '(diagnostic only, NOT applied to the deltas below — the ' +
                'calibration case shares the marshalling path, so a real ' +
                'regression moves it too)',
        );
        if (Math.abs(driftPct) > 10) {
            console.log(
                '  NOTE: calibration should barely move between runs. This much ' +
                    'means either the machine drifted or the change under test ' +
                    'reaches the read path — reread the per-case pattern below ' +
                    'rather than any single verdict, and rerun on a quiet machine.',
            );
        }
    }
    /** @type {string[]} */
    const failures = [];
    /** @type {string[]} */
    const warnings = [];
    let unmeasured = 0;
    let compared = 0;
    for (const r of measured) {
        const base = entry.cases?.[r.spec.name];
        if (!base) continue;
        compared++;
        const delta =
            ((r.perOpMs.median - base.medianPerOpMs) / base.medianPerOpMs) *
            100;
        const mark =
            delta > failGate
                ? 'FAIL'
                : delta > 5
                  ? 'WARN'
                  : delta < -5
                    ? 'improved'
                    : 'ok';
        if (delta > failGate) failures.push(r.spec.name);
        else if (delta > 5) warnings.push(r.spec.name);
        console.log(
            `  ${String(mark).padEnd(8)} ${r.spec.name.padEnd(58)} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`,
        );
    }
    for (const [name, base] of Object.entries(entry.cases ?? {})) {
        const cur = measured.find((r) => r.spec.name === name);
        if (!cur) {
            unmeasured++;
            console.log(
                `  UNMEASURED ${name} (baseline ${/** @type {any} */ (base).medianPerOpMs?.toExponential(2)} ms/op — not run or rejected here)`,
            );
        }
    }
    console.log(
        `\nbaseline summary: ${compared} compared, ${failures.length} fail, ${warnings.length} warn, ${unmeasured} unmeasured`,
    );
    return failures.length > 0 ? 2 : 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
