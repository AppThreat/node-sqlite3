// Promise API, async iteration, transactions, resource disposal and
// cancellation. Everything here is assembled onto the classes by
// installPromiseApi() from lib/sqlite3.js.
//
// Every wrapped method is dual-mode: when the last argument is a function
// the call behaves exactly like the callback API (and returns `this`, so
// chaining keeps working); otherwise it returns a promise. Database#prepare
// and Database#backup deliberately keep their synchronous return in both
// forms — see the handoff notes for 03.

import { Readable } from 'node:stream';

// Statement -> Database association. Statements do not expose their
// database, but aborting a statement operation must interrupt the
// connection, so every JS-side statement creation point records the pair.
// Statements created through `new sqlite3.Statement(db, sql)` directly are
// not tracked: aborting those rejects without an interrupt.
const statementDatabases = new WeakMap();

/**
 * Records which database owns a statement, so AbortSignal handling can
 * reach `db.interrupt()` from a statement method.
 *
 * @param {import('./sqlite3.js').Database} db the owning connection.
 * @param {import('./sqlite3.js').Statement} statement the prepared statement.
 * @returns {object} the statement, for inline use.
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
    let lastIDValue;
    let lastIDError;
    let lastIDThrows = false;
    try {
        lastIDValue = statement.lastID;
    } catch (err) {
        lastIDThrows = true;
        lastIDError = err;
    }
    const lastIDBigInt = statement.lastIDBigInt;
    const changes = statement.changes;
    return {
        get lastID() {
            if (lastIDThrows) throw lastIDError;
            return lastIDValue;
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
function isSignalOptions(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (
        Object.hasOwn(value, 'signal') &&
        Object.keys(value).every((key) => key === 'signal')
    );
}

function splitSignalOption(args) {
    if (isSignalOptions(args.at(-1))) {
        return { signal: args.at(-1).signal, args: args.slice(0, -1) };
    }
    return { signal: undefined, args };
}

/**
 * Wraps a callback-mode core into a dual-mode method.
 *
 * @param {Function} core the callback-mode implementation.
 * @param {object} [options]
 * @param {Function} [options.pick] maps `(thisArg, result)` to the promise
 *   resolution value; default resolves the callback's own result argument.
 * @param {boolean} [options.void=true] resolve `undefined` regardless of
 *   the callback's result (exec/close/wait/reset/finalize/bind/finish).
 * @param {boolean} [options.signal=false] accept a trailing `{ signal }`
 *   options object and wire it to `db.interrupt()`.
 * @param {boolean} [options.statement=false] the receiver is a Statement
 *   whose database must be looked up for interrupt.
 * @returns {Function} the dual-mode method.
 */
