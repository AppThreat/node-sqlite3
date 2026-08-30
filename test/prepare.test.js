import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('prepare', function () {
    describe('invalid SQL', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        let _stmt;
        it('should fail preparing a statement with invalid SQL', function (_t, done) {
            _stmt = db.prepare(
                'CRATE TALE foo text bar)',
                function (err, _statement) {
                    if (
                        err &&
                        err.errno === sqlite3.ERROR &&
                        err.message ===
                            'SQLITE_ERROR: near "CRATE": syntax error'
                    ) {
                        done();
                    } else throw err;
                },
            );
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('simple prepared statement', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        it('should prepare, run and finalize the statement', function (_t, done) {
            db.prepare('CREATE TABLE foo (text bar)')
                .run(function (err) {
                    if (err) throw err;
                })
                .finalize(done);
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('inserting and retrieving rows', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        let inserted = 0;
        let retrieved = 0;

        // We insert and retrieve that many rows.
        const count = 1000;

        it('should create the table', function (_t, done) {
            db.prepare(
                'CREATE TABLE foo (txt text, num int, flt float, blb blob)',
            )
                .run(function (err) {
                    if (err) throw err;
                })
                .finalize(done);
        });

        it(`should insert ${count} rows`, function (_t, done) {
            for (let i = 0; i < count; i++) {
                db.prepare('INSERT INTO foo VALUES(?, ?, ?, ?)')
                    .run(
                        `String ${i}`,
                        i,
                        i * Math.PI,
                        // The 4th parameter is bound explicitly: v9 rejects
                        // a parameter-count mismatch instead of silently
                        // binding the missing ones as NULL.
                        null,
                        function (err) {
                            if (err) throw err;
                            inserted++;
                        },
                    )
                    .finalize(function (err) {
                        if (err) throw err;
                        if (inserted === count) done();
                    });
            }
        });

        it(`should prepare a statement and run it ${count + 5} times`, function (_t, done) {
            const stmt = db.prepare(
                'SELECT txt, num, flt, blb FROM foo ORDER BY num',
                function (err) {
                    if (err) throw err;
                    assert.equal(
                        stmt.sql,
                        'SELECT txt, num, flt, blb FROM foo ORDER BY num',
                    );
                },
            );

            for (let i = 0; i < count + 5; i++)
                (function (i) {
                    stmt.get(function (err, row) {
                        if (err) throw err;

                        if (retrieved >= 1000) {
                            assert.equal(row, undefined);
                        } else {
                            assert.equal(row.txt, `String ${i}`);
                            assert.equal(row.num, i);
                            assert.equal(row.flt, i * Math.PI);
                            assert.equal(row.blb, null);
                        }

                        retrieved++;
                    });
                })(i);

            stmt.finalize(done);
        });

        it(`should have retrieved ${count + 5} rows`, function () {
            assert.equal(count + 5, retrieved, "Didn't retrieve all rows");
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('inserting with accidental undefined', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        let inserted = 0;
        let retrieved = 0;

        it('should create the table', function (_t, done) {
            db.prepare('CREATE TABLE foo (num int)')
                .run(function (err) {
                    if (err) throw err;
                })
                .finalize(done);
        });

        it('should insert two rows', function (_t, done) {
            db.prepare('INSERT INTO foo VALUES(4)')
                .run(function (err) {
                    if (err) throw err;
                    inserted++;
                })
                .run(undefined, function (err) {
                    // The second time we pass undefined as a parameter. This is
                    // a mistake, but it should either throw an error or be ignored,
                    // not silently fail to run the statement.
                    if (err) throw err;
                    inserted++;
                })
                .finalize(function (err) {
                    if (err) throw err;
                    if (inserted === 2) done();
                });
        });

        it('should retrieve the data', function (_t, done) {
            const stmt = db.prepare('SELECT num FROM foo', function (err) {
                if (err) throw err;
            });

            for (let i = 0; i < 2; i++)
                (function (_i) {
                    stmt.get(function (err, row) {
                        if (err) throw err;
                        assert(row);
                        assert.equal(row.num, 4);
                        retrieved++;
                    });
                })(i);

            stmt.finalize(done);
        });

        it('should have retrieved two rows', function () {
            assert.equal(2, retrieved, "Didn't retrieve all rows");
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('retrieving reset() function', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(
                'test/support/prepare.db',
                sqlite3.OPEN_READONLY,
                done,
            );
        });

        let retrieved = 0;

        it('should retrieve the same row over and over again', function (_t, done) {
            const stmt = db.prepare(
                'SELECT txt, num, flt, blb FROM foo ORDER BY num',
            );
            for (let i = 0; i < 10; i++) {
                stmt.reset();
                stmt.get(function (err, row) {
                    if (err) throw err;
                    assert.equal(row.txt, 'String 0');
                    assert.equal(row.num, 0);
                    assert.equal(row.flt, 0.0);
                    assert.equal(row.blb, null);
                    retrieved++;
                });
            }
            stmt.finalize(done);
        });

        it('should have retrieved 10 rows', function () {
            assert.equal(10, retrieved, "Didn't retrieve all rows");
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('multiple get() parameter binding', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(
                'test/support/prepare.db',
                sqlite3.OPEN_READONLY,
                done,
            );
        });

        let retrieved = 0;

        it('should retrieve particular rows', function (_t, done) {
            const stmt = db.prepare(
                'SELECT txt, num, flt, blb FROM foo WHERE num = ?',
            );

            for (let i = 0; i < 10; i++)
                (function (i) {
                    stmt.get(i * 10 + 1, function (err, row) {
                        if (err) throw err;
                        const val = i * 10 + 1;
                        assert.equal(row.txt, `String ${val}`);
                        assert.equal(row.num, val);
                        assert.equal(row.flt, val * Math.PI);
                        assert.equal(row.blb, null);
                        retrieved++;
                    });
                })(i);

            stmt.finalize(done);
        });

        it('should have retrieved 10 rows', function () {
            assert.equal(10, retrieved, "Didn't retrieve all rows");
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('prepare() parameter binding', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(
                'test/support/prepare.db',
                sqlite3.OPEN_READONLY,
                done,
            );
        });

        let retrieved = 0;

        it('should retrieve particular rows', function (_t, done) {
            db.prepare(
                'SELECT txt, num, flt, blb FROM foo WHERE num = ? AND txt = ?',
                10,
                'String 10',
            )
                .get(function (err, row) {
                    if (err) throw err;
                    assert.equal(row.txt, 'String 10');
                    assert.equal(row.num, 10);
                    assert.equal(row.flt, 10 * Math.PI);
                    assert.equal(row.blb, null);
                    retrieved++;
                })
                .finalize(done);
        });

        it('should have retrieved 1 row', function () {
            assert.equal(1, retrieved, "Didn't retrieve all rows");
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('all()', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(
                'test/support/prepare.db',
                sqlite3.OPEN_READONLY,
                done,
            );
        });

        let retrieved = 0;
        const count = 1000;

        it('should retrieve particular rows', function (_t, done) {
            db.prepare(
                'SELECT txt, num, flt, blb FROM foo WHERE num < ? ORDER BY num',
                count,
            )
                .all(function (err, rows) {
                    if (err) throw err;
                    for (let i = 0; i < rows.length; i++) {
                        assert.equal(rows[i].txt, `String ${i}`);
                        assert.equal(rows[i].num, i);
                        assert.equal(rows[i].flt, i * Math.PI);
                        assert.equal(rows[i].blb, null);
                        retrieved++;
                    }
                })
                .finalize(done);
        });

        it('should have retrieved all rows', function () {
            assert.equal(count, retrieved, "Didn't retrieve all rows");
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('all()', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(
                'test/support/prepare.db',
                sqlite3.OPEN_READONLY,
                done,
            );
        });

        it('should retrieve particular rows', function (_t, done) {
            db.prepare('SELECT txt, num, flt, blb FROM foo WHERE num > 5000')
                .all(function (err, rows) {
                    if (err) throw err;
                    assert.ok(rows.length === 0);
                })
                .finalize(done);
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('high concurrency', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        function randomString() {
            let str = '';
            for (let i = Math.random() * 300; i > 0; i--) {
                str += String.fromCharCode(Math.floor(Math.random() * 256));
            }
            return str;
        }

        // Generate random data.
        const data = [];
        const length = Math.floor(Math.random() * 1000) + 200;
        for (let i = 0; i < length; i++) {
            data.push([randomString(), i, i * Math.random(), null]);
        }

        let inserted = 0;
        let retrieved = 0;

        it('should create the table', function (_t, done) {
            db.prepare(
                'CREATE TABLE foo (txt text, num int, flt float, blb blob)',
            )
                .run(function (err) {
                    if (err) throw err;
                })
                .finalize(done);
        });

        it('should insert all values', function (_t, done) {
            for (let i = 0; i < data.length; i++) {
                const stmt = db.prepare('INSERT INTO foo VALUES(?, ?, ?, ?)');
                stmt.run(
                    data[i][0],
                    data[i][1],
                    data[i][2],
                    data[i][3],
                    function (err) {
                        if (err) throw err;
                        inserted++;
                    },
                ).finalize(function (err) {
                    if (err) throw err;
                    if (inserted === data.length) done();
                });
            }
        });

        it('should retrieve all values', function (_t, done) {
            db.prepare('SELECT txt, num, flt, blb FROM foo')
                .all(function (err, rows) {
                    if (err) throw err;

                    for (let i = 0; i < rows.length; i++) {
                        assert.ok(data[rows[i].num] !== true);

                        assert.equal(rows[i].txt, data[rows[i].num][0]);
                        assert.equal(rows[i].num, data[rows[i].num][1]);
                        assert.equal(rows[i].flt, data[rows[i].num][2]);
                        assert.equal(rows[i].blb, data[rows[i].num][3]);

                        // Mark the data row as already retrieved.
                        data[rows[i].num] = true;
                        retrieved++;
                    }

                    assert.equal(retrieved, data.length);
                    assert.equal(retrieved, inserted);
                })
                .finalize(done);
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('test Database#get()', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(
                'test/support/prepare.db',
                sqlite3.OPEN_READONLY,
                done,
            );
        });

        let retrieved = 0;

        it('should get a row', function (_t, done) {
            db.get(
                'SELECT txt, num, flt, blb FROM foo WHERE num = ? AND txt = ?',
                10,
                'String 10',
                function (err, row) {
                    if (err) throw err;
                    assert.equal(row.txt, 'String 10');
                    assert.equal(row.num, 10);
                    assert.equal(row.flt, 10 * Math.PI);
                    assert.equal(row.blb, null);
                    retrieved++;
                    done();
                },
            );
        });

        it('should have retrieved all rows', function () {
            assert.equal(1, retrieved, "Didn't retrieve all rows");
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    describe('Database#run() and Database#all()', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        let inserted = 0;
        let retrieved = 0;

        // We insert and retrieve that many rows.
        const count = 1000;

        it('should create the table', function (_t, done) {
            db.run(
                'CREATE TABLE foo (txt text, num int, flt float, blb blob)',
                done,
            );
        });

        it(`should insert ${count} rows`, function (_t, done) {
            for (let i = 0; i < count; i++) {
                db.run(
                    'INSERT INTO foo VALUES(?, ?, ?, ?)',
                    `String ${i}`,
                    i,
                    i * Math.PI,
                    // The 4th parameter is bound explicitly: v9 rejects
                    // a parameter-count mismatch instead of silently
                    // binding the missing ones as NULL.
                    null,
                    function (err) {
                        if (err) throw err;
                        inserted++;
                        if (inserted === count) done();
                    },
                );
            }
        });

        it('should retrieve all rows', function (_t, done) {
            db.all(
                'SELECT txt, num, flt, blb FROM foo ORDER BY num',
                function (err, rows) {
                    if (err) throw err;
                    for (let i = 0; i < rows.length; i++) {
                        assert.equal(rows[i].txt, `String ${i}`);
                        assert.equal(rows[i].num, i);
                        assert.equal(rows[i].flt, i * Math.PI);
                        assert.equal(rows[i].blb, null);
                        retrieved++;
                    }

                    assert.equal(retrieved, count);
                    assert.equal(retrieved, inserted);

                    done();
                },
            );
        });

        after(function (_t, done) {
            db.close(done);
        });
    });

    // 9.0.2: the no-callback form resolves its await only once the worker
    // has completed the prepare (and any bind). Before, `await
    // db.prepare(sql)` settled one microtask later — long before the
    // prepare landed — so `columns`, `parameterCount`, `parameterNames`
    // and `readonly` read as `undefined` and only recovered after an
    // arbitrary turn of the event loop.
    describe('prepare() completion gate', function () {
        let db;
        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        it('populates the introspection accessors right after the await', async function () {
            await db.exec('CREATE TABLE t (v TEXT, n INT)');
            const stmt = await db.prepare('SELECT v, n FROM t WHERE n = ?');
            assert.strictEqual(stmt.parameterCount, 1);
            assert.deepStrictEqual(
                stmt.columns.map((c) => c.name),
                ['v', 'n'],
            );
            assert.strictEqual(stmt.parameterNames, undefined);
            assert.strictEqual(stmt.readonly, true);
            await stmt.finalize();
        });

        it('gates the bind form on prepare and bind completing', async function () {
            const stmt = await db.prepare('SELECT v, n FROM t WHERE n = ?', 1);
            assert.strictEqual(stmt.parameterCount, 1);
            const rows = await stmt.all();
            assert.deepStrictEqual(rows, []);
            await stmt.finalize();
        });

        it('keeps the synchronous chaining surface before the await', async function () {
            const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
            // Same object identity across chained callback methods, and
            // native methods run against the statement itself.
            assert.ok(stmt instanceof sqlite3.Statement);
            const out = stmt.run('a', 1, function (err) {
                if (err) throw err;
            });
            assert.strictEqual(out, stmt);
            await stmt.finalize();
            const after = await db.get('SELECT count(*) AS c FROM t');
            assert.strictEqual(after.c, 1);
        });

        it('yields the statement itself after the await', async function () {
            const awaited = await db.prepare('SELECT 40 + 2 AS answer');
            assert.ok(awaited instanceof sqlite3.Statement);
            assert.strictEqual(awaited.sql, 'SELECT 40 + 2 AS answer');
            assert.strictEqual(awaited.parameterCount, 0);
            assert.strictEqual((await awaited.get()).answer, 42);
            await awaited.finalize();
        });

        it('rejects the await on invalid SQL', async function () {
            await assert.rejects(
                () => db.prepare('SELECT * FROM no_such_table'),
                (err) => {
                    assert.strictEqual(err.code, 'SQLITE_ERROR');
                    return true;
                },
            );
            await db.wait();
        });

        it('reports a failure once: the await rejects, the event fires for listeners', async function () {
            const events = [];
            const stmt = db.prepare('SELECT * FROM no_such_table_either');
            stmt.on('error', (err) => events.push(err));
            await assert.rejects(() => stmt, /no such table/);
            // One 'error' event for the listener, one rejection for the
            // await — the same failure, not two.
            assert.strictEqual(events.length, 1);
            await db.wait();
        });

        it('still returns the statement synchronously in the callback form', async function () {
            const stmt = db.prepare('SELECT 1 AS one', function (err) {
                if (err) throw err;
            });
            assert.ok(stmt instanceof sqlite3.Statement);
            // Accessors are undefined until the callback fires: the
            // callback form keeps its historical asynchronous prepare.
            assert.strictEqual(stmt.parameterCount, undefined);
            await new Promise((resolve) => stmt.finalize(resolve));
        });

        after(async function () {
            await db.close();
        });
    });
});
