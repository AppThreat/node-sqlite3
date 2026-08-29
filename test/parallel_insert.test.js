import { after, before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';
import { deleteFile, ensureExists, fileExists } from './support/helper.js';

describe('parallel', function () {
    let db;
    before(function (_t, done) {
        deleteFile('test/tmp/test_parallel_inserts.db');
        ensureExists('test/tmp');
        db = new sqlite3.Database('test/tmp/test_parallel_inserts.db', done);
    });

    const columns = [];
    for (let i = 0; i < 128; i++) {
        columns.push(`id${i}`);
    }

    it('should create the table', function (_t, done) {
        db.run(`CREATE TABLE foo (${columns})`, done);
    });

    // 1000 file-backed INSERTs, each its own implicit transaction (journal
    // file created and deleted per row). Measured at 38s on GitHub's
    // windows-11-arm runner — about 2x over the 20s suite-wide ceiling that
    // tools/run-tests.mjs applies, while every other runner finishes in
    // single-digit seconds. The override lifts the ceiling for this test
    // only; the hang detector still guards the rest of the suite.
    it(
        'should insert in parallel',
        {
            timeout: 180000,
        },
        function (_t, done) {
            for (let i = 0; i < 1000; i++) {
                const values = [];
                for (let j = 0; j < columns.length; j++) {
                    values.push(i * j);
                }
                db.run(`INSERT INTO foo VALUES (${values})`);
            }

            db.wait(done);
        },
    );

    it('should close the database', function (_t, done) {
        db.close(done);
    });

    it('should verify that the database exists', function () {
        fileExists('test/tmp/test_parallel_inserts.db');
    });

    after(function () {
        deleteFile('test/tmp/test_parallel_inserts.db');
    });
});
