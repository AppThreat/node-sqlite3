// A zero-dependency Kysely dialect for @appthreat/sqlite3 (Phase 6).
// Kysely's SqliteDialect is written against better-sqlite3's sync
// surface; this adapter maps the same contract onto this package's
// async-first connection — prepared statements carry the `readonly`
// flag Kysely's driver checks, and iterate() provides the streaming
// reads its SELECTs want.
//
// Requires kysely as a peer: `npm install kysely`.

import {
    Kysely,
    SqliteAdapter,
    SqliteIntrospector,
    SqliteQueryCompiler,
} from 'kysely';

/**
 * Builds a Kysely instance over one @appthreat/sqlite3 connection.
 *
 * @param {import('@appthreat/sqlite3').Database} db the connection.
 * @param {{ onCreateConnection?: (db: unknown) => Promise<void> | void }} [hooks]
 *   `onCreateConnection` runs once per connection (where pragmas go).
 */
export function kyselyFor(db, hooks = {}) {
    const dialect = {
        createAdapter: () => new SqliteAdapter(),
        createQueryCompiler: () => new SqliteQueryCompiler(),
        createIntrospector: (database) =>
            new SqliteIntrospector(database, dialect),
        createDriver: () => ({
            async init() {
                if (hooks.onCreateConnection) {
                    await hooks.onCreateConnection(db);
                }
                // Kysely prepares one statement per compiled query; the
                // cache keeps re-issued queries (its identity columns
                // lookups, its selects) off the prepare path.
                db.cacheStatements();
            },
            async acquireConnection() {
                return {
                    async executeQuery(compiledQuery) {
                        const { sql, parameters } = compiledQuery;
                        const stmt = await db.prepare(sql);
                        try {
                            if (stmt.readonly) {
                                return { rows: await stmt.all(parameters) };
                            }
                            const run = await stmt.run(parameters);
                            return {
                                rows: [],
                                insertId:
                                    run.lastID !== undefined &&
                                    run.lastID !== null
                                        ? run.lastID
                                        : undefined,
                                numUpdatedOrDeletedRows:
                                    run.changes !== undefined &&
                                    run.changes !== null
                                        ? BigInt(run.changes)
                                        : undefined,
                            };
                        } finally {
                            await stmt.finalize();
                        }
                    },
                };
            },
            async releaseConnection() {
                /* one long-lived connection */
            },
            async beginTransaction() {
                await db.exec('BEGIN');
            },
            async commitTransaction() {
                await db.exec('COMMIT');
            },
            async rollbackTransaction() {
                await db.exec('ROLLBACK');
            },
            async destroy() {
                // The caller owns the connection (it passed it in);
                // close it yourself after kysely.destroy().
            },
        }),
    };
    return new Kysely({ dialect });
}

// Usage:
//   const db = await sqlite3.open('app.db');
//   const kysely = kyselyFor(db, {
//       onCreateConnection: (c) => c.pragma('journal_mode = WAL'),
//   });
//   const rows = await kysely.selectFrom('users').selectAll().execute();
