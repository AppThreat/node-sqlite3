import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Statement and database introspection (Deliverable 07): the statement
// accessors serve a snapshot taken at prepare time (they never touch the
// sqlite handle at read time), status() reads live counters, and the
// database exposes the 64-bit change counters, table metadata and the
// safe db_config switches.

describe('statement introspection', function () {
    /** @type {sqlite3.Database} */
    let db;
    /** @type {sqlite3.Statement[]} */
    let prepared;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        prepared = [];
        await new Promise((resolve, reject) => {
            db.once('open', resolve);
            db.once('error', reject);
        });
        await db.exec(
            'CREATE TABLE user (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL);\n' +
                'CREATE TABLE dept (id INTEGER PRIMARY KEY, label TEXT);\n' +
                "INSERT INTO user (name, score) VALUES ('alice', 1.5), ('bob', 2.5)",
        );
    });

    afterEach(async function () {
        for (const stmt of prepared) {
            if (!stmt.finalized) {
                await new Promise((resolve, reject) => {
                    stmt.finalize((err) => (err ? reject(err) : resolve()));
                });
            }
        }
        await db.close();
    });

    /** Resolves a statement once its asynchronous prepare has finished. */
    async function prepare(sql) {
        return await new Promise((resolve, reject) => {
            const stmt = db.prepare(sql, function (err) {
                if (err) reject(err);
                else resolve(this);
            });
            prepared.push(stmt);
        });
    }

    it('readonly is true for SELECT and false for INSERT', async function () {
        const select = await prepare('SELECT * FROM user');
        assert.strictEqual(select.readonly, true);
        const insert = await prepare('INSERT INTO user (name) VALUES (?)');
        assert.strictEqual(insert.readonly, false);
    });

    it('parameterCount counts every form', async function () {
        // ?N explicitly selects its index, so it does not add a new one.
        assert.strictEqual(
            (await prepare('SELECT :a, @b, $c, ?')).parameterCount,
            4,
        );
        assert.strictEqual((await prepare('SELECT ?1, ?2')).parameterCount, 2);
        assert.strictEqual((await prepare('SELECT 1')).parameterCount, 0);
    });

    it('parameterNames reports names, null for positional', async function () {
        const stmt = await prepare('SELECT :a, @b, $c, ?');
        assert.deepStrictEqual(stmt.parameterNames, [':a', '@b', '$c', null]);
        // The array is index-ordered: ?2 appears first in the SQL but
        // occupies index 2.
        const numbered = await prepare('SELECT ?2, ?1');
        assert.deepStrictEqual(numbered.parameterNames, ['?1', '?2']);
    });

    it('columns carries declaredType, database, table and origin', async function () {
        const stmt = await prepare('SELECT name, score FROM user');
        assert.deepStrictEqual(stmt.columns, [
            {
                name: 'name',
                declaredType: 'TEXT',
                database: 'main',
                table: 'user',
                origin: 'name',
            },
            {
                name: 'score',
                declaredType: 'REAL',
                database: 'main',
                table: 'user',
                origin: 'score',
            },
        ]);
    });

    it('an aliased column keeps its origin and declared type', async function () {
        const stmt = await prepare('SELECT name AS who FROM user');
        assert.deepStrictEqual(stmt.columns, [
            {
                name: 'who',
                declaredType: 'TEXT',
                database: 'main',
                table: 'user',
                origin: 'name',
            },
        ]);
    });

    it('expression columns carry only a name', async function () {
        const stmt = await prepare('SELECT count(*) AS n, 1 + 1 FROM user');
        // Absent fields, not nulls: an expression has no declared type
        // and no origin.
        assert.deepStrictEqual(stmt.columns[0], { name: 'n' });
        assert.deepStrictEqual(Object.keys(stmt.columns[1]), ['name']);
    });

    it('a join reports each column’s own table', async function () {
        await db.exec(
            "INSERT INTO dept (label) VALUES ('eng'); UPDATE user SET score = 1 WHERE name = 'alice'",
        );
        const stmt = await prepare(
            'SELECT user.name, dept.label FROM user JOIN dept ON dept.id = user.id',
        );
        assert.strictEqual(stmt.columns[0].table, 'user');
        assert.strictEqual(stmt.columns[1].table, 'dept');
    });

    // The snapshot is taken on the libuv worker that prepares, but it is
    // published on the JS thread, in the async-work completion. Were it
    // published by the worker, a getter called inside the prepare window
    // would read fields another thread is still writing — a std::vector
    // mid-push_back, not merely a stale bool. Looping makes that visible:
    // a single prepare samples the window once and passes ~85% of the
    // time even when publication is unsynchronised.
    it('accessors are undefined until the prepare completes', async function () {
        for (let i = 0; i < 200; i++) {
            // Distinct SQL each time so no cache can serve it synchronously.
            // The callback is the completion signal: waiting on it rather
            // than on a timer keeps this deterministic on a loaded runner.
            let done;
            const finished = new Promise((resolve) => {
                done = resolve;
            });
            const stmt = db.prepare(`SELECT ${i} AS n, ?`, done);
            prepared.push(stmt);
            // Still on the tick that issued the prepare, so no callback
            // can have run: the snapshot must not be visible yet.
            assert.strictEqual(stmt.readonly, undefined);
            assert.strictEqual(stmt.parameterCount, undefined);
            assert.strictEqual(stmt.parameterNames, undefined);
            assert.strictEqual(stmt.columns, undefined);
            await finished;
            assert.strictEqual(stmt.readonly, true);
            assert.strictEqual(stmt.parameterCount, 1);
        }
    });

    it('the snapshot survives finalize', async function () {
        const stmt = await prepare('SELECT name FROM user');
        await new Promise((resolve, reject) => {
            stmt.finalize((err) => (err ? reject(err) : resolve()));
        });
        assert.strictEqual(stmt.finalized, true);
        assert.strictEqual(stmt.columns[0].table, 'user');
    });

    it('status counts fullscan steps for an unindexed scan', async function () {
        await db.exec(
            'CREATE TABLE big (a);\n' +
                'INSERT INTO big VALUES ' +
                Array.from({ length: 200 }, (_, i) => `(${i})`).join(','),
        );
        const stmt = await prepare('SELECT * FROM big WHERE a = 199');
        assert.strictEqual(stmt.status(sqlite3.STMTSTATUS_FULLSCAN_STEP), 0);
        await stmt.all();
        const fullscan = stmt.status(sqlite3.STMTSTATUS_FULLSCAN_STEP);
        // A full scan of 200 rows reports ~199 steps; an indexed lookup
        // would report 0. Keep the bound clear of both.
        assert.ok(fullscan >= 100, `fullscan steps: ${fullscan}`);
        // reset zeroes the counter.
        assert.strictEqual(
            stmt.status(sqlite3.STMTSTATUS_FULLSCAN_STEP, true),
            fullscan,
        );
        assert.strictEqual(stmt.status(sqlite3.STMTSTATUS_FULLSCAN_STEP), 0);
    });

    it('status refuses a finalized statement', async function () {
        const stmt = await prepare('SELECT 1');
        await new Promise((resolve, reject) => {
            stmt.finalize((err) => (err ? reject(err) : resolve()));
        });
        assert.throws(
            () => stmt.status(sqlite3.STMTSTATUS_RUN),
            /already finalized/,
        );
    });
});

