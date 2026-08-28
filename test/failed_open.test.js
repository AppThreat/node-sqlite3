// Work queued behind a failed open (Deliverable 11). Before the fix, a
// failed open left the connection in the Opening state forever: Process()
// never dispatches from Opening, so anything queued against the
// connection (statements, config calls) sat stranded and never settled.
// The failed open is now terminal (Closed) and the drain fails queued
// work with the open's own error. A permission refusal cannot reach this
// path (it throws before the native open is scheduled), but a native
// failure — a missing directory, a permissions error — is the same class.

import assert from 'node:assert';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('failed open', function () {
    it('fails work queued behind the failed open with the open error', {
        timeout: 10000,
    }, async function () {
        // This test hangs on release/v9 (the queued get never settles);
        // the timeout above is what turns that hang into a failure.
        const db = new sqlite3.Database(
            '/no/such/directory-either/nested/missing.db',
            (openErr) => {
                assert.strictEqual(
                    /** @type {Error & { code?: string }} */ (openErr).code,
                    'SQLITE_CANTOPEN',
                );
            },
        );
        const queued = new Promise((resolve, reject) => {
            db.get('SELECT 1 AS v', (err) => {
                if (err) resolve(err);
                else
                    reject(
                        new Error('queued work ran against a dead connection'),
                    );
            });
        });
        const err = /** @type {Error & { code?: string }} */ (await queued);
        assert.strictEqual(err.code, 'SQLITE_CANTOPEN');
        assert.match(err.message, /unable to open database file/);
    });

    it(
        'the connection is terminal: close reports the usual closed error',
        { timeout: 10000 },
        function (_t, done) {
            const db = new sqlite3.Database(
                '/no/such/directory-either/nested/two.db',
            );
            db.on('error', () => {
                // The open failure surfaced on the error event; the connection
                // must now behave like a closed one.
                db.close((err) => {
                    assert.ok(err, 'close on a failed-open connection errors');
                    assert.strictEqual(
                        /** @type {Error & { code?: string }} */ (err).errno,
                        sqlite3.MISUSE,
                    );
                    done();
                });
            });
        },
    );

    it(
        'a callback-less failed open emits the error event instead of crashing',
        { timeout: 10000 },
        function (_t, done) {
            const db = new sqlite3.Database(
                '/no/such/directory-either/nested/three.db',
            );
            db.on('error', (err) => {
                assert.strictEqual(
                    /** @type {Error & { code?: string }} */ (err).code,
                    'SQLITE_CANTOPEN',
                );
                done();
            });
        },
    );
});
