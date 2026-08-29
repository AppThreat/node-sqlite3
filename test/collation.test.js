import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// User-defined collations (Deliverable 06): ordering by a JS comparator,
// COLLATE in table definitions and indexes, the sync-method gate (a
// collation cannot fail a single comparison, so the sync path must refuse
// up front), and comparator error handling.

describe('user-defined collations', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await new Promise((resolve, reject) => {
            db.once('open', resolve);
            db.once('error', reject);
        });
    });

    afterEach(async function () {
        await db.close();
    });

    it('orders ORDER BY through the comparator', async function () {
        await db.exec(
            'CREATE TABLE words (w TEXT);\n' +
                "INSERT INTO words VALUES ('zebra'), ('Ärger'), ('apple'), ('Zebra')",
        );
        db.collation('german', (a, b) => a.localeCompare(b, 'de'));
        const rows = await db.all(
            'SELECT w FROM words ORDER BY w COLLATE german',
        );
        assert.deepStrictEqual(
            rows.map((r) => r.w),
            ['apple', 'Ärger', 'zebra', 'Zebra'],
        );
        // ...while the default BINARY collation keeps Ä after Z.
        const binary = await db.all('SELECT w FROM words ORDER BY w');
        assert.deepStrictEqual(
            binary.map((r) => r.w),
            ['Zebra', 'apple', 'zebra', 'Ärger'],
        );
    });

    it('works in a COLLATE column definition', async function () {
        db.collation('german', (a, b) => a.localeCompare(b, 'de'));
        await db.exec(
            'CREATE TABLE names (w TEXT COLLATE german);\n' +
                "INSERT INTO names VALUES ('z'), ('ä'), ('a')",
        );
        const rows = await db.all('SELECT w FROM names ORDER BY w');
        assert.deepStrictEqual(
            rows.map((r) => r.w),
            ['a', 'ä', 'z'],
        );
    });

    it('works in an index and orders through it', async function () {
        db.collation('german', (a, b) => a.localeCompare(b, 'de'));
        await db.exec(
            'CREATE TABLE words (w TEXT);\n' +
                "INSERT INTO words VALUES ('zebra'), ('Ärger'), ('apple')",
        );
        await db.exec('CREATE INDEX idx ON words (w COLLATE german)');
        const plan = await db.all(
            'EXPLAIN QUERY PLAN SELECT w FROM words ORDER BY w COLLATE german',
        );
        assert.match(
            plan.map((r) => Object.values(r).join(' ')).join(' '),
            /USING (COVERING )?INDEX idx/,
        );
        const rows = await db.all(
            'SELECT w FROM words ORDER BY w COLLATE german',
        );
        assert.deepStrictEqual(
            rows.map((r) => r.w),
            ['apple', 'Ärger', 'zebra'],
        );
    });

    it('receives numeric and blob values as text', async function () {
        await db.exec(
            'CREATE TABLE mixed (v);\n' +
                "INSERT INTO mixed VALUES (10), (9), (2.5), ('x')",
        );
        // The collation receives the values converted to text.
        const kinds = new Set();
        db.collation('spy', (a, b) => {
            kinds.add(typeof a);
            return a < b ? -1 : a > b ? 1 : 0;
        });
        const rows = await db.all(
            'SELECT v FROM mixed ORDER BY CAST(v AS TEXT) COLLATE spy',
        );
        assert.ok(kinds.has('string'));
        assert.strictEqual(rows.length, 4);
    });

    it('blocks the sync methods while registered, and restores them after removal', async function () {
        await db.exec('CREATE TABLE t (x INT); INSERT INTO t VALUES (1)');
        db.collation('any', (a, b) => (a < b ? -1 : 1));
        assert.throws(
            () => db.getSync('SELECT x FROM t'),
            (err) =>
                /sync methods cannot be used while a JavaScript collation/.test(
                    err.message,
                ) && /deadlock/.test(err.message),
        );
        assert.throws(() => db.runSync('SELECT 1'));
        assert.throws(() => db.allSync('SELECT 1'));
        // The async API keeps working, collation included.
        const rows = await db.all(
            "SELECT 'b' AS v UNION ALL SELECT 'a' ORDER BY 1 COLLATE any",
        );
        assert.strictEqual(rows.length, 2);
        db.removeCollation('any');
        assert.strictEqual(db.getSync('SELECT x FROM t').x, 1);
        // Removing an unknown name is a no-op.
        db.removeCollation('never');
    });

    it('aborts the query when the comparator throws, with cause', async function () {
        const boom = new Error('comparator explosion');
        await db.exec(
            'CREATE TABLE t (w TEXT);\n' +
                "INSERT INTO t VALUES ('c'), ('a'), ('b'), ('d'), ('e'), ('f'), ('g'), ('h')",
        );
        db.collation('bad', (_a, _b) => {
            throw boom;
        });
        // The query dies with SQLITE_INTERRUPT (the only way to keep a
        // failed comparison from producing wrongly-ordered rows) and the
        // thrown error is attached as the cause.
        await assert.rejects(
            db.all('SELECT w FROM t ORDER BY w COLLATE bad'),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_INTERRUPT');
                assert.strictEqual(err.cause, boom);
                return true;
            },
        );
        // The async API still works (the sync methods are gated while a
        // collation is registered).
        assert.strictEqual((await db.get('SELECT 1 AS v')).v, 1);
    });

    it('aborts the query when the comparator returns a non-number', async function () {
        await db.exec(
            'CREATE TABLE t (w TEXT);\n' +
                "INSERT INTO t VALUES ('c'), ('a'), ('b'), ('d'), ('e'), ('f'), ('g'), ('h')",
        );
        db.collation('stringy', () => 'less');
        await assert.rejects(
            db.all('SELECT w FROM t ORDER BY w COLLATE stringy'),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_INTERRUPT');
                assert.match(err.cause.message, /must return a number/);
                return true;
            },
        );
    });

    it('handles numeric comparator results by sign', async function () {
        await db.exec(
            'CREATE TABLE t (w TEXT);\n' +
                "INSERT INTO t VALUES ('bb'), ('a'), ('ccc')",
        );
        // Length-first ordering via arbitrary-magnitude numbers.
        db.collation('len', (a, b) => a.length - b.length);
        const rows = await db.all('SELECT w FROM t ORDER BY w COLLATE len');
        assert.deepStrictEqual(
            rows.map((r) => r.w),
            ['a', 'bb', 'ccc'],
        );
    });

    it('validates name and comparator, and chains', function () {
        assert.throws(() => db.collation(''), /non-empty name/);
        assert.throws(() => db.collation('x'), /comparator function/);
        assert.throws(() => db.removeCollation(''), /non-empty name/);
        const returned = db.collation('ok', (a, b) => a.localeCompare(b));
        assert.strictEqual(returned, db);
    });

    it('replaces a collation registration', async function () {
        await db.exec(
            'CREATE TABLE t (w TEXT);\n' +
                "INSERT INTO t VALUES ('b'), ('a'), ('c')",
        );
        db.collation('ord', (a, b) => a.localeCompare(b));
        db.collation('ord', (a, b) => b.localeCompare(a));
        const rows = await db.all('SELECT w FROM t ORDER BY w COLLATE ord');
        assert.deepStrictEqual(
            rows.map((r) => r.w),
            ['c', 'b', 'a'],
        );
    });
});
