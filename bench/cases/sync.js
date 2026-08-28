// Sync vs async (Deliverable 13 §2.2): getSync/runSync/allSync against
// their async equivalents at 1, 10, 100 and 10,000 operations. This is
// where README's "roughly 6x faster" claim lives — the harness publishes
// the curve (per-op cost as the batch grows), not one number, and every
// ratio is checked against the same-run noise floor before it is called
// a result.
//
import { fmt } from './shared.js';

// Both sides use the statement cache: that is the documented fast-path
// pairing (README shows getSync after cacheStatements(), and the async
// equivalent of a cached sync call is a cached async call).

/** Batch sizes the curve is measured at. */
const SIZES = [1, 10, 100, 10000];

/**
 * Builds the sync-vs-async cases on two cache-enabled connections with
 * identical 20,000-row read tables and empty write tables.
 *
 * @param {any} dbSync connection for the sync cases (cache enabled).
 * @param {any} dbAsync connection for the async cases (cache enabled).
 * @returns {import('../harness.js').CaseSpec[]} the sync-vs-async cases.
 */
export function syncCases(dbSync, dbAsync) {
    const ddl = 'CREATE TABLE t (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)';
    const seed =
        "INSERT INTO t SELECT x, x + 0.5, 'text-value-' || x, zeroblob(64) " +
        'FROM (WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 20000) SELECT x FROM cnt)';
    for (const db of [dbSync, dbAsync]) {
        db.exec(
            `${ddl}; CREATE TABLE wt (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB); ${seed}`,
        );
        db.cacheStatements();
    }
    const GET_SQL = 'SELECT * FROM t WHERE rowid = ?';
    const RUN_SQL = 'INSERT INTO wt VALUES (?, ?, ?, ?)';
    const buf = Buffer.alloc(64);

    /** @type {import('../harness.js').CaseSpec[]} */
    const cases = [];

    for (const size of SIZES) {
        const label = fmt(size);

        cases.push({
            name: `sync-vs-async/get: batch of ${label} (async)`,
            group: 'sync-vs-async',
            ops: size,
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < size; i++) {
                        await dbAsync.get(GET_SQL, (i % 20000) + 1);
                    }
                }
            },
        });
        cases.push({
            name: `sync-vs-async/getSync: batch of ${label}`,
            group: 'sync-vs-async',
            ops: size,
            ratioTo: `sync-vs-async/get: batch of ${label} (async)`,
            iter: (_env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < size; i++) {
                        dbSync.getSync(GET_SQL, (i % 20000) + 1);
                    }
                }
            },
        });

        cases.push({
            name: `sync-vs-async/run: batch of ${label} (async)`,
            group: 'sync-vs-async',
            ops: size,
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    dbAsync.runSync('DELETE FROM wt');
                    for (let i = 0; i < size; i++) {
                        await dbAsync.run(
                            RUN_SQL,
                            i,
                            i + 0.5,
                            `text-value-${i}`,
                            buf,
                        );
                    }
                }
            },
        });
        cases.push({
            name: `sync-vs-async/runSync: batch of ${label}`,
            group: 'sync-vs-async',
            ops: size,
            ratioTo: `sync-vs-async/run: batch of ${label} (async)`,
            note: 'each round clears the table first (timed, not counted)',
            iter: (_env, n) => {
                for (let r = 0; r < n; r++) {
                    dbSync.runSync('DELETE FROM wt');
                    for (let i = 0; i < size; i++) {
                        dbSync.runSync(
                            RUN_SQL,
                            i,
                            i + 0.5,
                            `text-value-${i}`,
                            buf,
                        );
                    }
                }
            },
        });
    }

    // allSync against the async `read/all: 20,000 rows × 4 cols` case:
    // the crossover point — one threadpool round trip amortised over
    // 20,000 marshalled rows should narrow the gap to near nothing.
    cases.push({
        name: 'sync-vs-async/allSync: 20,000 rows × 4 cols',
        group: 'sync-vs-async',
        ops: 20000,
        ratioTo: 'read/all: 20,000 rows × 4 cols',
        iter: (_env, n) => {
            for (let i = 0; i < n; i++) {
                const rows = dbSync.allSync('SELECT * FROM t');
                if (rows.length !== 20000) throw new Error('bad row count');
            }
        },
    });

    return cases;
}
