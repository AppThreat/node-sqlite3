// Sessions and changesets (Deliverable 08): capture, harvest (changeset
// vs patchset), apply with each conflict policy, invert/concat/iterate,
// the preupdate event, and the lifetime rules (close idempotency, a
// session left open at close(), the shared preupdate-hook slot).
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';

const SETUP = 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)';

/** Opens a memory database with the shared schema. */
async function openDb() {
    const db = await sqlite3.open(':memory:');
    await db.exec(SETUP);
    return db;
}

describe('sessions and changesets', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = await openDb();
    });

    afterEach(async function () {
        await db.close();
    });

    it('captures insert, update and delete into a changeset', async function () {
        await db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
        const session = db.session();
        await db.exec("UPDATE t SET v = 'B' WHERE id = 2");
        await db.exec("INSERT INTO t VALUES (3, 'c')");
        await db.exec('DELETE FROM t WHERE id = 1');
        const changeset = await session.changeset();
        await session.close();

        assert.ok(changeset instanceof Uint8Array, 'a Uint8Array');
        assert.ok(!Buffer.isBuffer(changeset), 'not a Buffer');
        assert.ok(changeset.length > 0);

        const ops = [...sqlite3.iterateChangeset(changeset)];
        assert.strictEqual(ops.length, 3);
        assert.deepStrictEqual(
            ops.map((op) => op.op),
            ['delete', 'update', 'insert'],
        );
        // DELETE carries the full old row.
        assert.deepStrictEqual(ops[0].oldRow, [1, 'a']);
        assert.strictEqual(ops[0].newRow, undefined);
        // UPDATE carries old (pk + modified) and new (modified only).
        assert.deepStrictEqual(ops[1].oldRow, [2, 'b']);
        assert.deepStrictEqual(ops[1].newRow, [null, 'B']);
        // INSERT carries only the new row.
        assert.strictEqual(ops[2].oldRow, undefined);
        assert.deepStrictEqual(ops[2].newRow, [3, 'c']);
        // The pk positions travel with the change.
        assert.deepStrictEqual(ops[0].primaryKey, [true, false]);
    });

    it('records only the attached table', async function () {
        await db.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)');
        await db.exec('INSERT INTO t VALUES (1, NULL)');
        await db.exec('INSERT INTO other VALUES (1)');
        const session = db.session({ table: 't' });
        await db.exec("INSERT INTO t VALUES (2, 'x')");
        await db.exec('INSERT INTO other VALUES (2)');
        const changeset = await session.changeset();
        await session.close();
        const tables = [
            ...new Set(
                [...sqlite3.iterateChangeset(changeset)].map((op) => op.table),
            ),
        ];
        assert.deepStrictEqual(tables, ['t']);
    });

    it('applies a changeset and leaves both databases identical', async function () {
        await db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
        const before = await db.serializeToBytes();

        const session = db.session();
        await db.exec("UPDATE t SET v = 'B' WHERE id = 2");
        await db.exec("INSERT INTO t VALUES (3, 'c')");
        await db.exec('DELETE FROM t WHERE id = 1');
        const changeset = await session.changeset();
        await session.close();

        const target = await sqlite3.deserializeFromBytes(before);
        await target.applyChangeset(changeset);

        assert.deepStrictEqual(
            await target.all('SELECT * FROM t ORDER BY id'),
            await db.all('SELECT * FROM t ORDER BY id'),
        );
        // Identical content, not just rows: the schema tables must
        // match too. (Byte-equality of the serializations is too strict
        // after an apply — SQLite's header change counter legitimately
        // differs between a db written directly and one built by
        // replaying a changeset.)
        assert.deepStrictEqual(
            await target.all(
                'SELECT type, name, sql FROM sqlite_schema ORDER BY name',
            ),
            await db.all(
                'SELECT type, name, sql FROM sqlite_schema ORDER BY name',
            ),
        );
        await target.close();
    });

    it('rolls the whole apply back when the policy is abort', async function () {
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (1, 'a')");
        await db.exec("INSERT INTO t VALUES (2, 'b')");
        const changeset = await session.changeset();
        await session.close();

        // The target already contains id=1: applying the first insert
        // conflicts, and 'abort' must undo the whole apply — id=2 (which
        // would have applied cleanly) must not survive either.
        const target = await openDb();
        await target.exec("INSERT INTO t VALUES (1, 'target')");
        await assert.rejects(
            () => target.applyChangeset(changeset),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_ABORT');
                return true;
            },
        );
        const rows = await target.all('SELECT * FROM t ORDER BY id');
        assert.deepStrictEqual(rows, [{ id: 1, v: 'target' }]);
        await target.close();
    });

    it('skips conflicting changes with the omit policy', async function () {
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (1, 'recorded')");
        const changeset = await session.changeset();
        await session.close();

        const target = await openDb();
        await target.exec("INSERT INTO t VALUES (1, 'existing')");
        await target.applyChangeset(changeset, { conflict: 'omit' });
        const row = await target.get('SELECT v FROM t WHERE id = 1');
        assert.strictEqual(row.v, 'existing');
        await target.close();
    });

    it('overwrites conflicting rows with the replace policy', async function () {
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (1, 'recorded')");
        const changeset = await session.changeset();
        await session.close();

        const target = await openDb();
        await target.exec("INSERT INTO t VALUES (1, 'existing')");
        await target.applyChangeset(changeset, { conflict: 'replace' });
        const row = await target.get('SELECT v FROM t WHERE id = 1');
        assert.strictEqual(row.v, 'recorded');
        await target.close();
    });

    it('runs the JS conflict handler with materialised rows', async function () {
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (2, 'recorded')");
        const changeset = await session.changeset();
        await session.close();

        const target = await openDb();
        await target.exec("INSERT INTO t VALUES (2, 'existing')");
        /** @type {import('../lib/native.js').ChangesetConflict[]} */
        const seen = [];
        await target.applyChangeset(changeset, {
            conflict: (info) => {
                seen.push(info);
                assert.strictEqual(info.op, 'insert');
                assert.strictEqual(info.table, 't');
                assert.strictEqual(info.conflict, 'conflict');
                assert.deepStrictEqual(info.conflictRow.map(String), [
                    '2',
                    'existing',
                ]);
                assert.deepStrictEqual(
                    info.newRow.map((v) => (v === null ? null : String(v))),
                    ['2', 'recorded'],
                );
                return 'replace';
            },
        });
        assert.strictEqual(seen.length, 1);
        const row = await target.get('SELECT v FROM t WHERE id = 2');
        assert.strictEqual(row.v, 'recorded');
        await target.close();
    });

    // Nothing serialises applies, so two with JS handlers can overlap.
    // The gate that keeps main-thread sqlite calls deferring while an
    // apply holds the connection mutex must therefore count applies, not
    // flag them: cleared by whichever finished first, it declared the
    // connection safe while the second was still inside
    // sqlite3changeset_apply, and the next main-thread sqlite call
    // blocked on a mutex whose owner was waiting on this thread. That is
    // a hard deadlock — this test hangs rather than fails when it
    // regresses, which is why it carries an explicit timeout.
    it('two overlapping applies with JS handlers keep the deferral honest', {
        timeout: 30000,
    }, async function () {
        const ROWS = 400;
        /** Builds a changeset inserting ROWS rows tagged with `seed`. */
        async function changesetOf(seed) {
            const src = await openDb();
            const session = src.session();
            await src.exec('BEGIN');
            for (let i = 1; i <= ROWS; i++) {
                await src.run('INSERT INTO t VALUES (?, ?)', [
                    i,
                    `${seed}${i}`,
                ]);
            }
            await src.exec('COMMIT');
            const bytes = await session.changeset();
            await session.close();
            await src.close();
            return bytes;
        }

        const first = await changesetOf('a');
        const second = await changesetOf('b');

        // Every row conflicts, so both applies call their JS handler
        // hundreds of times and overlap for a good while.
        await db.exec('BEGIN');
        for (let i = 1; i <= ROWS; i++) {
            await db.run('INSERT INTO t VALUES (?, ?)', [i, 'orig']);
        }
        await db.exec('COMMIT');

        const applyFirst = db.applyChangeset(first, {
            conflict: () => 'replace',
        });
        const applySecond = db.applyChangeset(second, {
            conflict: () => 'replace',
        });

        // The moment one apply finishes, issue a main-thread sqlite call
        // while the other is still running. On the unfixed build this
        // never returns.
        const configured = applyFirst.then(() => {
            db.configure('busyTimeout', 1234);
        });

        await Promise.all([applyFirst, applySecond, configured]);
        // The connection is still usable afterwards.
        const row = await db.get('SELECT count(*) AS n FROM t');
        assert.strictEqual(row.n, ROWS);
    });

    it('aborts and reports when the JS conflict handler throws', async function () {
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (2, 'recorded')");
        const changeset = await session.changeset();
        await session.close();

        const target = await openDb();
        await target.exec("INSERT INTO t VALUES (2, 'existing')");
        await assert.rejects(
            () =>
                target.applyChangeset(changeset, {
                    conflict: () => {
                        throw new Error('decide better');
                    },
                }),
            (err) => {
                assert.match(err.message, /decide better/);
                assert.strictEqual(err.code, 'SQLITE_ABORT');
                return true;
            },
        );
        const row = await target.get('SELECT v FROM t WHERE id = 2');
        assert.strictEqual(row.v, 'existing');
        await target.close();
    });

    it('excludes tables the filter refuses', async function () {
        await db.exec('CREATE TABLE audit (id INTEGER PRIMARY KEY)');
        await db.exec('INSERT INTO t VALUES (1, NULL)');
        await db.exec('INSERT INTO audit VALUES (1)');
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (2, 'x')");
        await db.exec('INSERT INTO audit VALUES (2)');
        const changeset = await session.changeset();
        await session.close();

        const target = await openDb();
        await target.exec('CREATE TABLE audit (id INTEGER PRIMARY KEY)');
        /** @type {string[]} */
        const offered = [];
        await target.applyChangeset(changeset, {
            filter: (table) => {
                offered.push(table);
                return table !== 'audit';
            },
        });
        assert.deepStrictEqual(offered.sort(), ['audit', 't']);
        assert.strictEqual(
            (await target.get('SELECT count(*) c FROM audit')).c,
            0,
        );
        assert.strictEqual((await target.get('SELECT count(*) c FROM t')).c, 1);
        await target.close();
    });

    it('inverts a changeset so applying the inverse undoes it', async function () {
        await db.exec("INSERT INTO t VALUES (1, 'a')");
        const before = await db.serializeToBytes();
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (2, 'b')");
        await db.exec("UPDATE t SET v = 'A' WHERE id = 1");
        const changeset = await session.changeset();
        await session.close();

        const inverse = sqlite3.invertChangeset(changeset);
        assert.ok(inverse instanceof Uint8Array);
        const ops = [...sqlite3.iterateChangeset(inverse)];
        assert.deepStrictEqual(
            ops.map((op) => op.op),
            ['update', 'delete'],
        );

        // Apply to a copy of the pre-session state, then the inverse on
        // top: the result must be the pre-session bytes again.
        const target = await sqlite3.deserializeFromBytes(before);
        await target.applyChangeset(changeset);
        assert.strictEqual((await target.get('SELECT count(*) c FROM t')).c, 2);
        await target.applyChangeset(inverse);
        // Content-identical to the pre-session state (byte equality is
        // out for the change-counter reason above).
        assert.deepStrictEqual(
            await target.all('SELECT * FROM t ORDER BY id'),
            [{ id: 1, v: 'a' }],
        );
        await target.close();
    });

    it('concatenates two changesets', async function () {
        const sessionA = db.session();
        await db.exec("INSERT INTO t VALUES (1, 'a')");
        const csA = await sessionA.changeset();

        const sessionB = db.session();
        await db.exec("INSERT INTO t VALUES (2, 'b')");
        const csB = await sessionB.changeset();
        await sessionA.close();
        await sessionB.close();

        const combined = sqlite3.concatChangeset(csA, csB);
        const target = await openDb();
        await target.applyChangeset(combined);
        assert.deepStrictEqual(
            await target.all('SELECT * FROM t ORDER BY id'),
            [
                { id: 1, v: 'a' },
                { id: 2, v: 'b' },
            ],
        );
        await target.close();
    });

    it('rejects garbage instead of undefined behaviour', async function () {
        const garbage = new Uint8Array(64).fill(0x5a);
        assert.throws(
            () => sqlite3.invertChangeset(garbage),
            (err) => err instanceof Error,
        );
        assert.throws(
            () => sqlite3.concatChangeset(garbage, garbage),
            (err) => err instanceof Error,
        );
        assert.throws(
            () => [...sqlite3.iterateChangeset(garbage)],
            (err) => err instanceof Error,
        );
    });

    it('honours byteOffset on typed-array inputs', async function () {
        await db.exec("INSERT INTO t VALUES (1, 'a')");
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (2, 'b')");
        const changeset = await session.changeset();
        await session.close();

        // Embed the changeset at an offset inside a larger buffer.
        const padded = new Uint8Array(changeset.length + 8);
        padded.set(changeset, 8);
        const view = padded.subarray(8);
        const inverse = sqlite3.invertChangeset(view);
        assert.strictEqual(inverse.length, changeset.length);
    });

    it('distinguishes a patchset from a changeset', async function () {
        await db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
        const session = db.session();
        await db.exec("UPDATE t SET v = 'B' WHERE id = 1");
        const changeset = await session.changeset();
        const patchset = await session.patchset();
        await session.close();

        // A changeset stores old+new for an update; a patchset only the
        // new values plus the primary key, so it is smaller and cannot
        // detect data conflicts on non-key columns.
        assert.ok(patchset.length < changeset.length);
        const csOps = [...sqlite3.iterateChangeset(changeset)];
        const psOps = [...sqlite3.iterateChangeset(patchset)];
        assert.deepStrictEqual(csOps[0].oldRow, [1, 'a']);
        // The patchset's "old" side carries only the primary key.
        assert.deepStrictEqual(psOps[0].oldRow, [1, null]);
        assert.deepStrictEqual(psOps[0].newRow, [null, 'B']);
    });

    it('close is idempotent and later calls fail with MISUSE', async function () {
        const session = db.session();
        await session.close();
        assert.strictEqual(session.closed, true);
        await session.close(); // benign no-op
        await assert.rejects(
            () => session.changeset(),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_MISUSE');
                return true;
            },
        );
    });

    it('a session left open at close() neither crashes nor leaks', {
        timeout: 30000,
    }, async function () {
        const standalone = await openDb();
        await standalone.exec("INSERT INTO t VALUES (1, 'a')");
        const session = standalone.session();
        await standalone.exec("INSERT INTO t VALUES (2, 'b')");
        await standalone.close();
        // The connection closed the session underneath; the wrapper is
        // inert and says so.
        assert.strictEqual(session.closed, true);
        await assert.rejects(
            () => session.changeset(),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_MISUSE');
                return true;
            },
        );
        // The process still exits cleanly afterwards (a leaked session
        // handle would wedge sqlite3_close or hang teardown).
    });

    it('marking changes indirect flags them in the changeset', async function () {
        const session = db.session({ indirect: true });
        await db.exec("INSERT INTO t VALUES (1, 'a')");
        const changeset = await session.changeset();
        await session.close();
        const ops = [...sqlite3.iterateChangeset(changeset)];
        assert.strictEqual(ops[0].indirect, true);
    });

    it('using after `using` disposes the session', async function () {
        {
            using session = db.session();
            await db.exec("INSERT INTO t VALUES (1, 'a')");
            const changeset = await session.changeset();
            assert.ok(changeset.length > 0);
        }
        // Disposed: further work fails.
        const session2 = db.session();
        await session2.close();
    });
});

