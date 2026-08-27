// The worker pool: one writer connection plus N read-only connections,
// each on its own worker thread. SQLite allows one writer at a time; a
// pool that routes every write to the single writer connection and reads
// to the reader connections converts SQLITE_BUSY retry loops into
// queueing, and moves all SQLite work off the main thread.
//
// The design is deliberately boring: whole queries cross postMessage
// (structured clone), results come back the same way, and each
// connection runs exactly one query at a time. The one-at-a-time rule is
// what makes cancellation precise (one progress-flag slot per
// connection) and what makes the writer a serializer rather than a race.
// Concurrency comes from having N connections, not from interleaving on
// one — see docs/concurrency.md for when that trade is right.
//
// Cross-thread facts this file relies on (verified):
//  - structured clone drops an Error's own properties, so SQLite
//    diagnostics (code/errno/primaryCode) are re-serialized explicitly;
//  - a Buffer clones as a plain Uint8Array, so blob columns in pool
//    results are Uint8Array, not Buffer;
//  - a SharedArrayBuffer shares memory across the boundary, so the
//    parent can set a cancellation flag the worker's connection polls.
//
// Deadlock posture: the writer mutex is held for the whole of a
// transaction, so anything a transaction body awaits that itself needs
// the writer would wait forever. Rather than let that hang, the body
// runs inside an AsyncLocalStorage mark and the pool-facing methods
// that could self-deadlock (write/exec/read-without-readers/transaction/
// close) reject loudly from inside one, pointing at the tx handle.

import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';

/**
 * Options for {@link pool}.
 *
 * @typedef {object} PoolOptions
 * @property {number} [readers] how many read-only worker connections to
 *   open (default 4). 0 routes reads to the writer, serializing them
 *   with writes — the right shape for a write-heavy file or a
 *   `:memory:` database.
 * @property {boolean} [walMode] set `PRAGMA journal_mode = WAL` on the
 *   writer before readers connect (default true). WAL is what lets
 *   readers and the writer proceed concurrently; with `false` (or on a
 *   filesystem that refuses WAL) readers can block on the writer and
 *   rely on `busyTimeout`.
 * @property {number} [busyTimeout] `PRAGMA busy_timeout` in milliseconds
 *   for every connection (default 5000).
 * @property {'number' | 'bigint' | 'mixed'} [integerMode] the integer
 *   conversion mode for every connection (see
 *   `configure('integerMode', …)`); the driver default (`'number'`)
 *   applies when omitted.
 * @since 9.0.0
 */

/**
 * Options for a pool query.
 *
 * @typedef {object} PoolQueryOptions
 * @property {AbortSignal} [signal] aborts the query: the connection
 *   running it is interrupted through a shared-memory flag, and the
 *   promise rejects with the signal's reason. As with the
 *   single-connection API, an abort that loses the race with a
 *   completing query still rejects and drops the result.
 * @since 9.0.0
 */

/**
 * The query surface inside {@link SqlitePool#transaction}, pinned to the
 * writer connection: reads see the transaction's own uncommitted writes,
 * writes join it.
 *
 * @typedef {object} PoolTransaction
 * @property {(sql: string, params?: import('./native.js').BindParams) => Promise<import('./native.js').Row[]>} read
 *   runs a query on the writer, resolving every row.
 * @property {(sql: string, params?: import('./native.js').BindParams) => Promise<import('./native.js').Row | undefined>} get
 *   runs a query on the writer, resolving the first row (or undefined).
 * @property {(sql: string, params?: import('./native.js').BindParams) => Promise<import('./promises.js').PromiseRunResult>} write
 *   runs a statement inside the transaction, resolving `{lastID, changes, lastIDBigInt}`.
 * @property {(sql: string) => Promise<void>} exec
 *   runs raw SQL (DDL, pragmas) inside the transaction.
 * @since 9.0.0
 */

// Set while a transaction body runs: the pool-facing methods that would
// wait on the writer (and so on the very transaction the body is
// building) reject instead of hanging.
/** @type {AsyncLocalStorage<boolean>} */
const txBody = new AsyncLocalStorage();

/**
 * A worker-thread pool over one database file: a single writer
 * connection plus read-only reader connections, each on its own worker.
 *
 * Created with {@link pool}; not a constructor users call. Every method
 * is promise-only — there is no callback form, and none of the objects
 * from the worker connections (`Database`, `Statement`, …) ever cross
 * the boundary.
 *
 * Rows are structured-cloned across `postMessage`, so blob columns come
 * back as plain `Uint8Array` (not `Buffer`), and large result sets pay a
 * copy — the pool is shaped for many small queries, not for
 * `SELECT *` over a million rows (see docs/concurrency.md).
 *
 * @since 9.0.0
 */
class SqlitePool {
    /** @type {string} */
    #filename;

