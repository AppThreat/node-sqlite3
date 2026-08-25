import assert from 'node:assert';
import { before, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('data types', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:');
        db.run('CREATE TABLE txt_table (txt TEXT)');
        db.run('CREATE TABLE int_table (int INTEGER)');
        db.run('CREATE TABLE flt_table (flt FLOAT)');
        db.wait(done);
    });

    beforeEach(function (_t, done) {
        db.exec(
            'DELETE FROM txt_table; DELETE FROM int_table; DELETE FROM flt_table;',
            done,
        );
    });

    it('should serialize Date()', function (_t, done) {
        const date = new Date();
        db.run('INSERT INTO int_table VALUES(?)', date, function (err) {
            if (err) throw err;
            db.get('SELECT int FROM int_table', function (err, row) {
                if (err) throw err;
                assert.equal(row.int, +date);
                done();
            });
        });
    });

    it('should serialize RegExp()', function (_t, done) {
        const regexp = /^f\noo/;
        db.run('INSERT INTO txt_table VALUES(?)', regexp, function (err) {
            if (err) throw err;
            db.get('SELECT txt FROM txt_table', function (err, row) {
                if (err) throw err;
                assert.equal(row.txt, String(regexp));
                done();
            });
        });
    });

    [
        4294967296.249,
        Math.PI,
        3924729304762836.5,
        Date.now(),
        912667.394828365,
        2.3948728634826374e83,
        9.293476892934982e300,
        Number.POSITIVE_INFINITY,
        -9.293476892934982e300,
        -2.3948728634826374e83,
        Number.NEGATIVE_INFINITY,
    ].forEach(function (flt) {
        it(`should serialize float ${flt}`, function (_t, done) {
            db.run('INSERT INTO flt_table VALUES(?)', flt, function (err) {
                if (err) throw err;
                db.get('SELECT flt FROM flt_table', function (err, row) {
                    if (err) throw err;
                    assert.equal(row.flt, flt);
                    done();
                });
            });
        });
    });

    [
        4294967299,
        3924729304762836,
        Date.now(),
        2.3948728634826374e83,
        9.293476892934982e300,
        Number.POSITIVE_INFINITY,
        -9.293476892934982e300,
        -2.3948728634826374e83,
        Number.NEGATIVE_INFINITY,
    ].forEach(function (integer) {
        it(`should serialize integer ${integer}`, function (_t, done) {
            db.run('INSERT INTO int_table VALUES(?)', integer, function (err) {
                if (err) throw err;
                db.get(
                    'SELECT int AS integer FROM int_table',
                    function (err, row) {
                        if (err) throw err;
                        assert.equal(row.integer, integer);
                        done();
                    },
                );
            });
        });
    });

    it('should reject faulty toString', function (_t, done) {
        const faulty = { toString: 23 };
        // v8 bound this as "[object Object]"; v9 rejects non-serialisable
        // objects. As a direct argument the object is a named-parameter
        // map, so the unknown-parameter error reaches the callback.
        db.run('INSERT INTO txt_table VALUES(?)', faulty, function (err) {
            assert.notEqual(err, undefined);
            assert.strictEqual(err.code, 'SQLITE_RANGE');
            done();
        });
    });

    it('should reject faulty toString in array', function () {
        const faulty = [[{ toString: null }], 1];
        // v8 bound the inner object as "[object Object]"; v9 throws a
        // TypeError synchronously, naming the parameter index.
        assert.throws(
            function () {
                db.all('SELECT * FROM txt_table WHERE txt = ? LIMIT ?', faulty);
            },
            function (err) {
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /Cannot bind parameter 1/);
                return true;
            },
        );
    });

    it('should reject faulty toString set to function', function () {
        const faulty = [
            [
                {
                    toString: function () {
                        console.log('oh no');
                    },
                },
            ],
            1,
        ];
        assert.throws(
            function () {
                db.all('SELECT * FROM txt_table WHERE txt = ? LIMIT ?', faulty);
            },
            function (err) {
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /Cannot bind parameter 1/);
                return true;
            },
        );
    });
});
