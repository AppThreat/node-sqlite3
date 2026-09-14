# 01 — Project assessment: `@appthreat/sqlite3` today

`@appthreat/sqlite3` v9.0.2 is a Node-API 10, ESM-only, async-first
SQLite binding for Node ≥ 24 (and Electron ≥ 35), forked from
TryGhost/node-sqlite3 and substantially rewritten. It bundles SQLite
3.53.4 and ships prebuilds for six platforms inside the npm tarball
(resolved at runtime by `lib/sqlite3-binding.js`, so pnpm's
install-script block is a no-op).

## Architecture

- **Async by default.** Every data method (`run`/`get`/`all`/`each`/
  `map`/`exec`/`prepare`…) runs SQLite on a background worker via a
  strictly FIFO queue (`docs/concurrency.md`). The JS event loop stays
  free. Dual-mode: trailing callback = classic chainable API, no
  callback = promise.
- **Sync fast path.** `getSync`/`runSync`/`allSync`/`prepareSync` execute
  on the calling thread and refuse unless the connection is fully idle.
  Measured 8–12× faster than the cached async equivalents on macOS
  (22–31× on Linux), and at parity with `node:sqlite` on prepared
  statements (within 1.03–1.17×; blobs are the one weak column type at
  1.29×).
- **Per-shape generated row builders.** The addon calls back into JS once
  per result shape to compile a monomorphic row-construction function
  (`makeRowFactory` in `lib/sqlite3.js`), with a C++ store-loop fallback
  where codegen is unavailable.
- **JS callbacks (UDFs, collations, progress) cross threads.** Async
  statements run on a worker; a JS callback is a blocking round trip to
  the main JS thread (~18 µs/call measured). This single fact explains
  most of the deliberate API restrictions (below).
- **Worker threads + pool.** The addon is context-aware
  (per-environment constructors); `sqlite3.pool(filename, {readers})`
  builds one writer + N read-only readers on separate workers, writes
  queue, `{signal}` cancellation crosses threads through a
  SharedArrayBuffer flag.

### Deliberate restrictions that follow from the threading model

1. UDFs/aggregates/window functions **refuse to run** from
   `getSync`/`runSync`/`allSync`/`prepareSync` — the JS thread is blocked
   inside SQLite and cannot service its own callback (deadlock). It
   refuses with an explicit error (`src/function.cc`,
   `SyncRefusalMessage`). `docs/performance.md` explicitly records that
   this is *policy, not a structural limit* — a re-entrant direct call is
   possible future work.
2. While a JS **collation** or JS **progress handler** is registered, the
   sync methods refuse entirely (a collation callback has no error
   channel). `db.withCollation(name, cmp, fn)` scopes registration to a
   block.
3. `commit`/`rollback` hooks are observational only (no veto) — a veto
   would need a blocking round trip at commit time.
4. A session and a `'preupdate'` listener cannot coexist (SQLite has one
   preupdate hook per connection); both directions fail loudly.

## Feature inventory (verified in lib/ + src/ + docs/)

**Connections**: `new Database(file, mode|options, cb)`, `sqlite3.open()`
promise-native, `untrusted: true` hostile-file recipe, Node `--permission`
enforcement on open/ATTACH/`VACUUM INTO`/backup/extension, `configure()`
for `busyTimeout` / `limit` (run-time limits) / hook toggles /
`integerMode` (`number`|`bigint`|`mixed`) / `extensionPolicy` /
`attachPaths`, `serialize()`/`parallelize()`, `interrupt()`, `wait()`,
`state` snapshot, `changes`/`totalChanges` (64-bit), `dbConfig()`,
`checkpoint({mode})`, WAL hook event, `tableInfo()`, SQLCipher + custom
magic source builds, `cached` registry, `verbose()` long-stack traces.

