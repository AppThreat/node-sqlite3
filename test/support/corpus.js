// Shared value corpus for marshalling tests (Deliverable 02 §4). One
// place decides what "every interesting JS value" means, so the bind,
// column, and sync-path suites (D02/D06/D08) all assert the same
// contract. `sqliteType` is the *expected* storage class after a
// round-trip. Entries with `rejected: true` must be refused by bind
// (TypeError by default, RangeError for out-of-range BigInts), never
// silently coerced.
//
// Notes on the boundary entries:
// - 2**53+1, 2**63-1 and -(2**63) as *numbers* are not all exactly
//   representable (2**63-1 rounds up to 2**63); they are included
//   precisely because that neighbourhood is where silent-coercion bugs
//   live. The double 2**63 clamps to INT64_MAX on bind.
// - `undefined` binds as NULL (Deliverable 02 decision): object shorthand
//   { $x: obj.maybeMissing } is a common call shape, and typo'd property
//   names are caught by the named-parameter and arity checks instead.
// - -0 binds as INTEGER 0: SQLite has no signed integer zero, and v8
//   pinned the same behaviour (test/marshalling.test.js).

/** @returns {Buffer} a deterministic blob of `n` bytes */
function blob(n) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 251) % 256;
    return b;
}

/** @returns {Uint8Array} a deterministic view of `n` bytes */
function u8(n) {
    return new Uint8Array(blob(n));
}

/**
 * Builds typed-array/DataView/ArrayBuffer views over one deterministic
 * 16-byte buffer so byteOffset handling is observable.
 *
 * @returns {{ plain: Uint8Array, offset: Uint8Array, dataview: DataView, arraybuffer: ArrayBuffer, shared: Uint8Array, u16: Uint16Array }}
 */
function views() {
    const bytes = blob(16);
    const plain = new Uint8Array(bytes);
    const offset = new Uint8Array(bytes.buffer, 4, 8);
    const dataview = new DataView(bytes.buffer, 2, 6);
    const sab = new SharedArrayBuffer(16);
    new Uint8Array(sab).set(bytes);
    const shared = new Uint8Array(sab);
    const u16 = new Uint16Array(
        bytes.buffer.slice(0), // own copy: byte length must be even
        0,
        8,
    );
    return { plain, offset, dataview, arraybuffer: bytes.buffer, shared, u16 };
}

const FIXED_DATE = new Date('2026-08-25T12:34:56.789Z');

