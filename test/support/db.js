// Shared database helpers for new tests. Guarantee close() and temp-file
// cleanup so a failing assertion cannot leak handles or files into
// test/tmp/ — the legacy suites open-code this and several leak.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../../lib/sqlite3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TMP_DIR = join(__dirname, '..', 'tmp');

/**
 * Runs `fn` with an open `Database`, closing it afterwards whether `fn`
 * succeeds or throws.
 *
 * @param {(db: import('../../lib/sqlite3.js').Database) => Promise<void> | void} fn
 * @param {{ filename?: string, mode?: number }} [options]
 * @returns {Promise<void>}
 * @throws whatever `fn` threw, or the close error when close fails.
 * @example
 * await withDb(async (db) => {
 *     db.exec('CREATE TABLE t (i)');
 * });
 */
export async function withDb(fn, { filename = ':memory:', mode } = {}) {
    mkdirSync(TMP_DIR, { recursive: true });
    const db =
        mode === undefined
            ? new sqlite3.Database(filename)
            : new sqlite3.Database(filename, mode);
    let error;
    try {
        await fn(db);
    } catch (err) {
        error = err;
    }
    await new Promise((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
    }).catch((closeErr) => {
        if (!error) error = closeErr;
    });
    if (error) throw error;
}

/**
 * Runs `fn` on a database backed by a unique file under `test/tmp/`,
 * removing the file afterwards whether `fn` succeeds or throws.
 *
 * @param {(db: import('../../lib/sqlite3.js').Database) => Promise<void> | void} fn
 * @param {{ mode?: number }} [options]
 * @returns {Promise<void>}
 * @throws whatever `fn` threw.
 * @example
 * await withTempDb(async (db) => {
 *     db.exec('CREATE TABLE t (i)');
 * });
 */
export async function withTempDb(fn, { mode } = {}) {
    const filename = join(TMP_DIR, `helper-${randomUUID()}.db`);
    try {
        await withDb(fn, { filename, mode });
    } finally {
        rmSync(filename, { force: true });
    }
}
