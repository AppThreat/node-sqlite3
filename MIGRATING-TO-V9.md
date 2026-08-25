# Migrating to v9

v9 fixes a class of silent data-corruption bugs in the value marshalling
between JavaScript and SQLite, and adds the promise API, async iteration,
disposal and cancellation. Code that was already receiving **wrong
values** will now see errors instead; code that was correct keeps working.
Everything below follows from those two principles.

## Calls without a callback now return promises

`run`, `get`, `all`, `map`, `exec`, `close`, `wait`, `loadExtension` on a
`Database`, and `bind`, `run`, `get`, `all`, `map`, `reset`, `finalize` on
a `Statement` (plus `step`/`finish` on `Backup`) are dual-mode: a trailing
function keeps the callback contract byte-for-byte (still returns `this`,
still chainable); without one you get a promise.

- `db.run(sql, params)` resolves `{ lastID, changes, lastIDBigInt }`.
  `lastID` applies the integer mode and keeps the 'number'-mode
  `RangeError` for unsafe rowids **lazy** — it throws only when read, so
  awaiting an insert into a big-rowid table never throws by itself.
  `lastIDBigInt` is exact in every mode.
- Strict-binding errors that used to throw synchronously from a
  callback-less call (bad bind values, arity mismatches) are now
  rejections; the orphaned statement is still finalized.
