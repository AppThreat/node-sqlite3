import assert from 'node:assert';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

async function openDb(rows = 250) {
    const db = await sqlite3.open(':memory:');
    await db.exec('CREATE TABLE t (a INT, b TEXT)');
    const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
    for (let i = 0; i < rows; i++) {
        await stmt.run(i, `row ${i}`);
    }
    await stmt.finalize();
    return db;
}

describe('iterate', function () {
    it('drains a full result set', async function () {
        const db = await openDb();
        const seen = [];
        for await (const row of db.iterate('SELECT a FROM t ORDER BY a')) {
            seen.push(row.a);
        }
        assert.strictEqual(seen.length, 250);
        assert.strictEqual(seen[0], 0);
        assert.strictEqual(seen[249], 249);
        await db.close();
    });

    it('binds parameters on the first fetch', async function () {
        const db = await openDb();
        const seen = [];
        for await (const row of db.iterate(
            'SELECT a FROM t WHERE a >= ? AND a < ? ORDER BY a',
            10,
            15,
        )) {
            seen.push(row.a);
        }
        assert.deepStrictEqual(seen, [10, 11, 12, 13, 14]);
        await db.close();
    });

    it('handles empty result sets', async function () {
        const db = await openDb();
        let iterations = 0;
        for await (const _row of db.iterate('SELECT a FROM t WHERE a < 0')) {
            iterations++;
        }
        assert.strictEqual(iterations, 0);
        await db.close();
    });

    it('rejects the first next() on bad SQL', async function () {
        const db = await openDb();
        await assert.rejects(
            async function () {
                for await (const _row of db.iterate('SELECT * FROM nope')) {
                    // unreachable
                }
            },
            function (err) {
                assert.strictEqual(err.code, 'SQLITE_ERROR');
                return true;
            },
        );
        await db.close();
    });

    // A statement that never reached `prepared` drops its whole queue in
    // Statement::CleanQueue without firing callbacks (src/statement.cc),
    // so the finalize the iterator's teardown waits on never calls back.
    // return() used to hang here forever.
    it('return() after a failed prepare still settles', async function () {
        const db = await openDb();
        const iterator = db.iterate('SELECT * FROM nope');
        await assert.rejects(iterator.next(), (err) => {
            assert.strictEqual(err.code, 'SQLITE_ERROR');
            return true;
        });
        assert.deepStrictEqual(await iterator.return(), {
            value: undefined,
            done: true,
        });
        assert.deepStrictEqual(db.getSync('SELECT 1 AS x'), { x: 1 });
        await db.close();
    });

    it('early break leaves the statement finalized and the db idle', async function () {
        const db = await openDb();
        let seen = 0;
        for await (const _row of db.iterate('SELECT a FROM t ORDER BY a')) {
            seen++;
            if (seen === 3) break;
        }
        assert.strictEqual(seen, 3);
        // The sync fast path is the strongest idle probe: it refuses to run
        // while anything is in flight or queued.
        const count = db.getSync('SELECT COUNT(*) AS c FROM t');
        assert.strictEqual(count.c, 250);
        await db.close();
    });

    it('early break on a borrowed statement resets it for reuse', async function () {
        const db = await openDb();
        const stmt = db.prepare('SELECT a FROM t ORDER BY a LIMIT 5');
        let seen = 0;
        for await (const _row of stmt.iterate()) {
            seen++;
            if (seen === 2) break;
        }
        assert.strictEqual(seen, 2);
        const rows = await stmt.all();
        assert.strictEqual(rows.length, 5);
        await stmt.finalize();
        await db.close();
    });

    it('a throw from the body cleans up and propagates', async function () {
        const db = await openDb();
        const stmt = db.prepare('SELECT a FROM t ORDER BY a');
        await assert.rejects(async function () {
            for await (const _row of stmt.iterate()) {
                throw new Error('consumer boom');
            }
        }, /consumer boom/);
        const count = db.getSync('SELECT COUNT(*) AS c FROM t');
        assert.strictEqual(count.c, 250);
        await stmt.finalize();
        await db.close();
    });

    it('holds the statement locked only while a fetch is in flight', async function () {
        const db = await openDb();
        const iterator = db.iterate('SELECT a FROM t ORDER BY a');
        const pending = iterator.next();
        // A fetch is in flight: the sync fast path must refuse to run.
        assert.throws(function () {
            db.getSync('SELECT 1');
        }, /busy|idle/i);
        const first = await pending;
        assert.strictEqual(first.value.a, 0);
        // Between fetches nothing is in flight: getSync works again.
        assert.deepStrictEqual(db.getSync('SELECT 1 AS x'), { x: 1 });
        await iterator.return();
        await db.close();
    });

    it('two concurrent iterators over the same statement is an error', async function () {
        const db = await openDb();
        const stmt = db.prepare('SELECT a FROM t');
        const first = stmt.iterate();
        await first.next();
        assert.throws(function () {
            stmt.iterate();
        }, /already being iterated/);
        await first.return();
        // After the first iterator finished, a new one is fine.
        const second = stmt.iterate();
        await second.next();
        await second.return();
        await stmt.finalize();
        await db.close();
    });

    it('iterating two statements on one database is fine', async function () {
        const db = await openDb();
        const s1 = db.prepare('SELECT a FROM t WHERE a < 10 ORDER BY a');
        const s2 = db.prepare('SELECT a FROM t WHERE a >= 10 ORDER BY a');
        const seen = [];
        for await (const row of s1.iterate()) {
            seen.push(row.a);
            for await (const inner of s2.iterate()) {
                seen.push(inner.a);
                break;
            }
        }
        assert.strictEqual(seen.length, 20);
        await s1.finalize();
        await s2.finalize();
        await db.close();
    });

    it('backpressure: memory stays flat over many rows with a slow consumer', {
        timeout: 60000,
    }, async function () {
        const db = await sqlite3.open(':memory:');
        // Warm up allocator and statement machinery first.
        for await (const _row of db.iterate(
            "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 1000) SELECT x, printf('%1024c', 'x') AS payload FROM cnt",
        )) {
            // drain
        }
        global.gc?.();
        const before = process.memoryUsage().heapUsed;
        let count = 0;
        for await (const _row of db.iterate(
            "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 100000) SELECT x, printf('%1024c', 'x') AS payload FROM cnt",
        )) {
            count++;
            // Slow consumer: yield regularly so the iterator can never run
            // ahead by more than one batch (max 1024 rows).
            if (count % 256 === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        assert.strictEqual(count, 100000);
        global.gc?.();
        const delta = process.memoryUsage().heapUsed - before;
        // Unbounded buffering would hold ~100k x 1KB = ~100MB live; the
        // batched iterator holds at most ~1024 rows live. The bound leaves
        // generous room for GC lag.
        assert.ok(
            delta < 40 * 1024 * 1024,
            `heap delta ${Math.round(delta / 1048576)}MB should stay under 40MB`,
        );
        await db.close();
    });

    it('db.stream returns an object-mode Readable', async function () {
        const db = await openDb();
        const rows = [];
        for await (const row of db.stream(
            'SELECT a FROM t WHERE a < 5 ORDER BY a',
        )) {
            rows.push(row);
        }
        assert.deepStrictEqual(
            rows.map((r) => r.a),
            [0, 1, 2, 3, 4],
        );
        await db.close();
    });

    it('fetch() is usable directly for paged reads', async function () {
        const db = await openDb();
        const stmt = db.prepare('SELECT a FROM t ORDER BY a');
        const page = await new Promise(function (resolve, reject) {
            stmt.fetch(10, function (err, rows, done) {
                if (err) reject(err);
                else resolve({ rows, done });
            });
        });
        assert.strictEqual(page.rows.length, 10);
        assert.strictEqual(page.done, false);
        assert.strictEqual(page.rows[9].a, 9);
        const rest = await new Promise(function (resolve, reject) {
            stmt.fetch(1000, function (err, rows, done) {
                if (err) reject(err);
                else resolve({ rows, done });
            });
        });
        assert.strictEqual(rest.rows.length, 240);
        assert.strictEqual(rest.done, true);
        await stmt.finalize();
        await db.close();
    });
});