    /** @type {number} */
    #readerCount;

    /** @type {boolean} */
    #walMode;

    /** @type {number} */
    #busyTimeout;

    /** @type {string | undefined} */
    #integerMode;

    /** @type {Slot | null} */
    #writer = null;

    /** @type {Slot[]} */
    #readers = [];

    /** @type {Promise<void> | null} */
    #closePromise = null;

    // Gate for user-facing work: set when close() starts, so in-flight
    // operations (including transaction bodies, whose tx calls then
    // reject and unwind into a ROLLBACK) can drain.
    #closing = false;

    // Mutex over the writer connection: held for the whole of a write,
    // and for the whole of a transaction (BEGIN..COMMIT), so nothing can
    // interleave inside another transaction.
    #writerTail = Promise.resolve();

    // Every request in flight, queued or running: close() drains these
    // before touching the workers.
    /** @type {Set<Promise<unknown>>} */
    #inflight = new Set();

    #nextId = 1;

    /**
     * @param {string} filename the database file.
     * @param {{ readers: number, walMode: boolean, busyTimeout: number,
     *     integerMode: ('number' | 'bigint' | 'mixed') | undefined }} options
     *   validated options.
     */
    constructor(filename, options) {
        this.#filename = filename;
        this.#readerCount = options.readers;
        this.#walMode = options.walMode;
        this.#busyTimeout = options.busyTimeout;
        this.#integerMode = options.integerMode;
    }

    /**
     * Spawns the workers and opens every connection.
     *
     * The writer connects first (it may create the file and switch it to
     * WAL); the readers follow in parallel so a missing file cannot fail
     * their read-only opens. On any failure every spawned worker is
     * terminated and the error surfaces.
     *
     * @param {string} filename the database file.
     * @param {{ readers: number, walMode: boolean, busyTimeout: number,
     *     integerMode: ('number' | 'bigint' | 'mixed') | undefined }} options
     *   the validated options.
     * @returns {Promise<SqlitePool>} the opened pool.
     */
    static async create(filename, options) {
        const pool = new SqlitePool(filename, options);
        /** @type {Slot[]} */
        const spawned = [];
        try {
            pool.#writer = pool.#spawn(false, spawned);
            await pool.#writer.ready;
            for (let i = 0; i < pool.#readerCount; i++) {
                pool.#readers.push(pool.#spawn(true, spawned));
            }
            await Promise.all(pool.#readers.map((slot) => slot.ready));
        } catch (err) {
            await Promise.all(spawned.map((slot) => slot.terminate()));
            throw err;
        }
        return pool;
    }

    /**
     * Spawns one worker and sends it the open message.
     *
     * @param {boolean} readOnly whether the connection is a reader.
     * @param {Slot[]} spawned accumulator for startup teardown.
     * @returns {Slot} the slot for the new worker.
     */
    #spawn(readOnly, spawned) {
        const slot = new Slot(
            new Worker(
                new URL('./worker.js', import.meta.url),
                /** @type {import('node:worker_threads').WorkerOptions} */ (
                    /** @type {unknown} */ ({ type: 'module' })
                ),
            ),
        );
        spawned.push(slot);
        slot.worker.postMessage({
            kind: 'open',
            filename: this.#filename,
            readOnly,
            walMode: this.#walMode,
            busyTimeout: this.#busyTimeout,
            integerMode: this.#integerMode,
        });
        return slot;
    }