export const corpus = [
    // Safe integers.
    { label: 'zero', value: 0, sqliteType: 'INTEGER' },
    { label: 'one', value: 1, sqliteType: 'INTEGER' },
    { label: 'negative one', value: -1, sqliteType: 'INTEGER' },
    { label: 'int32 max', value: 2 ** 31 - 1, sqliteType: 'INTEGER' },
    { label: 'int32 min', value: -(2 ** 31), sqliteType: 'INTEGER' },
    {
        label: 'max safe integer',
        value: Number.MAX_SAFE_INTEGER,
        sqliteType: 'INTEGER',
    },
    // int64 boundaries beyond the safe-integer range.
    { label: '2**53 + 1', value: 2 ** 53 + 1, sqliteType: 'INTEGER' },
    {
        label: '2**63 - 1 (rounds to 2**63 as a double)',
        value: 2 ** 63 - 1,
        sqliteType: 'INTEGER',
    },
    { label: '-(2**63)', value: -(2 ** 63), sqliteType: 'INTEGER' },
    // BigInts: exact, no clamping.
    { label: 'bigint one', value: 1n, sqliteType: 'INTEGER' },
    {
        label: 'bigint 2**53 + 1',
        value: 9007199254740993n,
        sqliteType: 'INTEGER',
    },
    {
        label: 'bigint 2**63 - 1',
        value: 9223372036854775807n,
        sqliteType: 'INTEGER',
    },
    {
        label: 'bigint -(2**63)',
        value: -(2n ** 63n),
        sqliteType: 'INTEGER',
    },
    // Floats.
    { label: 'fraction', value: Math.PI, sqliteType: 'REAL' },
    { label: 'negative fraction', value: -0.5, sqliteType: 'REAL' },
    { label: 'large exponent', value: 1.5e300, sqliteType: 'REAL' },
    // -0 is INTEGER 0: no signed zero exists in SQLite integers.
    { label: 'negative zero', value: -0, sqliteType: 'INTEGER' },
    // SQLite converts NaN to NULL on bind_double; Infinity stays REAL.
    { label: 'NaN', value: Number.NaN, sqliteType: 'NULL' },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY, sqliteType: 'REAL' },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY, sqliteType: 'REAL' },
    // Strings.
    { label: 'empty string', value: '', sqliteType: 'TEXT' },
    { label: 'string with NUL byte', value: 'a\0b', sqliteType: 'TEXT' },
    {
        label: 'lone high surrogate',
        value: 'before \uD800 after',
        sqliteType: 'TEXT',
    },
    {
        label: 'lone low surrogate',
        value: 'before \uDC00 after',
        sqliteType: 'TEXT',
    },
    { label: 'non-BMP text', value: 'sqlite \u{1F5A0} v9', sqliteType: 'TEXT' },
    // Blobs at page-boundary-adjacent sizes and 1 MiB.
    { label: 'empty blob', value: blob(0), sqliteType: 'BLOB' },
    { label: '64-byte blob', value: blob(64), sqliteType: 'BLOB' },
    { label: '4095-byte blob', value: blob(4095), sqliteType: 'BLOB' },
    { label: '4096-byte blob', value: blob(4096), sqliteType: 'BLOB' },
    { label: '4097-byte blob', value: blob(4097), sqliteType: 'BLOB' },
    { label: '1 MiB blob', value: blob(1024 * 1024), sqliteType: 'BLOB' },
    // Typed-array views bind as blobs of their exact byte range.
    { label: 'Uint8Array', value: u8(32), sqliteType: 'BLOB' },
    {
        label: 'Uint8Array with byteOffset',
        value: views().offset,
        sqliteType: 'BLOB',
    },
    {
        label: 'DataView with byteOffset',
        value: views().dataview,
        sqliteType: 'BLOB',
    },
    { label: 'ArrayBuffer', value: views().arraybuffer, sqliteType: 'BLOB' },
    {
        label: 'Uint8Array over SharedArrayBuffer',
        value: views().shared,
        sqliteType: 'BLOB',
    },
    {
        label: 'Uint16Array (raw bytes)',
        value: views().u16,
        sqliteType: 'BLOB',
    },
    // Misc bindable types.
    { label: 'true', value: true, sqliteType: 'INTEGER' },
    { label: 'false', value: false, sqliteType: 'INTEGER' },
    { label: 'null', value: null, sqliteType: 'NULL' },
    {
        label: 'undefined (binds as NULL)',
        value: undefined,
        sqliteType: 'NULL',
    },
    { label: 'Date (epoch ms)', value: FIXED_DATE, sqliteType: 'REAL' },
    { label: 'RegExp (toString)', value: /corpus[0-9]+/i, sqliteType: 'TEXT' },
    // Values that bind must refuse rather than coerce.
    {
        label: 'plain object',
        value: { nope: 1 },
        sqliteType: null,
        rejected: true,
    },
    { label: 'array', value: [1, 2, 3], sqliteType: null, rejected: true },
    {
        label: 'Symbol',
        value: Symbol('corpus'),
        sqliteType: null,
        rejected: true,
    },
    {
        label: 'function',
        value: () => {
            /* intentionally does nothing */
        },
        sqliteType: null,
        rejected: true,
    },
    {
        label: 'Map',
        value: new Map([['a', 1]]),
        sqliteType: null,
        rejected: true,
    },
    {
        label: 'class instance',
        value: new (class Widget {
            constructor() {
                this.size = 1;
            }
        })(),
        sqliteType: null,
        rejected: true,
    },
    {
        label: 'bigint 2**63 (out of int64 range)',
        value: 2n ** 63n,
        sqliteType: null,
        rejected: true,
        rejection: 'RangeError',
    },
    {
        label: 'bigint -(2**63)-1 (out of int64 range)',
        value: -(2n ** 63n) - 1n,
        sqliteType: null,
        rejected: true,
        rejection: 'RangeError',
    },
];

/** The subset expected to bind successfully. */
export const bindableValues = corpus.filter((e) => !e.rejected);

/** The subset bind must refuse. */
export const rejectedValues = corpus.filter((e) => e.rejected === true);
