import assert from 'node:assert';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Deliverable 02: int64 bind + the three integer modes. The default
// 'number' mode throws a RangeError for integers outside the safe range
// instead of silently truncating — the single deliberate breaking change
// of this deliverable.
describe('integer modes', function () {
    describe('configure', function () {
        it('defaults to number', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.strictEqual(db.integerMode, 'number');
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('accepts the three modes and rejects anything else', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                for (const mode of ['number', 'bigint', 'mixed']) {
                    db.configure('integerMode', mode);
                    assert.strictEqual(db.integerMode, mode);
                }
                assert.throws(
                    () => db.configure('integerMode', 'nope'),
                    /integerMode must be one of 'number', 'bigint', 'mixed'/,
                );
                assert.throws(
                    () => db.configure('integerMode', 42),
                    /integerMode must be one of/,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('applies to already-prepared statements at read time', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (a)', resolve),
            );
            try {
                db.runSync('INSERT INTO t VALUES (9007199254740993)');
                const stmt = db.prepareSync('SELECT a FROM t');
                db.configure('integerMode', 'bigint');
                assert.strictEqual(stmt.getSync().a, 9007199254740993n);
                stmt.finalize();
                const stmt2 = db.prepareSync('SELECT a FROM t');
                db.configure('integerMode', 'mixed');
                assert.strictEqual(stmt2.getSync().a, 9007199254740993n);
                stmt2.finalize();
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });

    describe('bind', function () {
        it('binds 2**40 exactly through the int64 path', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (a INTEGER)', resolve),
            );
            try {
                db.runSync('INSERT INTO t VALUES (?)', [2 ** 40]);
                const row = db.getSync('SELECT a, typeof(a) AS ty FROM t');
                assert.strictEqual(row.ty, 'integer');
                assert.strictEqual(row.a, 2 ** 40);
                // v8 bound this as a REAL via the Int32 round-trip.
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('binds BigInts in the int64 range exactly', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (a)', resolve),
            );
            try {
                for (const v of [
                    0n,
                    -1n,
                    2147483648n,
                    9007199254740993n,
                    9223372036854775807n,
                    -9223372036854775808n,
                ]) {
                    db.configure('integerMode', 'bigint');
                    db.runSync('INSERT INTO t VALUES (?)', [v]);
                    assert.strictEqual(
                        db.getSync(
                            'SELECT a FROM t WHERE rowid = last_insert_rowid()',
                        ).a,
                        v,
                        String(v),
                    );
                    db.runSync('DELETE FROM t');
                }
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('rejects BigInts outside the int64 range with a RangeError', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                for (const v of [2n ** 63n, -(2n ** 63n) - 1n, 10n ** 30n]) {
                    assert.throws(
                        () => db.runSync('SELECT ? AS v', [v]),
                        (err) =>
                            err instanceof RangeError &&
                            /outside the signed 64-bit integer range/.test(
                                err.message,
                            ),
                        String(v),
                    );
                }
                // The async entry points throw synchronously too.
                const noop = () => undefined;
                assert.throws(
                    () => db.run('SELECT ? AS v', [2n ** 63n], noop),
                    RangeError,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('integral doubles beyond int32 but within int64 bind as INTEGER', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (a)', resolve),
            );
            try {
                for (const v of [2 ** 31, 2 ** 40, 2 ** 53 - 1, -(2 ** 53)]) {
                    db.runSync('INSERT INTO t VALUES (?)', [v]);
                    const row = db.getSync(
                        'SELECT typeof(a) AS ty FROM t WHERE rowid = last_insert_rowid()',
                    );
                    assert.strictEqual(row.ty, 'integer', String(v));
                    db.runSync('DELETE FROM t');
                }
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('integral doubles beyond int64 bind as REAL', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (a)', resolve),
            );
            try {
                db.runSync('INSERT INTO t VALUES (?)', [2.3948728634826374e83]);
                const row = db.getSync('SELECT typeof(a) AS ty, a FROM t');
                assert.strictEqual(row.ty, 'real');
                assert.strictEqual(row.a, 2.3948728634826374e83);
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('the double 2**63 (rounded 2**63-1) clamps to INT64_MAX', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (a)', resolve),
            );
            try {
                db.runSync('INSERT INTO t VALUES (?)', [2 ** 63 - 1]);
                const row = db.getSync('SELECT typeof(a) AS ty FROM t');
                assert.strictEqual(row.ty, 'integer');
                // Exact stored value: INT64_MAX, visible in 'bigint' mode.
                db.configure('integerMode', 'bigint');
                assert.strictEqual(
                    db.getSync('SELECT a FROM t').a,
                    9223372036854775807n,
                );
                // The default mode refuses it instead of truncating.
                db.configure('integerMode', 'number');
                assert.throws(() => db.getSync('SELECT a FROM t'), RangeError);
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });

    describe("mode 'number' (default)", function () {
        it('reads safe integers as numbers', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.strictEqual(db.getSync('SELECT 42 AS v').v, 42);
                assert.strictEqual(
                    db.getSync(`SELECT ${Number.MAX_SAFE_INTEGER} AS v`).v,
                    Number.MAX_SAFE_INTEGER,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('throws a RangeError naming the column and value for unsafe integers', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.throws(
                    () => db.getSync('SELECT 9007199254740993 AS v'),
                    (err) =>
                        err instanceof RangeError &&
                        /9007199254740993/.test(err.message) &&
                        /column 'v'/.test(err.message),
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('delivers the RangeError to async callbacks instead of a wrong row', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                const err = await new Promise((resolve) =>
                    db.get('SELECT 9007199254740993 AS v', (e) => resolve(e)),
                );
                assert.ok(err instanceof RangeError);
                const errAll = await new Promise((resolve) =>
                    db.all('SELECT 9007199254740993 AS v', (e) => resolve(e)),
                );
                assert.ok(errAll instanceof RangeError);
                const errEach = await new Promise((resolve) => {
                    db.each(
                        'SELECT 9007199254740993 AS v',
                        (e) => resolve(e),
                        () => resolve(null),
                    );
                });
                assert.ok(errEach instanceof RangeError);
                const errMap = await new Promise((resolve) => {
                    db.map('SELECT 9007199254740993 AS v, 1 AS extra', (e) =>
                        resolve(e),
                    );
                });
                assert.ok(errMap instanceof RangeError);
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });

    describe("mode 'bigint'", function () {
        it('reads every integer as a BigInt', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                db.configure('integerMode', 'bigint');
                assert.strictEqual(db.getSync('SELECT 42 AS v').v, 42n);
                assert.strictEqual(
                    db.getSync('SELECT 9007199254740993 AS v').v,
                    9007199254740993n,
                );
                assert.strictEqual(
                    db.getSync('SELECT -9223372036854775808 AS v').v,
                    -9223372036854775808n,
                ); // Non-integer columns are untouched.
                assert.strictEqual(db.getSync('SELECT 1.5 AS v').v, 1.5);
                assert.strictEqual(db.getSync("SELECT 'x' AS v").v, 'x');
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });

    describe("mode 'mixed'", function () {
        it('reads safe integers as numbers and unsafe ones as BigInts', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                db.configure('integerMode', 'mixed');
                assert.strictEqual(db.getSync('SELECT 42 AS v').v, 42);
                assert.strictEqual(
                    db.getSync('SELECT 9007199254740993 AS v').v,
                    9007199254740993n,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });
});

describe('lastID and lastIDBigInt', function () {
    const BIG = 2 ** 53 + 2; // first representable double above the safe range

    function bigRowidDb() {
        const db = new sqlite3.Database(':memory:');
        return new Promise((resolve) =>
            db.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, a)', () =>
                resolve(db),
            ),
        );
    }

    it('stays a safe number for ordinary inserts in every mode', async function () {
        for (const mode of ['number', 'bigint', 'mixed']) {
            const db = await bigRowidDb();
            try {
                db.configure('integerMode', mode);
                const result = db.runSync('INSERT INTO t (a) VALUES (1)');
                if (mode === 'bigint') {
                    assert.strictEqual(result.lastID, 1n);
                } else {
                    assert.strictEqual(result.lastID, 1);
                }
                assert.strictEqual(result.changes, 1);
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        }
    });

    it('throws in number mode, is a BigInt in bigint/mixed, at 2**53+1', async function () {
        const db = await bigRowidDb();
        try {
            await new Promise((resolve) =>
                db.exec(`INSERT INTO t (rowid, a) VALUES (${BIG}, 1)`, resolve),
            );

            db.configure('integerMode', 'number');
            // db.runSync eagerly reads lastID for its result object, so
            // the RangeError fires there; the statement-level runSync
            // only throws when lastID is actually read.
            assert.throws(
                () => db.runSync('INSERT INTO t (a) VALUES (2)'),
                (err) =>
                    err instanceof RangeError && /in lastID/.test(err.message),
            );
            const stmt = db.prepareSync('INSERT INTO t (a) VALUES (?)');
            stmt.runSync([3]);
            assert.throws(() => void stmt.lastID, RangeError);
            // The throwing db.runSync above did complete its insert
            // (rowid BIG+1) before its eager lastID read threw.
            assert.strictEqual(stmt.lastIDBigInt, BigInt(BIG) + 2n);
            stmt.finalize();

            db.configure('integerMode', 'bigint');
            assert.strictEqual(
                db.runSync('INSERT INTO t (a) VALUES (3)').lastID,
                BigInt(BIG) + 3n,
            );

            db.configure('integerMode', 'mixed');
            assert.strictEqual(
                db.runSync('INSERT INTO t (a) VALUES (4)').lastID,
                BigInt(BIG) + 4n,
            );
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });

    it('lastIDBigInt is exact in every mode', async function () {
        for (const mode of ['number', 'bigint', 'mixed']) {
            const db = await bigRowidDb();
            try {
                db.configure('integerMode', mode);
                const stmt = db.prepareSync(
                    `INSERT INTO t (rowid, a) VALUES (${BIG}, 1)`,
                );
                stmt.runSync();
                assert.strictEqual(stmt.lastIDBigInt, BigInt(BIG));
                stmt.finalize();
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        }
    });

    it('exposes lastID/changes through the async run callback this', async function () {
        const db = await bigRowidDb();
        try {
            const seen = await new Promise((resolve) =>
                db.run('INSERT INTO t (a) VALUES (1)', function (err) {
                    assert.ifError(err);
                    resolve({ lastID: this.lastID, changes: this.changes });
                }),
            );
            assert.strictEqual(seen.lastID, 1);
            assert.strictEqual(seen.changes, 1);
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });

    it('reading an unsafe lastID inside an async callback throws a RangeError', async function () {
        const db = await bigRowidDb();
        try {
            await new Promise((resolve) =>
                db.exec(`INSERT INTO t (rowid, a) VALUES (${BIG}, 1)`, resolve),
            );
            const err = await new Promise((resolve) =>
                db.run('INSERT INTO t (a) VALUES (2)', function (e) {
                    if (e) return resolve(e);
                    try {
                        void this.lastID;
                    } catch (caught) {
                        resolve(caught);
                    }
                    resolve(null);
                }),
            );
            assert.ok(err instanceof RangeError, String(err));
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });

    it('lastID and changes are undefined before the first run', async function () {
        const db = await bigRowidDb();
        try {
            const stmt = db.prepareSync('INSERT INTO t (a) VALUES (?)');
            assert.strictEqual(stmt.lastID, undefined);
            assert.strictEqual(stmt.changes, undefined);
            assert.strictEqual(stmt.lastIDBigInt, undefined);
            stmt.finalize();
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });
});
