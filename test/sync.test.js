import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Opt-in synchronous fast path. prepareSync/getSync/runSync/allSync skip
// the threadpool when — and only when — the database is fully idle. These
// tests pin correctness, type fidelity, and the busy/error semantics.
describe('sync api', function () {
    let db;

    beforeEach(function (_t, done) {
        db = new sqlite3.Database(':memory:', function (err) {
            assert.ifError(err);
            db.exec(
                'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c BLOB, d REAL)',
                done,
            );
        });
    });

    afterEach(function (_t, done) {
        db.close(function () {
            done();
        });
    });

    describe('statement-level', function () {
        it('prepareSync returns a usable statement', function () {
            const stmt = db.prepareSync('SELECT ? AS v');
            assert.strictEqual(stmt.getSync(42).v, 42);
            stmt.finalize();
        });

        it('getSync returns rows with full type fidelity', function () {
            const ins = db.prepareSync(
                'INSERT INTO t (a, b, c, d) VALUES (?, ?, ?, ?)',
            );
            const buf = Buffer.from([0x00, 0xff, 0x10, 0x20]);
            ins.runSync(7, 'héllo ✓', buf, 2.5);
            ins.finalize();

            const sel = db.prepareSync('SELECT a, b, c, d FROM t');
            const row = sel.getSync();
            assert.strictEqual(row.a, 7);
            assert.strictEqual(row.b, 'héllo ✓');
            assert.ok(Buffer.isBuffer(row.c));
            assert.ok(buf.equals(row.c));
            assert.strictEqual(row.d, 2.5);
            sel.finalize();
        });

        it('getSync binds array, positional and named params', function () {
            const stmt = db.prepareSync('SELECT ?1 AS a, ?2 AS b');
            assert.deepStrictEqual(
                { a: 1, b: 2 },
                (() => {
                    const r = stmt.getSync([1, 2]);
                    return { a: r.a, b: r.b };
                })(),
            );
            assert.strictEqual(stmt.getSync(5, 6).a, 5);
            stmt.finalize();

            const named = db.prepareSync('SELECT $x AS x, :y AS y');
            const r = named.getSync({ $x: 1, ':y': 2 });
            assert.strictEqual(r.x, 1);
            assert.strictEqual(r.y, 2);
            named.finalize();
        });

        it('getSync returns undefined when exhausted and rows while stepping', function () {
            const ins = db.prepareSync('INSERT INTO t (a) VALUES (?)');
            ins.runSync(1);
            ins.runSync(2);
            ins.runSync(3);
            ins.finalize();

            const sel = db.prepareSync('SELECT a FROM t ORDER BY a');
            // Unbound getSync advances the cursor like the async get().
            assert.strictEqual(sel.getSync().a, 1);
            assert.strictEqual(sel.getSync().a, 2);
            assert.strictEqual(sel.getSync().a, 3);
            assert.strictEqual(sel.getSync(), undefined);
            sel.finalize();
        });

        it('getSync re-executes when re-bound after exhaustion', function () {
            const ins = db.prepareSync('INSERT INTO t (a) VALUES (?)');
            ins.runSync(1);
            ins.runSync(2);
            ins.finalize();

            const sel = db.prepareSync('SELECT a FROM t WHERE a = ?');
            assert.strictEqual(sel.getSync(1).a, 1);
            assert.strictEqual(sel.getSync(2).a, 2);
            assert.strictEqual(sel.getSync(1).a, 1);
            sel.finalize();
        });

        it('runSync sets lastID/changes on the statement and returns it', function () {
            const stmt = db.prepareSync('INSERT INTO t (a) VALUES (?)');
            for (let i = 1; i <= 3; i++) {
                const ret = stmt.runSync(i);
                assert.strictEqual(ret, stmt);
                assert.strictEqual(stmt.lastID, i);
                assert.strictEqual(stmt.changes, 1);
            }
            const upd = db.prepareSync('UPDATE t SET a = a + 10');
            upd.runSync();
            assert.strictEqual(upd.changes, 3);
            upd.finalize();
            stmt.finalize();
        });

        it('allSync returns arrays, empty and non-empty', function () {
            const sel = db.prepareSync('SELECT a FROM t ORDER BY a');
            assert.deepStrictEqual(sel.allSync(), []);
            sel.finalize();

            const ins = db.prepareSync('INSERT INTO t (a) VALUES (?)');
            for (let i = 1; i <= 4; i++) ins.runSync(i);
            ins.finalize();

            const sel2 = db.prepareSync('SELECT a FROM t ORDER BY a');
            assert.deepStrictEqual(
                sel2.allSync().map((r) => r.a),
                [1, 2, 3, 4],
            );
            // Reusable afterwards.
            assert.deepStrictEqual(
                sel2.allSync().map((r) => r.a),
                [1, 2, 3, 4],
            );
            sel2.finalize();
        });

        it('allSync handles large results', function () {
            const ins = db.prepareSync('INSERT INTO t (b) VALUES (?)');
            for (let i = 0; i < 2000; i++) ins.runSync(`row-${i}`);
            ins.finalize();
            const sel = db.prepareSync('SELECT id, b FROM t ORDER BY id');
            const rows = sel.allSync();
            assert.strictEqual(rows.length, 2000);
            assert.strictEqual(rows[1999].b, 'row-1999');
            sel.finalize();
        });

        it('throws sqlite errors with errno and code', function () {
            // prepare_v2 reports missing tables at prepare time.
            assert.throws(
                function () {
                    db.prepareSync('SELECT * FROM nonexistent_table');
                },
                function (err) {
                    assert.strictEqual(err.code, 'SQLITE_ERROR');
                    assert.strictEqual(err.errno, 1);
                    return true;
                },
            );

            const ins = db.prepareSync('INSERT INTO t (id) VALUES (?)');
            ins.runSync(1);
            assert.throws(
                function () {
                    ins.runSync(1);
                },
                function (err) {
                    // v9 reports the extended code; the primary code
                    // moved to err.primaryCode. INTEGER PRIMARY KEY
                    // conflicts report CONSTRAINT_PRIMARYKEY.
                    assert.strictEqual(
                        err.code,
                        'SQLITE_CONSTRAINT_PRIMARYKEY',
                    );
                    assert.strictEqual(err.primaryCode, 'SQLITE_CONSTRAINT');
                    return true;
                },
            );
            ins.finalize();
        });

        it('prepareSync throws on invalid SQL', function () {
            assert.throws(function () {
                db.prepareSync('NO SUCH SYNTAX');
            }, /SQLITE_ERROR|syntax error/);
        });

        it('rejects callback arguments', function () {
            const stmt = db.prepareSync('SELECT ? AS v');
            assert.throws(function () {
                stmt.getSync(function () {
                    /* any callback must be rejected */
                });
            }, /callback/i);
            stmt.finalize();
        });

        it('works repeatedly on the same statement without lockup', function () {
            const stmt = db.prepareSync('SELECT ? AS v');
            for (let i = 0; i < 1000; i++) {
                assert.strictEqual(stmt.getSync(i).v, i);
            }
            stmt.finalize();
        });
    });

    describe('busy gating', function () {
        it('throws while async work is in flight', function (_t, done) {
            db.run('INSERT INTO t (a) VALUES (?)', 1, function (err) {
                assert.ifError(err);
                done();
            });
            assert.throws(function () {
                db.getSync('SELECT COUNT(*) AS n FROM t');
            }, /busy/);
        });

        it('throws inside an async completion callback (bookkeeping pending)', function (_t, done) {
            // STATEMENT_END runs after user callbacks, so the completing
            // op itself still counts as in-flight. Deferred calls see the
            // drained state. This pins the documented semantics.
            db.run('INSERT INTO t (a) VALUES (?)', 1, function (err) {
                assert.ifError(err);
                assert.throws(function () {
                    db.getSync('SELECT COUNT(*) AS n FROM t');
                }, /busy/);
                setImmediate(function () {
                    assert.strictEqual(
                        db.getSync('SELECT COUNT(*) AS n FROM t').n,
                        1,
                    );
                    done();
                });
            });
        });

        it('works again once the database drains', function (_t, done) {
            db.run('INSERT INTO t (a) VALUES (?)', 1, function (err) {
                assert.ifError(err);
                setImmediate(function () {
                    assert.strictEqual(
                        db.getSync('SELECT COUNT(*) AS n FROM t').n,
                        1,
                    );
                    done();
                });
            });
        });

        it('throws under serialize() with queued work', function () {
            db.serialize(function () {
                db.run('INSERT INTO t (a) VALUES (1)', function (err) {
                    assert.ifError(err);
                });
                assert.throws(function () {
                    db.runSync('INSERT INTO t (a) VALUES (2)');
                }, /busy/);
            });
        });

        it('throws on a finalized statement', function () {
            const stmt = db.prepareSync('SELECT 1 AS v');
            stmt.finalize();
            assert.throws(function () {
                stmt.getSync();
            }, /finalized/);
        });
    });

    describe('database-level', function () {
        it('getSync/runSync/allSync without a cache', function () {
            const info = db.runSync(
                'INSERT INTO t (a, b) VALUES (?, ?)',
                1,
                'one',
            );
            assert.strictEqual(info.lastID, 1);
            assert.strictEqual(info.changes, 1);
            assert.strictEqual(
                db.getSync('SELECT b FROM t WHERE a = ?', 1).b,
                'one',
            );
            assert.strictEqual(
                db.getSync('SELECT b FROM t WHERE a = ?', 99),
                undefined,
            );
            assert.strictEqual(db.allSync('SELECT a FROM t').length, 1);
            const info2 = db.runSync('UPDATE t SET b = ?', 'uno');
            assert.strictEqual(info2.changes, 1);
        });

        it('getSync/runSync/allSync with the statement cache reuse statements', function () {
            db.cacheStatements();
            for (let i = 0; i < 50; i++) {
                db.runSync('INSERT INTO t (a) VALUES (?)', i);
            }
            assert.strictEqual(db.getSync('SELECT COUNT(*) AS n FROM t').n, 50);
            assert.deepStrictEqual(
                db.allSync('SELECT COUNT(*) AS n FROM t').map((r) => r.n),
                [50],
            );
            // Two distinct SQL strings: the SELECT is shared between the
            // getSync and allSync calls.
            assert.strictEqual(db._stmtCache.size, 2);
        });

        it('sync and async calls interleave correctly when drained', function (_t, done) {
            db.run('INSERT INTO t (a) VALUES (1)', function (err) {
                assert.ifError(err);
                setImmediate(function () {
                    db.runSync('INSERT INTO t (a) VALUES (2)');
                    db.get('SELECT COUNT(*) AS n FROM t', function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.n, 2);
                        done();
                    });
                });
            });
        });

        it('close() still works with cache populated by sync calls', function (_t, done) {
            const db2 = new sqlite3.Database(':memory:', function (err) {
                assert.ifError(err);
                db2.exec('CREATE TABLE u (x INTEGER)', function () {
                    db2.cacheStatements();
                    for (let i = 0; i < 10; i++)
                        db2.runSync('INSERT INTO u (x) VALUES (?)', i);
                    db2.close(function (err2) {
                        assert.ifError(err2);
                        done();
                    });
                });
            });
        });
    });
});

