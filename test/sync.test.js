import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
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

// The sync methods cache their prepared statements, so those outlive the
// call. close() must drain that cache, or it fails with SQLITE_BUSY.
describe('sync fast path statement lifetime', function () {
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
                // Fails with SQLITE_BUSY if the cache was not drained.
                db.close(function (err) {
                    assert.ifError(err);
                    done();
                });
            });
        });
    });
});

// The sync read paths are the ones under optimisation pressure: they are
// being reshaped to convert rows straight from the sqlite3_stmt instead of
// materialising an intermediate C++ copy of the whole result set. These
// tests pin the observable semantics that refactor must preserve — the
// row shape, the marshalled types, and the exact wording of the errors,
// none of which was covered before. The error text matters twice over:
// the string it names a column with is built per cell on the hot path,
// so any change to how it is produced is a change to this message.
describe('sync read paths: shape, types and error text', function () {
    /** @type {import('../lib/sqlite3.js').Database} */
    let db;

    beforeEach(async function () {
        db = await sqlite3.open(':memory:');
        await db.exec(
            'CREATE TABLE m (i INTEGER, r REAL, t TEXT, b BLOB, n INTEGER)',
        );
        await db.run(
            'INSERT INTO m VALUES (?, ?, ?, ?, ?)',
            42,
            1.5,
            'héllo',
            Buffer.from([1, 2, 3]),
            null,
        );
    });

    afterEach(async function () {
        await db.close();
    });

    it('getSync marshals every storage class and keeps insertion order', function () {
        const row = db.getSync('SELECT i, r, t, b, n FROM m');
        assert.deepStrictEqual(Object.keys(row), ['i', 'r', 't', 'b', 'n']);
        assert.strictEqual(row.i, 42);
        assert.strictEqual(row.r, 1.5);
        assert.strictEqual(row.t, 'héllo');
        assert.ok(Buffer.isBuffer(row.b));
        assert.deepStrictEqual([...row.b], [1, 2, 3]);
        assert.strictEqual(row.n, null);
    });

    it('rows are plain objects on Object.prototype', function () {
        // Not a null-prototype object: `row.hasOwnProperty(...)`,
        // `instanceof Object` and util.inspect output all depend on this,
        // and node:sqlite's choice of a null prototype is NOT ours to copy
        // without a major-version note.
        const row = db.getSync('SELECT i FROM m');
        assert.strictEqual(Object.getPrototypeOf(row), Object.prototype);
    });

    it('allSync returns one object per row, sharing the column names', function () {
        db.runSync('INSERT INTO m (i) VALUES (7)');
        const rows = db.allSync('SELECT i FROM m ORDER BY i');
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(
            rows.map((r) => r.i),
            [7, 42],
        );
        assert.deepStrictEqual(Object.keys(rows[0]), ['i']);
    });

    it('duplicate column names collapse to the last value, as JS objects do', function () {
        const row = db.getSync('SELECT 1 AS dup, 2 AS dup');
        assert.deepStrictEqual(Object.keys(row), ['dup']);
        assert.strictEqual(row.dup, 2);
    });

    it('a zero-row query yields undefined from getSync and [] from allSync', function () {
        assert.strictEqual(
            db.getSync('SELECT i FROM m WHERE i = 999'),
            undefined,
        );
        assert.deepStrictEqual(db.allSync('SELECT i FROM m WHERE i = 999'), []);
    });

    it('an unsafe integer names the column it came from, by result name', async function () {
        await db.exec('CREATE TABLE big (v INTEGER)');
        await db.run('INSERT INTO big VALUES (?)', 9007199254740993n);
        // The message is asserted in full: it is the only consumer of the
        // per-cell column description, so it is what proves that
        // description is still correct however it comes to be built.
        assert.throws(
            () => db.getSync('SELECT v FROM big'),
            (err) =>
                err instanceof RangeError &&
                err.message ===
                    "Integer 9007199254740993 in column 'v' is outside the safe " +
                        'integer range (-(2^53-1) .. 2^53-1); ' +
                        "configure('integerMode', 'bigint' | 'mixed') to read it exactly",
        );
        // An alias renames it; an expression names itself. Both come from
        // sqlite3_column_name, so both must survive the same way.
        assert.throws(
            () => db.getSync('SELECT v AS renamed FROM big'),
            /in column 'renamed' is outside/,
        );
        assert.throws(
            () => db.getSync('SELECT v + 0 FROM big'),
            /in column 'v \+ 0' is outside/,
        );
        // And the column is named correctly when it is not the first one.
        assert.throws(
            () => db.getSync("SELECT 'a' AS first, v AS second FROM big"),
            /in column 'second' is outside/,
        );
    });

    it('allSync reports the offending column from a later row, not the first', async function () {
        // The failure is raised while converting row 2, after row 1 has
        // already been built — a single-pass implementation must not lose
        // the column identity by then.
        await db.exec('CREATE TABLE big (v INTEGER)');
        await db.run('INSERT INTO big VALUES (?)', 1n);
        await db.run('INSERT INTO big VALUES (?)', 9007199254740993n);
        assert.throws(
            () => db.allSync('SELECT v FROM big ORDER BY v'),
            /Integer 9007199254740993 in column 'v' is outside/,
        );
    });

    it('bigint and mixed integer modes read the same rows without throwing', async function () {
        await db.exec('CREATE TABLE big (v INTEGER)');
        await db.run('INSERT INTO big VALUES (?)', 9007199254740993n);
        db.configure('integerMode', 'bigint');
        assert.strictEqual(
            db.getSync('SELECT v FROM big').v,
            9007199254740993n,
        );
        db.configure('integerMode', 'mixed');
        assert.strictEqual(
            db.getSync('SELECT v FROM big').v,
            9007199254740993n,
        );
        // In mixed mode a safe value stays a number.
        assert.strictEqual(db.getSync('SELECT 5 AS v').v, 5);
    });

    it('a wide row keeps every column distinct', function () {
        const cols = Array.from({ length: 40 }, (_, i) => `${i} AS c${i}`);
        const row = db.getSync(`SELECT ${cols.join(', ')}`);
        assert.strictEqual(Object.keys(row).length, 40);
        assert.strictEqual(row.c0, 0);
        assert.strictEqual(row.c39, 39);
    });

    it('text and blobs survive at the sizes that switch copy strategy', function () {
        // 4 KiB is the zero-copy boundary for blobs (src/convert.cc); both
        // sides of it must round-trip byte-for-byte.
        for (const size of [1, 4095, 4096, 65536]) {
            const buf = Buffer.alloc(size, 0xab);
            const row = db.getSync('SELECT ? AS b', buf);
            assert.strictEqual(row.b.length, size, `blob ${size}`);
            assert.ok(row.b.equals(buf), `blob ${size} contents`);
            const text = 'ü'.repeat(size);
            assert.strictEqual(
                db.getSync('SELECT ? AS t', text).t,
                text,
                `text ${size}`,
            );
        }
    });
});

