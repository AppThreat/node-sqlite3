import sqlite3 from '../lib/sqlite3.js';
import assert from 'assert';

describe('tracing', function() {
    it('Database tracing', function(done) {
        let db = new sqlite3.Database(':memory:');
        let create = false;
        let select = false;

        db.on('trace', function(sql) {
            if (sql.match(/^SELECT/)) {
                assert.ok(!select);
                assert.equal(sql, "SELECT * FROM foo");
                select = true;
            }
            else if (sql.match(/^CREATE/)) {
                assert.ok(!create);
                assert.equal(sql, "CREATE TABLE foo (id int)");
                create = true;
            }
            else {
                assert.ok(false);
            }
        });

        db.serialize(function() {
            db.run("CREATE TABLE foo (id int)");
            db.run("SELECT * FROM foo");
        });

        db.close(function(err) {
            if (err) throw err;
            assert.ok(create);
            assert.ok(select);
            done();
        });
    });


    it('test disabling tracing #1', function(done) {
        let db = new sqlite3.Database(':memory:');

        db.on('trace', function(sql) {});
        db.removeAllListeners('trace');
        db._events['trace'] = function(sql) {
            assert.ok(false);
        };

        db.run("CREATE TABLE foo (id int)");
        db.close(done);
    });


    it('test disabling tracing #2', function(done) {
        let db = new sqlite3.Database(':memory:');

        let trace = function(sql) {};
        db.on('trace', trace);
        db.removeListener('trace', trace);
        db._events['trace'] = function(sql) {
            assert.ok(false);
        };

        db.run("CREATE TABLE foo (id int)");
        db.close(done);
    });
});