import assert from 'node:assert';
import path, { dirname } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Large result sets are converted to JS in a single synchronous pass. That
// is deliberate: spreading the conversion over several event-loop turns
// would release the statement lock early and let later-queued operations
// report before this one, breaking the FIFO callback ordering that
// serialize() is built on. These tests pin that contract down.
describe('large result delivery', function () {
    let db;

    before(function () {
        db = new sqlite3.Database(
            path.join(__dirname, 'support', 'big.db'),
            sqlite3.OPEN_READONLY,
        );
    });

    after(function (_t, done) {
        db.close(function () {
            done();
        });
    });

    it(
        'delivers a large result set correctly',
        { timeout: 30000 },
        function (_t, done) {
            const N = 100000;
            db.all('SELECT id FROM foo LIMIT ?', N, function (err, rows) {
                assert.ifError(err);
                assert.strictEqual(rows.length, N);
                let sum = 0;
                for (let i = 0; i < rows.length; i++) {
                    assert.strictEqual(rows[i].id, i);
                    sum += rows[i].id;
                }
                assert.strictEqual(sum, (N * (N - 1)) / 2);
                done();
            });
        },
    );

    it(
        'fires callbacks in queue order regardless of result size',
        { timeout: 30000 },
        function (_t, done) {
            const order = [];
            db.serialize(function () {
                db.all(
                    'SELECT id, txt FROM foo LIMIT 100000',
                    function (err, rows) {
                        assert.ifError(err);
                        assert.strictEqual(rows.length, 100000);
                        order.push('big');
                    },
                );
                db.get('SELECT 1 AS x', function (err) {
                    assert.ifError(err);
                    order.push('get');
                });
                db.all('SELECT id FROM foo LIMIT 1', function (err) {
                    assert.ifError(err);
                    order.push('small');
                    assert.deepStrictEqual(order, ['big', 'get', 'small']);
                    done();
                });
            });
        },
    );

    it(
        'does not drop the callback when the db is closed in the same tick',
        { timeout: 30000 },
        function (_t, done) {
            const db2 = new sqlite3.Database(
                path.join(__dirname, 'support', 'big.db'),
                sqlite3.OPEN_READONLY,
            );
            let called = false;
            db2.all(
                'SELECT id, txt FROM foo LIMIT 100000',
                function (err, rows) {
                    assert.ifError(err);
                    assert.strictEqual(rows.length, 100000);
                    called = true;
                },
            );
            db2.close(function (err) {
                assert.ifError(err);
                assert.ok(
                    called,
                    'all() callback must fire before close completes',
                );
                done();
            });
        },
    );
});