// The `{ rowMode: 'array' }` opt-in on the sync read paths: one array per
// row instead of an object. The default row shape is pinned above and must
// not change; these pin the array shape, which bulk readers (CSV export,
// ETL) opt into.
describe('sync read paths: rowMode array', function () {
    /** @type {import('../lib/sqlite3.js').Database} */
    let db;

    beforeEach(async function () {
        db = await sqlite3.open(':memory:');
        await db.exec(
            'CREATE TABLE m (i INTEGER, r REAL, t TEXT, b BLOB, n INTEGER)',
        );
        await db.run(
            'INSERT INTO m VALUES (?, ?, ?, ?, ?)',
            42,
            1.5,
            'héllo',
            Buffer.from([1, 2, 3]),
            null,
        );
    });

    afterEach(async function () {
        await db.close();
    });

    it('getSync and allSync return arrays with full type fidelity', async function () {
        await db.run('INSERT INTO m (i) VALUES (7)');
        const rows = db.allSync('SELECT i, r, t, b, n FROM m ORDER BY i', {
            rowMode: 'array',
        });
        assert.strictEqual(rows.length, 2);
        assert.ok(Array.isArray(rows[0]));
        assert.deepStrictEqual(rows[0], [7, null, null, null, null]);
        assert.deepStrictEqual([...rows[1].slice(0, 2)], [42, 1.5]);
        assert.strictEqual(rows[1][2], 'héllo');
        assert.ok(Buffer.isBuffer(rows[1][3]));
        assert.deepStrictEqual([...rows[1][3]], [1, 2, 3]);
        assert.strictEqual(rows[1][4], null);

        const row = db.getSync('SELECT i, r FROM m WHERE i = 7', {
            rowMode: 'array',
        });
        assert.deepStrictEqual(row, [7, null]);
    });

    it('duplicate column names keep every value, unlike object mode', function () {
        assert.deepStrictEqual(
            db.getSync('SELECT 1 AS dup, 2 AS dup', { rowMode: 'array' }),
            [1, 2],
        );
        // The object mode default still collapses (pinned above too).
        assert.deepStrictEqual(
            Object.keys(db.getSync('SELECT 1 AS dup, 2 AS dup')),
            ['dup'],
        );
    });

    it('zero-row queries return [] and undefined, like object mode', function () {
        assert.deepStrictEqual(
            db.allSync('SELECT i FROM m WHERE i = 999', { rowMode: 'array' }),
            [],
        );
        assert.strictEqual(
            db.getSync('SELECT i FROM m WHERE i = 999', { rowMode: 'array' }),
            undefined,
        );
    });

    it('repeated database-level calls are independent queries, not cursor steps', function () {
        db.cacheStatements();
        for (const mode of [{ rowMode: 'array' }, { rowMode: 'array' }]) {
            const row = db.getSync('SELECT i FROM m', mode);
            assert.deepStrictEqual(row, [42]);
        }
        assert.deepStrictEqual(
            db.allSync('SELECT i FROM m', { rowMode: 'array' }).length,
            1,
        );
    });

    it('statement-level calls mix modes on one statement', function () {
        const stmt = db.prepareSync('SELECT i FROM m');
        assert.deepStrictEqual(stmt.getSync({ rowMode: 'array' }), [42]);
        assert.strictEqual(stmt.getSync(), undefined); // cursor exhausted
        assert.deepStrictEqual(stmt.allSync(), [{ i: 42 }]);
        assert.deepStrictEqual(stmt.allSync({ rowMode: 'array' }), [[42]]);
        stmt.finalize();
    });

    it('named binds and the options bag coexist', function () {
        const stmt = db.prepareSync('SELECT $x AS x, :y AS y');
        assert.deepStrictEqual(
            stmt.getSync({ $x: 1, ':y': 2 }, { rowMode: 'array' }),
            [1, 2],
        );
        assert.deepStrictEqual(
            db.getSync('SELECT $x AS x', { $x: 5 }, { rowMode: 'array' }),
            [5],
        );
        stmt.finalize();
    });

    it('rejects a rowMode that is not object or array', function () {
        assert.throws(
            () => db.getSync('SELECT i FROM m', { rowMode: 'bogus' }),
            (err) =>
                err instanceof TypeError &&
                err.message === "rowMode must be 'object' or 'array'",
        );
        assert.throws(
            () => db.allSync('SELECT i FROM m', { rowMode: 7 }),
            TypeError,
        );
    });

    it('the integer-mode RangeError names the column in array mode too', async function () {
        await db.exec('CREATE TABLE big (v INTEGER)');
        await db.run('INSERT INTO big VALUES (?)', 9007199254740993n);
        // Same wording as object mode: the column description is shared.
        assert.throws(
            () => db.getSync('SELECT v FROM big', { rowMode: 'array' }),
            (err) =>
                err instanceof RangeError &&
                err.message ===
                    "Integer 9007199254740993 in column 'v' is outside the safe " +
                        'integer range (-(2^53-1) .. 2^53-1); ' +
                        "configure('integerMode', 'bigint' | 'mixed') to read it exactly",
        );
        // And from a later row of allSync (the single-pass loop must not
        // lose the column identity by then).
        await db.run('INSERT INTO big VALUES (?)', 1n);
        assert.throws(
            () =>
                db.allSync('SELECT v FROM big ORDER BY v', {
                    rowMode: 'array',
                }),
            /Integer 9007199254740993 in column 'v' is outside/,
        );
        // bigint mode reads the same rows as arrays without throwing.
        db.configure('integerMode', 'bigint');
        assert.deepStrictEqual(
            db.getSync('SELECT v FROM big', { rowMode: 'array' }),
            [9007199254740993n],
        );
    });

    it('a schema change on a cached statement rebuilds the row arrays', async function () {
        // SELECT * over a table that is dropped and recreated with a
        // different shape: the cached statement transparently re-prepares
        // on the next step, and the sync paths must follow the live
        // statement's new result shape instead of reusing the cached keys.
        db.cacheStatements();
        await db.exec('CREATE TABLE u (a INTEGER)');
        await db.run('INSERT INTO u VALUES (1)');
        assert.deepStrictEqual(
            db.allSync('SELECT * FROM u', { rowMode: 'array' }),
            [[1]],
        );
        await db.exec('DROP TABLE u; CREATE TABLE u (a INTEGER, b TEXT)');
        await db.runSync("INSERT INTO u VALUES (2, 'x')");
        assert.deepStrictEqual(
            db.getSync('SELECT * FROM u', { rowMode: 'array' }),
            [2, 'x'],
        );
        assert.deepStrictEqual(Object.keys(db.getSync('SELECT * FROM u')), [
            'a',
            'b',
        ]);
    });
});

