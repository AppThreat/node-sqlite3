import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('rerunning statements', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:', done);
    });

    const count = 10;
    let inserted = 0;
    let retrieved = 0;

    it('should create the table', function (_t, done) {
        db.run('CREATE TABLE foo (id int)', done);
    });

    it('should insert repeatedly, reusing the same statement', function (_t, done) {
        const stmt = db.prepare('INSERT INTO foo VALUES(?)');
        for (let i = 5; i < count; i++) {
            stmt.run(i, function (err) {
                if (err) throw err;
                inserted++;
            });
        }
        stmt.finalize(done);
    });

    it('should retrieve repeatedly, resuing the same statement', function (_t, done) {
        const collected = [];
        const stmt = db.prepare('SELECT id FROM foo WHERE id = ?');
        for (let i = 0; i < count; i++) {
            stmt.get(i, function (err, row) {
                if (err) throw err;
                if (row) collected.push(row);
            });
        }
        stmt.finalize(function (err) {
            if (err) throw err;
            retrieved += collected.length;
            assert.deepEqual(collected, [
                { id: 5 },
                { id: 6 },
                { id: 7 },
                { id: 8 },
                { id: 9 },
            ]);
            done();
        });
    });

    it('should have inserted and retrieved the right amount', function () {
        assert.equal(inserted, 5);
        assert.equal(retrieved, 5);
    });

    after(function (_t, done) {
        db.close(done);
    });
});
