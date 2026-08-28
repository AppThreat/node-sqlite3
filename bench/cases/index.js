// Composes the full suite. Case files are imported explicitly — never
// globbed — for the same reason tools/run-tests.mjs exists: a shell glob
// enumerated zero files on Windows while exiting 0.

import { betterSqliteCases, nodeSqliteCases } from './baselines.js';
import { poolCases, schedulingCases } from './concurrency.js';
import {
    blobRoundTripCase,
    blobStreamCase,
    marshallingCases,
} from './marshalling.js';
import {
    cacheTrioCases,
    openCloseCase,
    overheadCases,
    transactionCases,
    udfCases,
} from './overhead.js';
import { readCases } from './read.js';
import {
    colDefsFor,
    colsFor,
    connectionRegistry,
    intRows,
    scratchDir,
} from './shared.js';
import { syncCases } from './sync.js';
import { writeCases } from './write.js';

/** @typedef {import('../harness.js').CaseSpec} CaseSpec */

/**
 * The calibration case: a cached async single-row get — the README's
 * "interactive lookup" shape. Measured twice as two independent cases;
 * their same-run difference is the suite's noise floor, and every ratio
 * the harness prints is checked against it.
 *
 * @param {any} db a cache-enabled connection with a 20,000-row table `t`.
 * @param {string} name case name (A or B).
 * @returns {CaseSpec} the calibration case.
 */
function calibrationCase(db, name) {
    return {
        name,
        group: 'calibration',
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                await db.get(
                    'SELECT * FROM t WHERE rowid = ?',
                    (i % 20000) + 1,
                );
            }
        },
    };
}

/**
 * Builds every case and every fixture the suite needs.
 *
 * @param {typeof import('../lib/sqlite3.js').default} sqlite3 the driver.
 * @param {{ compare: boolean }} opts whether --compare was passed (enables the better-sqlite3 mirror).
 * @returns {Promise<{ cases: CaseSpec[], dispose: () => Promise<void>, skipped: string[] }>} the composed suite.
 */
export async function buildSuite(sqlite3, opts) {
    const registry = connectionRegistry(sqlite3);
    const scratch = scratchDir();
    /** @type {(() => Promise<void> | void)[]} */
    const disposers = [];
    /** @type {string[]} */
    const skipped = [];

    // Calibration pair: two identical connections, measured back to back.
    for (const label of ['calA', 'calB']) {
        const db = registry.mem(label);
        db.exec(
            `CREATE TABLE t (${colDefsFor(4)}); ${intRows(20000, colsFor(4))}`,
        );
        db.cacheStatements();
    }
    /** @type {CaseSpec[]} */
    const cases = [
        calibrationCase(registry.all[0], 'calibration/cached get (A)'),
        calibrationCase(registry.all[1], 'calibration/cached get (B)'),
    ];

    // read group (own connection, no cache)
    cases.push(...readCases(registry.mem('read')));

    // marshalling group: three integer-mode connections + keepers. The
    // default mode is 'number'; the other two are set explicitly per
    // connection so the modes cannot contaminate each other's numbers.
    const marshalNumber = registry.mem('marshal-number');
    const marshalMixed = registry.mem('marshal-mixed');
    const marshalBigint = registry.mem('marshal-bigint');
    cases.push(
        ...marshallingCases({
            number: marshalNumber,
            mixed: marshalMixed,
            bigint: marshalBigint,
        }),
    );
    await setIntegerMode(marshalMixed, 'mixed');
    await setIntegerMode(marshalBigint, 'bigint');
    cases.push(blobRoundTripCase(registry.mem('blob-rt')));
    cases.push(blobStreamCase(registry.mem('blob-stream')));

    // write group: plain + cached connections
    cases.push(
        ...writeCases(registry.mem('write'), registry.mem('write-cached')),
    );

    // sync-vs-async group: two cache-enabled connections
    cases.push(...syncCases(registry.mem('sync'), registry.mem('async')));

    // baseline mirrors
    const ratioNames = {
        getSyncCase: 'sync-vs-async/getSync: batch of 1',
        allSyncCase: 'sync-vs-async/allSync: 20,000 rows × 4 cols',
        insertCase: 'sync-vs-async/runSync: batch of 1',
        execCase: 'write/exec: 100-statement script',
    };
    const nodeSqlite = await nodeSqliteCases(ratioNames);
    if ('cases' in nodeSqlite) {
        cases.push(...nodeSqlite.cases);
        disposers.push(nodeSqlite.dispose);
    } else {
        skipped.push(nodeSqlite.skipped);
    }
    if (opts.compare) {
        const better = await betterSqliteCases(ratioNames);
        if ('cases' in better) {
            cases.push(...better.cases);
            disposers.push(better.dispose);
        } else {
            skipped.push(better.skipped);
        }
    }

    // overhead group
    cases.push(...overheadCases(registry.mem('overhead')));
    cases.push(
        ...cacheTrioCases({
            hit: registry.mem('cache-hit'),
            miss: registry.mem('cache-miss'),
            disabled: registry.mem('cache-off'),
        }),
    );
    cases.push(...udfCases(registry.mem('udf')));
    cases.push(...transactionCases(registry.mem('txn')));
    cases.push(openCloseCase(sqlite3));

    // concurrency group
    cases.push(...schedulingCases(registry.mem('scheduling')));
    {
        const pool = await poolCases(
            sqlite3,
            registry.mem('pool-local'),
            scratch,
        );
        cases.push(...pool.cases);
        disposers.push(pool.dispose);
    }

    // Deterministic drain barrier: every fixture table was created with
    // un-awaited exec() calls (queued FIFO per connection); wait() queues
    // at each tail and resolves only once reached, so every connection is
    // provably idle before the first sample — sync methods refuse
    // otherwise, and a busy queue would fail cases non-deterministically.
    await Promise.all(registry.all.map((db) => db.wait()));

    return {
        cases,
        skipped,
        dispose: async () => {
            await Promise.allSettled(
                disposers.map((fn) => Promise.resolve().then(fn)),
            );
            await registry.dispose();
            scratch.cleanup();
        },
    };
}

/**
 * Sets the integer mode on a connection, awaiting the queued configure.
 *
 * @param {any} db the connection.
 * @param {'number' | 'mixed' | 'bigint'} mode the mode.
 * @returns {Promise<void>} resolves once configured.
 */
async function setIntegerMode(db, mode) {
    await db.configure('integerMode', mode);
}
