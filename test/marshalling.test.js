import assert from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Marshalling regression tests: pin down the exact JS<->SQLite value
// conversion behaviour exercised by the performance work (flat fields,
// cached column names, SQLITE_STATIC binds, zero-copy blobs, batched each).

function randomBytes(n) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 7 + 31) & 0xff;
    return b;
}

describe('marshalling', function () {
    let db;

    before(function (_t, done) {
        db = new sqlite3.Database(':memory:');
        db.exec(
            `
            CREATE TABLE types (
                id INTEGER PRIMARY KEY,
                int_col INTEGER,
                flt_col REAL,
                txt_col TEXT,
                blob_col BLOB
            );
        `,
            done,
        );
    });

    describe('type round-trips via db.run/db.get', function () {
        beforeEach(function (_t, done) {
            db.exec('DELETE FROM types', done);
        });

        const ints = [
            0, 1, -1, 2147483647, -2147483648, 2147483648, 9007199254740991,
        ];
        ints.forEach(function (v) {
            it(`round-trips integer ${v}`, function (_t, done) {
                db.run(
                    'INSERT INTO types (int_col) VALUES (?)',
                    v,
                    function (err) {
                        assert.ifError(err);
                        db.get(
                            'SELECT int_col FROM types',
                            function (err, row) {
                                assert.ifError(err);
                                assert.strictEqual(row.int_col, v);
                                done();
                            },
                        );
                    },
                );
            });
        });

        it('binds -0 through the integer path as 0', function (_t, done) {
            db.run(
                'INSERT INTO types (int_col) VALUES (?)',
                -0,
                function (err) {
                    assert.ifError(err);
                    db.get(
                        'SELECT typeof(int_col) AS t, int_col FROM types',
                        function (err, row) {
                            assert.ifError(err);
                            assert.strictEqual(row.int_col, 0);
                            assert.strictEqual(row.t, 'integer');
                            done();
                        },
                    );
                },
            );
        });

        const flts = [
            0.5,
            -0.5,
            Math.PI,
            1e308,
            -1e308,
            4294967296.249,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
        ];
        flts.forEach(function (v) {
            it(`round-trips float ${v}`, function (_t, done) {
                db.run(
                    'INSERT INTO types (flt_col) VALUES (?)',
                    v,
                    function (err) {
                        assert.ifError(err);
                        db.get(
                            'SELECT flt_col FROM types',
                            function (err, row) {
                                assert.ifError(err);
                                assert.ok(
                                    Object.is(row.flt_col, v),
                                    `got ${row.flt_col}`,
                                );
                                done();
                            },
                        );
                    },
                );
            });
        });

        it('binds NaN as NULL (sqlite semantics)', function (_t, done) {
            db.run(
                'INSERT INTO types (flt_col) VALUES (?)',
                Number.NaN,
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT flt_col FROM types', function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.flt_col, null);
                        done();
                    });
                },
            );
        });

        const texts = [
            '',
            'a',
            'héllo wörld ✓ 日本語',
            'a\0b',
            'x'.repeat(10000),
        ];
        texts.forEach(function (v, i) {
            it(`round-trips text #${i} (len ${v.length})`, function (_t, done) {
                db.run(
                    'INSERT INTO types (txt_col) VALUES (?)',
                    v,
                    function (err) {
                        assert.ifError(err);
                        db.get(
                            'SELECT txt_col FROM types',
                            function (err, row) {
                                assert.ifError(err);
                                assert.strictEqual(row.txt_col, v);
                                done();
                            },
                        );
                    },
                );
            });
        });

        it('round-trips true as 1 and false as 0', function (_t, done) {
            db.run(
                'INSERT INTO types (int_col) VALUES (?)',
                true,
                function (err) {
                    assert.ifError(err);
                    db.run(
                        'INSERT INTO types (int_col) VALUES (?)',
                        false,
                        function (err) {
                            assert.ifError(err);
                            db.get(
                                'SELECT int_col FROM types ORDER BY id LIMIT 1',
                                function (err, row) {
                                    assert.ifError(err);
                                    assert.strictEqual(row.int_col, 1);
                                    db.get(
                                        'SELECT int_col FROM types ORDER BY id DESC LIMIT 1',
                                        function (err, row) {
                                            assert.ifError(err);
                                            assert.strictEqual(row.int_col, 0);
                                            done();
                                        },
                                    );
                                },
                            );
                        },
                    );
                },
            );
        });

        it('binds null as NULL', function (_t, done) {
            db.run(
                'INSERT INTO types (txt_col) VALUES (?)',
                null,
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT txt_col FROM types', function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.txt_col, null);
                        done();
                    });
                },
            );
        });

        it('binds undefined as NULL', function (_t, done) {
            db.run(
                'INSERT INTO types (txt_col) VALUES (?)',
                undefined,
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT txt_col FROM types', function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.txt_col, null);
                        done();
                    });
                },
            );
        });

        it('serializes plain objects in arrays as [object Object]', function (_t, done) {
            db.run(
                'INSERT INTO types (txt_col) VALUES (?)',
                [{ a: 1 }],
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT txt_col FROM types', function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.txt_col, '[object Object]');
                        done();
                    });
                },
            );
        });

        it('treats direct plain objects as named-parameter maps (SQLITE_RANGE)', function (_t, done) {
            db.run(
                'INSERT INTO types (txt_col) VALUES (?)',
                { a: 1 },
                function (err) {
                    assert.ok(err);
                    assert.strictEqual(err.code, 'SQLITE_RANGE');
                    done();
                },
            );
        });

        it('serializes dates as epoch millis', function (_t, done) {
            const dates = [
                new Date(0),
                new Date(-86400000),
                new Date(1700000000123),
            ];
            // Insert sequentially: concurrent runs race for rowids.
            let n = 0;
            const insertNext = function () {
                if (n === dates.length) {
                    return db.all(
                        'SELECT flt_col FROM types ORDER BY id',
                        function (err, rows) {
                            assert.ifError(err);
                            assert.strictEqual(rows.length, 3);
                            rows.forEach(function (row, i) {
                                assert.strictEqual(row.flt_col, +dates[i]);
                            });
                            done();
                        },
                    );
                }
                db.run(
                    'INSERT INTO types (flt_col) VALUES (?)',
                    dates[n],
                    function (err) {
                        assert.ifError(err);
                        n++;
                        insertNext();
                    },
                );
            };
            insertNext();
        });

        it('serializes regexps via toString', function (_t, done) {
            const re = /^f\noo/gi;
            db.run(
                'INSERT INTO types (txt_col) VALUES (?)',
                re,
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT txt_col FROM types', function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.txt_col, String(re));
                        done();
                    });
                },
            );
        });

        it('round-trips integer via object with numeric keys', function (_t, done) {
            db.run(
                'INSERT INTO types (int_col, flt_col) VALUES (?, ?)',
                { 1: 42, 2: 1.5 },
                function (err) {
                    assert.ifError(err);
                    db.get(
                        'SELECT int_col, flt_col FROM types',
                        function (err, row) {
                            assert.ifError(err);
                            assert.strictEqual(row.int_col, 42);
                            assert.strictEqual(row.flt_col, 1.5);
                            done();
                        },
                    );
                },
            );
        });
    });

    describe('named parameters', function () {
        const styles = ['$name', '@name', ':name'];
        styles.forEach(function (style) {
            it(`binds ${style}name`, function (_t, done) {
                const obj = {};
                obj[`${style}name`] = 'neo';
                db.get(`SELECT ${style}name AS out`, obj, function (err, row) {
                    assert.ifError(err);
                    assert.strictEqual(row.out, 'neo');
                    done();
                });
            });
        });

        it('mixes named and positional-looking keys', function (_t, done) {
            db.get(
                'SELECT $a AS a, ?2 AS b, :c AS c',
                { $a: 1, 2: 2, ':c': 3 },
                function (err, row) {
                    assert.ifError(err);
                    assert.strictEqual(row.a, 1);
                    assert.strictEqual(row.b, 2);
                    assert.strictEqual(row.c, 3);
                    done();
                },
            );
        });
    });

    describe('column names', function () {
        it('uses AS aliases', function (_t, done) {
            db.get(
                'SELECT 1 AS foo, 2 AS "bar baz", 3 AS héllo',
                function (err, row) {
                    assert.ifError(err);
                    assert.deepStrictEqual(Object.keys(row), [
                        'foo',
                        'bar baz',
                        'héllo',
                    ]);
                    assert.strictEqual(row.foo, 1);
                    assert.strictEqual(row['bar baz'], 2);
                    assert.strictEqual(row['héllo'], 3);
                    done();
                },
            );
        });

        it('uses expression text for unnamed expressions', function (_t, done) {
            db.get('SELECT 1 + 1', function (err, row) {
                assert.ifError(err);
                assert.deepStrictEqual(Object.keys(row), ['1 + 1']);
                assert.strictEqual(row['1 + 1'], 2);
                done();
            });
        });

        it('keeps last value for duplicate column names', function (_t, done) {
            db.get('SELECT 1 AS a, 2 AS a', function (err, row) {
                assert.ifError(err);
                assert.strictEqual(row.a, 2);
                assert.deepStrictEqual(Object.keys(row), ['a']);
                done();
            });
        });

        it('keeps names stable across reused statement calls', function (_t, done) {
            const stmt = db.prepare('SELECT ? AS one, ? AS two');
            stmt.get(1, 2, function (err, row1) {
                assert.ifError(err);
                assert.deepStrictEqual(Object.keys(row1), ['one', 'two']);
                assert.strictEqual(row1.one, 1);
                assert.strictEqual(row1.two, 2);
                stmt.get(3, 4, function (err, row2) {
                    assert.ifError(err);
                    assert.deepStrictEqual(Object.keys(row2), ['one', 'two']);
                    assert.strictEqual(row2.one, 3);
                    assert.strictEqual(row2.two, 4);
                    stmt.finalize(done);
                });
            });
        });
    });

    describe('blob marshalling', function () {
        beforeEach(function (_t, done) {
            db.exec('DELETE FROM types', done);
        });

        it('round-trips binary data with NULs and 0xff', function (_t, done) {
            const buf = randomBytes(1024);
            buf[0] = 0x00;
            buf[1] = 0xff;
            db.run(
                'INSERT INTO types (blob_col) VALUES (?)',
                buf,
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT blob_col FROM types', function (err, row) {
                        assert.ifError(err);
                        assert.ok(Buffer.isBuffer(row.blob_col));
                        assert.strictEqual(row.blob_col.length, buf.length);
                        assert.ok(buf.equals(row.blob_col));
                        done();
                    });
                },
            );
        });

        it('round-trips empty buffers', function (_t, done) {
            db.run(
                'INSERT INTO types (blob_col) VALUES (?)',
                Buffer.alloc(0),
                function (err) {
                    assert.ifError(err);
                    db.get(
                        'SELECT blob_col, typeof(blob_col) AS t FROM types',
                        function (err, row) {
                            assert.ifError(err);
                            assert.ok(Buffer.isBuffer(row.blob_col));
                            assert.strictEqual(row.blob_col.length, 0);
                            assert.strictEqual(row.t, 'blob');
                            done();
                        },
                    );
                },
            );
        });

        it('round-trips large blobs', function (_t, done) {
            const buf = randomBytes(1024 * 1024);
            db.run(
                'INSERT INTO types (blob_col) VALUES (?)',
                buf,
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT blob_col FROM types', function (err, row) {
                        assert.ifError(err);
                        assert.ok(buf.equals(row.blob_col));
                        done();
                    });
                },
            );
        });

        it('returned buffers are independent per read and mutation-safe', function (_t, done) {
            const buf = randomBytes(64);
            db.run(
                'INSERT INTO types (blob_col) VALUES (?)',
                buf,
                function (err) {
                    assert.ifError(err);
                    db.get('SELECT blob_col FROM types', function (err, row1) {
                        assert.ifError(err);
                        row1.blob_col[0] = 0xaa;
                        db.get(
                            'SELECT blob_col FROM types',
                            function (err, row2) {
                                assert.ifError(err);
                                assert.strictEqual(row2.blob_col[0], buf[0]);
                                assert.ok(buf.equals(row2.blob_col));
                                done();
                            },
                        );
                    });
                },
            );
        });

        it('delivers blobs via each()', function (_t, done) {
            const blobs = [randomBytes(16), randomBytes(16), randomBytes(16)];
            let i = 0;
            const insertNext = function () {
                if (i === blobs.length) return each();
                db.run(
                    'INSERT INTO types (blob_col) VALUES (?)',
                    blobs[i],
                    insertNext,
                );
                i++;
            };
            const each = function () {
                let seen = 0;
                db.each(
                    'SELECT blob_col FROM types ORDER BY id',
                    function (err, row) {
                        assert.ifError(err);
                        assert.ok(blobs[seen].equals(row.blob_col));
                        seen++;
                    },
                    function (err, count) {
                        assert.ifError(err);
                        assert.strictEqual(count, blobs.length);
                        assert.strictEqual(seen, blobs.length);
                        done();
                    },
                );
            };
            insertNext();
        });
    });

    describe('bind value lifetime under queueing (SQLITE_STATIC regression)', function () {
        beforeEach(function (_t, done) {
            db.exec('DELETE FROM types', done);
        });

        it('keeps queued text params intact', function (_t, done) {
            const N = 200;
            const stmt = db.prepare('INSERT INTO types (txt_col) VALUES (?)');
            for (let i = 0; i < N; i++) {
                const s = `row-${i}-padding-${'p'.repeat(64)}-${i}`;
                stmt.run(s);
            }
            stmt.finalize(function () {
                db.all(
                    'SELECT txt_col FROM types ORDER BY id',
                    function (err, rows) {
                        assert.ifError(err);
                        assert.strictEqual(rows.length, N);
                        for (let i = 0; i < N; i++) {
                            const expected =
                                'row-' +
                                i +
                                '-padding-' +
                                'p'.repeat(64) +
                                '-' +
                                i;
                            assert.strictEqual(
                                rows[i].txt_col,
                                expected,
                                `mismatch at ${i}`,
                            );
                        }
                        done();
                    },
                );
            });
        });

        it('keeps queued blob params intact', function (_t, done) {
            const N = 100;
            const stmt = db.prepare('INSERT INTO types (blob_col) VALUES (?)');
            const blobs = [];
            for (let i = 0; i < N; i++) {
                const b = randomBytes(32);
                b[0] = i;
                blobs.push(b);
                stmt.run(b);
            }
            stmt.finalize(function () {
                db.all(
                    'SELECT blob_col FROM types ORDER BY id',
                    function (err, rows) {
                        assert.ifError(err);
                        assert.strictEqual(rows.length, N);
                        rows.forEach(function (row, i) {
                            assert.ok(
                                blobs[i].equals(row.blob_col),
                                `blob mismatch at ${i}`,
                            );
                        });
                        done();
                    },
                );
            });
        });

        it('keeps params intact when interleaving statements', function (_t, done) {
            const stmtA = db.prepare('INSERT INTO types (txt_col) VALUES (?)');
            const stmtB = db.prepare('INSERT INTO types (int_col) VALUES (?)');
            for (let i = 0; i < 50; i++) {
                stmtA.run(`text-${i}-${'z'.repeat(100)}`);
                stmtB.run(i * 3);
            }
            stmtA.finalize(function () {
                stmtB.finalize(function () {
                    db.all(
                        'SELECT txt_col, int_col FROM types ORDER BY id',
                        function (err, rows) {
                            assert.ifError(err);
                            assert.strictEqual(rows.length, 100);
                            // Cross-statement ordering is unspecified, but each
                            // statement's queued params must stay in FIFO order.
                            const texts = rows
                                .filter((r) => r.txt_col !== null)
                                .map((r) => r.txt_col);
                            const ints = rows
                                .filter((r) => r.int_col !== null)
                                .map((r) => r.int_col);
                            assert.strictEqual(texts.length, 50);
                            assert.strictEqual(ints.length, 50);
                            texts.forEach(function (txt, i) {
                                assert.strictEqual(
                                    txt,
                                    `text-${i}-${'z'.repeat(100)}`,
                                    `text FIFO broken at ${i}`,
                                );
                            });
                            ints.forEach(function (v, i) {
                                assert.strictEqual(
                                    v,
                                    i * 3,
                                    `int FIFO broken at ${i}`,
                                );
                            });
                            done();
                        },
                    );
                });
            });
        });
    });

    describe('lastID and changes', function () {
        beforeEach(function (_t, done) {
            db.exec('DELETE FROM types', done);
        });

        it('tracks lastID/changes across reused statement runs', function (_t, done) {
            const stmt = db.prepare('INSERT INTO types (int_col) VALUES (?)');
            const insertNext = function (i, lastId) {
                if (i === 3) return update();
                stmt.run(i, function (err) {
                    assert.ifError(err);
                    assert.strictEqual(this.changes, 1);
                    assert.strictEqual(this.lastID, lastId + 1);
                    insertNext(i + 1, lastId + 1);
                });
            };
            const update = function () {
                stmt.finalize(function () {
                    db.run(
                        'UPDATE types SET int_col = int_col + 100',
                        function (err) {
                            assert.ifError(err);
                            assert.strictEqual(this.changes, 3);
                            done();
                        },
                    );
                });
            };
            insertNext(0, 0);
        });

        it('reports explicit rowid in lastID', function (_t, done) {
            db.run(
                'INSERT INTO types (rowid, int_col) VALUES (12345, 1)',
                function (err) {
                    assert.ifError(err);
                    assert.strictEqual(this.lastID, 12345);
                    done();
                },
            );
        });
    });

    describe('each() streaming semantics', function () {
        beforeEach(function (_t, done) {
            db.exec('DELETE FROM types', done);
        });

        it('delivers rows in order', function (_t, done) {
            const N = 500;
            const stmt = db.prepare('INSERT INTO types (int_col) VALUES (?)');
            for (let i = 0; i < N; i++) stmt.run(i);
            stmt.finalize(function () {
                let expected = 0;
                db.each(
                    'SELECT int_col FROM types ORDER BY id',
                    function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.int_col, expected++);
                    },
                    function (err, count) {
                        assert.ifError(err);
                        assert.strictEqual(count, N);
                        assert.strictEqual(expected, N);
                        done();
                    },
                );
            });
        });

        it('fires complete with 0 for empty result', function (_t, done) {
            db.each(
                'SELECT int_col FROM types',
                function (_err) {
                    throw new Error('item must not be called');
                },
                function (err, count) {
                    assert.ifError(err);
                    assert.strictEqual(count, 0);
                    done();
                },
            );
        });

        it('supports concurrent each() on separate statements', function (_t, done) {
            const N = 400;
            const stmt = db.prepare('INSERT INTO types (txt_col) VALUES (?)');
            for (let i = 0; i < N; i++) stmt.run(`v${i}`);
            stmt.finalize(function () {
                let remaining = 2;
                const maybeDone = function () {
                    if (remaining === 0) done();
                };
                const runEach = function (_order, cb) {
                    let count = 0;
                    db.each(
                        'SELECT rowid, txt_col FROM types ORDER BY rowid',
                        function (err, row) {
                            assert.ifError(err);
                            assert.strictEqual(row.txt_col, `v${count}`);
                            count++;
                        },
                        function (err, total) {
                            assert.ifError(err);
                            assert.strictEqual(total, N);
                            assert.strictEqual(count, N);
                            remaining--;
                            cb();
                        },
                    );
                };
                runEach(1, maybeDone);
                runEach(2, maybeDone);
            });
        });
    });

    describe('statement reuse via get()', function () {
        beforeEach(function (_t, done) {
            db.exec('DELETE FROM types', done);
        });

        it('re-steps bound values without rebinding (SQLITE_STATIC lifetime)', function (_t, done) {
            const stmt = db.prepare(
                'SELECT ? AS v FROM (SELECT 1 UNION SELECT 2 UNION SELECT 3)',
            );
            stmt.get(`sticky-value-${'x'.repeat(200)}`, function (err, row) {
                assert.ifError(err);
                assert.strictEqual(row.v, `sticky-value-${'x'.repeat(200)}`);
                // Two unbound gets: sqlite re-steps and must still see the
                // previously bound text intact (payload kept alive).
                stmt.get(function (err, row) {
                    assert.ifError(err);
                    assert.strictEqual(
                        row.v,
                        `sticky-value-${'x'.repeat(200)}`,
                    );
                    stmt.get(function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(
                            row.v,
                            `sticky-value-${'x'.repeat(200)}`,
                        );
                        stmt.finalize(done);
                    });
                });
            });
        });

        it('rebinds varying strings repeatedly without corruption', function (_t, done) {
            const stmt = db.prepare('SELECT ? AS v');
            const vals = [];
            for (let i = 0; i < 30; i++)
                vals.push(`v${i}-${'y'.repeat(50 + i * 37)}`);
            let i = 0;
            const next = function () {
                if (i === vals.length) return stmt.finalize(done);
                stmt.get(vals[i], function (err, row) {
                    assert.ifError(err);
                    assert.strictEqual(row.v, vals[i]);
                    i++;
                    next();
                });
            };
            next();
        });

        it('advances one row per unbound get() and stops', function (_t, done) {
            const stmt = db.prepare('SELECT int_col FROM types ORDER BY id');
            const insertAndConsume = function () {
                const ins = db.prepare(
                    'INSERT INTO types (int_col) VALUES (?)',
                );
                ins.run(10);
                ins.run(20);
                ins.run(30);
                ins.finalize(function () {
                    stmt.get(function (err, row) {
                        assert.ifError(err);
                        assert.strictEqual(row.int_col, 10);
                        stmt.get(function (err, row) {
                            assert.ifError(err);
                            assert.strictEqual(row.int_col, 20);
                            stmt.get(function (err, row) {
                                assert.ifError(err);
                                assert.strictEqual(row.int_col, 30);
                                stmt.get(function (err, row) {
                                    assert.ifError(err);
                                    assert.strictEqual(row, undefined);
                                    stmt.finalize(done);
                                });
                            });
                        });
                    });
                });
            };
            insertAndConsume();
        });
    });
});
