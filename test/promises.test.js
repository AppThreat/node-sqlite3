import assert from 'node:assert';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

async function openDb() {
    const db = await sqlite3.open(':memory:');
    await db.exec('CREATE TABLE t (a INT, b TEXT)');
    return db;
}

describe('promise API', function () {
    describe('open()', function () {
        it('resolves an open database', async function () {
            const db = await sqlite3.open(':memory:');
            assert.strictEqual(db.open, true);
            assert.ok(db instanceof sqlite3.Database);
            await db.close();
        });

        it('honours open flags', async function () {
            const db = await sqlite3.open(
                'test/tmp/promises-flags.db',
                sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            );
            assert.strictEqual(db.open, true);
            await db.close();
        });

        it('rejects on open failure', async function () {
            await assert.rejects(
                sqlite3.open('test/tmp/no-such-dir-03x/foo.db'),
                function (err) {
                    assert.strictEqual(err.primaryCode, 'SQLITE_CANTOPEN');
                    return true;
                },
            );
        });
    });

    describe('dual-mode resolution values', function () {
        it('run resolves { lastID, changes, lastIDBigInt }', async function () {
            const db = await openDb();
            const r = await db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
            assert.strictEqual(r.lastID, 1);
            assert.strictEqual(r.changes, 1);
            assert.strictEqual(r.lastIDBigInt, 1n);
            assert.deepStrictEqual(Object.keys(r).sort(), [
                'changes',
                'lastID',
                'lastIDBigInt',
            ]);
            await db.close();
        });

        it('get resolves the row or undefined', async function () {
            const db = await openDb();
            await db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
            const row = await db.get('SELECT * FROM t WHERE a = ?', 1);
            assert.deepStrictEqual(row, { a: 1, b: 'one' });
            const none = await db.get('SELECT * FROM t WHERE a = ?', 99);
            assert.strictEqual(none, undefined);
            await db.close();
        });

        it('all resolves an array of rows', async function () {
            const db = await openDb();
            await db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
            await db.run('INSERT INTO t VALUES (?, ?)', 2, 'two');
            const rows = await db.all('SELECT a FROM t ORDER BY a');
            assert.deepStrictEqual(rows, [{ a: 1 }, { a: 2 }]);
            await db.close();
        });

        it('map resolves the mapped object', async function () {
            const db = await openDb();
            await db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
            await db.run('INSERT INTO t VALUES (?, ?)', 2, 'two');
            const mapped = await db.map('SELECT a, b FROM t');
            assert.deepStrictEqual(mapped, { 1: 'one', 2: 'two' });
            await db.close();
        });

        it('exec, close, wait resolve undefined', async function () {
            const db = await openDb();
            assert.strictEqual(await db.exec('CREATE TABLE u (i)'), undefined);
            assert.strictEqual(await db.wait(), undefined);
            assert.strictEqual(await db.close(), undefined);
            assert.strictEqual(db.open, false);
        });

        it('statement methods resolve like their database forms', async function () {
            const db = await openDb();
            const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
            const r = await stmt.run(3, 'three');
            assert.strictEqual(r.changes, 1);
            // get on an INSERT returns no row: use a fresh select instead.
            const sel = db.prepare('SELECT b FROM t WHERE a = ?');
            assert.deepStrictEqual(await sel.get(3), { b: 'three' });
            assert.strictEqual((await sel.all()).length, 1);
            const sel2 = db.prepare('SELECT a, b FROM t');
            assert.deepStrictEqual(await sel2.map(), { 3: 'three' });
            assert.strictEqual(await sel.reset(), undefined);
            assert.strictEqual(await stmt.finalize(), undefined);
            assert.strictEqual(await sel.finalize(), undefined);
            assert.strictEqual(await sel2.finalize(), undefined);
            await db.close();
        });

        it('backup step resolves completion, finish resolves undefined', async function () {
            const db = await openDb();
            await db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
            const backup = db.backup('test/tmp/promises-backup.db');
            let completed = false;
            while (!completed) {
                completed = await backup.step(16);
            }
            assert.strictEqual(completed, true);
            assert.strictEqual(await backup.finish(), undefined);
            await db.close();
        });
    });

    describe('run result value semantics', function () {
        it('captures lastID at settle time, not lazily', async function () {
            const db = await openDb();
            const r1 = await db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
            await db.run('INSERT INTO t VALUES (?, ?)', 2, 'two');
            // A lazy read of the underlying (reused) statement would now
            // report the second insert's rowid; the snapshot must not.
            assert.strictEqual(r1.lastID, 1);
            await db.close();
        });

        it('keeps the unsafe-rowid RangeError lazy in number mode', async function () {
            const db = await openDb();
            const r = await db.run(
                "INSERT INTO t (rowid, a, b) VALUES (9007199254740993, 1, 'big')",
            );
            // Resolving is fine; only reading lastID throws.
            assert.strictEqual(r.lastIDBigInt, 9007199254740993n);
            assert.throws(function () {
                r.lastID;
            }, RangeError);
            await db.close();
        });

        it('lastID is a BigInt in bigint and mixed modes', async function () {
            const db = await openDb();
            db.configure('integerMode', 'mixed');
            const r = await db.run(
                "INSERT INTO t (rowid, a, b) VALUES (9007199254740993, 1, 'big')",
            );
            assert.strictEqual(r.lastID, 9007199254740993n);
            db.configure('integerMode', 'bigint');
            const r2 = await db.run(
                "INSERT INTO t (rowid, a, b) VALUES (2, 2, 'small')",
            );
            assert.strictEqual(r2.lastID, 2n);
            await db.close();
        });
    });

    describe('callback mode is unchanged', function () {
        it('returns this and stays chainable', async function () {
            const db = await openDb();
            let ran = 0;
            const out = db.run(
                'INSERT INTO t VALUES (?, ?)',
                1,
                'one',
                function (err) {
                    if (err) throw err;
                    ran++;
                },
            );
            assert.strictEqual(out, db);
            assert.strictEqual(
                db.get('SELECT a FROM t', function (err, row) {
                    if (err) throw err;
                    assert.deepStrictEqual(row, { a: 1 });
                }),
                db,
            );
            await db.wait();
            assert.strictEqual(ran, 1);
            await db.close();
        });

        it('statement methods with callbacks return the statement (finalize the database)', async function () {
            const db = await openDb();
            const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
            const out = stmt.run(1, 'one', function (err) {
                if (err) throw err;
            });
            assert.strictEqual(out, stmt);
            // finalize has always returned the database, for chaining.
            const fin = stmt.finalize(function (err) {
                if (err) throw err;
            });
            assert.strictEqual(fin, db);
            await db.close();
        });

        it('prepare keeps its synchronous statement return', async function () {
            const db = await openDb();
            const stmt = db.prepare('SELECT 1 AS one');
            assert.ok(stmt instanceof sqlite3.Statement);
            const row = await new Promise(function (resolve, reject) {
                stmt.get(function (err, r) {
                    if (err) reject(err);
                    else resolve(r);
                });
            });
            assert.deepStrictEqual(row, { one: 1 });
            await stmt.finalize();
            await db.close();
        });
    });

    describe('rejections', function () {
        it('carry code, errno and primaryCode', async function () {
            const db = await openDb();
            await db.exec('CREATE TABLE u (x INT UNIQUE)');
            await db.run('INSERT INTO u VALUES (1)');
            await assert.rejects(
                db.run('INSERT INTO u VALUES (1)'),
                function (err) {
                    assert.strictEqual(err.code, 'SQLITE_CONSTRAINT_UNIQUE');
                    assert.strictEqual(err.primaryCode, 'SQLITE_CONSTRAINT');
                    assert.strictEqual(err.errno, sqlite3.CONSTRAINT_UNIQUE);
                    return true;
                },
            );
            await db.close();
        });

        it('reject instead of throwing synchronously on bad binds', async function () {
            const db = await openDb();
            const p = db.run('INSERT INTO t VALUES (?)', [{ a: 1 }]);
            assert.ok(p instanceof Promise);
            await assert.rejects(p, TypeError);
            // The connection survived: the orphaned statement was finalized.
            const rows = await db.all('SELECT * FROM t');
            assert.deepStrictEqual(rows, []);
            await db.close();
        });

        it('reject on statement methods too', async function () {
            const db = await openDb();
            const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
            await assert.rejects(stmt.run(1, { nope: 1 }), TypeError);
            await stmt.finalize();
            await db.close();
        });
    });

    describe('each() is callback-only', function () {
        it('throws a TypeError without callbacks, pointing at iterate()', async function () {
            const db = await openDb();
            assert.throws(
                function () {
                    db.each('SELECT 1');
                },
                function (err) {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, /iterate\(\)/);
                    return true;
                },
            );
            const stmt = db.prepare('SELECT 1');
            assert.throws(function () {
                stmt.each();
            }, TypeError);
            await stmt.finalize();
            await db.close();
        });

        it('still streams rows with callbacks', async function () {
            const db = await openDb();
            await db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
            const rows = [];
            await new Promise(function (resolve, reject) {
                db.each(
                    'SELECT a FROM t',
                    function (err, row) {
                        if (err) return reject(err);
                        rows.push(row);
                    },
                    function (err) {
                        if (err) reject(err);
                        else resolve();
                    },
                );
            });
            assert.deepStrictEqual(rows, [{ a: 1 }]);
            await db.close();
        });
    });

    describe('verbose() augments promise rejections', function () {
        it('stack contains the calling frame', async function () {
            const db = await openDb();
            sqlite3.verbose();
            await assert.rejects(
                db.all('SELECT * FROM promises_no_such_table'),
                function (err) {
                    assert.ok(
                        err.stack.includes('promises.test.js'),
                        `stack should mention the test file: ${err.stack}`,
                    );
                    assert.match(err.stack, /Database#all/);
                    return true;
                },
            );
            await db.close();
        });
    });

    // Statement#map is the one JS-side method that reshapes its callback's
    // arguments, so it is the one a refactor can silently change. On error
    // it must hand back the error alone — an empty object there reads as a
    // successful empty result.
    describe('Statement#map error contract', function () {
        it('passes the error alone, with no result object', async function () {
            const db = await openDb();
            const stmt = db.prepare('SELECT a FROM t');
            await db.exec('DROP TABLE t');
            // Called through a reference: `stmt.map(...)` written out
            // trips Biome's Array#map rule.
            const mapRows = stmt.map.bind(stmt);
            const args = await new Promise(function (resolve) {
                mapRows(function (...called) {
                    resolve(called);
                });
            });
            assert.strictEqual(args.length, 2);
            assert.strictEqual(args[0].code, 'SQLITE_ERROR');
            assert.strictEqual(args[1], undefined);
            await stmt.finalize();
            await db.close();
        });
    });
});
