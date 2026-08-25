// Shared value corpus for marshalling tests (Deliverable 02 §4). One
// place decides what "every interesting JS value" means, so the bind,
// column, and sync-path suites (D02/D06/D08) all assert the same
// contract. `sqliteType` is the *expected* storage class after a
// round-trip — not necessarily what the current code produces; the
// consumers' job is to close that gap. Entries with `rejected: true`
// must be refused by bind, never silently coerced.
//
// Note on the int64 boundary entries: 2**53+1, 2**63-1 and -(2**63) are
// not all exactly representable as JS numbers (2**63-1 rounds up to
// 2**63); they are included precisely because that neighbourhood is
// where silent-coercion bugs live.

/** @returns {Buffer} a deterministic blob of `n` bytes */
function blob(n) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 251) % 256;
    return b;
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
    // Floats.
    { label: 'fraction', value: Math.PI, sqliteType: 'REAL' },
    { label: 'negative fraction', value: -0.5, sqliteType: 'REAL' },
    { label: 'large exponent', value: 1.5e300, sqliteType: 'REAL' },
    { label: 'negative zero', value: -0, sqliteType: 'REAL' },
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
    // Misc bindable types.
    { label: 'true', value: true, sqliteType: 'INTEGER' },
    { label: 'false', value: false, sqliteType: 'INTEGER' },
    { label: 'null', value: null, sqliteType: 'NULL' },
    { label: 'Date (epoch ms)', value: FIXED_DATE, sqliteType: 'REAL' },
    { label: 'RegExp (toString)', value: /corpus[0-9]+/i, sqliteType: 'TEXT' },
    // Values that bind must reject rather than coerce.
    { label: 'undefined', value: undefined, sqliteType: null, rejected: true },
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
];

/** The subset expected to bind successfully. */
export const bindableValues = corpus.filter((e) => !e.rejected);

/** The subset bind must refuse. */
export const rejectedValues = corpus.filter((e) => e.rejected === true);
