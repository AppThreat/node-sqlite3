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
        await local.run("INSERT INTO t VALUES (1, 'local')");
        const session = local.session({ table: 't' });
        await local.run("UPDATE t SET v = 'local2' WHERE id = 1");
        const changeset = await session.changeset();
        await session.close();

        const remote = await remoteWith('server');
        // OMIT: the remote's row wins; the rebase buffer records that.
        const rebase = await remote.applyChangeset(changeset, {
            conflict: 'omit',
            rebase: true,
        });
        assert.ok(rebase instanceof Uint8Array);
        assert.ok(rebase.length > 0);
        assert.strictEqual((await remote.get('SELECT v FROM t')).v, 'server');
        await remote.close();
    });

    it('rebases a later local changeset against the harvested resolutions', async function () {
        // Round one: the client learns its update lost to the server's.
        await local.run("INSERT INTO t VALUES (1, 'v1')");
        const session1 = local.session({ table: 't' });
        await local.run("UPDATE t SET v = 'client-edit' WHERE id = 1");
        const round1 = await session1.changeset();
        await session1.close();

        const remote = await remoteWith('server-edit');
        const rebase = await remote.applyChangeset(round1, {
            conflict: 'omit',
            rebase: true,
        });
        await remote.close();

        // Round two: the client makes a *new* local change (starting from
        // its own state) and rebases it onto the resolved history — the
        // textbook sync loop. The rebased changeset applies cleanly to
        // the server state.
        await local.run("UPDATE t SET v = 'after-rebase' WHERE id = 1");
        const session2 = local.session({ table: 't' });
        await local.run("INSERT INTO t VALUES (2, 'new-row')");
        const round2 = await session2.changeset();
        await session2.close();

        const rebased = sqlite3.rebaseChangeset(round2, rebase);
        assert.ok(rebased instanceof Uint8Array);
        assert.ok(rebased.length > 0);

        const converged = await remoteWith('server-edit');
        await converged.applyChangeset(rebased);
        // Rebase semantics: the OMIT resolution recorded in round one
        // means the client's further edit to that same row is rebased
        // away — the server's value stands. The new row (no conflict)
        // lands normally.
        assert.strictEqual(
            (await converged.get('SELECT v FROM t WHERE id = 1')).v,
            'server-edit',
        );
        assert.strictEqual(
            (await converged.get('SELECT v FROM t WHERE id = 2')).v,
            'new-row',
        );
        await converged.close();
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
