// Promise API, async iteration, transactions, resource disposal and
// cancellation. Everything here is assembled onto the classes by
// installPromiseApi() from lib/sqlite3.js.
//
// Every wrapped method is dual-mode: when the last argument is a function
// the call behaves exactly like the callback API (and returns `this`, so
// chaining keeps working); otherwise it returns a promise. Database#prepare
// and Database#backup deliberately keep their synchronous return in both
// forms — see the handoff notes for 03.

import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Public types (emitted into lib/promises.d.ts and re-exported from the
// generated lib/sqlite3.d.ts). These mirror the options and result
// shapes the wrappers below produce.

/**
 * What promise-mode `run()` resolves to.
 *
 * The values are captured when the run's callback fires (so a reused
 * cached statement cannot corrupt an older result), but the possible
 * `lastID` RangeError stays lazy: reading `lastID` in `'number'` integer
 * mode after an insert with an unsafe rowid throws exactly when read,
 * never merely because the promise resolved. `lastIDBigInt` is exact in
 * every mode.
 *
 * @typedef {object} PromiseRunResult
 * @property {number | bigint} lastID The inserted rowid, subject to the integer mode.
 * @property {bigint} lastIDBigInt The inserted rowid, exact in every integer mode.
 * @property {number} changes Rows changed by the statement.
 * @since 9.0.0
 */

/**
 * Options accepted by every promise-mode method and by `iterate()` /
 * `transaction()`. Aborting interrupts the whole connection (a SQLite
 * constraint) and rejects with the signal's reason.
 *
 * @typedef {object} SignalOptions
 * @property {AbortSignal} [signal] Abort this operation by interrupting the connection.
 * @since 9.0.0
 */

/**
 * Options for `Database#transaction`.
 *
 * @typedef {object} TransactionOptions
 * @property {'deferred' | 'immediate' | 'exclusive'} [mode='deferred'] Transaction start mode.
 * @property {boolean} [savepoint=false] Nest via SAVEPOINT even at the top level.
 * @property {boolean} [serialize=false] Run the body inside serialize() (strict
 *   FIFO, at the cost of bypassing the statement cache).
 * @property {AbortSignal} [signal] Abort via `db.interrupt()` and reject with the signal's reason.
 * @since 9.0.0
 */

/**
 * Callback of `Statement#fetch`: receives up to `count` rows and whether
 * the cursor is exhausted.
 *
 * @typedef {(err: import('./native.js').SqliteError | null, rows: import('./native.js').Row[], done: boolean) => void} FetchCallback
 * @since 9.0.0
 */

/**
 * Opens a database and resolves once the connection is ready. The
 * `Database` constructor cannot return a promise; this is the
 * promise-native form. `new Database(...)` is unchanged.
 *
 * @typedef {(filename: string, mode?: number) => Promise<import('./native.js').Database>} OpenFunction
 * @since 9.0.0
 */

// Statement -> Database association. Statements do not expose their
// database, but aborting a statement operation must interrupt the
// connection, so every JS-side statement creation point records the pair.
// Statements created through `new sqlite3.Statement(db, sql)` directly are
// not tracked: aborting those rejects without an interrupt.
/** @type {WeakMap<object, import('./sqlite3.js').Database>} */
const statementDatabases = new WeakMap();

/**
 * Records which database owns a statement, so AbortSignal handling can
 * reach `db.interrupt()` from a statement method.
 *
 * @param {import('./sqlite3.js').Database} db the owning connection.
 * @param {import('./sqlite3.js').Statement} statement the prepared statement.
 * @returns {import('./sqlite3.js').Statement} the statement, for inline use.
 */
function associateStatement(db, statement) {
    statementDatabases.set(statement, db);
    return statement;
}

/**
 * Builds the object a promise-mode `run()` resolves to.
 *
 * Values are snapshotted while the run's callback fires (so a reused
 * cached statement cannot corrupt an older result), but the possible
 * `lastID` RangeError stays lazy: reading `lastID` in 'number' integer
 * mode after an insert with an unsafe rowid throws exactly when read,
 * never merely because the promise resolved. `lastIDBigInt` is exact in
 * every mode.
 *
 * @param {import('./sqlite3.js').Statement} statement the statement that ran.
 * @returns {{ lastID: number | bigint, lastIDBigInt: bigint, changes: number }} the run result.
 */
function makeRunResult(statement) {
    /** @type {number | bigint | undefined} */
    let lastIDValue;
    /** @type {unknown} */
    let lastIDError;
    let lastIDThrows = false;
    try {
        lastIDValue = statement.lastID;
    } catch (err) {
        lastIDThrows = true;
        lastIDError = err;
    }
    const lastIDBigInt = /** @type {bigint} */ (statement.lastIDBigInt);
    const changes = /** @type {number} */ (statement.changes);
    return {
        get lastID() {
            if (lastIDThrows) throw lastIDError;
            return /** @type {number | bigint} */ (lastIDValue);
        },
        get lastIDBigInt() {
            return lastIDBigInt;
        },
        get changes() {
            return changes;
        },
    };
}

// True for a trailing plain object used purely as call options, i.e. every
// own enumerable key is `signal`. Named-parameter objects cannot collide:
// their keys carry a `$`/`:`/`@` prefix in the SQL.
/**
 * @param {unknown} value
 * @returns {boolean}
 * @private
 */
function isSignalOptions(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (
        Object.hasOwn(value, 'signal') &&
        Object.keys(/** @type {Record<string, unknown>} */ (value)).every(
            (key) => key === 'signal',
        )
    );
}

/**
 * @param {unknown[]} args
 * @returns {{ signal: unknown, args: unknown[] }}
 * @private
 */
function splitSignalOption(args) {
    const last = args.at(-1);
    if (isSignalOptions(last)) {
        return {
            signal: /** @type {{ signal?: AbortSignal }} */ (last).signal,
            args: args.slice(0, -1),
        };
    }
    return { signal: undefined, args };
}

/**
 * Wraps a callback-mode core into a dual-mode method.
 *
 * @param {(...callArgs: unknown[]) => unknown} core the callback-mode implementation.
 * @param {object} [options]
 * @param {(thisArg: unknown, result: unknown) => unknown} [options.pick] maps
 *   `(thisArg, result)` to the promise resolution value; default resolves
 *   the callback's own result argument.
 * @param {boolean} [options.void=true] resolve `undefined` regardless of
 *   the callback's result (exec/close/wait/reset/finalize/bind/finish).
 * @param {boolean} [options.signal=false] accept a trailing `{ signal }`
 *   options object and wire it to `db.interrupt()`.
 * @param {boolean} [options.statement=false] the receiver is a Statement
 *   whose database must be looked up for interrupt.
 * @returns {(...args: any[]) => any} the dual-mode method; the public
 *   overload set is declared in lib/augment.d.ts.
 */
function dualMode(core, options = {}) {
    /**
     * @param {unknown} _self
     * @param {unknown} result
     */
    const defaultPick = (_self, result) => result;
    /** @type {((thisArg: unknown, result: unknown) => unknown) | null} */
    const pick = options.void === true ? null : (options.pick ?? defaultPick);
    const acceptsSignal = options.signal === true;
    const isStatement = options.statement === true;
    /**
     * @this {unknown}
     * @param {...unknown} args
     * @returns {unknown}
     */
    function wrapper(...args) {
        if (typeof args.at(-1) === 'function') {
            return core.apply(this, args);
        }
        /** @type {unknown} */
        let signal;
        if (acceptsSignal) {
            const split = splitSignalOption(args);
            signal = split.signal;
            args = split.args;
        }
        const theSignal =
            signal !== undefined && signal !== null
                ? /** @type {AbortSignal} */ (signal)
                : null;
        return new Promise((resolve, reject) => {
            if (theSignal) {
                if (typeof theSignal.addEventListener !== 'function') {
                    reject(
                        new TypeError('options.signal must be an AbortSignal'),
                    );
                    return;
                }
                if (theSignal.aborted) {
                    reject(theSignal.reason);
                    return;
                }
            }
            /** @type {(() => void) | null} */
            let detach = null;
            if (theSignal) {
                const self = this;
                const onAbort = () => {
                    // Cancellation is connection-wide: interrupt() reaches
                    // every in-flight statement on the database, not just
                    // the one being awaited. That is a SQLite constraint.
                    const db = isStatement
                        ? statementDatabases.get(/** @type {object} */ (self))
                        : /** @type {import('./sqlite3.js').Database} */ (self);
                    try {
                        db?.interrupt();
                    } catch {
                        // Closing or closed — the rejection below is the outcome.
                    }
                    if (detach) detach();
                    reject(theSignal.reason);
                };
                detach = () => theSignal.removeEventListener('abort', onAbort);
                theSignal.addEventListener('abort', onAbort, { once: true });
            }
            /**
             * @param {unknown} err
             * @param {unknown} result
             * @this {unknown}
             */
            const settle = function (err, result) {
                if (detach) detach();
                if (err) reject(err);
                else resolve(pick ? pick(this, result) : undefined);
            };
            try {
                core.call(this, ...args, settle);
            } catch (err) {
                // Strict binding throws synchronously; a method that
                // returns a promise rejects instead of throwing. The core
                // has already finalized any orphaned statement.
                if (detach) detach();
                reject(err);
            }
        });
    }
    return wrapper;
}

/**
 * `each()` guard: it is callback-only (the async iterator is the
 * promise-based form), and calling it without any callback used to stream
 * every row into nowhere. Fail loudly instead.
 *
 * @param {(...callArgs: unknown[]) => unknown} core the callback-mode each implementation.
 * @returns {(...args: any[]) => any} the guarded method.
 */
function eachCallbackOnly(core) {
    /**
     * @this {unknown}
     * @param {...unknown} args
     * @returns {unknown}
     */
    function guarded(...args) {
        if (
            typeof args.at(-1) !== 'function' &&
            typeof args.at(-2) !== 'function'
        ) {
            throw new TypeError(
                'each() is callback-only: pass a row callback (and optionally a ' +
                    'complete callback), or use iterate() for promise-based iteration.',
            );
        }
        return core.apply(this, args);
    }
    return guarded;
}

// ---------------------------------------------------------------------------
// Async iteration

// One active iterator per statement; two would interleave their cursors.
const activeIterations = new WeakSet();

const ITERATOR_MIN_BATCH = 64;
const ITERATOR_MAX_BATCH = 1024;

/**
 * Options driving {@link createAsyncIterator}.
 *
 * @typedef {object} IteratorOptions
 * @property {unknown[]} [params] bind parameters for the first fetch.
 * @property {boolean} [ownsStatement] whether the iterator finalizes (true)
 *   or merely resets (false) its statement on teardown.
 * @property {AbortSignal} [signal] abort the iteration mid-cursor.
 * @property {() => void} [interrupt] interrupt the connection on abort.
 * @property {((callback: (err: Error | null) => void) => import('./sqlite3.js').Statement)} [prepare]
 *   lazily create the statement (db.iterate).
 * @private
 */

/**
 * Creates the pull-based async iterator backing `iterate()`.
 *
 * Rows are fetched in batches through the native `fetch()`, so memory stays
 * flat regardless of result size: the batch grows from 64 to at most 1024
 * rows while the consumer keeps up, and a new batch is only requested once
 * the buffer is empty. The iterator is itself an async iterable.
 *
 * @param {import('./sqlite3.js').Statement | null} statement the statement
 *   to iterate, or null when `prepare` creates one lazily (db.iterate).
 * @param {IteratorOptions} options
 * @returns {AsyncIterableIterator<import('./native.js').Row>} the async iterator.
 * @throws {Error} when the statement already has an active iterator.
 */
function createAsyncIterator(statement, options) {
    /** @type {unknown[]} */
    const params = options.params ?? [];
    const ownsStatement = options.ownsStatement === true;
    /** @type {AbortSignal | undefined} */
    const signal = options.signal;
    const prepare = options.prepare ?? null;

    if (statement !== null && activeIterations.has(statement)) {
        throw new Error(
            'Statement is already being iterated; finish or break the first ' +
                'iterator, or iterate a second statement instead.',
        );
    }
    if (statement !== null) activeIterations.add(statement);

    /** @type {object[]} */
    let buffer = [];
    let cursorDone = false;
    /** @type {unknown} */
    let error = null;
    let closed = false;
    /** @type {Promise<void> | null} */
    let finished = null;
    let batch = ITERATOR_MIN_BATCH;
    let firstFetch = true;
    /** @type {Promise<void> | null} */
    let inFlight = null;
    /**
     * @typedef {{ resolve: (r: IteratorResult<import('./native.js').Row, unknown>) => void, reject: (e: unknown) => void }} Waiter
     */
    /** @type {Waiter[]} */
    const waiters = [];

    let aborted = false;
    /** @type {unknown} */
    let abortReason = null;
    /** @type {(() => void) | null} */
    let onAbort = null;
    let signalDetached = !signal;
    const detachSignal = () => {
        if (signalDetached) return;
        signalDetached = true;
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
        if (typeof signal.addEventListener !== 'function') {
            throw new TypeError('options.signal must be an AbortSignal');
        }
        if (signal.aborted) {
            aborted = true;
            abortReason = signal.reason;
        } else {
            onAbort = () => {
                aborted = true;
                abortReason = signal.reason;
                try {
                    options.interrupt?.();
                } catch {
                    // Closing or closed — the rejection below is the outcome.
                }
                if (error === null) error = abortReason;
                close();
                flush();
                finish();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }
    }

    /** @type {Error | null} */
    let prepareError = null;
    // Set once the statement's prepare has failed. Statement::CleanQueue
    // now fails the calls queued behind a failed prepare rather than
    // dropping them, so their callbacks do arrive; this flag keeps the
    // iterator's own bookkeeping (teardown, `finished`) in step with a
    // failure that can land between any two of its states.
    let prepareFailed = false;
    // Resolver of the in-flight teardown, so a prepare failure can settle it.
    /** @type {(() => void) | null} */
    let teardownResolve = null;

    // Borrowed statements (stmt.iterate): the statement's own prepare can
    // fail after the iterator was created. A prepare failure with no
    // prepare callback emits 'error' on the statement — listen once, so
    // the iteration ends even when the failure arrives before any fetch
    // has been queued for CleanQueue to fail. (When a prepare callback
    // consumed the error there is no event; teardown() then relies on the
    // `finalized` accessor.)
    /** @type {(() => void) | null} */
    let detachStatementError = null;
    if (statement !== null && prepare === null) {
        const borrowed = statement;
        /**
         * @param {import('./native.js').SqliteError} err
         */
        const onStatementError = (err) => {
            if (finished !== null) return;
            prepareFailed = true;
            prepareError = err;
            if (inFlight !== null) {
                inFlight = null;
                error = err;
                close();
                finish();
                flush();
            }
            settleTeardown();
        };
        borrowed.once('error', onStatementError);
        detachStatementError = () =>
            borrowed.removeListener('error', onStatementError);
    }

    function ensureStatement() {
        if (prepare === null || statement !== null) return;
        statement = prepare(
            /**
             * @param {Error | null} err
             */
            function (err) {
                if (err) {
                    prepareError = err;
                    prepareFailed = true;
                    // Fail a pending pull from here: the prepare can fail
                    // before that fetch was ever queued, in which case
                    // CleanQueue has nothing to fail on its behalf.
                    if (inFlight !== null) {
                        inFlight = null;
                        error = err;
                        close();
                        finish();
                        flush();
                    }
                    // Same for a teardown queued behind it: an AbortSignal can
                    // interrupt the prepare itself, and then the finalize we
                    // queued would never call back — hanging `return()`.
                    settleTeardown();
                }
            },
        );
        activeIterations.add(
            /** @type {import('./sqlite3.js').Statement} */ (statement),
        );
    }

    function settleTeardown() {
        if (teardownResolve === null) return;
        const resolve = teardownResolve;
        teardownResolve = null;
        resolve();
    }

    /**
     * @param {(r: IteratorResult<import('./native.js').Row, unknown>) => void} resolve
     * @param {(e: unknown) => void} reject
     * @returns {boolean} whether the waiter was settled.
     */
    function dispatch(resolve, reject) {
        if (error !== null) {
            const err = error;
            error = null;
            reject(err);
            return true;
        }
        if (buffer.length > 0) {
            resolve({
                value: /** @type {import('./native.js').Row} */ (
                    buffer.shift()
                ),
                done: false,
            });
            return true;
        }
        if (cursorDone || closed) {
            // The consumer saw the last row and asked once more: the
            // iteration is over, release the statement now so the
            // connection does not carry it past the loop.
            close();
            finish();
            resolve({ value: undefined, done: true });
            return true;
        }
        return false;
    }

    function flush() {
        while (waiters.length > 0) {
            const waiter = waiters[0];
            if (!dispatch(waiter.resolve, waiter.reject)) {
                pull();
                return;
            }
            waiters.shift();
        }
    }

    function pull() {
        if (inFlight !== null || closed || cursorDone || error !== null) {
            return;
        }
        if (aborted) {
            error = abortReason;
            close();
            finish();
            flush();
            return;
        }
        ensureStatement();
        if (prepareError !== null) {
            // The lazily prepared statement failed to prepare; surface the
            // real error rather than the "already finalized" MISUSE the
            // queued fetch calls would produce.
            error = prepareError;
            prepareError = null;
            close();
            finish();
            flush();
            return;
        }
        if (
            statement !== null &&
            prepare === null &&
            /** @type {import('./sqlite3.js').Statement} */ (statement)
                .finalized
        ) {
            // A borrowed statement that was finalized before this pull —
            // its own prepare failed, or the user finalized it mid-cursor.
            // Anything queued on it never calls back.
            error = prepareError ?? new Error('Statement is already finalized');
            close();
            finish();
            flush();
            return;
        }
        const args = firstFetch ? [batch, ...params] : [batch];
        firstFetch = false;
        /** @type {Promise<void>} */
        const flight = new Promise((resolve) => {
            args.push(
                /**
                 * @param {Error | null} err
                 * @param {object[]} rows
                 * @param {boolean} done
                 */
                function (err, rows, done) {
                    inFlight = null;
                    if (closed) {
                        // Terminated while this batch was in flight; drop it.
                        resolve();
                        return;
                    }
                    if (err) {
                        error = prepareError !== null ? prepareError : err;
                        prepareError = null;
                        resolve();
                        close();
                        finish();
                    } else {
                        buffer = rows;
                        cursorDone = done;
                        if (!done && rows.length === batch) {
                            batch = Math.min(batch * 2, ITERATOR_MAX_BATCH);
                        }
                        resolve();
                        if (cursorDone && buffer.length === 0) {
                            close();
                            finish();
                        }
                    }
                    flush();
                },
            );
            /** @type {(...fetchArgs: unknown[]) => unknown} */ (
                /** @type {import('./sqlite3.js').Statement} */ (statement)
                    .fetch
            )(...args);
        });
        inFlight = flight;
    }

    function close() {
        if (closed) return;
        closed = true;
        detachSignal();
        detachStatementError?.();
        if (statement !== null) activeIterations.delete(statement);
    }

    // Teardown is awaited by return()/throw() so that, once `for await`
    // resumes after a break, the statement is unlocked and the database is
    // idle (the sync fast path's getSync works immediately). Errors here
    // are swallowed by design: cleanup must not mask the outcome the
    // consumer already received, and finalizing an already-finalized
    // statement is a benign MISUSE.
    /**
     * @returns {Promise<void>}
     */
    function teardown() {
        const target = statement;
        if (target === null) return Promise.resolve();
        // A failed prepare already tore the statement down and dropped its
        // queue; asking for a finalize here would wait forever.
        if (prepareFailed) return Promise.resolve();
        /** @type {Promise<void>} */
        const settle = new Promise((resolve) => {
            const done = () => {
                teardownResolve = null;
                resolve();
            };
            try {
                if (target.finalized) {
                    // Finalized without us (failed prepare whose error went
                    // to a prepare callback, or a user finalize): anything
                    // we would queue here never calls back.
                    resolve();
                } else if (ownsStatement) {
                    // settleTeardown() is the escape hatch for a prepare
                    // that fails after this call is queued.
                    teardownResolve = resolve;
                    target.finalize(done);
                } else if (!cursorDone) {
                    // Borrowed statement left mid-cursor: reset it so it
                    // stays usable for a fresh bind.
                    teardownResolve = resolve;
                    target.reset(done);
                } else {
                    resolve();
                }
            } catch {
                done();
            }
        });
        return settle;
    }

    function finish() {
        if (finished === null) {
            finished = teardown();
            finished.then(detachSignal, detachSignal);
        }
        return finished;
    }

    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        /**
         * @returns {Promise<IteratorResult<import('./native.js').Row, unknown>>}
         */
        next() {
            /** @type {Promise<IteratorResult<import('./native.js').Row, unknown>>} */
            const iteration = new Promise(
                /**
                 * @param {(r: IteratorResult<import('./native.js').Row, unknown>) => void} resolve
                 * @param {(e: unknown) => void} reject
                 */
                (resolve, reject) => {
                    if (aborted && error === null && !closed) {
                        error = abortReason;
                        close();
                    }
                    if (!dispatch(resolve, reject)) {
                        waiters.push({ resolve, reject });
                        pull();
                    }
                },
            );
            return iteration;
        },
        /**
         * @param {import('./native.js').Row | undefined} [value]
         * @returns {Promise<IteratorResult<import('./native.js').Row, unknown>>}
         */
        async return(value) {
            close();
            await finish();
            return { value, done: true };
        },
        /**
         * @param {unknown} err
         * @returns {Promise<never>}
         */
        async throw(err) {
            close();
            await finish();
            throw err;
        },
    };
}

/**
 * Splits a variadic `iterate(sql, ...rest)` argument list into bind
 * parameters and an optional trailing `{ signal }`.
 *
 * @param {unknown[]} args the arguments after the SQL.
 * @returns {{ params: unknown[], signal: unknown }}
 * @private
 */
function iterateParams(args) {
    const last = args.at(-1);
    if (isSignalOptions(last)) {
        return {
            params: args.slice(0, -1),
            signal: /** @type {{ signal?: AbortSignal }} */ (last).signal,
        };
    }
    return { params: args, signal: undefined };
}

// ---------------------------------------------------------------------------
// Transactions

// Transaction nesting is tracked per async flow, not with a
// connection-wide counter: a counter made a *concurrently started*
// second transaction silently take the savepoint path, so its "commit"
// was a RELEASE that the outer transaction's rollback could undo (and
// its work committed only if the unrelated first transaction did). With
// AsyncLocalStorage, calls made from inside a transaction body — across
// awaits — still nest correctly via savepoints, while a concurrent
// top-level BEGIN fails loudly at SQLite ("cannot start a transaction
// within a transaction"), surfaced below with an explanation.
//
// The store is keyed by connection. Depth is a property of one database,
// not of the async flow: a transaction on connection B that happens to
// run inside a transaction on connection A is still B's *first*
// transaction, and must issue a real BEGIN — a savepoint there would
// silently discard an explicitly requested 'immediate' or 'exclusive'
// mode, and with it the write lock the caller asked for.
/** @type {AsyncLocalStorage<Map<object, number>>} */
const txFlow = new AsyncLocalStorage();
/** @type {Set<string>} */
const TRANSACTION_MODES = new Set(['deferred', 'immediate', 'exclusive']);

/**
 * The transaction engine under `Database#transaction`: BEGIN/COMMIT with
 * ROLLBACK on failure, savepoints when nested, and connection-wide
 * interruption on abort.
 *
 * @param {import('./sqlite3.js').Database} db the connection.
 * @param {(tx: import('./sqlite3.js').Database) => unknown} fn the body.
 * @param {{ mode: string, savepoint: boolean, serialize: boolean, signal?: AbortSignal }} opts
 *   the validated options.
 * @returns {Promise<unknown>} whatever the body resolves to.
 * @throws {AggregateError} When the body and the rollback both fail.
 * @private
 */
async function runTransaction(db, fn, opts) {
    /** @type {AbortSignal | undefined} */
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (signal && typeof signal.addEventListener !== 'function') {
        return Promise.reject(
            new TypeError('options.signal must be an AbortSignal'),
        );
    }

    const outer = txFlow.getStore();
    const depth = outer?.get(db) ?? 0;
    const useSavepoint = opts.savepoint || depth > 0;
    const name = `sp_${depth + 1}`;
    const beginSqls = useSavepoint
        ? [`SAVEPOINT ${name}`]
        : [`BEGIN ${opts.mode.toUpperCase()}`];
    const commitSqls = useSavepoint
        ? [`RELEASE SAVEPOINT ${name}`]
        : ['COMMIT'];
    // ROLLBACK TO alone leaves the savepoint's implicit transaction open
    // (a savepoint started outside BEGIN opens one): release it too.
    const rollbackSqls = useSavepoint
        ? [`ROLLBACK TO SAVEPOINT ${name}`, `RELEASE SAVEPOINT ${name}`]
        : ['ROLLBACK'];

    /**
     * @param {string[]} sqls
     */
    const execAll = async (sqls) => {
        for (const sql of sqls) {
            await db.exec(sql);
        }
    };

    let aborted = false;
    /** @type {unknown} */
    let abortReason = null;
    /** @type {(() => void) | null} */
    let onAbort = null;
    if (signal) {
        onAbort = () => {
            aborted = true;
            abortReason = signal.reason;
            try {
                db.interrupt();
            } catch {
                // Closing or closed — the rejection path below is the outcome.
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
    }
    const detachSignal = () => {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };

    if (opts.serialize) db.serialize();

    const begin = async () => {
        try {
            await execAll(beginSqls);
        } catch (err) {
            if (aborted) throw abortReason;
            const message = String(
                /** @type {{ message?: unknown }} */ (err)?.message,
            );
            if (
                !useSavepoint &&
                depth === 0 &&
                /within a transaction/i.test(message)
            ) {
                // Another transaction is open on this connection. Before
                // the AsyncLocalStorage-based tracking this silently rode
                // inside it as a savepoint.
                throw new Error(
                    'a transaction is already active on this connection; ' +
                        'db.transaction() bodies must not run concurrently ' +
                        'on one connection (nest calls inside the body ' +
                        'instead)',
                    { cause: err },
                );
            }
            throw err;
        }
    };

    // Copied, not mutated: sibling calls in the same body share one store
    // object, so raising the depth in place would leak into them.
    const flow = new Map(outer);
    flow.set(db, depth + 1);

    return txFlow.run(flow, async () => {
        try {
            await begin();

            let failed = false;
            /** @type {unknown} */
            let failure;
            /** @type {unknown} */
            let result;
            try {
                result = await fn(db);
            } catch (err) {
                failed = true;
                failure = err;
            }
            if (aborted) {
                // The signal is the story: its connection-wide interrupt is
                // what caused any body failure seen here.
                failed = true;
                failure = abortReason;
            }

            if (failed) {
                /** @type {unknown} */
                let rollbackError = null;
                let rollbackFailed = false;
                try {
                    await execAll(rollbackSqls);
                } catch (err) {
                    rollbackFailed = true;
                    rollbackError = err;
                }
                detachSignal();
                if (rollbackFailed) {
                    throw new AggregateError(
                        [failure, rollbackError],
                        'transaction body failed and its ROLLBACK failed too; ' +
                            'the connection may still hold the transaction open',
                    );
                }
                throw failure;
            }

            try {
                await execAll(commitSqls);
            } catch (commitError) {
                detachSignal();
                if (aborted) throw abortReason;
                // COMMIT failed (e.g. SQLITE_BUSY): best-effort rollback,
                // then surface the commit error itself.
                try {
                    await execAll(rollbackSqls);
                } catch {
                    // The commit error is the story worth telling.
                }
                throw commitError;
            }
            detachSignal();
            return result;
        } finally {
            detachSignal();
            if (opts.serialize) db.parallelize();
        }
    });
}

// ---------------------------------------------------------------------------
// Installation

// The cores are captured before the promise layer wraps them and are
// re-wrapped by retracePromiseApi, so their shared holder is the
// permissive callable shape; each member's real overload set lives in
// lib/augment.d.ts.
/** @type {Record<string, (...callArgs: any[]) => any> | null} */
let dbCores = null;
/** @type {Record<string, (...callArgs: any[]) => any> | null} */
let stmtCores = null;
/** @type {Record<string, (...callArgs: any[]) => any> | null} */
let backupCores = null;
/**
 * @typedef {{ sqlite3: import('./sqlite3.js').sqlite3, Database: typeof import('./sqlite3-binding.js').Database, Statement: typeof import('./sqlite3-binding.js').Statement, Backup: typeof import('./sqlite3-binding.js').Backup }} Installed
 */
/** @type {Installed | null} */
let installed = null;

/**
 * @param {import('./sqlite3.js').sqlite3} sqlite3 the public namespace.
 * @param {typeof import('./sqlite3-binding.js').Database} Database the class.
 * @param {typeof import('./sqlite3-binding.js').Statement} Statement the class.
 * @param {typeof import('./sqlite3-binding.js').Backup} Backup the class.
 * @param {Record<string, (...callArgs: any[]) => any>} dbCores
 * @param {Record<string, (...callArgs: any[]) => any>} stmtCores
 * @param {Record<string, (...callArgs: any[]) => any>} backupCores
 * @returns {void}
 * @private
 */
function install(
    sqlite3,
    Database,
    Statement,
    Backup,
    dbCores,
    stmtCores,
    backupCores,
) {
    Database.prototype.get = dualMode(dbCores.get, { signal: true });
    Database.prototype.run = dualMode(dbCores.run, {
        signal: true,
        pick: /** @type {(thisArg: unknown, result: unknown) => unknown} */ (
            makeRunResult
        ),
    });
    Database.prototype.all = dualMode(dbCores.all, { signal: true });
    Database.prototype.map = dualMode(dbCores.map, { signal: true });
    Database.prototype.exec = dualMode(dbCores.exec, {
        signal: true,
        void: true,
    });
    Database.prototype.close = dualMode(dbCores.close, { void: true });
    Database.prototype.wait = dualMode(dbCores.wait, { void: true });
    Database.prototype.loadExtension = dualMode(dbCores.loadExtension, {
        void: true,
    });
    Database.prototype.each = eachCallbackOnly(dbCores.each);

    Statement.prototype.bind = dualMode(stmtCores.bind, { void: true });
    Statement.prototype.get = dualMode(stmtCores.get, {
        signal: true,
        statement: true,
    });
    Statement.prototype.run = dualMode(stmtCores.run, {
        signal: true,
        statement: true,
        pick: /** @type {(thisArg: unknown, result: unknown) => unknown} */ (
            makeRunResult
        ),
    });
    Statement.prototype.all = dualMode(stmtCores.all, {
        signal: true,
        statement: true,
    });
    Statement.prototype.map = dualMode(stmtCores.map, {
        signal: true,
        statement: true,
    });
    Statement.prototype.each = eachCallbackOnly(stmtCores.each);
    Statement.prototype.reset = dualMode(stmtCores.reset, { void: true });
    Statement.prototype.finalize = dualMode(stmtCores.finalize, {
        void: true,
    });

    Backup.prototype.step = dualMode(backupCores.step, {
        pick: (_self, completed) => completed,
    });
    Backup.prototype.finish = dualMode(backupCores.finish, { void: true });

    /**
     * Opens a database and resolves once the connection is ready.
     *
     * The `Database` constructor cannot return a promise; this is the
     * promise-native form. `new Database(...)` is unchanged.
     *
     * @param {string} filename the database file (or `:memory:` / `''`).
     * @param {number} [mode] open flags, e.g. `sqlite3.OPEN_READWRITE`.
     * @returns {Promise<import('./sqlite3.js').Database>} the opened database.
     * @since 9.0.0
     * @example
     * const db = await sqlite3.open('app.db', sqlite3.OPEN_READWRITE);
     */
    sqlite3.open = function open(filename, mode) {
        return new Promise((resolve, reject) => {
            /** @type {import('./sqlite3.js').Database} */
            let db;
            try {
                /**
                 * @param {Error | null} err
                 */
                const onOpen = (err) => {
                    if (err) reject(err);
                    else resolve(db);
                };
                const OpenCtor =
                    /** @type {new (filename: string, ...rest: unknown[]) => import('./sqlite3.js').Database} */ (
                        /** @type {unknown} */ (Database)
                    );
                db =
                    mode === undefined
                        ? new OpenCtor(filename, onOpen)
                        : new OpenCtor(filename, mode, onOpen);
            } catch (err) {
                reject(err);
            }
        });
    };

    /**
     * Iterates query results with backpressure, pulling rows from SQLite
     * in batches (64..1024) only as the consumer asks for them. The
     * statement is prepared on first use and finalized when the iteration
     * ends (drain, `break`, `throw` or abort).
     *
     * @param {string} sql the query to iterate.
     * @param {...any} rest bind parameters, then an optional
     *   `{ signal }` options object.
     * @returns {AsyncIterableIterator<import('./native.js').Row>} the async iterator.
     * @since 9.0.0
     * @example
     * for await (const row of db.iterate('SELECT * FROM big')) { ... }
     */
    Database.prototype.iterate = function (sql, ...rest) {
        const { params, signal } = iterateParams(rest);
        return createAsyncIterator(null, {
            params,
            signal: /** @type {AbortSignal | undefined} */ (signal),
            ownsStatement: true,
            interrupt: () => this.interrupt(),
            // The raw constructor (not db.prepare): its callback fires on
            // success too, which the iterator uses as its prepare gate.
            prepare: (callback) =>
                associateStatement(this, new Statement(this, sql, callback)),
        });
    };

    /**
     * Iterates an existing statement's results with backpressure. On
     * `break`/`throw` the statement is reset (not finalized) and stays
     * usable. Two concurrent iterators over the same statement throw.
     *
     * @param {...any} rest bind parameters for the first fetch, then
     *   an optional `{ signal }` options object.
     * @returns {AsyncIterableIterator<import('./native.js').Row>} the async iterator.
     * @since 9.0.0
     * @example
     * const stmt = db.prepare('SELECT * FROM t WHERE a = ?');
     * for await (const row of stmt.iterate(42)) { ... }
     */
    Statement.prototype.iterate = function (...rest) {
        const { params, signal } = iterateParams(rest);
        return createAsyncIterator(this, {
            params,
            signal: /** @type {AbortSignal | undefined} */ (signal),
            ownsStatement: false,
            interrupt: () => statementDatabases.get(this)?.interrupt(),
        });
    };

    /**
     * `db.iterate()` as a Node `Readable` (object mode), for piping and
     * composing with the rest of the stream ecosystem.
     *
     * @param {string} sql the query to stream.
     * @param {...any} rest bind parameters, then `{ signal }` options.
     * @returns {import('node:stream').Readable} an object-mode stream of rows.
     * @since 9.0.0
     * @example
     * db.stream('SELECT * FROM big').pipe(someTransform);
     */
    Database.prototype.stream = function (sql, ...rest) {
        return Readable.from(this.iterate(sql, ...rest), {
            objectMode: true,
        });
    };

    /**
     * Runs `fn` inside a transaction: BEGIN / COMMIT, ROLLBACK on throw.
     * The original error is re-thrown; if the ROLLBACK fails too, an
     * `AggregateError` carries both. Nested calls automatically use
     * savepoints.
     *
     * The callback receives the connection itself as `tx` — a transaction
     * is connection-wide in SQLite, and work issued on `db` directly from
     * inside the callback races it. Pass `{ serialize: true }` to opt into
     * strict FIFO ordering for the duration (at the cost of bypassing the
     * statement cache).
     *
     * @param {(tx: import('./sqlite3.js').Database) => unknown} fn the transaction body, receives `(tx)`.
     * @param {object} [options]
     * @param {'deferred' | 'immediate' | 'exclusive'} [options.mode='deferred']
     * @param {boolean} [options.savepoint=false] force SAVEPOINT even at
     *   the top level.
     * @param {boolean} [options.serialize=false]
     * @param {AbortSignal} [options.signal] aborts via `db.interrupt()` and
     *   rejects with the signal's reason.
     * @returns {Promise<any>} whatever `fn` resolves to.
     * @throws {TypeError} when `fn` is not a function or `mode` is invalid.
     * @since 9.0.0
     * @example
     * const rows = await db.transaction(async (tx) => {
     *     await tx.run('INSERT INTO t VALUES (?)', 1);
     *     return tx.all('SELECT * FROM t');
     * });
     */
    Database.prototype.transaction = function (fn, options = {}) {
        // transaction() always returns a promise, so validation failures
        // reject rather than throw, like every other promise-mode method.
        if (typeof fn !== 'function') {
            return Promise.reject(
                new TypeError('transaction() requires a function body'),
            );
        }
        const mode = options?.mode ?? 'deferred';
        if (!TRANSACTION_MODES.has(mode)) {
            return Promise.reject(
                new TypeError(
                    "transaction() mode must be 'deferred', 'immediate' or 'exclusive'",
                ),
            );
        }
        return runTransaction(
            this,
            /** @type {(tx: import('./sqlite3.js').Database) => unknown} */ (
                fn
            ),
            {
                mode,
                savepoint: options?.savepoint === true,
                serialize: options?.serialize === true,
                signal: options?.signal,
            },
        );
    };

    // Dispose support: `await using` closes/finalizes; a double dispose is
    // a benign no-op rather than a rejection. Errors that only say "this
    // was already torn down" are swallowed; real errors propagate.
    /**
     * @param {any} err
     * @returns {boolean}
     */
    const alreadyTornDown = (err) =>
        err?.code === 'SQLITE_MISUSE' &&
        (/already finalized/i.test(err.message) ||
            /already finished/i.test(err.message) ||
            /database handle is closed/i.test(err.message));

    /**
     * `await using` support: closes the database.
     *
     * @returns {Promise<void>} resolves once closed.
     * @since 9.0.0
     * @example
     * await using db = await sqlite3.open('app.db');
     */
    Database.prototype[Symbol.asyncDispose] = async function () {
        if (!this.open) return;
        try {
            await this.close();
        } catch (err) {
            if (alreadyTornDown(err)) return;
            throw err;
        }
    };

    /**
     * `await using` support: finalizes the statement.
     *
     * @returns {Promise<void>} resolves once finalized.
     * @since 9.0.0
     */
    Statement.prototype[Symbol.asyncDispose] = function () {
        return new Promise((resolve, reject) => {
            /**
             * @param {Error | null} err
             */
            this.finalize(function (err) {
                if (err && !alreadyTornDown(err)) reject(err);
                else resolve();
            });
        });
    };

    /**
     * `using` support for `prepareSync()` results: initiates an async
     * finalize synchronously. The callback keeps it in callback mode so no
     * promise — and no possible unhandled rejection — is created.
     *
     * @since 9.0.0
     */
    Statement.prototype[Symbol.dispose] = function () {
        this.finalize(function () {
            /* best effort */
        });
    };

    /**
     * `await using` support: finishes the backup.
     *
     * @returns {Promise<void>} resolves once finished.
     * @since 9.0.0
     */
    Backup.prototype[Symbol.asyncDispose] = function () {
        return new Promise((resolve, reject) => {
            /**
             * @param {Error | null} err
             */
            this.finish(function (err) {
                if (err && !alreadyTornDown(err)) reject(err);
                else resolve();
            });
        });
    };
}

/**
 * Installs the promise API onto the classes: dual-mode wrappers over the
 * existing callback implementations, plus `open()`, `iterate()`,
 * `stream()`, `transaction()` and dispose support. Called once from
 * lib/sqlite3.js after every callback-mode method is in place.
 *
 * @param {import('./sqlite3.js').sqlite3} sqlite3 the binding's export
 *   object, carrying `Database`, `Statement` and `Backup`.
 * @returns {void}
 */
export function installPromiseApi(sqlite3) {
    const { Database, Statement, Backup } = sqlite3;
    installed = { sqlite3, Database, Statement, Backup };
    dbCores = {
        get: Database.prototype.get,
        run: Database.prototype.run,
        all: Database.prototype.all,
        map: Database.prototype.map,
        exec: Database.prototype.exec,
        close: Database.prototype.close,
        wait: Database.prototype.wait,
        loadExtension: Database.prototype.loadExtension,
        each: Database.prototype.each,
    };
    stmtCores = {
        bind: Statement.prototype.bind,
        get: Statement.prototype.get,
        run: Statement.prototype.run,
        all: Statement.prototype.all,
        map: Statement.prototype.map,
        each: Statement.prototype.each,
        reset: Statement.prototype.reset,
        finalize: Statement.prototype.finalize,
    };
    backupCores = {
        step: Backup.prototype.step,
        finish: Backup.prototype.finish,
    };
    install(
        sqlite3,
        Database,
        Statement,
        Backup,
        /** @type {Record<string, (...callArgs: any[]) => any>} */ (dbCores),
        /** @type {Record<string, (...callArgs: any[]) => any>} */ (stmtCores),
        /** @type {Record<string, (...callArgs: any[]) => any>} */ (
            backupCores
        ),
    );
}

/**
 * Rewires `sqlite3.verbose()`: wraps the callback-mode cores with the
 * long-stack-trace machinery, then reinstalls the dual-mode wrappers so
 * promise rejections go through the same augmentation path.
 *
 * @param {(object: Record<string, import('./trace.js').Traceable>, property: string) => void} extendTrace the trace wrapper from lib/trace.js.
 * @returns {void}
 */
export function retracePromiseApi(extendTrace) {
    const installedNow = /** @type {Installed} */ (
        /** @type {unknown} */ (installed)
    );
    /** @type {Record<string, (...callArgs: any[]) => any>} */
    const db = /** @type {Record<string, (...callArgs: any[]) => any>} */ (
        /** @type {unknown} */ (dbCores)
    );
    /** @type {Record<string, (...callArgs: any[]) => any>} */
    const stmt = /** @type {Record<string, (...callArgs: any[]) => any>} */ (
        /** @type {unknown} */ (stmtCores)
    );
    /** @type {Record<string, (...callArgs: any[]) => any>} */
    const backup = /** @type {Record<string, (...callArgs: any[]) => any>} */ (
        /** @type {unknown} */ (backupCores)
    );
    for (const name of Object.keys(db)) {
        extendTrace(db, name);
    }
    for (const name of Object.keys(stmt)) {
        extendTrace(stmt, name);
    }
    for (const name of Object.keys(backup)) {
        extendTrace(backup, name);
    }
    install(
        installedNow.sqlite3,
        installedNow.Database,
        installedNow.Statement,
        installedNow.Backup,
        /** @type {Record<string, (...callArgs: any[]) => any>} */ (dbCores),
        /** @type {Record<string, (...callArgs: any[]) => any>} */ (stmtCores),
        /** @type {Record<string, (...callArgs: any[]) => any>} */ (
            backupCores
        ),
    );
}

export { associateStatement };
