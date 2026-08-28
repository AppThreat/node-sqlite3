// Shared fixture and helper code for the bench cases. Everything here is
// setup, not measurement: the harness times `iter` bodies only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Formats an integer with thousands separators, locale-independently, so
 * case names are identical on every machine (they are the baseline keys).
 *
 * @param {number} n the number.
 * @returns {string} formatted string.
 */
export function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * SQL that materialises `n` integer rows 1..n via a recursive CTE, with
 * the given per-row column expressions.
 *
 * @param {number} n row count.
 * @param {string} cols comma-separated column expressions over `x`.
 * @param {string} table target table name (default `t`).
 * @returns {string} the INSERT ... SELECT statement.
 */
export function intRows(n, cols, table = 't') {
    return (
        `INSERT INTO ${table} SELECT ` +
        cols +
        ' FROM (WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < ' +
        n +
        ') SELECT x FROM cnt)'
    );
}

/**
 * Column expressions for an `x`-driven row with the requested width.
 * 1 column: the integer; 4: int, real, short text, 64-byte blob;
 * 16: a wider mix of ints, reals and texts.
 *
 * @param {number} width 1, 4 or 16 columns.
 * @returns {string} comma-separated expressions.
 */
export function colsFor(width) {
    if (width === 1) return 'x';
    if (width === 4) {
        return "x, x + 0.5, 'text-value-' || x, zeroblob(64)";
    }
    const parts = ['x', 'x + 0.5'];
    for (let i = 2; i < width; i++) {
        if (i % 3 === 0) parts.push(`x * ${i}`);
        else if (i % 3 === 1) parts.push(`x + ${i}.5`);
        else parts.push(`'col-${i}-' || x`);
    }
    return parts.join(', ');
}

/**
 * The column list matching `colsFor`, for CREATE TABLE.
 *
 * @param {number} width 1, 4 or 16 columns.
 * @returns {string} comma-separated `name type` definitions.
 */
export function colDefsFor(width) {
    if (width === 1) return 'c0 INTEGER';
    if (width === 4) return 'c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB';
    const parts = ['c0 INTEGER', 'c1 REAL'];
    for (let i = 2; i < width; i++) {
        parts.push(
            i % 3 === 0
                ? `c${i} INTEGER`
                : `c${i} ${i % 3 === 1 ? 'REAL' : 'TEXT'}`,
        );
    }
    return parts.join(', ');
}

/**
 * Waits for `n` sequential callback-style operations. Used to time the
 * callback API without a promise wrapper on the per-call path.
 *
 * @param {number} n how many operations to run.
 * @param {(i: number, done: () => void) => void} call issues operation `i`; must invoke `done` when it completes.
 * @returns {Promise<void>} resolves when all n operations completed, in order.
 */
export function seqCallbacks(n, call) {
    return new Promise((resolve) => {
        let i = 0;
        const next = () => {
            if (i === n) {
                resolve();
                return;
            }
            call(i, next);
            i++;
        };
        next();
    });
}

/**
 * Opens every connection the suite needs on one shared handle object, so
 * `dispose()` can close them all at the end. In-memory databases are used
 * wherever the fixture fits comfortably in RAM: they keep the OS page
 * cache out of the measurements.
 *
 * @param {typeof import('../lib/sqlite3.js').default} sqlite3 the driver.
 * @returns {{ mem: () => any, all: any[], dispose: () => Promise<void>}} connection registry.
 */
export function connectionRegistry(sqlite3) {
    /** @type {any[]} */
    const conns = [];
    return {
        /**
         * Opens (and registers) a new in-memory database.
         *
         * @param {string} [label] diagnostic label.
         * @returns {any} the open database.
         */
        mem(label = 'mem') {
            const db = new sqlite3.Database(':memory:');
            Reflect.set(db, 'benchLabel', label);
            conns.push(db);
            return db;
        },
        all: conns,
        /** Closes every registered connection. */
        async dispose() {
            for (const db of conns) {
                await new Promise((resolve) => db.close(resolve));
            }
            conns.length = 0;
        },
    };
}

/**
 * Creates a scratch directory for file-backed fixtures (the pool bench).
 *
 * @returns {{ dir: string, cleanup: () => void }} the directory path and a cleanup callback.
 */
export function scratchDir() {
    const dir = mkdtempSync(join(tmpdir(), 'node-sqlite3-bench-'));
    return {
        dir,
        cleanup() {
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
