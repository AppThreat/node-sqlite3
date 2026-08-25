// The JS half of the driver. The native binding (lib/sqlite3-binding.js)
// provides the Database/Statement/Backup classes and the constants; this
// file adds the callback conveniences around them — the statement cache,
// Database#run/get/all/each/map on top of Statement, backup creation,
// trace/profile/change event wiring — and then installs the promise API
// from lib/promises.js over the finished surface.
//
// Types come from lib/native.d.ts (the native layer's shape); everything
// this file adds to the public surface is declared in lib/augment.d.ts
// and emitted into the generated lib/sqlite3.d.ts.

import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
    associateStatement,
    installPromiseApi,
    retracePromiseApi,
} from './promises.js';
import binding from './sqlite3-binding.js';
import { extendTrace } from './trace.js';

/**
 * A native class (Database, Statement or Backup) before the EventEmitter
 * prototype is copied onto it.
 *
 * @typedef {new (...args: never[]) => object} NativeClass
 */

/**
 * `sqlite3.cached` — a registry of connections shared by resolved
 * database path. Special filenames (`''`, `':memory:'`) are never
 * cached; a second call with the same path returns the open connection
 * and still fires the callback once it is ready.
 *
 * @typedef {object} CachedRegistry
 * @property {(filename: string, callback?: (this: import('./sqlite3-binding.js').Database, err: Error | null) => void) => import('./sqlite3-binding.js').Database} Database Open (or reuse) a connection, optionally with a callback.
 * @property {Record<string, import('./sqlite3-binding.js').Database>} objects The registry itself, keyed by resolved path.
 */

/**
 * The public `sqlite3` namespace object the package exports as its
 * default: the native binding (the three classes and every SQLite
 * constant with its literal value) plus the JS-layer `verbose`,
 * `cached` and `open`.
 *
 * @typedef {import('./sqlite3-binding.js').NativeBinding & {
 *   verbose: () => sqlite3,
 *   cached: CachedRegistry,
 *   open: import('./promises.js').OpenFunction,
 * }} sqlite3
 */

const sqlite3 = /** @type {sqlite3} */ (/** @type {unknown} */ (binding));

const { Database, Statement, Backup } = sqlite3;

/**
 * Copies `source`'s prototype onto `target`, giving the native classes
 * EventEmitter behaviour without a runtime class hierarchy.
 *
 * @param {NativeClass} target the native class to extend.
 * @param {NativeClass} source the class whose prototype is copied.
 * @returns {void}
 * @private
 */
function inherits(target, source) {
    Object.assign(target.prototype, source.prototype);
}

inherits(Database, EventEmitter);
inherits(Statement, EventEmitter);
inherits(Backup, EventEmitter);

/**
 * Pops a trailing error-first callback off `args`, wrapped so it is
 * only invoked for a truthy error — the `err === null` success call is
 * the caller's business, not the extractErrBack user's.
 *
 * @param {unknown[]} args the call arguments.
 * @returns {((err: import('./native.js').SqliteError | null) => void) | undefined} the wrapped callback, or undefined.
 * @private
 */
function extractErrBack(args) {
    const last = args[args.length - 1];
    if (args.length > 0 && typeof last === 'function') {
        const callback =
            /** @type {(err: import('./native.js').SqliteError) => void} */ (
                last
            );
        /**
         * @param {import('./native.js').SqliteError | null} err
         */
        function rethrow(err) {
            if (err) callback(err);
        }
        return rethrow;
    }
    return undefined;
}

// Captured before the promise API wraps Statement#bind: prepare()'s
// no-callback form must keep returning the statement synchronously, and a
// dual-mode bind would hand back a promise instead.
/** @type {(...args: any[]) => any} */
const nativeStatementBind = Statement.prototype.bind;
// Internal fire-and-forget finalizes must not allocate a promise per call:
// they sit on the hot path of every uncached run/get/all/each/map.
/** @type {(...args: any[]) => any} */
const nativeStatementFinalize = Statement.prototype.finalize;

