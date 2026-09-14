# Plans: competitive research & feature roadmap

Produced 2026-09-09 against `@appthreat/sqlite3` **v9.0.2** (commit
`25814f7`, branch `master`).

## What is in here

| File | Contents |
| --- | --- |
| [01-project-assessment.md](01-project-assessment.md) | What this project is today: architecture, full API inventory, strengths, structural constraints |
| [02-competitor-research.md](02-competitor-research.md) | Deep research on `node:sqlite`, `better-sqlite3`, `bun:sqlite` (+ `Bun.SQL`), plus a broader survey: libsql, Deno `@db/sqlite`, wa-sqlite/sql.js, rusqlite, Python `sqlite3`, and what ORMs (Drizzle/Kysely) require from a driver |
| [03-feature-gap-matrix.md](03-feature-gap-matrix.md) | Capability-by-capability matrix: this package vs each competitor, with gaps and leads |
| [04-roadmap.md](04-roadmap.md) | The recommended roadmap — six phases, ordered, each item with motivation, design sketch, effort and risk |

## How the research was done

- **This repo**: read `README.md`, `MIGRATING-TO-V9.md`, all of `docs/`,
  `lib/*.js`/`*.d.ts` (the full JS API surface), `deps/sqlite3.gyp`
  (compile flags), the vendored SQLite 3.53.4 amalgamation header, and
  key parts of `src/*.cc` (trace hooks, configure).
- **node:sqlite**: runtime introspection on Node v24.16.0, the v26
  official docs (`nodejs.org/api/sqlite.html`), and the Node C++ source
  (`src/node_sqlite.cc` on `nodejs/node` main).
- **better-sqlite3**: `docs/api.md`, `docs/integer.md`, `docs/threads.md`,
  `docs/unsafe.md`, `docs/performance.md` and `lib/`+`src/` from
  WiseLibs/better-sqlite3 master (v13.0.3).
- **bun:sqlite**: Bun 1.4.2 official types (`bun-types/sqlite.d.ts`), the
  main-branch implementation, and bun.com docs.
- **Others**: upstream READMEs/docs for libsql, Deno `@db/sqlite`,
  wa-sqlite, sql.js, rusqlite; Python stdlib docs; Drizzle and Kysely
  driver sources.

## One-paragraph summary

`@appthreat/sqlite3` is already the most feature-complete SQLite binding
in the Node ecosystem — nothing else offers async-first execution with a
sync fast path, a worker pool, streaming, sessions/changesets, blob I/O,
collations, a C++-side authorizer, and cancellation on one connection
object. The gaps that remain against `node:sqlite` and `better-sqlite3`
are: UDFs on the synchronous path (an architectural item the perf doc
already earmarks), small ergonomics the sync-first drivers make easy
(`pragma()`/`explain()` helpers, reusable transactions with begin modes,
pluck/raw row modes on the async path, tagged templates), changeset
**rebasing** (the missing half of the sessions story, which no JS driver
has), and JS-defined **virtual tables** (better-sqlite3's marquee
feature). The roadmap phases these in order of value-to-effort, keeping
the project's async-first identity and refuse-loudly threading discipline
intact.
