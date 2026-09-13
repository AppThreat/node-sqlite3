import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Phase 5: the user_version-based migration runner.

describe('migrate()', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
    });

    afterEach(async function () {
        await db.close();
    });

    it('applies pending migrations in order and bumps user_version', async function () {
        const { applied, from, to } = await sqlite3.migrate(db, [
            { name: '0001-create', sql: 'CREATE TABLE a (x)' },
            {
                name: '0002-seed',
                up: (tx) => tx.run('INSERT INTO a VALUES (1)'),
            },
        ]);
        assert.deepStrictEqual(applied, ['0001-create', '0002-seed']);
        assert.strictEqual(from, 0);
        assert.strictEqual(to, 2);
        assert.strictEqual(
            await db.pragma('user_version', { simple: true }),
            2,
        );
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM a')).n, 1);
    });

    it('is idempotent', async function () {
        await sqlite3.migrate(db, [{ name: 'a', sql: 'CREATE TABLE a (x)' }]);
        const second = await sqlite3.migrate(db, [
            { name: 'a', sql: 'CREATE TABLE b (x)' },
        ]);
        assert.deepStrictEqual(second.applied, []);
    });

    it('rolls a failing migration back and names it', async function () {
        await sqlite3.migrate(db, [{ name: 'a', sql: 'CREATE TABLE a (x)' }]);
        await assert.rejects(
            sqlite3.migrate(db, [
                { name: 'a', sql: 'CREATE TABLE a (x)' },
                {
                    name: 'b',
                    sql: 'CREATE TABLE b (x);\nINSERT INTO nonexistent VALUES (1)',
                },
            ]),
            /migration b \(version 2\) failed/,
        );
        // user_version is still 1: the failed migration did not land.
        assert.strictEqual(
            await db.pragma('user_version', { simple: true }),
            1,
        );
    });

    it('loads migrations from a directory, ordered numerically', async function () {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
        try {
            writeFileSync(
                path.join(dir, '002-second.sql'),
                'CREATE TABLE b (x)',
            );
            writeFileSync(path.join(dir, '10-tenth.sql'), 'CREATE TABLE j (x)');
            writeFileSync(
                path.join(dir, '001-first.sql'),
                'CREATE TABLE a (x)',
            );
            const { applied } = await sqlite3.migrate(db, dir);
            assert.deepStrictEqual(applied, [
                '001-first',
                '002-second',
                '10-tenth',
            ]);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it('validates the migration list', async function () {
        await assert.rejects(sqlite3.migrate(db, 7), /array of migrations/);
        await assert.rejects(
            sqlite3.migrate(db, [/** @type {any} */ ({ name: 'x' })]),
            /must be \{ name, sql \} or \{ name, up \}/,
        );
        await assert.rejects(
            sqlite3.migrate(db, [
                /** @type {any} */
                ({ name: 'x', sql: 'SELECT 1', up: () => undefined }),
            ]),
            /both sql and up/,
        );
    });

    it('wraps a non-Error rejection instead of throwing over it', async function () {
        await assert.rejects(
            sqlite3.migrate(db, [
                {
                    name: '0001-throws-a-string',
                    up: () => Promise.reject('nope'),
                },
            ]),
            (err) =>
                err instanceof Error &&
                /0001-throws-a-string \(version 1\) failed: nope/.test(
                    err.message,
                ) &&
                err.cause === 'nope',
        );
        assert.strictEqual(
            await db.pragma('user_version', { simple: true }),
            0,
        );
    });

    it('reports the database version when it is ahead of the list', async function () {
        await db.pragma('user_version = 5');
        const result = await sqlite3.migrate(db, [
            { name: '0001-a', sql: 'CREATE TABLE a (x)' },
        ]);
        assert.deepStrictEqual(result, { applied: [], from: 5, to: 5 });
    });
});