// Database#prepare stays uncached: the caller owns the returned statement.
// It also keeps its synchronous return in every form (see the promise API
// notes in lib/promises.js): `await db.prepare(sql)` still yields the
// statement, but a prepare error surfaces on its error event rather than
// as a rejection.
/**
 * Prepares a statement for the caller to own.
 *
 * Always returns the statement synchronously, even in the callback form
 * (`await db.prepare(sql)` yields the statement): a prepare failure
 * surfaces on the statement's `'error'` event instead of a rejection, and
 * a bind failure throws synchronously after finalizing the orphan.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL statement to prepare.
 * @param {...unknown} args bind parameters, then optionally a callback.
 * @returns {import('./sqlite3-binding.js').Statement} the prepared statement.
 */
Database.prototype.prepare = function (sql, ...args) {
    const statement = new Statement(this, sql, extractErrBack(args));
    associateStatement(this, statement);
    if (!args.length) return statement;
    try {
        const bindVariadic =
            /** @type {(...args: unknown[]) => import('./sqlite3-binding.js').Statement} */ (
                /** @type {unknown} */ (nativeStatementBind)
            );
        return bindVariadic.apply(statement, args);
    } catch (err) {
        // Bind TypeErrors leave the freshly prepared statement orphaned;
        // finalize it so close() cannot end up with SQLITE_BUSY.
        nativeStatementFinalize.call(statement);
        throw err;
    }
};

// run/get/all/each/map reuse prepared statements when the caller enabled
// the cache with cacheStatements(). Under serialize() the cached path is
// bypassed: statement operations do not pass through the database queue,
// so strict FIFO ordering would be lost.

/**
 * The inner body of a cached Database method: run the work against a
 * (possibly cached) statement and finalize it unless it stays cached.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {import('./sqlite3-binding.js').Statement} statement the statement to drive.
 * @param {unknown[]} params the caller's arguments after the SQL.
 * @param {boolean} cached whether the statement came from the cache.
 * @returns {unknown} whatever the method returns.
 * @private
 */
// Database#run(sql, [bind1, bind2, ...], [callback])
Database.prototype.run = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.run)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

// Database#get(sql, [bind1, bind2, ...], [callback])
Database.prototype.get = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.get)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

// Database#all(sql, [bind1, bind2, ...], [callback])
Database.prototype.all = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.all)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

// Database#each(sql, [bind1, bind2, ...], [callback], [complete])
Database.prototype.each = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.each)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

Database.prototype.map = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.map)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

/**
 * Builds a Database method around `fn` that resolves its SQL to a
 * statement — from the cache when one is enabled, otherwise a fresh
 * (and afterwards finalized) one.
 *
 * A cache hit skips the prepare, and statement operations never pass
 * through the database queue — so while an exclusive operation
 * (exec/close/wait/loadExtension) is running or waiting, the cached
 * path would overtake it and run concurrently with it. It falls back to
 * the uncached path there: its prepare goes through Database::Schedule
 * and lands in the queue behind that operation.
 *
 * @param {(statement: import('./sqlite3-binding.js').Statement, params: unknown[], cached: boolean) => unknown} fn the method body.
 * @returns {(this: import('./sqlite3-binding.js').Database, sql: string, ...args: any[]) => any} the assembled method.
 * @private
 */
