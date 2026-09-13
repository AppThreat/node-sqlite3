# 03 — Feature gap matrix

Legend: ✅ has · ⚠️ partial/different · ❌ lacks. Column order:
**this** = `@appthreat/sqlite3` 9.0.2 · **node** = `node:sqlite` (Node
24–26) · **bs3** = better-sqlite3 13 · **bun** = `bun:sqlite` 1.4.
The last column names any other driver that has the feature
(rusqlite, libsql, Deno `@db/sqlite`, Python stdlib).

## Core execution model

| Capability | this | node | bs3 | bun | Elsewhere |
| --- | --- | --- | --- | --- | --- |
| Async, non-blocking queries | ✅ | ❌ (backup only) | ❌ (backup only) | ❌ | — |
| Sync fast path | ✅ | ✅ | ✅ | ✅ | — |
| Async iteration with backpressure | ✅ `iterate`/`stream` | ❌ (sync iterate) | ❌ (sync iterate) | ❌ (sync iterate) | — |
| Statement cache | ✅ opt-in + sync auto | ❌ (tag store is one) | ❌ | ✅ `query()` LRU 20 | — |
| Worker-thread connection pool | ✅ | ❌ | ❌ (docs recipe only) | ❌ | — |
| Multi-connection reader/writer guidance | ✅ pool | ❌ | ⚠️ docs | ⚠️ docs | libsql (server) |
| Cancellation (signal / token / interrupt) | ✅ all three | ❌ | ❌ | ❌ | rusqlite interrupt handle |
| `Symbol.dispose`/`using` | ✅ | ✅ | ❌ | ✅ | — |

## Query ergonomics

| Capability | this | node | bs3 | bun | Elsewhere |
| --- | --- | --- | --- | --- | --- |
| Tagged-template queries | ❌ | ✅ `createTagStore` | ❌ | ⚠️ via `Bun.SQL` module | Deno `db.sql` |
| `pragma()` helper w/ parsed results | ❌ | ❌ | ✅ | ❌ | — |
| `explain()` helper | ❌ | ❌ | ✅ (v13) | ❌ | — |
| Array/tuple row mode | ⚠️ sync paths only (`rowMode`) | ✅ `setReturnArrays` | ✅ `raw()` | ✅ `values()` | libsql `raw()` |
| Pluck (first-column) mode | ❌ | ❌ | ✅ | ⚠️ `values`+map | — |
| Expand (table-namespaced rows) | ❌ | ❌ | ✅ | ❌ | — |
| Reusable transaction fn + `.deferred/.immediate/.exclusive` | ⚠️ inline `transaction()` only, auto-savepoints | ❌ | ✅ | ✅ | Deno, Bun.SQL |
| Atomic `batch(statements)` | ❌ | ❌ | ❌ | ⚠️ multi-stmt `run` | libsql ✅ (write/read/deferred) |
| `inTransaction` / txn state introspection | ❌ | ✅ `isTransaction` | ✅ | ✅ | rusqlite `transaction_state`, Python |
| `db.location(name)` (attached-file path) | ❌ | ✅ | ⚠️ `name` property | ⚠️ `filename` | — |
| SQL text dump (`.dump`/`iterdump`) | ❌ | ❌ | ❌ | ❌ | Python `iterdump` |
| `sqlite3_complete`-style util | ❌ | ❌ | ❌ | ❌ | Deno `isComplete` |

## Values & errors

