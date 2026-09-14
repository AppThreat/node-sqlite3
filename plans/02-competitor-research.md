# 02 — Competitor research

Researched 2026-09-09. Facts verified against runtime introspection,
official docs and upstream sources; sources noted per section.

---

## 1. `node:sqlite` (Node.js built-in)

Sources: runtime introspection on Node v24.16.0; Node v26 docs
(`nodejs.org/api/sqlite.html`, structured `sqlite.json` changelogs);
`src/node_sqlite.cc` on nodejs/node main (4,641 lines). Stability:
experimental at v22.5 → 1.1 at v23.4 → "no longer experimental" v24.2 →
Release-candidate 1.2 at v25.7.

**Execution model.** Entirely synchronous on the JS main thread; one
connection per thread; the *only* async API is module-level `backup()`
(a libuv-threadpool job with `rate` pages/step and a `progress`
callback). UDFs and aggregates re-enter JS inline on the same thread
(a JS callback can even prepare and run *other* statements mid-query);
the one hard rule is that a statement's own VM cannot re-enter itself
while stepping.

**DatabaseSync** (v26 surface): `open`/`close`/`isOpen`/`isTransaction`/
`Symbol.dispose`; `prepare(sql, {readBigInts, returnArrays,
allowBareNamedParameters, allowUnknownNamedParameters, persistent})`;
`exec`; `function(name, {options}, fn)` with
`deterministic`/`directOnly`/`varargs`/`useBigIntArguments`; `aggregate`
with `inverse` (window functions, since v25.5/v24.14);
`loadExtension`/`enableLoadExtension` (requires `allowExtension:true` at
construction); `enableDefensive(active)` (defensive **on by default**
since v25.5/v24.14); `setAuthorizer(callback|null)` returning
`SQLITE_OK/DENY/IGNORE`; `location(dbName)`; `createSession`/
`applyChangeset` (with `filter` + per-conflict callbacks);
`serialize()`/`deserialize()` (docs say v26.1; present and working on
local 24.16); `createTagStore()`; `limits` getter/setter (11 run-time
limits, v25.8). Constructor options include `enableForeignKeyConstraints`
(default **true**), `timeout` (busy timeout), `defensive`, `limits`.

**StatementSync**: `get`/`all`/`iterate`/`run` (→ `{changes,
lastInsertRowid}`); `columns()` (name/database/table/column/type);
`sourceSQL`/`expandedSQL` accessors; `setReadBigInts`,
`setReturnArrays`, `setAllowBareNamedParameters`,
`setAllowUnknownNamedParameters`; `close()`/`Symbol.dispose` and
`stat(counter)`/`resetStats()` (v26.8: STMTSTATUS counters —
fullscanStep, sort, autoindex, vmStep, reprepare, run, filterMiss,
filterHit, memused).

**Session** (named `Session`, not SessionSync): `changeset()`,
`patchset()`, `close()`, `Symbol.dispose`.

**SQLTagStore** (`createTagStore(maxSize)`, v24.9): an LRU of prepared
statements driven by **tagged template literals** — `store.all\`SELECT …
WHERE id = ${id}\``; interpolation values become positional `?`
parameters, the joined SQL is the cache key, statements prepared with
`SQLITE_PREPARE_PERSISTENT`; arity must match holes exactly. `get/all/
iterate/run` as tags, `clear()`, `capacity`/`db`/`size` getters.

**Errors**: `code = 'ERR_SQLITE_ERROR'`, message from `sqlite3_errmsg`,
plus own `errcode` (extended numeric) and `errstr`. Integers outside
±2^53−1 throw `ERR_OUT_OF_RANGE` unless `readBigInts` — same
refuse-to-truncate philosophy as this package. Rows are
null-prototype objects. Bare named parameters allowed by default.
Booleans bindable only since v26.8.

**Tracing**: `diagnostics_channel` channel **`sqlite.db.query`**
(SQLITE_TRACE_PROFILE) publishing `{sql: expandedSql, database,
duration: ns}` automatically when the channel has subscribers —
zero-instrumentation observability for APM tools.

