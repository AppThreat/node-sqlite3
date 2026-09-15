// The worker pool (Deliverable 09): read/write routing, write
// serialization, transaction pinning, error diagnostics across the
// postMessage boundary, cancellation through the shared flag, and
// shutdown that leaves no worker behind.
import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';
import { TMP_DIR } from './support/db.js';

// A query slow enough to measure overlap against, cheap enough for CI:
// ~2M recursive rows per invocation.
const SLOW_QUERY =
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c ' +
    'WHERE x < 2000000) SELECT count(*) AS n FROM c';

/** Removes a database file and its journal/WAL siblings. */
function removeDb(file) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        rmSync(`${file}${suffix}`, { force: true });
    }
}

describe('pool', function () {
    let pool;
    let file;

    /**
     * Opens a pool over a fresh file with two readers.
     *
     * @returns {Promise<void>} resolves once the pool is ready.
     */
    async function freshPool() {
        file = join(TMP_DIR, `pool-test-${process.pid}-${Date.now()}.db`);
        removeDb(file);
        pool = await sqlite3.pool(file, { readers: 2 });
        await pool.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
    }

    afterEach(async function () {
        if (pool !== undefined && pool !== null) {
            await pool.close();
            pool = /** @type {any} */ (null);
        }
        if (file !== undefined) {
            removeDb(file);
            file = /** @type {any} */ (undefined);
        }
    });

    it('routes reads to readers and writes to the writer', {
        timeout: 30000,
    }, async function () {
        await freshPool();
        const result = await pool.write('INSERT INTO t (b) VALUES (?)', [
            'one',
        ]);
        assert.strictEqual(result.changes, 1);
        assert.ok(result.lastID >= 1);
        const rows = await pool.read('SELECT b FROM t');
        assert.deepStrictEqual(
            rows.map((r) => r.b),
            ['one'],
        );
        const row = await pool.get('SELECT b FROM t WHERE a = ?', [
            result.lastID,
        ]);
        assert.strictEqual(row.b, 'one');
        // Repeated gets through the pool stay correct (the cached-get
        // re-stepping bug class this deliverable had to route around).
        assert.strictEqual(
            (await pool.get('SELECT COUNT(*) AS n FROM t')).n,
            1,
        );
        assert.strictEqual(
            (await pool.get('SELECT COUNT(*) AS n FROM t')).n,
            1,
        );
    });

    it('runs WAL mode and the busy timeout by default', {
        timeout: 30000,
    }, async function () {
        await freshPool();
        const mode = await pool.get('PRAGMA journal_mode');
        assert.strictEqual(
            mode.journal_mode.toLowerCase(),
            'wal',
            'pool default enables WAL',
        );
        const timeout = await pool.get('PRAGMA busy_timeout');
        assert.strictEqual(timeout.timeout, 5000);
    });

    it('concurrent reads do not queue behind each other', {
        timeout: 120000,
    }, async function () {
        await freshPool();
        // Structural, not wall-time: a trivial read completing while a
        // slow one is still in flight proves the two ran on different
        // readers (one connection at a time would delay the trivial
        // read behind the slow one). The claim is ordering, not speed,
        // so it holds on a loaded CI machine too — where a wall-clock
        // ratio cannot: with every core saturated, two concurrent
        // queries timeshare and cost 2x one, by design of the load.
        let slowDone = false;
        const slow = pool.read(SLOW_QUERY);
        slow.finally(() => {
            slowDone = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const fast = await pool.get('SELECT 1 AS v');
        assert.strictEqual(fast.v, 1);
        assert.strictEqual(
            slowDone,
            false,
            'the slow read is still in flight — the fast one did not queue behind it',
        );
        const rows = await slow;
        assert.strictEqual(rows[0].n, 2000000);
    });

    it('concurrent writes all land (they queue on the writer)', {
        timeout: 60000,
    }, async function () {
        await freshPool();
        const N = 50;
        await Promise.all(
            Array.from({ length: N }, (_, i) =>
                pool.write('INSERT INTO t (b) VALUES (?)', [`row-${i}`]),
            ),
        );
        const count = await pool.get('SELECT COUNT(*) AS n FROM t');
        assert.strictEqual(count.n, N, 'every write landed exactly once');
    });

    it('transaction sees its own writes; readers see committed only', {
        timeout: 30000,
    }, async function () {
        await freshPool();
        await pool.write('INSERT INTO t (b) VALUES (?)', ['committed']);
        const returned = await pool.transaction(async (tx) => {
            await tx.write('INSERT INTO t (b) VALUES (?)', ['uncommitted']);
            const inside = await tx.read('SELECT COUNT(*) AS n FROM t');
            const outside = await pool.read('SELECT COUNT(*) AS n FROM t');
            return { inside: inside[0].n, outside: outside[0].n };
        });
        assert.strictEqual(returned.inside, 2, 'tx reads its own writes');
        assert.strictEqual(
            returned.outside,
            1,
            'pool.read inside the body sees committed data only',
        );
        const after = await pool.get('SELECT COUNT(*) AS n FROM t');
        assert.strictEqual(after.n, 2, 'commit made the write visible');
    });

    it('rolling back discards the writes', {
        timeout: 30000,
    }, async function () {
        await freshPool();
        await assert.rejects(
            pool.transaction(async (tx) => {
                await tx.write('INSERT INTO t (b) VALUES (?)', ['doomed']);
                throw new Error('body failed');
            }),
            /body failed/,
        );
        assert.strictEqual(
            (await pool.get('SELECT COUNT(*) AS n FROM t')).n,
            0,
            'rollback discarded the insert',
        );
    });

    it('overlapping transactions serialize without losing updates', {
        timeout: 60000,
    }, async function () {
        await freshPool();
        await pool.exec('CREATE TABLE counter (n INTEGER)');
        await pool.write('INSERT INTO counter VALUES (0)');
        // Two transactions at once, each a read-modify-write: the pool
        // must serialize them (the second waits for the first) so both
        // increments survive — a lost update is the failure mode.
        await Promise.all([
            pool.transaction(async (tx) => {
                const row = await tx.get('SELECT n FROM counter');
                await tx.write('UPDATE counter SET n = ?', [row.n + 1]);
            }),
            pool.transaction(async (tx) => {
                const row = await tx.get('SELECT n FROM counter');
                await tx.write('UPDATE counter SET n = ?', [row.n + 1]);
            }),
        ]);
        assert.strictEqual(
            (await pool.get('SELECT n FROM counter')).n,
            2,
            'both increments survived (transactions serialized, not interleaved)',
        );
    });

    it('pool.write/exec from inside a transaction body refuse instead of deadlocking', {
        timeout: 30000,
    }, async function () {
        await freshPool();
        await assert.rejects(
            pool.transaction(async (tx) => {
                // tx handle works…
                await tx.write('INSERT INTO t (b) VALUES (?)', ['kept']);
                // …but the pool-facing writer methods would wait on the
                // transaction itself forever.
                await pool.write('INSERT INTO t (b) VALUES (?)', ['never']);
            }),
            /cannot run inside a pool.transaction\(\) body/,
        );
        assert.strictEqual(
            (await pool.get('SELECT COUNT(*) AS n FROM t')).n,
            0,
            'the refusal unwound the transaction through its rollback',
        );
    });

    it('errors keep code/errno/primaryCode across the boundary', {
        timeout: 30000,
    }, async function () {
        await freshPool();
        await pool.write('INSERT INTO t (a, b) VALUES (1, ?)', ['first']);
        await assert.rejects(
            pool.write('INSERT INTO t (a, b) VALUES (1, ?)', ['duplicate']),
            function (err) {
                assert.strictEqual(err.code, 'SQLITE_CONSTRAINT_PRIMARYKEY');
                assert.strictEqual(err.errno, 1555);
                assert.strictEqual(err.primaryCode, 'SQLITE_CONSTRAINT');
                assert.match(err.message, /UNIQUE constraint failed/);
                return true;
            },
        );
        // A syntax error keeps its diagnostics too.
        await assert.rejects(pool.read('SELEKT 1'), function (err) {
            assert.strictEqual(err.code, 'SQLITE_ERROR');
            assert.strictEqual(err.errno, 1);
            return true;
        });
    });

    it('blob columns cross as Uint8Array (documented Buffer difference)', {
        timeout: 30000,
    }, async function () {
        await freshPool();
        await pool.exec('CREATE TABLE blobs (d BLOB)');
        await pool.write('INSERT INTO blobs VALUES (?)', [
            new Uint8Array([1, 2, 3]),
        ]);
        const row = await pool.get('SELECT d FROM blobs');
        assert.ok(row.d instanceof Uint8Array);
        assert.deepStrictEqual(Array.from(row.d), [1, 2, 3]);
        assert.ok(
            !Buffer.isBuffer(row.d),
            'documented: pool results carry Uint8Array, not Buffer',
        );
    });

    it('BigInt bind values and results survive the round trip', {
        timeout: 30000,
    }, async function () {
        file = join(TMP_DIR, `pool-bigint-${process.pid}-${Date.now()}.db`);
        removeDb(file);
        pool = await sqlite3.pool(file, { readers: 0, integerMode: 'bigint' });
        await pool.exec('CREATE TABLE big (v INTEGER)');
        const big = 9007199254740993n;
        await pool.write('INSERT INTO big VALUES (?)', [big]);
        const row = await pool.get('SELECT v AS v FROM big');
        assert.strictEqual(row.v, big);
    });

    it('cancels a running read through the shared flag', {
        timeout: 60000,
    }, async function () {
        await freshPool();
        const controller = new AbortController();
        const reason = new Error('too slow');
        setTimeout(() => controller.abort(reason), 30);
        await assert.rejects(
            pool.read(SLOW_QUERY, { signal: controller.signal }),
            (err) => err === reason,
        );
        // The pool keeps working afterwards.
        assert.strictEqual(
            (await pool.get('SELECT COUNT(*) AS n FROM t')).n,
            0,
        );
    });

    it('close drains in-flight work, is idempotent, and leaves no worker', {
        timeout: 60000,
    }, async function () {
        await freshPool();
        const slow = pool.read(SLOW_QUERY);
        const closed = pool.close();
        // The in-flight read still settles — close waits for it.
        const rows = await slow;
        assert.strictEqual(rows[0].n, 2000000);
        await closed;
        await pool.close(); // idempotent
        assert.ok(pool.closed);
        // New work refuses.
        await assert.rejects(pool.read('SELECT 1'), /pool is closed/);
        // The process exits on its own once the (only) pool is closed —
        // no worker survives — which the suite's own exit proves; here
        // assert the observable refusal instead.
    });

    // The test above has one operation in flight, which reaches a worker
    // immediately. Writes queue on the writer mutex instead, and work
    // waiting there had not been registered for the drain — close() saw
    // an almost-empty set, shut the workers down, and failed the waiting
    // writes with "pool worker exited unexpectedly". Accepted work must
    // complete however deep the queue is.
    it('close drains writes still queued on the writer', {
        timeout: 60000,
    }, async function () {
        await freshPool();
        const writes = Array.from({ length: 50 }, (_, i) =>
            pool.write('INSERT INTO t (b) VALUES (?)', [`row-${i}`]),
        );
        const closed = pool.close();
        const settled = await Promise.allSettled(writes);
        const failed = settled.filter((s) => s.status === 'rejected');
        assert.deepStrictEqual(
            failed.map((f) => f.reason?.message),
            [],
            'every accepted write completes across close()',
        );
        await closed;

        // And they are actually in the file, not merely resolved.
        const check = await sqlite3.open(file);
        assert.strictEqual((await check.get('SELECT count(*) n FROM t')).n, 50);
        await check.close();
    });

    // Same gap on the transaction path, which takes the writer mutex
    // directly rather than through the shared helper.
    it('close waits for a transaction that is still queued', {
        timeout: 60000,
    }, async function () {
        await freshPool();
        const blocker = pool.write('INSERT INTO t (b) VALUES (?)', ['first']);
        const queued = pool.transaction(async (tx) => {
            await tx.write('INSERT INTO t (b) VALUES (?)', ['in-tx']);
        });
        const closed = pool.close();
        await blocker;
        await queued;
        await closed;

        const check = await sqlite3.open(file);
        assert.strictEqual((await check.get('SELECT count(*) n FROM t')).n, 2);
        await check.close();
    });

    it('await using closes the pool', { timeout: 30000 }, async function () {
        file = join(TMP_DIR, `pool-dispose-${process.pid}-${Date.now()}.db`);
        removeDb(file);
        {
            const p = await sqlite3.pool(file, { readers: 1 });
            await p.exec('CREATE TABLE t (a)');
            await using poolDisposed = p;
            await poolDisposed.write('INSERT INTO t VALUES (1)');
        }
        assert.ok(true, 'await using disposed without hanging');
    });

    it('opens a file: URI filename in every worker', {
        timeout: 30000,
    }, async function () {
        // Without OPEN_URI in the workers' flags SQLite read the whole
        // URI as a literal path and every worker failed with a bare
        // SQLITE_CANTOPEN, even though pool() documents the URI form.
        file = join(TMP_DIR, `pool-uri-${process.pid}-${Date.now()}.db`);
        removeDb(file);
        const seed = await sqlite3.pool(file, { readers: 0 });
        await seed.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
        await seed.write('INSERT INTO t (b) VALUES (?)', ['uri']);
        await seed.close();

        pool = await sqlite3.pool(`file:${file}`, { readers: 2 });
        assert.strictEqual((await pool.get('SELECT b FROM t')).b, 'uri');
        // A read-write URI is still writable through the writer.
        await pool.write('INSERT INTO t (b) VALUES (?)', ['second']);
        assert.strictEqual(
            (await pool.get('SELECT COUNT(*) AS n FROM t')).n,
            2,
        );
    });

    it('honours a read-only URI and drops the WAL default for it', {
        timeout: 30000,
    }, async function () {
        // The canonical read-only form. WAL is a write, so the default
        // must not be applied here — otherwise the writer worker's
        // `PRAGMA journal_mode = WAL` fails and the whole pool refuses
        // to open.
        file = join(TMP_DIR, `pool-uri-ro-${process.pid}-${Date.now()}.db`);
        removeDb(file);
        const seed = await sqlite3.pool(file, { readers: 0, walMode: false });
        await seed.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
        await seed.write('INSERT INTO t (b) VALUES (?)', ['ro']);
        await seed.close();

        pool = await sqlite3.pool(`file:${file}?mode=ro`, { readers: 2 });
        assert.strictEqual((await pool.get('SELECT b FROM t')).b, 'ro');
        await assert.rejects(
            pool.write('INSERT INTO t (b) VALUES (?)', ['nope']),
            /readonly|SQLITE_READONLY/i,
            'mode=ro must actually be read-only',
        );
    });

    it('refuses walMode: true on a read-only URI instead of failing every worker', {
        timeout: 30000,
    }, async function () {
        await assert.rejects(
            sqlite3.pool('file:/tmp/whatever.db?mode=ro', {
                readers: 1,
                walMode: true,
            }),
            /cannot enable WAL on the read-only URI/,
        );
    });

    it('refuses a read-only URI whose file does not exist, and creates nothing', {
        timeout: 30000,
    }, async function () {
        // immutable=1 is a read-only assertion, but it is not a `mode`, so
        // SQLite did not stop the writer's OPEN_CREATE: the pool created a
        // 0-byte database, the readers opened it happily, and every query
        // returned nothing — a typo'd path looked like an empty database.
        const missing = join(
            TMP_DIR,
            `pool-missing-${process.pid}-${Date.now()}.db`,
        );
        removeDb(missing);
        await assert.rejects(
            sqlite3.pool(`file:${missing}?immutable=1`, { readers: 1 }),
            /SQLITE_CANTOPEN/,
        );
        assert.strictEqual(
            existsSync(missing),
            false,
            'a read-only URI must not create the database',
        );
        // mode=ro was already refused by SQLite itself; assert it stays so.
        await assert.rejects(
            sqlite3.pool(`file:${missing}?mode=ro`, { readers: 1 }),
            /SQLITE_CANTOPEN/,
        );
        assert.strictEqual(existsSync(missing), false);
    });

    it('reads an existing file through an immutable URI, and refuses writes', {
        timeout: 30000,
    }, async function () {
        file = join(TMP_DIR, `pool-imm-${process.pid}-${Date.now()}.db`);
        removeDb(file);
        const seed = await sqlite3.pool(file, { readers: 0, walMode: false });
        await seed.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
        await seed.write('INSERT INTO t (b) VALUES (?)', ['frozen']);
        await seed.close();

        pool = await sqlite3.pool(`file:${file}?immutable=1`, { readers: 2 });
        assert.strictEqual((await pool.get('SELECT b FROM t')).b, 'frozen');
        await assert.rejects(
            pool.write('INSERT INTO t (b) VALUES (?)', ['nope']),
            /readonly|SQLITE_READONLY/i,
        );
    });

    it('an in-memory pool works under default options', {
        timeout: 30000,
    }, async function () {
        // `PRAGMA journal_mode = WAL` reports 'memory' for an in-memory
        // database, which the writer read as a failure — so both
        // documented in-memory forms (readers: 0, and the cache=shared URI
        // the readers>0 error recommends) failed under nothing but the
        // defaults.
        const solo = await sqlite3.pool(':memory:', { readers: 0 });
        await solo.exec('CREATE TABLE t (a)');
        await solo.write('INSERT INTO t VALUES (1)');
        assert.deepStrictEqual(await solo.read('SELECT a FROM t'), [{ a: 1 }]);
        await solo.close();

        const shared = await sqlite3.pool('file::memory:?cache=shared', {
            readers: 2,
        });
        await shared.exec('CREATE TABLE t (a)');
        await shared.write('INSERT INTO t VALUES (2)');
        // The readers share the writer's database through the shared cache.
        assert.deepStrictEqual(await shared.read('SELECT a FROM t'), [
            { a: 2 },
        ]);
        await shared.close();

        // An explicit request is still an error rather than a silent no-op.
        await assert.rejects(
            sqlite3.pool(':memory:', { readers: 0, walMode: true }),
            /cannot enable WAL on the in-memory database/,
        );
    });

    it('refuses :memory: and unknown options loudly', {
        timeout: 30000,
    }, async function () {
        await assert.rejects(
            sqlite3.pool(':memory:'),
            /in-memory one cannot be shared across workers/,
        );
        // The URI spellings of the same thing: separate memory databases
        // per worker is the silent-wrong-answer version of this error.
        await assert.rejects(
            sqlite3.pool('file::memory:'),
            /in-memory one cannot be shared across workers/,
        );
        await assert.rejects(
            sqlite3.pool('file:anything?mode=memory'),
            /in-memory one cannot be shared across workers/,
        );
        await assert.rejects(
            sqlite3.pool('/tmp/x.db', { readers: -1 }),
            /readers.*non-negative integer/,
        );
        await assert.rejects(
            sqlite3.pool('/tmp/x.db', { nope: true }),
            /unknown option 'nope'/,
        );
        await assert.rejects(sqlite3.pool(''), /non-empty filename/);
    });

    it('readers: 0 routes reads to the writer', {
        timeout: 30000,
    }, async function () {
        file = join(TMP_DIR, `pool-wonly-${process.pid}-${Date.now()}.db`);
        removeDb(file);
        pool = await sqlite3.pool(file, { readers: 0 });
        await pool.exec('CREATE TABLE t (a)');
        await pool.write('INSERT INTO t VALUES (1)');
        assert.strictEqual((await pool.read('SELECT a FROM t'))[0].a, 1);
        // And the in-transaction refusal applies (reads would wait on
        // the writer the body holds).
        await assert.rejects(
            pool.transaction(async () => pool.read('SELECT 1')),
            /cannot run inside a pool.transaction\(\) body/,
        );
    });
});