    /**
     * The error every operation on a closed pool rejects with.
     *
     * @returns {Error} the closed-pool error.
     */
    #closedError() {
        return new Error('pool is closed');
    }

    /**
     * The error thrown when a pool-facing method that needs the writer
     * is called from inside a transaction body (where it would wait on
     * that very transaction forever).
     *
     * @param {string} who the calling method.
     * @returns {Error} the deadlock-refusal error.
     */
    #insideTxError(who) {
        return new Error(
            `${who} cannot run inside a pool.transaction() body: the ` +
                'writer is pinned by the transaction until it commits. ' +
                'Use the tx handle the body receives',
        );
    }

    /**
     * The database filename the pool was created with.
     *
     * @returns {string} the filename.
     * @since 9.0.0
     */
    get filename() {
        return this.#filename;
    }

    /**
     * How many read-only connections the pool was created with.
     *
     * @returns {number} the reader count.
     * @since 9.0.0
     */
    get readers() {
        return this.#readerCount;
    }

    /**
     * True once close() has started (the pool refuses new work).
     *
     * @returns {boolean} whether close() has started.
     * @since 9.0.0
     */
    get closed() {
        return this.#closing;
    }

    /**
     * Runs a query on a reader connection, resolving every row. With
     * `readers: 0` the query runs on the writer, serialized with writes
     * (and is refused inside a transaction body — use the tx handle).
     *
     * Reads on reader connections see committed data only — including,
     * under WAL, data a running transaction on the writer has written
     * but not committed.
     *
     * @param {...any} args the SQL query, then optionally bind
     *   parameters (one array or named-parameter object), then
     *   optionally a trailing `{ signal }` options object.
     * @returns {Promise<import('./native.js').Row[]>} every result row.
     * @throws {TypeError} when the SQL is not a non-empty string or the
     *   arguments are malformed.
     * @since 9.0.0
     * @example
     * const rows = await pool.read('SELECT id FROM users WHERE name = ?', ['alice']);
     */
    async read(...args) {
        const { sql, params, signal } = splitQueryArgs(args, 'read()');
        this.#checkOpen('read()');
        const slot = this.#pickReader();
        if (slot !== null)
            return this.#enqueue(slot, sql, params, signal, 'all');
        this.#refuseWriterRead('read()');
        return this.#withWriter(() =>
            this.#enqueue(this.#writerSlot(), sql, params, signal, 'all'),
        );
    }

    /**
     * Runs a query on a reader connection, resolving the first row (or
     * `undefined`). Same routing and visibility rules as
     * {@link SqlitePool#read}.
     *
     * @param {...any} args the SQL query, then optionally bind
     *   parameters (one array or named-parameter object), then
     *   optionally a trailing `{ signal }` options object.
     * @returns {Promise<import('./native.js').Row | undefined>} the first row, or undefined.
     * @throws {TypeError} when the SQL is not a non-empty string or the
     *   arguments are malformed.
     * @since 9.0.0
     * @example
     * const user = await pool.get('SELECT id FROM users WHERE name = ?', ['alice']);
     */
    async get(...args) {
        const { sql, params, signal } = splitQueryArgs(args, 'get()');
        this.#checkOpen('get()');
        const slot = this.#pickReader();
        if (slot !== null)
            return this.#enqueue(slot, sql, params, signal, 'get');
        this.#refuseWriterRead('get()');
        return this.#withWriter(() =>
            this.#enqueue(this.#writerSlot(), sql, params, signal, 'get'),
        );
    }

    /**
     * Runs a statement on the writer connection, resolving
     * `{lastID, changes, lastIDBigInt}`. Writes serialize: concurrent
     * calls queue on the single writer instead of racing each other to
     * SQLITE_BUSY.
     *
     * @param {...any} args the SQL statement, then optionally bind
     *   parameters (one array or named-parameter object), then
     *   optionally a trailing `{ signal }` options object.
     * @returns {Promise<import('./promises.js').PromiseRunResult>} the run result.
     * @throws {TypeError} when the SQL is not a non-empty string or the
     *   arguments are malformed.
     * @since 9.0.0
     * @example
     * const result = await pool.write('INSERT INTO users (name) VALUES (?)', ['alice']);
     */
    async write(...args) {
        const { sql, params, signal } = splitQueryArgs(args, 'write()');
        this.#checkOpen('write()');
        if (txBody.getStore() === true) {
            throw this.#insideTxError('write()');
        }
        return this.#withWriter(() =>
            this.#enqueue(this.#writerSlot(), sql, params, signal, 'run'),
        );
    }

    /**
     * Runs raw SQL on the writer connection: DDL, pragmas,
     * multi-statement scripts. Resolves once every statement has run.
     *
     * @param {string} sql the SQL to execute.
     * @returns {Promise<void>} resolves when the SQL has run.
     * @throws {TypeError} when the SQL is not a non-empty string.
     * @since 9.0.0
     * @example
     * await pool.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
     */
    async exec(sql) {
        if (typeof sql !== 'string' || sql.length === 0) {
            throw new TypeError('exec() requires a non-empty SQL string');
        }
        this.#checkOpen('exec()');
        if (txBody.getStore() === true) {
            throw this.#insideTxError('exec()');
        }
        return this.#withWriter(() =>
            this.#enqueue(
                this.#writerSlot(),
                sql,
                undefined,
                undefined,
                'exec',
            ),
        );
    }

    /**
     * Runs `fn` as one transaction on the writer connection, with
     * `ROLLBACK` on failure. The whole transaction is pinned to the
     * writer: the {@link PoolTransaction} handle `fn` receives routes
     * every query there, its reads see the transaction's own uncommitted
     * writes, and no other write can interleave inside it.
     *
     * Transactions serialize — a second `transaction()` call waits for
     * the first to commit or roll back. Reads issued as `pool.read()`
     * inside the body still run on the readers and still see committed
     * data only. Inside the body, use the tx handle rather than
     * `pool.write()`/`pool.exec()` (they refuse, rather than wait on the
     * transaction they would be joining).
     *
     * @template T
     * @param {(tx: PoolTransaction) => T | Promise<T>} fn the transaction body.
     * @param {{ mode?: 'deferred' | 'immediate' | 'exclusive' }} [options]
     *   `mode` selects the BEGIN form (default `'deferred'`; use
     *   `'immediate'` to take the write lock up front).
     * @returns {Promise<T>} whatever the body resolves to.
     * @throws {TypeError} when `fn` is not a function or the options are
     *   malformed.
     * @throws {AggregateError} when the body and the ROLLBACK both fail.
     * @since 9.0.0
     * @example
     * await pool.transaction(async (tx) => {
     *     const user = await tx.get('SELECT id FROM users WHERE name = ?', ['alice']);
     *     await tx.write('INSERT INTO logs (user_id) VALUES (?)', [user.id]);
     * });
     */
    async transaction(fn, options) {
        if (typeof fn !== 'function') {
            throw new TypeError('transaction() requires a function body');
        }
        let mode = 'deferred';
        if (options !== undefined && options !== null) {
            if (typeof options !== 'object' || Array.isArray(options)) {
                throw new TypeError('transaction() options must be an object');
            }
            const known = new Set(['mode']);
            for (const key of Object.keys(options)) {
                if (!known.has(key)) {
                    throw new TypeError(
                        `transaction() received unknown option '${key}'`,
                    );
                }
            }
            if (options.mode !== undefined) {
                if (
                    !['deferred', 'immediate', 'exclusive'].includes(
                        options.mode,
                    )
                ) {
                    throw new TypeError(
                        "transaction() mode must be 'deferred', 'immediate' or 'exclusive'",
                    );
                }
                mode = options.mode;
            }
        }
        this.#checkOpen('transaction()');
        if (txBody.getStore() === true) {
            throw this.#insideTxError('transaction()');
        }
        // Tracked from acceptance, like #withWriter: a transaction still
        // waiting on the writer mutex must hold close() up too.
        return this.#track(this.#runTransaction(fn, mode));
    }

    /**
     * The body of {@link SqlitePool#transaction}, after validation.
     *
     * @template T
     * @param {(tx: PoolTransaction) => T | Promise<T>} fn the transaction body.
     * @param {string} mode the BEGIN form.
     * @returns {Promise<T>} whatever the body resolves to.
     */
    async #runTransaction(fn, mode) {
        // No re-check of #closing here. The transaction was accepted
        // before close() started (the entry point refuses otherwise) and
        // is registered for the drain, so close() waits for it — the same
        // contract a queued write gets. Refusing here instead dropped
        // transactions that merely happened to be behind another writer.
        const release = await this.#acquireWriter();
        const writer = this.#writerSlot();
        /** @type {PoolTransaction} */
        const tx = {
            read: (sql, params) =>
                this.#enqueue(writer, sql, params, undefined, 'all'),
            get: (sql, params) =>
                this.#enqueue(writer, sql, params, undefined, 'get'),
            write: (sql, params) =>
                this.#enqueue(writer, sql, params, undefined, 'run'),
            exec: (sql) =>
                this.#enqueue(writer, sql, undefined, undefined, 'exec'),
        };
        return txBody.run(true, async () => {
            try {
                await this.#enqueue(
                    writer,
                    `BEGIN ${mode.toUpperCase()}`,
                    undefined,
                    undefined,
                    'exec',
                );
                let result;
                try {
                    result = await fn(tx);
                } catch (failure) {
                    try {
                        await this.#enqueue(
                            writer,
                            'ROLLBACK',
                            undefined,
                            undefined,
                            'exec',
                        );
                    } catch (rollbackError) {
                        throw new AggregateError(
                            [failure, rollbackError],
                            'transaction body failed and its ROLLBACK ' +
                                'failed too; the writer connection may ' +
                                'still hold the transaction open',
                        );
                    }
                    throw failure;
                }
                try {
                    await this.#enqueue(
                        writer,
                        'COMMIT',
                        undefined,
                        undefined,
                        'exec',
                    );
                } catch (commitError) {
                    // COMMIT can fail (e.g. SQLITE_BUSY); best-effort
                    // rollback, then surface the commit error itself.
                    try {
                        await this.#enqueue(
                            writer,
                            'ROLLBACK',
                            undefined,
                            undefined,
                            'exec',
                        );
                    } catch {
                        // The commit error is the story worth telling.
                    }
                    throw commitError;
                }
                return result;
            } finally {
                release();
            }
        });
    }

    /**
     * Closes the pool: refuses new work, waits for every in-flight
     * operation (including running transactions) to settle, closes every
     * connection on its worker, and waits for every worker to exit. No
     * worker survives close().
     *
     * Idempotent — every call returns the same promise. Refused from
     * inside a transaction body (it would wait on that transaction).
     *
     * @returns {Promise<void>} resolves once every worker has exited.
     * @since 9.0.0
     * @example
     * await pool.close();
     */
    close() {
        if (txBody.getStore() === true) {
            return Promise.reject(this.#insideTxError('close()'));
        }
        if (this.#closePromise !== null) return this.#closePromise;
        this.#closing = true;
        const slots = [
            ...(this.#writer !== null ? [this.#writer] : []),
            ...this.#readers,
        ];
        this.#closePromise = (async () => {
            // Drain. Only the entry points refuse once #closing is set;
            // work already accepted runs to completion, so a transaction
            // caught by close() commits rather than rolling back
            // (verified: a body still running when close() lands inserts
            // and commits, and the rows are there afterwards). The loop
            // rather than a single snapshot because settling one entry
            // can register another — a transaction's own COMMIT, or a
            // write that was still waiting on the writer mutex.
            while (this.#inflight.size > 0) {
                await Promise.allSettled([...this.#inflight]);
            }
            await Promise.all(slots.map((slot) => slot.shutdown()));
        })();
        return this.#closePromise;
    }

    /**
     * `await using pool` — disposes via {@link SqlitePool#close}.
     *
     * @returns {Promise<void>} resolves once the pool is closed.
     * @since 9.0.0
     */
    [Symbol.asyncDispose]() {
        return this.close();
    }

    /**
     * Refuses work on a closed pool.
     *
     * @param {string} who the calling method.
     * @returns {void}
     * @throws {Error} when close() has started.
     */
    #checkOpen(who) {
        if (this.#closing) {
            const err = this.#closedError();
            err.message = `${err.message} (${who})`;
            throw err;
        }
    }

    /**
     * Picks the reader with the least queued work, skipping dead ones.
     * Returns null when the pool has no readers or none is alive.
     *
     * @returns {Slot | null} the chosen reader slot.
     */
    #pickReader() {
        if (this.#readerCount === 0) return null;
        /** @type {Slot | null} */
        let best = null;
        for (const slot of this.#readers) {
            if (slot.dead) continue;
            if (best === null || slot.depth < best.depth) best = slot;
        }
        return best;
    }

    /**
     * Refuses a read that would have to fall back to the writer: inside
     * a transaction body that would wait on the body's own transaction
     * forever, and with every reader worker dead it would silently
     * serialize reads behind writes — loud in both cases.
     *
     * @param {string} who the calling method.
     * @returns {void}
     * @throws {Error} when the read cannot run on a reader.
     */
    #refuseWriterRead(who) {
        if (this.#readerCount > 0) {
            throw new Error(
                'every pool reader worker has exited; the pool does not ' +
                    'restart crashed workers — create a new pool',
            );
        }
        if (txBody.getStore() === true) {
            throw this.#insideTxError(who);
        }
    }

    /**
     * The writer slot, failing loudly if it is gone.
     *
     * @returns {Slot} the writer slot.
     * @throws {Error} when the writer worker has exited.
     */
    #writerSlot() {
        const writer = this.#writer;
        if (writer === null || writer.dead) {
            throw new Error(
                'the pool writer worker has exited; the pool does not ' +
                    'restart crashed workers — create a new pool',
            );
        }
        return writer;
    }

    /**
     * Acquires the writer mutex.
     *
     * @returns {Promise<() => void>} resolves with the release function.
     */
    #acquireWriter() {
        const ticket = this.#writerTail;
        /** @type {() => void} */
        let release = () => {
            // Replaced synchronously below; a release before then is a
            // benign no-op.
        };
        this.#writerTail = new Promise((resolve) => {
            release = resolve;
        });
        return ticket.then(() => release);
    }

    /**
     * Registers a promise as in-flight work for close()'s drain, and
     * deregisters it when it settles.
     *
     * Everything the pool has *accepted* has to be registered, not just
     * what has reached a worker: a write waiting its turn on the writer
     * mutex has not called #enqueue yet, so tracking only there let
     * close() see an almost-empty set, shut the workers down, and fail
     * the waiting writes with "pool worker exited unexpectedly" —
     * exactly the silent-loss that drain-on-close exists to prevent.
     *
     * @template T
     * @param {Promise<T>} promise the accepted work.
     * @returns {Promise<T>} the same work, tracked.
     */
    #track(promise) {
        const tracked = promise.finally(() => {
            this.#inflight.delete(tracked);
        });
        this.#inflight.add(tracked);
        return tracked;
    }

    /**
     * Runs `fn` while holding the writer mutex, tracked from the moment
     * the work is accepted rather than from when it reaches the worker.
     *
     * @template T
     * @param {() => Promise<T>} fn the work to run.
     * @returns {Promise<T>} whatever fn resolves to.
     */
    #withWriter(fn) {
        return this.#track(
            (async () => {
                const release = await this.#acquireWriter();
                try {
                    return await fn();
                } finally {
                    release();
                }
            })(),
        );
    }

    /**
     * Enqueues one query on a slot's serialization chain, tracks it for
     * close()'s drain, and wires the cancellation flag when a signal was
     * given.
     *
     * @param {Slot} slot the connection to run on.
     * @param {string} sql the SQL.
     * @param {import('./native.js').BindParams | undefined} params bind parameters.
     * @param {AbortSignal | undefined} signal cancellation signal.
     * @param {'all' | 'get' | 'run' | 'exec'} method the driver method.
     *   a transaction reject once close() starts (unwinding the body),
     *   while BEGIN/COMMIT/ROLLBACK must still reach the worker.
     * @returns {Promise<any>} the query result.
     */
    #enqueue(slot, sql, params, signal, method) {
        if (slot.dead) {
            return Promise.reject(slot.deadError());
        }
        /** @type {SharedArrayBuffer | undefined} */
        let cancel;
        if (signal) {
            cancel = new SharedArrayBuffer(4);
        }
        const id = this.#nextId++;
        /** @type {any} */
        const msg = { id, kind: 'query', method, sql };
        if (params !== undefined) msg.params = params;
        if (cancel !== undefined) msg.cancel = cancel;

        const run = slot.tail.then(() => {
            // The connection is now idle and it is this request's turn.
            // Work accepted before close() runs to completion here —
            // only post-close entry-point calls are refused — and an
            // aborted request skips the round trip entirely.
            if (signal?.aborted) throw signal.reason;
            return this.#send(slot, msg);
        });
        slot.tail = run.then(
            () => {
                // Chain position advances on success.
            },
            (err) => {
                // and on failure: the next request must still run, so
                // the tail never rejects.
                void err;
            },
        );
        slot.depth++;
        const tracked = run.finally(() => {
            slot.depth--;
            this.#inflight.delete(tracked);
        });
        // Tracked from enqueue, not first send: a request still queued
        // behind another must hold close() up too.
        this.#inflight.add(tracked);

        if (!signal) return tracked;
        const flag = new Int32Array(/** @type {SharedArrayBuffer} */ (cancel));
        const onAbort = () => {
            Atomics.store(flag, 0, 1);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        return tracked
            .finally(() => {
                signal.removeEventListener('abort', onAbort);
            })
            .then(
                (value) => {
                    // An abort that lost the race with a completing query
                    // still wins the contract: reject and drop the result
                    // (the single-connection API behaves the same).
                    if (signal.aborted) throw signal.reason;
                    return value;
                },
                (err) => {
                    if (signal.aborted) throw signal.reason;
                    throw err;
                },
            );
    }

    /**
     * Sends one request message and awaits its reply.
     *
     * @param {Slot} slot the worker to send to.
     * @param {any} msg the message.
     * @returns {Promise<any>} the reply's value, or the rehydrated error.
     */
    #send(slot, msg) {
        return new Promise((resolve, reject) => {
            slot.pending.set(msg.id, { resolve, reject });
            try {
                slot.worker.postMessage(msg);
            } catch (err) {
                slot.pending.delete(msg.id);
                reject(err);
            }
        });
    }
}

