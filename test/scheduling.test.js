import assert from 'node:assert';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('scheduling', function () {
    it('scheduling after the database was closed', function (_t, done) {
        const db = new sqlite3.Database(':memory:');
        // A callback-less call is promise mode since v9, so the failure is
        // a rejection rather than an 'error' event (the callback form is
        // covered by the next test).
        db.close();
        db.run('CREATE TABLE foo (id int)').then(
            function () {
                assert.fail('expected the run to fail');
            },
            function (err) {
                assert.ok(
                    err.message &&
                        err.message.indexOf(
                            'SQLITE_MISUSE: Database handle is closed',
                        ) > -1,
                );
                done();
            },
        );
    });

    it('scheduling a query with callback after the database was closed', function (_t, done) {
        const db = new sqlite3.Database(':memory:');
        db.on('error', function (_err) {
            assert.ok(false, 'Event was accidentally triggered');
        });

        db.close();
        db.run('CREATE TABLE foo (id int)', function (err) {
            assert.ok(
                err.message &&
                    err.message.indexOf(
                        'SQLITE_MISUSE: Database handle is closed',
                    ) > -1,
            );
            done();
        });
    });

    it('running a query after the database was closed', function (_t, done) {
        const db = new sqlite3.Database(':memory:');

        const stmt = db.prepare('SELECT * FROM sqlite_master', function (err) {
            if (err) throw err;
            db.close(function (err) {
                assert.ok(err);
                assert.ok(
                    err.message &&
                        err.message.indexOf(
                            'SQLITE_BUSY: unable to close due to',
                        ) > -1,
                );

                // Running a statement now should not fail.
                stmt.run(done);
            });
        });
    });
});
