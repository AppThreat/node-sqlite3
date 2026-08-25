import sqlite3 from '../lib/sqlite3.js';
import assert from 'assert';

// Pins the trace/profile API semantics across the sqlite3_trace_v2
// migration: expanded SQL (bind values inlined) and timing payloads.
describe('trace/profile payload semantics', function() {
    let db;

    beforeEach(function(done) {
        db = new sqlite3.Database(':memory:', function(err) {
            assert.ifError(err);
            db.exec('CREATE TABLE t (a INTEGER, b TEXT)', done);
        });
    });

    afterEach(function(done) {
        db.close(done);
    });

    it('trace emits expanded SQL for positional params', function(done) {
        const seen = [];
        db.on('trace', function(sql) {
            seen.push(sql);
        });
        db.run('INSERT INTO t VALUES (?, ?)', 42, 'hello', function(err) {
            assert.ifError(err);
            setTimeout(function() {
                assert.ok(seen.some(s => s === "INSERT INTO t VALUES (42, 'hello')"),
                    'expanded insert not found in: ' + JSON.stringify(seen));
                done();
            }, 50);
        });
    });

    it('trace emits expanded SQL for array params', function(done) {
        const seen = [];
        db.on('trace', function(sql) {
            seen.push(sql);
        });
        db.get('SELECT ? AS v', [7], function(err, row) {
            assert.ifError(err);
            assert.strictEqual(row.v, 7);
            setTimeout(function() {
                assert.ok(seen.some(s => s === 'SELECT 7 AS v'),
                    'expanded select not found in: ' + JSON.stringify(seen));
                done();
            }, 50);
        });
    });

    it('trace emits expanded SQL for named params', function(done) {
        const seen = [];
        db.on('trace', function(sql) {
            seen.push(sql);
        });
        db.get('SELECT $a AS a, :b AS b', {$a: 1, ':b': 2}, function(err) {
            assert.ifError(err);
            setTimeout(function() {
                assert.ok(seen.some(s => s === 'SELECT 1 AS a, 2 AS b'),
                    'expanded named-param select not found in: ' + JSON.stringify(seen));
                done();
            }, 50);
        });
    });

    it('profile emits expanded SQL and non-negative ms', function(done) {
        const seen = [];
        db.on('profile', function(sql, ms) {
            assert.equal(typeof ms, 'number');
            assert.ok(ms >= 0, 'negative duration');
            seen.push(sql);
        });
        db.run('INSERT INTO t VALUES (?, ?)', 1, 'x', function(err) {
            assert.ifError(err);
            setTimeout(function() {
                assert.ok(seen.some(s => s === "INSERT INTO t VALUES (1, 'x')"),
                    'profiled insert not found in: ' + JSON.stringify(seen));
                done();
            }, 50);
        });
    });

    it('trace and profile work simultaneously', function(done) {
        const traces = [];
        const profiles = [];
        db.on('trace', function(sql) { traces.push(sql); });
        db.on('profile', function(sql) { profiles.push(sql); });
        db.run('INSERT INTO t VALUES (?, ?)', 5, 'five', function(err) {
            assert.ifError(err);
            setTimeout(function() {
                assert.ok(traces.some(s => s === "INSERT INTO t VALUES (5, 'five')"),
                    'trace payload missing: ' + JSON.stringify(traces));
                assert.ok(profiles.some(s => s === "INSERT INTO t VALUES (5, 'five')"),
                    'profile payload missing: ' + JSON.stringify(profiles));
                done();
            }, 50);
        });
    });

    it('profile fires for statement-heavy exec too', function(done) {
        const profiles = [];
        db.on('profile', function(sql) { profiles.push(sql); });
        db.exec("INSERT INTO t VALUES (1, 'a'); INSERT INTO t VALUES (2, 'b');", function(err) {
            assert.ifError(err);
            setTimeout(function() {
                assert.ok(profiles.length >= 2, 'expected >=2 profile events, got ' + profiles.length);
                done();
            }, 50);
        });
    });
});
