import assert from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';
import { bindPaths } from './support/bindpaths.js';
import { corpus } from './support/corpus.js';

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

        it('rejects plain objects in arrays instead of coercing them', function (_t, done) {
            // v8 bound these as the literal string "[object Object]".
            assert.throws(
                function () {
                    db.run('INSERT INTO types (txt_col) VALUES (?)', [
                        { a: 1 },
                    ]);
                },
                function (err) {
                    assert.ok(err instanceof TypeError);
                    assert.match(err.message, /Cannot bind parameter 1/);
                    assert.match(err.message, /unsupported type Object/);
                    return true;
                },
            );
            db.get('SELECT txt_col FROM types', function (err, row) {
                assert.ifError(err);
                assert.strictEqual(row, undefined);
                done();
            });
        });

        it('treats direct plain objects as named-parameter maps (unknown parameter)', function (_t, done) {
            db.run(
                'INSERT INTO types (txt_col) VALUES (?)',
                { a: 1 },
                function (err) {
                    assert.ok(err);
                    // v8 surfaced this as a bare SQLITE_RANGE from
                    // sqlite3_bind_text; v9 names the offending parameter.
                    assert.strictEqual(err.code, 'SQLITE_RANGE');
                    assert.match(err.message, /unknown named parameter "a"/);
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

// ---------------------------------------------------------------------------
// Deliverable 02: corpus round-trip property test.
//
// For every corpus value and every integer mode, each query path must
// produce either the exact round-tripped value or an error — never a
// silently wrong value. The async (Work_*) and sync (*Sync) marshalling
// paths are separate native code and are exercised side by side on
// purpose.

/** Exact bytes a blob-ish corpus value must round-trip as. */
function expectedBytes(value) {
    assert.ok(
        ArrayBuffer.isView(value) || value instanceof ArrayBuffer,
        'expectedBytes only accepts blob-ish values',
    );
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        return Buffer.from(value);
    }
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * The value the given corpus entry must read back as in the given
 * integer mode: `{ value }`, `{ rangeError: true }` (the deliberate
 * 'number'-mode throw), or `{ nullValue: true }`.
 */
function expectedRead(entry, mode) {
    switch (entry.sqliteType) {
        case 'INTEGER': {
            let stored;
            if (typeof entry.value === 'bigint') {
                stored = entry.value;
            } else if (typeof entry.value === 'boolean') {
                stored = entry.value ? 1n : 0n;
            } else if (Object.is(entry.value, -0)) {
                stored = 0n;
            } else {
                // Numbers: whatever int64 the bind produced. The double
                // 2**63 is the rounded form of 2**63-1 and clamps to
                // INT64_MAX rather than wrapping.
                const d = Math.trunc(entry.value);
                stored = d >= 2 ** 63 ? 9223372036854775807n : BigInt(d);
            }
            const safe = stored >= -(2n ** 53n) + 1n && stored < 2n ** 53n;
            if (mode === 'bigint') return { value: stored };
            if (safe) return { value: Number(stored) };
            if (mode === 'mixed') return { value: stored };
            return { rangeError: true };
        }
        case 'REAL': {
            const v = entry.value instanceof Date ? +entry.value : entry.value;
            return { value: v, float: true };
        }
        case 'NULL':
            return { nullValue: true };
        case 'TEXT': {
            if (entry.value instanceof RegExp)
                return { value: String(entry.value) };
            // Lone surrogates cannot survive the UTF-8 boundary: the JS
            // engine replaces them with U+FFFD on the way in. Pinned here
            // so a future WTF-8 round-trip fix must change this test
            // consciously.
            const replaced = entry.value
                .replace(/\uD800/g, '\uFFFD')
                .replace(/\uDC00/g, '\uFFFD');
            return { value: replaced };
        }
        case 'BLOB':
            return { bytes: expectedBytes(entry.value) };
        default:
            throw new Error(`unhandled sqliteType ${entry.sqliteType}`);
    }
}

describe('corpus round-trip (Deliverable 02)', function () {
    for (const mode of ['number', 'bigint', 'mixed']) {
        describe(`integer mode '${mode}'`, function () {
            it('configures and reports the mode', async function () {
                const db = new sqlite3.Database(':memory:');
                await new Promise((resolve) => db.exec('SELECT 1', resolve));
                try {
                    db.configure('integerMode', mode);
                    assert.strictEqual(db.integerMode, mode);
                } finally {
                    await new Promise((resolve) => db.close(resolve));
                }
            });

            for (const entry of corpus) {
                it(`round-trips ${entry.label}`, async function () {
                    const db = new sqlite3.Database(':memory:');
                    try {
                        await new Promise((resolve) =>
                            db.exec('SELECT 1', resolve),
                        );
                        db.configure('integerMode', mode);

                        const paths = bindPaths(db);
                        assert.strictEqual(paths.length, 15);

                        for (const path of paths) {
                            const outcome = await path.run(entry.value);

                            if (entry.rejected) {
                                // Bind-side rejection: every path either
                                // throws synchronously or reports err —
                                // never a wrong value. (Array form, so a
                                // plain object is a value, not a param map.)
                                const rejection =
                                    entry.rejection === 'RangeError'
                                        ? RangeError
                                        : TypeError;
                                if (outcome.threw) {
                                    assert.ok(
                                        outcome.threw instanceof rejection,
                                        `${path.name}: expected ${rejection.name}, got ${outcome.threw}`,
                                    );
                                    assert.match(
                                        outcome.threw.message,
                                        /Cannot bind parameter 1/,
                                        `${path.name}: error must name the parameter`,
                                    );
                                } else {
                                    assert.ok(
                                        outcome.err,
                                        `${path.name}: expected an error for rejected value`,
                                    );
                                }
                                continue;
                            }

                            const expect = expectedRead(entry, mode);

                            if (expect.rangeError) {
                                if (!path.reads) {
                                    // Bind-only paths (run) never convert
                                    // row values: success is correct.
                                    assert.ok(
                                        !outcome.threw && !outcome.err,
                                        `${path.name}: unexpected ${outcome.threw || outcome.err}`,
                                    );
                                    continue;
                                }
                                // 'number' mode and an unsafe int64: an
                                // error, never a truncated double.
                                const err = outcome.threw || outcome.err;
                                assert.ok(
                                    err instanceof RangeError,
                                    `${path.name}: expected RangeError, got ${
                                        JSON.stringify(
                                            outcome.err?.message ??
                                                outcome.threw?.message,
                                        ) ?? 'no error'
                                    }`,
                                );
                                continue;
                            }

                            assert.ok(
                                !outcome.threw && !outcome.err,
                                `${path.name}: unexpected ${outcome.threw || outcome.err}`,
                            );
                            if (!path.reads) continue;

                            if (outcome.stringified) {
                                // db.map reports the value as the
                                // stringified result key.
                                if (entry.sqliteType === 'BLOB') continue;
                                const expectStr = expect.nullValue
                                    ? 'null'
                                    : String(expect.value);
                                assert.strictEqual(
                                    outcome.v,
                                    expectStr,
                                    `${path.name}: expected key ${expectStr}`,
                                );
                                continue;
                            }

                            if (expect.nullValue) {
                                assert.strictEqual(
                                    outcome.v,
                                    null,
                                    `${path.name}: expected NULL`,
                                );
                            } else if (expect.bytes) {
                                assert.ok(
                                    Buffer.isBuffer(outcome.v),
                                    `${path.name}: expected a Buffer`,
                                );
                                assert.ok(
                                    expect.bytes.equals(outcome.v),
                                    `${path.name}: blob bytes differ`,
                                );
                            } else if (expect.float) {
                                assert.ok(
                                    Object.is(outcome.v, expect.value),
                                    `${path.name}: expected ${expect.value}, got ${outcome.v}`,
                                );
                            } else {
                                assert.ok(
                                    Object.is(outcome.v, expect.value),
                                    `${path.name}: expected ${String(
                                        expect.value,
                                    )}, got ${String(outcome.v)}`,
                                );
                            }
                        }
                    } finally {
                        await new Promise((resolve) => db.close(resolve));
                    }
                });
            }
        });
    }

    describe('storage classes', function () {
        it('stores every bindable corpus value with its declared type', async function () {
            const db = new sqlite3.Database(':memory:');
            try {
                await new Promise((resolve) =>
                    db.exec('CREATE TABLE t (v)', resolve),
                );
                const bindable = corpus.filter((e) => !e.rejected);
                for (const entry of bindable) {
                    if (entry.sqliteType === 'NULL') continue; // typeof() of a NULL cell is 'null'
                    db.runSync('INSERT INTO t (v) VALUES (?)', [entry.value]);
                    const row = db.getSync(
                        'SELECT typeof(v) AS ty FROM t WHERE rowid = last_insert_rowid()',
                    );
                    assert.strictEqual(
                        row.ty,
                        entry.sqliteType.toLowerCase(),
                        `${entry.label}: stored as ${row.ty}`,
                    );
                    db.runSync('DELETE FROM t');
                }
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('binds 2**40 as a 64-bit INTEGER, not a REAL', async function () {
            // The v8 bug: the Int32 round-trip classified anything above
            // int32 as a float, so WHERE-matches on typed columns broke.
            const db = new sqlite3.Database(':memory:');
            try {
                await new Promise((resolve) =>
                    db.exec('CREATE TABLE t (a INTEGER STRICT)', resolve),
                );
                db.runSync('INSERT INTO t VALUES (?)', [2 ** 40]);
                const row = db.getSync('SELECT typeof(a) AS ty, a FROM t');
                assert.strictEqual(row.ty, 'integer');
                assert.strictEqual(row.a, 2 ** 40);
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });

    describe('parameter arity', function () {
        it('rejects too few parameters on every path', async function () {
            const db = new sqlite3.Database(':memory:');
            try {
                await new Promise((resolve) => db.exec('SELECT 1', resolve));
                const paths = bindPaths(db);
                for (const path of paths) {
                    const out = await new Promise((resolve) => {
                        if (path.name.includes('Sync')) {
                            try {
                                if (path.name === 'db.getSync') {
                                    db.getSync('SELECT ? AS a, ? AS b', [1]);
                                } else if (path.name === 'db.allSync') {
                                    db.allSync('SELECT ? AS a, ? AS b', [1]);
                                } else if (path.name === 'db.runSync') {
                                    db.runSync('SELECT ? AS a, ? AS b', [1]);
                                } else if (path.name === 'stmt.getSync') {
                                    db.prepareSync(
                                        'SELECT ? AS a, ? AS b',
                                    ).getSync([1]);
                                } else if (path.name === 'stmt.allSync') {
                                    db.prepareSync(
                                        'SELECT ? AS a, ? AS b',
                                    ).allSync([1]);
                                } else {
                                    db.prepareSync(
                                        'SELECT ? AS a, ? AS b',
                                    ).runSync([1]);
                                }
                                resolve({});
                            } catch (err) {
                                resolve({ threw: err });
                            }
                        } else {
                            db.get('SELECT ? AS a, ? AS b', [1], (err) =>
                                resolve({ err }),
                            );
                        }
                    });
                    const err = out.threw || out.err;
                    assert.ok(err, `${path.name}: expected an arity error`);
                    assert.strictEqual(err.code, 'SQLITE_RANGE');
                    assert.match(
                        err.message,
                        /supplied 1 parameter\(s\) but the statement takes 2/,
                        `${path.name}`,
                    );
                }
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('rejects too many parameters', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.throws(
                    () => db.getSync('SELECT ? AS a', 1, 2),
                    /supplied 2 parameter\(s\) but the statement takes 1/,
                );
                const err = await new Promise((resolve) =>
                    db.get('SELECT ? AS a', [1, 2], (e) => resolve(e)),
                );
                assert.strictEqual(err.code, 'SQLITE_RANGE');
                assert.match(err.message, /supplied 2 parameter\(s\)/);
                assert.throws(
                    () => db.prepareSync('SELECT ? AS a').getSync(1, 2),
                    /supplied 2 parameter\(s\) but the statement takes 1/,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('rejects an empty bind argument for a parameterised statement', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.throws(
                    () => db.getSync('SELECT ? AS a', []),
                    /supplied 0 parameter\(s\) but the statement takes 1/,
                );
                const err = await new Promise((resolve) =>
                    db.get('SELECT ? AS a', {}, (e) => resolve(e)),
                );
                assert.match(
                    err.message,
                    /supplied 0 parameter\(s\) but the statement takes 1/,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('keeps the historical accidental-undefined shape for parameterless SQL', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (a)', resolve),
            );
            try {
                db.runSync('INSERT INTO t VALUES (1)', undefined);
                const row = db.getSync('SELECT COUNT(*) AS n FROM t');
                assert.strictEqual(row.n, 1);
                const err = await new Promise((resolve) =>
                    db.run('INSERT INTO t VALUES (2)', undefined, (e) =>
                        resolve(e),
                    ),
                );
                assert.ifError(err);
                assert.strictEqual(
                    db.getSync('SELECT COUNT(*) AS n FROM t').n,
                    2,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('rejects a named parameter absent from the SQL', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.throws(
                    () => db.getSync('SELECT $a AS v', { $b: 1 }),
                    /unknown named parameter "\$b"/,
                );
                const err = await new Promise((resolve) =>
                    db.get('SELECT $a AS v', { $b: 1 }, (e) => resolve(e)),
                );
                assert.strictEqual(err.code, 'SQLITE_RANGE');
                assert.match(err.message, /unknown named parameter "\$b"/);
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('rejects extra named keys (typos) via the arity check', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                const err = await new Promise((resolve) =>
                    db.get('SELECT $a AS v', { $a: 1, $typo: 2 }, (e) =>
                        resolve(e),
                    ),
                );
                assert.strictEqual(err.code, 'SQLITE_RANGE');
                assert.match(err.message, /supplied 2 parameter\(s\)/);
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });

    describe('typed-array blob acceptance', function () {
        it('honours byteOffset on a Uint8Array (the naive .Data() read is off by the offset)', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (b)', resolve),
            );
            try {
                // Exact-size ArrayBuffer: Buffer pooling would give
                // backing.buffer a non-zero offset of its own.
                const backing = new Uint8Array(16).fill(0xee);
                backing.fill(0xab, 4, 12); // the 8 visible bytes
                const view = new Uint8Array(backing.buffer, 4, 8);
                db.runSync('INSERT INTO t VALUES (?)', [view]);
                const read = db.getSync('SELECT b FROM t').b;
                assert.ok(Buffer.isBuffer(read));
                assert.strictEqual(read.length, 8);
                assert.ok(read.equals(Buffer.alloc(8, 0xab)));
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('honours byteOffset on a DataView', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (b)', resolve),
            );
            try {
                const backing = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
                const view = new DataView(backing.buffer, 2, 4);
                db.runSync('INSERT INTO t VALUES (?)', [view]);
                const read = db.getSync('SELECT b FROM t').b;
                assert.ok(read.equals(Buffer.from([2, 3, 4, 5])));
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('binds Uint8Array views over SharedArrayBuffer', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (b)', resolve),
            );
            try {
                const sab = new SharedArrayBuffer(4);
                const view = new Uint8Array(sab);
                view.set([0xde, 0xad, 0xbe, 0xef]);
                db.runSync('INSERT INTO t VALUES (?)', [view]);
                assert.ok(
                    db
                        .getSync('SELECT b FROM t')
                        .b.equals(Buffer.from([0xde, 0xad, 0xbe, 0xef])),
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });

    describe('blob boundary sizes and lifetime', function () {
        for (const size of [4095, 4096, 4097]) {
            it(`round-trips a ${size}-byte blob and keeps the returned buffer valid after finalize`, async function () {
                const db = new sqlite3.Database(':memory:');
                await new Promise((resolve) =>
                    db.exec('CREATE TABLE t (b)', resolve),
                );
                try {
                    // 4096 is the external-buffer threshold in RowToJS:
                    // sizes on both sides and exactly on it must behave
                    // identically.
                    const src = Buffer.alloc(size);
                    for (let i = 0; i < size; i++) src[i] = (i * 251) % 256;
                    db.runSync('INSERT INTO t VALUES (?)', [src]);

                    const stmt = db.prepareSync('SELECT b FROM t');
                    const read = stmt.getSync().b;
                    stmt.finalize();

                    // The payload of an external buffer is owned by the
                    // buffer itself: it must outlive the statement.
                    assert.ok(Buffer.isBuffer(read));
                    assert.strictEqual(read.length, size);
                    assert.ok(src.equals(read));
                    read[0] = (read[0] + 1) % 256; // still writable
                } finally {
                    await new Promise((resolve) => db.close(resolve));
                }
            });
        }
    });

    describe('unsupported types never coerce', function () {
        it('no row ever contains the string "[object Object]"', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) =>
                db.exec('CREATE TABLE t (v TEXT)', resolve),
            );
            try {
                for (const v of [{ a: 1 }, [1, 2], new Map()]) {
                    assert.throws(
                        () => db.runSync('INSERT INTO t VALUES (?)', [v]),
                        TypeError,
                    );
                }
                assert.strictEqual(
                    db.getSync('SELECT COUNT(*) AS n FROM t').n,
                    0,
                );
                // And nothing matched the old coercion, either.
                assert.strictEqual(
                    db.getSync(
                        "SELECT COUNT(*) AS n FROM t WHERE v = '[object Object]'",
                    ).n,
                    0,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('error names the parameter index and the constructor', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.throws(
                    () => db.runSync('SELECT ? AS a, ? AS b', [1, new Map()]),
                    /Cannot bind parameter 2: unsupported type Map/,
                );
                class Gadget {}
                assert.throws(
                    () => db.runSync('SELECT ? AS a', [new Gadget()]),
                    /Cannot bind parameter 1: unsupported type Gadget/,
                );
                assert.throws(
                    () => db.runSync('SELECT ? AS a', [Symbol('s')]),
                    /Cannot bind parameter 1: unsupported type Symbol/,
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });

        it('BigInt outside int64 throws RangeError with the digits', async function () {
            const db = new sqlite3.Database(':memory:');
            await new Promise((resolve) => db.exec('SELECT 1', resolve));
            try {
                assert.throws(
                    () => db.runSync('SELECT ? AS a', [2n ** 63n]),
                    (err) =>
                        err instanceof RangeError &&
                        /BigInt 9223372036854775808/.test(err.message),
                );
                assert.throws(
                    () => db.runSync('SELECT ? AS a', [-(2n ** 63n) - 1n]),
                    (err) =>
                        err instanceof RangeError &&
                        /BigInt -9223372036854775809/.test(err.message),
                );
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        });
    });
});