// The row factory (lib/sqlite3.js makeRowFactory + Statement::RowFactoryForShape)
// builds each row by calling a generated function instead of storing each
// column from C++. It is a pure optimisation, so every one of these
// assertions describes behaviour that predates it and must survive it —
// the generated source embeds the column names, which is exactly where a
// fast path can start disagreeing with the slow one.
describe('row factory: generated rows match the store loop', function () {
    /** @type {import('../lib/sqlite3.js').Database} */
    let db;

    beforeEach(async function () {
        db = await sqlite3.open(':memory:');
    });

    afterEach(async function () {
        await db.close();
    });

    /**
     * Reads one row through every path that builds rows, so a fast path
     * cannot disagree with a slow one unnoticed.
     * @param {string} sql the query.
     * @returns {Promise<Record<string, unknown>[]>} one row per path.
     */
    async function everyPath(sql) {
        const rows = [
            db.getSync(sql),
            db.allSync(sql)[0],
            (await db.all(sql))[0],
            await db.get(sql),
        ];
        const each = [];
        await new Promise((resolve, reject) => {
            db.each(
                sql,
                (err, row) => (err ? reject(err) : each.push(row)),
                (err) => (err ? reject(err) : resolve(undefined)),
            );
        });
        rows.push(each[0]);
        return /** @type {Record<string, unknown>[]} */ (rows);
    }

    it('escapes quotes, backslashes and newlines in column names', async function () {
        // These names are interpolated into generated source; an escaping
        // bug here is a syntax error at best and a wrong row at worst.
        const sql =
            'SELECT 1 AS "a\'b", 2 AS "c""d", 3 AS "e\\f", 4 AS "g' +
            String.fromCharCode(10) +
            'h"';
        for (const row of await everyPath(sql)) {
            assert.deepStrictEqual(Object.keys(row), [
                "a'b",
                'c"d',
                'e\\f',
                'g\nh',
            ]);
            assert.deepStrictEqual(Object.values(row), [1, 2, 3, 4]);
        }
    });

    it('keeps non-ASCII and empty column names intact', async function () {
        const sql = 'SELECT 1 AS "héllo—✓", 2 AS ""';
        for (const row of await everyPath(sql)) {
            assert.deepStrictEqual(Object.keys(row), ['héllo—✓', '']);
            assert.strictEqual(row['héllo—✓'], 1);
            assert.strictEqual(row[''], 2);
        }
    });

    it('treats a __proto__ column exactly as the store loop did', async function () {
        // An object literal assigns the prototype for this key rather than
        // creating an own property — which is also what a property store
        // did, so the observable result is unchanged. Pinned because the
        // two mechanisms agreeing here is load-bearing, not obvious.
        const sql = 'SELECT 1 AS "__proto__", 2 AS keep';
        for (const row of await everyPath(sql)) {
            assert.strictEqual(Object.hasOwn(row, '__proto__'), false);
            assert.strictEqual(Object.getPrototypeOf(row), Object.prototype);
            assert.strictEqual(row.keep, 2);
        }
    });

    it('collapses duplicate column names to the last value', async function () {
        const sql = 'SELECT 1 AS dup, 2 AS other, 3 AS dup';
        for (const row of await everyPath(sql)) {
            assert.deepStrictEqual(row, { dup: 3, other: 2 });
        }
    });

    it('rebuilds the row shape after a re-prepare', async function () {
        // The factory bakes in the column names, so a schema change that
        // re-prepares the statement behind sqlite3_step must invalidate it.
        await db.exec('CREATE TABLE s (a INTEGER)');
        await db.run('INSERT INTO s VALUES (1)');
        assert.deepStrictEqual(db.allSync('SELECT * FROM s'), [{ a: 1 }]);
        await db.exec('DROP TABLE s');
        await db.exec('CREATE TABLE s (b INTEGER, c INTEGER)');
        await db.run('INSERT INTO s VALUES (2, 3)');
        assert.deepStrictEqual(db.allSync('SELECT * FROM s'), [{ b: 2, c: 3 }]);
    });

    it('falls back to the store loop beyond the factory column limit', async function () {
        // kMaxFactoryColumns is 256; a wider result must still be correct.
        const width = 300;
        const cols = Array.from(
            { length: width },
            (_, i) => `${i} AS c${i}`,
        ).join(',');
        const row = db.getSync(`SELECT ${cols}`);
        assert.strictEqual(Object.keys(row).length, width);
        assert.strictEqual(row.c0, 0);
        assert.strictEqual(row.c299, 299);
        assert.deepStrictEqual(await db.get(`SELECT ${cols}`), row);
    });

    it('still raises the integer-mode RangeError from a factory row', async function () {
        await db.exec('CREATE TABLE big (v INTEGER)');
        await db.run('INSERT INTO big VALUES (9007199254740993)');
        assert.throws(() => db.allSync('SELECT v FROM big'), {
            name: 'RangeError',
            message: /column 'v'/,
        });
        await assert.rejects(db.all('SELECT v FROM big'), {
            name: 'RangeError',
            message: /column 'v'/,
        });
    });

    it('preserves every value type through the factory', async function () {
        await db.exec(
            'CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n INTEGER)',
        );
        await db.run(
            'INSERT INTO t VALUES (?, ?, ?, ?, ?)',
            7,
            1.5,
            'héllo',
            Buffer.from([1, 2, 3]),
            null,
        );
        for (const row of await everyPath('SELECT * FROM t')) {
            assert.strictEqual(row.i, 7);
            assert.strictEqual(row.r, 1.5);
            assert.strictEqual(row.s, 'héllo');
            assert.ok(Buffer.isBuffer(row.b));
            assert.deepStrictEqual(
                [.../** @type {Buffer} */ (row.b)],
                [1, 2, 3],
            );
            assert.strictEqual(row.n, null);
        }
    });
});

