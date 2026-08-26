import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Transaction hooks (Deliverable 07): commit/rollback fire as events, a
// transaction's change events are delivered before its commit event
// (they share one ordered native channel precisely because three
// separate ones would not guarantee it), the hooks are advisory (a
// listener's return value cannot veto), and hook state follows listener
// count rather than toggling per configure() call.

describe('transaction hooks', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await new Promise((resolve, reject) => {
            db.once('open', resolve);
            db.once('error', reject);
        });
        await db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
    });

    afterEach(async function () {
        await db.close();
    });

    it('fires commit for an explicit transaction', async function () {
        /** @type {string[]} */
        const events = [];
        db.on('commit', () => events.push('commit'));
        await db.exec('BEGIN; INSERT INTO t VALUES (1); COMMIT;');
        await new Promise((resolve) => setTimeout(resolve, 25));
        // The CREATE TABLE in beforeEach ran before the listener, so
        // exactly one commit — the explicit one.
        assert.deepStrictEqual(events, ['commit']);
    });

    it('fires commit for each implicit (autocommit) transaction', async function () {
        let commits = 0;
        db.on('commit', () => commits++);
        await db.run('INSERT INTO t VALUES (1)');
        await db.run('INSERT INTO t VALUES (2)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(commits, 2);
    });

    it('fires rollback for an explicit ROLLBACK', async function () {
        /** @type {string[]} */
        const events = [];
        db.on('rollback', () => events.push('rollback'));
        await db.exec('BEGIN; INSERT INTO t VALUES (1); ROLLBACK;');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.deepStrictEqual(events, ['rollback']);
        // The rolled-back row is really gone.
        const row = await db.get('SELECT count(*) AS n FROM t');
        assert.strictEqual(row.n, 0);
    });

    it('fires rollback when db.transaction() throws', async function () {
        let rollbacks = 0;
        db.on('rollback', () => rollbacks++);
        await assert.rejects(
            db.transaction(() => {
                return db.run('INSERT INTO t VALUES (1)').then(() => {
                    throw new Error('body failed');
                });
            }),
            /body failed/,
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(rollbacks, 1);
    });

    it('delivers a transaction’s change events before its commit event', async function () {
        // The ordering guarantee the pair exists for. Both event kinds
        // ride one FIFO native channel; this test pins that.
        /** @type {string[]} */
        const order = [];
        db.on('change', (_type, _database, table, rowid) => {
            order.push(`change:${table}:${rowid}`);
        });
        db.on('commit', () => order.push('commit'));

        await db.exec(
            'BEGIN; INSERT INTO t VALUES (7); INSERT INTO t VALUES (8); COMMIT;',
        );
        await new Promise((resolve) => setTimeout(resolve, 25));

        assert.deepStrictEqual(order, ['change:t:7', 'change:t:8', 'commit']);
    });

    it('keeps the ordering guarantee across parallel statement workers', async function () {
        // Same guarantee when the transaction's statements and its COMMIT
        // are dispatched as separate parallel calls: whichever worker runs
        // the COMMIT is serialized by sqlite behind the inserts.
        /** @type {string[]} */
        const order = [];
        db.on('change', (_type, _database, _table, rowid) => {
            order.push(`change:${rowid}`);
        });
        db.on('commit', () => order.push('commit'));

        await db.exec('BEGIN');
        await Promise.all([
            db.run('INSERT INTO t VALUES (10)'),
            db.run('INSERT INTO t VALUES (20)'),
            db.run('INSERT INTO t VALUES (30)'),
        ]);
        await db.exec('COMMIT');
        await new Promise((resolve) => setTimeout(resolve, 25));

        assert.strictEqual(order.filter((e) => e === 'commit').length, 1);
        assert.strictEqual(order.length, 4);
        assert.strictEqual(order[order.length - 1], 'commit');
    });

    it('commit is advisory: a listener’s return value cannot veto', async function () {
        db.on('commit', () => false);
        await db.run('INSERT INTO t VALUES (1)');
        const row = await db.get('SELECT count(*) AS n FROM t');
        assert.strictEqual(row.n, 1, 'the commit proceeded despite false');
    });

    it('two listeners both fire, and the hook survives removing one', async function () {
        // Pins the set-not-toggle semantics: the second addListener used
        // to uninstall the hook (configure() is called per listener).
        let a = 0;
        let b = 0;
        const first = () => a++;
        db.on('commit', first);
        const second = () => b++;
        db.on('commit', second);

        await db.run('INSERT INTO t VALUES (1)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(a, 1);
        assert.strictEqual(b, 1);

        db.removeListener('commit', first);
        await db.run('INSERT INTO t VALUES (2)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(a, 1, 'removed listener must not fire again');
        assert.strictEqual(b, 2, 'the hook must stay installed');

        db.removeListener('commit', second);
        await db.run('INSERT INTO t VALUES (3)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(b, 2, 'no listener left: hook uninstalled');
    });

    it('removeAllListeners uninstalls the hook', async function () {
        let commits = 0;
        db.on('commit', () => commits++);
        db.on('rollback', () => {
            /* sink */
        });
        db.removeAllListeners('commit');
        db.removeAllListeners('rollback');
        void 0;

        await db.exec('BEGIN; INSERT INTO t VALUES (1); COMMIT;');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(commits, 0);
    });

    it('change events keep their payload shape', async function () {
        /** @type {any[]} */
        const seen = [];
        db.on('change', (type, database, table, rowid) => {
            seen.push([type, database, table, rowid]);
        });
        await db.run('INSERT INTO t VALUES (42)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0][0], 'insert');
        assert.strictEqual(seen[0][1], 'main');
        assert.strictEqual(seen[0][2], 't');
        assert.strictEqual(seen[0][3], 42);
    });

    it('survives 1000 open/hook/close cycles', {
        timeout: 60000,
    }, async function () {
        // Where a missed cleanup would show up as a crash or a leaked
        // handle keeping the loop alive.
        for (let i = 0; i < 1000; i++) {
            const dbx = new sqlite3.Database(':memory:');
            await new Promise((resolve, reject) => {
                dbx.once('open', resolve);
                dbx.once('error', reject);
            });
            dbx.on('commit', () => {
                /* sink */
            });
            dbx.on('rollback', () => {
                /* sink */
            });
            dbx.on('change', () => {
                /* sink */
            });
            dbx.on('wal', () => {
                /* sink */
            });
            await dbx.exec('CREATE TABLE x (a); INSERT INTO x VALUES (1)');
            await dbx.close();
        }
    });

    it('registering hooks defers past in-flight function work without wedging', async function () {
        // The D06 class of hazard, now on the hook registration path:
        // on('commit') while a JS function is mid-round-trip with 50
        // statements in flight must not deadlock. This is a liveness
        // check; the real pin is the native assert
        // (!MayBlockOnWorkerRoundTrip()) at the sqlite3_commit_hook call.
        db.function('slow', () => {
            const until = performance.now() + 1;
            while (performance.now() < until) {
                /* spin briefly */
            }
            return 1;
        });
        await db.exec('CREATE TABLE u (a)');
        const inserts = [];
        for (let i = 0; i < 50; i++) {
            inserts.push(db.run('INSERT INTO u VALUES (slow())'));
        }
        // Install and remove the hooks while that work is in flight.
        const onCommit = () => {
            /* installed and removed mid-flight */
        };
        db.on('commit', onCommit);
        db.removeListener('commit', onCommit);
        await Promise.all(inserts);
        const row = await db.get('SELECT count(*) AS n FROM u');
        assert.strictEqual(row.n, 50);
    });
});
