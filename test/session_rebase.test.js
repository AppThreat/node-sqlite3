import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Phase 3: changeset rebasing (the client-server sync primitive no other
// JS driver exposes) and session.diff.

describe('changeset rebasing', function () {
    /** @type {sqlite3.Database} */
    let local;

    beforeEach(async function () {
        local = new sqlite3.Database(':memory:');
        await local.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    });

    afterEach(async function () {
        await local.close();
    });

    /**
     * Builds a database with t(1, 'server') — a "remote" that already
     * applied a conflicting change.
     *
     * @param {string} value the row's v.
     * @returns {Promise<sqlite3.Database>} the remote connection.
     */
    async function remoteWith(value) {
        const remote = new sqlite3.Database(':memory:');
        await remote.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        await remote.run('INSERT INTO t VALUES (1, ?)', value);
        return remote;
    }

    it('harvests a rebase buffer from a conflicting apply', async function () {
        // The buffer is produced by whichever site *applies* an incoming
        // changeset and resolves conflicts: it records what that site
        // decided, so the decisions do not have to be made again
        // elsewhere in the network.
        await local.run("INSERT INTO t VALUES (1, 'local')");
        const session = local.session({ table: 't' });
        await local.run("UPDATE t SET v = 'local2' WHERE id = 1");
        const changeset = await session.changeset();
        await session.close();

        const remote = await remoteWith('server');
        // OMIT: the applying site's row wins; the rebase buffer records that.
        const rebase = await remote.applyChangeset(changeset, {
            conflict: 'omit',
            rebase: true,
        });
        assert.ok(rebase instanceof Uint8Array);
        assert.ok(rebase.length > 0);
        assert.strictEqual((await remote.get('SELECT v FROM t')).v, 'server');
        await remote.close();
    });

    it('rebases the local changeset against an incoming apply, so it lands cleanly upstream', async function () {
        // The sync loop the rebaser exists for, in SQLite's own terms:
        // this site is at S0, records local work (S0 → S1), then receives
        // a changeset based on S0 from a peer and applies it *here*,
        // resolving conflicts. Rebasing the local changeset against the
        // resolutions makes it apply cleanly at the peer — no second
        // conflict to resolve there.
        //
        // Direction matters and is easy to get backwards: the buffer must
        // come from the apply performed on *this* database, and the
        // changeset rebased must be the one recorded *before* that apply.
        await local.run("INSERT INTO t VALUES (1, 'v0')");

        // The peer: same S0, its own edit, its changeset.
        const peer = new sqlite3.Database(':memory:');
        await peer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        await peer.run("INSERT INTO t VALUES (1, 'v0')");
        const peerSession = peer.session({ table: 't' });
        await peer.run("UPDATE t SET v = 'remote-edit' WHERE id = 1");
        const remoteChangeset = await peerSession.changeset();
        await peerSession.close();

        // This site's own work, recorded before the peer's changeset arrives.
        const localSession = local.session({ table: 't' });
        await local.run("UPDATE t SET v = 'local-edit' WHERE id = 1");
        await local.run("INSERT INTO t VALUES (2, 'local-row')");
        const localChangeset = await localSession.changeset();
        await localSession.close();

        // Apply the peer's changeset here, keeping the local value.
        const rebase = await local.applyChangeset(remoteChangeset, {
            conflict: 'omit',
            rebase: true,
        });
        assert.ok(rebase instanceof Uint8Array);
        assert.strictEqual(
            (await local.get('SELECT v FROM t')).v,
            'local-edit',
        );

        // Un-rebased, the local changeset cannot be applied at the peer:
        // its old values say 'v0' and the peer holds 'remote-edit'.
        await assert.rejects(
            peer.applyChangeset(localChangeset),
            /SQLITE_ABORT/,
        );
        assert.strictEqual(
            (await peer.get('SELECT v FROM t')).v,
            'remote-edit',
        );

        // Rebased, the conflicting change's old values are rewritten to
        // the values the OMIT left in place at the peer…
        const rebased = sqlite3.rebaseChangeset(localChangeset, rebase);
        const ops = [...sqlite3.iterateChangeset(rebased)];
        assert.deepStrictEqual(
            ops.map((op) => op.op),
            ['update', 'insert'],
        );
        assert.deepStrictEqual(ops[0].oldRow, [1, 'remote-edit']);
        assert.deepStrictEqual(ops[0].newRow, [null, 'local-edit']);

        // …so it applies with no conflict handler at all, and the
        // non-conflicting insert rides along.
        await peer.applyChangeset(rebased);
        assert.strictEqual(
            (await peer.get('SELECT v FROM t WHERE id = 1')).v,
            'local-edit',
        );
        assert.strictEqual(
            (await peer.get('SELECT v FROM t WHERE id = 2')).v,
            'local-row',
        );
        await peer.close();
    });

    it('rewrites by primary key, so only changesets recorded before the apply may be rebased', async function () {
        // The matching rule, pinned because getting it wrong is silent:
        // the rebaser finds a buffer entry by *primary key* and rewrites
        // the change's old values to the ones the buffer carries. It does
        // not check that the change was recorded before the apply — so a
        // changeset recorded afterwards is rewritten just the same, and
        // its old values then describe a state the peer left behind two
        // pushes ago. One buffer belongs to the changesets recorded
        // before its apply; later work needs its own round.
        await local.run("INSERT INTO t VALUES (1, 'v0')");
        const incoming = new sqlite3.Database(':memory:');
        await incoming.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        await incoming.run("INSERT INTO t VALUES (1, 'v0')");
        const incomingSession = incoming.session({ table: 't' });
        await incoming.run("UPDATE t SET v = 'remote-edit' WHERE id = 1");
        const remoteChangeset = await incomingSession.changeset();
        await incomingSession.close();
        await incoming.close();

        const before = local.session({ table: 't' });
        await local.run("UPDATE t SET v = 'local-edit' WHERE id = 1");
        const recordedBefore = await before.changeset();
        await before.close();

        const rebase = await local.applyChangeset(remoteChangeset, {
            conflict: 'omit',
            rebase: true,
        });

        // Recorded after the apply: its own old values are 'local-edit',
        // the state this database is actually in.
        const after = local.session({ table: 't' });
        await local.run("UPDATE t SET v = 'later-edit' WHERE id = 1");
        const recordedAfter = await after.changeset();
        await after.close();
        assert.deepStrictEqual(
            [...sqlite3.iterateChangeset(recordedAfter)][0].oldRow,
            [1, 'local-edit'],
        );

        // Rebased against the same buffer, both changesets have their old
        // values replaced by 'remote-edit' — correct for the first,
        // wrong for the second (a peer that already received the first
        // push holds 'local-edit').
        assert.deepStrictEqual(
            [
                ...sqlite3.iterateChangeset(
                    sqlite3.rebaseChangeset(recordedBefore, rebase),
                ),
            ][0].oldRow,
            [1, 'remote-edit'],
        );
        assert.deepStrictEqual(
            [
                ...sqlite3.iterateChangeset(
                    sqlite3.rebaseChangeset(recordedAfter, rebase),
                ),
            ][0].oldRow,
            [1, 'remote-edit'],
        );
    });

    it('resolves undefined (no rebase) when no conflicts occurred', async function () {
        await local.run("INSERT INTO t VALUES (1, 'only-client')");
        const session = local.session({ table: 't' });
        const changeset = await session.changeset();
        await session.close();

        const remote = await remoteWith('anything');
        const rebase = await remote.applyChangeset(changeset, {
            rebase: true,
        });
        // No conflicts: nothing to rebase against.
        assert.strictEqual(rebase, null);
        await remote.close();
    });

    it('rebaseChangeset validates its inputs', function () {
        assert.throws(() => sqlite3.rebaseChangeset(7), TypeError);
        assert.throws(
            () => sqlite3.rebaseChangeset(new Uint8Array(4), 7),
            TypeError,
        );
    });

    it('validates the { rebase } option', async function () {
        await assert.rejects(
            local.applyChangeset(new Uint8Array(0), {
                rebase: 'yes',
            }),
            /'rebase' must be a boolean/,
        );
    });
});

describe('session.diff()', function () {
    it('records the differences between two attached databases', async function () {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'diff-'));
        const mainPath = path.join(dir, 'main.db');
        const otherPath = path.join(dir, 'other.db');
        try {
            const main = new sqlite3.Database(mainPath);
            await main.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v)');
            await main.exec(
                "INSERT INTO t VALUES (1, 'same'), (2, 'old'), (3, 'gone')",
            );
            await main.close();

            const other = new sqlite3.Database(otherPath);
            await other.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v)');
            await other.exec(
                "INSERT INTO t VALUES (1, 'same'), (2, 'new'), (4, 'added')",
            );
            await other.close();

            const db = new sqlite3.Database(mainPath);
            await db.exec(`ATTACH '${otherPath}' AS other`);
            const session = db.session({ table: 't' });
            await session.diff('t', 'other');
            const changeset = await session.changeset();
            await session.close();
            assert.ok(changeset.length > 0);

            /** @type {any[]} */
            const changes = [];
            for (const change of sqlite3.iterateChangeset(changeset)) {
                changes.push(change);
            }
            const byId = new Map(
                changes.map((c) => [c.newRow?.[0] ?? c.oldRow?.[0], c.op]),
            );
            // The recorded changeset transforms `other`'s table into
            // `main`'s: row 2 must be UPDATEd back to 'old', row 3
            // (main-only) INSERTed, row 4 (other-only) DELETEd; row 1
            // matches and is absent.
            assert.strictEqual(byId.get(2), 'update');
            assert.strictEqual(byId.get(3), 'insert');
            assert.strictEqual(byId.get(4), 'delete');
            assert.strictEqual(byId.has(1), false);
            await db.close();
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it('reports schema mismatches loudly', async function () {
        const db = new sqlite3.Database(':memory:');
        await db.exec(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v);\nATTACH ':memory:' AS other",
        );
        const session = db.session({ table: 't' });
        await assert.rejects(
            new Promise((_, reject) => {
                session.diff('t', 'other', (err) => reject(err));
            }),
            /no such table/i,
        );
        await session.close();
        await db.close();
    });
});
