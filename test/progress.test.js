import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';

import sqlite3 from '../lib/sqlite3.js';

// Progress handler and cancellation token (Deliverable 07). The token is
// the recommended form: an atomic flag in a SharedArrayBuffer, polled by
// the native handler — zero JS per check, and cancellable from any
// thread. The JS callback form round-trips per invocation and is gated
// out of the synchronous methods like collations are.

const RECURSIVE = `
WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM c)
SELECT sum(x) FROM c
`;

/**
 * Waits for the connection's in-flight work to drain, up to `budget` ms.
 * Returns either way: the caller asserts on db.pending, so a genuine
 * failure to drain still fails the test — just without a fixed sleep
 * deciding it.
 */
async function waitForDrain(db, budget = 5000) {
    const deadline = Date.now() + budget;
    while (db.pending !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function openDb() {
    const db = new sqlite3.Database(':memory:');
    await new Promise((resolve, reject) => {
        db.once('open', resolve);
        db.once('error', reject);
    });
    return db;
}

describe('progress handler', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = await openDb();
    });

    afterEach(async function () {
        await db.close();
    });

    it('a cancellation token aborts a long query and the connection survives', {
        timeout: 15000,
    }, async function () {
        const token = db.cancellationToken();
        assert.strictEqual(token.cancelled, false);

        const started = Date.now();
        // Cancel shortly after the query starts running.
        setTimeout(() => token.cancel(), 20);

        await assert.rejects(
            db.all(RECURSIVE),
            (err) => err.code === 'SQLITE_INTERRUPT',
        );
        const elapsed = Date.now() - started;
        // Unbounded, this query runs for hundreds of milliseconds; the
        // token must stop it well before that. Generous bound so a slow
        // runner fails on correctness, not on scheduling.
        assert.ok(elapsed < 5000, `abort took ${elapsed}ms`);

        assert.strictEqual(token.cancelled, true);
        // The connection is fully usable again: pending drained to 0 and
        // a fresh query completes normally.
        assert.strictEqual(db.pending, 0);
        const row = await db.get('SELECT 41 + 1 AS v');
        assert.strictEqual(row.v, 42);
    });

    it('a token cancelled from a worker thread aborts the query', {
        timeout: 20000,
    }, async function () {
        // The whole point of the SharedArrayBuffer: the main thread is
        // busy awaiting the query, so the flag has to be set from another
        // thread with no JS involvement on this connection.
        const token = db.cancellationToken();
        const workerSource = `
            const { parentPort, workerData } = require('node:worker_threads');
            const flag = new Int32Array(workerData.sab);
            setTimeout(() => {
                Atomics.store(flag, 0, 1);
                parentPort.postMessage('set');
            }, 20);
        `;
        const worker = new Worker(workerSource, {
            eval: true,
            workerData: { sab: token.buffer },
        });
        const flagged = new Promise((resolve) => {
            worker.once('message', resolve);
        });

        await assert.rejects(
            db.all(RECURSIVE),
            (err) => err.code === 'SQLITE_INTERRUPT',
        );
        assert.strictEqual(await flagged, 'set');
        await worker.terminate();

        // The connection survived the cross-thread abort.
        const row = await db.get('SELECT 7 AS v');
        assert.strictEqual(row.v, 7);
        assert.strictEqual(db.pending, 0);
    });

    it('the token’s signal integrates with the { signal } option', {
        timeout: 15000,
    }, async function () {
        const token = db.cancellationToken();
        const reason = new Error('stopped by user');
        const started = Date.now();
        setTimeout(() => token.cancel(reason), 20);

        await assert.rejects(
            db.all(RECURSIVE, { signal: token.signal }),
            (err) => err === reason,
        );
        assert.ok(Date.now() - started < 5000);
        // The signal rejects immediately, independently of the query, so
        // unlike the other pending checks here the interrupted work is
        // still unwinding. Poll rather than sleeping a fixed 25ms: on a
        // loaded runner that sleep is not enough, and the assertion then
        // fails on scheduling instead of on the thing it is testing.
        await waitForDrain(db);
        assert.strictEqual(db.pending, 0);
    });

    it('an unused token costs nothing observable and queries still complete', {
        timeout: 15000,
    }, async function () {
        const token = db.cancellationToken();
        const rows = await db.all('SELECT 1 AS a UNION ALL SELECT 2');
        assert.deepStrictEqual(
            rows.map((r) => r.a),
            [1, 2],
        );
        token.destroy();
        // Still works after destroy.
        const row = await db.get('SELECT 3 AS v');
        assert.strictEqual(row.v, 3);
    });

    it('reset() lets a token be reused', { timeout: 15000 }, async function () {
        const token = db.cancellationToken();
        token.cancel();
        token.reset();
        assert.strictEqual(token.cancelled, false);
        const row = await db.get('SELECT 1 AS v');
        assert.strictEqual(row.v, 1);
    });

    it('the JavaScript callback form aborts on a truthy return', {
        timeout: 15000,
    }, async function () {
        let calls = 0;
        db.progress(1000, () => {
            calls++;
            return calls > 3;
        });
        await assert.rejects(
            db.all(RECURSIVE),
            (err) => err.code === 'SQLITE_INTERRUPT',
        );
        assert.ok(calls >= 4, `callback ran ${calls} times`);
        // The handler stays installed until removed.
        assert.strictEqual(db.pending, 0);
        db.progress();
        const row = await db.get('SELECT 5 AS v');
        assert.strictEqual(row.v, 5);
    });

    it('a throwing progress callback aborts the query and carries the cause', {
        timeout: 15000,
    }, async function () {
        const boom = new Error('progress exploded');
        db.progress(1000, () => {
            throw boom;
        });
        await assert.rejects(db.all(RECURSIVE), (err) => {
            assert.strictEqual(err.code, 'SQLITE_INTERRUPT');
            assert.strictEqual(err.cause, boom);
            return true;
        });
        db.progress();
    });

    it('sync methods refuse while a JS progress callback is registered', async function () {
        db.progress(1000, () => false);
        // getSync hits the sync-prepare gate first, prepareSync directly.
        assert.throws(
            () => db.getSync('SELECT 1'),
            /while a JavaScript progress callback/,
        );
        assert.throws(
            () => db.prepareSync('SELECT 1'),
            /while a JavaScript progress callback/,
        );
        db.progress();
        // Removing the handler re-enables the sync path.
        assert.strictEqual(db.getSync('SELECT 1 AS v').v, 1);
    });

    it('sync methods work with the token form installed', async function () {
        const token = db.cancellationToken();
        assert.strictEqual(db.getSync('SELECT 2 AS v').v, 2);
        token.destroy();
    });

    it('validates the period and callback types', async function () {
        assert.throws(
            () => db.progress(0, () => false),
            /period must be a positive integer/,
        );
        assert.throws(
            () => /** @type {any} */ (db).progress(10, 'nope'),
            /callback must be a function/,
        );
        assert.throws(
            () => db.cancellationToken({ period: 0 }),
            /period must be a positive integer/,
        );
    });

    it('cancelling with no query running affects the next one only if still set', {
        timeout: 15000,
    }, async function () {
        const token = db.cancellationToken();
        token.cancel();
        await assert.rejects(
            db.all(RECURSIVE),
            (err) => err.code === 'SQLITE_INTERRUPT',
        );
        token.destroy();
    });

    // SQLite has one progress slot per connection, so a second token
    // replaces the first. destroy() on the displaced token must not
    // disarm its replacement: it used to, and the runaway query below
    // then never aborted — the connection wedged and the process would
    // not exit.
    it('a displaced token’s destroy() does not disarm its replacement', {
        timeout: 15000,
    }, async function () {
        const first = db.cancellationToken();
        const second = db.cancellationToken();

        first.destroy();
        second.cancel();

        await assert.rejects(
            db.all(RECURSIVE),
            (err) => err.code === 'SQLITE_INTERRUPT',
        );
        second.destroy();
        assert.deepStrictEqual(await db.all('SELECT 1 AS v'), [{ v: 1 }]);
    });

    // Same slot, other direction: progress(fn) takes it from the token,
    // so the token's destroy() must leave the callback installed.
    it('a token displaced by progress() does not disarm the callback', {
        timeout: 15000,
    }, async function () {
        const token = db.cancellationToken();
        let calls = 0;
        db.progress(1000, () => {
            calls++;
            return calls > 50;
        });
        token.destroy();

        await assert.rejects(
            db.all(RECURSIVE),
            (err) => err.code === 'SQLITE_INTERRUPT',
        );
        assert.ok(calls > 50, `progress callback ran (${calls} calls)`);
        db.progress();
    });
});
