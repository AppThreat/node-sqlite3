// Micro-benchmarks for the hot paths targeted by the marshalling
// optimisations: row conversion (all/each), bind marshalling (run),
// and blob transfers. Run: node bench/bench.js
import sqlite3 from '../lib/sqlite3.js';

function bench(name, fn) {
    return new Promise((resolve) => {
        // warmup
        fn(() => {
            const start = process.hrtime.bigint();
            fn(() => {
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                resolve({ name, ms });
            });
        });
    });
}

async function benchAsync(name, fn) {
    await fn(); // warmup
    const start = process.hrtime.bigint();
    await fn();
    return { name, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

const results = [];

async function main() {
    const db = new sqlite3.Database(':memory:');
    const db2 = new sqlite3.Database(':memory:');
    const db3 = new sqlite3.Database(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b REAL, c TEXT, d BLOB)');
    db.exec('CREATE TABLE t2 (a INTEGER, b REAL, c TEXT, d BLOB)');
    db2.exec('CREATE TABLE t2 (a INTEGER, b REAL, c TEXT, d BLOB)');
    db3.exec('CREATE TABLE t (a INTEGER, b REAL, c TEXT, d BLOB)');
    await new Promise((r) => {
        const s = db3.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
        const buf = Buffer.alloc(64);
        for (let i = 0; i < 20000; i++) {
            buf[0] = i & 0xff;
            s.run(i, i + 0.5, `text-value-${i}`, buf);
        }
        s.finalize(r);
    });
    db.exec('CREATE TABLE t3 (d BLOB)');

    await new Promise((r) => {
        const stmt = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
        const buf = Buffer.alloc(64);
        for (let i = 0; i < 20000; i++) {
            buf[0] = i & 0xff;
            stmt.run(i, i + 0.5, `text-value-${i}`, buf);
        }
        stmt.finalize(r);
    });

    results.push(
        await bench('all: 20k rows x 4 cols (read cache)', (done) => {
            db.all('SELECT a, b, c, d FROM t', () => done());
        }),
    );

    results.push(
        await bench('each: 20k rows x 4 cols', (done) => {
            let _n = 0;
            db.each(
                'SELECT a, b, c, d FROM t',
                () => {
                    _n++;
                },
                () => done(),
            );
        }),
    );

    results.push(
        await bench('run: 10k inserts (bind+exec)', (done) => {
            db.exec('DELETE FROM t2', () => {
                const stmt = db.prepare('INSERT INTO t2 VALUES (?, ?, ?, ?)');
                const buf = Buffer.alloc(64);
                for (let i = 0; i < 10000; i++) {
                    buf[0] = i & 0xff;
                    stmt.run(i, i + 0.5, `text-value-${i}`, buf);
                }
                stmt.finalize(() => done());
            });
        }),
    );

    results.push(
        await bench('db.run: 10k (prepare per call)', (done) => {
            db.exec('DELETE FROM t2', () => {
                let i = 0;
                const next = () => {
                    if (i === 10000) return done();
                    db.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                        () => {
                            i++;
                            next();
                        },
                    );
                };
                next();
            });
        }),
    );

    results.push(
        await bench('db.run + trace: 10k', (done) => {
            const onTrace = function () {
                /* no-op listener: measures dispatch cost only */
            };
            db.on('trace', onTrace);
            db.exec('DELETE FROM t2', () => {
                let i = 0;
                const next = () => {
                    if (i === 10000) {
                        db.removeListener('trace', onTrace);
                        return done();
                    }
                    db.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                        () => {
                            i++;
                            next();
                        },
                    );
                };
                next();
            });
        }),
    );

    results.push(
        await bench('db.run + profile: 10k', (done) => {
            const onProfile = function () {
                /* no-op listener: measures dispatch cost only */
            };
            db.on('profile', onProfile);
            db.exec('DELETE FROM t2', () => {
                let i = 0;
                const next = () => {
                    if (i === 10000) {
                        db.removeListener('profile', onProfile);
                        return done();
                    }
                    db.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                        () => {
                            i++;
                            next();
                        },
                    );
                };
                next();
            });
        }),
    );

    // Deliverable 07: the write-path hooks. "No hook installed" is the
    // structural zero (the native hook exists only while a listener is
    // registered); the removed-listener variant proves removal returns
    // to it. The commit-listener variants measure the active cost.
    results.push(
        await bench('db.run + commit listener: 10k autocommits', (done) => {
            const onCommit = function () {
                /* no-op listener: measures dispatch cost only */
            };
            db.on('commit', onCommit);
            db.exec('DELETE FROM t2', () => {
                let i = 0;
                const next = () => {
                    if (i === 10000) {
                        db.removeListener('commit', onCommit);
                        return done();
                    }
                    db.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                        () => {
                            i++;
                            next();
                        },
                    );
                };
                next();
            });
        }),
    );

    results.push(
        await bench('db.run + change+commit listeners: 10k', (done) => {
            const onCommit = function () {
                /* no-op listener: measures dispatch cost only */
            };
            const onChange = function () {
                /* no-op listener: measures dispatch cost only */
            };
            db.on('commit', onCommit);
            db.on('change', onChange);
            db.exec('DELETE FROM t2', () => {
                let i = 0;
                const next = () => {
                    if (i === 10000) {
                        db.removeListener('commit', onCommit);
                        db.removeListener('change', onChange);
                        return done();
                    }
                    db.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                        () => {
                            i++;
                            next();
                        },
                    );
                };
                next();
            });
        }),
    );

    results.push(
        await bench('db.run after hook removal: 10k', (done) => {
            const onCommit = function () {
                /* installed and removed: proves removal restores baseline */
            };
            db.on('commit', onCommit);
            db.removeListener('commit', onCommit);
            db.exec('DELETE FROM t2', () => {
                let i = 0;
                const next = () => {
                    if (i === 10000) return done();
                    db.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                        () => {
                            i++;
                            next();
                        },
                    );
                };
                next();
            });
        }),
    );

    // Cancellation-token polling cost: an installed token adds one
    // relaxed atomic load per `period` VM instructions. Paired against
    // "get: 10k single-row lookups" above: the same prepared statement,
    // same parameters, token installed vs not.
    results.push(
        await bench(
            'stmt.get 10k with cancellation token installed',
            (done) => {
                const token = db.cancellationToken();
                const stmt = db.prepare(
                    'SELECT a, b, c, d FROM t WHERE rowid = ?',
                );
                let i = 0;
                const next = () => {
                    if (i === 10000) {
                        return stmt.finalize(() => {
                            token.destroy();
                            done();
                        });
                    }
                    i++;
                    stmt.get((i % 20000) + 1, next);
                };
                next();
            },
        ),
    );

    results.push(
        await bench('db.run cached: 10k', (done) => {
            db2.cacheStatements();
            db2.exec('DELETE FROM t2', () => {
                let i = 0;
                const next = () => {
                    if (i === 10000) return done();
                    db2.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                        () => {
                            i++;
                            next();
                        },
                    );
                };
                next();
            });
        }),
    );

    // Pure synchronous loop: the intended usage pattern for the sync API.
    {
        db3.cacheStatements();
        let warm = db3.getSync('SELECT a, b, c, d FROM t WHERE rowid = ?', 1);
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < 10000; i++) {
            warm = db3.getSync(
                'SELECT a, b, c, d FROM t WHERE rowid = ?',
                (i % 20000) + 1,
            );
        }
        if (warm === undefined) throw new Error('lookup failed');
        results.push({
            name: 'db.getSync cached: 10k lookups',
            ms: Number(process.hrtime.bigint() - t0) / 1e6,
        });
    }

    results.push(
        await bench('get: 10k single-row lookups', (done) => {
            const stmt = db.prepare('SELECT a, b, c, d FROM t WHERE rowid = ?');
            let i = 0;
            const next = () => {
                if (i === 10000) return stmt.finalize(() => done());
                i++;
                stmt.get((i % 20000) + 1, next);
            };
            next();
        }),
    );

    // --- Promise-mode variants: the wrapper sits on the hot path of every
    // call, so its overhead is measured against the callback rows above.

    results.push(
        await benchAsync('db.all (promise): 20k rows x 4 cols', async () => {
            await db.all('SELECT a, b, c, d FROM t');
        }),
    );

    results.push(
        await benchAsync('stmt.get (promise): 10k lookups', async () => {
            const stmt = db.prepare('SELECT a, b, c, d FROM t WHERE rowid = ?');
            for (let i = 0; i < 10000; i++) {
                await stmt.get((i % 20000) + 1);
            }
            await stmt.finalize();
        }),
    );

    results.push(
        await benchAsync(
            'db.run (promise): 10k (prepare per call)',
            async () => {
                await db.exec('DELETE FROM t2');
                for (let i = 0; i < 10000; i++) {
                    await db.run(
                        'INSERT INTO t2 VALUES (?, ?, ?, ?)',
                        i,
                        i + 0.5,
                        `text-value-${i}`,
                        Buffer.alloc(64),
                    );
                }
            },
        ),
    );

    results.push(
        await benchAsync('iterate: 20k rows x 4 cols (for await)', async () => {
            let n = 0;
            for await (const _row of db.iterate('SELECT a, b, c, d FROM t')) {
                n++;
            }
            if (n !== 20000) throw new Error(`iterate saw ${n} rows`);
        }),
    );

    // --- Streaming comparison at 200k rows: each vs all vs iterate.
    const db4 = new sqlite3.Database(':memory:');
    await new Promise((r) => {
        db4.exec(
            'CREATE TABLE big (a INTEGER, b REAL, c TEXT, d BLOB);\n' +
                "INSERT INTO big SELECT x, x+0.5, 'text-value-'||x, zeroblob(64) " +
                'FROM (WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 200000) SELECT x FROM cnt);',
            r,
        );
    });

    results.push(
        await bench('each: 200k rows', (done) => {
            let n = 0;
            db4.each(
                'SELECT a, b, c, d FROM big',
                () => {
                    n++;
                },
                () => {
                    if (n !== 200000) throw new Error(`each saw ${n} rows`);
                    done();
                },
            );
        }),
    );

    results.push(
        await bench('all: 200k rows', (done) => {
            db4.all('SELECT a, b, c, d FROM big', (_err, rows) => {
                if (rows.length !== 200000) throw new Error('bad count');
                done();
            });
        }),
    );

    results.push(
        await benchAsync('iterate: 200k rows (for await)', async () => {
            let n = 0;
            for await (const _row of db4.iterate(
                'SELECT a, b, c, d FROM big',
            )) {
                n++;
            }
            if (n !== 200000) throw new Error(`iterate saw ${n} rows`);
        }),
    );

    results.push(
        await bench('blob: 2k x 256KB round-trip', (done) => {
            const buf = Buffer.alloc(256 * 1024);
            for (let j = 0; j < buf.length; j++) buf[j] = j & 0xff;
            db.exec('DELETE FROM t3', () => {
                const stmt = db.prepare('INSERT INTO t3 (d) VALUES (?)');
                for (let i = 0; i < 2000; i++) stmt.run(buf);
                stmt.finalize(() => {
                    db.all('SELECT d FROM t3', () => done());
                });
            });
        }),
    );

    // --- User-defined functions (Deliverable 06): the JS round trip is
    // the cost that decides when a JS function is the wrong tool. Three
    // equivalent 100k-row filters — in SQL, in a JS function called per
    // row, and in plain JS after all() — plus the raw per-call cost of a
    // minimal JS scalar, an aggregate step, and a collation comparison.

    {
        const dbf = new sqlite3.Database(':memory:');
        await new Promise((r) =>
            dbf.exec(
                'CREATE TABLE f (a INT, b REAL, c TEXT, d BLOB);\n' +
                    "INSERT INTO f SELECT x, x+0.5, 'text-'||x, zeroblob(64) " +
                    'FROM (WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 100000) SELECT x FROM cnt);',
                r,
            ),
        );

        const sqlMs = await benchAsync(
            'filter 100k: in SQL (a % 7 = 0)',
            async () => {
                const rows = await dbf.all('SELECT a FROM f WHERE a % 7 = 0');
                if (rows.length !== 14285) throw new Error('bad count');
            },
        );

        dbf.function('seventh', { deterministic: true }, (a) =>
            a % 7 === 0 ? 1 : 0,
        );
        const jsFnMs = await benchAsync(
            'filter 100k: JS fn per row (seventh)',
            async () => {
                const rows = await dbf.all(
                    'SELECT a FROM f WHERE seventh(a) = 1',
                );
                if (rows.length !== 14285) throw new Error('bad count');
            },
        );
        dbf.removeFunction('seventh');

        const jsPostMs = await benchAsync(
            'filter 100k: JS after all()',
            async () => {
                const rows = await dbf.all('SELECT a FROM f');
                const kept = rows.filter((r) => r.a % 7 === 0);
                if (kept.length !== 14285) throw new Error('bad count');
            },
        );

        results.push(sqlMs, jsFnMs, jsPostMs);

        // Raw round-trip cost: one minimal JS call per row, no filtering.
        dbf.function('noop', { deterministic: true }, (_a) => 1);
        const noopMs = await benchAsync(
            'JS round trip: 100k minimal calls',
            async () => {
                await dbf.all('SELECT noop(a) FROM f');
            },
        );
        results.push(noopMs);
        const perCallUs = (noopMs.ms * 1000) / 100000;
        results.push({
            name: 'JS round trip: per call',
            ms: perCallUs,
            unit: 'us',
        });

        dbf.aggregate('accumulate', {
            start: () => 0,
            step: (acc, _v) => acc + 1,
            result: (acc) => acc,
        });
        const aggMs = await benchAsync(
            'JS aggregate step: 100k rows',
            async () => {
                const row = await dbf.get('SELECT accumulate(a) AS v FROM f');
                if (row.v !== 100000) throw new Error('bad count');
            },
        );
        results.push(aggMs);

        dbf.collation('natsort', (x, y) => (x < y ? -1 : x > y ? 1 : 0));
        const collMs = await benchAsync(
            'JS collation: sort 100k as text',
            async () => {
                await dbf.all(
                    'SELECT a FROM f ORDER BY CAST(a AS TEXT) COLLATE natsort',
                );
            },
        );
        results.push(collMs);

        // db.transaction() reading (D05 follow-up: AsyncLocalStorage sits
        // on the transaction path and nothing had measured it). The raw
        // BEGIN/COMMIT comparator separates the engine cost from the
        // wrapper's (AsyncLocalStorage, the flow-store copy, validation).
        const txMs = await benchAsync(
            'db.transaction: 200 empty bodies',
            async () => {
                for (let i = 0; i < 200; i++) {
                    await dbf.transaction(async (tx) => {
                        await tx.get('SELECT 1 AS v');
                    });
                }
            },
        );
        results.push(txMs);
        const rawTxMs = await benchAsync(
            'raw BEGIN+COMMIT: 200 pairs',
            async () => {
                for (let i = 0; i < 200; i++) {
                    await dbf.exec('BEGIN');
                    await dbf.exec('COMMIT');
                }
            },
        );
        results.push(rawTxMs);
        const txOverheadUs = ((txMs.ms - rawTxMs.ms) * 1000) / 200;
        results.push({
            name: 'db.transaction: wrapper overhead',
            ms: txOverheadUs,
            unit: 'us',
        });

        await dbf.close();
    }

    for (const r of results) {
        const value =
            'unit' in r && r.unit === 'us'
                ? `${r.ms.toFixed(2).padStart(8)} us`
                : `${r.ms.toFixed(1).padStart(8)} ms`;
        console.log(r.name.padEnd(40), value);
    }
    await new Promise((r) =>
        db.close(() => db2.close(() => db3.close(() => db4.close(r)))),
    );
}

main();
