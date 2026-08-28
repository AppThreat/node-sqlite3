# Security posture

This document states what `@appthreat/sqlite3` does and does not protect
against. The headline, which holds for every mechanism below:

> **Defence in depth, not a sandbox.**

SQL given to `exec`/`run`/`prepare` is **trusted input**. If you execute
SQL from an untrusted source, no feature of this package makes that safe;
use the declarative authorizer (`db.authorizer()`) to constrain it, and
even then assume the authorizer is only as good as the policy installed.
The only complete injection defence is parameter binding — bind values,
never splice strings.

## The Node permission model

Node's `--permission` flag restricts the JavaScript `fs` layer. This
package's native layer calls `open(2)` directly, so without the v9
checks a program run with `--permission --allow-addons` could read and
write **any file on the system** through a SQLite connection — Node's
permission checks never see it. This was verified by probe before the
checks were written: with `--allow-fs-read` limited to the app's own
code and no `--allow-fs-write` anywhere, an unpatched connection opened,
created and wrote a database file outside every grant.

### What the package checks

When the permission model is active (`process.permission` exists — under
Node 24 and 26 it exists only under `--permission`; there is no
`isEnabled()` method), every open path checks the target against the
process's allowances before the native open is scheduled:

| Path | Checks |
|---|---|
| Read-only open (`OPEN_READONLY`) | `fs.read` for the file |
| Writable open (anything else) | `fs.read` + `fs.write` for the file, **and** `fs.write` for its directory — SQLite creates the `-journal`, `-wal` and `-shm` files beside the database, so a writable open that cannot write the directory cannot work. Grant it with `--allow-fs-write="<dir>/*"`, which covers the file and its sidecars. |
| `''` (private temporary database) | `fs.write` for the temp directory — `''` is a real on-disk database under `os.tmpdir()`, not a special in-memory name. |
| `ATTACH 'x' AS y` (SQL) | A native authorizer gate denies `SQLITE_ATTACH` unless the target is allowlisted via `configure('attachPaths', [...])`. `VACUUM INTO 'x'` fires the same internal `ATTACH` action, so one gate covers both SQL-level paths to the filesystem. |
| `db.backup('x')` | The destination (or source, in the full form) is opened natively; it is checked like a writable open. |
| `db.loadExtension(x)` | Refused unless allowlisted — see below. |
| `:memory:` | No filesystem; no checks. (The URI memory spellings count as in-memory only on a connection opened with `sqlite3.OPEN_URI`; without that flag SQLite reads `file:…` as an ordinary filename.) |

A refusal is an `ERR_ACCESS_DENIED`-shaped error (`code`, `permission`,
`resource`) whose message names the path, the scope and a flag that
actually permits it.

### Running under `--permission`

- `--allow-addons` is required for the package to load at all — under
  `--permission` without it, the addon is blocked before `dlopen`, which
  is exactly what that flag governs. There is nothing to configure: if
  you are reading this from inside the package, addons were allowed.
- The package's own code must be readable: grant `--allow-fs-read` over
  the package directory (its `lib/` **and** `prebuilds/` — the loader
  stats the prebuild directory through Node's fs).
- On **Linux**, add `--allow-fs-read=/etc/alpine-release`: the
  `node-gyp-build` loader stats that file at module load to detect musl,
  and under the permission model the denied stat crashes it before this
  package's code runs (observed in the alpine container; the file need
  only be readable, not present).
- `sqlite3.pool()` spawns workers: add `--allow-worker`.

### The ATTACH gate

`ATTACH` is SQL, not an open call, so the JS check cannot see it. The
gate is a pre-filter inside the native authorizer callback: while armed,
every `SQLITE_ATTACH` action is denied unless the target filename
matches the allowlist. Notes that matter:

- **In-memory targets pass**: `':memory:'` always, and the URI forms
  (`file::memory:`, `file:…?mode=memory`) only on a connection opened
  with `sqlite3.OPEN_URI` — without that flag SQLite treats them as
  ordinary filenames, so they are matched against the allowlist like any
  other path. `''` never passes (it is temp-file-backed).
- **Matching is lexical**: the allowlist entry must match the filename
  as written in the SQL (exact string, or cwd-joined for relative
  targets; separators are normalised on Windows only, since `\` is an
  ordinary filename character on POSIX). Symlinks are not resolved — a
  differently-spelled target is denied. Fail-closed.
- `configure('attachPaths', [...])` permission-checks every entry at
  declare time (a writable ATTACH needs the same grants as a writable
  open; a `file:…?mode=ro` entry needs only `fs.read`). The ATTACH
  statement must then use a spelling that matches the entry.
- The gate is separate from the declarative `db.authorizer()` policy:
  installing or removing a policy does not remove the gate. Only
  `configure('attachPaths', null)` disarms it.
- Connections opened `{ untrusted: true }` carry a deny-all gate that
  `configure('attachPaths', …)` refuses to widen.

### Extension loading

`loadExtension` loads and executes an arbitrary shared library — the
same class of operation `--allow-addons` gates. Under the permission
model it is refused unless the exact path was declared:

```js
db.configure('extensionPolicy', { allow: ['/abs/path/ext.so'] });
await db.loadExtension('/abs/path/ext.so');
```

Every allowlisted path must be `fs.read`-permitted. Without the
permission model the pre-v9 behaviour stands unless you configure a
policy; `{ deny: true }` disables loading **permanently** for the
connection (it cannot be re-enabled).

The SQL function `load_extension()` is unreachable: on the vendored
SQLite 3.53.4 (verified by probe, not citation) it is off by default —
and in 3.53.4 `SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION` maps to the C-API
flag only, with a separate flag gating the SQL function — and the
package explicitly sets the C-API flag to 0 at open time (belt and
braces for source builds compiled with `SQLITE_ENABLE_LOAD_EXTENSION`).
`loadExtension()` re-enables the C API for the duration of its call and
disables it after.

### What remains open, by name

- **TOCTOU**: the checks run at the JS boundary; the actual `open(2)`
  happens later on a worker thread. A file swapped between the two
  (rename, symlink) is opened regardless. The permission model is not a
  sandbox and the C library is outside it.
- **Loaded extensions**: anything in an allowlisted shared library runs
  with the process's full privileges and can touch the filesystem
  directly, including registering a VFS. Loading one is a deliberate
  trust decision.
- **Lexical matching**: the ATTACH gate's allowlist is matched by
  string, not by resolved inode; it fails closed (denies) on mismatch,
  which can reject a legitimate target whose spelling differs.
- **The permission-model checks are per-open**: nothing re-checks on
  `process.chdir()` (SQLite resolves relative names at open time; a
  relative path re-checked later would use a different cwd).
- **Other processes**: every check gates this process's behaviour only.

If the permission model is off, none of these mechanisms exist and the
package behaves exactly as it did before v9 — the checks cost one
property read.

## Untrusted database files

Opening an attacker-supplied SQLite file executes its schema (views,
triggers, CHECK constraints parse and can invoke functions); CVEs in
SQLite's file parsing have existed. The one-option recipe:

```js
const db = await sqlite3.open(path, {
    mode: sqlite3.OPEN_READONLY,
    untrusted: true,
});
```

applies:

| Switch | Value | Why |
|---|---|---|
| `SQLITE_DBCONFIG_DEFENSIVE` | on | SQLite refuses out-of-band mutations (direct `sqlite_master` writes and similar). |
| `SQLITE_DBCONFIG_TRUSTED_SCHEMA` | off | Schema objects are treated as untrusted: dangerous constructs in a hostile schema are not honoured. |
| `SQLITE_DBCONFIG_WRITABLE_SCHEMA` | off | `PRAGMA writable_schema` becomes a no-op; the classic tamper (`UPDATE sqlite_master …`) hits SQLite's hard protection. On a plain connection that tamper succeeds — verified by probe; that contrast is the point of the option. |
| extension loading | permanently disabled | `loadExtension` refuses; `configure('extensionPolicy', …)` throws. |
| `SQLITE_LIMIT_LENGTH` | 64 MiB | bounds one hostile record/blob (default 1 GiB). |
| `SQLITE_LIMIT_SQL_LENGTH` | 1 MiB | bounds compiled SQL (default 1 GiB). |
| `SQLITE_LIMIT_EXPR_DEPTH` | 100 | bounds parser recursion (default 1000). |
| `SQLITE_LIMIT_VDBE_OP` | 25 000 | bounds one statement's program (default 250 M). |
| `SQLITE_LIMIT_ATTACHED` | 0 | no ATTACH at all, behind the deny-all authorizer gate. |

This is one option standing in for a page of SQLite hardening lore;
it is still **not** a sandbox for hostile SQL you run deliberately —
use `db.authorizer()` for that. A malformed (non-database) file errors
gracefully with `SQLITE_NOTADB` rather than crashing.

## `db.interrupt()` is connection-wide

`interrupt()` aborts every in-flight statement on the connection; it is
not a resource limit and cannot target one query. For a cancellable
long query, use `db.cancellationToken()` (a flag polled in C, usable
from any thread) or the progress handler for cooperative scheduling —
see the README's concurrency documentation.

## SQLCipher

The package supports
[SQLCipher](https://github.com/sqlcipher/sqlcipher) (encrypted SQLite)
via a **source build** — no prebuild ships with SQLCipher, by design:
the encryption runtime must come from your system's SQLCipher, and a
prebuilt binary would link the vendored plain SQLite instead.

Install SQLCipher with your package manager (`brew install sqlcipher`,
`apt install libsqlcipher-dev`, …) or build it yourself, then:

```bash
npm install @appthreat/sqlite3 --build-from-source --sqlite_libname=sqlcipher --sqlite=/usr/
```

Custom locations need the flags:

```bash
# macOS (Homebrew)
export LDFLAGS="-L$(brew --prefix)/opt/sqlcipher/lib"
export CPPFLAGS="-I$(brew --prefix)/opt/sqlcipher/include/sqlcipher"
npm install @appthreat/sqlite3 --build-from-source \
    --sqlite_libname=sqlcipher --sqlite=$(brew --prefix)

# Linux (source-installed under /usr/local)
export LDFLAGS="-L/usr/local/lib"
export CPPFLAGS="-I/usr/local/include -I/usr/local/include/sqlcipher"
export CXXFLAGS="$CPPFLAGS"
npm install @appthreat/sqlite3 --build-from-source \
    --sqlite_libname=sqlcipher --sqlite=/usr/local
```

For a SQLCipher source build against Electron headers, additionally pass
`--runtime=electron --target=<version> --dist-url=https://electronjs.org/headers`.

A CI job builds the package against SQLCipher on Linux so the option
does not silently rot (it runs post-merge and on demand, like the
packaged-ASAR job, so it is not a per-push gate).

## Vendored SQLite and CVE policy

The vendored amalgamation is pinned: `deps/sqlite-amalgamation-3530400`
(SQLite **3.53.4**, `sqlite_version%: '3530400'` in
`deps/common-sqlite.gypi`). The package therefore **inherits SQLite's
CVEs**: a vulnerability in the amalgamation is a vulnerability in every
build of this package until the amalgamation is bumped. Bumps are
deliberate, versioned changes (see `MIGRATING-TO-V9.md`) — they are not
folded into feature deliverables. If you need to know exactly what you
are running: `sqlite3.VERSION` and `sqlite3.VERSION_NUMBER` report the
vendored version at runtime.

## Reporting

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability and
what to include.