**Statements**: `prepare`/`prepareSync` (+ promise form gated on
introspection snapshot), `bind`/`run`/`get`/`all`/`map`/`reset`/
`finalize`, native `fetch(count)` paged reads, `iterate()` async iterator
with backpressure, `stream()` object-mode Readable, statement cache
(`cacheStatements()`, LRU), sync fast paths with `{rowMode:'array'}`,
introspection (`readonly`, `parameterCount`, `parameterNames`, `columns`
with declaredType/database/table/origin), `status()` STMTSTATUS counters,
`lastID`/`lastIDBigInt`/`changes` (mode-aware, lazy RangeError),
`Symbol.dispose`.

**Advanced**: UDFs / aggregates / window functions (`deterministic`,
`directOnly` default true, `innocuous`, `varargs`); custom collations
(`collation`/`removeCollation`/`withCollation`); rule-list C++ authorizer
(no JS on the prepare path); `'change'`/`'commit'`/`'rollback'`/`'wal'`/
`'preupdate'` hooks; `progress()` + SharedArrayBuffer
`cancellationToken()` + AbortSignal; sessions (`session()`, `changeset()`,
`patchset()`, `applyChangeset` with per-conflict callbacks and filters,
`invertChangeset`/`concatChangeset`/`iterateChangeset`); stepping
`backup()` with retry policy; `serializeToBytes()`/`deserializeFromBytes()`
(WAL images normalized to rollback format); incremental blob I/O
(`openBlob`, `read`/`write`/`reopen`/`size`, streams); worker pool;
extended result codes (`code`/`errno`/`primaryCode`); strict marshalling
(no `[object Object]`, no silent truncation, arity errors).

**Compiled-in SQLite extensions** (deps/sqlite3.gyp): FTS3/FTS4/FTS5,
RTREE, JSON, math functions, STAT4, DBSTAT virtual table, sessions +
preupdate hook, column metadata. `SQLITE_DEFAULT_MEMSTATUS=0` (some
global memory statistics are disabled — verify before relying on
`sqlite3_status`-family APIs).

**Testing/tooling**: 60+ test files (node:test), Electron main+suite+ASAR
CI, glibc/musl Docker matrix, benchmark suite with RME gate and
node:sqlite + better-sqlite3 comparison baselines, generated TypeScript
declarations with CI drift check.

## Strengths (keep and consolidate)

1. **The only mature async-first driver** — non-blocking queries with
   real backpressured streaming; nothing else in the ecosystem has this
   (node:sqlite is sync-only; better-sqlite3 sync-only; bun:sqlite
   sync-only).
2. **Plus a competitive sync path** — within ~1.1× of `node:sqlite` on
   the shapes measured, faster on prepared inserts and `exec`.
3. **Sessions/changesets beyond anyone in JS** — apply/invert/concat/
   iterate/patchset with per-conflict callbacks (node:sqlite has create +
   apply only).
4. **Collations** — better-sqlite3 has *never* had them; bun:sqlite
   doesn't either.
5. **Authorizer design** — declarative rules evaluated in C++ inside
   SQLite, so no JS runs at prepare time (faster and thread-safe by
   construction, vs node:sqlite's JS callback).
6. **Security posture** — permission-model integration, `untrusted`
   recipe, extension policy, ATTACH gate: unique among all drivers
   surveyed.
7. **Blob streaming with Node streams** — only rusqlite/Python/@db/sqlite
   have incremental blob I/O at all; none integrate it with
   `stream.pipeline`.

## Structural constraints to respect in any roadmap

- Everything that makes SQLite call **back into JS** from the sync path
  needs the re-entrancy work (Phase 2 of the roadmap) or must keep
  refusing loudly.
- Everything that makes SQLite call back into JS from the **async** path
  pays ~18 µs per call (worker→main round trip) — fine for
  bounded-row logic, wrong for per-row bulk predicates (documented with
  measured crossover).
- The FIFO queue and exclusive-op semantics (`exec`/`close`/`wait`/
  `loadExtension`) are now load-bearing guarantees; new APIs must slot
  into the queue discipline rather than bypass it.
- Rows crossing worker boundaries (pool) are structured-clone copies;
  bulk-read guidance should continue steering users to a single
  connection.
