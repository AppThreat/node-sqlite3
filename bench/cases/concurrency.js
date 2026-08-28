// Concurrency cases (Deliverable 13 §2.2): parallelize() vs serialize()
// under N concurrent queries, and the worker pool against a single
// connection — including the postMessage row-transfer cost that decides
// whether the pool is worth using (D09 filed "a real number for the pool
// under contention"; this is it).
import { join } from 'node:path';

import { intRows } from './shared.js';

/** @typedef {import('../harness.js').CaseSpec} CaseSpec */

/**
 * parallelize() vs serialize(): 50 concurrent 1,000-row queries on one
 * connection, wall-clock. Same connection, same queries — only the
 * scheduling mode differs.
 *
 * @param {any} db an open connection with a 1,000-row table `c`.
 * @returns {CaseSpec[]} the two scheduling cases.
 */
export function schedulingCases(db) {
    db.exec('CREATE TABLE c (v INTEGER)');
    db.exec(intRows(1000, 'x', 'c'));
    const CONCURRENT = 50;

    /** @param {boolean} serialized @returns {Promise<void>} one round */
    const round = async (serialized) => {
        /** @type {Promise<unknown>[]} */
        let started = [];
        const mode = serialized ? db.serialize : db.parallelize;
        mode.call(db, () => {
            started = Array.from({ length: CONCURRENT }, () =>
                db.all('SELECT * FROM c'),
            );
        });
        const rows = await Promise.all(started);
        for (const r of rows) {
            if (/** @type {any[]} */ (r).length !== 1000)
                throw new Error('bad count');
        }
    };

    return [
        {
            name: 'concurrency/50 concurrent queries: parallelize()',
            group: 'concurrency',
            ops: CONCURRENT,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) await round(false);
            },
        },
        {
            name: 'concurrency/50 concurrent queries: serialize()',
            group: 'concurrency',
            ops: CONCURRENT,
            ratioTo: 'concurrency/50 concurrent queries: parallelize()',
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) await round(true);
            },
        },
    ];
}

/**
 * The pool cases (Deliverable 09 keepers plus the contention pair):
 * round trips, 200 concurrent reads pool-vs-single-connection, and the
 * postMessage row-transfer cost (pool.all of 20k rows against the same
 * query on a local connection).
 *
 * @param {typeof import('../../lib/sqlite3.js').default} sqlite3 the driver.
 * @param {any} localDb a local connection with a 20,000-row table `c20` (the pool file gets the same data).
 * @param {{ dir: string }} scratch scratch directory for the pool file.
 * @returns {Promise<{ cases: CaseSpec[], dispose: () => Promise<void> }>} the pool cases and disposer.
 */
export async function poolCases(sqlite3, localDb, scratch) {
    localDb.exec('CREATE TABLE c20 (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    localDb.exec(
        intRows(20000, "x, x + 0.5, 'text-value-' || x, zeroblob(64)", 'c20'),
    );

    const file = join(scratch.dir, 'bench-pool.db');
    const pool = await sqlite3.pool(file, { readers: 4 });
    await pool.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    await pool.exec('CREATE TABLE c20 (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    await pool.write(
        "INSERT INTO c20 SELECT x, x + 0.5, 'text-value-' || x, zeroblob(64) " +
            'FROM (WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 20000) SELECT x FROM cnt)',
    );
    await pool.write('INSERT INTO t VALUES (?, ?)', [1, 'seed']);

    /** @type {CaseSpec[]} */
    const cases = [
        {
            name: 'concurrency/pool.read: 1,000 round trips',
            group: 'concurrency',
            ops: 1000,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    for (let r = 0; r < 1000; r++) {
                        await pool.read('SELECT a, b FROM t WHERE a = ?', [1]);
                    }
                }
            },
        },
        {
            name: 'concurrency/pool.get: 1,000 round trips',
            group: 'concurrency',
            ops: 1000,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    for (let r = 0; r < 1000; r++) {
                        await pool.get('SELECT a, b FROM t WHERE a = ?', [1]);
                    }
                }
            },
        },
        {
            name: 'concurrency/pool.write: 1,000 round trips',
            group: 'concurrency',
            ops: 1000,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    for (let r = 0; r < 1000; r++) {
                        await pool.write('INSERT INTO t VALUES (?, ?)', [
                            r,
                            'x',
                        ]);
                    }
                }
                await pool.exec('DELETE FROM t');
                await pool.write('INSERT INTO t VALUES (?, ?)', [1, 'seed']);
            },
        },
        {
            name: 'concurrency/pool.all: 20,000 rows (postMessage transfer)',
            group: 'concurrency',
            ops: 20000,
            ratioTo: 'read/all: 20,000 rows × 4 cols',
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const rows = await pool.read('SELECT * FROM c20');
                    if (rows.length !== 20000) throw new Error('bad count');
                }
            },
        },
        {
            name: 'concurrency/200 concurrent reads: pool (4 readers)',
            group: 'concurrency',
            ops: 200,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const rows = await Promise.all(
                        Array.from({ length: 200 }, () =>
                            pool.read('SELECT * FROM c20 WHERE c0 % 100 = 0'),
                        ),
                    );
                    if (rows.length !== 200) throw new Error('bad count');
                }
            },
        },
        {
            name: 'concurrency/200 concurrent reads: single connection',
            group: 'concurrency',
            ops: 200,
            ratioTo: 'concurrency/200 concurrent reads: pool (4 readers)',
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const rows = await Promise.all(
                        Array.from({ length: 200 }, () =>
                            localDb.all('SELECT * FROM c20 WHERE c0 % 100 = 0'),
                        ),
                    );
                    if (rows.length !== 200) throw new Error('bad count');
                }
            },
        },
    ];

    return {
        cases,
        dispose: async () => {
            await pool.close();
        },
    };
}