// Marker for errors the worker sent back (already rehydrated), so
// callers can tell a SQL failure from infrastructure trouble.
class QueryError extends Error {
    /** @type {string | undefined} */
    code;

    /** @type {number | undefined} */
    errno;

    /** @type {string | undefined} */
    primaryCode;
}

/**
 * One worker and its connection: the serialization chain (`tail`), the
 * queue depth for routing, and the pending reply map.
 *
 * @private
 */
class Slot {
    /**
     * @param {Worker} worker the worker thread.
     */
    constructor(worker) {
        this.worker = worker;
        this.tail = Promise.resolve();
        this.depth = 0;
        this.dead = false;
        /** @type {Error | null} */
        this.exitCause = null;
        /** @type {Map<number, { resolve: (value: any) => void, reject: (err: unknown) => void }>} */
        this.pending = new Map();
        /** @type {Promise<void>} */
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        /** @type {Promise<void> | null} */
        this.exitPromise = null;

        worker.on('message', (msg) => this.#onMessage(msg));
        worker.on('error', (err) => {
            // 'exit' follows and does the pending rejection; remember
            // the cause so the error names what actually happened.
            this.exitCause = err;
        });
        worker.on('exit', () => this.#onExit());
    }

    /**
     * Awaits the worker's readiness.
     *
     * @returns {Promise<void>} resolves on 'ready', rejects on the open
     *   error or an early exit.
     */
    get ready() {
        return this.readyPromise;
    }

    /**
     * The error to reject pending work with once this worker is dead.
     *
     * @returns {Error} the exit cause or a generic message.
     */
    deadError() {
        return this.exitCause ?? new Error('pool worker exited unexpectedly');
    }

    /**
     * @param {any} msg the message from the worker.
     */
    #onMessage(msg) {
        if (msg.kind === 'ready') {
            this.readyResolve?.();
            return;
        }
        if (msg.kind === 'openError') {
            this.readyReject?.(deserializeError(msg.error));
            return;
        }
        if (msg.kind === 'closed') {
            if (msg.error) {
                // The connection refused to close cleanly (e.g.
                // SQLITE_BUSY); surface it rather than swallowing.
                this.exitCause = deserializeError(msg.error);
            }
            return;
        }
        if (msg.kind === 'result' || msg.kind === 'error') {
            const entry = this.pending.get(msg.id);
            if (entry === undefined) return;
            this.pending.delete(msg.id);
            if (msg.kind === 'result') entry.resolve(msg.value);
            else entry.reject(deserializeError(msg.error));
        }
    }

    /**
     * Fails everything pending when the worker goes away.
     */
    #onExit() {
        this.dead = true;
        const err = this.deadError();
        for (const entry of this.pending.values()) {
            entry.reject(err);
        }
        this.pending.clear();
        this.readyReject?.(new Error('pool worker exited unexpectedly'));
    }

