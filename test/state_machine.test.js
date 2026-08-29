// Regression tests for the native state machine (Deliverable 05): the
// Backup call guard, the db.state accessor, the statement cache's
// serialize guard, and finalize-on-GC safety.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Runs the throwing-backup scenario in a child process; see the helper's
// header comment for why this is not done in-process.
describe('backup call guard', function () {
    it('a throwing step callback does not wedge the connection', {
        timeout: 30000,
    }, async function () {
        // Absolute path and a joined cwd, both built with node:path: the
        // previous form stripped the trailing directory with /\/test$/,
        // which never matches a Windows path, leaving cwd inside test/ so
        // the relative argument resolved to test\test\support\… and the
        // child died with MODULE_NOT_FOUND. Nothing caught it because the
        // suite does not run on Windows in CI — only the Electron job does.
        const child = spawn(
            process.execPath,
            [join(import.meta.dirname, 'support', 'throwing_backup_child.mjs')],
            { cwd: join(import.meta.dirname, '..') },
        );
        let out = '';
        child.stdout.on('data', (chunk) => {
            out += chunk;
        });
        child.stderr.on('data', (chunk) => {
            out += chunk;
        });
        const code = await new Promise((resolve) => {
            child.on('close', resolve);
        });
        assert.strictEqual(code, 0, `child exited ${code}; output:\n${out}`);
        assert.match(out, /GETSYNC_OK/);
        assert.match(out, /CLOSE_OK/);
        assert.match(out, /UNCAUGHT:step callback boom/);
    });
});

describe('db.state', function () {
    it('is a frozen snapshot of exactly the six scheduling fields', async function () {
        const db = await sqlite3.open(':memory:');
        const state = db.state;
        assert.deepStrictEqual(Object.keys(state).sort(), [
            'closing',
            'locked',
            'open',
            'pending',
            'queued',
            'serialized',
        ]);
        assert.ok(Object.isFrozen(state));
        // A fresh read must reflect changes, not a cached snapshot.
        db.serialize();
        assert.strictEqual(db.state.serialized, true);
        assert.notStrictEqual(state.serialized, db.state.serialized);
        db.parallelize();
        assert.strictEqual(db.state.serialized, false);
        await db.close();
    });

    it('reflects an idle open connection', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        // locked is honest since DbState/exclusiveHeld: false once the
        // exclusive exec completed (it used to be sticky history).
        assert.deepStrictEqual(db.state, {
            open: true,
            closing: false,
            locked: false,
            serialized: false,
            pending: 0,
            queued: 0,
        });
        await db.close();
    });

    it('shows an exclusive operation in flight immediately after exec()', async function () {
        const db = await sqlite3.open(':memory:');
        // exec() with an idle queue dispatches synchronously: locked is
        // set and pending incremented before exec() returns.
        const done = new Promise((resolve) =>
            db.exec('CREATE TABLE t (a INT)', resolve),
        );
        assert.strictEqual(db.state.locked, true);
        assert.strictEqual(db.state.pending, 1);
        assert.strictEqual(db.state.queued, 0);
        await done;
        // Honest release: locked drops when the exclusive call completes
        // (it used to stay true until the next dispatch).
        assert.deepStrictEqual(db.state, {
            open: true,
            closing: false,
            locked: false,
            serialized: false,
            pending: 0,
            queued: 0,
        });
        await db.close();
    });

    it('shows queued work while a statement operation is in flight', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        // A statement run is in flight (pending > 0, bypassing the
        // database queue), and an exclusive exec behind it is queued.
        const ran = new Promise((resolve) =>
            db.run('INSERT INTO t VALUES (1)', resolve),
        );
        const executed = new Promise((resolve) =>
            db.exec('SELECT * FROM t', resolve),
        );
        const state = db.state;
        assert.ok(state.pending >= 1, `pending ${state.pending} >= 1`);
        assert.ok(state.queued >= 1, `queued ${state.queued} >= 1`);
        await ran;
        await executed;
        await db.close();
    });

    it('shows a close queued behind in-flight work, then settled', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        const ran = new Promise((resolve) =>
            db.run('INSERT INTO t VALUES (1)', resolve),
        );
        const closed = db.close();
        // The close is waiting behind the in-flight statement work:
        // queued, but `closing` only turns true once the close itself
        // starts (which requires pending == 0), so it is not observable
        // in this window.
        const queued = db.state;
        assert.strictEqual(queued.open, true);
        assert.strictEqual(queued.closing, false);
        assert.ok(queued.queued >= 1, `queued ${queued.queued} >= 1`);
        assert.ok(queued.pending >= 1, `pending ${queued.pending} >= 1`);
        await ran;
        await closed;
        // After the close completed: fully settled, locked included (the
        // old tombstone used to read true here by design).
        assert.deepStrictEqual(db.state, {
            open: false,
            closing: false,
            locked: false,
            serialized: false,
            pending: 0,
            queued: 0,
        });
    });

    it('sees a fetch in flight while a statement iterates', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT); INSERT INTO t VALUES (1),(2)');
        const iterator = db.iterate('SELECT a FROM t ORDER BY a');
        const first = iterator.next();
        assert.ok(db.state.pending >= 1);
        await first;
        // Between fetches nothing is in flight.
        assert.strictEqual(db.state.pending, 0);
        await iterator.return();
        await db.close();
    });

    it('serialize() reached via a saved prototype reference still disables the cache fast path', async function () {
        // The _serialized drift bug: a saved reference to the native
        // serialize bypassed the JS mirror, so the statement cache kept
        // taking the fast path while the connection was serialized,
        // silently breaking FIFO. There is no mirror anymore: the native
        // flag is the state.
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        db.cacheStatements();
        // Prime the cache so a fast-path take is possible at all.
        await db.run('INSERT INTO t VALUES (1)');
        const nativeSerialize = sqlite3.Database.prototype.serialize;
        nativeSerialize.call(db);
        assert.strictEqual(db.state.serialized, true);
        assert.strictEqual(db.serialized, true);
        // While serialized, a cached call must not overtake queued
        // database work: two ops issued now must complete in order.
        const order = [];
        await Promise.all([
            new Promise((resolve) =>
                db.exec('SELECT 1', () => {
                    order.push('exec');
                    resolve();
                }),
            ),
            new Promise((resolve) =>
                db.run('INSERT INTO t VALUES (2)', () => {
                    order.push('run');
                    resolve();
                }),
            ),
        ]);
        assert.deepStrictEqual(order, ['exec', 'run']);
        db.parallelize();
        assert.strictEqual(db.state.serialized, false);
        await db.close();
    });
});

