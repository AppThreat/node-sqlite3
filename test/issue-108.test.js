import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('buffer', function () {
    let db;

    it('should insert blobs', function (_t, done) {
        db = new sqlite3.Database(':memory:');
        db.serialize(function () {
            db.run('CREATE TABLE lorem (info BLOB)');
            const stmt = db.prepare('INSERT INTO lorem VALUES (?)');

            stmt.on('error', function (err) {
                throw err;
            });

            const buff = Buffer.alloc(2);
            stmt.run(buff);
            stmt.finalize();
        });

        db.close(done);
    });
});