**Notable timeline**: v22.5 initial; v23.3 sessions; v23.4 iterate +
unflagged; v23.5 UDF options + loadExtension + constants; v23.8 backup;
v24.0 aggregate + timeout + setReturnArrays + isTransaction; v24.9
createTagStore; v24.10 setAuthorizer; v24.12–25.1 defensive; v25.5
window functions; v25.8 limits; v26.1 serialize/deserialize docs; v26.8
stmt.close/stat/resetStats, booleans, ArrayBuffer binding, re-entrancy
hardening.

---

## 2. better-sqlite3 (v13.0.3)

Sources: `docs/api.md`, `docs/integer.md`, `docs/threads.md`,
`docs/unsafe.md`, `docs/performance.md`, `lib/` and `src/` on master.

**Execution model.** Fully synchronous main-thread API (backup is the
single async method, returning a promise with `attached`/`progress`
options and rate control). Marketed on speed; v13 migrated to Node-API
with in-package prebuilds.

**Database**: ctor options `readonly`, `fileMustExist`, `timeout`
(default 5000 ms), `verbose` (per-SQL logging callback), `nativeBinding`;
`new Database(buffer)` opens a serialized image in memory. Methods:
`prepare`, `exec`, **`pragma(source, {simple})`** (executes `PRAGMA
${source}` in a special pragma mode and returns parsed rows; `{simple:
true}` returns the scalar), **`explain(sql)`** (v13: wraps as
`EXPLAIN ${source}`; parameters may be left unbound), `backup`,
`serialize(options)` → Buffer (deserialization happens via the
constructor's Buffer path), `function`/`aggregate` (with `inverse` for
windows), **`table`** (JS virtual tables), `loadExtension(path,
entryPoint)`, `close`, `defaultSafeIntegers(toggle)`,
`unsafeMode(toggle)` (escape hatch for defensive-mode-blocked ops and
mutate-while-iterating). Properties: `open`, `inTransaction`, `name`,
`memory`, `readonly`. `checkpoint()` was removed in v7 in favour of
`db.pragma('wal_checkpoint(RESTART)')`.

**`db.table()` — JS virtual tables (v7.4, the marquee feature).**
Read-only virtual tables computed on the fly by a JS **generator
function**: `{ rows: function*(){…}, columns: [...], parameters:
[...] (hidden columns ⇒ table-valued function), safeIntegers,
directOnly }`. An object definition registers an **eponymous-only**
module (the table exists immediately by that name; no
`CREATE VIRTUAL TABLE`); a factory function registers a named module
instantiated per `CREATE VIRTUAL TABLE … USING mod(args)`. Documented
uses: `filesystem_directory`, `regex_matches(pattern, str)` table-valued
regex, `sequence(n)`, CSV files. Write support is deliberately absent.

**Statement**: `run/get/all/iterate` (+ `return()` on iterators, capped
at 65,535 active iterators); **`pluck()` / `expand()` / `raw()`** as
mutually-exclusive toggles (first-column scalars / table-namespaced rows
with `$` bucket for expressions / array rows); **`bind(...)` permanent**
(one-shot per statement object, then execution-time binds forbidden);
`safeIntegers(toggle)` per statement; `columns()` (best after first
execution); `toString()` (v13: expanded SQL with bound values
substituted); frozen `source`/`reader`/`readonly`/`database`/`busy`.
Named parameters `@x`/`:x`/`$x` all bind from **bare object keys**;
extra keys silently ignored; anonymous values may be spread across
multiple arrays.

**Transactions.** `db.transaction(fn)` returns a **reusable wrapped
function** with `.deferred()`/`.immediate()`/`.exclusive()` begin-mode
variants; nesting becomes a savepoint automatically; sync-only (returns
a promise ⇒ TypeError).

**Errors.** `SqliteError.code` = extended code string (e.g.
`SQLITE_CONSTRAINT_UNIQUE`); TypeError = API misuse; RangeError =
count/size violations. UDF arity strictness with **overloads by arity**
under one name; aggregates keep arbitrary JS state between step and
result.

**Explicit absences** (verified): no custom collations (never existed
across its whole release history), no sessions/changesets, no
authorizer, no serialize-then-deserialize helper beyond the Buffer
constructor path, no async queries, no built-in pool.

---

## 3. `bun:sqlite` (Bun ≤ 1.4.2)

Sources: `bun-types@1.4.2` `sqlite.d.ts`, main-branch
`src/js/bun/sqlite.ts`, bun.com docs. Synchronous, built into the Bun
runtime (does not run on Node).