    /**
     * Asks the worker to close its connection, then awaits its exit.
     *
     * @returns {Promise<void>} resolves once the worker exited.
     */
    shutdown() {
        if (this.exitPromise !== null) return this.exitPromise;
        this.exitPromise = new Promise((resolve) => {
            if (this.dead) {
                resolve();
                return;
            }
            this.worker.once('exit', () => resolve());
            this.worker.postMessage({ kind: 'close' });
        });
        return this.exitPromise;
    }

    /**
     * Hard-terminates the worker (startup-failure path, where the
     * graceful close handshake cannot be assumed).
     *
     * @returns {Promise<void>} resolves once the worker exited.
     */
    terminate() {
        if (this.exitPromise !== null) return this.exitPromise;
        this.exitPromise = new Promise((resolve) => {
            this.worker.once('exit', () => resolve());
            this.worker.terminate().catch(() => {
                resolve();
            });
        });
        return this.exitPromise;
    }
}

/**
 * Rebuilds an error the worker sent as a plain object, restoring the
 * SQLite diagnostics structured clone drops.
 *
 * @param {{ name?: string, message?: string, stack?: string,
 *     code?: string, errno?: number, primaryCode?: string }} raw the
 *   serialized error.
 * @returns {Error} the rebuilt error.
 * @private
 */