function dualMode(core, options = {}) {
    const pick =
        options.void === true
            ? null
            : (options.pick ?? ((_self, result) => result));
    const acceptsSignal = options.signal === true;
    const isStatement = options.statement === true;
    return function (...args) {
        if (typeof args.at(-1) === 'function') {
            return core.apply(this, args);
        }
        let signal;
        if (acceptsSignal) {
            const split = splitSignalOption(args);
            signal = split.signal;
            args = split.args;
        }
        return new Promise((resolve, reject) => {
            if (signal !== undefined && signal !== null) {
                if (typeof signal.addEventListener !== 'function') {
                    reject(
                        new TypeError('options.signal must be an AbortSignal'),
                    );
                    return;
                }
                if (signal.aborted) {
                    reject(signal.reason);
                    return;
                }
            }
            let detach = null;
            if (signal !== undefined && signal !== null) {
                const self = this;
                const onAbort = () => {
                    // Cancellation is connection-wide: interrupt() reaches
                    // every in-flight statement on the database, not just
                    // the one being awaited. That is a SQLite constraint.
                    const db = isStatement
                        ? statementDatabases.get(self)
                        : self;
                    try {
                        db?.interrupt();
                    } catch {
                        // Closing or closed — the rejection below is the outcome.
                    }
                    detach();
                    reject(signal.reason);
                };
                detach = () => signal.removeEventListener('abort', onAbort);
                signal.addEventListener('abort', onAbort, { once: true });
            }
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
    };
}

/**
 * `each()` guard: it is callback-only (the async iterator is the
 * promise-based form), and calling it without any callback used to stream
 * every row into nowhere. Fail loudly instead.
 *
 * @param {Function} core the callback-mode each implementation.
 * @returns {Function} the guarded method.
 */
function eachCallbackOnly(core) {
    return function (...args) {
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
    };
}

// ---------------------------------------------------------------------------
// Async iteration

// One active iterator per statement; two would interleave their cursors.
const activeIterations = new WeakSet();

const ITERATOR_MIN_BATCH = 64;
const ITERATOR_MAX_BATCH = 1024;

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
 * @param {object} options
 * @returns {AsyncIterableIterator<object>} the async iterator.
 * @throws {Error} when the statement already has an active iterator.
 */
function createAsyncIterator(statement, options) {
    const params = options.params ?? [];
    const ownsStatement = options.ownsStatement === true;
    const signal = options.signal;
    const prepare = options.prepare ?? null;

    if (statement !== null && activeIterations.has(statement)) {
        throw new Error(
            'Statement is already being iterated; finish or break the first ' +
                'iterator, or iterate a second statement instead.',
        );
    }
    if (statement !== null) activeIterations.add(statement);

    let buffer = [];
    let cursorDone = false;
    let error = null;
    let closed = false;
    let finished = null;
    let batch = ITERATOR_MIN_BATCH;
    let firstFetch = true;
    let inFlight = null;
    const waiters = [];

    let aborted = false;
    let abortReason = null;
    let onAbort = null;
    let signalDetached = !signal;
    const detachSignal = () => {
        if (signalDetached) return;
        signalDetached = true;
        if (onAbort) signal.removeEventListener('abort', onAbort);
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

    let prepareError = null;
    // Set once the statement's prepare has failed. A statement that never
    // reached `prepared` drops every queued call in Statement::CleanQueue
    // without firing its callback (src/statement.cc), so anything waiting on
    // one has to be woken from here instead.
    let prepareFailed = false;
    // Resolver of the in-flight teardown, so a prepare failure can settle it.
    let teardownResolve = null;

    function ensureStatement() {
        if (prepare === null || statement !== null) return;
        statement = prepare(function (err) {
            if (err) {
                prepareError = err;
                prepareFailed = true;
                // A fetch queued behind the failed prepare is silently
                // deleted by CleanQueue and its callback never fires;
                // a pending pull must be failed here instead.
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
        });
        activeIterations.add(statement);
    }

    function settleTeardown() {
        if (teardownResolve === null) return;
        const resolve = teardownResolve;
        teardownResolve = null;
        resolve();
    }

    function dispatch(resolve, reject) {
        if (error !== null) {
            const err = error;
            error = null;
            reject(err);
            return true;
        }
        if (buffer.length > 0) {
            resolve({ value: buffer.shift(), done: false });
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
        const args = firstFetch ? [batch, ...params] : [batch];
        firstFetch = false;
        inFlight = new Promise((resolve) => {
            statement.fetch(...args, function (err, rows, done) {
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
            });
        });
    }

    function close() {
        if (closed) return;
        closed = true;
        detachSignal();
        if (statement !== null) activeIterations.delete(statement);
    }

    // Teardown is awaited by return()/throw() so that, once `for await`
    // resumes after a break, the statement is unlocked and the database is
    // idle (the sync fast path's getSync works immediately). Errors here
    // are swallowed by design: cleanup must not mask the outcome the
    // consumer already received, and finalizing an already-finalized
    // statement is a benign MISUSE.
    function teardown() {
        const target = statement;
        if (target === null) return Promise.resolve();
        // A failed prepare already tore the statement down and dropped its
        // queue; asking for a finalize here would wait forever.
        if (prepareFailed) return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => {
                teardownResolve = null;
                resolve();
            };
            try {
                if (ownsStatement) {
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
        next() {
            return new Promise((resolve, reject) => {
                if (aborted && error === null && !closed) {
                    error = abortReason;
                    close();
                }
                if (!dispatch(resolve, reject)) {
                    waiters.push({ resolve, reject });
                    pull();
                }
            });
        },
        async return(value) {
            close();
            await finish();
            return { value, done: true };
        },
        async throw(err) {
            close();
            await finish();
            throw err;
        },
    };
}

function iterateParams(args) {
    if (isSignalOptions(args.at(-1))) {
        return { params: args.slice(0, -1), signal: args.at(-1).signal };
    }
    return { params: args, signal: undefined };
}

// ---------------------------------------------------------------------------
// Transactions

const transactionDepths = new WeakMap();
const TRANSACTION_MODES = new Set(['deferred', 'immediate', 'exclusive']);

async function runTransaction(db, fn, opts) {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (signal && typeof signal.addEventListener !== 'function') {
        return Promise.reject(
            new TypeError('options.signal must be an AbortSignal'),
        );
    }

    const depth = transactionDepths.get(db) ?? 0;
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

    const execAll = async (sqls) => {
        for (const sql of sqls) {
            await db.exec(sql);
        }
    };

    let aborted = false;
    let abortReason = null;
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
        if (onAbort) signal.removeEventListener('abort', onAbort);
    };

    if (opts.serialize) db.serialize();
    transactionDepths.set(db, depth + 1);

    try {
        try {
            await execAll(beginSqls);
        } catch (err) {
            throw aborted ? abortReason : err;
        }

        let failed = false;
        let failure;
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
            // COMMIT failed (e.g. SQLITE_BUSY): best-effort rollback, then
            // surface the commit error itself.
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
        transactionDepths.set(db, depth);
        detachSignal();
        if (opts.serialize) db.parallelize();
    }
}

// ---------------------------------------------------------------------------
// Installation

let dbCores = null;
let stmtCores = null;
let backupCores = null;
let installed = null;

function install(sqlite3, Database, Statement, Backup) {
    Database.prototype.get = dualMode(dbCores.get, { signal: true });
    Database.prototype.run = dualMode(dbCores.run, {
        signal: true,
        pick: makeRunResult,
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
        pick: makeRunResult,
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
            let db;
            try {
                db =
                    mode === undefined
                        ? new Database(filename, (err) => {
                              if (err) reject(err);
                              else resolve(db);
                          })
                        : new Database(filename, mode, (err) => {
                              if (err) reject(err);
                              else resolve(db);
                          });
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
     * @param {...any} [params] bind parameters, then an optional
     *   `{ signal }` options object.
     * @returns {AsyncIterableIterator<object>} the async iterator.
     * @since 9.0.0
     * @example
     * for await (const row of db.iterate('SELECT * FROM big')) { ... }
     */
    Database.prototype.iterate = function (sql, ...rest) {
        const { params, signal } = iterateParams(rest);
        return createAsyncIterator(null, {
            params,
            signal,
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
     * @param {...any} [params] bind parameters for the first fetch, then
     *   an optional `{ signal }` options object.
     * @returns {AsyncIterableIterator<object>} the async iterator.
     * @since 9.0.0
     * @example
     * const stmt = db.prepare('SELECT * FROM t WHERE a = ?');
     * for await (const row of stmt.iterate(42)) { ... }
     */
    Statement.prototype.iterate = function (...rest) {
        const { params, signal } = iterateParams(rest);
        return createAsyncIterator(this, {
            params,
            signal,
            ownsStatement: false,
            interrupt: () => statementDatabases.get(this)?.interrupt(),
        });
    };

    /**
     * `db.iterate()` as a Node `Readable` (object mode), for piping and
     * composing with the rest of the stream ecosystem.
     *
     * @param {string} sql the query to stream.
     * @param {...any} [params] bind parameters, then `{ signal }` options.
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
     * @param {Function} fn the transaction body, receives `(tx)`.
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
        return runTransaction(this, fn, {
            mode,
            savepoint: options?.savepoint === true,
            serialize: options?.serialize === true,
            signal: options?.signal,
        });
    };

    // Dispose support: `await using` closes/finalizes; a double dispose is
    // a benign no-op rather than a rejection. Errors that only say "this
    // was already torn down" are swallowed; real errors propagate.
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
 * @param {object} sqlite3 the binding's export object, carrying
 *   `Database`, `Statement` and `Backup`.
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
    install(sqlite3, Database, Statement, Backup);
}

/**
 * Rewires `sqlite3.verbose()`: wraps the callback-mode cores with the
 * long-stack-trace machinery, then reinstalls the dual-mode wrappers so
 * promise rejections go through the same augmentation path.
 *
 * @param {Function} extendTrace the trace wrapper from lib/trace.js.
 * @returns {void}
 */
export function retracePromiseApi(extendTrace) {
    for (const name of Object.keys(dbCores)) extendTrace(dbCores, name);
    for (const name of Object.keys(stmtCores)) extendTrace(stmtCores, name);
    for (const name of Object.keys(backupCores)) {
        extendTrace(backupCores, name);
    }
    install(
        installed.sqlite3,
        installed.Database,
        installed.Statement,
        installed.Backup,
    );
}

export { associateStatement };
