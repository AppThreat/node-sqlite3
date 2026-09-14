# 04 — Feature roadmap

Ordered by value-to-effort, sequenced so each phase de-risks the next.
Every item must respect the project's two invariants: the FIFO queue /
exclusive-op discipline, and "call back into JS from the sync path only
via re-entrancy, never by blocking the JS thread on itself".

Effort scale: **S** ≤ a few days · **M** one to three weeks · **L** a
quarter-ish. Impact: ★–★★★ (adoption/ differentiation).

---

## Phase 1 — Ergonomics parity (all S/M, ship as minors)

The sync-first drivers make a set of small things trivial; users
migrating from better-sqlite3/node:sqlite keep reaching for them.

1. **`db.pragma(source, { simple })`** — S · ★★
   Prepare-and-return-parsed-rows around `PRAGMA ${source}`, `{simple:
   true}` for the scalar (better-sqlite3 parity; its docs call this *the*
   recommended way to run pragmas). Thin wrapper over the existing
   `getSync`/async `get`; special-cases the handful of statements-only
   pragmas via `exec`. Include `journal_mode = WAL` / `wal_checkpoint(
   RESTART)` / `optimize` recipes in docs.
2. **Reusable `db.transaction(fn)` with begin modes** — M · ★★
   Keep the existing inline form; additionally return a reusable wrapped
   function (as better-sqlite3, bun, Deno all do) carrying
   `.deferred()`/`.immediate()`/`.exclusive()`. Async-aware (unlike bs3,
   whose wrapper is sync-only — ours can guard the same
   `AsyncLocalStorage` nesting that exists today). BEGIN IMMEDIATE by
   default for write transactions is worth considering + documenting
   (avoid deferred-write upgrade failures under concurrency).
3. **Array/pluck row modes on the async paths** — S · ★★
   `{ rowMode: 'array' }` exists on sync calls only; extend it (plus a
   `pluck` shape: first column) to `get`/`all`/`iterate`/`stream`/
   `fetch` and the pool. The generated row builder already supports
   array shapes — this is plumbing, and it is the fastest row shape
   (see performance doc). Avoid bs3's mutable `.raw()` toggles; prefer
   per-call options to stay dual-mode-safe.
4. **`db.explain(sql, { plan: true })`** — S · ★
   `EXPLAIN QUERY PLAN` rows, parameters optionally unbound (they don't
   execute). Small but beloved bs3 v13 feature; pairs with the existing
   `stmt.status(FULLSCAN_STEP)` diagnostics.
5. **Error token offset: `err.offset`** — S · ★★
   The vendored 3.53.4 exposes `sqlite3_error_offset()`; bun:sqlite
   ships it as `byteOffset` and nobody else does. Attach to
   `SqliteError` after failed prepares (`-1` when N/A). Cheap, uniquely
   useful for user-facing SQL editors and migrations.
6. **`db.inTransaction` / `db.txnState`** — S · ★
   `sqlite3_get_autocommit` + `sqlite3_txn_state` (idle/read/write).
   Every other driver has some form (node `isTransaction`, bs3/bun
   `inTransaction`). Trivial binding, read under the connection mutex.
7. **`batch(statements, { mode })`** — M · ★★
   Atomic multi-statement execution in one savepoint, statements as
   strings or `{sql, args}`; map libsql's `write/read/deferred` modes
   onto BEGIN modes. Wraps existing transaction machinery; big ergonomic
   win for migrations/seeding, and a differentiator vs bs3/node which
   lack it entirely.
8. **`db.dump()` / `sqlite3.iterdump(db)`** — S · ★
   Streaming `.dump`-style SQL text export (Python `iterdump` parity;
   nothing in JS has it). Straight `SELECT * FROM sqlite_schema` +
   row-serialization walker; async iterator form fits `iterate()`.

**Phase 1 exit**: migrating from better-sqlite3 or node:sqlite needs no
adaptation layer for the top-20 utility calls.

---

## Phase 2 — Re-entrant UDFs on the sync path (M/L · ★★★)

