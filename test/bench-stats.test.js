// Unit tests for the benchmark statistics engine (Deliverable 13). The
// harness's whole value is refusing to report numbers it cannot trust,
// so the gate itself is pinned here: deterministic seeded bootstraps,
// RME rejection of noisy samples, acceptance of clean ones, and the
// noise-floor/ratio logic that decides whether a difference counts as a
// result. These tests fail on release/v9 (the module is new).
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
    bootstrapMedianRme,
    DEFAULT_CONFIG,
    mean,
    measure,
    median,
    mulberry32,
    noiseFloor,
    percentile,
    summarise,
} from '../bench/harness.js';

describe('bench stats primitives', () => {
    it('median handles odd, even and unsorted input', () => {
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(median([4, 1, 3, 2]), 2.5);
        assert.equal(median([7]), 7);
    });

    it('median rejects an empty sample set loudly', () => {
        assert.throws(() => median([]), /empty/);
    });

    it('percentile interpolates between adjacent ranks', () => {
        // p50 of [1..4] via interpolation is 2.5; nearest-rank would give 2.
        assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
        assert.equal(percentile([1, 2, 3, 4], 0), 1);
        assert.equal(percentile([1, 2, 3, 4], 1), 4);
        assert.equal(percentile([10, 20], 0.25), 12.5);
    });

    it('mean matches hand arithmetic', () => {
        assert.equal(mean([1, 2, 3, 4]), 2.5);
        assert.equal(mean([5]), 5);
    });

    it('mulberry32 is deterministic per seed and varies across seeds', () => {
        const a1 = mulberry32(42);
        const a2 = mulberry32(42);
        const b1 = mulberry32(43);
        const seq = Array.from({ length: 8 }, () => a1());
        assert.deepEqual(
            seq,
            Array.from({ length: 8 }, () => a2()),
        );
        assert.notDeepEqual(
            seq,
            Array.from({ length: 8 }, () => b1()),
        );
        for (const v of seq) {
            assert.ok(v >= 0 && v < 1, `value out of [0,1): ${v}`);
        }
    });
});

describe('bootstrap RME gate', () => {
    it('a tight sample set produces a small RME and is not rejected', () => {
        const xs = [10, 10.1, 9.9, 10.05, 9.95, 10, 10.2, 9.8, 10.1, 9.9];
        const stats = summarise(xs);
        assert.ok(stats.rme < 0.05, `expected small RME, got ${stats.rme}`);
        assert.ok(stats.rme >= 0);
    });

    it('a wildly noisy sample set produces a large RME and is rejected by the threshold', () => {
        const xs = [5, 40, 8, 90, 6, 55, 7, 70, 5.5, 62];
        const stats = summarise(xs);
        assert.ok(
            stats.rme * 100 > DEFAULT_CONFIG.rmeThresholdPct,
            `expected RME above the gate, got ${(stats.rme * 100).toFixed(1)}%`,
        );
    });

    it('bootstrap is deterministic for the same samples and seed', () => {
        const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const first = bootstrapMedianRme(xs, 500, mulberry32(7));
        const second = bootstrapMedianRme(xs, 500, mulberry32(7));
        assert.equal(first.rme, second.rme);
        assert.equal(first.ciLow, second.ciLow);
        assert.equal(first.ciHigh, second.ciHigh);
    });

    it('RME is infinite for fewer than two samples or a zero median', () => {
        assert.equal(
            bootstrapMedianRme([3], 100, mulberry32(1)).rme,
            Number.POSITIVE_INFINITY,
        );
        // All-zero samples: median 0, so relative error is undefined.
        assert.equal(
            bootstrapMedianRme([0, 0, 0], 100, mulberry32(1)).rme,
            Number.POSITIVE_INFINITY,
        );
    });

    it('rejection in measure() follows the config threshold', async () => {
        // Bimodal random cost per iteration (0.02 ms or 4 ms, coin flip):
        // per-sample batches average a different mix every sample, so the
        // between-sample spread — what the RME gate measures — is large.
        // (A deterministic fast/slow alternation would NOT do: batches
        // larger than the alternation period average it away, which is
        // correct harness behaviour, not a gap.)
        const rng = mulberry32(1234);
        const noisy = {
            name: 'noisy',
            group: 't',
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const spinUntil =
                        performance.now() + (rng() < 0.5 ? 0.02 : 4);
                    while (performance.now() < spinUntil) {
                        /* spin */
                    }
                }
            },
        };
        const cfg = { ...DEFAULT_CONFIG, warmupMs: 60, samples: 32 };
        const result = await measure(noisy, cfg);
        assert.equal(result.rejected, true);
        assert.ok(
            result.perOpMs.rme * 100 > cfg.rmeThresholdPct,
            'rejected result must carry an RME above the gate',
        );
    });
});

