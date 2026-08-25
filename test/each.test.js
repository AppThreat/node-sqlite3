import assert from 'node:assert';
import path, { dirname } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('each', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(
            path.join(__dirname, 'support', 'big.db'),
            sqlite3.OPEN_READONLY,
            done,
        );
    });

    it('retrieve 100,000 rows with Statement#each', function (_t, done) {
        const total = 100000;
        let retrieved = 0;

        db.each(
            'SELECT id, txt FROM foo LIMIT 0, ?',
            total,
            function (err, _row) {
                if (err) throw err;
                retrieved++;

                if (retrieved === total) {
                    assert.equal(
                        retrieved,
                        total,
                        'Only retrieved ' +
                            retrieved +
                            ' out of ' +
                            total +
                            ' rows.',
                    );
                    done();
                }
            },
        );
    });

    it('Statement#each with complete callback', function (_t, done) {
        const total = 10000;
        let retrieved = 0;

        db.each(
            'SELECT id, txt FROM foo LIMIT 0, ?',
            total,
            function (err, _row) {
                if (err) throw err;
                retrieved++;
            },
            function (_err, num) {
                assert.equal(retrieved, num);
                assert.equal(
                    retrieved,
                    total,
                    'Only retrieved ' +
                        retrieved +
                        ' out of ' +
                        total +
                        ' rows.',
                );
                done();
            },
        );
    });
});