**Database**: ctor options `readonly`, `create`, `readwrite`,
`safeIntegers`, `strict` (strict: missing params throw; named keys given
**bare**, without `$`/`:`/`@`); `db.query(sql)` — LRU-cached
prepared statements (default 20 per Database, `MAX_QUERY_CACHE_SIZE`),
prepared `SQLITE_PREPARE_PERSISTENT`; `prepare` (uncached); `run(sql,
...)` executes multi-statement scripts; `transaction(fn)` with
`.deferred/.immediate/.exclusive` (code copied from better-sqlite3);
`serialize(name?)` → Buffer and **static** `Database.deserialize(bytes,
{readonly, strict, safeIntegers})`; `loadExtension(path, entryPoint)`;
`Database.setCustomSQLite(path)` (swap the SQLite dylib before first
open — needed for extensions on macOS system SQLite);
`fileControl(op, arg)` wrapping `sqlite3_file_control` (e.g.
`SQLITE_FCNTL_PERSIST_WAL`); `close(throwOnError)`; `Symbol.dispose`;
`inTransaction`; `filename`; `handle`. Databases are **not transferable
to Workers** — each worker opens its own connection (WAL recommended);
no shareable/pooled objects.

**Statement**: `get/all/run/values` (**tuple rows**), `raw()` (all
values as `Uint8Array`), `iterate` (sync), **`as(Class)`** — rows mapped
to class instances *without invoking the constructor* (prototype-only),
`finalize`, `toString()` (expanded SQL of last bindings);
`columnNames`, `columnTypes` (runtime `sqlite3_column_type` of first
row), `declaredTypes`, `paramsCount`. Executing with no parameters
reuses the last bound values.

**Errors**: `SQLiteError` with `errno` (extended code) and
**`byteOffset`** — the byte offset of the failing token (via
`sqlite3_error_offset`), unique among the drivers surveyed.

**Important corrections to common claims** (verified): `sql` is **not**
exported from `bun:sqlite` — the tagged-template client is
**`Bun.SQL`** (`import { sql } from "bun"`, covering Postgres/MySQL/
SQLite since v1.2.21). Helpers named `sql.raw`/`sql.join`/
`sql.identifier`/`sql.empty`/`sql.blob`/`sql.int`… **do not exist in
Bun** — its equivalents are `sql("users")` (identifier), `sql([...])`
(IN lists), `sql.unsafe()`, `sql.file()`, plus `.values()`/`.raw()`/
`.simple()` query modifiers and `sql.begin()/reserve()` with pooling.
Also absent from `bun:sqlite`: UDFs, `db.backup`, custom collations,
arrays-as-tables, any async execution.

---

## 4. @libsql/client (Turso)

Sources: libsql-js and libsql-client-ts READMEs, Turso docs.

Three modes: local file, **remote HTTP** (`libsql://` + authToken), and
**embedded replicas** (local file + `syncUrl`; `db.sync()` pulls deltas;
`syncInterval` for background sync). Async client with `execute`,
`batch(statements, mode)` — atomic multi-statement with **`"write"`/
`"read"`/`"deferred"`** modes — interactive `transaction(mode)` objects,
`executeMultiple`, `intMode: number|bigint|string`. The sibling native
package exposes `interrupt()`, a rule-based `authorizer()`,
`loadExtension`, per-statement `timed()`, `raw()`, `reader`. The libsql
**fork** adds native vector search: `F32_BLOB(n)`, `vector32/64/8/1bit/
sparse` constructors, `vector_distance_cos/l2/dot/jaccard`, and DiskANN
`libsql_vector_idx` + `vector_top_k`. Its docs explicitly list as
unsupported: pragma, backup, serialize, function, aggregate, table,
pluck, expand, bind — a useful negative-space list of what a "serious"
driver is expected to have.

---

## 5. Deno `@db/sqlite` (v0.13)

Sources: jsr.io/@db/sqlite.

Pure Deno **FFI** (not WASM): downloads/caches a prebuilt SQLite shared
library; `DENO_SQLITE_PATH` swaps in a custom build. Notable surface:
state properties (`autocommit`, `changes`, `totalChanges`,
`lastInsertRowId`, `inTransaction`, `open`, `path`); `int64` BigInt
toggle; **`parseJson` toggle (auto-parse JSON columns into JS objects)**;
`db.sql` tagged template; `transaction(fn)` with `.deferred/.immediate/
.exclusive`; `function`/`aggregate` UDFs; **`openBlob`** incremental
blob I/O; `backup(dest, name, pages)` **into another Database**;
`loadExtension`; `isComplete()` (`sqlite3_complete`); `unsafeHandle`
raw-pointer escape hatch.