describe('implicit sync statement cache', function () {
    /** @type {import('../lib/sqlite3.js').Database} */
    let db;

    beforeEach(async function () {
        db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INTEGER)');
        await db.run('INSERT INTO t VALUES (1)');
    });

    afterEach(async function () {
        await db.close();
    });

    it('reuses the prepared statement across identical sync calls', function () {
        db.getSync('SELECT a FROM t');
        db.getSync('SELECT a FROM t');
        assert.strictEqual(db._syncStmtCache.size, 1);
    });

    it('re-runs a cached parameterless query from its first row', function () {
        // The cache makes the statement outlive the call, so a second
        // getSync must restart rather than step a spent cursor.
        assert.deepStrictEqual(db.getSync('SELECT a FROM t'), { a: 1 });
        assert.deepStrictEqual(db.getSync('SELECT a FROM t'), { a: 1 });
    });

    it('is invalidated by registering a user function', async function () {
        db.getSync('SELECT a FROM t');
        assert.strictEqual(db._syncStmtCache.size, 1);
        db.function('noop', (x) => x);
        assert.strictEqual(db._syncStmtCache.size, 0);
    });

    it('does not enable the opt-in async statement cache', function () {
        db.getSync('SELECT a FROM t');
        assert.strictEqual(db._stmtCache, undefined);
    });

    it('is emptied by close, leaving no unfinalized statements', async function () {
        const fresh = await sqlite3.open(':memory:');
        fresh.getSync('SELECT 1 AS a');
        assert.strictEqual(fresh._syncStmtCache.size, 1);
        await fresh.close();
        assert.strictEqual(fresh._syncStmtCache.size, 0);
    });

    it('evicts beyond its capacity without leaking statements', function () {
        for (let i = 0; i < 80; i++) db.getSync(`SELECT ${i} AS a`);
        assert.ok(db._syncStmtCache.size <= 64);
    });
});

