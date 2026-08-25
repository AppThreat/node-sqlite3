import assert from 'node:assert';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

const FILE = 'test/tmp/transaction-03.db';

describe('transaction', function () {
    let db;
    before(async function () {
        db = await sqlite3.open(FILE);
        await db.exec('CREATE TABLE IF NOT EXISTS t (a INT)');
    });

    after(async function () {
        await db.close();
        fs.unlinkSync(FILE);
    });

    it('commits on success and resolves the body value', async function () {
        await db.exec('DELETE FROM t');
        const out = await db.transaction(async (tx) => {
            assert.strictEqual(tx, db);
            await tx.run('INSERT INTO t VALUES (1)');
            await tx.run('INSERT INTO t VALUES (2)');
            return tx.all('SELECT a FROM t ORDER BY a');
        });
        assert.deepStrictEqual(
            out.map((r) => r.a),
            [1, 2],
        );
        const rows = await db.all('SELECT a FROM t ORDER BY a');
        assert.deepStrictEqual(
            rows.map((r) => r.a),
            [1, 2],
        );
    });

    it('rolls back on throw and rethrows the original error', async function () {
        await db.exec('DELETE FROM t');
        await assert.rejects(
            db.transaction(async (tx) => {
                await tx.run('INSERT INTO t VALUES (1)');
                throw new Error('body boom');
            }),
            /body boom/,
        );
        const rows = await db.all('SELECT a FROM t');
        assert.deepStrictEqual(rows, []);
    });

    it('surfaces both errors as an AggregateError when rollback fails too', async function () {
        await db.exec('DELETE FROM t');
        const realExec = db.exec;
        let sabotaged = false;
        db.exec = function (sql, ...rest) {
            if (sabotaged && sql === 'ROLLBACK') {
                return Promise.reject(new Error('rollback boom'));
            }
            return realExec.call(this, sql, ...rest);
        };
        try {
            await assert.rejects(
                db.transaction(async (tx) => {
                    sabotaged = true;
                    await tx.run('INSERT INTO t VALUES (1)');
                    throw new Error('body boom');
                }),
                function (err) {
                    assert.ok(err instanceof AggregateError);
                    assert.strictEqual(err.errors.length, 2);
                    assert.match(err.errors[0].message, /body boom/);
                    assert.match(err.errors[1].message, /rollback boom/);
                    return true;
                },
            );
        } finally {
            db.exec = realExec;
            // Clean up the still-open transaction left by the sabotage.
            await realExec.call(db, 'ROLLBACK');
        }
    });

    it('nested transactions use savepoints automatically', async function () {
        await db.exec('DELETE FROM t');
        await db.transaction(async (tx) => {
            await tx.run('INSERT INTO t VALUES (1)');
            await tx
                .transaction(async (inner) => {
                    await inner.run('INSERT INTO t VALUES (2)');
                    // Only the savepoint rolls back.
                    throw new Error('inner boom');
                })
                .catch(function (err) {
                    assert.match(err.message, /inner boom/);
                });
            await tx.run('INSERT INTO t VALUES (3)');
        });
        const rows = await db.all('SELECT a FROM t ORDER BY a');
        // 2 was rolled back to the savepoint; 1 and 3 committed.
        assert.deepStrictEqual(
            rows.map((r) => r.a),
            [1, 3],
        );
    });

    it('{ savepoint: true } nests via SAVEPOINT at the top level', async function () {
        await db.exec('DELETE FROM t');
        await db
            .transaction(
                async (tx) => {
                    await tx.run('INSERT INTO t VALUES (9)');
                    throw new Error('sp boom');
                },
                { savepoint: true },
            )
            .catch(function (err) {
                assert.match(err.message, /sp boom/);
            });
        const rows = await db.all('SELECT a FROM t');
        assert.deepStrictEqual(rows, []);
    });

    it('supports immediate and exclusive modes', async function () {
        await db.exec('DELETE FROM t');
        await db.transaction(
            async (tx) => {
                await tx.run('INSERT INTO t VALUES (1)');
            },
            { mode: 'immediate' },
        );
        await db.transaction(
            async (tx) => {
                await tx.run('INSERT INTO t VALUES (2)');
            },
            { mode: 'exclusive' },
        );
        const rows = await db.all('SELECT a FROM t ORDER BY a');
        assert.deepStrictEqual(
            rows.map((r) => r.a),
            [1, 2],
        );
    });

    it('rejects invalid modes and non-function bodies', async function () {
        await assert.rejects(
            db.transaction(
                async () => {
                    /* body never runs: the mode is rejected first */
                },
                { mode: 'sideways' },
            ),
            TypeError,
        );
        await assert.rejects(db.transaction('not a function'), TypeError);
    });

    it('{ serialize: true } runs the body in serialize mode', async function () {
        await db.exec('DELETE FROM t');
        let sawSerialized;
        await db.transaction(
            async (tx) => {
                sawSerialized = db._serialized;
                await tx.run('INSERT INTO t VALUES (1)');
            },
            { serialize: true },
        );
        assert.strictEqual(sawSerialized, true);
        assert.strictEqual(db._serialized, false);
        const rows = await db.all('SELECT a FROM t');
        assert.strictEqual(rows.length, 1);
    });

    it('rejects with SQLITE_BUSY when a second connection holds the write lock', {
        timeout: 30000,
    }, async function () {
        const db1 = await sqlite3.open(FILE);
        const db2 = await sqlite3.open(FILE);
        try {
            await db1.exec('BEGIN IMMEDIATE');
            await db1.run('INSERT INTO t VALUES (100)');
            await assert.rejects(
                db2.transaction(
                    async (tx) => {
                        await tx.run('INSERT INTO t VALUES (200)');
                    },
                    { mode: 'immediate' },
                ),
                function (err) {
                    assert.strictEqual(err.primaryCode, 'SQLITE_BUSY');
                    return true;
                },
            );
            await db1.exec('ROLLBACK');
        } finally {
            await db1.close();
            await db2.close();
        }
    });
});
