# Migrating to v9

v9 fixes a class of silent data-corruption bugs in the value marshalling
between JavaScript and SQLite. Code that was already receiving **wrong
values** will now see errors instead; code that was correct keeps working.
Everything below is a consequence of that single principle.

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
