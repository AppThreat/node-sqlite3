// Write-path cases (Deliverable 13 §2.2): prepared insert, per-call
// prepare, the statement cache, one transaction vs autocommit — the
// single biggest real-world speed lever in SQLite — and multi-statement
// exec.
//
// Every round clears its table first: the DELETE is inside the timed
// region (it has to be, the harness times whole rounds) but excluded from
// the op count, and it is identical across the compared cases, so ratios
// stay apples-to-apples.
//
// The transaction pair runs on a FILE database, not :memory: — on an
// in-memory database a commit is a memcpy and there is no journal, which
// is exactly why run 1 of this suite measured the lever as "within
// noise". The lever is real precisely where durability costs something.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Opens a private file-backed database for the transaction pair.
 *
 * @param {string} tag filename tag, so the two compared cases never share a file.
 * @returns {Promise<any>} env with { db, stmt, path } once open, tabled and prepared.
 */
async function txnFileSetup(tag) {
    const { default: sqlite3 } = await import('../../lib/sqlite3.js');
    const path = join(tmpdir(), `node-sqlite3-bench-${tag}-${process.pid}.db`);
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
        rmSync(path + suffix, { force: true });
    }
    const db = new sqlite3.Database(path);
    await new Promise((resolve, reject) => {
        db.once('open', resolve);
        db.once('error', reject);
    });
    await db.exec('CREATE TABLE w (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    const stmt = db.prepare('INSERT INTO w VALUES (?, ?, ?, ?)');
    return { db, stmt, path };
}

/**
 * Closes and removes a transaction-pair file database.
 *
 * @param {{ db: any, stmt: any, path: string }} env the setup value.
 * @returns {Promise<void>} resolves once closed and cleaned up.
 */
async function txnFileTeardown(env) {
    await new Promise((resolve) => env.stmt.finalize(resolve));
    await new Promise((resolve) => env.db.close(resolve));
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
        rmSync(env.path + suffix, { force: true });
    }
}

/**
 * Builds the write cases. Two connections: the shared plain one, and a
 * separate one for the statement-cache case, because `cacheStatements()`
 * cannot be turned off and must not leak into the other cases.
 *
 * @param {any} dbPlain an open, cache-free connection.
 * @param {any} dbCached an open connection that this group may cache-enable.
 * @returns {import('../harness.js').CaseSpec[]} the write cases.
 */
export function writeCases(dbPlain, dbCached) {
    const db = dbPlain;
    db.exec('CREATE TABLE w (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    dbCached.exec('CREATE TABLE w (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    const K = 1000; // inserts per round
    const buf = Buffer.alloc(64);

    /** @type {import('../harness.js').CaseSpec[]} */
    const cases = [
        {
            name: 'write/run: prepared insert ×1,000',
            group: 'write',
            ops: K,
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                const stmt = db.prepare('INSERT INTO w VALUES (?, ?, ?, ?)');
                for (let r = 0; r < n; r++) {
                    await db.exec('DELETE FROM w');
                    for (let i = 0; i < K; i++) {
                        await stmt.run(i, i + 0.5, `text-value-${i}`, buf);
                    }
                }
                await stmt.finalize();
            },
        },
        {
            name: 'write/db.run: prepare per call ×1,000',
            group: 'write',
            ops: K,
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    await db.exec('DELETE FROM w');
                    for (let i = 0; i < K; i++) {
                        await db.run(
                            'INSERT INTO w VALUES (?, ?, ?, ?)',
                            i,
                            i + 0.5,
                            `text-value-${i}`,
                            buf,
                        );
                    }
                }
            },
        },
        {
            name: 'write/db.run: statement cache ×1,000',
            group: 'write',
            ops: K,
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                dbCached.cacheStatements();
                for (let r = 0; r < n; r++) {
                    await dbCached.exec('DELETE FROM w');
                    for (let i = 0; i < K; i++) {
                        await dbCached.run(
                            'INSERT INTO w VALUES (?, ?, ?, ?)',
                            i,
                            i + 0.5,
                            `text-value-${i}`,
                            buf,
                        );
                    }
                }
            },
        },
        {
            name: 'write/insert: ×1,000 in one transaction (file db)',
            group: 'write',
            ops: K,
            targetSampleMs: 80,
            ratioTo: 'write/insert: ×1,000 autocommit (file db)',
            note: 'file-backed: a commit must survive a journal — the lever being measured',
            setup: () => txnFileSetup('txn'),
            teardown: txnFileTeardown,
            iter: async (env, n) => {
                for (let r = 0; r < n; r++) {
                    await env.db.exec('DELETE FROM w');
                    await env.db.exec('BEGIN');
                    for (let i = 0; i < K; i++) {
                        await env.stmt.run(i, i + 0.5, `text-value-${i}`, buf);
                    }
                    await env.db.exec('COMMIT');
                }
            },
        },
        {
            name: 'write/insert: ×1,000 autocommit (file db)',
            group: 'write',
            ops: K,
            targetSampleMs: 80,
            note: 'file-backed: a commit must survive a journal — the lever being measured',
            setup: () => txnFileSetup('autocommit'),
            teardown: txnFileTeardown,
            iter: async (env, n) => {
                for (let r = 0; r < n; r++) {
                    await env.db.exec('DELETE FROM w');
                    for (let i = 0; i < K; i++) {
                        await env.stmt.run(i, i + 0.5, `text-value-${i}`, buf);
                    }
                }
            },
        },
        {
            name: 'write/exec: 100-statement script',
            group: 'write',
            ops: 100,
            iter: async (_env, n) => {
                const script = Array.from(
                    { length: 100 },
                    (_, i) =>
                        `INSERT INTO w VALUES (${i}, ${i}.5, 's${i}', x'00')`,
                ).join(';\n');
                for (let i = 0; i < n; i++) {
                    await db.exec(`DELETE FROM w;\n${script}`);
                }
            },
        },
    ];

    return cases;
}
