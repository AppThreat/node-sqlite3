# ⚙️ node-sqlite3

Asynchronous, non-blocking [SQLite3](https://sqlite.org/) bindings for [Node.js](http://nodejs.org/). Forked from TryGhost/node-sqlite3.

![NPM Downloads](https://img.shields.io/npm/dm/%40appthreat%2Fsqlite3)
[![Latest release](https://img.shields.io/github/release/AppThreat/node-sqlite3.svg)](https://www.npmjs.com/package/@appthreat/sqlite3)
![Node-API v9 Badge](https://github.com/nodejs/abi-stable-node/blob/doc/assets/Node-API%20v9%20Badge.svg)

# Features

- Straightforward query and parameter binding interface
- Full Buffer/Blob support
- Extensive [debugging support](https://github.com/AppThreat/node-sqlite3/wiki/Debugging)
- [Query serialization](https://github.com/AppThreat/node-sqlite3/wiki/Control-Flow) API
- [Extension support](https://github.com/AppThreat/node-sqlite3/wiki/API#databaseloadextensionpath-callback), including bundled support for the [json1 extension](https://www.sqlite.org/json1.html)
- Big test suite
- Written in modern C++ and tested for memory leaks
- Bundles SQLite v3.53.4, or you can build using a local SQLite [amalgamation](https://www.sqlite.org/amalgamation.html)

# Installing

Use whichever package manager you like:

```bash
npm install @appthreat/sqlite3
# or
pnpm add @appthreat/sqlite3
# or
yarn add @appthreat/sqlite3
# or
bun add @appthreat/sqlite3
```

- GitHub's `master` branch: `npm install https://github.com/AppThreat/node-sqlite3/tarball/master`

Requires Node.js >= 24. See [docs/install.md](docs/install.md) for the full
installation guide: prebuild coverage, source builds, custom SQLite/SQLCipher,
and troubleshooting.

### Prebuilt binaries

`@appthreat/sqlite3` v6+ was rewritten to use [Node-API](https://nodejs.org/api/n-api.html), so a single prebuilt binary per platform covers every supported Node version — nothing is compiled or downloaded at install time for the platforms below:

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64` (glibc and musl)
- `linux-x64` (glibc and musl)
- `win32-arm64`
- `win32-x64`

The prebuilds are bundled **inside the npm tarball** and resolved at
**runtime**, not by an install script. In particular, **pnpm 10+ users need no
`onlyBuiltDependencies` allowlist**: pnpm blocks dependencies' install scripts
by default, and that block is a no-op here because `lib/sqlite3-binding.js`
locates the prebuild itself when the module is first imported.

Support for other platforms and architectures may be added in the future if CI
supports building on them. Everywhere else, `@appthreat/sqlite3` builds from
source via `node-gyp` — see
[docs/install.md](docs/install.md#source-builds) for the toolchain
requirements and the pnpm specifics for source builds.

### Other ways to install

It is also possible to make your own build of `sqlite3` from its source instead of its npm package ([See below.](#source-install)).

The `sqlite3` module also works with [node-webkit](https://github.com/rogerwang/node-webkit) if node-webkit contains a supported version of Node.js engine. [(See below.)](#building-for-node-webkit)

SQLite's [SQLCipher extension](https://github.com/sqlcipher/sqlcipher) is also supported. [(See below.)](#building-for-sqlcipher)

# API

See the [API documentation](https://github.com/AppThreat/node-sqlite3/wiki/API) in the wiki.

# Usage

**Note:** the module must be [installed](#installing) before use.

This package is now ESM only.

```js
import sqlite3 from "sqlite3";
const db = new sqlite3.verbose().Database(":memory:");

db.serialize(() => {
  db.run("CREATE TABLE lorem (info TEXT)");

  const stmt = db.prepare("INSERT INTO lorem VALUES (?)");
  for (let i = 0; i < 10; i++) {
    stmt.run("Ipsum " + i);
  }
  stmt.finalize();

  db.each("SELECT rowid AS id, info FROM lorem", (err, row) => {
    console.log(row.id + ": " + row.info);
  });
});

db.close();
```

## Promises, async iteration and disposal (v9)

Every data method is dual-mode: pass a trailing callback for the classic
behaviour (returning `this`, chainable), or omit it to get a promise. `run`
resolves `{ lastID, lastIDBigInt, changes }`; `get`/`all`/`map` resolve the
rows; `exec`/`close`/`wait` resolve `undefined`. Errors carry the v9
`code`/`errno`/`primaryCode` triple.

```js
const db = await sqlite3.open(":memory:");          // promise-native open
await db.exec("CREATE TABLE lorem (info TEXT)");
const { lastID } = await db.run("INSERT INTO lorem VALUES (?)", "Ipsum 1");
const row = await db.get("SELECT * FROM lorem WHERE rowid = ?", lastID);
```

Stream large results with real backpressure — batches are pulled from
SQLite (64..1024 rows) only as fast as the consumer reads them:

```js
for await (const row of db.iterate("SELECT * FROM big")) { ... }
db.stream("SELECT * FROM big").pipe(someTransform);   // object-mode Readable
```

Transactions, cancellation and `await using` disposal:

```js
await db.transaction(async (tx) => {       // ROLLBACK on throw, nested savepoints
  await tx.run("INSERT INTO lorem VALUES (?)", "Ipsum 2");
});

const rows = await db.all("SELECT * FROM big", { signal });  // AbortSignal:
// an already-aborted signal rejects before scheduling; aborting in flight
// interrupts the whole connection (a SQLite constraint) and rejects with
// the signal's reason.

await using db2 = await sqlite3.open("app.db");  // closed however the block exits
await using stmt = db2.prepare("SELECT 1");      // finalized the same way
```

`each()` stays callback-only — the async iterator is its promise-based
replacement. `db.prepare()` and `db.backup()` keep their synchronous return
in every form.

## Performance options

Two opt-in fast paths avoid the per-call prepare and threadpool round-trip
costs. Both keep the default asynchronous behaviour untouched.

### Statement cache

```js
db.cacheStatements();        // or db.cacheStatements(16) to cap the LRU size
```

`run/get/all/each/map` then reuse prepared statements (LRU, keyed on the SQL
string, 64 entries by default). The cache is bypassed, falling back to a
per-call prepare, whenever ordering guarantees would otherwise be lost: under
`serialize()`, and while an exclusive operation (`exec`, `close`, `wait`,
`loadExtension`) is running or queued. `close()` finalizes cached statements.

A cached statement retains its most recently bound text/blob parameters until
it is rebound or finalized, so a large blob bound through a cached statement
stays resident while that entry lives in the cache.

### Synchronous fast path

```js
db.cacheStatements();
const row = db.getSync("SELECT * FROM t WHERE rowid = ?", 42);   // row | undefined
const info = db.runSync("INSERT INTO t (a) VALUES (?)", 42);     // { lastID, changes }
const rows = db.allSync("SELECT * FROM t");
const stmt = db.prepareSync("SELECT ? AS v");                    // statement-level variants
```

`getSync/runSync/allSync` execute on the calling thread — roughly 6x faster
than the async equivalents for interactive lookups. They throw when the
database is not fully idle: async work in flight or queued, or when called
from inside an async completion callback (defer with `setImmediate` or use
`db.wait`). They accept no callback argument. Like any synchronous database
API, a busy database file can block the event loop for up to the configured
`busyTimeout`.

Without `cacheStatements()` these methods prepare and finalize a statement
per call; enabling the cache is what makes them fast.

### Scheduling change

The database queue is now strictly FIFO. Previously a non-exclusive call
could dispatch immediately while an exclusive one (`exec`, `close`, `wait`,
`loadExtension`) was still waiting in the queue, so it could overtake that
call and run concurrently with it — for example a write landing outside a
transaction opened by `exec("BEGIN")`. Code that implicitly relied on the
old queue-jumping behaviour may see operations complete in a different
order. Parallel throughput is unchanged: the queue is only non-empty once
something has had to wait.

## Value marshalling (v9)

### Integer modes

```js
db.getSync("SELECT COUNT(*) AS n FROM t").n;   // number (default)
db.configure("integerMode", "mixed");          // or 'number' | 'bigint'
db.integerMode;                                // 'mixed'
```

Integers are stored as true 64-bit values on both the bind and the read
path, and `BigInt` parameters bind exactly. Reads follow the configured
mode:

| Mode | INTEGER columns and `lastID` |
|---|---|
| `'number'` (default) | `number` when safely representable, otherwise a `RangeError` — never a silently truncated double |
| `'bigint'` | always `BigInt` |
| `'mixed'` | `number` when safe, `BigInt` otherwise — recommended for anything touching `rowid`s |

`Statement#lastIDBigInt` returns the last insert rowid as a `BigInt` in
every mode, so `'number'`-mode code can still read a large rowid without
switching modes.

### Accepted bind values

`string`, `number` (integral values within the int64 range bind as
INTEGER; the double `2**63` clamps to `2**63-1`), `bigint` (`RangeError`
outside the signed 64-bit range), `boolean` (0/1), `null` and `undefined`
(both NULL), `Date` (epoch milliseconds as REAL — documented, lossy in
type), `RegExp` (its source string), and any binary view: Node `Buffer`,
`Uint8Array`/`Float64Array`/… (byte range honoured), `DataView`
(byte range honoured), `ArrayBuffer`.

Everything else — plain objects, arrays, `Map`, class instances, symbols,
functions — throws a `TypeError` naming the parameter index and the
constructor. Bind the number of parameters the statement takes: too few
(previously silently NULL) and too many (previously ignored) are both
errors now, and a named parameter absent from the SQL (`sqlite3_bind_parameter_index`
returning 0) throws as well.

### Extended result codes

Errors carry three properties: `err.code` (the extended name, e.g.
`SQLITE_CONSTRAINT_UNIQUE`), `err.errno` (the extended number) and
`err.primaryCode` (the primary name, e.g. `SQLITE_CONSTRAINT`). The
`SQLITE_CONSTRAINT_*`, `SQLITE_BUSY_*`, `SQLITE_READONLY_*`,
`SQLITE_IOERR_*`, `SQLITE_CANTOPEN_*`, `SQLITE_LOCKED_*`,
`SQLITE_CORRUPT_*`, `SQLITE_ERROR_*`, `SQLITE_ABORT_ROLLBACK` and
`SQLITE_AUTH_USER` constants are exported, as are the previously missing
open flags `OPEN_NOMUTEX`, `OPEN_MEMORY` and `OPEN_EXRESCODE`.

## User-defined functions, aggregates and collations (v9)

```js
// Scalar functions — this makes WHERE x REGEXP ? work:
db.function('regexp', { deterministic: true },
    (pattern, value) => new RegExp(pattern).test(value) ? 1 : 0);

// Aggregates: start() builds an accumulator, step() folds a row into it,
// result() produces the value. Providing inverse makes it a window
// function usable with OVER (...).
db.aggregate('median', {
    start: () => [],
    step: (acc, v) => { acc.push(v); return acc; },
    result: (acc) => {
        acc.sort((a, b) => a - b);
        return acc.length ? acc[acc.length >> 1] : null;
    },
});
await db.get('SELECT median(salary) AS m FROM employees');

// Collations — ORDER BY, indexes, COLLATE:
db.collation('german', (a, b) => a.localeCompare(b, 'de'));
await db.all('SELECT name FROM t ORDER BY name COLLATE german');

db.removeFunction('regexp');
db.removeCollation('german');
```

Arguments and return values use exactly the bind-marshalling rules above
(int64/BigInt, buffers for blobs, strict types: an unsupported return
value is an error, never a coerced string). Without `varargs: true` the
arity comes from the implementation's `length` (minus the accumulator for
aggregates), and calls with any other argument count are SQL errors.

Options: `deterministic` (required for index/generated-column use, and a
false claim corrupts results — opt-in), `directOnly` (default **true**:
schema SQL — triggers, views, CHECK constraints, index expressions —
cannot invoke the function; opt out explicitly), `innocuous`, `varargs`.
Window functions (aggregates with `inverse`) are registered through
`sqlite3_create_window_function`, which has no flag slot, so the flag
options do not apply to them.

### The threading model, and what it costs

SQLite invokes a function callback on whatever thread is executing the
statement — here a worker thread. Each call therefore makes a blocking
round trip to the JS thread: the worker marshals the arguments and waits
while the JS thread runs your function and posts the result back.

Measured cost (`pnpm run bench`, Apple Silicon, Node 26): **~18 µs per
call**. Consequences, with one decimal of honesty:

| Filtering 100,000 rows | Time |
|---|---|
| the predicate in SQL | 5 ms |
| the predicate in JS after `all()` | 25 ms |
| the predicate in a JS function per row | 1,830 ms |

A JS function called per row is the wrong tool for bulk filtering —
fetch and filter in JS (or write the predicate in SQL). A JS collation is
even sharper: sorting 100k rows costs O(N log N) round trips (~17 s).
Where they shine is pushing *logic* into a query — a regexp, a domain
checksum, a custom aggregate over a bounded group.

Two deliberate restrictions follow from the threading model:

- A JS function reached from a **synchronous method**
  (`getSync`/`runSync`/`allSync`/`prepareSync`) fails with an explicit
  error instead of deadlocking: the JS thread is the one blocked inside
  SQLite there and cannot run the callback. Use the async API.
- While a JS **collation** is registered, the synchronous methods refuse
  to run entirely (remove it with `removeCollation()` or use the async
  API): a comparison would need the blocked JS thread, and unlike
  functions, a collation callback has no way to report an error.

Errors: a throwing callback surfaces as a `SQLITE_ERROR` whose message
names the function, with the original JS error attached as `err.cause`;
the connection stays usable. Registration and replacement are refused
with `SQLITE_BUSY` (reported on the connection's `'error'` event) while
a cursor is suspended mid-query; the statement cache is flushed on every
registration, replacement and removal, so no statement compiled against
the old implementation is handed back.

## Hooks, authorizer, progress and introspection (v9)

```js
// Transaction hooks. commit fires after the transaction commits — every
// change event of that transaction is delivered first, which is what
// makes the pair useful for cache invalidation. The hooks are
// observational: the commit (or rollback) has already happened when the
// listener runs, and no return value can veto it.
db.on('change', (type, database, table, rowid) => { /* ... */ });
db.on('commit', () => { /* ... */ });
db.on('rollback', () => { /* ... */ });

// WAL hook: fires after a commit appends frames to the WAL.
db.on('wal', (database, pages) => { /* ... */ });
```

A hook's native sqlite callback exists only while at least one listener
is registered — an installed-but-unused hook costs nothing. In WAL mode,
`db.checkpoint()` is the lever for keeping the WAL bounded:

```js
const { busy, logFrames, checkpointedFrames } =
    await db.checkpoint({ mode: 'truncate' });
```

### Sandboxing SQL with the authorizer

```js
db.authorizer({
    default: 'deny',
    allow: [
        { action: sqlite3.SELECT },
        { action: sqlite3.READ, table: 'users' },
    ],
});
db.authorizer(null); // remove
```

The policy is a rule list evaluated inside SQLite itself, in C++ — no
JavaScript runs on the prepare path, so it is fast and thread-safe by
construction. `deny` rules win over `allow` rules; a denied action fails
the statement with `SQLITE_AUTH` ("not authorized"). The ~35 action
constants (`sqlite3.SELECT`, `sqlite3.READ`, `sqlite3.INSERT`,
`sqlite3.ATTACH`, …) and the decisions (`sqlite3.DENY`,
`sqlite3.IGNORE`) are exported. The statement cache is flushed on every
policy change: a cached statement was compiled under the old policy and
would bypass the new one.

### Cancelling queries

```js
// The cancellation token: an atomic flag in a SharedArrayBuffer that
// the native progress handler polls. Zero JS cost per check, and
// cancel() works from any thread — post token.buffer to a Worker.
const token = db.cancellationToken();
db.all(longRunningSql).catch(() => {});
setTimeout(() => token.cancel(), 100);

// token.signal is a real AbortSignal, so the promise form rejects with
// your reason:
db.all(longRunningSql, { signal: token.signal }).catch((reason) => {});
```

Cancellation is connection-wide, like `db.interrupt()`: the abort
reaches every statement running on the connection. While a token exists,
each query pays one relaxed atomic load per `period` VM instructions
(default 1000) — within measurement noise in the benchmark suite.

A JavaScript callback form exists for progress reporting —
`db.progress(10000, () => shouldStop)` calls the callback every 10,000
VM instructions and aborts the statement when it returns truthy — but
each invocation is a blocking round trip to the JS thread (the same
~18 µs class as JS functions), so it is for progress bars over long
queries, not per-row work. While it is registered, the synchronous
methods refuse to run (a callback would fire on the thread that must
service it). The token form has no such restriction.

### Statement and connection introspection

```js
const stmt = await db.prepare('SELECT name AS who FROM users WHERE id = ?');
stmt.readonly;        // true — sqlite3_stmt_readonly
stmt.parameterCount;  // 1
stmt.parameterNames;  // ['?1'] (null entries for positional `?`)
stmt.columns;         // [{ name: 'who', declaredType: 'TEXT',
                      //    database: 'main', table: 'users', origin: 'name' }]
stmt.status(sqlite3.STMTSTATUS_FULLSCAN_STEP); // >0: the query scanned
                                              // without an index

db.changes;           // rows changed by the most recent statement (64-bit)
db.totalChanges;      // every change since open (64-bit)
await db.tableInfo('users');   // column metadata incl. collation, defaults
await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE, true); // safe db_config switches
```

The statement accessors serve a snapshot taken when the statement was
prepared, so reading them never touches the sqlite handle and cannot
race a running query; fields SQLite reports as absent (an expression
column has no origin, a typeless column no declared type) are omitted
rather than nulled. Integer modes apply to `changes`/`totalChanges` as
everywhere else. `tableInfo` runs a `PRAGMA table_info`, so a
deny-by-default authorizer must allow `sqlite3.PRAGMA`.

## Source install

To skip searching for pre-compiled binaries, and force a build from source, use

```bash
npm install --build-from-source
```

The sqlite3 module depends only on libsqlite3. However, by default, an internal/bundled copy of sqlite will be built and statically linked, so an externally installed sqlite3 is not required.

If you wish to install against an external sqlite then you need to pass the `--sqlite` argument to `npm` wrapper:

```bash
npm install --build-from-source --sqlite=/usr/local
```

If building against an external sqlite3 make sure to have the development headers available. Mac OS X ships with these by default. If you don't have them installed, install the `-dev` package with your package manager, e.g. `apt-get install libsqlite3-dev` for Debian/Ubuntu. Make sure that you have at least `libsqlite3` >= 3.6.

Note, if building against homebrew-installed sqlite on OS X you can do:

```bash
npm install --build-from-source --sqlite=/usr/local/opt/sqlite/
```

## Custom file header (magic)

The default sqlite file header is "SQLite format 3". You can specify a different magic, though this will make standard tools and libraries unable to work with your files.

```bash
npm install --build-from-source --sqlite_magic="MyCustomMagic15"
```

Note that the magic _must_ be exactly 15 characters long (16 bytes including null terminator).

## Building for node-webkit

Because of ABI differences, `sqlite3` must be built in a custom to be used with [node-webkit](https://github.com/rogerwang/node-webkit).

To build `sqlite3` for node-webkit:

1. Install [`nw-gyp`](https://github.com/rogerwang/nw-gyp) globally: `npm install nw-gyp -g` _(unless already installed)_

2. Build the module with the custom flags of `--runtime`, `--target_arch`, and `--target`:

```bash
NODE_WEBKIT_VERSION="0.8.6" # see latest version at https://github.com/rogerwang/node-webkit#downloads
npm install sqlite3 --build-from-source --runtime=node-webkit --target_arch=ia32 --target=$(NODE_WEBKIT_VERSION)
```

You can also run this command from within a `sqlite3` checkout:

```bash
npm install --build-from-source --runtime=node-webkit --target_arch=ia32 --target=$(NODE_WEBKIT_VERSION)
```

Remember the following:

- You must provide the right `--target_arch` flag. `ia32` is needed to target 32bit node-webkit builds, while `x64` will target 64bit node-webkit builds (if available for your platform).

- After the `sqlite3` package is built for node-webkit it cannot run in the vanilla Node.js (and vice versa).
  - For example, `npm test` of the node-webkit's package would fail.

Visit the “[Using Node modules](https://github.com/rogerwang/node-webkit/wiki/Using-Node-modules)” article in the node-webkit's wiki for more details.

## Building for SQLCipher

For instructions on building SQLCipher, see [Building SQLCipher for Node.js](https://coolaj86.com/articles/building-sqlcipher-for-node-js-on-raspberry-pi-2/). Alternatively, you can install it with your local package manager.

To run against SQLCipher, you need to compile `sqlite3` from source by passing build options like:

```bash
npm install sqlite3 --build-from-source --sqlite_libname=sqlcipher --sqlite=/usr/
```

If your SQLCipher is installed in a custom location (if you compiled and installed it yourself), you'll need to set some environment variables:

### On OS X with Homebrew

Set the location where `brew` installed it:

```bash
export LDFLAGS="-L`brew --prefix`/opt/sqlcipher/lib"
export CPPFLAGS="-I`brew --prefix`/opt/sqlcipher/include/sqlcipher"
npm install sqlite3 --build-from-source --sqlite_libname=sqlcipher --sqlite=`brew --prefix`
```

### On most Linuxes (including Raspberry Pi)

Set the location where `make` installed it:

```bash
export LDFLAGS="-L/usr/local/lib"
export CPPFLAGS="-I/usr/local/include -I/usr/local/include/sqlcipher"
export CXXFLAGS="$CPPFLAGS"
npm install sqlite3 --build-from-source --sqlite_libname=sqlcipher --sqlite=/usr/local --verbose
```

### Custom builds and Electron

Running `sqlite3` through [electron-rebuild](https://github.com/electron/electron-rebuild) does not preserve the SQLCipher extension, so some additional flags are needed to make this build Electron compatible. Your `npm install sqlite3 --build-from-source` command needs these additional flags (be sure to replace the target version with the current Electron version you are working with):

```bash
--runtime=electron --target=18.2.1 --dist-url=https://electronjs.org/headers
```

In the case of MacOS with Homebrew, the command should look like the following:

```bash
npm install sqlite3 --build-from-source --sqlite_libname=sqlcipher --sqlite=`brew --prefix` --runtime=electron --target=18.2.1 --dist-url=https://electronjs.org/headers
```

# Testing

```bash
pnpm run test
```

# Developing

Development of this repo itself requires **pnpm >= 11** (`corepack enable`, or a
standalone install). Clone, then:

```bash
pnpm install          # also builds the native binding via the install script
pnpm run rebuild      # recompile after changing C++ (node-gyp rebuild)
pnpm run lint         # biome check --write (autofix; CI runs lint:check)
pnpm run test         # node:test, 20s per-test timeout, files run in parallel
pnpm run prebuild     # produce the shipping prebuilds/ artifacts
```

Always use `pnpm run rebuild`, never bare `pnpm rebuild` — the latter is a
pnpm builtin that rebuilds *dependencies*, not this repo's `rebuild` script.
See [docs/install.md](docs/install.md#development) for the full guide,
including the stale-`prebuilds/` trap when iterating on C++.

# Contributors

- [Daniel Lockyer](https://github.com/daniellockyer)
- [Konstantin Käfer](https://github.com/kkaefer)
- [Dane Springmeyer](https://github.com/springmeyer)
- [Will White](https://github.com/willwhite)
- [Orlando Vazquez](https://github.com/orlandov)
- [Artem Kustikov](https://github.com/artiz)
- [Eric Fredricksen](https://github.com/grumdrig)
- [John Wright](https://github.com/mrjjwright)
- [Ryan Dahl](https://github.com/ry)
- [Tom MacWright](https://github.com/tmcw)
- [Carter Thaxton](https://github.com/carter-thaxton)
- [Audrius Kažukauskas](https://github.com/audriusk)
- [Johannes Schauer](https://github.com/pyneo)
- [Mithgol](https://github.com/Mithgol)
- [Kewde](https://github.com/kewde)

# Acknowledgments

Thanks to [Orlando Vazquez](https://github.com/orlandov),
[Eric Fredricksen](https://github.com/grumdrig) and
[Ryan Dahl](https://github.com/ry) for their SQLite bindings for node, and to mraleph on Freenode's #v8 for answering questions.

This module was originally created by [Mapbox](https://mapbox.com/) & is now maintained by [Ghost](https://ghost.org).

# Changelog

We use [GitHub releases](https://github.com/AppThreat/node-sqlite3/releases) for notes on the latest versions. See [CHANGELOG.md](https://github.com/AppThreat/node-sqlite3/blob/b05f4594cf8b0de64743561fcd2cfe6f4571754d/CHANGELOG.md) in git history for details on older versions.

# Copyright & license

Copyright (c) 2013-2025 Mapbox & Ghost Foundation

`@appthreat/sqlite3` is [BSD licensed](https://github.com/AppThreat/node-sqlite3/raw/master/LICENSE).
