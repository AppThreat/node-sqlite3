import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';
import { deleteFile } from './support/helper.js';

// The statement cache is opt-in: db.cacheStatements() makes run/get/all/
// each/map reuse prepared statements (LRU, keyed on the SQL string).
// These tests pin the semantics the cache must not change:
// - bind values are per-call (no stale bindings leak between calls)
// - serialize() keeps strict FIFO ordering (cache defers to uncached path)
// - close() flushes cached statements: no SQLITE_BUSY, no lost callbacks
// - prepare errors surface like the uncached path and don't poison the cache
describe('statement cache', function () {
    let db;

    beforeEach(function (_t, done) {
        db = new sqlite3.Database(':memory:', function (err) {
            assert.ifError(err);
            db.exec(
                'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c BLOB)',
                done,
            );
        });
    });

    afterEach(function (_t, done) {
        db.close(function () {
            done();
        });
    });

    it('is off by default and does not change behavior', function (_t, done) {
        assert.strictEqual(db._stmtCache, undefined);
        let n = 0;
        for (let i = 0; i < 5; i++) {
            db.run('INSERT INTO t (a) VALUES (?)', i, function (err) {
                assert.ifError(err);
                // Parallel completion order is unspecified; lastID must
                // still be a valid rowid of this batch.
                assert.ok(this.lastID >= 1 && this.lastID <= 5);
                if (++n === 5) done();
            });
        }
    });

    it('reuses statements with per-call bind values', function (_t, done) {
        db.cacheStatements();
        const vals = [];
        for (let i = 0; i < 25; i++) vals.push(`v${i}-${'x'.repeat(40)}`);
        let n = 0;
        vals.forEach(function (v, i) {
            db.run('INSERT INTO t (a, b) VALUES (?, ?)', i, v, function (err) {
                assert.ifError(err);
                if (++n === vals.length) {
                    db.all(
                        'SELECT a, b FROM t ORDER BY id',
                        function (err, rows) {
                            assert.ifError(err);
                            assert.strictEqual(rows.length, vals.length);
                            rows.forEach(function (row, i) {
                                assert.strictEqual(row.a, i);
                                assert.strictEqual(row.b, vals[i]);
                            });
                            done();
                        },
                    );
                }
            });
        });
    });

    it('re-runs statements bound with no parameters', function (_t, done) {
        db.cacheStatements();
        for (let i = 0; i < 5; i++) {
            db.run("INSERT INTO t (b) VALUES ('fixed')");
        }
        // Parallel mode never guaranteed cross-statement visibility;
        // drain first (same pattern as parallel_insert.test.js).
        db.wait(function () {
            db.get('SELECT COUNT(*) AS n FROM t', function (err, row) {
                assert.ifError(err);
                assert.strictEqual(row.n, 5);
                done();
            });
        });
    });

    it('supports get/all/each/map through the cache', function (_t, done) {
        db.cacheStatements();
        const buf = Buffer.from('blob-bytes');
        const ins = db.prepare('INSERT INTO t (a, b, c) VALUES (?, ?, ?)');
        let n = 0;
        for (let i = 0; i < 4; i++) {
            ins.run(i, `row${i}`, buf, function () {
                if (++n === 4) ins.finalize(check);
            });
        }
        function check() {
            db.get('SELECT a, b, c FROM t WHERE a = ?', 2, function (err, row) {
                assert.ifError(err);
                assert.strictEqual(row.b, 'row2');
                assert.ok(buf.equals(row.c));
                db.all('SELECT a FROM t ORDER BY a', function (err, rows) {
                    assert.ifError(err);
                    assert.deepStrictEqual(
                        rows.map((r) => r.a),
                        [0, 1, 2, 3],
                    );
                    let seen = 0;
                    db.each(
                        'SELECT a FROM t ORDER BY a',
                        function (err, row) {
                            assert.ifError(err);
                            assert.strictEqual(row.a, seen++);
                        },
                        function (err, count) {
                            assert.ifError(err);
                            assert.strictEqual(count, 4);
                            db.map(
                                'SELECT a, b FROM t ORDER BY a',
                                function (err, result) {
                                    assert.ifError(err);
                                    assert.deepStrictEqual(
                                        Object.keys(result),
                                        ['0', '1', '2', '3'],
                                    );
                                    assert.strictEqual(result['2'], 'row2');
                                    done();
                                },
                            );
                        },
                    );
                });
            });
        }
    });

    it('keeps named-parameter and object binds per call', function (_t, done) {
        db.cacheStatements();
        db.run(
            'INSERT INTO t (a, b) VALUES ($a, $b)',
            { $a: 1, $b: 'one' },
            function (err) {
                assert.ifError(err);
                db.run(
                    'INSERT INTO t (a, b) VALUES ($a, $b)',
                    { $a: 2, $b: 'two' },
                    function (err) {
                        assert.ifError(err);
                        db.all(
                            'SELECT a, b FROM t ORDER BY a',
                            function (err, rows) {
                                assert.ifError(err);
                                assert.strictEqual(rows.length, 2);
                                assert.strictEqual(rows[0].b, 'one');
                                assert.strictEqual(rows[1].b, 'two');
                                done();
                            },
                        );
                    },
                );
            },
        );
    });

    it('keeps FIFO ordering on the same cached statement in one tick', function (_t, done) {
        db.cacheStatements();
        const N = 100;
        for (let i = 0; i < N; i++) {
            db.run('INSERT INTO t (a) VALUES (?)', i);
        }
        db.wait(function () {
            db.all('SELECT a FROM t ORDER BY id', function (err, rows) {
                assert.ifError(err);
                assert.strictEqual(rows.length, N);
                rows.forEach(function (row, i) {
                    assert.strictEqual(row.a, i, `FIFO broken at ${i}`);
                });
                done();
            });
        });
    });

    it('defers to the uncached path under serialize() and keeps FIFO order', function (_t, done) {
        db.cacheStatements();
        const order = [];
        db.serialize(function () {
            for (let i = 0; i < 30; i++) {
                db.run('INSERT INTO t (a) VALUES (?)', i, function () {
                    order.push(i);
                });
            }
        });
        db.wait(function () {
            // serialize() must complete callbacks in issue order
            for (let i = 0; i < 30; i++) {
                assert.strictEqual(
                    order[i],
                    i,
                    `serialize order broken at ${i}`,
                );
            }
            db.parallelize(function () {
                db.all('SELECT a FROM t ORDER BY id', function (err, rows) {
                    assert.ifError(err);
                    assert.strictEqual(rows.length, 30);
                    rows.forEach(function (row, i) {
                        assert.strictEqual(row.a, i);
                    });
                    done();
                });
            });
        });
    });

    it('survives LRU eviction pressure with a tiny cache', function (_t, done) {
        db.cacheStatements(1);
        const sqls = [];
        for (let i = 0; i < 10; i++) sqls.push(`SELECT ${i} AS v`);
        let n = 0;
        sqls.forEach(function (sql, i) {
            db.get(sql, function (err, row) {
                assert.ifError(err);
                assert.strictEqual(row.v, i);
                if (++n === sqls.length) done();
            });
        });
    });

    it('reports prepare errors and recovers', function (_t, done) {
        db.cacheStatements();
        db.run('NOT VALID SQL AT ALL', function (err) {
            assert.ok(err);
            assert.strictEqual(err.code, 'SQLITE_ERROR');
            db.run('INSERT INTO t (a) VALUES (?)', 1, function (err) {
                assert.ifError(err);
                db.get('SELECT COUNT(*) AS n FROM t', function (err, row) {
                    assert.ifError(err);
                    assert.strictEqual(row.n, 1);
                    done();
                });
            });
        });
    });

    it('reports runtime errors per call without poisoning the cache', function (_t, done) {
        db.cacheStatements();
        db.run(
            'CREATE TABLE IF NOT EXISTS u (x INTEGER UNIQUE)',
            function (err) {
                assert.ifError(err);
                db.run('INSERT INTO u (x) VALUES (?)', 1, function (err) {
                    assert.ifError(err);
                    db.run('INSERT INTO u (x) VALUES (?)', 1, function (err) {
                        assert.ok(err);
                        // v9 reports the extended code; the primary code
                        // moved to err.primaryCode.
                        assert.strictEqual(
                            err.code,
                            'SQLITE_CONSTRAINT_UNIQUE',
                        );
                        assert.strictEqual(
                            err.primaryCode,
                            'SQLITE_CONSTRAINT',
                        );
                        db.run(
                            'INSERT INTO u (x) VALUES (?)',
                            2,
                            function (err) {
                                assert.ifError(err);
                                done();
                            },
                        );
                    });
                });
            },
        );
    });

    it('coexists with user-held prepared statements', function (_t, done) {
        db.cacheStatements();
        const mine = db.prepare('INSERT INTO t (a) VALUES (?)');
        db.run('INSERT INTO t (a) VALUES (?)', 100, function (err) {
            assert.ifError(err);
            mine.run(200, function (err) {
                assert.ifError(err);
                db.get('SELECT COUNT(*) AS n FROM t', function (err, row) {
                    assert.ifError(err);
                    assert.strictEqual(row.n, 2);
                    mine.finalize(done);
                });
            });
        });
    });

    describe('close interaction', function () {
        const FILE = 'test/tmp/test_stmt_cache_close.db';

        beforeEach(function (_t, done) {
            deleteFile(FILE);
            db.close(function () {
                db = new sqlite3.Database(FILE, function (err) {
                    assert.ifError(err);
                    db.exec(
                        'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)',
                        done,
                    );
                });
            });
        });

        it('flushes cached statements on close (no SQLITE_BUSY)', function (_t, done) {
            db.cacheStatements();
            for (let i = 0; i < 20; i++) {
                db.run('INSERT INTO t (a) VALUES (?)', i);
            }
            db.close(function (err) {
                assert.ifError(err);
                db = new sqlite3.Database(
                    FILE,
                    sqlite3.OPEN_READONLY,
                    function (err2) {
                        assert.ifError(err2);
                        db.get(
                            'SELECT COUNT(*) AS n FROM t',
                            function (e, row) {
                                assert.ifError(e);
                                assert.strictEqual(row.n, 20);
                                done();
                            },
                        );
                    },
                );
            });
        });

        it('delivers queued cached callbacks before close completes', function (_t, done) {
            db.cacheStatements();
            let callbacks = 0;
            for (let i = 0; i < 50; i++) {
                db.run('INSERT INTO t (a) VALUES (?)', i, function () {
                    callbacks++;
                });
            }
            // Same-tick close: the review cycle's killer case. Every
            // callback must fire, close must not error.
            db.close(function (err) {
                assert.ifError(err);
                assert.strictEqual(callbacks, 50, 'cached callbacks were lost');
                db = new sqlite3.Database(
                    FILE,
                    sqlite3.OPEN_READONLY,
                    function (err2) {
                        assert.ifError(err2);
                        db.get(
                            'SELECT COUNT(*) AS n FROM t',
                            function (e, row) {
                                assert.ifError(e);
                                assert.strictEqual(row.n, 50);
                                done();
                            },
                        );
                    },
                );
            });
        });

        it('closes cleanly with cache enabled but empty', function (_t, done) {
            db.cacheStatements();
            db.close(function (err) {
                assert.ifError(err);
                // keep afterEach happy: already closed
                db = new sqlite3.Database(':memory:', function () {
                    done();
                });
            });
        });
    });
});