function cachedMethod(fn) {
    return function (sql, ...args) {
        const errBack = extractErrBack(args);

        const cache = this._stmtCache;
        // Native state, read per field: while serialized, closing, or with
        // anything queued/in flight on the database queue, the cached
        // path would overtake that work (statement operations bypass
        // Database::Schedule), so fall back to the uncached path whose
        // prepare lands in the queue behind it. db.state is the same
        // information as one frozen object, but constructing it per call
        // measured +46% on the sync hot path (bench, Deliverable 05).
        if (
            cache &&
            !this.serialized &&
            !this.closing &&
            this.queued === 0 &&
            !(this.locked && this.pending > 0)
        ) {
            let statement = cache.get(sql);
            if (statement !== undefined) {
                // Most recently used.
                cache.delete(sql);
                cache.set(sql, statement);
            } else {
                /**
                 * @param {import('./native.js').SqliteError | null} err
                 */
                const onPrepareError = function (err) {
                    if (!err) return;
                    // Failed to prepare: drop it so the next call retries.
                    cache.delete(sql);
                    if (errBack) errBack(err);
                    else fresh.emit('error', err);
                };
                const fresh = new Statement(this, sql, onPrepareError);
                statement = fresh;
                associateStatement(this, fresh);
                cache.set(sql, fresh);
                if (cache.size > /** @type {number} */ (this._stmtCacheMax)) {
                    const oldestSql = /** @type {string} */ (
                        /** @type {unknown} */ (cache.keys().next().value)
                    );
                    const oldest =
                        /** @type {import('./sqlite3-binding.js').Statement} */ (
                            /** @type {unknown} */ (cache.get(oldestSql))
                        );
                    cache.delete(oldestSql);
                    nativeStatementFinalize.call(oldest);
                }
            }
            /** @type {import('./sqlite3-binding.js').Statement} */
            const ready =
                /** @type {import('./sqlite3-binding.js').Statement} */ (
                    /** @type {unknown} */ (statement)
                );
            try {
                return fn.call(this, ready, args, true);
            } catch (err) {
                // A synchronous bind TypeError: the statement is cached
                // but nothing will ever drive it, so drop it rather than
                // keeping a dead entry (and a pending prepare) around.
                cache.delete(sql);
                nativeStatementFinalize.call(ready);
                throw err;
            }
        }

        const statement = new Statement(this, sql, errBack);
        associateStatement(this, statement);
        try {
            return fn.call(this, statement, args, false);
        } catch (err) {
            // Same as above, uncached shape: finalize the orphaned
            // statement so close() cannot end up with SQLITE_BUSY.
            nativeStatementFinalize.call(statement);
            throw err;
        }
    };
}

/**
 * Enables the opt-in LRU cache of prepared statements for
 * run/get/all/each/map, keyed on the SQL string.
 *
 * Defaults to 64 entries. Cached statements are finalized by close().
 * Under serialize() the cache is bypassed to preserve strict FIFO
 * ordering.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {number} [maxEntries] cache capacity; a positive integer.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 */
Database.prototype.cacheStatements = function (maxEntries) {
    if (!this._stmtCache) {
        this._stmtCache = new Map();
        this._stmtCacheMax = 64;
    }
    /** @type {Map<string, import('./sqlite3-binding.js').Statement>} */
    const cache = this._stmtCache;
    const max = Number.parseInt(
        /** @type {string} */ (/** @type {unknown} */ (maxEntries)),
        10,
    );
    if (max > 0) this._stmtCacheMax = max;
    while (cache.size > /** @type {number} */ (this._stmtCacheMax)) {
        const oldestSql = /** @type {string} */ (
            /** @type {unknown} */ (cache.keys().next().value)
        );
        const oldest = /** @type {import('./sqlite3-binding.js').Statement} */ (
            /** @type {unknown} */ (cache.get(oldestSql))
        );
        cache.delete(oldestSql);
        nativeStatementFinalize.call(oldest);
    }
    return this;
};

/**
 * Prepares synchronously on the main thread.
 *
 * Throws when the database is not fully idle. The returned statement
 * also supports the getSync/runSync/allSync fast path.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL statement to prepare.
 * @returns {import('./sqlite3-binding.js').Statement} the prepared statement.
 * @throws {Error} When the database is not fully idle.
 */
Database.prototype.prepareSync = function (sql) {
    return new Statement(this, sql, undefined, true);
};

/**
 * Executes `SELECT ... ` synchronously, consulting (and filling) the
 * statement cache when enabled.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @template T
 * @param {string} sql the query.
 * @param {...unknown} params bind parameters.
 * @returns {T | undefined} the first row, or undefined.
 * @throws {Error} When the database is not fully idle or binding fails.
 */