function deserializeError(raw) {
    const err = new QueryError(
        typeof raw?.message === 'string' ? raw.message : String(raw),
    );
    if (typeof raw?.name === 'string') err.name = raw.name;
    if (typeof raw?.stack === 'string') err.stack = raw.stack;
    if (raw?.code !== undefined) err.code = raw.code;
    if (raw?.errno !== undefined) err.errno = raw.errno;
    if (raw?.primaryCode !== undefined) err.primaryCode = raw.primaryCode;
    return err;
}

/**
 * Splits a pool query's arguments into sql, params and signal, with the
 * same trailing-`{ signal }` rule the single-connection API uses (a
 * plain object whose only key is `signal` is options; named bind
 * parameters carry a `$`/`:`/`@` prefix and cannot collide).
 *
 * @param {unknown[]} args the call arguments.
 * @param {string} who the calling method, for error messages.
 * @returns {{ sql: string, params: import('./native.js').BindParams | undefined,
 *     signal: AbortSignal | undefined }} the split arguments.
 * @throws {TypeError} when the SQL or arguments are malformed.
 * @private
 */
function splitQueryArgs(args, who) {
    let signal;
    let rest = args;
    const last = args.at(-1);
    if (isSignalOptions(last)) {
        signal = /** @type {{ signal?: AbortSignal }} */ (last).signal;
        rest = args.slice(0, -1);
    }
    if (signal !== undefined) {
        if (
            signal === null ||
            typeof (/** @type {AbortSignal} */ (signal).addEventListener) !==
                'function'
        ) {
            throw new TypeError(`${who} signal must be an AbortSignal`);
        }
    }
    const sql = rest[0];
    if (typeof sql !== 'string' || sql.length === 0) {
        throw new TypeError(`${who} requires a non-empty SQL string`);
    }
    /** @type {import('./native.js').BindParams | undefined} */
    let params;
    if (rest.length > 1) {
        if (rest.length > 2) {
            throw new TypeError(`${who} takes (sql, params?, { signal }?)`);
        }
        params = /** @type {import('./native.js').BindParams} */ (rest[1]);
        const p = rest[1];
        if (
            p !== undefined &&
            p !== null &&
            (typeof p !== 'object' || typeof p === 'function')
        ) {
            throw new TypeError(
                `${who} bind parameters must be an array or a ` +
                    'named-parameter object; wrap a single value in an array',
            );
        }
    }
    return { sql, params, signal };
}