---

## 6. WASM: wa-sqlite & sql.js

Sources: upstream READMEs.

- **wa-sqlite**: SQLite compiled to WASM with **VFS layers written
  entirely in JavaScript** — the whole point of the project. Catalogue:
  MemoryVFS, IDBBatchAtomicVFS/IDBMirrorVFS (IndexedDB),
  OPFSAdaptiveVFS/OPFSAnyContextVFS/OPFSCoopSyncVFS and
  **OPFSWriteAheadVFS** (WAL journaling on OPFS). Worker-oriented
  deployment; async (Asyncify/JSPI) builds allow async VFS.
- **sql.js**: in-memory-only WASM SQLite; whole-DB import/export
  (`new SQL.Database(bytes)` / `db.export()`); JS UDFs; manual
  `stmt.free()` lifetimes. No persistence, BigInt binding unsupported.

Lesson for a native driver: pluggable storage backends and durability
topologies matter in the browser world; on the server, the equivalents
are the pool, `serializeToBytes` handoffs and VFS-level encryption
(SQLCipher) — all already present here.

---

## 7. rusqlite (Rust) — the feature ceiling

Sources: README + docs.rs.

Exposes nearly everything SQLite has: **hooks with veto**
(`commit_hook` returning bool forces rollback), `rollback_hook`,
`update_hook`, `wal_hook`, `preupdate_hook`, `progress_handler`,
`busy_handler`, `set_authorizer`; **`unlock_notify`** (wake when a
locked DB frees — unique among everything surveyed); blob I/O with
Read/Write/Seek; serialize/deserialize (incl. from streams); backup
with progress; `changes`/`total_changes`/`is_autocommit`/
`transaction_state`; **`vtab`** — virtual tables in Rust, plus bundled
`generate_series`, CSV, and **`rarray()`** (bind a Rust array as a
table — unique and extremely useful for `IN (...)`/JOIN patterns);
`limit`/`set_limit` (returns prior value); `column_decltype`;
`get_interrupt_handle`/`is_interrupted`; **session extension incl.
rebasing**; `loadable_extension` (writing SQLite extensions in Rust);
SQLCipher builds; type conversions (uuid, chrono, url, serde_json).

---

## 8. Python stdlib `sqlite3`

`Connection.autocommit` three-mode control + `in_transaction`;
**adapters/converters** (`register_adapter`/`register_converter` with
`detect_types` for typed column round-trips); `backup(dst, pages,
progress)`; `blobopen` (file-like, indexable/sliceable blob objects);
`serialize`/`deserialize`; `set_trace_callback` (every statement incl.
implicit txn statements); `executescript`; `getlimit`/`setlimit`;
authorizer/progress/window functions/collations; **`iterdump()`** —
streaming SQL dump; `sqlite3.Row` row factory; URI opens incl.
`file:mem1?mode=memory&cache=shared`; `text_factory` for non-UTF-8;
errors carrying `sqlite_errorcode`/`sqlite_errorname`; even a
`python -m sqlite3` CLI.

---

## 9. What ORMs require from a SQLite driver

- **Drizzle** (better-sqlite3 dialect): constructor, `prepare(sql)` with
  `run(args)`→`{changes, lastInsertRowid}`/`all(args)`/`get(args)`/
  `raw()`, `transaction` with `.deferred/.immediate/.exclusive`,
  `$client` passthrough. Nothing else.
- **Kysely** (SqliteDialect): `acquireConnection`/`releaseConnection`,
  raw `begin`/`commit`/`rollback` SQL, `prepare` with `stmt.reader`,
  `stmt.all/run/iterate(args)`, `close()`, plus an `onCreateConnection`
  hook (where pragmas get set). Async-native — the natural fit for this
  package.

Takeaway: ORM compatibility is cheap; it is a docs/examples deliverable,
not a core-API one. A first-party Kysely dialect would work against the
existing promise API almost unchanged; a Drizzle driver would map onto
`*Sync` + `transaction`.
