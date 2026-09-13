// `sqlite3.migrate(db, migrations)` (Phase 5): a dependency-free,
// `PRAGMA user_version`-based sequential migration runner. No driver
// ships one (libsql ships only a CLI); keeping it opt-in and tiny is the
// point.
//
// Migrations are either an array of { name, sql } / { name, up(db) }
// entries, or a directory path of `NNN-name.sql` files (sorted by the
// numeric prefix, falling back to lexicographic). Each pending migration
// runs inside one transaction (a JS `up` body can await; a raw `sql`
// script may contain several statements) and bumps `user_version` inside
// that transaction, so an interrupted run leaves nothing half-applied.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One migration.
 *
 * @typedef {object} Migration
 * @property {string} name the migration's name (for errors and reporting).
 * @property {string} [sql] the SQL script (or use `up`).
 * @property {string} [up_sql] the normalized SQL script (internal).
 * @property {(tx: import('./native.js').Database) => unknown | Promise<unknown>} [up]
 *   a programmatic body; receives the transaction connection.
 */

/**
 * Normalizes the migrations argument into an ordered name/body list.
 *
 * @param {string | Migration[]} migrations a directory path or a list.
 * @returns {Migration[]} the ordered migrations.
 * @throws {TypeError} for a malformed list or unreadable directory.
 * @private
 */
function loadMigrations(migrations) {
    if (typeof migrations === 'string') {
        let entries;
        try {
            entries = readdirSync(migrations);
        } catch (err) {
            throw new TypeError(
                `migrate() cannot read the migrations directory ${migrations}: ` +
                    /** @type {Error} */ (err).message,
            );
        }
        return entries
            .filter((entry) => entry.endsWith('.sql'))
            .map((entry) => {
                const stem = entry.slice(0, -4);
                return /** @type {Migration} */ ({
                    name: stem,
                    up_sql: readFileSync(path.join(migrations, entry), 'utf8'),
                });
            })
            .sort((a, b) => {
                const na = Number.parseInt(a.name ?? '', 10);
                const nb = Number.parseInt(b.name ?? '', 10);
                if (Number.isInteger(na) && Number.isInteger(nb) && na !== nb) {
                    return na - nb;
                }
                return (a.name ?? '').localeCompare(b.name ?? '');
            });
    }
    if (!Array.isArray(migrations)) {
        throw new TypeError(
            'migrate() requires an array of migrations or a directory path',
        );
    }
    return migrations.map((entry, i) => {
        if (
            entry === null ||
            typeof entry !== 'object' ||
            typeof entry.name !== 'string' ||
            (typeof entry.up !== 'function' &&
                typeof entry.up_sql !== 'string' &&
                typeof entry.sql !== 'string')
        ) {
            throw new TypeError(
                `migrate()[${i}] must be { name, sql } or { name, up }`,
            );
        }
        if (entry.up !== undefined && (entry.sql || entry.up_sql)) {
            throw new TypeError(
                `migrate()[${i}] (${entry.name}) has both sql and up; pick one`,
            );
        }
        return /** @type {Migration} */ ({
            name: entry.name,
            up: entry.up,
            up_sql: entry.up_sql ?? entry.sql,
        });
    });
}

/**
 * Runs every pending migration against the connection, in order, each in
 * one transaction with `PRAGMA user_version` tracking the position.
 * Idempotent: already-applied migrations (by position — the first
 * `user_version` entries) are skipped.
 *
 * @param {import('./native.js').Database} db the connection.
 * @param {string | Migration[]} migrations a directory of `NNN-name.sql`
 *   files or a list of `{ name, sql }` / `{ name, up }` entries.
 * @returns {Promise<{ applied: string[], from: number, to: number }>} the
 *   applied names and the version range.
 * @throws {TypeError} when the migrations are malformed; rejects with the
 *   failing migration's error (its work rolled back).
 * @since 9.1.0
 * @example
 * await sqlite3.migrate(db, [
 *     { name: '0001-create-users', sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY)' },
 *     { name: '0002-seed', up: (tx) => tx.run('INSERT INTO users DEFAULT VALUES') },
 * ]);
 */
export async function migrate(db, migrations) {
    const list = loadMigrations(migrations);
    const from =
        /** @type {number} */ (
            await db.pragma('user_version', { simple: true })
        ) ?? 0;
    /** @type {string[]} */
    const applied = [];
    for (let i = from; i < list.length; i++) {
        const migration = list[i];
        try {
            await db.transaction(
                async (tx) => {
                    if (migration.up !== undefined) {
                        await migration.up(tx);
                    } else {
                        await tx.exec(/** @type {string} */ (migration.up_sql));
                    }
                    await tx.run(`PRAGMA user_version = ${i + 1}`);
                },
                { mode: 'immediate' },
            );
            applied.push(migration.name);
        } catch (err) {
            const context = `migration ${migration.name} (version ${
                i + 1
            }) failed`;
            // Prefix the failure in place when it is an Error (keeping its
            // code/errno/stack), and wrap anything else — a migration that
            // rejects with a string must not make this throw a TypeError
            // about assigning to `message`.
            if (err instanceof Error) {
                err.message = `${context}: ${err.message}`;
                throw err;
            }
            throw new Error(`${context}: ${String(err)}`, { cause: err });
        }
    }
    // `to` is where the database now is, which is `from` when nothing was
    // pending — including a database ahead of the list (a rollback of the
    // application without a rollback of its schema).
    return { applied, from, to: Math.max(from, list.length) };
}
