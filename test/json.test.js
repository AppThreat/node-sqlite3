import { before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

if (process.env.NODE_SQLITE3_JSON1 === 'no') {
    describe('json', function () {
        it('skips JSON tests when --sqlite=/usr (or similar) is tested', function () {
            /* intentionally empty: the real JSON tests are the else branch */
        });
    });
} else {
    describe('json', function () {
        let db;

        before(function (_t, done) {
            db = new sqlite3.Database(':memory:', done);
        });

        it('should select JSON', function (_t, done) {
            db.run('SELECT json(?)', JSON.stringify({ ok: true }), done);
        });
    });
}
