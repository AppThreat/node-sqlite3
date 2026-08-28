// Read-path cases (Deliverable 13 §2.2): `all` across a rows × columns
// matrix, plus `get`/`each`/`iterate`/`map`, a wide-text row set and a
// mostly-NULL row set. Marshalling optimisations that only help narrow
// integer columns should show up here as exactly that.
import { colDefsFor, colsFor, fmt, intRows } from './shared.js';

/**
 * Builds the read cases on a fresh connection: tables r_<rows>_<cols> for
 * the size matrix, plus the wide and mostly-NULL sets.
 *
 * @param {any} db an open, cache-free connection.
 * @returns {import('../harness.js').CaseSpec[]} the read cases.
 */
export function readCases(db) {
    const sizes = [
        [1000, 1],
        [1000, 4],
        [1000, 16],
        [20000, 1],
        [20000, 4],
        [20000, 16],
        [200000, 1],
        [200000, 4],
        [200000, 16],
    ];

    /** @type {import('../harness.js').CaseSpec[]} */
    const cases = [];
    for (const [rows, cols] of sizes) {
        db.exec(`CREATE TABLE r_${rows}_${cols} (${colDefsFor(cols)})`);
        db.exec(intRows(rows, colsFor(cols), `r_${rows}_${cols}`));
        cases.push({
            name: `read/all: ${fmt(rows)} rows × ${cols} cols`,
            group: 'read',
            ops: rows,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const rowsOut = await db.all(
                        `SELECT * FROM r_${rows}_${cols}`,
                    );
                    if (rowsOut.length !== rows)
                        throw new Error('bad row count');
                }
            },
            alloc: rows === 20000 && (cols === 1 || cols === 4),
            allocIter: async (env, n) => {
                for (let i = 0; i < n; i++) {
                    env.keep = await db.all(`SELECT * FROM r_${rows}_${cols}`);
                }
            },
        });
    }

    // Wide rows: 8 columns of ~100-char text — the shape that stresses
    // string marshalling rather than integer conversion.
    db.exec(
        'CREATE TABLE r_wide (c0 TEXT, c1 TEXT, c2 TEXT, c3 TEXT, c4 TEXT, c5 TEXT, c6 TEXT, c7 TEXT)',
    );
    db.exec(
        intRows(
            20000,
            Array.from(
                { length: 8 },
                (_, i) => `'w${i}-' || printf('%096d', x)`,
            ).join(', '),
            'r_wide',
        ),
    );
    cases.push({
        name: 'read/all: 20,000 rows × 8 cols wide text',
        group: 'read',
        ops: 20000,
        // ~80 MB of string allocation per sample makes GC pauses a real
        // part of this case; more samples keep the median honest about it.
        samples: 48,
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                const rowsOut = await db.all('SELECT * FROM r_wide');
                if (rowsOut.length !== 20000) throw new Error('bad row count');
            }
        },
        alloc: true,
        allocIter: async (env, _n) => {
            env.keep = await db.all('SELECT * FROM r_wide');
        },
    });

    // Mostly-NULL rows: 7 of 8 columns NULL — NULL marshalling and the
    // fixed per-row overhead, without payload conversion work.
    db.exec(
        'CREATE TABLE r_null (c0 INTEGER, c1 INTEGER, c2 INTEGER, c3 INTEGER, c4 INTEGER, c5 INTEGER, c6 INTEGER, c7 INTEGER)',
    );
    db.exec(
        intRows(20000, 'x, NULL, NULL, NULL, NULL, NULL, NULL, NULL', 'r_null'),
    );
    cases.push({
        name: 'read/all: 20,000 rows × 8 cols mostly NULL',
        group: 'read',
        ops: 20000,
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                const rowsOut = await db.all('SELECT * FROM r_null');
                if (rowsOut.length !== 20000) throw new Error('bad row count');
            }
        },
        alloc: true,
        allocIter: async (env, _n) => {
            env.keep = await db.all('SELECT * FROM r_null');
        },
    });

    // Single-row get through a prepared statement: the interactive lookup.
    // rowid lookup, not a table scan.
    cases.push({
        name: 'read/get: single row (prepared statement)',
        group: 'read',
        iter: async (_env, n) => {
            const stmt = db.prepare('SELECT * FROM r_20000_4 WHERE rowid = ?');
            for (let i = 0; i < n; i++) {
                await stmt.get((i % 20000) + 1);
            }
            await stmt.finalize();
        },
    });

    cases.push({
        name: 'read/each: 20,000 rows × 4 cols',
        group: 'read',
        ops: 20000,
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                await new Promise((resolve, reject) => {
                    let seen = 0;
                    db.each(
                        'SELECT * FROM r_20000_4',
                        () => {
                            seen++;
                        },
                        (/** @type {Error | null} */ err) => {
                            if (err) reject(err);
                            else if (seen !== 20000)
                                reject(new Error('bad row count'));
                            else resolve();
                        },
                    );
                });
            }
        },
    });

    cases.push({
        name: 'read/iterate: 20,000 rows × 4 cols (for await)',
        group: 'read',
        ops: 20000,
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                let seen = 0;
                for await (const _row of db.iterate(
                    'SELECT * FROM r_20000_4',
                )) {
                    seen++;
                }
                if (seen !== 20000) throw new Error('bad row count');
            }
        },
    });

    cases.push({
        name: 'read/map: 20,000 rows × 4 cols',
        group: 'read',
        ops: 20000,
        // map() returns an object keyed by the first column, not an array.
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                const mapped = await db.map('SELECT c0 FROM r_20000_4');
                if (
                    !Object.hasOwn(mapped, '1') ||
                    !Object.hasOwn(mapped, '20000')
                ) {
                    throw new Error('bad map keys');
                }
            }
        },
    });

    return cases;
}
