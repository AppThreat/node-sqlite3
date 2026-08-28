// Overhead cases (Deliverable 13 §2.2): promise vs callback per call,
// trace/profile listeners, the statement cache hit/miss/disabled trio,
// JS scalar functions per row, and the per-deliverable keepers (hooks,
// cancellation token, transaction wrapper, open+close).
import { intRows, seqCallbacks } from './shared.js';

/** @typedef {import('../harness.js').CaseSpec} CaseSpec */

/**
 * Builds the callback/promise, trace/profile, hook and token cases.
 *
 * @param {any} db an open connection with an empty write table `ow`.
 * @returns {CaseSpec[]} overhead cases sharing that connection.
 */
export function overheadCases(db) {
    db.exec('CREATE TABLE ow (c0 INTEGER, c1 REAL, c2 TEXT, c3 BLOB)');
    db.cacheStatements();
    const RUN_SQL = 'INSERT INTO ow VALUES (?, ?, ?, ?)';
    const buf = Buffer.alloc(64);
    const K = 1000;

    /** One cached-write round: clear, then K inserts. */
    const writeRound = async () => {
        await db.exec('DELETE FROM ow');
        for (let i = 0; i < K; i++) {
            await db.run(RUN_SQL, i, i + 0.5, `text-value-${i}`, buf);
        }
    };

    /** @type {CaseSpec[]} */
    const cases = [
        {
            name: 'overhead/stmt.get: 1,000 (callback)',
            group: 'overhead',
            ops: 1000,
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    await seqCallbacks(1000, (i, done) =>
                        db.get('SELECT 42 AS v, ? AS p', i, done),
                    );
                }
            },
        },
        {
            name: 'overhead/stmt.get: 1,000 (promise)',
            group: 'overhead',
            ops: 1000,
            ratioTo: 'overhead/stmt.get: 1,000 (callback)',
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < 1000; i++) {
                        await db.get('SELECT 42 AS v, ? AS p', i);
                    }
                }
            },
        },
        {
            name: 'overhead/db.run cached: 1,000',
            group: 'overhead',
            ops: K,
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) await writeRound();
            },
        },
    ];

    // trace/profile: attach a no-op listener for the round, remove it
    // after, so each case is self-contained on the shared connection.
    for (const kind of ['trace', 'profile']) {
        cases.push({
            name: `overhead/db.run cached + ${kind} listener: 1,000`,
            group: 'overhead',
            ops: K,
            ratioTo: 'overhead/db.run cached: 1,000',
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                const listener = () => {
                    /* no-op listener: measures dispatch cost only */
                };
                db.on(kind, listener);
                try {
                    for (let r = 0; r < n; r++) await writeRound();
                } finally {
                    db.removeListener(kind, listener);
                }
            },
        });
    }

    // The D07 write-path hooks. "after removal" is the structural zero:
    // the native hook exists only while a listener is registered, and the
    // case proves removal returns to the cached baseline.
    cases.push(
        {
            name: 'overhead/db.run cached + commit listener: 1,000 autocommits',
            group: 'overhead',
            ops: K,
            ratioTo: 'overhead/db.run cached: 1,000',
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                const listener = () => {
                    /* no-op listener: measures dispatch cost only */
                };
                db.on('commit', listener);
                try {
                    for (let r = 0; r < n; r++) await writeRound();
                } finally {
                    db.removeListener('commit', listener);
                }
            },
        },
        {
            name: 'overhead/db.run cached + change+commit listeners: 1,000',
            group: 'overhead',
            ops: K,
            ratioTo: 'overhead/db.run cached: 1,000',
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                const onCommit = () => {
                    /* no-op listener: measures dispatch cost only */
                };
                const onChange = () => {
                    /* no-op listener: measures dispatch cost only */
                };
                db.on('commit', onCommit);
                db.on('change', onChange);
                try {
                    for (let r = 0; r < n; r++) await writeRound();
                } finally {
                    db.removeListener('commit', onCommit);
                    db.removeListener('change', onChange);
                }
            },
        },
        {
            name: 'overhead/db.run cached after listener removal: 1,000',
            group: 'overhead',
            ops: K,
            ratioTo: 'overhead/db.run cached: 1,000',
            note: 'each round clears the table first (timed, not counted)',
            iter: async (_env, n) => {
                const listener = () => {
                    /* no-op listener: measures dispatch cost only */
                };
                db.on('commit', listener);
                db.removeListener('commit', listener);
                for (let r = 0; r < n; r++) await writeRound();
            },
        },
        {
            name: 'overhead/stmt.get: 10,000 with cancellation token',
            group: 'overhead',
            ops: 10000,
            ratioTo: 'read/get: single row (prepared statement)',
            setup: () => {
                const token = db.cancellationToken();
                const stmt = db.prepare('SELECT 42 AS v');
                return { token, stmt };
            },
            teardown: async (env) => {
                await new Promise((resolve) => env.stmt.finalize(resolve));
                env.token.destroy();
            },
            iter: async (env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < 10000; i++) {
                        await env.stmt.get();
                    }
                }
            },
        },
    );

    return cases;
}