The flagship gap, and the README's own comparison table concedes it:
`node:sqlite` and better-sqlite3 run JS functions inline in sync calls;
this package refuses. `docs/performance.md` ("Future direction: UDFs on
the synchronous fast path") already establishes this is **policy, not a
structural limit**: on the sync path the JS thread is the one executing
SQL, so the trampoline can call the JS function **directly** — same
thread, no round trip — exactly how node:sqlite does it.

Design sketch:

- In `src/function.cc`, detect "current thread == JS thread and the call
  originates from a sync step" and take the direct path: invoke the JS
  function via the env on the stack, convert the result back, and report
  a throwing callback through `sqlite3_result_error` (the error channel
  functions already have; collations still refuse, as documented).
- **Re-entrancy guard**: while inside such a callback, sync calls on the
  *same connection* must throw a clear error ("statement is executing" —
  node:sqlite hardened the same rule in v26.8); *other* connections are
  fine. The existing "connection fully idle" precondition of the sync
  path needs a carve-out for "idle except statements stepped from this
  re-entrant frame".
- Window/aggregate `inverse`/`result` paths need the same treatment.
- Bench: the `vers_compare(?, ?)` shape from the perf doc should land in
  the suite; the README's node:sqlite UDF caveat section gets rewritten
  from "refuses" to "works, and here's the cost model" (async-path UDFs
  still pay the ~18 µs round trip; sync-path UDFs become direct).

Risks: exception safety across sqlite frames (node:sqlite's
`SetIgnoreNextSQLiteError` pattern is the reference), and preserving the
current refusal tests' intent (they become direct-call tests).

**Phase 2 exit**: `db.function('regexp', …)` + `getSync('… WHERE x
REGEXP ?')` works; the comparison table's biggest ❌ flips.

---

## Phase 3 — Sessions completion: rebase + diff (M · ★★★)

This package already leads JS on sessions/changesets (apply/invert/
concat/iterate/patchset). Two C APIs sit unbound in the vendored header,
and together they complete a **fork-free replication story** that no JS
driver has (rusqlite is the only binding anywhere with them):

1. **`sqlite3.rebaseChangeset(changeset, rebase)`** — wraps
   `sqlite3_rebaser_new/configure/apply`: rebase a local changeset
   against a "rebase" (conflict resolution) captured during an
   `applyChangeset` that used OMIT/REPLACE. Expose `applyChangeset`'s
   optional `{ rebase: true }` to harvest the rebase buffer alongside
   the apply, then `rebaseChangeset()` to transform subsequent local
   changesets — the textbook client-server sync loop.
2. **`session.diff(table, otherDbOrPath)`** — wraps `sqlite3session_diff`
   (already compiled in): a changeset of the differences between two
   table contents without recording anything — instant "what changed
   between these two databases" for sync/verification tooling.
3. **Docs**: a replication cookbook — the pool + sessions + rebase
   pattern as a workable offline-first sync engine on stock SQLite.

Risk: low (pure additive bindings over stable session APIs). Impact:
high — it's a category no other JS driver can enter without copying this
work.

---

## Phase 4 — JavaScript virtual tables (`db.table()`) (L · ★★★)

better-sqlite3's marquee feature, absent from every other JS driver.
Natural fit here *after* Phase 2: vtab `xBestIndex`/`xFilter`/`xNext`
callbacks fire on whichever thread steps the statement.

- **Async path**: callbacks marshal worker→JS like UDFs today (~18 µs
  per call; fine for generator-driven row production, which is
  inherently coarse-grained).
- **Sync path** (post-Phase-2): direct re-entrant calls.

Scope v1 read-only (same as bs3), matching their proven shape:
`db.table(name, { rows: function* (…) {}, columns: […], parameters:
[…] (hidden columns ⇒ table-valued functions), directOnly })` for
eponymous tables, factory-function form for named modules. Ship the
documented use cases: `sequence`, `regex_matches`, JSON/CSV file tables.

**The extension nobody has**: rusqlite's `rarray()` — bind a JS array
(or iterable) as a table-valued parameter. With vtab + hidden-column
parameters this becomes natural here: `SELECT * FROM json_each(?1)`-style
ergonomics for JS data (`WHERE id IN (SELECT value FROM ?)`), a genuine
differentiator for ORMs/query builders.

Risks: vtab cursor lifetimes across the queue discipline (a vtab scan
holding a cursor while the user issues other statements — the blob
`SQLITE_ABORT` invalidation pattern is the precedent to copy); xBestIndex
constraint handling deserves a deliberate, minimal contract (bs3 ignores
constraint passing entirely — do the same in v1).

---

## Phase 5 — Tagged templates & migration affordances (M · ★★)

1. **Tag store**: `db.createTagStore(maxSize?)` / `sqlite3.tag(db)` —
   node:sqlite-compatible tagged-template LRU
   (`store.get`/`all`/`iterate`/`run` as template tags; template values
   become positional parameters; joined SQL is the cache key). Adds:
   composition helpers `sql.raw`, `sql.join`, `sql.identifier`,
   `sql.identifierPath`, `sql.empty` (the Kysely/Sequelize-style names —
   Bun notably has none of these; Node has only the bare store). Promise-
   native (an immediate improvement on node's sync-only store).
2. **`node:sqlite` compat shim** — M · ★★
   `import { DatabaseSync } from '@appthreat/sqlite3/compat'`: a class
   mapping `prepare/exec/function/aggregate/loadExtension/…` onto the
   sync paths plus re-entrant UDFs (Phase 2). Zero-dependency drop-in for
   code written against node:sqlite that outgrows it (needs pools,
   sessions, streaming). This is the single cheapest adoption lever
   available: the APIs are nearly isomorphic by design.
3. **Migration helper** — S/M · ★
   `sqlite3.migrate(db, migrationsDirOrList)` — `PRAGMA user_version`
   based, sequential, runs inside `transaction`. No driver ships one
   (libsql ships a CLI). Keep it dependency-free and opt-in.

---

## Phase 6 — Observability, ops & ecosystem (S/M each · ★★)

1. **`diagnostics_channel` emission** — S · ★★
   `node:diagnostics_channel` channel `@appthreat/sqlite3.query`
   publishing `{ sql (expanded), database, duration: ns }` when
   subscribed — the machinery already exists (SQLITE_TRACE_PROFILE in
   `src/database.cc`); wire `configure('trace', …)` to a channel
   subscriber. Optionally *also* mirror into node's `sqlite.db.query`
   channel name for APM-tool compatibility (decide: alias vs own name).
2. **`stmt.expandedSQL` / `stmt.normalizedSQL`** — S · ★
   `sqlite3_expanded_sql` (last bindings) and `sqlite3_normalized_sql`
   (literals → `?`; requires SQLITE_ENABLE_NORMALIZE — verify the flag,
   compile it in if absent). Normalized SQL is what query-metric
   dashboards want; only this and `expandedSQL` on statement objects
   (bs3/bun expose expanded via `toString()`).
3. **DB status + memory knobs** — S · ★
   `db.status()` over `sqlite3_db_status` (cache hit/miss/spill, schema
   used); `db.releaseMemory()` (`sqlite3_db_release_memory`) for pool
   pressure; `configure('walAutocheckpoint', n)`; verify what
   `SQLITE_DEFAULT_MEMSTATUS=0` disables and document it.
4. **Bun runtime verification** — S · ★★
   The binding loader already handles runtimes without
   `process.versions.napi`; add a Bun CI job loading the prebuild and
   running the suite (Bun's N-API coverage is the risk). README already
   shows `bun add` — make the claim verified rather than hopeful.
5. **ORM dialects** — S/M · ★★
   First-party Kysely dialect (async-native; needs `prepare`+`iterate`+
   `begin/commit` raw SQL — all present) and a Drizzle example mapping to
   `*Sync` + transaction-with-modes. Docs + `examples/`, or a tiny
   `@appthreat/sqlite3-kysely` package.
6. **Smaller parity items** (bundle as "introspection minor") — S · ★
   `db.limits` getter alongside `configure('limit', …)` (returning
   current values, node v25.8-style); `db.location(dbName)`;
   `sqlite3.compileOptions` (`sqlite3_compileoption_get`);
   `sqlite3.complete(sql)` (`sqlite3_complete`, for REPL/CLIs);
   per-statement integer-mode override option (node `setReadBigInts`,
   bs3 `safeIntegers` parity) — an options bag on `prepare` rather than
   mutable toggles.

### Explicit non-goals

- **Client/server, remote replicas, vector search** — libsql's turf;
  requires a SQLite fork. Stock answer: document compatibility with
  loadable `sqlite-vec`-style extensions instead (extension policy
  already exists).
- **Commit-veto hooks** — possible via a blocking round trip on the
  async path, but it couples commit latency to the JS thread; keep hooks
  observational (documented rationale exists).
- **JS VFS plugins** — wa-sqlite's territory; a native driver's VFS
  surface is C. SQLCipher + custom-magic builds cover the server-side
  storage-variant cases.
- **Mutable per-statement mode toggles** (bs3 `.pluck()`-style state) —
  per-call options fit the dual-mode (callback/promise) API better.

---

## Suggested sequencing

| Release | Contents |
| --- | --- |
| 9.1 | Phase 1 (ergonomics) + Phase 6 items 1–3 (observability quick wins) |
| 9.2 | Phase 2 (sync-path UDFs) — the headline; rewrite comparison table |
| 9.3 | Phase 3 (rebase + diff) + Phase 6 rest (Bun CI, dialects, shim) |
| 10.0 | Phase 4 (virtual tables + rarray) — new-major surface; Phase 5 tag store/migrations can slip into 9.x independently |

Budget feeling: Phase 1 ≈ 4–6 focused weeks total; Phase 2 is the one
design-heavy item; Phases 3–6 are additive and parallelizable across
contributors once 2 lands (vtab depends on it for the sync path only).