| Capability | this | node | bs3 | bun | Elsewhere |
| --- | --- | --- | --- | --- | --- |
| 64-bit-correct integers (bind+read) | ✅ 3 modes, refuse-to-truncate | ✅ `readBigInts` | ✅ `safeIntegers` | ✅ `safeIntegers` | libsql `intMode` |
| Per-statement integer mode override | ❌ (per-connection) | ✅ | ✅ | ⚠️ | — |
| Extended result codes on errors | ✅ `code`/`errno`/`primaryCode` | ✅ `errcode`/`errstr` | ✅ `code` | ✅ | Python `sqlite_errorcode` |
| Error token byte offset | ❌ | ❌ | ❌ | ✅ `byteOffset` | — |
| Strict bind validation (TypeError, arity) | ✅ strictest | ⚠️ | ✅ | ⚠️ `strict:true` | — |
| Boolean binding | ✅ | ⚠️ v26.8+ | ✅ | ✅ | — |
| JSON column auto-parse | ❌ | ❌ | ❌ | ❌ | Deno `parseJson`, Python converters |
| Row→class mapping | ❌ | ❌ | ❌ | ✅ `as(Class)` | Python `row_factory` |

## User-defined logic in SQL

| Capability | this | node | bs3 | bun | Elsewhere |
| --- | --- | --- | --- | --- | --- |
| Scalar UDFs (async path) | ✅ | ✅ | ✅ | ❌ | — |
| Scalar UDFs from **sync** calls | ❌ refuses | ✅ | ✅ | n/a | — |
| Aggregates + window functions | ✅ `inverse` | ✅ | ✅ | ❌ | — |
| Custom collations | ✅ (sync-path gated) | ❌ | ❌ never | ❌ | Python, rusqlite |
| Virtual tables in JS | ❌ | ❌ | ✅ `db.table()` | ❌ | rusqlite `vtab`, wa-sqlite |
| Array-as-table binding (`rarray`) | ❌ | ❌ | ❌ | ❌ | rusqlite only |
| On-demand collation factory | ❌ | ❌ | ❌ | ❌ | rusqlite `collation_needed` |
| FTS5 custom tokenizer in JS | ❌ | ❌ | ❌ | ❌ | nobody |

## Notifications, security, introspection

| Capability | this | node | bs3 | bun | Elsewhere |
| --- | --- | --- | --- | --- | --- |
| update/change hook | ✅ | ❌ | ❌ | ❌ | rusqlite, Python |
| commit/rollback hooks | ✅ observational | ❌ | ❌ | ❌ | rusqlite (commit **with veto**) |
| preupdate hook (old+new rows) | ✅ | ❌ | ❌ | ❌ | rusqlite |
| WAL hook + checkpoint control | ✅ `wal` event + `checkpoint()` | ❌ | ⚠️ pragma recipe | ⚠️ pragma | rusqlite `wal_hook` |
| Authorizer | ✅ C++ rule list (no JS on prepare path) | ✅ JS callback | ❌ | ❌ | libsql rule-based, Python |
| Run-time limits get/set | ✅ `configure('limit')` | ✅ `limits` prop (v25.8) | ❌ | ❌ | Python, rusqlite |
| Defensive mode | ✅ `dbConfig` + `untrusted` | ✅ default-on | ⚠️ `unsafeMode` inverse | ❌ | — |
| Progress handler | ✅ JS cb + SAB token | ❌ | ❌ | ❌ | rusqlite, Python |
| Statement counters (STMTSTATUS) | ✅ `stmt.status()` | ✅ `stat()` v26.8 | ❌ | ❌ | — |
| Column metadata (origin/decltype) | ✅ `stmt.columns` + `tableInfo` | ✅ `columns()` | ✅ | ⚠️ names/types | rusqlite |
| `expandedSQL` / `normalizedSQL` | ⚠️ trace events only | ✅ / ❌ | ⚠️ `toString()` / ❌ | ⚠️ `toString()` / ❌ | — |
| diagnostics_channel integration | ❌ | ✅ `sqlite.db.query` | ❌ | ❌ | — |
| DB/global status counters | ❌ | ❌ | ❌ | ❌ | rusqlite |
| Node permission-model integration | ✅ unique | ❌ | ❌ | n/a | — |

## Sessions, backup, snapshots, blobs

