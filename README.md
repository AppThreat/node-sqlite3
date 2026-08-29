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

# Compared with `node:sqlite`

Node ships a built-in SQLite module. It has grown a lot and now covers
most of what a synchronous driver needs, so the honest summary is: **if
your workload is synchronous and fits `node:sqlite`, use `node:sqlite`**
— nothing needs installing and nothing needs compiling. This package
exists for the parts it does not cover.

Verified against `@appthreat/sqlite3` 9.0.0 on **Node v24.18.0 and
v26.7.0**, which expose an identical `node:sqlite` surface and behave
identically on every point below — so this table holds across the whole
range this package supports. `node:sqlite` did grow quickly during 24.x
(`backup` and `createTagStore` among the later additions) and is still
gaining features, so on an older 24.x patch release, or a newer Node
than the two above, check
[the `node:sqlite` docs](https://nodejs.org/api/sqlite.html) before
relying on a ❌ below.

## What only this package has

| Capability | `@appthreat/sqlite3` | `node:sqlite` |
|---|---|---|
| Asynchronous API (event loop stays free) | ✅ callbacks + promises | ❌ synchronous only |
| `async` iteration (`for await`), streams | ✅ `iterate`, `stream` | ❌ (sync `iterate` only) |
| Worker-thread connection pool | ✅ `pool()` | ❌ |
| Transaction helper with savepoints | ✅ `transaction()` | ❌ hand-rolled `BEGIN`/`COMMIT` |
| Statement cache | ✅ `cacheStatements()`, implicit on sync | ❌ prepare per call |
| Custom collations | ✅ `collation()` / `removeCollation()` | ❌ |
| Incremental blob I/O | ✅ `openBlob()` | ❌ read/write whole values |
| Update / commit / rollback / preupdate hooks | ✅ EventEmitter | ❌ |
| Progress handler | ✅ `progress()` | ❌ |
| Query cancellation | ✅ `cancellationToken()`, connection-wide | ❌ |
| WAL checkpoint control | ✅ `checkpoint()` | ❌ |
| Schema introspection | ✅ `tableInfo()`, `columns()`, `parameterNames` | ⚠️ `columns()` only |
| Changeset utilities | ✅ concat / invert / iterate | ⚠️ apply + create only |
| Backup control | ✅ handle you step yourself (`remaining`, `idle`, retry policy) | ⚠️ one-shot promise (`rate`, `progress`) |
| Integer read modes | ✅ `number` / `mixed` / `bigint`, per connection | ⚠️ `setReadBigInts()` per statement |
| Electron support | ✅ tested in CI, main + utility process | ⚠️ works, untested by us |

## What both have

User-defined functions and aggregates (including window functions via
`inverse`), sessions and changesets, the authorizer, extension loading,
`serialize`/`deserialize`, incremental online backup with progress
reporting, `readOnly` and busy-timeout connection options, array row
mode, bare and unknown named-parameter control, and extended result
codes on errors. Both also **refuse to truncate** an INTEGER outside the
safe range rather than silently losing precision — they differ only in
how you opt into `BigInt`.

## What only `node:sqlite` has

| Capability | Why it matters |
|---|---|
| **Zero install** — built in, no compiler, no prebuild, no supply chain | Usually the deciding factor |
| **UDFs callable from synchronous queries** | See below — a real architectural difference, not an oversight |
| Tagged-template queries (`createTagStore`) | Ergonomic SQL literals |
| `enableDefensive()` | Hardening for untrusted SQL |

The UDF difference is worth understanding before choosing. `node:sqlite`
runs SQLite on the main thread, so a JavaScript callback can run inline
while a query is stepping. This package runs asynchronous queries on a
worker, and a JS callback fires safely there — but calling a UDF from
the *synchronous* fast path would mean SQLite blocking the JS thread
that has to run the callback, which deadlocks. It refuses instead, with
an error saying so. So: **UDFs, aggregates and window functions work on
the async API here, not on `getSync`/`allSync`/`runSync`.** If you need
custom functions inside otherwise-synchronous code, `node:sqlite` is the
better fit.

Migrating from `node:sqlite` is mostly mechanical — `DatabaseSync` maps
to `Database` plus the `*Sync` methods. See
[MIGRATING-TO-V9.md](MIGRATING-TO-V9.md) for the value-marshalling
differences, which are where the surprises live.

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

It is also possible to make your own build of `sqlite3` from its source instead of its npm package ([See below.](#source-install)).

SQLite's [SQLCipher extension](https://github.com/sqlcipher/sqlcipher) is also supported. [(See below.)](#sqlcipher-encrypted-databases)

## Electron

No rebuild, no `electron-rebuild`: v9 ships Node-API 10 prebuilds, and Node-API
is ABI-stable across runtimes — the same binary Node loads is the one Electron
loads. The minimum is **Electron 35** (the first major whose bundled Node
exposes Node-API 10; verified by loading the prebuild in Electron 35 and 44),
recorded in `engines.electron`. Source builds against Electron headers are only
needed for SQLCipher or a custom `sqlite_magic` — see
[docs/electron.md](docs/electron.md) for process placement (main vs. utility
process vs. preload), ASAR/`asarUnpack` configuration for electron-builder and
electron-forge, bundler externals, `userData` paths, and the SQLCipher rebuild
path.

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
// Bulk-reader row shape: one array per row, values in result-column order.
const flat = db.allSync("SELECT * FROM t", { rowMode: "array" });
```

`getSync`/`allSync` (not the async paths) accept a trailing
`{ rowMode: 'array' }` option: rows come back as arrays instead of
objects — duplicate column names keep every value instead of collapsing,
and the per-cell property stores disappear entirely, making it the
fastest row shape the sync paths can build. CSV export, ETL and bulk
feeds are the intended users; the default object shape is unchanged.
(A named bind parameter could never have the bare key `rowMode` — bind
keys carry a sigil — so the option is unambiguous.)

`getSync/runSync/allSync` execute on the calling thread. On the benchmark
suite (`pnpm run bench`, [docs/performance.md](docs/performance.md)),
cached single-row lookups are **8–12× faster** than the cached async
`get`/`run`
equivalents on arm64 macOS (10.4–11.8× for `getSync`, flat
from batches of 1 to 10,000; `runSync` 8.2× at one operation rising to
~11.5× at 10,000 as per-round overhead amortises) — and **22–31×** on
Linux, where the async threadpool round trip costs more. For large
result sets sync and async are level (20,000 rows × 4 cols measured
within the noise floor): the marshalling is the same work either way,
and it dominates the threadpool round trip. They throw when the
database is not fully idle: async work in flight or queued, or when called
from inside an async completion callback (defer with `setImmediate` or use
`db.wait`). They accept no callback argument. Like any synchronous database
API, a busy database file can block the event loop for up to the configured
`busyTimeout`.

These `Database`-level forms keep their own statement cache, so they do
not prepare and finalize a statement per call; that is automatic and
does not need `cacheStatements()`, which is opt-in and governs the
asynchronous calls.

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

## Sessions, changesets and the preupdate event (v9)

A session records every INSERT, UPDATE and DELETE made through the
connection (tables need a primary key to be recordable), and harvests
them as a changeset — a `Uint8Array` you can store, ship, or apply to
another connection:

```js
const session = db.session({ table: 'users' });   // or every table
await db.run('UPDATE users SET name = ? WHERE id = ?', 'x', 1);
const changeset = await session.changeset();      // Uint8Array
const patchset = await session.patchset();        // new rows only, smaller
await session.close();

await target.applyChangeset(changeset, { conflict: 'replace' });
await target.applyChangeset(changeset, {
    // the fully general form — runs per conflict:
    conflict: (info) => (info.conflict === 'notFound' ? 'omit' : 'replace'),
    filter: (table) => table !== 'audit',
});

for (const op of sqlite3.iterateChangeset(changeset)) {
    console.log(op.op, op.table, op.oldRow, op.newRow);
}
const inverse = sqlite3.invertChangeset(changeset); // undoes the apply
const both = sqlite3.concatChangeset(a, b);         // a then b
```

`applyChangeset` wraps the apply in one savepoint: either every change
lands or the whole apply rolls back. `conflict` decides what happens on
a collision — `'abort'` (the default) rolls back, `'omit'` skips the
change, `'replace'` overwrites the row — or a function returning one of
those per conflict. The function form is a blocking round trip from the
applying thread (like a user-defined JS function), so it must not use
the synchronous methods on that connection.

The `'preupdate'` event fires for every write with the row's before and
after values — the old values `change` events cannot give you:

```js
db.on('preupdate', ({ op, table, rowid, oldRowid, oldRow, newRow }) => {
    audit.log(op, table, oldRow, newRow);
});
```

`oldRowid` and `rowid` differ exactly on a rowid-changing update.
One preupdate hook exists per connection and is shared with the session
machinery, so a session and a `'preupdate'` listener cannot coexist on
one connection — attempting either direction fails loudly instead of
silently stopping the other.

## In-memory snapshots: serializeToBytes / deserializeFromBytes (v9)

The whole database as bytes — snapshotting, shipping a prebuilt
database, fast fixtures, moving a database between threads:

```js
const bytes = await db.serializeToBytes();        // Uint8Array snapshot
const copy = await sqlite3.deserializeFromBytes(bytes, {
    readonly: false,
    resizable: true,
});
```

`serializeToBytes` returns the exact bytes a file copy would contain
(the FIFO-ordering `db.serialize()` keeps its old meaning). The bytes
are named deliberately: overloading `serialize()` would be the worst
API decision available. `deserializeFromBytes` **copies** into
SQLite-owned memory — handing a JS buffer to SQLite directly is a
use-after-free waiting to happen — and rejects corrupt input with
`SQLITE_NOTADB` rather than crashing later.

## Incremental blob I/O (v9)

Reading a 500 MB blob as one value materialises it as a single buffer;
`openBlob` gives you a handle that streams it instead:

```js
const blob = await db.openBlob({ table: 'files', column: 'data', rowid: 1 });
const chunk = new Uint8Array(65536);
const n = await blob.read(chunk, 0);       // n bytes at blob offset 0
await blob.write(source, 4096);            // write at an offset
blob.size;                                 // sqlite3_blob_bytes

await pipeline(blob.createReadStream(), fs.createWriteSink(path));
await pipeline(fs.createReadStream(path), blob.createWriteStream());
await blob.close();
```

Streams read and write in chunks (default 64 KiB), so memory stays flat
regardless of the blob's size. Any write to the row invalidates open
handles with `SQLITE_ABORT` (and a message saying so); an aborted handle
cannot be reopened — close and open a fresh one — while `blob.reopen(
rowid)` cheaply re-aims a *healthy* handle at another row. The blob
cannot grow through the handle: size the column first (e.g.
`UPDATE ... SET data = zeroblob(n)`) and then stream into it. Writing
through a blob handle surfaces as a `'preupdate'` delete event (the new
values are not yet available inside `sqlite3_blob_write`).

## Worker threads and the connection pool (v9)

The addon is context-aware: it loads cleanly in every `worker_threads`
worker, and each environment gets its own constructors. Two supported
ways to use it from workers — plus the pool, which is the batteries-
included version:

**Path handoff** — the worker opens its own connection to the same file
(WAL mode gives real read concurrency):

```js
const w = new Worker('./db-worker.js', {
    workerData: { filename: 'app.db' },
});
```

**Bytes handoff** — move an in-memory database across threads with one
copy (`serializeToBytes()` → transfer → `deserializeFromBytes()`):

```js
const bytes = await db.serializeToBytes();
const movable = bytes.slice().buffer;      // plain ArrayBuffer copy
w.postMessage({ bytes: movable }, [movable]);
// worker: await sqlite3.deserializeFromBytes(new Uint8Array(bytes))
```

**The pool** — one writer plus N read-only reader connections, each on
its own worker; writes queue instead of racing to `SQLITE_BUSY`:

```js
const pool = await sqlite3.pool('app.db', { readers: 4 });

const rows = await pool.read('SELECT * FROM t WHERE a = ?', [1]);
const one  = await pool.get('SELECT b FROM t WHERE a = ?', [1]);
await pool.write('INSERT INTO t (b) VALUES (?)', ['hi']);

await pool.transaction(async (tx) => {
    const row = await tx.get('SELECT a FROM t');   // pinned to the writer
    await tx.write('UPDATE t SET a = ?', [row.a + 1]);
});

await pool.close();   // drains, closes every connection, no worker survives
```

Queries accept `{ signal }` (cancellation crosses the thread boundary
through a shared-memory flag), errors keep `code`/`errno`/`primaryCode`,
and `await using pool` works. Rows are structured-cloned across the
boundary: blob columns come back as `Uint8Array` (not `Buffer`) and huge
result sets pay a copy — the pool is for many small queries, not bulk
reads. See [docs/concurrency.md](docs/concurrency.md) for the full
picture: `serialize()`/`parallelize()` semantics, WAL, busy timeouts,
and when to use one connection, several, or the pool.

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

The default sqlite file header is “SQLite format 3”. You can specify a different magic, though this will make standard tools and libraries unable to work with your files.

```bash
npm install --build-from-source --sqlite_magic=”MyCustomMagic15”
```

Note that the magic _must_ be exactly 15 characters long (16 bytes including null terminator).

## SQLCipher (encrypted databases)

SQLCipher is supported via a **source build** — no prebuild ships with
SQLCipher, because the encryption runtime must come from your system's
SQLCipher. Build flags, Homebrew/Linux paths and the Electron variant are
in [docs/security.md#sqlcipher](docs/security.md#sqlcipher).

### Custom builds and Electron

The default build needs **no Electron-specific step at all**: v9 ships Node-API
10 prebuilds and Node-API is ABI-stable across runtimes, so the prebuild loads
in Electron >= 35 unchanged (see [Electron](#electron) above and
[docs/electron.md](docs/electron.md)).

Running a **source** build (SQLCipher, custom `sqlite_magic`) against Electron
headers needs extra flags for `npm install sqlite3 --build-from-source`
(replace the target with your Electron version):

```bash
--runtime=electron --target=44.0.0 --dist-url=https://electronjs.org/headers
```

The SQLite location and library name go through `GYP_DEFINES`, not
command-line flags — node-gyp 13 treats anything after `--` as a
build-file name. For macOS with Homebrew:

```bash
export GYP_DEFINES="sqlite=$(brew --prefix) sqlite_libname=sqlcipher"
npm install @appthreat/sqlite3 --build-from-source \
    --runtime=electron --target=44.0.0 --dist-url=https://electronjs.org/headers
```

SQLCipher needs the session extension enabled, which packaged builds
usually omit — see [docs/security.md](docs/security.md#sqlcipher).

# Security

The security posture — what this package does and does not protect
against, the Node `--permission` interaction (and how the checks refuse
out-of-scope file access), the `untrusted: true` recipe for hostile
database files, extension-loading policy, and the vendored-SQLite CVE
policy — is documented in [docs/security.md](docs/security.md).
Vulnerability reporting is in [SECURITY.md](SECURITY.md).

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
pnpm run test:electron # the full suite + app-env harness inside Electron
pnpm run test:matrix   # the suite across glibc/musl containers (needs Docker)
```

`test:matrix` exists for the failures that do not reproduce on a developer
machine — a musl-only segfault, or a race that needs an older glibc, a
specific Node and a busy CPU before it shows up at all:

```bash
node tools/test-matrix.mjs --list          # the targets and why each exists
node tools/test-matrix.mjs --cpus=1 --load=6   # simulate a slow CI runner
node tools/test-matrix.mjs --repeat=20 --cmd='node --test test/foo.test.js'
```

It rebuilds the addon and regenerates fixtures inside each container,
ignoring your local `node_modules/`, `build/`, `prebuilds/` and `test/tmp/`,
so a result does not depend on working-tree leftovers.

Always use `pnpm run rebuild`, never bare `pnpm rebuild` — the latter is a
pnpm builtin that rebuilds *dependencies*, not this repo's `rebuild` script.
See [docs/install.md](docs/install.md#development) for the full guide,
including the stale-`prebuilds/` trap when iterating on C++.

# Copyright & license

Copyright (c) 2013-2025 Mapbox & Ghost Foundation
Copyright (c) 2025-2026 Team AppThreat

`@appthreat/sqlite3` is a fork of node-sqlite3 and is
[BSD-3-Clause licensed](https://github.com/AppThreat/node-sqlite3/raw/master/LICENSE),
the same terms as the original. The vendored SQLite amalgamation is public
domain. See [LICENSE](LICENSE) for the full text and the attribution of prior
work.
