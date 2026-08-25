import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('profiling', function () {
    let create = false;
    let select = false;

    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:', done);

        db.on('profile', function (sql, nsecs) {
            assert.ok(typeof nsecs === 'number');
            if (sql.match(/^SELECT/)) {
                assert.ok(!select);
                assert.equal(sql, 'SELECT * FROM foo');
                select = true;
            } else if (sql.match(/^CREATE/)) {
                assert.ok(!create);
                assert.equal(sql, 'CREATE TABLE foo (id int)');
                create = true;
            } else {
                assert.ok(false);
            }
        });
    });

    it('should profile a create table', function (_t, done) {
        assert.ok(!create);
        db.run('CREATE TABLE foo (id int)', function (err) {
            if (err) throw err;
            setImmediate(function () {
                assert.ok(create);
                done();
            });
        });
    });

    it('should profile a select', function (_t, done) {
        assert.ok(!select);
        db.run('SELECT * FROM foo', function (err) {
            if (err) throw err;
            setImmediate(function () {
                assert.ok(select);
                done();
            }, 0);
        });
    });

    after(function (_t, done) {
        db.close(done);
    });
});
