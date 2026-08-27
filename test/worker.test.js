// Worker-thread safety (Deliverable 09). The addon loads per
// environment; every worker is its own napi env, so these tests are the
// proof that nothing napi-shaped is shared across environments — the
// per-env constructor block (AddonData) is what makes the 8-worker
// cycle pass, and a regression to a file static fails it (that bug
// class segfaults at env teardown on musl and silently misbehaves
// everywhere else).
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import sqlite3 from '../lib/sqlite3.js';
import { TMP_DIR } from './support/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER_URL = pathToFileURL(join(__dirname, '../lib/sqlite3.js')).href;

/** Removes a database file and its journal/WAL siblings. */
function removeDb(file) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        rmSync(`${file}${suffix}`, { force: true });
    }
}

/**
 * Spawns an eval-mode worker that loads the driver and runs `body`.
 *
 * The body receives the loaded driver, a `report(value)` function whose
 * values arrive through `next()`, and a JSON-serialized `payload`
 * (bodies are stringified into the worker, so they cannot close over
 * test-file variables). When the body completes, the worker unrefs its
 * parent port: the thread then exits naturally once idle — with
 * whatever objects the body left open, which is exactly the teardown
 * these tests want to exercise.
 *
 * @template [P=undefined]
 * @param {(sqlite3: typeof import('../lib/sqlite3.js').default,
 *     report: (value: any) => void, payload: P) => void | Promise<void>} body
 * @param {P} [payload] JSON-serializable value handed to the body.
 * @returns {{ worker: Worker,
 *     next: () => Promise<any>,
 *     exited: Promise<number> }} the worker, a report reader and the
 *   exit-code promise.
 */
function driverWorker(body, payload) {
    const hasPayload = payload !== undefined;
    const worker = new Worker(
        `
        const { parentPort } = require('node:worker_threads');
        const payload = ${hasPayload ? JSON.stringify(payload) : 'undefined'};
        import(${JSON.stringify(DRIVER_URL)}).then(async (m) => {
            const report = (value) =>
                parentPort.postMessage({ kind: 'report', value });
            try {
                await (${body.toString()})(m.default, report, payload);
            } catch (err) {
                parentPort.postMessage({
                    kind: 'fatal',
                    message: err && err.message ? err.message : String(err),
                });
            }
            // Let the thread die naturally once the body is done, so the
            // napi environment tears down around whatever is still open.
            parentPort.unref();
        });
        `,
        { eval: true },
    );

    /** @type {Promise<any>[]} */
    const queued = [];
    /** @type {{ resolve: (v: any) => void, reject: (e: Error) => void }[]} */
    const waiters = [];
    worker.on('message', (msg) => {
        if (msg.kind === 'report') {
            const waiter = waiters.shift();
            if (waiter) waiter.resolve(msg.value);
            else queued.push(Promise.resolve(msg.value));
        } else if (msg.kind === 'fatal') {
            const err = new Error(`worker body failed: ${msg.message}`);
            const waiter = waiters.shift();
            if (waiter) waiter.reject(err);
            else queued.push(Promise.reject(err));
        }
    });
    worker.on('error', (err) => {
        const waiter = waiters.shift();
        if (waiter) waiter.reject(err);
        else queued.push(Promise.reject(err));
    });
    const exited = new Promise((resolve) => {
        worker.once('exit', (code) => resolve(code));
    });
    /**
     * Awaits the next reported value.
     *
     * @returns {Promise<any>} the reported value.
     */
    function next() {
        if (queued.length > 0) return queued.shift();
        return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
        });
    }
    return { worker, next, exited };
}

