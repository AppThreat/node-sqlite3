import sqlite3 from '../lib/sqlite3.js';
import assert from 'assert';


describe('serialize() and parallelize()', function() {
    let db;
    before(function(done) { db = new sqlite3.Database(':memory:', done); });

    let inserted1 = 0;
    let inserted2 = 0;
    let retrieved = 0;

    let count = 1000;

    it('should toggle', function(done) {
        db.serialize();
        db.run("CREATE TABLE foo (txt text, num int, flt float, blb blob)");
        db.parallelize(done);
    });

    it('should insert rows', function() {
        let stmt1 = db.prepare("INSERT INTO foo VALUES(?, ?, ?, ?)");
        let stmt2 = db.prepare("INSERT INTO foo VALUES(?, ?, ?, ?)");
        for (let i = 0; i < count; i++) {
            // Interleaved inserts with two statements.
            stmt1.run('String ' + i, i, i * Math.PI, function(err) {
                if (err) throw err;
                inserted1++;
            });
            i++;
            stmt2.run('String ' + i, i, i * Math.PI, function(err) {
                if (err) throw err;
                inserted2++;
            });
        }
        stmt1.finalize();
        stmt2.finalize();
    });

    it('should have inserted all the rows after synchronizing with serialize()', function(done) {
        db.serialize();
        db.all("SELECT txt, num, flt, blb FROM foo ORDER BY num", function(err, rows) {
            if (err) throw err;
            for (let i = 0; i < rows.length; i++) {
                assert.equal(rows[i].txt, 'String ' + i);
                assert.equal(rows[i].num, i);
                assert.equal(rows[i].flt, i * Math.PI);
                assert.equal(rows[i].blb, null);
                retrieved++;
            }

            assert.equal(count, inserted1 + inserted2, "Didn't insert all rows");
            assert.equal(count, retrieved, "Didn't retrieve all rows");
            done();
        });
    });

    after(function(done) { db.close(done); });
});

describe('serialize(fn)', function() {
    let db;
    before(function(done) { db = new sqlite3.Database(':memory:', done); });

    let inserted = 0;
    let retrieved = 0;

    let count = 1000;

    it('should call the callback', function(done) {
        db.serialize(function() {
            db.run("CREATE TABLE foo (txt text, num int, flt float, blb blob)");

            let stmt = db.prepare("INSERT INTO foo VALUES(?, ?, ?, ?)");
            for (let i = 0; i < count; i++) {
                stmt.run('String ' + i, i, i * Math.PI, function(err) {
                    if (err) throw err;
                    inserted++;
                });
            }
            stmt.finalize();

            db.all("SELECT txt, num, flt, blb FROM foo ORDER BY num", function(err, rows) {
                if (err) throw err;
                for (let i = 0; i < rows.length; i++) {
                    assert.equal(rows[i].txt, 'String ' + i);
                    assert.equal(rows[i].num, i);
                    assert.equal(rows[i].flt, i * Math.PI);
                    assert.equal(rows[i].blb, null);
                    retrieved++;
                }
                done();
            });
        });
    });


    it('should have inserted and retrieved all rows', function() {
        assert.equal(count, inserted, "Didn't insert all rows");
        assert.equal(count, retrieved, "Didn't retrieve all rows");
    });

    after(function(done) { db.close(done); });
});