/**
 * The statement-cache trio (§2.2): hit (same SQL every call), miss (never
 * the same SQL twice — a 16-entry cache over 1,000 distinct statements),
 * and disabled (no cache; a prepare per call through the database queue).
 * Three connections, because cacheStatements() cannot be turned off.
 *
 * @param {{ hit: any, miss: any, disabled: any }} dbs three connections, each with a 1,000-row lookup table `g`.
 * @returns {CaseSpec[]} the cache trio cases.
 */
export function cacheTrioCases(dbs) {
    for (const db of [dbs.hit, dbs.miss, dbs.disabled]) {
        db.exec('CREATE TABLE g (v INTEGER)');
        db.exec(intRows(1000, 'x', 'g'));
    }
    dbs.hit.cacheStatements(64);
    dbs.miss.cacheStatements(16);

    /** @type {CaseSpec[]} */
    const cases = [
        {
            name: 'overhead/get: statement cache hit',
            group: 'overhead',
            ops: 1000,
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < 1000; i++) {
                        await dbs.hit.get(
                            'SELECT v FROM g WHERE rowid = ?',
                            (i % 1000) + 1,
                        );
                    }
                }
            },
        },
        {
            name: 'overhead/get: statement cache miss',
            group: 'overhead',
            ops: 1000,
            ratioTo: 'overhead/get: statement cache hit',
            iter: async (_env, n) => {
                let call = 0;
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < 1000; i++) {
                        // Every call prepares: never the same SQL twice,
                        // and the 16-entry cache keeps evicting.
                        await dbs.miss.get(
                            `SELECT v FROM g WHERE rowid = ? /*${call++}*/`,
                            (i % 1000) + 1,
                        );
                    }
                }
            },
        },
        {
            name: 'overhead/get: statement cache disabled',
            group: 'overhead',
            ops: 1000,
            ratioTo: 'overhead/get: statement cache hit',
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < 1000; i++) {
                        await dbs.disabled.get(
                            'SELECT v FROM g WHERE rowid = ?',
                            (i % 1000) + 1,
                        );
                    }
                }
            },
        },
    ];
    return cases;
}

/**
 * The user-defined-function keepers (Deliverable 06): the JS round trip
 * is the cost that decides when a JS function is the wrong tool — a JS
 * function called from a query running on a worker thread pays a
 * cross-thread round trip per invocation, which is the number to beat.
 *
 * Row counts are 20,000 (10,000 for the collation sort): a JS call per
 * row costs tens of microseconds, so 100k rows per sample — the old
 * one-shot bench's shape — would put a single sample over two seconds.
 *
 * @param {any} db an open connection with a 20,000-row table `f`.
 * @returns {CaseSpec[]} the UDF cases.
 */