// The cached path skips the prepare, and statement operations never travel
// through the database queue. Nothing may therefore overtake an exclusive
// operation (exec/close/wait/loadExtension) just because its SQL was cached.
describe('statement cache ordering vs exclusive operations', function () {
    it('does not let a cached statement overtake exec()', function (_t, done) {
        const order = [];
        const db = new sqlite3.Database(':memory:');
        db.cacheStatements();
        db.run('CREATE TABLE t (i)', function () {
            // Prime the cache for this exact SQL.
            db.run('INSERT INTO t VALUES (1)', function () {
                db.exec(
                    'INSERT INTO t VALUES (2); INSERT INTO t VALUES (3);',
                    function (err) {
                        assert.ifError(err);
                        order.push('exec');
                    },
                );
                // Cache hit, issued after exec: must still run after it.
                db.run('INSERT INTO t VALUES (1)', function (err) {
                    assert.ifError(err);
                    order.push('cached run');
                    assert.deepStrictEqual(order, ['exec', 'cached run']);
                    db.close(done);
                });
            });
        });
    });

    it('rejects a cached statement issued after close()', function (_t, done) {
        const db = new sqlite3.Database(':memory:');
        db.cacheStatements();
        db.run('CREATE TABLE t (i)', function () {
            db.run('INSERT INTO t VALUES (1)', function () {
                setImmediate(function () {
                    let closed = false;
                    db.close(function (err) {
                        assert.ifError(err);
                        closed = true;
                    });
                    // close() must be requested synchronously, not deferred:
                    // this cache hit has to land behind it and fail.
                    db.run('INSERT INTO t VALUES (1)', function (err) {
                        assert.ok(err, 'run after close() must not succeed');
                        assert.ok(closed, 'close should have completed first');
                        done();
                    });
                });
            });
        });
    });

    it('rejects a cached statement issued after close() from a callback', function (_t, done) {
        const db = new sqlite3.Database(':memory:');
        db.cacheStatements();
        db.run('CREATE TABLE t (i)', function () {
            db.run('INSERT INTO t VALUES (1)', function () {
                // Still inside a statement callback: the statement is locked
                // and db->pending is non-zero, so the cache flush queues.
                db.close(function (err) {
                    assert.ifError(err);
                });
                db.run('INSERT INTO t VALUES (1)', function (err) {
                    assert.ok(err, 'run after close() must not succeed');
                    done();
                });
            });
        });
    });
});
