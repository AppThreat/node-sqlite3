import assert from 'node:assert';
import { before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('query properties', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:');
        db.run('CREATE TABLE foo (id INT, txt TEXT)', done);
    });

    it('should return the correct lastID', function (_t, done) {
        const stmt = db.prepare('INSERT INTO foo VALUES(?, ?)');
        let j = 1;
        for (let i = 0; i < 5000; i++) {
            stmt.run(i, 'demo', function (err) {
                if (err) throw err;
                // Relies on SQLite's row numbering to be gapless and starting
                // from 1.
                assert.equal(j++, this.lastID);
            });
        }
        db.wait(done);
    });

    it('should return the correct changes count', function (_t, done) {
        db.run('UPDATE foo SET id = id + 1 WHERE id % 2 = 0', function (err) {
            if (err) throw err;
            assert.equal(2500, this.changes);
            done();
        });
    });
});