describe('database introspection', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await new Promise((resolve, reject) => {
            db.once('open', resolve);
            db.once('error', reject);
        });
        await db.exec(
            "CREATE TABLE t (a INTEGER PRIMARY KEY AUTOINCREMENT, b TEXT NOT NULL DEFAULT 'x', c COLLATE NOCASE)",
        );
    });

    afterEach(async function () {
        await db.close();
    });

    it('changes tracks the last statement, totalChanges accumulates', async function () {
        assert.strictEqual(db.changes, 0);
        assert.strictEqual(db.totalChanges, 0);

        await db.run("INSERT INTO t (b) VALUES ('one')");
        assert.strictEqual(db.changes, 1);
        assert.strictEqual(db.totalChanges, 1);

        await db.run("INSERT INTO t (b) VALUES ('two'), ('three')");
        assert.strictEqual(db.changes, 2);
        assert.strictEqual(db.totalChanges, 3);

        await db.run('UPDATE t SET b = ?', 'nine');
        assert.strictEqual(db.changes, 3);
        assert.strictEqual(db.totalChanges, 6);

        // A read between writes does not reset `changes`: like
        // sqlite3_changes64, it reports the most recent data-modifying
        // statement.
        await db.get('SELECT 1');
        assert.strictEqual(db.changes, 3);
        assert.strictEqual(db.totalChanges, 6);
    });

    it('changes follows the integer mode', async function () {
        await db.run("INSERT INTO t (b) VALUES ('x')");
        db.configure('integerMode', 'bigint');
        assert.strictEqual(db.changes, 1n);
        db.configure('integerMode', 'number');
    });

    it('totalChanges is exact past 2^31 via the bigint mode', async function () {
        // The whole point of sqlite3_total_changes64: exercising a real
        // 2^31-row table is too slow, but the type is the contract.
        db.configure('integerMode', 'bigint');
        assert.strictEqual(typeof db.totalChanges, 'bigint');
        db.configure('integerMode', 'number');
    });

    it('tableInfo reports columns with metadata', async function () {
        const columns = await db.tableInfo('t');
        assert.strictEqual(columns.length, 3);
        assert.deepStrictEqual(
            {
                cid: columns[0].cid,
                name: columns[0].name,
                type: columns[0].type,
                notNull: columns[0].notNull,
                primaryKey: columns[0].primaryKey,
                collate: columns[0].collate,
                autoIncrement: columns[0].autoIncrement,
            },
            {
                cid: 0,
                name: 'a',
                type: 'INTEGER',
                notNull: false,
                primaryKey: 1,
                collate: 'BINARY',
                autoIncrement: true,
            },
        );
        assert.strictEqual(columns[1].notNull, true);
        assert.strictEqual(columns[1].defaultValue, "'x'");
        assert.strictEqual(columns[2].collate, 'NOCASE');
    });

    it('tableInfo returns [] for a missing table', async function () {
        const columns = await db.tableInfo('nosuch');
        assert.deepStrictEqual(columns, []);
    });

    it('tableInfo validates its arguments', async function () {
        // Promise mode: the validation error rejects. Callback mode
        // throws synchronously.
        await assert.rejects(db.tableInfo(''), /non-empty table name/);
        await assert.rejects(
            /** @type {any} */ (db).tableInfo('t', 42),
            /database name must be a string/,
        );
        assert.throws(
            () =>
                db.tableInfo('', () => {
                    /* callback mode */
                }),
            /non-empty table name/,
        );
    });

    it('dbConfig reads and writes the defensive switch', async function () {
        const before = await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE);
        assert.strictEqual(typeof before, 'boolean');
        const prev = await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE, true);
        assert.strictEqual(prev, before);
        const after = await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE);
        assert.strictEqual(after, true);
        // In defensive mode, schema-table writes are refused by name.
        await assert.rejects(
            db.exec(
                "INSERT INTO sqlite_master VALUES ('table','x','x',2,'CREATE TABLE x (a)')",
            ),
            (err) => /sqlite_master may not be modified/.test(err.message),
        );
        await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE, false);
        assert.strictEqual(
            await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE),
            false,
        );
    });

    it('dbConfig rejects unknown ops and bad values', async function () {
        await assert.rejects(
            db.dbConfig(9999, true),
            /must be one of the DBCONFIG_\* constants/,
        );
        await assert.rejects(
            /** @type {any} */ (db).dbConfig(sqlite3.DBCONFIG_DEFENSIVE, 'yes'),
            /value must be a boolean or -1/,
        );
    });

    it('exports the introspection constants with sqlite’s values', async function () {
        assert.strictEqual(sqlite3.STMTSTATUS_FULLSCAN_STEP, 1);
        assert.strictEqual(sqlite3.STMTSTATUS_VM_STEP, 4);
        assert.strictEqual(sqlite3.DBCONFIG_DEFENSIVE, 1010);
        assert.strictEqual(sqlite3.DBCONFIG_TRUSTED_SCHEMA, 1017);
        assert.strictEqual(sqlite3.CHECKPOINT_TRUNCATE, 3);
    });
});
