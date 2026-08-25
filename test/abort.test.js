import assert from 'node:assert';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// A CPU-heavy query that takes long enough to still be in flight when the
// abort lands a tick later.
const HEAVY = counter(8000000);

// The same shape, ~40x cheaper. sqlite3_interrupt() is a no-op when no
// statement is running yet and does not touch statements started after it
// returns, so an abort that loses the race against the worker thread
// simply does not fire — the iterator still rejects (it settles its own
// waiters), but the query runs to completion in the background and
// teardown has to wait for it. That makes the cost of a *repeated* abort
// test up to N full executions, which is why the loop below uses this
// one: at HEAVY's 0.8s-on-fast-hardware it needed 16s of its 30s budget
// locally and blew past it entirely on CI's slower and emulated runners
// (measured there: 29.7s, 25.6s, then a timeout — a coin flip).
// The window this loop exists to hit is the one during *prepare*, whose
// width has nothing to do with how long the query then runs, so nothing
// is lost. Interrupting a running step stays covered by the tests above,
// which each run HEAVY exactly once.
const MODERATE = counter(200000);

/**
 * @param {number} n rows for the recursive CTE to count to.
 * @returns {string} a query whose cost scales with n.
 */
function counter(n) {
    return (
        `WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < ${n}) ` +
        'SELECT count(*) FROM cnt'
    );
}

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

    // sqlite3_interrupt aborts a prepare just as readily as a step, so an
    // abort can land while the statement is still being prepared. An
    // unprepared statement used to drop its whole queue without firing
    // callbacks — including the fetch and the finalize the iterator's
    // teardown waits on — so this hung. Rare on a fast machine and close
    // to certain on a slow one: the prepare window is wider there, which
    // is why CI's emulated and older runners failed every time while this
    // passed locally. Statement::CleanQueue now fails those calls; the
    // deterministic form is pinned in state_machine.test.js ("a prepare
    // that fails with work queued behind it"), and this keeps the racy
    // interrupt-during-prepare shape itself covered.
    //
    // Uses MODERATE, not HEAVY: see the note on that constant for why
    // repeating this shape is what makes the query's cost matter.
    it('aborting an iterator repeatedly never wedges the connection', {
        timeout: 30000,
    }, async function () {
        for (let i = 0; i < 20; i++) {
            const db = await sqlite3.open(':memory:');
            const controller = new AbortController();
            const iterator = db.iterate(MODERATE, {
                signal: controller.signal,
            });
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