describe('row factory: realms that forbid code generation', function () {
    it('falls back to the store loop and returns identical rows', function () {
        // The generated row builder needs `new Function`. A CSP'd Electron
        // renderer or this flag forbids it, and the addon must degrade to
        // building rows column by column rather than fail. Run out of
        // process because the restriction is per-isolate.
        // Already a file: URL — import it as one. Going via .pathname and
        // back through pathToFileURL doubles the drive letter on Windows
        // ("D:\D:\a\...", because "/D:/a/..." reads as a relative path)
        // and drops percent-encoding on any path containing spaces.
        const lib = new URL('../lib/sqlite3.js', import.meta.url).href;
        const script = `
            import mod from '${lib}';
            const sqlite3 = mod.verbose ? mod : mod.default;
            try { new Function('return 1'); console.log('CODEGEN=allowed'); }
            catch { console.log('CODEGEN=blocked'); }
            const db = new sqlite3.Database(':memory:');
            await new Promise((r, j) => db.run('SELECT 1', (e) => e ? j(e) : r()));
            db.runSync('CREATE TABLE t (a INTEGER, b TEXT, c BLOB)');
            db.runSync("INSERT INTO t VALUES (1, 'x', x'0102')");
            const row = db.allSync('SELECT * FROM t')[0];
            console.log('OBJ=' + JSON.stringify(db.allSync('SELECT * FROM t')));
            console.log('ARR=' + JSON.stringify(
                db.allSync('SELECT * FROM t', { rowMode: 'array' })));
            console.log('ASYNC=' + JSON.stringify(await db.all('SELECT * FROM t')));
            console.log('PROTO=' + (Object.getPrototypeOf(row) === Object.prototype));
            console.log('BUFFER=' + Buffer.isBuffer(row.c));
            db.close();
        `;
        const run = (extraArgs) =>
            spawnSync(
                process.execPath,
                [...extraArgs, '--input-type=module', '-e', script],
                { encoding: 'utf8' },
            );

        const blocked = run(['--disallow-code-generation-from-strings']);
        assert.strictEqual(blocked.status, 0, blocked.stderr);
        assert.match(blocked.stdout, /CODEGEN=blocked/);

        const allowed = run([]);
        assert.strictEqual(allowed.status, 0, allowed.stderr);
        assert.match(allowed.stdout, /CODEGEN=allowed/);

        // The rows themselves must not depend on which path built them.
        const rowsOf = (out) =>
            out
                .split(String.fromCharCode(10))
                .filter((line) => /^(OBJ|ARR|ASYNC|PROTO|BUFFER)=/.test(line));
        assert.deepStrictEqual(rowsOf(blocked.stdout), rowsOf(allowed.stdout));
        assert.match(blocked.stdout, /PROTO=true/);
        assert.match(blocked.stdout, /BUFFER=true/);
    });
});