- A callback-less call that failed used to emit `'error'` on the database;
  that failure is now a rejection. Calls that pass a callback (including
  the whole pre-v9 test suite's usage) are unchanged.
- `each()` is callback-only; calling it without callbacks throws a
  `TypeError` pointing at `iterate()`. Streaming without callbacks was a
  silent no-op before.
- `db.prepare()` and `db.backup()` keep their synchronous return in every
  form — ~60 places in the callback regression suite rely on it. A
  prepare error still surfaces on the statement's `'error'` event.

New in this release: top-level `sqlite3.open()` (promise-native open),
`db.iterate()`/`stmt.iterate()` (pull-based async iteration with
backpressure, backed by the new native `Statement#fetch(count)`),
`db.stream()` (object-mode `Readable`), `db.transaction()` (BEGIN/COMMIT
with rollback on throw, automatic savepoints when nested), and
`Symbol.asyncDispose`/`Symbol.dispose` for `await using`/`using`.

## Cancellation is connection-wide

Promise-mode calls, `iterate()` and `transaction()` accept a trailing
`{ signal }` options object (an `AbortSignal`). An already-aborted signal
rejects before scheduling anything. Aborting afterwards calls
`db.interrupt()` and rejects with the signal's reason — **interrupting
every in-flight statement on that connection**, not just the awaited one.
That is a SQLite constraint: `sqlite3_interrupt` has no per-statement
form. Work that was queued but not started when the abort lands may still
run to completion; its result is dropped. The signal listener is removed
when the call settles, so one long-lived signal does not accumulate
listeners.

## `map()` single-column results are rows, not `undefined`

`db.map('SELECT id FROM t')` used to build `{ id: undefined }` (the
two-column code path read a missing second column). A single-column
result now maps the key to the whole row, consistent with the three-plus
column rule.

## Integer reads now refuse to truncate (default `'number'` mode)

In v8, any INTEGER column value outside the safe integer range
(±2^53−1) came back as a silently rounded `number`. In v9 the default
throws instead:

```js
db.get("SELECT some_big_rowid FROM t", (err, row) => {
    // v9: err instanceof RangeError, message names the column and value
});
```

Pick the behaviour you want with `configure('integerMode', mode)`
(readable as `db.integerMode`):

- `'number'` (default) — `number` when safe, `RangeError` otherwise.
- `'bigint'` — every INTEGER column and `lastID` is a `BigInt`.
- `'mixed'` — `number` when safe, `BigInt` otherwise. Recommended for
  anything touching `rowid`s.

`Statement#lastIDBigInt` is exact in every mode if you need a large
rowid without switching modes.

## Integers bind as true 64-bit values

Integral numbers within the int64 range now bind via
`sqlite3_bind_int64` instead of `sqlite3_bind_int`, and `BigInt`
parameters are accepted (exact; `RangeError` outside the signed 64-bit
range). In v8 anything above int32 was silently stored as a REAL, which
broke `WHERE` matches on STRICT tables and typeof-based checks:

```js
db.runSync("INSERT INTO t VALUES (?)", 2 ** 40);
// v8: typeof(a) === 'real';  v9: typeof(a) === 'integer'
```

`lastID` follows the integer mode: a `RangeError` in `'number'` mode
when the rowid is unsafe (note `db.runSync` reads `lastID` eagerly for
its result object), a `BigInt` in `'bigint'`/`'mixed'`.

## Objects no longer bind as the string `"[object Object]"`

In v8 every plain object, array, `Map` and class instance bound as the
eleven-byte TEXT `"[object Object]"` (arrays passed directly were also
treated as named-parameter maps). In v9 these throw a `TypeError`
naming the parameter index and constructor:

```js
db.run("INSERT INTO t VALUES (?)", { a: 1 }, (err) => { /* v8: stored "[object Object]" */ });
db.runSync("INSERT INTO t VALUES (?)", [{ a: 1 }]);
// v9 TypeError: Cannot bind parameter 1: unsupported type Object.
//        Serialize it explicitly (e.g. JSON.stringify) before binding.
```

Serialize explicitly: `JSON.stringify(value)`, or bind the object's
fields as named parameters (`INSERT INTO t VALUES ($a)` with `{ $a: 1 }`).

`undefined` binds as NULL, matching `null` — object shorthand like
`{ $x: obj.maybeMissing }` keeps working. The one historic shape kept
on purpose: an argument list consisting only of `undefined` against a
statement with no parameters is ignored
(`db.run(sql, undefined, cb)` still runs the statement).

## Parameter-count mismatches and unknown named parameters are errors

- Too few parameters (`SELECT ?, ?` with one value): v8 silently bound
  NULL for the missing ones; v9 reports an error.
- Too many parameters, or extra keys on a named-parameter object: v8
  ignored them (or surfaced a bare `SQLITE_RANGE`); v9 reports
  `"supplied N parameter(s) but the statement takes M"`.
- A named parameter that does not exist in the SQL
  (`db.get('SELECT $a', { $b: 1 })`): v9 reports
  `"unknown named parameter \"$b\""`.

## Blob binding accepts every binary view

`Uint8Array` (byte range honoured, including non-zero `byteOffset`),
`DataView`, `ArrayBuffer`, typed arrays over `SharedArrayBuffer`, and
Node `Buffer` all bind as BLOBs of their exact byte range. Reads still
return Node `Buffer`s.

## `err.code` is now the extended result code

v8 reported only the 26 primary codes. v9 enables SQLite extended
result codes, so a unique violation is `SQLITE_CONSTRAINT_UNIQUE`
instead of `SQLITE_CONSTRAINT`. Every error carries:

- `err.code` — extended name (`'SQLITE_CONSTRAINT_UNIQUE'`),
- `err.errno` — extended numeric code,
- `err.primaryCode` — primary name (`'SQLITE_CONSTRAINT'`).

Migrate `err.code === 'SQLITE_CONSTRAINT'` checks to
`err.primaryCode === 'SQLITE_CONSTRAINT'` (or match the specific
extended code). The `SQLITE_CONSTRAINT_*`, `SQLITE_BUSY_*`,
`SQLITE_READONLY_*`, `SQLITE_IOERR_*`, `SQLITE_CANTOPEN_*` and other
extended families are exported as constants, as are the previously
missing open flags `OPEN_NOMUTEX`, `OPEN_MEMORY`, `OPEN_EXRESCODE`.

## The connection state is native truth: `db.state`

The internal scheduling state is now exposed read-only from the native
side and the JS-side mirrors are gone:

- `db.state` is a frozen snapshot `{ open, closing, locked, serialized,
  pending, queued }`, computed on read; the same fields are also
  individual read-only accessors (`db.serialized`, `db.closing`, ...).
- `db._serialized` and `db._closing` (undocumented JS-side mirrors,
  maintained by monkey-patching `serialize`/`parallelize`) **no longer
  exist**. `serialize()`/`parallelize()` are now the native methods
  directly — code that relied on the mirrors should read `db.state` or
  the individual accessors.
- The mirror deletion fixes a real bug: anything that reached the native
  `serialize` other than through the patched prototype (a saved
  prototype reference, `Reflect.apply`) desynchronised `_serialized`,
  and the statement cache then kept taking its fast path while the
  connection was serialized — silently breaking the FIFO guarantee
  `serialize()` promises.
- `db._queueBusy()` (undocumented, `@internal`) is **deprecated** in
  favour of `db.state` and will be removed in a later minor release.
- `stmt.finalized` is new read-only state: true once a statement was
  finalized (explicitly, after a failed prepare, or by the GC safety
  net).

## Concurrent `transaction()` calls now fail loudly

Nesting used to be tracked with a connection-wide counter, so a second
transaction started *concurrently* (not nested inside the first's body)
silently rode inside the first as a savepoint: its "commit" was a
`RELEASE` the first transaction's rollback would have undone, and its
work only persisted if the unrelated first transaction committed.
Nesting is now tracked per async flow (`AsyncLocalStorage`): calls made
from inside a transaction body — including across `await` — still nest
via savepoints, but a concurrent top-level `BEGIN` rejects with
`a transaction is already active on this connection`. Serialize
concurrent flows yourself (or open a second connection).

## A failed prepare no longer strands the calls queued behind it

When preparing a statement failed, the calls already queued against that
statement were discarded without their callbacks ever being invoked. In
callback style the call simply never came back; in promise style the
promise never settled. Those calls are now failed with the prepare's own
error, so they reject (or call back) like any other failure.

This is most visible with `AbortSignal`: `sqlite3_interrupt()` aborts a
prepare just as readily as it aborts a running step, so an abort landing
in that window used to wedge the connection. It also fixes
`stmt.iterate()` on a statement whose own prepare failed, where `next()`
waited forever on a dropped fetch and `return()` never settled.

The statement still reports the failure on its own `'error'` event when
the prepare was given no callback, so that surface is unchanged. `each()`
delivers the error to its completion handler — or, if it was called
without one, to its row callback; it is never handed to both, and the row
callback is never invoked with a row-shaped call it has no row for.

## Minor notes

- `Date` still binds as epoch milliseconds (REAL) and reads back as a
  `number` — unchanged, now documented. An opt-in TEXT form may arrive
  in a later minor release.
- `RegExp` still binds as its source string (`"/re/g"`).
- `NaN` binds as NULL (SQLite `bind_double` semantics) — unchanged.
- `-0` binds as INTEGER `0` (SQLite has no signed integer zero).
- Strings containing lone surrogates are converted to U+FFFD at the
  UTF-8 boundary, as in v8.
- `lastID`/`changes` are now prototype accessors rather than own
  enumerable properties assigned after each run; they read `undefined`
  before the first run, and `JSON.stringify` of a statement no longer
  includes them.

## TypeScript consumers

The type declarations are now generated (`pnpm run gen-types`) from the
JSDoc in `lib/*.js` plus two hand-written declaration files (`lib/native.d.ts`
for the addon's shape, `lib/augment.d.ts` for the JS layer's members), and
CI fails if they drift. Behavioural changes visible in the types:

- Parameterized promise calls now resolve to `Promise`: `db.all(sql, 1)`
  is `Promise<Row[]>` (previously it fell through to a callback overload
  and typed as the database). Callback calls still type as the receiver.
- Promise-mode methods that accept an `AbortSignal` type the trailing
  `{ signal }` options object (`SignalOptions`); `iterate()`/`stream()`
  accept it too.
- Bind parameters are typed (`BindValue`/`BindParams`), so binding e.g. a
  `Symbol` is a compile error, matching the runtime strict-binding rule.
- The SQLite constants have literal types (`sqlite3.OPEN_READONLY` is
  `1`), so flag combinations are checkable.
- `db.get`'s callback row is `row?: T` and the promise resolves
  `T | undefined` in every mode, matching the runtime.
- The namespace carries `cached.objects`, and the classes expose
  `db.filename`/`db.mode`/`stmt.sql` and the `Backup` own-properties,
  none of which were declared before.
- The ~128 module-level `export const` constants that the old
  declarations listed never existed at runtime (importing them by name
  returned `undefined`); they are gone from the types — use the default
  namespace object, which does carry them.
