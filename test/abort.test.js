import assert from 'node:assert';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// A CPU-heavy query that takes long enough to still be in flight when the
// abort lands a tick later.
const HEAVY =
    'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 8000000) ' +
    'SELECT count(*) FROM cnt';

describe('abort', function () {
    it('an already-aborted signal rejects before scheduling', async function () {
        const db = await sqlite3.open(':memory:');
        const controller = new AbortController();
        controller.abort('never mind');
        await assert.rejects(
            db.all('SELECT 1', { signal: controller.signal }),
            (reason) => reason === 'never mind',
        );
        // Nothing was scheduled: the connection is fully idle.
        assert.deepStrictEqual(db.getSync('SELECT 1 AS x'), { x: 1 });
        await db.close();
    });

    it('aborting an in-flight query rejects with the reason', {
        timeout: 30000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        const controller = new AbortController();
        const pending = db.get(HEAVY, { signal: controller.signal });
        setTimeout(function () {
            controller.abort('too slow');
        }, 5);
        await assert.rejects(pending, (reason) => reason === 'too slow');
        // The connection survived the interrupt.
        assert.deepStrictEqual(await db.get('SELECT 42 AS x'), { x: 42 });
        await db.close();
    });

    it('aborting while queued behind other work still rejects promptly', {
        timeout: 30000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        const controller = new AbortController();
        // A slow exclusive exec holds the queue; the aborted get waits
        // behind it without having touched SQLite yet.
        const slow = db.exec(HEAVY);
        const queued = db.get('SELECT 7', { signal: controller.signal });
        controller.abort('queued out');
        await assert.rejects(queued, (reason) => reason === 'queued out');
        // Note: interruption is connection-wide by SQLite design, so the
        // in-flight exec may also fail; drain it either way.
        await slow.then(
            () => undefined,
            () => undefined,
        );
        await db.close();
    });

    it('the signal option never collides with named parameters', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        // $signal is a bind parameter name; { signal } is options.
        await db.run('INSERT INTO t VALUES ($signal)', { $signal: 1 });
        assert.deepStrictEqual(await db.get('SELECT a FROM t'), { a: 1 });
        await db.close();
    });

    it('listener count on a reused signal stays bounded across 1000 queries', async function () {
        const db = await sqlite3.open(':memory:');
        const controller = new AbortController();
        const { signal } = controller;
        await db.exec('CREATE TABLE t (a INT)');
        const stmt = db.prepare('INSERT INTO t VALUES (?)');
        let maxListeners = 0;
        for (let i = 0; i < 1000; i++) {
            const pending = stmt.run(i, { signal });
            maxListeners = Math.max(
                maxListeners,
                getEventListeners(signal, 'abort').length,
            );
            await pending;
        }
        assert.ok(maxListeners <= 1, `saw ${maxListeners} listeners in flight`);
        assert.strictEqual(getEventListeners(signal, 'abort').length, 0);
        await stmt.finalize();
        await db.close();
    });

    it('aborting an iterator rejects the pending next() with the reason', {
        timeout: 30000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        const controller = new AbortController();
        const iterator = db.iterate(HEAVY, { signal: controller.signal });
        const pending = iterator.next();
        controller.abort('stop scanning');
        await assert.rejects(pending, (reason) => reason === 'stop scanning');
        // The interrupted fetch (and the teardown queued behind it) must
        // drain before the connection is idle again.
        await iterator.return();
        assert.deepStrictEqual(db.getSync('SELECT 1 AS x'), { x: 1 });
        await db.close();
    });

    // sqlite3_interrupt aborts a prepare too, and an unprepared statement
    // drops its whole queue without firing callbacks — including the
    // finalize the iterator's teardown waits on. That made the test above
    // hang roughly one run in three. The deterministic form of the same
    // deadlock is pinned in iterate.test.js ("return() after a failed
    // prepare still settles"); this repeats the racy shape to keep the
    // interrupt-during-prepare window itself covered.
    it('aborting an iterator repeatedly never wedges the connection', {
        timeout: 30000,
    }, async function () {
        for (let i = 0; i < 20; i++) {
            const db = await sqlite3.open(':memory:');
            const controller = new AbortController();
            const iterator = db.iterate(HEAVY, { signal: controller.signal });
            const pending = iterator.next();
            controller.abort('stop');
            // Either the fetch was interrupted (rejects with the reason) or
            // the prepare itself was (rejects with SQLITE_INTERRUPT).
            await assert.rejects(
                pending,
                (reason) =>
                    reason === 'stop' || reason?.code === 'SQLITE_INTERRUPT',
            );
            await iterator.return();
            assert.deepStrictEqual(db.getSync('SELECT 1 AS x'), { x: 1 });
            await db.close();
        }
    });

    it('aborting between rows rejects the next row', {
        timeout: 30000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        const controller = new AbortController();
        await assert.rejects(
            async function () {
                for await (const _row of db.iterate(HEAVY, {
                    signal: controller.signal,
                })) {
                    controller.abort('mid scan');
                }
            },
            (reason) => reason === 'mid scan',
        );
        await db.close();
    });

    it('aborting a transaction rolls back and rejects with the reason', {
        timeout: 30000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        const controller = new AbortController();
        const pending = db.transaction(
            async (tx) => {
                await tx.run('INSERT INTO t VALUES (1)');
                await tx.get(HEAVY);
                await tx.run('INSERT INTO t VALUES (2)');
            },
            { signal: controller.signal },
        );
        setTimeout(function () {
            controller.abort('tx cancelled');
        }, 5);
        await assert.rejects(pending, (reason) => reason === 'tx cancelled');
        // The insert was rolled back.
        assert.deepStrictEqual(await db.all('SELECT a FROM t'), []);
        await db.close();
    });

    it('a signal that never fires is just an observer', async function () {
        const db = await sqlite3.open(':memory:');
        const controller = new AbortController();
        await db.exec('CREATE TABLE IF NOT EXISTS t (a INT)');
        const r = await db.run('INSERT INTO t VALUES (?)', 1, {
            signal: controller.signal,
        });
        assert.strictEqual(r.changes, 1);
        await db.close();
    });
});