describe('environment teardown', function () {
    // The addon's class constructors must live in per-environment
    // instance data, not in file statics: a static Napi::Reference is
    // destroyed at process exit, after the environment is gone, so its
    // napi_delete_reference lands on a dead env. That segfaulted at exit
    // on musl while glibc and macOS tolerated it — a crash no assertion
    // inside the process can observe, so the child's exit status is the
    // test.
    it('exits cleanly with a database and session left open', {
        timeout: 15000,
    }, async function () {
        const child = execFile(
            process.execPath,
            [
                fileURLToPath(
                    new URL(
                        './support/teardown_exit_child.mjs',
                        import.meta.url,
                    ),
                ),
            ],
            { cwd: process.cwd() },
        );
        let stdout = '';
        child.stdout?.on('data', (c) => (stdout += c));
        const code = await new Promise((resolve) => {
            child.on('close', resolve);
        });
        assert.strictEqual(code, 0, `child exited with ${code}`);
        assert.match(stdout, /CHILD-EXITING/);
    });
});

describe('preupdate events', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = await openDb();
    });

    afterEach(async function () {
        await db.close();
    });

    it('INSERT gives newRow only, DELETE oldRow only, UPDATE both', async function () {
        /** @type {import('../lib/native.js').PreupdateEventInfo[]} */
        const events = [];
        db.on('preupdate', (info) => events.push(info));
        await db.exec("INSERT INTO t VALUES (1, 'a')");
        await db.exec("UPDATE t SET v = 'b' WHERE id = 1");
        await db.exec('DELETE FROM t WHERE id = 1');
        await new Promise((resolve) => setTimeout(resolve, 25));

        assert.strictEqual(events.length, 3);
        const [insert, update, remove] = events;
        assert.strictEqual(insert.op, 'insert');
        assert.strictEqual(insert.oldRow, null);
        assert.deepStrictEqual(insert.newRow, [1, 'a']);
        assert.strictEqual(insert.oldRowid, null);
        assert.strictEqual(insert.rowid, 1);

        assert.strictEqual(update.op, 'update');
        assert.deepStrictEqual(update.oldRow, [1, 'a']);
        assert.deepStrictEqual(update.newRow, [1, 'b']);
        assert.strictEqual(update.oldRowid, 1);
        assert.strictEqual(update.rowid, 1);

        assert.strictEqual(remove.op, 'delete');
        assert.deepStrictEqual(remove.oldRow, [1, 'b']);
        assert.strictEqual(remove.newRow, null);
        assert.strictEqual(remove.oldRowid, 1);
    });

    it('oldRowid differs from rowid on a rowid-changing update', async function () {
        /** @type {import('../lib/native.js').PreupdateEventInfo[]} */
        const events = [];
        db.on('preupdate', (info) => events.push(info));
        await db.exec("INSERT INTO t (rowid, v) VALUES (10, 'x')");
        await db.exec('UPDATE t SET rowid = 20 WHERE rowid = 10');
        await new Promise((resolve) => setTimeout(resolve, 25));

        const moved = events.find(
            (info) => info.op === 'update' && info.oldRowid !== info.rowid,
        );
        assert.ok(moved, 'a rowid-changing update event exists');
        assert.strictEqual(moved.oldRowid, 10);
        assert.strictEqual(moved.rowid, 20);
    });

    it('fires for the writes a changeset apply performs', async function () {
        const source = await openDb();
        await source.exec("INSERT INTO t VALUES (1, 'a')");
        const session = source.session();
        await source.exec("INSERT INTO t VALUES (2, 'b')");
        const changeset = await session.changeset();
        await session.close();

        /** @type {import('../lib/native.js').PreupdateEventInfo[]} */
        const events = [];
        db.on('preupdate', (info) => events.push(info));
        await db.applyChangeset(changeset);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(
            events.filter((info) => info.op === 'insert').length,
            1,
        );
        await source.close();
    });

    it('shares one hook slot with sessions and refuses loudly both ways', async function () {
        /** @type {import('../lib/native.js').PreupdateEventInfo[]} */
        const heard = [];
        const listener = (info) => heard.push(info);
        db.on('preupdate', listener);
        assert.throws(() => db.session(), /single preupdate hook/);
        assert.strictEqual(heard.length, 0); // nothing fired yet
        db.removeListener('preupdate', listener);

        // The other direction: a session is open, so the registration
        // fails (reported on the connection's 'error' event) instead of
        // silently stopping the session's recording.
        const session = db.session();
        await db.exec("INSERT INTO t VALUES (1, 'a')"); // session records
        const errors = [];
        db.on('error', (err) => errors.push(err));
        const heardDuringSession = [];
        db.on('preupdate', (info) => heardDuringSession.push(info));
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(errors.length, 1);
        // The rejected registration took no events (the session kept the
        // slot), so nothing arrived on the listener that lost it.
        assert.strictEqual(heardDuringSession.length, 0);
        assert.match(errors[0].message, /single preupdate hook/);

        // And the session still records — the failed registration did
        // not take the slot from it.
        const changeset = await session.changeset();
        assert.strictEqual([...sqlite3.iterateChangeset(changeset)].length, 1);
        await session.close();
    });
});
