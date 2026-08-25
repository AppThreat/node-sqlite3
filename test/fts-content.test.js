import { before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('fts', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:', done);
    });

    it('should create a new fts4 table', function (_t, done) {
        db.exec(
            'CREATE VIRTUAL TABLE t1 USING fts4(content="", a, b, c);',
            done,
        );
    });
});
