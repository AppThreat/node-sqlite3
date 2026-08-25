// Entry-point driver for marshalling tests (Deliverable 02). Runs one
// bind+read through every public query path — async and sync, Database
// and Statement — so the two native marshalling implementations
// (src/statement.cc Work_* vs the *Sync fast path) cannot drift apart
// unnoticed.

/**
 * Wraps a callback-style call so a synchronous throw is reported as
 * `{ threw }` instead of escaping.
 *
 * @param {() => void} fn
 * @returns {Promise<{ threw?: Error }>}
 */
function captureSyncThrow(fn) {
    return new Promise((resolve) => {
        try {
            fn();
        } catch (err) {
            resolve({ threw: err });
        }
    });
}

/**
 * Builds one driver per query path. Each driver binds `params` to
 * `SELECT ? AS v` (or the given single-placeholder SQL) and resolves
 * with `{ threw }` (synchronous failure), `{ err }` (callback failure),
 * or `{ v }` (the value read back; bind-only paths resolve `{}` on
 * success).
 *
 * @param {import('../../lib/sqlite3.js').Database} db
 * @returns {{ name: string, reads: boolean, run: (value: unknown) => Promise<{threw?: Error, err?: Error, v?: unknown}> }[]}
 */
export function bindPaths(db) {
    const select = 'SELECT ? AS v';

    const paths = [
        {
            name: 'db.get',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        db.get(select, [value], (err, row) =>
                            resolve(err ? { err } : { v: row?.v }),
                        );
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'db.all',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        db.all(select, [value], (err, rows) =>
                            resolve(err ? { err } : { v: rows[0]?.v }),
                        );
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'db.each',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    let seen;
                    let itemErr;
                    try {
                        db.each(
                            select,
                            [value],
                            (err, row) => {
                                if (err) {
                                    // e.g. the 'number'-mode RangeError
                                    itemErr = itemErr || err;
                                    return;
                                }
                                seen = row?.v;
                            },
                            (err) =>
                                resolve(
                                    err || itemErr
                                        ? { err: err || itemErr }
                                        : { v: seen },
                                ),
                        );
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'db.map',
            reads: true,
            // map() keys its result by the first column and takes the
            // second as the value, so a two-column shape is required.
            // The read-back is reported as the stringified key.
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        db.map(
                            'SELECT ? AS v, 0 AS extra',
                            [value],
                            (err, map) =>
                                resolve(
                                    err
                                        ? { err }
                                        : {
                                              v: Object.keys(map ?? {})[0],
                                              stringified: true,
                                          },
                                ),
                        );
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'db.run',
            reads: false,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        db.run(select, [value], (err) =>
                            resolve(err ? { err } : {}),
                        );
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'stmt.get',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    let stmt;
                    try {
                        stmt = db.prepare(select);
                    } catch (err) {
                        resolve({ threw: err });
                        return;
                    }
                    try {
                        stmt.get([value], (err, row) => {
                            // Resolve only once finalize completed, so
                            // the next path sees a fully idle database.
                            stmt.finalize(() =>
                                resolve(err ? { err } : { v: row?.v }),
                            );
                        });
                    } catch (err) {
                        stmt.finalize(() => resolve({ threw: err }));
                    }
                }),
        },
        {
            name: 'stmt.all',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    let stmt;
                    try {
                        stmt = db.prepare(select);
                    } catch (err) {
                        resolve({ threw: err });
                        return;
                    }
                    try {
                        stmt.all([value], (err, rows) => {
                            stmt.finalize(() =>
                                resolve(err ? { err } : { v: rows[0]?.v }),
                            );
                        });
                    } catch (err) {
                        stmt.finalize(() => resolve({ threw: err }));
                    }
                }),
        },
        {
            name: 'stmt.each',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    let stmt;
                    try {
                        stmt = db.prepare(select);
                    } catch (err) {
                        resolve({ threw: err });
                        return;
                    }
                    let seen;
                    let itemErr;
                    try {
                        stmt.each(
                            [value],
                            (err, row) => {
                                if (err) {
                                    itemErr = itemErr || err;
                                    return;
                                }
                                seen = row?.v;
                            },
                            (err) => {
                                stmt.finalize(() =>
                                    resolve(
                                        err || itemErr
                                            ? { err: err || itemErr }
                                            : { v: seen },
                                    ),
                                );
                            },
                        );
                    } catch (err) {
                        stmt.finalize(() => resolve({ threw: err }));
                    }
                }),
        },
        {
            name: 'stmt.run',
            reads: false,
            run: (value) =>
                new Promise((resolve) => {
                    let stmt;
                    try {
                        stmt = db.prepare(select);
                    } catch (err) {
                        resolve({ threw: err });
                        return;
                    }
                    try {
                        stmt.run([value], (err) => {
                            stmt.finalize(() => resolve(err ? { err } : {}));
                        });
                    } catch (err) {
                        stmt.finalize(() => resolve({ threw: err }));
                    }
                }),
        },
        {
            name: 'db.getSync',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        resolve({ v: db.getSync(select, [value])?.v });
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'db.allSync',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        resolve({ v: db.allSync(select, [value])[0]?.v });
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'db.runSync',
            reads: false,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        db.runSync(select, [value]);
                        resolve({});
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'stmt.getSync',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        const stmt = db.prepareSync(select);
                        const out = { v: stmt.getSync([value])?.v };
                        stmt.finalize();
                        resolve(out);
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'stmt.allSync',
            reads: true,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        const stmt = db.prepareSync(select);
                        const out = { v: stmt.allSync([value])[0]?.v };
                        stmt.finalize();
                        resolve(out);
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
        {
            name: 'stmt.runSync',
            reads: false,
            run: (value) =>
                new Promise((resolve) => {
                    try {
                        const stmt = db.prepareSync(select);
                        stmt.runSync([value]);
                        stmt.finalize();
                        resolve({});
                    } catch (err) {
                        resolve({ threw: err });
                    }
                }),
        },
    ];

    return paths;
}

export { captureSyncThrow };
