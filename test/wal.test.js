import assert from 'node:assert';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/** Removes a database file and its journal/WAL siblings. */
function removeDb(file) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        rmSync(`${file}${suffix}`, { force: true });
    }
}

import sqlite3 from '../lib/sqlite3.js';
import { TMP_DIR, withDb } from './support/db.js';

// WAL control (Deliverable 07): the 'wal' event fires per writing commit
// with a frame count, checkpoint() reports plausible frame counts in
// every mode, and TRUNCATE actually shrinks the -wal file.

const FILE = join(TMP_DIR, 'wal-hook-test.db');

async function walDb() {
    removeDb(FILE);
    const db = new sqlite3.Database(FILE);
    await new Promise((resolve, reject) => {
        db.once('open', resolve);
        db.once('error', reject);
    });
    const mode = await db.get('PRAGMA journal_mode=WAL');
    assert.strictEqual(
        mode.journal_mode.toLowerCase(),
        'wal',
        'test db must be in WAL mode',
    );
    await db.exec('CREATE TABLE IF NOT EXISTS t (a)');
    return db;
}

describe('wal', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = await walDb();
    });

    afterEach(async function () {
        await db.close();
        removeDb(FILE);
    });

    it('the wal event fires with a database name and frame count', async function () {
        /** @type {[string, number][]} */
        const events = [];
        db.on('wal', (database, pages) => events.push([database, pages]));
        await db.run('INSERT INTO t VALUES (1)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(events.length >= 1, `wal events: ${events.length}`);
        for (const [database, pages] of events) {
            assert.strictEqual(database, 'main');
            assert.ok(
                Number.isInteger(pages) && pages >= 0,
                `pages must be a non-negative integer, got ${pages}`,
            );
        }
        // Frames accumulate until a checkpoint.
        const last = events[events.length - 1][1];
        assert.ok(last >= 1, `at least one frame after a write, got ${last}`);
    });

    it('wal events stop after removeListener', async function () {
        let count = 0;
        const listener = () => count++;
        db.on('wal', listener);
        await db.run('INSERT INTO t VALUES (2)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        const afterFirst = count;
        db.removeListener('wal', listener);
        await db.run('INSERT INTO t VALUES (3)');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(afterFirst >= 1);
        assert.strictEqual(count, afterFirst, 'no events after removal');
    });
});

describe('checkpoint', function () {
    it('reports plausible frame counts in every mode', async function () {
        const file = join(TMP_DIR, 'wal-checkpoint-modes.db');
        removeDb(file);
        await withDb(
            async (db) => {
                const mode = await db.get('PRAGMA journal_mode=WAL');
                assert.strictEqual(mode.journal_mode.toLowerCase(), 'wal');
                await db.exec('CREATE TABLE c (a)');
                await db.run('INSERT INTO c VALUES (1)');
                await db.run('INSERT INTO c VALUES (2)');

                for (const name of ['passive', 'full', 'restart', 'truncate']) {
                    const result = await db.checkpoint({ mode: name });
                    assert.strictEqual(
                        result.busy,
                        false,
                        `${name} should not be busy`,
                    );
                    assert.ok(
                        Number.isInteger(result.logFrames) &&
                            result.logFrames >= 0,
                        `${name} logFrames: ${result.logFrames}`,
                    );
                    assert.ok(
                        Number.isInteger(result.checkpointedFrames) &&
                            result.checkpointedFrames >= 0,
                        `${name} checkpointedFrames: ${result.checkpointedFrames}`,
                    );
                }
            },
            { filename: file },
        );
        removeDb(file);
    });

    it('TRUNCATE shrinks the -wal file', async function () {
        const file = join(TMP_DIR, 'wal-truncate.db');
        removeDb(file);
        await withDb(
            async (db) => {
                await db.get('PRAGMA journal_mode=WAL');
                await db.exec('CREATE TABLE t (a BLOB)');
                for (let i = 0; i < 20; i++) {
                    await db.run(
                        'INSERT INTO t VALUES (?)',
                        Buffer.alloc(4096, 1),
                    );
                }
                const walFile = `${file}-wal`;
                const before = statSync(walFile).size;
                assert.ok(
                    before > 0,
                    'WAL file must have frames before the checkpoint',
                );

                const result = await db.checkpoint({ mode: 'truncate' });
                assert.strictEqual(result.busy, false);
                const after = statSync(walFile).size;
                assert.ok(after < before, `WAL shrank: ${before} -> ${after}`);
            },
            { filename: file },
        );
        removeDb(file);
    });

    it('accepts the mode as a string and the db name in options', async function () {
        const file = join(TMP_DIR, 'wal-options.db');
        removeDb(file);
        await withDb(
            async (db) => {
                await db.get('PRAGMA journal_mode=WAL');
                await db.exec('CREATE TABLE t (a)');
                await db.run('INSERT INTO t VALUES (1)');
                const r1 = await db.checkpoint('truncate');
                assert.strictEqual(r1.busy, false);
                const r2 = await db.checkpoint({ mode: 'passive', db: 'main' });
                assert.strictEqual(r2.busy, false);
                // Callback form returns the database itself.
                const self = await new Promise((resolve, reject) => {
                    const returned = db.checkpoint(function (err, result) {
                        if (err) reject(err);
                        else resolve(result);
                    });
                    assert.strictEqual(returned, db);
                });
                assert.ok(typeof self.busy === 'boolean');
            },
            { filename: file },
        );
        removeDb(file);
    });

    it('rejects an unknown mode', async function () {
        await withDb(async (db) => {
            await assert.rejects(
                /** @type {any} */ (db).checkpoint({ mode: 'sideways' }),
                /mode must be/,
            );
        });
    });

    it('is quiet on a non-WAL database', async function () {
        // A rollback-journal database has no WAL; sqlite reports a
        // successful no-op rather than an error.
        await withDb(async (db) => {
            const result = await db.checkpoint();
            assert.strictEqual(result.busy, false);
            assert.strictEqual(result.logFrames, -1);
            assert.strictEqual(result.checkpointedFrames, -1);
        });
    });
});
