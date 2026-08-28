# Performance

This document explains what the benchmark suite measures, how to
reproduce every figure in it, and — just as important — where this
package is slower than the alternatives. Every number below was produced
by `pnpm run bench`; nothing is hand-timed.

- [Method](#method)
- [The noise floor](#the-noise-floor)
- [Headline numbers (arm64 macOS)](#headline-numbers-arm64-macos)
- [Linux (arm64, Debian container)](#linux-arm64-debian-container)
- [When to use which API](#when-to-use-which-api)
- [Where this package loses](#where-this-package-loses)
- [Allocation per operation](#allocation-per-operation)
- [CI posture](#ci-posture)
- [Limits of these numbers](#limits-of-these-numbers)

## Method

```sh
pnpm run bench            # run the suite, print the table and JSON
pnpm run bench:compare    # also compare against bench/baseline.json
pnpm run bench:update     # regenerate this machine's baseline entry
```

`bench/index.js --help` documents the flags (`--filter`, `--json`,
`--strict`, `--compare`, `--baseline-from`). The suite is
dependency-free: `node:perf_hooks`, `node:test` conventions and ~a
hundred lines of statistics.

For each case, the harness:

1. **Warms up** for a fixed 500 ms wall-clock budget (JIT tiering,
   statement caches, sqlite page cache).
2. **Auto-scales the batch** so one sample is at least 10 ms (target
   20 ms), which makes clock resolution irrelevant.
3. Takes **32 samples** (a few long-running cases use fewer, by
   construction, and say so).
4. Reports the **median**, p95 and min of the per-operation values, and a
   **bootstrap 95% confidence interval** around the median (2,000
   resamples, seeded, so the interval is reproducible). The relative
   margin of error (RME) is half the interval over the median.
5. **Rejects** any case whose RME exceeds 5%. A rejected case is printed
   as `REJECTED` with its RME and observed range — no median is claimed
   for it. A benchmark that reports a number nobody should trust looks
   exactly like one that works; refusing is the only defence.

The environment is pinned in every output: Node version, platform, arch,
CPU model, SQLite version (`sqlite3.VERSION`), package version, git SHA
and whether `--expose-gc` was active.

### The noise floor

Before anything else, the harness measures **the same case twice** (two
identical connections, the `calibration/cached get (A)`/`(B)` pair) and
prints their relative difference. That is the run's noise floor. Every
A-vs-B ratio the harness prints is checked against it: a ratio smaller
than the floor is marked `~ within noise floor — not a result`. In the
runs below the floor was 0.2–4.3% on macOS; a *filtered* run without the
calibration pair reports no floor and suppresses all ratios, because they
cannot be validated.

The baseline comparison applies the same guard: a FAIL needs a regression
larger than `max(10%, 2× the run's noise floor)`, so a noisy run cannot
manufacture a regression verdict.

## Headline numbers (arm64 macOS)

Environment: Node v26.7.0, darwin/arm64, Apple M4 Pro (14 cpus), SQLite
3.53.4, `@appthreat/sqlite3` 9.0.0. Full output of a representative run
is reproduced in the deliverable handoff; the tables here are the same
numbers. **Ratios are what travel across platforms; absolute
milliseconds do not** — see [Linux](#linux-arm64-debian-container) for
how much the absolutes move.

### Sync vs async — the claim README used to make

README v9 previously said the sync methods are "roughly 6x faster than
the async equivalents for interactive lookups", a figure from a
one-sample harness. Measured properly (both sides using the statement
cache, batch of N sequential operations, per-op medians):

| Case | async | sync | sync advantage |
|---|---|---|---|
| `get`, batch of 1 | 10.0 µs/op | 1.27 µs/op | **7.9×** |
| `get`, batch of 10 | 10.4 µs/op | 1.31 µs/op | **8.0×** |
| `get`, batch of 100 | 9.9 µs/op | 1.33 µs/op | **7.4×** |
| `get`, batch of 10,000 | 9.6 µs/op | 1.31 µs/op | **7.3×** |
| `run`, batch of 1 | 11.4 µs/op | 1.67 µs/op | **6.8×** |
| `run`, batch of 10 | 9.8 µs/op | 1.13 µs/op | **8.7×** |
| `run`, batch of 100 | 9.8 µs/op | 1.13 µs/op | **8.7×** |
| `run`, batch of 10,000 | 9.9 µs/op | 1.14 µs/op | **8.7×** |
| `all`, 20,000 rows × 4 cols | 844 ns/row | 815 ns/row | 1.04× — *within the run's noise floor* |

Case RMEs were 0.2–1.6%; the ratio spread across three full runs was
±0.5×. So the honest claim is: **7–8× for single-row interactive
lookups and writes, flat from 1 to 10,000 operations — and no advantage
at all for large result sets**, because one threadpool round trip is
amortised across every row. The README now says exactly this. The old
"6x" was directionally right and under-claimed for `run`; it came from a
harness that took one sample.

The async per-op cost (~10 µs) is dominated by the threadpool round
trip, which is what the sync path avoids; it does not grow with batch
size, which is why the ratio is flat.

### Reads (per row)

| Case | median | RME |
|---|---|---|
| `all`: 1,000 rows × 1 col | 247 ns | 0.3% |
| `all`: 20,000 rows × 1 col | 225 ns | 0.3% |
| `all`: 200,000 rows × 1 col | 241 ns | 2.5% |
| `all`: 1,000 rows × 4 cols | 832 ns | 0.7% |
| `all`: 20,000 rows × 4 cols | 844 ns | 1.6% |
| `all`: 200,000 rows × 4 cols | 880 ns | 0.7% |
| `all`: 1,000 rows × 16 cols | 2.12 µs | 0.2% |
| `all`: 20,000 rows × 16 cols | 2.25 µs | 1.0% |
| `all`: 200,000 rows × 16 cols | 2.26 µs | 1.0% |
| `all`: 20,000 × 8 cols **wide text** (~100 chars) | 1.48 µs | 2.1% |
| `all`: 20,000 × 8 cols **mostly NULL** | 927 ns | 0.8% |
| `each`: 20,000 × 4 | 696 ns | 0.8% |
| `iterate` (`for await`): 20,000 × 4 | 877 ns | 0.5% |
| `map`: 20,000 × 4 | 229 ns | 0.8% |
| `get` single row (prepared statement) | 7.56 µs | 1.8% |

Notes: per-row cost is flat from 20k to 200k rows (no hidden
super-linear term). `each` beats `all` per row (no result array);
`iterate` pays ~25% over `all` for backpressure machinery. `map` is
cheapest per row because its single-column output is smaller — compare
like with like.

### Marshalling (single column, 20,000 rows, `allSync`)

| Value type | median/row | RME |
|---|---|---|
| INTEGER (mode `number`) | 232 ns | 0.6% |
| INTEGER (mode `mixed`) | 233 ns | 0.6% |
| INTEGER (mode `bigint`) | 237 ns | 0.9% |
| REAL | 245 ns | 0.6% |
| TEXT short | 257 ns | 0.8% |
| TEXT 4 KiB | 1.11 µs | 2.9% |
| TEXT unicode | 360 ns | 0.7% |
| NULL | 225 ns | 0.3% |
| BLOB 64 B | 480 ns | 1.7% |
| BLOB 4,095 B (copy side of the boundary) | 1.07 µs | 3.6% |
| BLOB 4 KiB (zero-copy side) | 1.10 µs | 0.4% |
| BLOB 64 KiB × 4,096 | REJECTED (RME 25.1%; observed 8.6–16.7 µs) | — |
| BLOB 1 MiB × 256 | REJECTED (RME 14.0%; observed 109–198 µs) | — |
| blob round-trip 2,000 × 256 KiB | 75.1 µs | 0.5% |
| blob stream 100 MiB round trip | 21.3 ms | 2.5% |

The 4,095/4,096 pair straddles the zero-copy boundary in `CellToJS`
(`src/convert.cc`): at ≥ 4096 bytes the payload moves into an external
Buffer instead of being copied. The medians are within noise of each
other (the copy of 4 KiB is cheap relative to the read), but the
*stability* differs — 0.4% RME on the zero-copy side vs 3.6% on the copy
side — and the allocation counters separate them decisively (see
[allocation](#allocation-per-operation)). The 64 KiB and 1 MiB blob
cases are honestly rejected: their per-sample cost is dominated by
allocator and GC behaviour that is genuinely bimodal.

### Writes

| Case | median | RME |
|---|---|---|
| prepared `run` insert | 9.11 µs | 0.3% |
| `db.run` prepare-per-call | 18.4 µs | 0.1% |
| `db.run` with statement cache | 9.82 µs | 0.3% |
| `exec` 100-statement script | 806 ns/stmt | 0.7% |
| **1,000 inserts in one transaction (file db)** | **7.54 µs** | 0.5% |
| 1,000 inserts autocommit (file db) | REJECTED (RME 81%; observed 175 µs–1.95 ms) | — |

The transaction lever is the one case where the harness refuses to print
the headline number, and the refusal *is* the finding: batched inserts
cost a stable ~7.5 µs each on a journal-backed file, while autocommit
inserts ranged from 175 µs to 1.95 ms — **at least 23× slower at the
fast end of its own observed range, and up to ~260× at the slow end**.
The distribution is intrinsically bimodal (journal create/delete and
fsync behaviour), so no single median should be quoted for it. On
`:memory:` the lever all but disappears (commit is a memcpy; the pair
measured 1.03× apart, within noise) — which is why this pair runs
against a real file.

### Overhead

| Case | median | RME |
|---|---|---|
| `stmt.get` × 1,000 (callback) | 7.77 µs | 0.4% |
| `stmt.get` × 1,000 (promise) | 6.36 µs | 0.6% |
| `db.run` cached × 1,000 (baseline) | 9.77 µs | 0.4% |
| … + `trace` listener | 9.76 µs | 1.0% (within noise of baseline) |
| … + `profile` listener | 9.00 µs | 1.2% (within noise of baseline) |
| … + `commit` listener | 10.3 µs | 0.7% (1.05×, clears the floor) |
| … + `change`+`commit` listeners | 9.91 µs | 0.6% (within noise) |
| … after listener removal | 9.70 µs | 0.4% (structural zero confirmed) |
| `stmt.get` × 10,000 with cancellation token | 6.11 µs | 0.2% (1.24× vs plain `get`) |
| `get` statement-cache hit | 7.17 µs | 2.3% |
| `get` statement-cache miss (unique SQL) | 18.8 µs | 0.8% (**2.6× slower**) |
| `get` cache disabled (prepare per call) | 17.6 µs | 1.1% (**2.4× slower**) |
| filter 20k rows: in SQL | 46 ns/row | 0.3% |
| filter 20k rows: JS function per row | 18.9 µs/row | 0.9% (**~410× slower than SQL**) |
| filter 20k rows: JS after `all()` | 224 ns/row | 0.6% |
| JS round trip (minimal scalar) | 19.6 µs/call | 0.5% |
| JS aggregate step | 19.0 µs/step | 0.6% |
| JS collation | 141 µs/sorted row | 0.5% |
| `db.transaction` wrapper (empty body) | 16.1 µs/body | 0.3% |
| raw `BEGIN`+`COMMIT` | 13.5 µs/pair | 0.5% |
| open+close `:memory:` connection | 21.8 µs | 0.3% |

The JS-function numbers are the reason a JS UDF is the wrong tool for
row-wise work: each invocation pays a cross-thread round trip (the query
runs on a worker; your function runs on the JS thread). Filtering in SQL
or filtering the returned array is orders of magnitude cheaper. The
cancellation token costs ~24% on a tight `get` loop — real, and small
compared to what it buys.

### Concurrency

| Case | median | RME |
|---|---|---|
| 50 concurrent queries, `parallelize()` | 232 µs/query | 0.9% |
| 50 concurrent queries, `serialize()` | 257 µs/query | 1.0% (0.90× — within/near noise) |
| `pool.read` round trip | 21.4 µs | 0.3% |
| `pool.get` round trip | 20.9 µs | 0.3% |
| `pool.write` round trip | 50.0 µs | 0.8% |
| `pool.all` 20,000 rows (postMessage transfer) | 1.46 µs/row | 0.4% (**1.7× slower per row than local `all`**) |
| 200 concurrent reads, pool (4 readers) | 335 µs/query | 2.0% |
| 200 concurrent reads, single connection | 471 µs/query | 0.4% (**pool 1.4× faster under contention**) |

`parallelize()` vs `serialize()` on one connection is nearly a wash for
reads — a single connection serialises at the SQLite mutex anyway; the
mode matters for ordering guarantees, not read throughput. The pool pays
~1.7× per row to move a result set across a worker boundary
(structured clone), and wins it back under contention: 200 concurrent
reads finish 1.4× faster on 4 readers than on one connection.

## Linux (arm64, Debian container)

Same suite, Node v24.19.0 in a `node:24` (bookworm) container on the
same physical host, run via `pnpm run test:matrix`. The four large-blob
cases were filtered out (see [limits](#limits-of-these-numbers) — they
OOM the container). Noise floor 7.2% (vs 0.2–4.3% bare-metal macOS):
containers are noisier, and 12 cases were rejected by the RME gate
accordingly.

| Figure | arm64 macOS | arm64 Linux container | transferred? |
|---|---|---|---|
| `read/all` 20,000 × 1 | 225 ns/row | 223 ns/row | absolute parity (accidental) |
| `read/all` 20,000 × 4 | 844 ns/row | 851 ns/row | absolute parity (accidental) |
| `getSync` (cached) | 1.27 µs | 1.30 µs | sync path cost transfers |
| async `get` (cached) | 10.0 µs | 29.7 µs | **does not**: threadpool round trip is 3× pricier in the container |
| **sync-vs-async ratio** | **7–8×** | **22–31×** | direction yes, magnitude **no** |
| `allSync` vs `all` (20,000 × 4) | 1.04×, within noise | 1.05×, within noise | **held** — the crossover is universal |
| statement cache miss vs hit | 2.6× slower | miss rejected (RME 7%); disabled-vs-hit **2.3× slower** | held (via the disabled case) |
| transaction vs autocommit (file) | ≥23× (autocommit rejected, range 175 µs–1.95 ms) | **53.5×** (autocommit stable here: 2.29 ms/insert, RME 1.3%) | direction yes, magnitude platform-dependent — real `fsync` makes the lever bigger |
| JS round trip | 19.6 µs | 28.5 µs | direction held, absolute differs |
| pool `all` postMessage cost | 1.7× slower/row | 1.69× slower/row | **held almost exactly** |
| 200 concurrent reads: pool vs single | pool 1.4× faster | pool 1.47× faster | **held** |
| node:sqlite insert advantage | 2.2× | 2.9× | roughly held |

The lesson is exactly the one the suite was built to enforce: **ratios
of like-against-like within one run transfer; absolute costs and
threadpool-dependent ratios do not.** The sync-vs-async advantage ranges
from 7–8× (macOS, Node 26) to 22–31× (Linux container, Node 24) because
the denominator — the async round trip — is what the platform changes.
README quotes both.

## When to use which API

- **Sync (`getSync`/`runSync`/`allSync`)** for interactive, single-row
  work on an idle connection: 7–8× per call. It throws if anything is in
  flight, and it blocks the event loop for the duration — including
  `busyTimeout` waits — so it is wrong for anything slow or contended.
  For large result sets it buys nothing over `all` (see the crossover
  row above).
- **Statement cache** (`db.cacheStatements()`): 2.4–2.6× on repeated
  one-shot calls; first call of each SQL string pays the prepare. The
  cache is bypassed under `serialize()` and while an exclusive operation
  (`exec`/`close`/`wait`/`loadExtension`) is queued, so cached-call
  latency can differ by mode — the `miss`/`disabled` cases quantify the
  fallback.
- **Transactions**: batch writes. On a file database the difference is
  not a percentage, it is one to two orders of magnitude (above). Use
  `db.transaction()` (wrapper overhead ~2.6 µs per body over raw
  `BEGIN`/`COMMIT`) or explicit `BEGIN`/`COMMIT` around `exec` scripts.
- **Pool**: for concurrent reads from worker-safe code. Round trips cost
  ~21 µs (vs ~10 µs on a local connection), and each row crossing the
  worker boundary pays ~0.6 µs extra — so the pool only wins when there
  is contention to absorb (1.4× at 200 concurrent reads) or when you
  need the JS thread free.
- **`each`/`iterate` vs `all`**: `all` is simplest; `each` is ~18%
  cheaper per row and streams; `iterate` composes with `for await` at a
  ~25% premium over `all` with backpressure.
- **Hooks**: `trace`/`profile`/`change` listeners are free to within the
  noise floor on the write path; a `commit` listener costs ~5% on
  autocommit writes. Removing a listener returns exactly to baseline.
- **JS functions/aggregates/collations**: ~19 µs per invocation, O(n log
  n) comparisons for a collation sort. Use them for glue, never per row
  over large scans.

## Where this package loses

Measured against Node's built-in `node:sqlite` (`DatabaseSync`), same
fixtures, same statement shapes (sync vs sync):

| Case | `@appthreat/sqlite3` | `node:sqlite` | node:sqlite advantage |
|---|---|---|---|
| `get` single row (prepared) | 1.27 µs | 748 ns | **1.7×** |
| `all` 20,000 × 4 | 815 ns/row | 429 ns/row | **1.9×** |
| insert (prepared) | 1.67 µs | 766 ns | **2.2×** |
| `exec` 100-statement script | 806 ns/stmt | 896 ns/stmt | parity (0.90× — within noise) |

`node:sqlite` calls the C API directly from JS with no JavaScript
wrapper layer, statement cache, or mode-aware integer conversion in
between, and it shows. What this package offers in exchange is the
async, non-blocking surface (the event loop stays free), the worker
pool, transactions-with-savepoints, hooks, sessions/blob I/O and
per-connection configuration — none of which `node:sqlite` has. If
none of that matters for your workload, the built-in is the faster
sync driver and this document is not going to pretend otherwise.

`better-sqlite3` can be added as an optional mirror with
`npm i --no-save better-sqlite3 && pnpm run bench -- --compare` — it is
deliberately not a devDependency of this repo.

## Allocation per operation

Measured via `process.memoryUsage()` deltas around a forced GC
(`--expose-gc`). **Counters, and what lives in them:**

- `heapUsed`: JS-heap objects — row objects, strings, boxed values.
  External buffers are *not* here.
- `external`: C++ memory registered with V8, including this package's
  zero-copy blob payloads (`napi_create_external_buffer`) **and**
  copied Buffer/ArrayBuffer backing stores.
- `arrayBuffers`: ArrayBuffer/Buffer backing stores — copied buffers
  appear here; the zero-copy external path does **not** register in this
  counter (verified below), which makes it a tripwire: if the zero-copy
  path ever regresses to copies, `arrayBuffers` jumps from 0 to the full
  payload rate.
- `rss`: whole-process; includes SQLite's own allocations, which no
  other counter sees. Consistently too noisy to trust (RME 69–382% in
  these runs) and published as rejected.

The delta is a *retained* measurement: each case keeps exactly one
iteration's output reachable (dropped and GC'd before each sample), so
the delta is what one iteration allocates, divided by its op count.
Sample medians with RME, same treatment as time:

| Case (per row/op) | heapUsed | external | arrayBuffers |
|---|---|---|---|
| `all` 20,000 × 1 (int) | +64 B | 0 | 0 |
| `all` 20,000 × 4 | +312 B | +64 B | +64 B |
| `all` 20,000 × 8 wide text | +1.1 KB | 0 | 0 |
| `all` 20,000 × 8 mostly NULL | +128 B | 0 | 0 |
| INTEGER `bigint` mode | +88 B | 0 | 0 |
| REAL | +80 B | 0 | 0 |
| TEXT 4 KiB | +4.1 KB | 0 | 0 |
| BLOB 64 B | +264 B | +64 B | +64 B |
| BLOB 4,095 B (**copy**) | +264 B | +4.0 KB | **+4.0 KB** |
| BLOB 4 KiB (**zero-copy**) | +304 B | +4.0 KB | **0** |
| BLOB 1 MiB | +306 B | +1.0 MB | 0 |

Readings worth keeping: the `bigint` integer mode costs +24 B/row over
`number`/`mixed` (both 64 B — the row object dominates; `mixed` only
allocates a BigInt when a value is actually large). A NULL column costs
the same as an integer one: the row object is the floor. The
4,095-vs-4,096 pair separates the copy path from the zero-copy path in
the counters even though their timings are within noise.

## CI posture

`.github/workflows/bench.yml` runs the suite nightly and on pushes to
`release/*`, on the pinned `ubuntu-22.04` runner label (not
`ubuntu-latest`, which floats across a mixed pool — results from a mixed
pool are noise). **The job is informational** (`continue-on-error: true`):
it cannot fail a build. That is deliberate — timing on shared GitHub
runners is noisier than the apt outages that made D11 keep the
`sqlcipher` job post-merge-only, and a flaky gate is worse than an
ungated check. The comparison itself still runs and reports: per-case
`ok`/`WARN`/`FAIL`/`UNMEASURED` verdicts in the log, exit code 2 on
regressions, and the JSON uploaded as an artifact. The enforceable gate
is a local `pnpm run bench:compare` on a quiet machine against the
committed `bench/baseline.json`.

Baselines are per `platform-arch` and are regenerated deliberately:
`pnpm run bench:update` locally, or `node --expose-gc bench/index.js
--baseline-from <results.json>` to promote a CI artifact (this is how a
`linux-x64` entry would first be captured — run the job once, download
the artifact, promote, commit).

## Limits of these numbers

- **Memory footprint**: the four large-blob cases (`blob 64 KiB`,
  `blob 1 MiB`, the 2,000 × 256 KiB round trip, the 100 MiB stream)
  together push the process past 1 GB resident. The first two container
  runs of this suite were OOM-killed (exit 137) before the JSON was
  written; the Linux numbers below therefore exclude those four cases
  via `--filter`. GitHub's hosted runners have enough RAM for the full
  suite; small local containers may not.
- Absolute values are machine-specific. The ratios — sync-vs-async,
  cache hit-vs-miss, transaction-vs-autocommit, pool-vs-local — are the
  transferable claims, and the Linux table above is the check that they
  transfer.
- Every figure carries its RME in the suite output; anything without an
  interval is a claim, not a measurement, and should not be quoted from
  this file without the run that produced it.
- Three cases are rejected by design in the reference run (blob 64 KiB,
  blob 1 MiB, file-backed autocommit): their quantities are genuinely
  bimodal on this platform. The observed ranges are printed instead of
  medians.
- The noise floor is per-run (0.2–4.3% on a quiet macOS host). A run on
  a loaded machine reports its own, higher floor — and its ratios are
  suppressed accordingly. That is the harness refusing to over-claim,
  not a malfunction.
