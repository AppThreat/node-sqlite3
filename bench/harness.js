// The measurement engine for the v9 benchmark suite. Dependency-free by
// design (Deliverable 13 §2.1): node:perf_hooks for the clock, ~a hundred
// lines of statistics, and nothing else.
//
// The harness is built to refuse rather than misreport. Every case is
// sampled N times and reduced to a median with a bootstrap 95% confidence
// interval; the relative margin of error (RME) is half that interval over
// the median. A case whose RME exceeds the threshold is reported as
// REJECTED with its RME instead of a number that looks trustworthy — the
// failure mode this whole design exists to prevent is a quiet wrong
// number, not a loud missing one.
import { performance } from 'node:perf_hooks';

/**
 * A small deterministic PRNG (mulberry32) so bootstrap confidence
 * intervals are reproducible from the same sample set and seed.
 *
 * @param {number} seed 32-bit integer seed.
 * @returns {() => number} uniform pseudo-random values in [0, 1).
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Median of a numeric sample set.
 *
 * @param {number[]} xs samples.
 * @returns {number} the median (mean of the two central values for even n).
 */
export function median(xs) {
    if (xs.length === 0) throw new Error('median of empty sample set');
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Percentile of a numeric sample set with linear interpolation between
 * adjacent ranks.
 *
 * @param {number[]} xs samples.
 * @param {number} p percentile in [0, 1].
 * @returns {number} the interpolated percentile value.
 */
export function percentile(xs, p) {
    if (xs.length === 0) throw new Error('percentile of empty sample set');
    const sorted = [...xs].sort((a, b) => a - b);
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Mean of a numeric sample set.
 *
 * @param {number[]} xs samples.
 * @returns {number} the arithmetic mean.
 */
export function mean(xs) {
    if (xs.length === 0) throw new Error('mean of empty sample set');
    let sum = 0;
    for (const x of xs) sum += x;
    return sum / xs.length;
}

/**
 * Bootstrap confidence interval for the median, and the relative margin of
 * error derived from it. The median is the headline statistic because GC
 * and JIT pauses make the mean tail-sensitive; bootstrapping propagates
 * the sample spread into an honest interval around it.
 *
 * RME = (ciHigh - ciLow) / 2 / median, as a fraction of the median.
 *
 * @param {number[]} xs samples (n >= 2).
 * @param {number} resamples bootstrap resample count.
 * @param {() => number} rng seeded uniform [0,1) generator.
 * @returns {{ rme: number, ciLow: number, ciHigh: number }} interval over the sample values.
 */
export function bootstrapMedianRme(xs, resamples, rng) {
    const n = xs.length;
    if (n < 2) {
        return { rme: Number.POSITIVE_INFINITY, ciLow: xs[0], ciHigh: xs[0] };
    }
    const medians = new Array(resamples);
    const pick = new Array(n);
    for (let r = 0; r < resamples; r++) {
        for (let i = 0; i < n; i++) pick[i] = xs[(rng() * n) | 0];
        medians[r] = median(pick);
    }
    medians.sort((a, b) => a - b);
    const ciLow = percentile(medians, 0.025);
    const ciHigh = percentile(medians, 0.975);
    const med = median(xs);
    return {
        rme: med > 0 ? (ciHigh - ciLow) / 2 / med : Number.POSITIVE_INFINITY,
        ciLow,
        ciHigh,
    };
}

/**
 * Full summary of one case's per-operation samples.
 *
 * @param {number[]} xs per-operation values (ms).
 * @param {{ seed?: number, resamples?: number }} [opts] bootstrap controls.
 * @returns {{ n: number, median: number, p95: number, min: number, max: number, mean: number, rme: number, ciLow: number, ciHigh: number }} reduced statistics.
 */
export function summarise(xs, opts) {
    const rng = mulberry32(opts?.seed ?? 0x5eed1337);
    const { rme, ciLow, ciHigh } = bootstrapMedianRme(
        xs,
        opts?.resamples ?? 2000,
        rng,
    );
    return {
        n: xs.length,
        median: median(xs),
        p95: percentile(xs, 0.95),
        min: Math.min(...xs),
        max: Math.max(...xs),
        mean: mean(xs),
        rme,
        ciLow,
        ciHigh,
    };
}

/** @typedef {Object} CaseSpec
 * @property {string} name case name, unique across the suite.
 * @property {string} group group heading the case is reported under.
 * @property {(env: any, n: number) => Promise<void> | void} iter performs `n` logical operations; timed once per sample. Sync paths run a tight loop with no awaits; async paths await each operation, because awaiting is the usage pattern being measured.
 * @property {() => Promise<any> | any} [setup] run once before warmup.
 * @property {(env: any) => Promise<void> | void} [teardown] run once after sampling.
 * @property {number} [ops] logical operations per single `iter` call at n=1 (per-op values divide by n*ops); default 1.
 * @property {number} [samples] override the sample count for this case.
 * @property {number} [targetSampleMs] override the per-sample duration target — for cases whose cost is dominated by OS-level jitter (journal/fsync churn), longer samples average more of it away.
 * @property {boolean} [alloc] also measure allocation per operation (forced-GC deltas).
 * @property {(env: any, n: number) => Promise<void> | void} [allocIter] iter variant that stores only its final iteration's output in `env.keep` — the retained-batch convention `measureAlloc` divides by; see its doc comment.
 * @property {number} [allocSamples] override the allocation sample count.
 * @property {string} [ratioTo] name of another case to publish an A/B ratio against.
 * @property {string} [note] one-line caveat printed with the case.
 */

/** @typedef {Object} HarnessConfig
 * @property {number} warmupMs fixed wall-clock warmup budget per case.
 * @property {number} targetSampleMs samples are scaled to roughly this duration.
 * @property {number} minSampleMs recalibrate if samples come in below this.
 * @property {number} samples sample count per case (>= 30 per §2.1).
 * @property {number} rmeThresholdPct reject cases whose RME exceeds this.
 * @property {number} allocSamples forced-GC allocation sample count per case.
 */

/** @type {HarnessConfig} */
export const DEFAULT_CONFIG = {
    warmupMs: 500,
    targetSampleMs: 20,
    minSampleMs: 10,
    samples: 32,
    rmeThresholdPct: 5,
    allocSamples: 16,
};

/**
 * Warms the iter path for a fixed wall-clock budget with a growing batch,
 * and returns the estimated cost of one logical operation.
 *
 * @param {CaseSpec} spec the case.
 * @param {any} env the case's setup value.
 * @param {number} budgetMs how long to warm up.
 * @param {number} floorOps minimum logical operations to have run.
 * @returns {Promise<number>} estimated ms per single operation.
 */
async function warmup(spec, env, budgetMs, floorOps) {
    const start = performance.now();
    let ran = 0;
    let n = 1;
    while (true) {
        await spec.iter(env, n);
        ran += n;
        const elapsed = performance.now() - start;
        if (elapsed >= budgetMs && ran >= floorOps) {
            return elapsed / ran;
        }
        // Grow the batch so the budget is reached in O(log) calls even for
        // sub-microsecond operations.
        n = Math.min(n * 2, 1 << 20);
    }
}

/**
 * Measures one case: warm up for a fixed wall-clock budget, auto-scale the
 * per-sample batch so each sample is >= 10 ms (making clock resolution
 * irrelevant), then take N samples and reduce them with `summarise`.
 *
 * @param {CaseSpec} spec the case.
 * @param {HarnessConfig} cfg harness configuration.
 * @returns {Promise<{ spec: CaseSpec, batch: number, perOpMs: ReturnType<typeof summarise>, sampleMs: number, rejected: boolean }>} the measurement.
 */
export async function measure(spec, cfg) {
    const env = spec.setup ? await spec.setup() : {};
    try {
        const perOpMs = await warmup(spec, env, cfg.warmupMs, 3);
        const target = spec.targetSampleMs ?? cfg.targetSampleMs;
        let batch = Math.max(1, Math.round(target / perOpMs));
        const ops = spec.ops ?? 1;
        const n = spec.samples ?? cfg.samples;

        /** @param {number} count @returns {Promise<number[]>} */
        const takeSamples = async (count) => {
            const perOp = [];
            for (let s = 0; s < count; s++) {
                const t0 = performance.now();
                await spec.iter(env, batch);
                perOp.push((performance.now() - t0) / (batch * ops));
            }
            return perOp;
        };

        let perOp = await takeSamples(Math.min(n, 4));

        // One recalibration pass: if warm-up made the estimate stale and
        // samples came out below the floor, rescale and start over.
        const observed = median(perOp) * batch * ops;
        if (observed > 0 && observed < cfg.minSampleMs) {
            batch = Math.max(1, Math.round((batch * target) / observed));
            perOp = await takeSamples(n);
        } else if (perOp.length < n) {
            perOp.push(...(await takeSamples(n - perOp.length)));
        }

        const stats = summarise(perOp);
        return {
            spec,
            batch,
            perOpMs: stats,
            sampleMs: stats.median * batch * ops,
            rejected: stats.rme * 100 > cfg.rmeThresholdPct,
        };
    } finally {
        if (spec.teardown) await spec.teardown(env);
    }
}

/** Allocation counters read per sample. `rss` is recorded but expected to
 * be too noisy to trust — publishing its rejection is part of the output. */
const ALLOC_COUNTERS = /** @type {const} */ ([
    'heapUsed',
    'external',
    'arrayBuffers',
    'rss',
]);

/**
 * Measures allocation per operation via process.memoryUsage() deltas
 * around a forced GC (--expose-gc). The convention that makes the delta
 * mean something: `allocIter` must store only its FINAL iteration's
 * output in `env.keep` (see bench/cases/read.js). The harness drops the
 * previous sample's `env.keep` and GCs before reading "before", runs
 * `reps` iterations, GCs again with the last output still live, and
 * reads "after" — so the delta is exactly one iteration's output.
 * Per-op bytes therefore divide by `ops` (one iteration), not `reps`.
 *
 * External buffers — the blob marshalling path (CellToJS in
 * src/convert.cc) — do not live in heapUsed at all; they surface in
 * `external` and `arrayBuffers`. Each counter is reduced with the same
 * median/RME treatment as time, and a counter whose RME exceeds the
 * threshold is reported as too noisy rather than published.
 *
 * @param {CaseSpec} spec the case.
 * @param {HarnessConfig} cfg harness configuration.
 * @returns {Promise<Record<string, { bytesPerOp: number, rme: number, rejected: boolean } | { skipped: string }>>} per-counter allocation stats, or a skip reason.
 */
export async function measureAlloc(spec, cfg) {
    if (typeof globalThis.gc !== 'function') {
        return { skipped: 'allocation needs --expose-gc' };
    }
    const env = spec.setup ? await spec.setup() : {};
    try {
        const iter = spec.allocIter ?? spec.iter;

        // Warm the alloc path, then calibrate reps like measure() does.
        const perOpMs = await warmup(spec, env, 100, 2);
        const reps = Math.max(1, Math.round(cfg.targetSampleMs / perOpMs));
        const n = spec.allocSamples ?? cfg.allocSamples;
        // One untimed call so the allocIter variant itself is warm.
        await iter(env, reps);

        const raw = {};
        for (const k of ALLOC_COUNTERS) raw[k] = [];
        for (let s = 0; s < n; s++) {
            env.keep = null;
            globalThis.gc();
            globalThis.gc();
            const before = process.memoryUsage();
            await iter(env, reps);
            globalThis.gc();
            globalThis.gc();
            const after = process.memoryUsage();
            for (const k of ALLOC_COUNTERS) {
                // Retained-batch convention: the delta is one iteration's
                // retained output, so the divisor is one iteration's ops.
                raw[k].push((after[k] - before[k]) / (spec.ops ?? 1));
            }
        }

        const out = {};
        for (const k of ALLOC_COUNTERS) {
            const stats = summarise(raw[k]);
            const zero = raw[k].every((v) => v === 0);
            out[k] = {
                bytesPerOp: stats.median,
                rme: stats.rme,
                // `zero` marks a counter that provably moved by nothing —
                // a real answer ("no allocation on this counter"), unlike
                // `rejected`, which means "moved, but too erratically to
                // attach a number to".
                zero,
                rejected: !zero && stats.rme * 100 > cfg.rmeThresholdPct,
            };
        }
        return out;
    } finally {
        if (spec.teardown) await spec.teardown(env);
    }
}

/**
 * The noise floor: the same case measured twice in the same run, as a
 * relative difference. Any A/B ratio smaller than this is indistinguishable
 * from measuring nothing and must not be reported as a result.
 *
 * @param {{ perOpMs: { median: number } }} a first measurement.
 * @param {{ perOpMs: { median: number } }} b second measurement of the same case.
 * @returns {{ relativePct: number }} the relative difference, in percent.
 */
export function noiseFloor(a, b) {
    const x = a.perOpMs.median;
    const y = b.perOpMs.median;
    const ref = (x + y) / 2;
    return {
        relativePct:
            ref > 0 ? (Math.abs(y - x) / ref) * 100 : Number.POSITIVE_INFINITY,
    };
}