Database.prototype.getSync = function (sql, ...params) {
    const entry = this._statementForSync(sql);
    try {
        return /** @type {T | undefined} */ (
            /** @type {(...args: unknown[]) => unknown} */ (
                entry.statement.getSync
            )(...params)
        );
    } finally {
        if (entry.transient) nativeStatementFinalize.call(entry.statement);
    }
};

/**
 * Executes a statement synchronously; returns `{ lastID, changes }`.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the statement.
 * @param {...unknown} params bind parameters.
 * @returns {{ lastID: number, changes: number }} the run result.
 * @throws {Error} When the database is not fully idle or binding fails.
 */
Database.prototype.runSync = function (sql, ...params) {
    const entry = this._statementForSync(sql);
    try {
        /** @type {(...args: unknown[]) => unknown} */ (
            entry.statement.runSync
        )(...params);
        return {
            lastID: /** @type {number} */ (entry.statement.lastID),
            changes: /** @type {number} */ (entry.statement.changes),
        };
    } finally {
        if (entry.transient) nativeStatementFinalize.call(entry.statement);
    }
};

/**
 * Executes a query synchronously, returning every row.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the query.
 * @param {...unknown} params bind parameters.
 * @template T
 * @returns {T[]} every result row.
 * @throws {Error} When the database is not fully idle or binding fails.
 */
Database.prototype.allSync = function (sql, ...params) {
    const entry = this._statementForSync(sql);
    try {
        return /** @type {T[]} */ (
            /** @type {(...args: unknown[]) => unknown} */ (
                entry.statement.allSync
            )(...params)
        );
    } finally {
        if (entry.transient) nativeStatementFinalize.call(entry.statement);
    }
};

/**
 * Resolves `sql` to a statement for the sync methods.
 *
 * Without the cache the statement is transient and the caller must
 * finalize it: otherwise every sync call leaks a prepared statement and
 * close() fails with SQLITE_BUSY.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL to prepare or reuse.
 * @returns {{ statement: import('./sqlite3-binding.js').Statement, transient: boolean }} the statement and whether the caller must finalize it.
 * @private
 */
Database.prototype._statementForSync = function (sql) {
    const cache = this._stmtCache;
    // No closing check is needed here: a close in flight means either the
    // sync prepare throws (its gate requires a fully idle connection) or,
    // on a cache hit, the sync call itself does — and close() drains the
    // cache, so a post-close hit is impossible.
    if (cache) {
        const statement = cache.get(sql);
        if (statement !== undefined) {
            cache.delete(sql);
            cache.set(sql, statement);
            return { statement: statement, transient: false };
        }
        const fresh = new Statement(this, sql, undefined, true);
        associateStatement(this, fresh);
        cache.set(sql, fresh);
        if (cache.size > /** @type {number} */ (this._stmtCacheMax)) {
            const oldestSql = /** @type {string} */ (
                /** @type {unknown} */ (cache.keys().next().value)
            );
            const oldest =
                /** @type {import('./sqlite3-binding.js').Statement} */ (
                    /** @type {unknown} */ (cache.get(oldestSql))
                );
            cache.delete(oldestSql);
            nativeStatementFinalize.call(oldest);
        }
        return { statement: fresh, transient: false };
    }
    return {
        statement: associateStatement(
            this,
            new Statement(this, sql, undefined, true),
        ),
        transient: true,
    };
};

// Database#close flushes the statement cache first: sqlite3_close fails
// with SQLITE_BUSY while prepared statements are outstanding.
/** @type {(...args: unknown[]) => unknown} */
const nativeClose = Database.prototype.close;
/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {...any} args optionally a callback.
 * @returns {any}
 */
