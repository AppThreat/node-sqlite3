import assert from 'node:assert';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

const BACKUP_FILE = 'test/tmp/dispose-backup.db';

describe('dispose', function () {
    it('await using closes the database', async function () {
        let db;
        {
            await using outer = await sqlite3.open(':memory:');
            db = outer;
            await outer.exec('CREATE TABLE t (a INT)');
        }
        assert.strictEqual(db.open, false);
    });

    it('explicit close() plus dispose does not double-reject', async function () {
        await using db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        await db.close();
        // The disposed close is a no-op, not a rejection.
    });

    it('a throw inside the block still disposes', async function () {
        let db;
        try {
            await using outer = await sqlite3.open(':memory:');
            db = outer;
            throw new Error('block boom');
        } catch (err) {
            assert.match(err.message, /block boom/);
        }
        assert.strictEqual(db.open, false);
    });

    it('a real close error still propagates out of dispose', async function () {
        // An unfinalized statement makes close() fail with SQLITE_BUSY;
        // dispose must surface that, not swallow it.
        const db = await sqlite3.open(':memory:');
        const stmt = db.prepare('SELECT 1');
        await assert.rejects(db[Symbol.asyncDispose](), function (err) {
            assert.strictEqual(err.primaryCode, 'SQLITE_BUSY');
            return true;
        });
        await stmt.finalize();
        await db.close();
    });

    it('await using finalizes the statement', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        {
            await using stmt = db.prepare('SELECT a FROM t');
            assert.deepStrictEqual(await stmt.get(), undefined);
        }
        // If the statement were still open, close() would fail BUSY.
        await db.close();
    });

    it('double dispose of a statement is a no-op', async function () {
        const db = await sqlite3.open(':memory:');
        const stmt = db.prepare('SELECT 1');
        await stmt[Symbol.asyncDispose]();
        await stmt[Symbol.asyncDispose]();
        await db.close();
    });

    it('using (sync) finalizes a prepareSync statement', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        {
            using stmt = db.prepareSync('SELECT a FROM t');
            assert.deepStrictEqual(stmt.getSync(), undefined);
        }
        await db.close();
    });

    it('await using finishes the backup', async function () {
        fs.rmSync(BACKUP_FILE, { force: true });
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (a INT)');
        await db.run('INSERT INTO t VALUES (1)');
        {
            await using backup = db.backup(BACKUP_FILE);
            let completed = false;
            while (!completed) {
                completed = await backup.step(16);
            }
        }
        await db.close();
        const check = await sqlite3.open(BACKUP_FILE);
        assert.deepStrictEqual(await check.get('SELECT a FROM t'), { a: 1 });
        await check.close();
        fs.rmSync(BACKUP_FILE, { force: true });
    });

    it('double dispose of a backup is a no-op', async function () {
        fs.rmSync(BACKUP_FILE, { force: true });
        const db = await sqlite3.open(':memory:');
        const backup = db.backup(BACKUP_FILE);
        while (!(await backup.step(16)));
        await backup[Symbol.asyncDispose]();
        await backup[Symbol.asyncDispose]();
        await db.close();
        fs.rmSync(BACKUP_FILE, { force: true });
    });
});