| Capability | this | node | bs3 | bun | Elsewhere |
| --- | --- | --- | --- | --- | --- |
| Session capture + changeset/patchset | ✅ | ✅ | ❌ | ❌ | rusqlite |
| Apply w/ per-conflict callbacks + filter | ✅ | ✅ | ❌ | ❌ | rusqlite |
| Invert / concat / iterate changesets | ✅ | ❌ | ❌ | ❌ | rusqlite |
| **Rebase** changesets | ❌ | ❌ | ❌ | ❌ | rusqlite only |
| `session.diff(table, otherDb)` | ❌ | ❌ | ❌ | ❌ | rusqlite |
| Online backup | ✅ stepping handle, self-paced | ✅ module fn, rate+progress | ✅ promise, rate+progress | ❌ | Python, Deno (→ live db) |
| serialize → bytes | ✅ WAL-normalized | ✅ | ✅ → Buffer | ✅ | Python, wa-sqlite |
| deserialize from bytes | ✅ copied, validated | ✅ | ⚠️ via ctor Buffer | ✅ static | Python |
| Incremental blob I/O | ✅ + Node streams | ❌ | ❌ | ❌ | rusqlite, Python, Deno |

## Extension, crypto, runtime support

| Capability | this | node | bs3 | bun | Elsewhere |
| --- | --- | --- | --- | --- | --- |
| Loadable extensions | ✅ + policy allowlist | ✅ gated by ctor flag | ✅ | ✅ (needs custom SQLite on macOS) | — |
| SQLCipher / at-rest encryption | ✅ source build | ❌ | ⚠️ community forks | ⚠️ via custom dylib | rusqlite bundled |
| Custom file magic | ✅ | ❌ | ❌ | ❌ | — |
| Bundled FTS5 / RTREE / JSON / math | ✅ all | ✅ | ✅ | ⚠️ runtime-dependent | — |
| Swappable SQLite build | ✅ `--sqlite=` source flag | ❌ | ⚠️ `nativeBinding` | ✅ `setCustomSQLite` | Deno `DENO_SQLITE_PATH` |
| Electron verified | ✅ CI incl. ASAR | ⚠️ | ⚠️ | n/a | — |
| Bun runtime | ⚠️ install documented; CI not verified | ❌ (their compat module unimplemented) | ⚠️ | ✅ native | — |
| `file_control` (WAL sidecars etc.) | ❌ | ❌ | ❌ | ✅ | — |
| ORM dialects (first-party) | ❌ | ⚠️ community | ⚠️ Drizzle+Kysely dialects exist | ⚠️ Drizzle | libsql first-party |

## Where this package already leads (no competitor has it)

True async execution with a sync fast path; async iteration/streaming
with backpressure; worker pool; strict-marshalling defaults with three
integer modes; collations; C++ rule-list authorizer; cancellation tokens
(shared memory) + AbortSignal; preupdate events with old rows;
invert/concat/iterate changesets; WAL-format-normalized serialize;
blob streams; permission-model enforcement; `untrusted` hardening;
extension policy allowlists; verified Electron/ASAR support.

## The gaps that matter, ranked by user value

1. **UDFs on the sync path** — the one thing the README's own comparison
   concedes to `node:sqlite`; already flagged internally as feasible
   (re-entrant direct call).
2. **Changeset rebasing** — the missing half of the sessions story;
   rusqlite has it, no JS driver does. Completes a fork-free
   replication/sync toolkit.
3. **JS virtual tables / table-valued functions** — better-sqlite3's
   marquee feature; combined with this package's async machinery it
   could go further (factory modules, streaming generators).
4. **Ergonomics bundle**: `pragma()`, `explain()`, reusable
   transactions with begin modes, async-path array/pluck row modes,
   tagged-template store, error offsets, `inTransaction`.
5. **Observability**: diagnostics_channel emission, expanded/normalized
   SQL accessors, DB status counters.
6. **Adoption surface**: node:sqlite compat shim, Kysely/Drizzle
   dialects, Bun CI verification, migration helper.