// TRY_CATCH_CALL returns early when a JS callback throws. The end-of-call
// bookkeeping must still run, or `locked` stays set and db->pending stays
// elevated forever -- which would make the idle gate unsatisfiable and
// permanently disable the sync fast path on that connection.
describe('sync fast path after a throwing callback', function () {
    it('stays usable when a query callback throws', function (_t, done) {
        const db = new sqlite3.Database(':memory:');
        const savedHandlers = process.listeners('uncaughtException');
        process.removeAllListeners('uncaughtException');

        let restored = false;
        const restore = function () {
            if (restored) return;
            restored = true;
            process.removeAllListeners('uncaughtException');
            for (const h of savedHandlers) process.on('uncaughtException', h);
        };

        process.once('uncaughtException', function (err) {
            assert.strictEqual(err.message, 'boom from callback');
            // The connection must not be wedged by the throw above.
            setTimeout(function () {
                restore();
                try {
                    assert.deepStrictEqual(db.getSync('SELECT 1 AS v'), {
                        v: 1,
                    });
                    assert.strictEqual(
                        db.runSync('INSERT INTO t VALUES (2)').changes,
                        1,
                    );
                    assert.deepStrictEqual(
                        db.getSync('SELECT COUNT(*) AS n FROM t'),
                        { n: 2 },
                    );
                } catch (e) {
                    return done(e);
                }
                db.close(done);
            }, 50);
        });

        db.run('CREATE TABLE t (i)', function () {
            db.run('INSERT INTO t VALUES (1)', function () {
                throw new Error('boom from callback');
            });
        });
    });
});

// Without cacheStatements() the sync methods prepare a transient statement
// per call. It must be finalized, or every call leaks a prepared statement
// and close() fails with SQLITE_BUSY.
describe('sync fast path without the statement cache', function () {
    it('does not leak prepared statements', function (_t, done) {
        const db = new sqlite3.Database(':memory:');
        db.run('CREATE TABLE t (i)', function () {
            setImmediate(function () {
                for (let i = 0; i < 20; i++) {
                    assert.deepStrictEqual(db.getSync('SELECT 1 AS v'), {
                        v: 1,
                    });
                    assert.strictEqual(
                        db.runSync('INSERT INTO t VALUES (?)', i).changes,
                        1,
                    );
                    assert.strictEqual(
                        db.allSync('SELECT i FROM t').length,
                        i + 1,
                    );
                }
                // Fails with SQLITE_BUSY if any transient statement leaked.
                db.close(function (err) {
                    assert.ifError(err);
                    done();
                });
            });
        });
    });
});