describe('worker threads', function () {
    it('loads the addon in 8 workers at once, 1000 queries each, 20 cycles', {
        timeout: 180000,
    }, async function () {
        const CYCLES = 20;
        const WORKERS = 8;
        const QUERIES = 1000;
        for (let cycle = 0; cycle < CYCLES; cycle++) {
            const results = await Promise.all(
                Array.from({ length: WORKERS }, (_, id) => {
                    const { next, exited } = driverWorker(
                        async (driver, report, spec) => {
                            const QUERIES = spec.queries;
                            const db = await driver.open(':memory:');
                            await db.exec(
                                'CREATE TABLE t (i INTEGER, sq INTEGER)',
                            );
                            const insert = db.prepare(
                                'INSERT INTO t VALUES (?, ?)',
                            );
                            for (let i = 0; i < QUERIES; i++) {
                                await insert.run(i, i * i);
                            }
                            await insert.finalize();
                            const row = await db.get(
                                'SELECT COUNT(*) AS n, SUM(sq) AS total FROM t',
                            );
                            await db.close();
                            report({ n: row.n, total: row.total });
                        },
                        { queries: QUERIES },
                    );
                    return next().then((r) => ({ id, r, exited }));
                }),
            );
            // Sum of squares for i = 0..999.
            const expectedTotal =
                ((QUERIES - 1) * QUERIES * (2 * QUERIES - 1)) / 6;
            for (const { id, r } of results) {
                assert.strictEqual(
                    r.n,
                    QUERIES,
                    `cycle ${cycle} worker ${id} row count`,
                );
                assert.strictEqual(
                    r.total,
                    expectedTotal,
                    `cycle ${cycle} worker ${id} sum of squares`,
                );
            }
            // Every worker of the cycle must have exited cleanly.
            for (const { exited } of results) {
                assert.strictEqual(await exited, 0);
            }
        }
    });

    it('worker exits cleanly without closing anything (env teardown with live objects)', {
        timeout: 30000,
    }, async function () {
        // The D08 musl crash shape: a napi environment torn down
        // with a live connection and statements. Inside a worker
        // this is a normal exit, and it must be a clean one.
        const { next, exited } = driverWorker(async (driver, report) => {
            const db = await driver.open(':memory:');
            await db.exec('CREATE TABLE t (a)');
            await db.run('INSERT INTO t VALUES (1)');
            // Deliberately no close, no finalize: the environment
            // tears down around the live handle.
            report('alive');
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        assert.strictEqual(await next(), 'alive');
        assert.strictEqual(
            await exited,
            0,
            'worker must exit cleanly with a live connection',
        );
    });

    it('terminating a worker mid-query leaves the parent healthy', {
        timeout: 120000,
    }, async function () {
        const { worker, next } = driverWorker(async (driver, report) => {
            const db = await driver.open(':memory:');
            await db.exec('CREATE TABLE t (a)');
            report('ready');
            // Runs long enough to still be running when the terminate
            // lands, cheap enough that teardown (which waits for this
            // work on the threadpool) completes quickly even under
            // heavy contention — the cost must not depend on losing a
            // race (REVIEW-LOG D05 addendum).
            await db
                .all(
                    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000000) SELECT count(*) FROM c',
                )
                .catch(() => {
                    // Terminated, not rejected — this worker never
                    // reports success either way.
                });
            report('query-completed');
        });
        // Wait for the query to be running, then kill the thread.
        assert.strictEqual(await next(), 'ready');
        await new Promise((resolve) => setTimeout(resolve, 100));
        await worker.terminate();

        // The parent's own connection must be unaffected.
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a)');
        await db.run('INSERT INTO t VALUES (42)');
        assert.strictEqual(
            (await db.get('SELECT a FROM t')).a,
            42,
            'parent connection still works after worker.terminate()',
        );
        await db.close();
    });

    it('main thread and a worker share one WAL file: writes are visible both ways', {
        timeout: 60000,
    }, async function () {
        // Unique per run: concurrent stress runs of the suite share
        // test/tmp/, and a fixed name would have twenty processes
        // creating and deleting one database out from under each other
        // (the observed "no such table" under 20-way stress).
        const FILE = join(
            TMP_DIR,
            `worker-wal-share-${process.pid}-${randomUUID()}.db`,
        );
        removeDb(FILE);
        try {
            const db = await sqlite3.open(FILE);
            assert.strictEqual(
                (
                    await db.get('PRAGMA journal_mode=WAL')
                ).journal_mode.toLowerCase(),
                'wal',
            );
            await db.exec('CREATE TABLE t (a)');
            await db.run('INSERT INTO t VALUES (1)');

            const { worker, next } = driverWorker(
                async (driver, report, file) => {
                    // A readonly open of a WAL database needs the -shm
                    // to exist (or be creatable); under extreme
                    // filesystem contention that race can transiently
                    // lose with SQLITE_CANTOPEN. Back off and retry —
                    // observed only with 20 suite runs plus container
                    // builds hammering one volume, never otherwise.
                    let reader;
                    for (let attempt = 0; ; attempt++) {
                        try {
                            reader = await driver.open(
                                file,
                                driver.OPEN_READONLY,
                            );
                            break;
                        } catch (err) {
                            if (
                                err.code !== 'SQLITE_CANTOPEN' ||
                                attempt >= 4
                            ) {
                                throw err;
                            }
                            await new Promise((resolve) =>
                                setTimeout(resolve, 25 * (attempt + 1)),
                            );
                        }
                    }
                    const seen = await reader.all('SELECT a FROM t ORDER BY a');
                    // The same worker also writes through its own
                    // read-write connection…
                    const writer = await driver.open(file);
                    await writer.run('INSERT INTO t VALUES (2)');
                    // …and its reader sees the commit once made.
                    const after = await reader.all(
                        'SELECT a FROM t ORDER BY a',
                    );
                    await reader.close();
                    await writer.close();
                    report({ seen, after });
                },
                FILE,
            );
            worker.unref();
            const reported = await next();
            assert.deepStrictEqual(
                reported.seen.map((row) => row.a),
                [1],
                'worker reader sees the main-thread write',
            );
            assert.deepStrictEqual(
                reported.after.map((row) => row.a),
                [1, 2],
                'worker reader sees its own writer commit',
            );
            // The worker's report follows its commit and the close of
            // both its connections, so the write is durable in the WAL.
            // Under extreme contention one same-connection read has
            // landed on a stale snapshot (never unloaded); poll a FRESH
            // connection — the visibility claim — bounded, then assert
            // the final state either way.
            let seen;
            for (let i = 0; i < 200; i++) {
                const check = await sqlite3.open(FILE);
                seen = await check.all('SELECT a FROM t ORDER BY a');
                await check.close();
                if (seen.length === 2) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.deepStrictEqual(
                seen.map((row) => row.a),
                [1, 2],
                'main thread sees the worker write',
            );
            await db.close();
        } finally {
            removeDb(FILE);
        }
    });

    it('moves an in-memory database to a worker via serialize/deserialize bytes', {
        timeout: 30000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
        await db.run('INSERT INTO t VALUES (?, ?)', [7, 'seven']);
        await db.run('INSERT INTO t VALUES (?, ?)', [8, 'eight']);
        const bytes = await db.serializeToBytes();
        await db.close();

        const worker = new Worker(
            `
                const { parentPort } = require('node:worker_threads');
                import(${JSON.stringify(DRIVER_URL)}).then(async (m) => {
                    const report = (value) =>
                        parentPort.postMessage({ kind: 'report', value });
                    parentPort.on('message', async (msg) => {
                        if (msg.kind !== 'bytes') return;
                        try {
                            const revived =
                                await m.default.deserializeFromBytes(
                                    new Uint8Array(msg.bytes),
                                    { resizable: true },
                                );
                            const rows = await revived.all(
                                'SELECT * FROM t ORDER BY a',
                            );
                            await revived.run('INSERT INTO t VALUES (?, ?)', [
                                9,
                                'nine',
                            ]);
                            const count = await revived.get(
                                'SELECT COUNT(*) AS n FROM t',
                            );
                            await revived.close();
                            report({ rows, count: count.n });
                            parentPort.unref();
                        } catch (err) {
                            report({
                                fatal:
                                    err && err.message
                                        ? err.message
                                        : String(err),
                            });
                        }
                    });
                });
                `,
            { eval: true },
        );
        /** @type {Promise<any>} */
        const reported = new Promise((resolve, reject) => {
            worker.on('message', (msg) => {
                if (msg.kind === 'report') resolve(msg.value);
            });
            worker.on('error', reject);
        });
        // serializeToBytes' Uint8Array is a view over SQLite-owned
        // external memory, which structured clone refuses to
        // transfer — copy it into a plain ArrayBuffer (the one copy
        // the handoff costs) and transfer that.
        const movable = bytes.slice().buffer;
        worker.postMessage({ kind: 'bytes', bytes: movable }, [movable]);
        const result = await reported;
        assert.ok(!result.fatal, `worker failed: ${result.fatal}`);
        assert.deepStrictEqual(result.rows, [
            { a: 7, b: 'seven' },
            { a: 8, b: 'eight' },
        ]);
        assert.strictEqual(result.count, 3, 'revived db is writable');
        assert.ok(
            movable.byteLength === 0,
            'transferred buffer detached in the parent',
        );
    });

    it('cancels a worker query from the main thread via the shared token buffer', {
        timeout: 30000,
    }, async function () {
        const { worker, next } = driverWorker(async (driver, report) => {
            const db = await driver.open(':memory:');
            await db.exec('CREATE TABLE t (a)');
            const token = db.cancellationToken();
            // Hand the raw SharedArrayBuffer to the parent before
            // starting the runaway query.
            report({ sab: token.buffer });
            try {
                await db.all(
                    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 100000000) SELECT count(*) FROM c',
                );
                report({ aborted: false });
            } catch (err) {
                report({ aborted: true, code: err.code });
            }
        });
        worker.unref();
        const armed = await next();
        assert.ok(
            armed.sab instanceof SharedArrayBuffer,
            'token buffer crosses to the main thread',
        );
        const flag = new Int32Array(armed.sab);
        // The query is now running in the worker; set the flag from
        // this thread.
        await new Promise((resolve) => setTimeout(resolve, 50));
        Atomics.store(flag, 0, 1);
        const outcome = await next();
        assert.strictEqual(
            outcome.aborted,
            true,
            'cross-thread cancel aborts the worker query',
        );
        assert.strictEqual(
            outcome.code,
            'SQLITE_INTERRUPT',
            'aborted query reports SQLITE_INTERRUPT',
        );
    });
});