Database.prototype.close = function (...args) {
    const cache = this._stmtCache;
    if (cache && cache.size > 0) {
        // The drain is synchronous and the internal finalize carries no
        // user callback, so no JS can run inside it and repopulate the
        // cache behind our backs. If a cached statement is busy, its
        // finalize queues behind that work; the native close is exclusive
        // and therefore lands after it either way.
        for (const [sql, statement] of cache) {
            cache.delete(sql);
            nativeStatementFinalize.call(statement);
        }
    }
    // Deliberately not deferred. close() is scheduled exclusively and
    // Work_BeginClose requires pending == 0, so the native queue already
    // makes it wait for the finalizes above (each either completes inline
    // when its statement is idle, or queues behind that statement's
    // in-flight work). Deferring the native call to a promise instead would
    // let operations issued after close() run before the close is even
    // requested.
    return nativeClose.apply(this, args);
};

sqlite3.cached = {
    /**
     * Opens a connection, or reuses the one already open for the
     * resolved path.
     *
     * @param {string} file the database filename.
     * @param {number | ((this: import('./sqlite3-binding.js').Database, err: Error | null) => void)} [a] open mode, or the callback.
     * @param {(this: import('./sqlite3-binding.js').Database, err: Error | null) => void} [b] the callback when a mode was given.
     * @returns {import('./sqlite3-binding.js').Database} the connection.
     */
    Database: function (file, a, b) {
        /** @type {any} */
        const modeOrCallback = a;
        /** @type {any} */
        const callback = b;
        if (file === '' || file === ':memory:') {
            // Don't cache special databases.
            return new Database(file, modeOrCallback, callback);
        }

        /** @type {import('./sqlite3-binding.js').Database} */
        let db;
        file = path.resolve(file);

        if (!sqlite3.cached.objects[file]) {
            db = sqlite3.cached.objects[file] = new Database(
                file,
                modeOrCallback,
                callback,
            );
        } else {
            // Make sure the callback is called.
            db = sqlite3.cached.objects[file];
            const callback = typeof a === 'number' ? b : a;
            if (typeof callback === 'function') {
                const cb = () => callback.call(db, null);
                if (db.open) process.nextTick(cb);
                else db.once('open', cb);
            }
        }

        return db;
    },
    objects: {},
};

// Database#backup(filename, [callback])
// Database#backup(filename, destName, sourceName, filenameIsDest, [callback])
/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {...unknown} args filename and optional callback, or the full
 *   filename/source/dest/direction/callback form.
 * @returns {import('./sqlite3-binding.js').Backup} the created backup.
 */
Database.prototype.backup = function (...args) {
    /** @type {import('./sqlite3-binding.js').Backup} */
    let backup;
    if (args.length <= 2) {
        backup = new Backup(
            this,
            /** @type {string} */ (args[0]),
            'main',
            'main',
            true,
            /** @type {((err: Error | null) => void) | undefined} */ (args[1]),
        );
    } else {
        backup = new Backup(
            this,
            /** @type {string} */ (args[0]),
            /** @type {string} */ (args[1]),
            /** @type {string} */ (args[2]),
            /** @type {boolean} */ (args[3]),
            /** @type {((err: Error | null) => void) | undefined} */ (args[4]),
        );
    }
    // Per the sqlite docs, exclude the following errors as non-fatal by default.
    backup.retryErrors = [sqlite3.BUSY, sqlite3.LOCKED];
    return backup;
};

/**
 * Maps rows by their first column via `all`, then reshapes the result.
 *
 * With two columns the value is the second column; with any other count
 * (including a single column) the value is the whole row — the
 * single-column case used to yield `undefined` for every entry
 * (REVIEW-LOG, D03).
 *
 * @this {import('./sqlite3-binding.js').Statement}
 * @param {...any} params bind parameters, then the callback.
 * @returns {any} this statement in callback mode, a promise otherwise.
 */
