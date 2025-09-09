import sqlite3 from '../lib/sqlite3.js';
import { Buffer } from 'buffer';

describe('buffer', function() {
    let db;

    it('should insert blobs', function(done) {
        db = new sqlite3.Database(':memory:');
        db.serialize(function () {

            db.run("CREATE TABLE lorem (info BLOB)");
            let stmt = db.prepare("INSERT INTO lorem VALUES (?)");

            stmt.on('error', function (err) {
                throw err;
            });

            let buff = Buffer.alloc(2);
            stmt.run(buff);
            stmt.finalize();
        });

        db.close(done);

    });
});