describe('finalize-on-GC safety net', function () {
    // Both tests need a real GC collection to drive the native
    // finalizers; without --expose-gc they would pass vacuously, so they
    // skip instead.
    it('a collected unfinalized statement stops blocking close()', async function (t) {
        if (typeof globalThis.gc !== 'function') {
            return t.skip('requires --expose-gc');
        }
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        let stmt = db.prepare('INSERT INTO t VALUES (?)');
        await stmt.run(1);
        // Forget the statement without finalize().
        stmt = null;
        globalThis.gc();
        // Let the collection (and thus the destructor's finalize) land.
        await new Promise((resolve) => setImmediate(resolve));
        await db.close();
    });

    it('statements and backups whose construction threw are safe to collect', async function (t) {
        if (typeof globalThis.gc !== 'function') {
            return t.skip('requires --expose-gc');
        }
        // Before Deliverable 05 the constructors left `db` uninitialised
        // when validation failed, so collecting the abandoned wrapper
        // segfaulted at GC time (verified: exit 139 on release/v9).
        assert.throws(() => new sqlite3.Statement({}, 'SELECT 1'));
        assert.throws(
            () => new sqlite3.Backup({}, 'f.db', 'main', 'main', true),
        );
        globalThis.gc();
        await new Promise((resolve) => setImmediate(resolve));
        // Surviving to here is the assertion; a regression segfaults the
        // process outright.
    });
});

// A prepare can fail with calls already queued behind it, and those calls
// are what the caller is actually waiting on. When the prepare had no
// callback of its own -- every promise-mode entry point -- the failure
// used to be reported only on the statement's 'error' event while the
// queue was discarded in silence, so nothing ever settled and the caller
// hung. sqlite3_interrupt() aborts a prepare exactly as readily as a
// step, so any abort landing in that window wedged the connection; the
// abort tests timed out on CI's slower runners for this reason, where the
// window is wide enough to hit almost every time.
describe('a prepare that fails with work queued behind it', function () {
    it('settles the queued call rather than dropping it', {
        timeout: 10000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        // No prepare callback, and the call below is queued in the same
        // tick, so it is still waiting when the prepare fails.
        const stmt = db.prepare('SELECT * FROM no_such_table');
        /** @type {Error[]} */
        const events = [];
        stmt.on('error', function (err) {
            events.push(err);
        });
        const err = await new Promise(function (resolve) {
            stmt.all(function (e) {
                resolve(e);
            });
        });
        assert.strictEqual(err.code, 'SQLITE_ERROR');
        assert.match(err.message, /no such table: no_such_table/);
        // The statement still reports its own failure: that event is the
        // documented surface for a prepare given no callback.
        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(db.getSync('SELECT 1 AS x'), { x: 1 });
        await db.close();
    });

    it('settles a queued each() through its completion handler', {
        timeout: 10000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        const stmt = db.prepare('SELECT * FROM no_such_table');
        stmt.on('error', function () {
            // Absorbed: this test is about the queued each(), not the event.
        });
        let rows = 0;
        const err = await new Promise(function (resolve) {
            stmt.each(
                function () {
                    rows++;
                },
                function (e) {
                    resolve(e);
                },
            );
        });
        assert.strictEqual(err.code, 'SQLITE_ERROR');
        // The per-row callback must not be handed the error as a row.
        assert.strictEqual(rows, 0);
        await db.close();
    });
});