// The synchronous paths bind straight onto the statement instead of
// building a Values::Field per parameter (src/convert.cc BindValueDirect).
// That is a second implementation of the bind semantics, so these tests
// hold it against the first one: for every value shape and every failure,
// the sync paths must agree with the asynchronous Field path exactly.
describe('sync bind agrees with the async bind path', function () {
    /** @type {import('../lib/sqlite3.js').Database} */
    let db;

    beforeEach(async function () {
        db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (v)');
    });

    afterEach(async function () {
        await db.close();
    });

    /**
     * Round-trips one value through both bind implementations.
     * @param {unknown} value the value to bind.
     * @returns {Promise<{sync: unknown, async: unknown}>} both readings.
     */
    async function bothPaths(value) {
        await db.run('DELETE FROM t');
        db.runSync('INSERT INTO t VALUES (?)', value);
        const sync = db.getSync('SELECT v FROM t').v;
        await db.run('DELETE FROM t');
        await db.run('INSERT INTO t VALUES (?)', value);
        const asyncRead = (await db.get('SELECT v FROM t')).v;
        return { sync, async: asyncRead };
    }

    const cases = [
        ['integer', 42],
        ['negative integer', -7],
        ['zero', 0],
        ['large safe integer', 9007199254740991],
        ['float', 1.5],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['string', 'hello'],
        ['empty string', ''],
        ['unicode string', 'héllo—✓'],
        ['string with NUL', 'a\u0000b'],
        ['true', true],
        ['false', false],
        ['null', null],
        ['bigint', 123n],
        ['negative bigint', -123n],
    ];

    for (const [label, value] of cases) {
        it(`binds ${label} identically`, async function () {
            const { sync, async: asyncValue } = await bothPaths(value);
            assert.deepStrictEqual(sync, asyncValue);
        });
    }

    it('binds an empty Buffer as an empty blob, not NULL', async function () {
        const { sync, async: asyncValue } = await bothPaths(Buffer.alloc(0));
        assert.ok(Buffer.isBuffer(sync), 'sync bound NULL, not a blob');
        assert.strictEqual(/** @type {Buffer} */ (sync).length, 0);
        assert.deepStrictEqual(sync, asyncValue);
    });

    it('binds Buffers, typed arrays, DataViews and ArrayBuffers alike', async function () {
        const bytes = [1, 2, 3, 4];
        const views = [
            Buffer.from(bytes),
            new Uint8Array(bytes),
            new DataView(new Uint8Array(bytes).buffer),
            new Uint8Array(bytes).buffer,
        ];
        for (const view of views) {
            const { sync, async: asyncValue } = await bothPaths(view);
            assert.deepStrictEqual([.../** @type {Buffer} */ (sync)], bytes);
            assert.deepStrictEqual(sync, asyncValue);
        }
    });

    it('binds a Date as epoch milliseconds', async function () {
        const date = new Date(1700000000000);
        const { sync, async: asyncValue } = await bothPaths(date);
        assert.strictEqual(sync, 1700000000000);
        assert.strictEqual(sync, asyncValue);
    });

    it('binds a byteOffset view without the whole backing buffer', async function () {
        const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
        const view = backing.subarray(2, 5);
        const { sync } = await bothPaths(view);
        assert.deepStrictEqual([.../** @type {Buffer} */ (sync)], [1, 2, 3]);
    });

    /**
     * Captures the error message from each path for the same call.
     * @param {unknown[]} params the bind parameters.
     * @param {string} [sql] the statement to bind against.
     * @returns {Promise<{sync: string, async: string}>} both messages.
     */
    async function bothErrors(params, sql = 'INSERT INTO t VALUES (?)') {
        let syncMessage = '(no error)';
        try {
            db.runSync(sql, ...params);
        } catch (err) {
            syncMessage = /** @type {Error} */ (err).message;
        }
        let asyncMessage = '(no error)';
        try {
            await db.run(sql, ...params);
        } catch (err) {
            asyncMessage = /** @type {Error} */ (err).message;
        }
        return { sync: syncMessage, async: asyncMessage };
    }

    it('reports too few parameters identically', async function () {
        const { sync, async: asyncMessage } = await bothErrors(
            [1],
            'INSERT INTO t SELECT ? UNION ALL SELECT ?',
        );
        assert.match(
            sync,
            /supplied 1 parameter\(s\) but the statement takes 2/,
        );
        assert.strictEqual(sync, asyncMessage);
    });

    it('reports too many parameters identically', async function () {
        const { sync, async: asyncMessage } = await bothErrors([1, 2, 3]);
        assert.match(
            sync,
            /supplied 3 parameter\(s\) but the statement takes 1/,
        );
        assert.strictEqual(sync, asyncMessage);
    });

    it('reports an unknown named parameter identically', async function () {
        const { sync, async: asyncMessage } = await bothErrors(
            [{ $nope: 1 }],
            'INSERT INTO t VALUES ($v)',
        );
        assert.match(sync, /unknown named parameter "\$nope"/);
        assert.strictEqual(sync, asyncMessage);
    });

    it('reports an unsupported type identically', async function () {
        // A bare object is the named-parameters shape, not a value; nest
        // it in the array form so it is bound as one.
        const { sync, async: asyncMessage } = await bothErrors([[{ a: 1 }]]);
        assert.match(sync, /Cannot bind parameter 1: unsupported type Object/);
        assert.strictEqual(sync, asyncMessage);
    });

    it('reports an out-of-range BigInt identically', async function () {
        const huge = 2n ** 64n;
        const { sync, async: asyncMessage } = await bothErrors([huge]);
        assert.match(sync, /BigInt .* outside the signed 64-bit integer range/);
        assert.strictEqual(sync, asyncMessage);
    });

    it('names the offending parameter by position', async function () {
        const { sync } = await bothErrors(
            [1, Symbol('x')],
            'INSERT INTO t VALUES (?), (?)',
        );
        assert.match(sync, /Cannot bind parameter 2:/);
    });

    it('names a failing named parameter by name', async function () {
        const { sync } = await bothErrors(
            [{ $v: Symbol('x') }],
            'INSERT INTO t VALUES ($v)',
        );
        assert.match(sync, /Cannot bind parameter \$v:/);
    });

    it('accepts array, positional and named shapes alike', function () {
        db.runSync('DELETE FROM t');
        db.runSync('INSERT INTO t VALUES (?)', 1);
        db.runSync('INSERT INTO t VALUES (?)', [2]);
        db.runSync('INSERT INTO t VALUES ($v)', { $v: 3 });
        assert.deepStrictEqual(
            db.allSync('SELECT v FROM t ORDER BY v').map((r) => r.v),
            [1, 2, 3],
        );
    });

    it('leaves no partial binding behind after a failed bind', function () {
        db.runSync('DELETE FROM t');
        assert.throws(() =>
            db.runSync('INSERT INTO t VALUES (?), (?)', 1, Symbol('x')),
        );
        // The statement must be re-runnable with a valid call afterwards.
        db.runSync('INSERT INTO t VALUES (?), (?)', 4, 5);
        assert.deepStrictEqual(
            db.allSync('SELECT v FROM t ORDER BY v').map((r) => r.v),
            [4, 5],
        );
    });

    // Named binding classifies each key as a position or a name, and
    // decides whether the argument is a parameter map at all. Both bind
    // implementations share that code, and its fast paths are only valid
    // where they agree with the general one — so the odd spellings are
    // pinned here rather than left to the common case.

    /**
     * Binds a named-parameter map through both implementations.
     * @param {object} params the named parameters.
     * @param {string} sql the statement to bind against.
     * @returns {Promise<{sync: unknown, async: unknown}>} both readings.
     */
    async function bothNamed(params, sql) {
        await db.run('DELETE FROM t');
        db.runSync(sql, params);
        const sync = db.getSync('SELECT v FROM t').v;
        await db.run('DELETE FROM t');
        await db.run(sql, params);
        const asyncRead = (await db.get('SELECT v FROM t')).v;
        return { sync, async: asyncRead };
    }

    it('binds a named parameter identically on both paths', async function () {
        const { sync, async: asyncValue } = await bothNamed(
            { $v: 'x' },
            'INSERT INTO t VALUES ($v)',
        );
        assert.strictEqual(sync, 'x');
        assert.strictEqual(sync, asyncValue);
    });

    it('binds the :name and @name sigils too', async function () {
        for (const sigil of [':', '@']) {
            const { sync, async: asyncValue } = await bothNamed(
                { [`${sigil}v`]: 5 },
                `INSERT INTO t VALUES (${sigil}v)`,
            );
            assert.strictEqual(sync, 5);
            assert.strictEqual(sync, asyncValue);
        }
    });

    it('reads an integer key as a bind position', async function () {
        const { sync, async: asyncValue } = await bothNamed(
            { 1: 'by index' },
            'INSERT INTO t VALUES (?)',
        );
        assert.strictEqual(sync, 'by index');
        assert.strictEqual(sync, asyncValue);
    });

    // Keys that could read as a number must not take the "obviously a
    // name" shortcut: each of these coerces to an integer, so it selects
    // a position exactly as it always has.
    for (const key of [' 1', '1.0', '+1']) {
        it(`treats the key ${JSON.stringify(key)} as position 1`, async function () {
            const { sync, async: asyncValue } = await bothNamed(
                { [key]: 'numeric-ish' },
                'INSERT INTO t VALUES (?)',
            );
            assert.strictEqual(sync, 'numeric-ish');
            assert.strictEqual(sync, asyncValue);
        });
    }

    // Likewise for the ones that coerce to an out-of-range position:
    // they must still fail, and fail the same way on both paths.
    for (const key of ['0x10', '', '1e2']) {
        it(`fails alike for the out-of-range key ${JSON.stringify(key)}`, async function () {
            const { sync, async: asyncMessage } = await bothErrors([
                { [key]: 'v' },
            ]);
            assert.notStrictEqual(sync, '(no error)');
            assert.strictEqual(sync, asyncMessage);
        });
    }

    // The key is read into a fixed stack buffer, with a fallback for
    // anything longer. Straddle that boundary so the fallback is real.
    for (const length of [120, 126, 127, 128, 200]) {
        it(`binds a ${length}-byte parameter name`, async function () {
            const name = `$${'a'.repeat(length - 1)}`;
            const { sync, async: asyncValue } = await bothNamed(
                { [name]: length },
                `INSERT INTO t VALUES (${name})`,
            );
            assert.strictEqual(sync, length);
            assert.strictEqual(sync, asyncValue);
        });
    }

    it('reports an unknown named parameter identically', async function () {
        const { sync, async: asyncMessage } = await bothErrors(
            [{ $nope: 1 }],
            'INSERT INTO t VALUES ($v)',
        );
        assert.match(sync, /unknown named parameter "\$nope"/);
        assert.strictEqual(sync, asyncMessage);
    });

    it('accepts a null-prototype object as a parameter map', async function () {
        const params = Object.create(null);
        params.$v = 'no proto';
        const { sync, async: asyncValue } = await bothNamed(
            params,
            'INSERT INTO t VALUES ($v)',
        );
        assert.strictEqual(sync, 'no proto');
        assert.strictEqual(sync, asyncValue);
    });

    it('accepts a class instance as a parameter map', async function () {
        class Params {
            constructor() {
                this.$v = 'from a class';
            }
        }
        const { sync, async: asyncValue } = await bothNamed(
            new Params(),
            'INSERT INTO t VALUES ($v)',
        );
        assert.strictEqual(sync, 'from a class');
        assert.strictEqual(sync, asyncValue);
    });

    it('still binds a lone Date, RegExp or Buffer positionally', async function () {
        // These are objects, but they are values rather than parameter
        // maps — the distinction the map check exists to draw.
        const date = new Date(1700000000000);
        assert.strictEqual((await bothPaths(date)).sync, 1700000000000);

        // A RegExp binds as a value (its text), not as an empty map —
        // which is what it would look like if read as named parameters.
        const re = await bothPaths(/x/);
        assert.strictEqual(typeof re.sync, 'string');
        assert.strictEqual(re.sync, re.async);

        const buf = Buffer.from([1, 2, 3]);
        assert.deepStrictEqual(
            [.../** @type {Buffer} */ ((await bothPaths(buf)).sync)],
            [1, 2, 3],
        );
    });

    it('re-steps a parameterless statement without rebinding', async function () {
        const statement = db.prepare('INSERT INTO t VALUES (7)');
        await db.wait();
        statement.runSync();
        statement.runSync();
        assert.strictEqual(db.getSync('SELECT count(*) AS n FROM t').n, 2);
        statement.finalize();
    });

    it('keeps a previous binding when re-run with no arguments', async function () {
        const statement = db.prepare('INSERT INTO t VALUES (?)');
        await db.wait();
        statement.runSync(11);
        statement.runSync();
        assert.deepStrictEqual(
            db.allSync('SELECT v FROM t').map((r) => r.v),
            [11, 11],
        );
        statement.finalize();
    });

    it('ignores an all-undefined call against a parameterless statement', function () {
        // Historical call shape: generic wrappers forwarding an absent
        // value must not trip the arity check.
        db.runSync('INSERT INTO t VALUES (7)', undefined);
        assert.strictEqual(db.getSync('SELECT count(*) AS n FROM t').n, 1);
    });

    it('binds undefined as NULL when the statement takes a parameter', function () {
        db.runSync('INSERT INTO t VALUES (?)', undefined);
        assert.strictEqual(db.getSync('SELECT v FROM t').v, null);
    });
});
