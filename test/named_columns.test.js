import assert from 'node:assert';
import { before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('named columns', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:', done);
    });

    it('should create the table', function (_t, done) {
        db.run('CREATE TABLE foo (txt TEXT, num INT)', done);
    });

    it('should insert a value', function (_t, done) {
        db.run(
            'INSERT INTO foo VALUES($text, $id)',
            {
                $id: 1,
                $text: 'Lorem Ipsum',
            },
            done,
        );
    });

    it('should retrieve the values', function (_t, done) {
        db.get('SELECT txt, num FROM foo ORDER BY num', function (err, row) {
            if (err) throw err;
            assert.equal(row.txt, 'Lorem Ipsum');
            assert.equal(row.num, 1);
            done();
        });
    });

    it('should be able to retrieve rowid of last inserted value', function (_t, done) {
        db.get(
            'SELECT last_insert_rowid() as last_id FROM foo',
            function (err, row) {
                if (err) throw err;
                assert.equal(row.last_id, 1);
                done();
            },
        );
    });
});
