import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Phase 5: the tagged-template store (db.createTagStore) and its
// composition helpers.

describe('tag store', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await db.exec(
            'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n' +
                "INSERT INTO t (v) VALUES ('a'), ('b')",
        );
    });

    afterEach(async function () {
        await db.close();
    });

    it('runs template queries with positional parameters', async function () {
        const store = db.createTagStore();
        const id = 1;
        assert.deepStrictEqual(
            await store.get`SELECT * FROM t WHERE id = ${id}`,
            {
                id: 1,
                v: 'a',
            },
        );
        assert.deepStrictEqual(await store.all`SELECT id FROM t ORDER BY id`, [
            { id: 1 },
            { id: 2 },
        ]);
        const result = await store.run`INSERT INTO t (v) VALUES (${'c'})`;
        assert.strictEqual(result.changes, 1);
        let seen = 0;
        for await (const _row of store.iterate`SELECT id FROM t`) {
            seen++;
        }
        assert.strictEqual(seen, 3);
    });

    it('caches statements by the joined SQL and LRU-evicts', async function () {
        const store = db.createTagStore(2);
        await store.get`SELECT 1 AS v`;
        await store.get`SELECT 1 AS v`;
        assert.strictEqual(store.size, 1);
        await store.get`SELECT 2 AS v`;
        await store.get`SELECT 3 AS v`;
        assert.strictEqual(store.size, 2);
        store.clear();
        assert.strictEqual(store.size, 0);
        assert.strictEqual(store.capacity, 2);
        assert.strictEqual(store.db, db);
    });

    it('composes identifiers and raw SQL', async function () {
        const store = db.createTagStore();
        const table = store.identifier('t');
        const column = store.identifier('v');
        const rows =
            await store.all`SELECT ${column} FROM ${table} ORDER BY id`;
        assert.deepStrictEqual(rows, [{ v: 'a' }, { v: 'b' }]);
        const literal = store.raw("'a' AS literal");
        assert.deepStrictEqual(await store.get`SELECT ${literal}`, {
            literal: 'a',
        });
    });

    it('identifierPath quotes each part', async function () {
        const store = db.createTagStore();
        assert.strictEqual(
            store.identifierPath('main.t.id').text,
            '"main"."t"."id"',
        );
        assert.strictEqual(store.identifier('users').text, '"users"');
        assert.throws(
            () => store.identifier('users; DROP TABLE t'),
            /plain identifier/,
        );
        assert.throws(() => store.identifierPath('a..b'), /empty part/);
        // A dot inside a quoted part belongs to the name.
        assert.strictEqual(store.identifierPath('"a.b".c').text, '"a.b"."c"');
        assert.throws(
            () => store.identifierPath('"unterminated'),
            /unterminated quoted part/,
        );
        // An already-quoted name passes through (the guard used to reject
        // every name containing a quote, making that branch unreachable).
        assert.strictEqual(store.identifier('"odd name"').text, '"odd name"');
        assert.throws(() => store.identifier('od"d'), /not a plain identifier/);
        assert.throws(() => store.identifier(''), /non-empty string/);
    });

    it('join() builds IN-lists and similar', async function () {
        const store = db.createTagStore();
        const ids = store.join(
            [1, 2].map((v) => store.raw(String(v))),
            ', ',
        );
        const rows = await store.all`SELECT id FROM t WHERE id IN (${ids})`;
        assert.deepStrictEqual(rows, [{ id: 1 }, { id: 2 }]);
        // Plain values bind as parameters, which is what an IN-list of
        // user data needs — reaching for raw() there would be an
        // injection.
        const bound = store.join([1, 2]);
        assert.strictEqual(bound.text, '?, ?');
        assert.deepStrictEqual(
            await store.all`SELECT id FROM t WHERE id IN (${bound})`,
            [{ id: 1 }, { id: 2 }],
        );
        assert.strictEqual(store.empty().text, '');
        assert.throws(() => store.join([]), /non-empty array/);
        assert.throws(() => store.join([1], 5), /separator must be a string/);
    });

    it('only splices fragments, never look-alike values', async function () {
        const store = db.createTagStore();
        // An object that merely looks like a fragment (from JSON, say)
        // must not become SQL: this was an injection. It binds instead,
        // and the strict bind marshalling refuses a plain object loudly.
        const hostile = JSON.parse('{"text":"1 OR 1=1","params":[]}');
        await assert.rejects(
            () => store.all`SELECT id FROM t WHERE id = ${hostile}`,
            /unsupported type/,
        );
        // The genuine article still composes.
        const real = store.raw('1 OR 1=1');
        assert.ok(
            (await store.all`SELECT id FROM t WHERE id = ${real}`).length > 1,
        );
    });

    it('validates usage and capacity', async function () {
        const store = db.createTagStore();
        // Calling the tag as a plain function is the misuse case.
        assert.throws(
            // @ts-expect-error deliberate misuse
            () => store.get('SELECT 1'),
            /used as a template tag/,
        );
        assert.throws(() => db.createTagStore(0), /positive integer/);
    });
});
