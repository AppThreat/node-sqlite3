import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DatabaseSync } from '@appthreat/sqlite3/compat';

import { DatabaseSync as DatabaseSyncRelative } from '../lib/compat.js';
import sqlite3 from '../lib/sqlite3.js';
import { TMP_DIR } from './support/db.js';

// Phase 5: the node:sqlite compatibility shim.

describe('node:sqlite compat shim', function () {
    /** @type {DatabaseSync} */
    let db;

    beforeEach(function () {
        db = new DatabaseSync(':memory:');
    });

    afterEach(function () {
        if (db.isOpen) db.close();
    });

    it('is reachable through the package /compat subpath export', function () {
        // Regression: the package had no exports map, so the
        // '@appthreat/sqlite3/compat' specifier the README documents could
        // not resolve at all.
        assert.strictEqual(DatabaseSync, DatabaseSyncRelative);
    });

    it('opens synchronously and reports state', function () {
        assert.strictEqual(db.isOpen, true);
        assert.strictEqual(db.open, true);
        assert.strictEqual(db.isTransaction, false);
    });

    it('exec runs multi-statement scripts', function () {
        db.exec(
            'CREATE TABLE t (a);\n' +
                'INSERT INTO t VALUES (1);\n' +
                "INSERT INTO t VALUES (';not-a-boundary;');\n",
        );
        assert.deepStrictEqual(
            db.prepare('SELECT COUNT(*) AS n FROM t').get(),
            {
                n: 2,
            },
        );
    });

    it('prepare/get/all/run/iterate behave like StatementSync', function () {
        db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1), (2)');
        const stmt = db.prepare('SELECT a FROM t WHERE a = ?');
        assert.deepStrictEqual(stmt.get(2), { a: 2 });
        // Re-running reuses the last bindings (node:sqlite's semantics).
        assert.deepStrictEqual(stmt.all(), [{ a: 2 }]);
        const insert = db.prepare('INSERT INTO t VALUES (?)');
        const result = insert.run(3);
        assert.strictEqual(result.changes, 1);
        assert.strictEqual(result.lastInsertRowid, 3);
        assert.deepStrictEqual(db.prepare('SELECT a FROM t ORDER BY a').all(), [
            { a: 1 },
            { a: 2 },
            { a: 3 },
        ]);
        assert.deepStrictEqual([...stmt.iterate(1)], [{ a: 1 }]);
        insert.close();
        assert.deepStrictEqual(stmt.columns(), [
            { name: 'a', table: 't', database: 'main', column: 'a' },
        ]);
        assert.strictEqual(stmt.sourceSQL, 'SELECT a FROM t WHERE a = ?');
        assert.strictEqual(stmt.expandedSQL, 'SELECT a FROM t WHERE a = 1');
        stmt.close();
    });

    it('supports the readBigInts and returnArrays toggles', function () {
        db.exec('CREATE TABLE t (a)');
        db.prepare('INSERT INTO t VALUES (9223372036854775807)').run();
        const bigint = db.prepare('SELECT a FROM t', { readBigInts: true });
        assert.strictEqual(typeof bigint.get().a, 'bigint');
        const arrays = db.prepare('SELECT 1 AS a, 2 AS b');
        arrays.setReturnArrays(true);
        assert.deepStrictEqual(arrays.get(), [1, 2]);
    });

    it('registers functions and aggregates that run synchronously', function () {
        db.function('double', (x) => x * 2);
        const call = db.prepare('SELECT double(21) AS v');
        assert.strictEqual(call.get().v, 42);
        call.close();
        db.aggregate('total', {
            start: () => 0,
            step: (acc, v) => acc + v,
            result: (acc) => acc,
        });
        db.exec('CREATE TABLE n (x); INSERT INTO n VALUES (1), (2), (3)');
        assert.strictEqual(
            db.prepare('SELECT total(x) AS v FROM n').get().v,
            6,
        );
    });

    it('tracks transactions', function () {
        db.exec('CREATE TABLE t (a)');
        db.exec('BEGIN');
        assert.strictEqual(db.isTransaction, true);
        db.exec('COMMIT');
        assert.strictEqual(db.isTransaction, false);
    });

    it('enableDefensive toggles defensive mode', function () {
        db.exec('CREATE TABLE t (a)');
        db.enableDefensive(true);
        assert.throws(() => db.exec('CREATE TABLE sqlite_schemahack (x)'));
        db.enableDefensive(false);
    });

    it('location() and the native passthrough work', function () {
        // node:sqlite reports null for an in-memory database; the
        // package's own location() reports the empty string there.
        assert.strictEqual(db.location(), null);
        assert.strictEqual(db.native.location(), '');
        assert.ok(db.native instanceof sqlite3.Database);
    });

    it('setReadBigInts changes how columns read, not just lastInsertRowid', function () {
        db.exec('CREATE TABLE big (v INTEGER)');
        db.prepare('INSERT INTO big VALUES (?)').run(42);
        const stmt = db.prepare('SELECT v FROM big');
        assert.strictEqual(stmt.get().v, 42);
        // The integer mode belongs to the prepared statement here, so the
        // setter re-prepares; it used to silently affect nothing.
        stmt.setReadBigInts(true);
        assert.strictEqual(stmt.get().v, 42n);
        stmt.setReadBigInts(false);
        assert.strictEqual(stmt.get().v, 42);
        stmt.close();
    });

    it('setAuthorizer fails loudly with the documented alternative', function () {
        assert.throws(() => db.setAuthorizer(null), /declarative/i);
    });

    it('validates constructor and prepare options', function () {
        assert.throws(
            () => new DatabaseSync(':memory:', { bogus: 1 }),
            /unknown option 'bogus'/,
        );
        assert.throws(
            () => new DatabaseSync(':memory:', { open: false }),
            /no equivalent/,
        );
        assert.throws(
            () => db.prepare('SELECT 1', { bogus: 1 }),
            /unknown option 'bogus'/,
        );
    });

    it('loadExtension is gated by allowExtension', function () {
        assert.throws(() => db.loadExtension('whatever.so'), /allowExtension/);
        const gated = new DatabaseSync(':memory:', {
            allowExtension: true,
        });
        gated.enableLoadExtension(true);
        assert.throws(() => gated.loadExtension('nope', 'entry'), /entry/);
        gated.close();
    });

    it('close() finalizes leaked statements instead of never closing', async function () {
        // node:sqlite finalizes outstanding statements on close, and code
        // ported from it leaks prepares freely. This package refuses to
        // close while one is unfinalized (SQLITE_BUSY), and the shim used
        // to discard that error in an empty callback: nothing threw,
        // nothing was emitted, and the connection stayed open with the
        // file handle held.
        const file = join(
            TMP_DIR,
            `compat-close-${process.pid}-${Date.now()}.db`,
        );
        rmSync(file, { force: true });
        const leaky = new DatabaseSync(file);
        leaky.exec('CREATE TABLE t (a)');
        const leaked = leaky.prepare('SELECT a FROM t');
        assert.deepStrictEqual(leaked.all(), []);
        assert.ok(!leaked.finalized);

        /** @type {Error[]} */
        const errors = [];
        leaky.native.on('error', (err) => errors.push(err));
        leaky.close();
        // The close is queued; wait for it the way the divergence note says.
        await leaky.native.wait().catch(() => {
            // A wait that fails says nothing about the close; poll below.
        });
        for (let i = 0; i < 20 && leaky.isOpen; i++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.strictEqual(
            leaky.isOpen,
            false,
            'the connection must actually close',
        );
        assert.deepStrictEqual(
            errors.map((e) => e.message),
            [],
            'no error should have been needed',
        );
        assert.ok(leaked.finalized, 'the leaked statement was finalized');
        rmSync(file, { force: true });
    });

    it('close() reports a failure it cannot fix instead of swallowing it', async function () {
        // A statement prepared directly on db.native is outside the
        // shim's bookkeeping, so the close genuinely fails. The point of
        // the test is that the failure is visible.
        const bare = new DatabaseSync(':memory:');
        bare.exec('CREATE TABLE t (a)');
        const native = bare.native.prepareSync('SELECT a FROM t');
        /** @type {any[]} */
        const errors = [];
        bare.native.on('error', (err) => errors.push(err));
        bare.close();
        for (let i = 0; i < 20 && errors.length === 0; i++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.strictEqual(errors.length, 1, 'the close error must surface');
        assert.match(errors[0].message, /unfinalized statements/);
        assert.strictEqual(errors[0].code, 'SQLITE_BUSY');
        // Clean up: finalize and close for real.
        await new Promise((resolve) => native.finalize(() => resolve(null)));
        await bare.native.close();
    });

    it('await using closes a connection with statements still open', async function () {
        const file = join(
            TMP_DIR,
            `compat-dispose-${process.pid}-${Date.now()}.db`,
        );
        rmSync(file, { force: true });
        {
            await using disposed = new DatabaseSync(file);
            disposed.exec('CREATE TABLE t (a)');
            disposed.prepare('SELECT a FROM t').all();
        }
        // The file is free once the block exits: reopening and dropping
        // the table proves the handle was released.
        const reopened = new DatabaseSync(file);
        reopened.exec('DROP TABLE t');
        await reopened[Symbol.asyncDispose]();
        rmSync(file, { force: true });
    });

    it('dispose support works', function () {
        {
            using stmt = db.prepare('SELECT 1');
            assert.ok(!stmt.finalized);
        }
        // Close via the async dispose path.
        const closing = db;
        db = new DatabaseSync(':memory:');
        return closing[Symbol.asyncDispose]();
    });
});