/**
 * A trailing `{ signal }` options object, the same rule
 * lib/promises.js applies.
 *
 * @param {unknown} value the candidate.
 * @returns {boolean} whether value is an options object.
 * @private
 */
function isSignalOptions(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (
        Object.hasOwn(
            /** @type {Record<string, unknown>} */ (value),
            'signal',
        ) &&
        Object.keys(/** @type {Record<string, unknown>} */ (value)).every(
            (key) => key === 'signal',
        )
    );
}

/**
 * Validates the pool options.
 *
 * @param {unknown} options the raw options.
 * @returns {{ readers: number, walMode: boolean, busyTimeout: number,
 *     integerMode: ('number' | 'bigint' | 'mixed') | undefined }} the
 *   validated options.
 * @throws {TypeError} on an unknown key or a malformed value.
 * @private
 */
function parsePoolOptions(options) {
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('pool() options must be an object');
        }
        const known = new Set([
            'readers',
            'walMode',
            'busyTimeout',
            'integerMode',
        ]);
        for (const key of Object.keys(options)) {
            if (!known.has(key)) {
                throw new TypeError(`pool() received unknown option '${key}'`);
            }
        }
    }
    const opts = /** @type {Record<string, unknown>} */ (options ?? {});
    const readers = typeof opts.readers === 'number' ? opts.readers : 4;
    if (
        typeof readers !== 'number' ||
        !Number.isInteger(readers) ||
        readers < 0
    ) {
        throw new TypeError(
            "pool() option 'readers' must be a non-negative integer",
        );
    }
    const walMode = opts.walMode !== false;
    if (typeof walMode !== 'boolean') {
        throw new TypeError("pool() option 'walMode' must be a boolean");
    }
    const busyTimeout =
        typeof opts.busyTimeout === 'number' ? opts.busyTimeout : 5000;
    if (
        typeof busyTimeout !== 'number' ||
        !Number.isInteger(busyTimeout) ||
        busyTimeout < 0
    ) {
        throw new TypeError(
            "pool() option 'busyTimeout' must be a non-negative integer",
        );
    }
    const integerModeRaw =
        typeof opts.integerMode === 'string' ? opts.integerMode : undefined;
    /** @type {('number' | 'bigint' | 'mixed') | undefined} */
    let integerMode;
    if (
        integerModeRaw === 'number' ||
        integerModeRaw === 'bigint' ||
        integerModeRaw === 'mixed'
    ) {
        integerMode = integerModeRaw;
    }
    if (
        integerMode !== undefined &&
        !['number', 'bigint', 'mixed'].includes(integerMode)
    ) {
        throw new TypeError(
            "pool() option 'integerMode' must be 'number', 'bigint' or 'mixed'",
        );
    }
    return { readers, walMode, busyTimeout, integerMode };
}

