import sqlite3 from '../lib/sqlite3.js';
import assert from 'assert';
import { ensureExists, deleteFile } from './support/helper.js';

describe('cache', function() {
    before(function() {
        ensureExists('test/tmp');
    });

    it('should cache Database objects while opening', function(done) {
        let filename = 'test/tmp/test_cache.db';
        deleteFile(filename);
        let opened1 = false, opened2 = false;
        let db1 = new sqlite3.cached.Database(filename, function(err) {
            if (err) throw err;
            opened1 = true;
            if (opened1 && opened2) done();
        });
        let db2 = new sqlite3.cached.Database(filename, function(err) {
            if (err) throw err;
            opened2 = true;
            if (opened1 && opened2) done();
        });
        assert.equal(db1, db2);
    });

    it('should cache Database objects after they are open', function(done) {
        let filename = 'test/tmp/test_cache2.db';
        deleteFile(filename);
        let db1, db2;
        db1 = new sqlite3.cached.Database(filename, function(err) {
            if (err) throw err;
            process.nextTick(function() {
                db2 = new sqlite3.cached.Database(filename, function(err) {
                    done();

                });
                assert.equal(db1, db2);
            });
        });
    });
});