Statement.prototype.map = function (...params) {
    const popped = params.pop();
    const callback =
        /** @type {(err: Error | null, map?: Record<string, unknown>) => void} */ (
            /** @type {unknown} */ (popped)
        );
    /**
     * @param {Error | null} err
     * @param {Record<string, unknown>[] | null} rows
     */
    const reshape = (err, rows) => {
        // An error means there are no rows to reshape: hand the caller the
        // error alone, exactly as the callback-mode contract has always
        // done (a second argument here would be a fake empty result).
        if (err) return callback(err, undefined);
        /** @type {Record<string, unknown>} */
        const result = {};
        if (rows?.length) {
            const keys = Object.keys(rows[0]);
            const key = keys[0];
            if (keys.length > 2) {
                // Value is an object
                for (let i = 0; i < rows.length; i++) {
                    result[/** @type {string} */ (rows[i][key])] = rows[i];
                }
            } else if (keys.length === 2) {
                const value = keys[1];
                // Value is a plain value
                for (let i = 0; i < rows.length; i++) {
                    result[/** @type {string} */ (rows[i][key])] =
                        rows[i][value];
                }
            } else {
                // Single column: the key column is the only data there is,
                // so the value is the whole row (same rule as >2). Used to
                // return `undefined` for every entry (REVIEW-LOG, D03).
                for (let i = 0; i < rows.length; i++) {
                    result[/** @type {string} */ (rows[i][key])] = rows[i];
                }
            }
        }
        callback(err, result);
    };
    params.push(reshape);
    return /** @type {(...args: any[]) => any} */ (this.all)(...params);
};

let isVerbose = false;

const supportedEvents = new Set(['trace', 'profile', 'change']);

/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} type
 * @param {...any} args
 * @returns {any}
 */
Database.prototype.addListener = Database.prototype.on = function (
    type,
    ...args
) {
    const val = /** @type {(...callArgs: any[]) => any} */ (
        EventEmitter.prototype.addListener
    ).call(this, type, ...args);
    if (supportedEvents.has(type)) {
        this.configure(
            /** @type {'trace' | 'profile' | 'change'} */ (type),
            true,
        );
    }
    return val;
};

/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} type
 * @param {...any} args
 * @returns {any}
 */
Database.prototype.removeListener = function (type, ...args) {
    const val = /** @type {(...callArgs: any[]) => any} */ (
        EventEmitter.prototype.removeListener
    ).call(this, type, ...args);
    if (supportedEvents.has(type) && !this.listenerCount(type)) {
        this.configure(
            /** @type {'trace' | 'profile' | 'change'} */ (type),
            false,
        );
    }
    return val;
};

/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} type
 * @param {...any} args
 * @returns {any}
 */
Database.prototype.removeAllListeners = function (type, ...args) {
    const val = /** @type {(...callArgs: any[]) => any} */ (
        EventEmitter.prototype.removeAllListeners
    ).call(this, type, ...args);
    if (supportedEvents.has(type)) {
        this.configure(
            /** @type {'trace' | 'profile' | 'change'} */ (type),
            false,
        );
    }
    return val;
};

/**
 * Enables long stack traces for every method: errors delivered to
 * callbacks (and promise rejections) carry the call site's stack,
 * filtered of driver frames.
 *
 * Irreversible for the process — once on, always on — and global: it
 * wraps the method cores, so every connection created afterwards is
 * traced too.
 *
 * @returns {sqlite3} the same namespace, for chaining.
 */
sqlite3.verbose = function () {
    if (!isVerbose) {
        // Dual-mode methods are traced at their callback cores and the
        // promise wrappers are then rebuilt around the traced cores, so a
        // promise rejection carries the same augmented stack as a callback
        // error. (Wrapping the dual-mode wrapper itself would see no
        // trailing function in promise mode and capture nothing.)
        retracePromiseApi(extendTrace);

        // prepare keeps its synchronous, non-dual contract; trace it on the
        // prototype as before.
        extendTrace(
            /** @type {Record<string, import('./trace.js').Traceable>} */ (
                /** @type {unknown} */ (Database.prototype)
            ),
            'prepare',
        );

        isVerbose = true;
    }
    return sqlite3;
};

// Promise API, async iteration, transactions and disposal — installed after
// every callback-mode method above is final.
installPromiseApi(sqlite3);

export default sqlite3;
export { Backup, Database, Statement } from './sqlite3-binding.js';
