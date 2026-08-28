// Comparison baselines (Deliverable 13 §2.3): node:sqlite (built in —
// the default choice for Node users today, so every sync-path number is
// reported next to it) and better-sqlite3 (the incumbent sync binding,
// behind --compare and an optional install; it is NOT a devDependency —
// `npm i --no-save better-sqlite3` before running with --compare).
//
// The mirrors use the same fixtures and statement shapes as the package
// cases they are ratio'd against.
import { intRows } from './shared.js';

/** @typedef {import('../harness.js').CaseSpec} CaseSpec */

/**
 * The four mirror cases against a synchronous baseline driver
 * (node:sqlite's DatabaseSync or better-sqlite3's Database).
 *
 * @param {any} db the baseline connection (prepared-statement API: prepare/get/all/run/exec).
 * @param {string} prefix case-name prefix, e.g. 'baseline/node:sqlite'.
 * @param {{ getSyncCase: string, allSyncCase: string, insertCase: string, execCase: string }} ratios case names to ratio against.
 * @returns {CaseSpec[]} the mirror cases.
 */
export function baselineCases(db, prefix, ratios) {
    db.exec('CREATE TABLE t (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    db.exec(intRows(20000, "x, x + 0.5, 'text-value-' || x, zeroblob(64)"));
    db.exec('CREATE TABLE w (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    const buf = Buffer.alloc(64);
    const K = 1000;

    /** @type {CaseSpec[]} */
    return [
        {
            name: `${prefix}/get: single row (prepared)`,
            group: 'baseline',
            ratioTo: ratios.getSyncCase,
            iter: (_env, n) => {
                const stmt = db.prepare('SELECT * FROM t WHERE rowid = ?');
                for (let i = 0; i < n; i++) {
                    stmt.get((i % 20000) + 1);
                }
            },
        },
        {
            name: `${prefix}/all: 20,000 rows × 4 cols`,
            group: 'baseline',
            ops: 20000,
            ratioTo: ratios.allSyncCase,
            iter: (_env, n) => {
                const stmt = db.prepare('SELECT * FROM t');
                for (let i = 0; i < n; i++) {
                    const rows = stmt.all();
                    if (rows.length !== 20000) throw new Error('bad count');
                }
            },
        },
        {
            name: `${prefix}/insert: prepared ×1,000`,
            group: 'baseline',
            ops: K,
            ratioTo: ratios.insertCase,
            note: 'each round clears the table first (timed, not counted)',
            iter: (_env, n) => {
                const del = db.prepare('DELETE FROM w');
                const stmt = db.prepare('INSERT INTO w VALUES (?, ?, ?, ?)');
                for (let r = 0; r < n; r++) {
                    del.run();
                    for (let i = 0; i < K; i++) {
                        stmt.run(i, i + 0.5, `text-value-${i}`, buf);
                    }
                }
            },
        },
        {
            name: `${prefix}/exec: 100-statement script`,
            group: 'baseline',
            ops: 100,
            ratioTo: ratios.execCase,
            iter: (_env, n) => {
                const script = Array.from(
                    { length: 100 },
                    (_, i) =>
                        `INSERT INTO w VALUES (${i}, ${i}.5, 's${i}', x'00')`,
                ).join(';\n');
                for (let i = 0; i < n; i++) {
                    db.exec(`DELETE FROM w;\n${script}`);
                }
            },
        },
    ];
}

/**
 * Builds the node:sqlite mirror cases when the built-in module is
 * importable (Node >= 22.5; unflagged since 23.4).
 *
 * @param {{ getSyncCase: string, allSyncCase: string, insertCase: string, execCase: string }} ratios case names to ratio against.
 * @returns {Promise<{ cases: CaseSpec[], dispose: () => void } | { skipped: string }>} the mirror cases, or a skip reason.
 */
export async function nodeSqliteCases(ratios) {
    let mod;
    try {
        mod = await import('node:sqlite');
    } catch (err) {
        return {
            skipped: `node:sqlite not available: ${/** @type {Error} */ (err).message}`,
        };
    }
    const db = new mod.DatabaseSync(':memory:');
    return {
        cases: baselineCases(db, 'baseline/node:sqlite', ratios),
        dispose: () => db.close(),
    };
}

/**
 * Builds the better-sqlite3 mirror cases when the package is installed
 * and --compare was passed. Never a devDependency of this repo.
 *
 * @param {{ getSyncCase: string, allSyncCase: string, insertCase: string, execCase: string }} ratios case names to ratio against.
 * @returns {Promise<{ cases: CaseSpec[], dispose: () => void } | { skipped: string }>} the mirror cases, or a skip reason.
 */
export async function betterSqliteCases(ratios) {
    let mod;
    try {
        mod = await import('better-sqlite3');
    } catch {
        return {
            skipped:
                'better-sqlite3 not installed (optional; npm i --no-save better-sqlite3)',
        };
    }
    const db = mod.default(':memory:');
    return {
        cases: baselineCases(db, 'baseline/better-sqlite3', ratios),
        dispose: () => db.close(),
    };
}
