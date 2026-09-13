// Hand-maintained declaration for lib/migrate.js (sqlite3.migrate). The
// runner itself is JSDoc-documented in the implementation file.

import type { Database } from './native.js';

/**
 * One migration: a name, and either a SQL script or a programmatic body.
 */
export interface Migration {
    /** The migration's name (for errors and reporting). */
    name: string;
    /** The SQL script (or use `up`). */
    sql?: string;
    /** A programmatic body; receives the transaction connection. */
    up?(tx: Database): unknown;
}

/**
 * Runs every pending migration against the connection, in order, each in
 * one transaction with `PRAGMA user_version` tracking the position.
 * Idempotent.
 *
 * @since 9.1.0
 */
export declare function migrate(
    db: Database,
    migrations: string | Migration[],
): Promise<{ applied: string[]; from: number; to: number }>;