export function udfCases(db) {
    db.exec('CREATE TABLE f (a INT, b REAL, c TEXT, d BLOB)');
    db.exec(intRows(20000, "x, x + 0.5, 'text-' || x, zeroblob(64)", 'f'));

    /** @type {CaseSpec[]} */
    const cases = [
        {
            name: 'overhead/filter 20k: in SQL (a % 7 = 0)',
            group: 'overhead',
            ops: 20000,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const rows = await db.all(
                        'SELECT a FROM f WHERE a % 7 = 0',
                    );
                    if (rows.length !== 2857) throw new Error('bad count');
                }
            },
        },
        {
            name: 'overhead/filter 20k: JS function per row',
            group: 'overhead',
            ops: 20000,
            samples: 24,
            iter: async (_env, n) => {
                db.function('seventh', { deterministic: true }, (a) =>
                    a % 7 === 0 ? 1 : 0,
                );
                try {
                    for (let i = 0; i < n; i++) {
                        const rows = await db.all(
                            'SELECT a FROM f WHERE seventh(a) = 1',
                        );
                        if (rows.length !== 2857) throw new Error('bad count');
                    }
                } finally {
                    db.removeFunction('seventh');
                }
            },
        },
        {
            name: 'overhead/filter 20k: JS after all()',
            group: 'overhead',
            ops: 20000,
            iter: async (_env, n) => {
                for (let i = 0; i < n; i++) {
                    const rows = await db.all('SELECT a FROM f');
                    const kept = rows.filter(
                        (/** @type {{a: number}} */ r) => r.a % 7 === 0,
                    );
                    if (kept.length !== 2857) throw new Error('bad count');
                }
            },
        },
        {
            name: 'overhead/JS round trip: 20k minimal calls',
            group: 'overhead',
            ops: 20000,
            samples: 24,
            iter: async (_env, n) => {
                db.function('noop', { deterministic: true }, (_a) => 1);
                try {
                    for (let i = 0; i < n; i++) {
                        await db.all('SELECT noop(a) FROM f');
                    }
                } finally {
                    db.removeFunction('noop');
                }
            },
        },
        {
            name: 'overhead/JS aggregate: 20k steps',
            group: 'overhead',
            ops: 20000,
            samples: 24,
            iter: async (_env, n) => {
                db.aggregate('accumulate', {
                    start: () => 0,
                    step: (/** @type {number} */ acc, _v) => acc + 1,
                    result: (/** @type {number} */ acc) => acc,
                });
                try {
                    for (let i = 0; i < n; i++) {
                        const row = await db.get(
                            'SELECT accumulate(a) AS v FROM f',
                        );
                        if (row.v !== 20000) throw new Error('bad count');
                    }
                } finally {
                    db.removeFunction('accumulate');
                }
            },
        },
        {
            name: 'overhead/JS collation: sort 10k as text',
            group: 'overhead',
            ops: 10000,
            samples: 12,
            note: 'O(n log n) JS comparisons — the per-row figure is per sorted row',
            iter: async (_env, n) => {
                db.collation(
                    'natsort',
                    (/** @type {string} */ x, /** @type {string} */ y) =>
                        x < y ? -1 : x > y ? 1 : 0,
                );
                try {
                    for (let i = 0; i < n; i++) {
                        await db.all(
                            'SELECT a FROM f WHERE a <= 10000 ORDER BY CAST(a AS TEXT) COLLATE natsort',
                        );
                    }
                } finally {
                    db.removeCollation('natsort');
                }
            },
        },
    ];
    return cases;
}

/**
 * The db.transaction() wrapper keepers (D05 follow-up): deliberately
 * empty bodies measure the wrapper (AsyncLocalStorage, flow-store copy,
 * validation) against raw BEGIN/COMMIT.
 *
 * @param {any} db an open connection.
 * @returns {CaseSpec[]} the transaction-wrapper cases.
 */
export function transactionCases(db) {
    return [
        {
            name: 'overhead/db.transaction: 200 empty bodies',
            group: 'overhead',
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < 200; i++) {
                        await db.transaction(async () => undefined)();
                    }
                }
            },
        },
        {
            name: 'overhead/raw BEGIN+COMMIT: 200 pairs',
            group: 'overhead',
            iter: async (_env, n) => {
                for (let r = 0; r < n; r++) {
                    for (let i = 0; i < 200; i++) {
                        await db.exec('BEGIN');
                        await db.exec('COMMIT');
                    }
                }
            },
        },
    ];
}

/**
 * The open/close keeper (Deliverable 11): every connection goes through
 * the Database wrapper whose permission-model gate costs one property
 * read with the model off.
 *
 * @param {typeof import('../../lib/sqlite3.js').default} sqlite3 the driver.
 * @returns {CaseSpec} the case.
 */
export function openCloseCase(sqlite3) {
    return {
        name: 'overhead/open+close: 1,000 :memory: connections',
        group: 'overhead',
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                const conn = new sqlite3.Database(':memory:');
                await new Promise((resolve, reject) => {
                    conn.once('open', resolve);
                    conn.once('error', reject);
                });
                await new Promise((resolve) => conn.close(resolve));
            }
        },
    };
}