describe('measure() auto-scaling', () => {
    it('scales the batch so each sample reaches the sample floor', async () => {
        let calls = 0;
        let perCallMs = 0.001; // start slow-ish, get faster after "JIT"
        const spec = {
            name: 'scale',
            group: 't',
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    calls++;
                    const spinUntil = performance.now() + perCallMs;
                    while (performance.now() < spinUntil) {
                        /* spin */
                    }
                    if (calls > 200) perCallMs = 0.0002;
                }
            },
        };
        const cfg = { ...DEFAULT_CONFIG, warmupMs: 60, samples: 8 };
        const result = await measure(spec, cfg);
        // The reported per-op median must be near the steady-state cost,
        // and samples must have been retaken at a sane batch size.
        assert.ok(result.batch >= 1);
        assert.ok(result.perOpMs.median > 0);
        assert.ok(
            result.perOpMs.median < 0.01,
            `per-op median should track the fast cost, got ${result.perOpMs.median} ms`,
        );
        assert.equal(result.perOpMs.n, 8);
    });

    it('divides per-op values by ops and reports the sample count', async () => {
        const spec = {
            name: 'ops',
            group: 't',
            ops: 10,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const spinUntil = performance.now() + 0.05;
                    while (performance.now() < spinUntil) {
                        /* spin */
                    }
                }
            },
        };
        const cfg = { ...DEFAULT_CONFIG, warmupMs: 20, samples: 6 };
        const result = await measure(spec, cfg);
        // ~0.05 ms per iteration of 10 ops -> ~0.005 ms/op.
        assert.ok(
            result.perOpMs.median > 0.002 && result.perOpMs.median < 0.009,
        );
        assert.equal(result.perOpMs.n, 6);
    });

    it('runs teardown even when iter throws', async () => {
        let toreDown = false;
        const spec = {
            name: 'boom',
            group: 't',
            iter: async () => {
                throw new Error('kaboom');
            },
            teardown: () => {
                toreDown = true;
            },
        };
        await assert.rejects(
            measure(spec, { ...DEFAULT_CONFIG, warmupMs: 10 }),
            /kaboom/,
        );
        assert.equal(toreDown, true);
    });
});

describe('noise floor', () => {
    it('reports zero for identical medians', () => {
        const a = { perOpMs: { median: 5 } };
        const b = { perOpMs: { median: 5 } };
        assert.equal(noiseFloor(a, b).relativePct, 0);
    });

    it('reports the symmetric relative difference', () => {
        const a = { perOpMs: { median: 10 } };
        const b = { perOpMs: { median: 11 } };
        // |11-10| / 10.5 = 9.52%
        assert.ok(Math.abs(noiseFloor(a, b).relativePct - 9.5238) < 0.01);
    });

    it('is infinite when both medians are zero (ratio undefined)', () => {
        const floor = noiseFloor(
            { perOpMs: { median: 0 } },
            { perOpMs: { median: 0 } },
        );
        assert.equal(floor.relativePct, Number.POSITIVE_INFINITY);
    });

    it('an A/A difference below the floor marks a ratio as noise, not a result', () => {
        // The exact logic bench/index.js applies to every printed ratio.
        const floorPct = 4; // measured A vs A this run
        const ratio = 1.02; // a 2% "difference"
        const withinNoise = Math.abs(ratio - 1) * 100 < floorPct;
        assert.equal(withinNoise, true);
        // ...and a real 8% difference clears a 4% floor:
        assert.equal(Math.abs(1.08 - 1) * 100 < floorPct, false);
    });
});
