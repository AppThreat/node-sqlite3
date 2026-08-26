import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// The declarative authorizer (Deliverable 07): the policy is evaluated
// in C++ inside sqlite3_prepare — no JavaScript runs on the prepare
// path — which is what makes it safe on any thread. deny wins over
// allow, the statement cache is flushed on change (a cached statement
// was compiled under the old policy), and removal restores access.

describe('authorizer', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await new Promise((resolve, reject) => {
            db.once('open', resolve);
            db.once('error', reject);
        });
        await db.exec(
            'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n' +
                "INSERT INTO users (name) VALUES ('alice'), ('bob');\n" +
                'CREATE TABLE secrets (token TEXT);\n' +
                "INSERT INTO secrets (token) VALUES ('hunter2')",
        );
    });

    afterEach(async function () {
        await db.close();
    });

    it('deny-by-default blocks SELECT', async function () {
        db.authorizer({ default: 'deny' });
        await assert.rejects(
            db.all('SELECT * FROM users'),
            (err) =>
                err.code === 'SQLITE_AUTH' &&
                /not authorized/.test(err.message),
        );
    });

    it('a targeted allow permits reading exactly one table', async function () {
        db.authorizer({
            default: 'deny',
            allow: [
                { action: sqlite3.SELECT },
                { action: sqlite3.READ, table: 'users' },
            ],
        });
        const rows = await db.all('SELECT name FROM users');
        assert.deepStrictEqual(
            rows.map((r) => r.name),
            ['alice', 'bob'],
        );
        await assert.rejects(
            db.all('SELECT token FROM secrets'),
            (err) => err.code === 'SQLITE_AUTH',
        );
    });

    it('deny overrides allow regardless of rule order', async function () {
        db.authorizer({
            default: 'allow',
            allow: [{ action: sqlite3.READ, table: 'users' }],
            deny: [{ action: sqlite3.READ, table: 'users' }],
        });
        await assert.rejects(
            db.all('SELECT * FROM users'),
            (err) => err.code === 'SQLITE_AUTH',
        );
    });

    it('blocks writes while allowing reads', async function () {
        db.authorizer({
            default: 'deny',
            allow: [
                { action: sqlite3.SELECT },
                { action: sqlite3.READ, table: 'users' },
                { action: sqlite3.FUNCTION },
            ],
        });
        await assert.rejects(
            db.run("INSERT INTO users (name) VALUES ('eve')"),
            (err) => err.code === 'SQLITE_AUTH',
        );
        // The blocked insert really did not land.
        const row = await db.get('SELECT count(*) AS n FROM users');
        assert.strictEqual(row.n, 2);
    });

    it('deny-by-default also gates SQL functions', async function () {
        db.authorizer({
            default: 'deny',
            allow: [
                { action: sqlite3.SELECT },
                { action: sqlite3.READ, table: 'users' },
            ],
        });
        // count(*) is an SQLITE_FUNCTION action; without an allow rule
        // sqlite refuses it, naming the function.
        await assert.rejects(db.get('SELECT count(*) AS n FROM users'), (err) =>
            /not authorized to use function: count/.test(err.message),
        );
    });

    it('denies ATTACH', async function () {
        db.authorizer({ default: 'allow', deny: [{ action: sqlite3.ATTACH }] });
        await assert.rejects(
            db.exec("ATTACH ':memory:' AS extra"),
            (err) => err.code === 'SQLITE_AUTH',
        );
    });

    it('deny also blocks the second statement of a batch', async function () {
        db.authorizer({
            default: 'deny',
            allow: [{ action: sqlite3.READ, table: 'users' }],
        });
        await assert.rejects(
            db.exec('SELECT * FROM users; SELECT * FROM secrets;'),
            (err) => err.code === 'SQLITE_AUTH',
        );
    });

    it('ignore hides a table instead of erroring', async function () {
        // SQLITE_IGNORE on a READ makes the table read as empty/missing
        // columns rather than failing the statement.
        db.authorizer({
            default: 'allow',
            ignore: [{ action: sqlite3.READ, table: 'secrets' }],
        });
        const rows = await db.all('SELECT * FROM secrets');
        // The column reads as NULL for every row: ignored, not an error.
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].token, null);
    });

    it('a rule can match on a column', async function () {
        db.authorizer({
            default: 'deny',
            allow: [
                { action: sqlite3.SELECT },
                { action: sqlite3.READ, table: 'users', column: 'name' },
            ],
        });
        const rows = await db.all('SELECT name FROM users');
        assert.deepStrictEqual(
            rows.map((r) => r.name),
            ['alice', 'bob'],
        );
        // Reading the other column is still denied.
        await assert.rejects(
            db.all('SELECT id FROM users'),
            (err) => err.code === 'SQLITE_AUTH',
        );
    });

    it('flushes the statement cache on install', async function () {
        // A cached statement was compiled under the old policy; keeping
        // it usable would bypass the sandbox entirely.
        db.cacheStatements();
        await db.all('SELECT * FROM secrets'); // primes the cache
        db.authorizer({ default: 'deny' });
        await assert.rejects(
            db.all('SELECT * FROM secrets'),
            (err) => err.code === 'SQLITE_AUTH',
        );
    });

    it('removal restores access', async function () {
        db.authorizer({ default: 'deny' });
        await assert.rejects(db.all('SELECT 1'));
        db.authorizer(null);
        const row = await db.get('SELECT count(*) AS n FROM users');
        assert.strictEqual(row.n, 2);
    });

    it('applies to synchronous prepares too (the policy runs in C++)', async function () {
        db.authorizer({
            default: 'deny',
            allow: [
                { action: sqlite3.SELECT },
                { action: sqlite3.READ, table: 'users' },
            ],
        });
        assert.throws(
            () => db.prepareSync('SELECT * FROM secrets'),
            (err) => err.code === 'SQLITE_AUTH',
        );
        const stmt = db.prepareSync('SELECT name FROM users');
        assert.strictEqual(stmt.getSync().name, 'alice');
        stmt.finalize();
    });

    it('malformed policies are rejected with the offending name', async function () {
        assert.throws(
            () => db.authorizer({ default: 'maybe' }),
            /default must be/,
        );
        assert.throws(
            () => /** @type {any} */ (db).authorizer({ allow: 'nope' }),
            /'allow' must be an array/,
        );
        assert.throws(
            () => db.authorizer({ allow: [{ action: 'SELECT' }] }),
            /allow\[0\] action must be an integer/,
        );
        assert.throws(
            () => db.authorizer({ unknown: true }),
            /unknown option 'unknown'/,
        );
    });

    it('exports the authorizer action constants', async function () {
        // Values are the sqlite authorizer codes; pin a representative
        // spread so a renumbering cannot slip through.
        assert.strictEqual(sqlite3.SELECT, 21);
        assert.strictEqual(sqlite3.READ, 20);
        assert.strictEqual(sqlite3.INSERT, 18);
        assert.strictEqual(sqlite3.DELETE, 9);
        assert.strictEqual(sqlite3.ATTACH, 24);
        assert.strictEqual(sqlite3.RECURSIVE, 33);
        assert.strictEqual(sqlite3.DENY, 1);
        assert.strictEqual(sqlite3.IGNORE, 2);
        assert.strictEqual(sqlite3.OK, 0);
    });

    it('a policy change takes effect for newly prepared statements', async function () {
        db.authorizer({ default: 'deny' });
        await assert.rejects(db.all('SELECT 1'));
        db.authorizer({ default: 'allow' });
        const row = await db.get('SELECT 1 AS v');
        assert.strictEqual(row.v, 1);
    });
});
