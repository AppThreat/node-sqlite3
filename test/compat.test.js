import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DatabaseSync } from '@appthreat/sqlite3/compat';

import { DatabaseSync as DatabaseSyncRelative } from '../lib/compat.js';
import sqlite3 from '../lib/sqlite3.js';

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