/**
 * Creates a worker-thread pool over a database file: one writer
 * connection plus `options.readers` read-only connections (default 4),
 * each on its own worker. Writes serialize on the writer; reads fan out
 * to the readers. All SQLite work happens off the calling thread.
 *
 * Requires a real file (or a `file:` URI): each connection is separate,
 * so a plain `:memory:` database cannot be shared across the pool's
 * workers — move in-memory data with `db.serializeToBytes()` +
 * {@link sqlite3.deserializeFromBytes} in a worker instead (see
 * docs/concurrency.md). With `readers: 0` a `:memory:` pool is fine:
 * everything runs on the single writer.
 *
 * @param {string} filename the database file.
 * @param {PoolOptions} [options] the pool options.
 * @returns {Promise<SqlitePool>} the opened pool.
 * @throws {TypeError} when the filename is missing or malformed, or an
 *   option is unknown/invalid.
 * @since 9.0.0
 * @example
 * const pool = await sqlite3.pool('app.db', {
 *     readers: 4,
 *     busyTimeout: 5000,
 * });
 * const rows = await pool.read('SELECT * FROM t WHERE a = ?', [1]);
 * await pool.write('INSERT INTO t (a) VALUES (?)', [2]);
 * await pool.close();
 */
async function pool(filename, options) {
    if (typeof filename !== 'string' || filename.length === 0) {
        throw new TypeError('pool() requires a non-empty filename string');
    }
    const opts = parsePoolOptions(options);
    if (opts.readers > 0 && (filename === ':memory:' || filename === '')) {
        throw new TypeError(
            `pool() cannot open ${filename === '' ? "''" : "':memory:'"} ` +
                'with readers: every pool connection is a separate ' +
                'database, and an in-memory one cannot be shared across ' +
                'workers — use readers: 0, or move the data with ' +
                'serializeToBytes()/deserializeFromBytes()',
        );
    }
    return SqlitePool.create(filename, opts);
}

export { pool, SqlitePool };
