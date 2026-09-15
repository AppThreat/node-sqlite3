// The node:sqlite compatibility shim (Phase 5):
// `import { DatabaseSync } from '@appthreat/sqlite3/compat'`.
//
// A zero-dependency drop-in for code written against Node's built-in
// node:sqlite that outgrew it — when the connection is idle the mapped
// calls run on this package's synchronous fast path (parity with
// node:sqlite's speed), and the moment the application needs pools,
// sessions, streaming or cancellation it can reach through `db.native`
// for the full async surface without changing databases.
//
// What maps 1:1: open/close/isOpen/isTransaction, exec (synchronous
// multi-statement scripts), prepare + StatementSync get/all/run/iterate/
// columns/sourceSQL/expandedSQL, function/aggregate (the Phase 2
// re-entrant UDFs make these genuinely synchronous), loadExtension/
// enableLoadExtension, enableDefensive, location, prepare options
// (readBigInts, returnArrays, allowBareNamedParameters,
// allowUnknownNamedParameters, persistent — accepted, some as no-ops).
//
// Documented divergences (loud, not silent):
//  - setAuthorizer() throws: this package's authorizer is a declarative
//    C++ rule list by design (no JavaScript on the prepare path); reach
//    through `db.native.authorizer(policy)` for the supported form.
//  - createSession()/applyChangeset() keep this package's async
//    signatures (they return promises) — node:sqlite's sync ones have no
//    equivalent on the sync fast path.
//  - serialize() returns the bytes asynchronously.
//  - StatementSync.close() finalizes asynchronously under the hood; the
//    statement is unusable immediately after. DatabaseSync.close() is the
//    same shape: it finalizes the statements prepared through it (as
//    node:sqlite does) and starts the close — the connection is unusable
//    at once, the handle is released on the queue. Use `await db[Symbol.
//    asyncDispose]()`, or `await db.native.close()`, when the close must
//    have completed (deleting the file, reopening it on Windows). A close
//    that fails anyway — a statement prepared directly on `db.native`
//    holds the connection — is reported on the connection's 'error'
//    event, never discarded.
//  - StatementSync.iterate() materialises the rows before yielding: the
//    sync fast path has no mid-cursor suspension. Use
//    `db.native.iterate()` for a true streaming cursor.
//  - setReadBigInts() after prepare() applies to lastInsertRowid;
//    integer *columns* are read in the mode fixed at prepare time, so
//    pass `{ readBigInts: true }` to prepare() (or re-prepare) to change
//    how rows are read.

import sqlite3 from './sqlite3.js';

/**
 * Splits one SQL script into complete statements, using sqlite3_complete
 * (via the binding's `complete()`) to find statement boundaries — quotes,
// comments and trigger bodies included. The trailing remainder (an
 * incomplete final statement) is kept and will fail loudly on run.
 *
 * @param {string} sql the script.
 * @returns {string[]} the complete statements.
 * @private
 */
function splitScript(sql) {
    /** @type {string[]} */
    const statements = [];
    let current = '';
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        current += ch;
        i++;
        if (ch === ';') {
            const candidate = current.trim();
            if (candidate.length > 0 && sqlite3.complete(candidate)) {
                statements.push(candidate);
                current = '';
            }
        }
    }
    const rest = current.trim();
    if (rest.length > 0) {
        // An unterminated tail: run it through complete() to fail with
        // sqlite's own message rather than dropping it silently.
        statements.push(rest);
    }
    return statements;
}

/**
 * A prepared statement in the node:sqlite shape, wrapping this package's
 * synchronous fast path.
 *
 * @since 9.1.0
 */
class StatementSync {
    /** @type {import('./sqlite3-binding.js').Statement} */
    #stmt;
    #readBigInts;
    #returnArrays;
    /** @type {(mode: 'number' | 'bigint') => import('./sqlite3-binding.js').Statement} */
    #reprepare;
    /** @type {(stmt: StatementSync) => void} */
    #onClose;

    /**
     * @param {import('./sqlite3-binding.js').Statement} stmt the wrapped statement.
     * @param {{ readBigInts?: boolean, returnArrays?: boolean }} options
     * @param {(mode: 'number' | 'bigint') => import('./sqlite3-binding.js').Statement} [reprepare]
     *   re-prepares the same SQL under another integer mode, for
     *   setReadBigInts (the mode belongs to the prepared statement).
     * @param {(stmt: StatementSync) => void} [onClose] tells the owning
     *   connection this statement no longer needs finalizing at close.
     */
    constructor(stmt, options, reprepare, onClose) {
        this.#stmt = stmt;
        this.#readBigInts = options?.readBigInts === true;
        this.#returnArrays = options?.returnArrays === true;
        this.#reprepare =
            reprepare ??
            (() => {
                throw new Error(
                    'setReadBigInts() cannot re-prepare this statement',
                );
            });
        this.#onClose =
            onClose ??
            (() => {
                // Unowned statement: nobody is tracking it for close.
            });
    }

    /**
     * True once finalized (explicitly or through dispose).
     *
     * @returns {boolean} finalized.
     */
    get finalized() {
        return this.#stmt.finalized;
    }

    /**
     * The statement's SQL text.
     *
     * @returns {string} the SQL.
     */
    get sourceSQL() {
        return /** @type {string} */ (this.#stmt.sql);
    }

    /**
     * The SQL with the most recent bound values substituted.
     *
     * @returns {string} the expanded SQL.
     */
    get expandedSQL() {
        return /** @type {string} */ (this.#stmt.expandedSQL);
    }

    /**
     * The statement's result columns.
     *
     * @returns {{ name: string, database?: string, table?: string, column?: string, type?: string }[]}
     *   the column descriptors.
     */
    columns() {
        // node:sqlite names the origin column `column`; this package's
        // native accessor calls it `origin`.
        const native = /** @type {any[]} */ (this.#stmt.columns) ?? [];
        return native.map(({ origin, ...rest }) =>
            origin === undefined ? rest : { ...rest, column: origin },
        );
    }

    /**
     * The bind arguments for one call: node:sqlite re-executes a
     * statement called again with no parameters (this package's statement
     * cursor semantics otherwise continue), so an explicit empty bind
     * forces the reset.
     *
     * @param {unknown[]} params
     * @returns {unknown[]}
     */
    #bindArgs(params) {
        // Only a zero-parameter statement can be safely re-executed with
        // an explicit empty bind (which forces the reset); a parameterful
        // statement called without arguments keeps this package's
        // re-bind-with-last-values semantics.
        if (params.length === 0 && this.#stmt.parameterCount === 0) {
            return [[]];
        }
        return params;
    }

    /**
     * @param {unknown[]} params
     * @returns {unknown[]}
     */
    #rowModeOption(params) {
        return this.#returnArrays ? [...params, { rowMode: 'array' }] : params;
    }

    /**
     * Steps once and returns the first row (or undefined).
     *
     * @param {...unknown} params bind parameters.
     * @returns {any} the row.
     */
    get(...params) {
        return this.#stmt.getSync(
            ...this.#rowModeOption(this.#bindArgs(params)),
        );
    }

    /**
     * Steps to completion and returns every row.
     *
     * @param {...unknown} params bind parameters.
     * @returns {any[]} the rows.
     */
    all(...params) {
        return this.#stmt.allSync(
            ...this.#rowModeOption(this.#bindArgs(params)),
        );
    }

    /**
     * Runs the statement, returning `{ changes, lastInsertRowid }`.
     *
     * @param {...unknown} params bind parameters.
     * @returns {{ changes: number | bigint, lastInsertRowid: number | bigint }} the run result.
     */
    run(...params) {
        this.#stmt.runSync(...this.#bindArgs(params));
        return {
            changes: this.#stmt.changes,
            lastInsertRowid: this.#readBigInts
                ? this.#stmt.lastIDBigInt
                : this.#stmt.lastID,
        };
    }

    /**
     * A synchronous iterator over the rows. Divergence: the rows are
     * materialised first (the sync fast path has no mid-cursor
     * suspension), so this costs the memory of the whole result — reach
     * for `db.native.iterate()` when that matters.
     *
     * @param {...unknown} params bind parameters.
     * @returns {IterableIterator<any>} the rows.
     */
    *iterate(...params) {
        yield* this.all(...params);
    }

    /**
     * Sets whether integers read as BigInt (node:sqlite's toggle). The
     * integer mode belongs to the prepared statement here, so this
     * re-prepares the same SQL under the new mode — column values follow
     * the setting, as they do in node:sqlite, rather than only
     * `lastInsertRowid`.
     *
     * @param {boolean} value the new setting.
     * @returns {void}
     */
    setReadBigInts(value) {
        const next = value === true;
        if (next === this.#readBigInts) return;
        const replacement = this.#reprepare(next ? 'bigint' : 'number');
        const previous = this.#stmt;
        this.#stmt = replacement;
        this.#readBigInts = next;
        if (!previous.finalized) {
            previous.finalize(function () {
                /* best effort: the replacement is live */
            });
        }
    }

    /**
     * Sets whether rows are arrays (node:sqlite's toggle).
     *
     * @param {boolean} value the new setting.
     * @returns {void}
     */
    setReturnArrays(value) {
        this.#returnArrays = value === true;
    }

    /**
     * Finalizes the statement. Accepted for shape parity; the underlying
     * finalize is asynchronous (queued), and the statement is unusable
     * immediately.
     *
     * @returns {void}
     */
    close() {
        if (!this.#stmt.finalized) {
            this.#stmt.finalize(function () {
                /* best effort */
            });
        }
        this.#onClose(this);
    }

    /**
     * `using` support.
     *
     * @returns {void}
     */
    [Symbol.dispose]() {
        this.close();
    }
}

/**
 * A connection in the node:sqlite `DatabaseSync` shape, mapping onto this
 * package's synchronous fast path.
 *
 * @since 9.1.0
 * @example
 * import { DatabaseSync } from '@appthreat/sqlite3/compat';
 * const db = new DatabaseSync(':memory:');
 * db.exec('CREATE TABLE t (a)');
 * const stmt = db.prepare('SELECT * FROM t WHERE a = ?');
 * const row = stmt.get(1);
 * db.close();
 */
class DatabaseSync {
    /** @type {import('./sqlite3-binding.js').Database} */
    #db;
    #allowExtension = false;
    // Statements prepared through this connection and not yet closed.
    // node:sqlite finalizes outstanding statements when the database
    // closes, and code written against it relies on that: this package's
    // close() instead fails with SQLITE_BUSY ("unable to close due to
    // unfinalized statements") while one is live, so without this the
    // connection would simply never close. Weakly held, because a
    // statement nobody kept a reference to is finalized by GC on its own
    // and pinning it here would be the leak the tracking is meant to
    // avoid.
    /** @type {Set<WeakRef<StatementSync>>} */
    #statements = new Set();
    /** @type {FinalizationRegistry<WeakRef<StatementSync>>} */
    #collected = new FinalizationRegistry((ref) => {
        this.#statements.delete(ref);
    });

    /**
     * Opens a connection. Options map onto this package's opens and
     * configure() calls: `readOnly`, `open` (default true),
     * `enableForeignKeyConstraints` (default true, node:sqlite's own
     * default), `enableDoubleQuotedStringLiterals` (refused: this
     * package keeps strict SQL), `allowExtension`, `timeout`.
     *
     * @param {string} location the database filename or `:memory:`.
     * @param {{ readOnly?: boolean, open?: boolean, enableForeignKeyConstraints?: boolean, allowExtension?: boolean, timeout?: number }} [options]
     */
    constructor(location, options = {}) {
        const known = new Set([
            'readOnly',
            'open',
            'enableForeignKeyConstraints',
            'enableDoubleQuotedStringLiterals',
            'allowExtension',
            'timeout',
        ]);
        for (const key of Object.keys(options)) {
            if (!known.has(key)) {
                throw new TypeError(
                    `DatabaseSync received unknown option '${key}'`,
                );
            }
        }
        if (options.open === false) {
            throw new TypeError(
                "DatabaseSync option 'open: false' has no equivalent; " +
                    'open the connection when ready instead',
            );
        }
        if (options.enableDoubleQuotedStringLiterals === true) {
            throw new TypeError(
                'DatabaseSync cannot enable double-quoted string ' +
                    'literals: this package deliberately keeps strict SQL',
            );
        }
        const mode =
            options.readOnly === true
                ? sqlite3.OPEN_READONLY
                : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
        // syncOpen: the native synchronous open (node:sqlite's semantics —
        // the connection is usable the moment the constructor returns).
        this.#db = new sqlite3.Database(location, { mode, syncOpen: true });
        if (options.timeout !== undefined) {
            this.#db.configure('busyTimeout', options.timeout);
        }
        this.#allowExtension = options.allowExtension === true;
        if (options.enableForeignKeyConstraints !== false) {
            this.#db.runSync('PRAGMA foreign_keys = ON');
        }
    }

    /**
     * The underlying connection, for reaching the full async surface
     * (pools, sessions, streaming, cancellation) without a second open.
     *
     * @returns {import('./sqlite3-binding.js').Database} the connection.
     */
    get native() {
        return this.#db;
    }

    /**
     * True while open.
     *
     * @returns {boolean} open.
     */
    get open() {
        return this.#db.open;
    }

    /**
     * Alias of {@link DatabaseSync.open} (node:sqlite's name).
     *
     * @returns {boolean} open.
     */
    get isOpen() {
        return this.#db.open;
    }

    /**
     * True inside an explicit transaction.
     *
     * @returns {boolean} in transaction.
     */
    get isTransaction() {
        return this.#db.inTransaction;
    }

    /**
     * Runs a SQL script (possibly several statements) synchronously.
     * Returns undefined, like node:sqlite's exec.
     *
     * @param {string} sql the script.
     * @returns {undefined}
     */
    exec(sql) {
        if (typeof sql !== 'string') {
            throw new TypeError('exec() requires a SQL string');
        }
        for (const statement of splitScript(sql)) {
            this.#db.runSync(statement);
        }
        return undefined;
    }

    /**
     * Prepares a statement synchronously.
     *
     * @param {string} sql the SQL.
     * @param {{ readBigInts?: boolean, returnArrays?: boolean, allowBareNamedParameters?: boolean, allowUnknownNamedParameters?: boolean, persistent?: boolean }} [options]
     *   `readBigInts`/`returnArrays` map onto this package's per-call
     *   row shapes; the remaining options are accepted for shape parity
     *   (bare named parameters are always allowed here, unknown named
     *   parameters always refused — this package's strictness).
     * @returns {StatementSync} the statement.
     */
    prepare(sql, options = {}) {
        const known = new Set([
            'readBigInts',
            'returnArrays',
            'allowBareNamedParameters',
            'allowUnknownNamedParameters',
            'persistent',
        ]);
        for (const key of Object.keys(options)) {
            if (!known.has(key)) {
                throw new TypeError(
                    `prepare() received unknown option '${key}'`,
                );
            }
        }
        /** @param {'number' | 'bigint'} [mode] */
        const prepare = (mode) =>
            this.#db.prepareSync(sql, { integerMode: mode });
        const stmt = prepare(
            options.readBigInts === true ? 'bigint' : undefined,
        );
        /** @type {StatementSync} */
        const wrapper = new StatementSync(stmt, options, prepare, (closed) =>
            this.#forget(closed),
        );
        const ref = new WeakRef(wrapper);
        this.#statements.add(ref);
        this.#collected.register(wrapper, ref, wrapper);
        return wrapper;
    }

    /**
     * Drops a statement from the close-time finalize list.
     *
     * @param {StatementSync} stmt the statement that closed itself.
     * @returns {void}
     */
    #forget(stmt) {
        this.#collected.unregister(stmt);
        for (const ref of this.#statements) {
            const live = ref.deref();
            if (live === undefined || live === stmt)
                this.#statements.delete(ref);
        }
    }

    /**
     * Finalizes every statement still open on this connection, so that
     * the close below is not refused with SQLITE_BUSY.
     *
     * @returns {void}
     */
    #finalizeStatements() {
        for (const ref of this.#statements) {
            const stmt = ref.deref();
            if (stmt !== undefined && !stmt.finalized) {
                // One statement refusing to finalize must not strand the
                // rest — or the close.
                try {
                    stmt.close();
                } catch {
                    /* keep going; close() reports what it cannot do */
                }
            }
        }
        this.#statements.clear();
    }

    /**
     * Registers a scalar SQL function (synchronous, via the re-entrant
     * direct-call path).
     *
     * @param {string} name the SQL name.
     * @param {((...args: unknown[]) => unknown) | { deterministic?: boolean, directOnly?: boolean, varargs?: boolean }} [options]
     *   the options object, or the implementation directly.
     * @param {(...args: unknown[]) => unknown} [fn] the implementation.
     * @returns {void}
     */
    function(name, options, fn) {
        /** @type {any} */ (this.#db).function(name, options, fn);
    }

    /**
     * Registers an aggregate (or window, with `inverse`) SQL function.
     *
     * @param {string} name the SQL name.
     * @param {{ start: () => unknown, step: (acc: unknown, ...args: unknown[]) => unknown, result: (acc: unknown) => unknown, inverse?: (acc: unknown, ...args: unknown[]) => unknown, deterministic?: boolean, varargs?: boolean }} spec
     *   the implementation.
     * @returns {void}
     */
    aggregate(name, spec) {
        /** @type {any} */ (this.#db).aggregate(name, spec);
    }

    /**
     * Loads a SQLite extension.
     *
     * @param {string} path the extension file.
     * @param {string} [entryPoint] the optional entry point.
     * @returns {void}
     */
    loadExtension(path, entryPoint) {
        if (!this.#allowExtension) {
            throw new Error(
                'DatabaseSync.loadExtension() requires allowExtension: ' +
                    'true at construction (node:sqlite has the same gate)',
            );
        }
        if (entryPoint !== undefined) {
            throw new TypeError(
                'loadExtension entryPoint is not supported; the extension ' +
                    'must use its default entry point',
            );
        }
        this.#db.loadExtension(path, function () {
            /* sync-shaped: completes on the queue */
        });
    }

    /**
     * No-op gate (the allowExtension constructor option is the real
     * gate), kept for node:sqlite's shape.
     *
     * @param {boolean} allow the new setting.
     * @returns {void}
     */
    enableLoadExtension(allow) {
        this.#allowExtension = allow === true;
    }

    /**
     * Toggles SQLite defensive mode.
     *
     * @param {boolean} active the new state.
     * @returns {void}
     */
    enableDefensive(active) {
        this.#db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE, active === true);
    }

    /**
     * The filesystem path of an attached database, or null for an
     * in-memory or temporary one (node:sqlite's shape; this package's own
     * `location()` returns the empty string there).
     *
     * @param {string} [dbName] the attached name.
     * @returns {string | null} the path.
     */
    location(dbName) {
        const path = this.#db.location(dbName);
        return path === '' ? null : path;
    }

    /**
     * Not available: this package's authorizer is declarative (a C++ rule
     * list — no JavaScript runs on the prepare path, by design). Use
     * `db.native.authorizer(policy)`.
     *
     * @returns {never}
     */
    setAuthorizer() {
        throw new Error(
            'DatabaseSync.setAuthorizer() is not available: this ' +
                "package's authorizer is declarative (a C++ rule list, no " +
                'JavaScript on the prepare path). Reach through ' +
                'db.native.authorizer(policy) for the supported form',
        );
    }

    /**
     * Creates a changeset-recording session. Divergence: this package's
     * sessions are asynchronous, so the returned session's methods return
     * promises (node:sqlite's are synchronous).
     *
     * @param {{ table?: string }} [options]
     * @returns {import('./sqlite3-binding.js').Session} the session.
     */
    createSession(options = {}) {
        return this.#db.session(options);
    }

    /**
     * Applies a changeset (asynchronous here; see createSession).
     *
     * @param {Uint8Array} changeset the bytes.
     * @param {import('./native.js').ApplyChangesetOptions} [options]
     * @returns {Promise<void>} resolves once applied.
     */
    applyChangeset(changeset, options) {
        return this.#db.applyChangeset(changeset, options);
    }

    /**
     * Serializes the database (asynchronous here).
     *
     * @returns {Promise<Uint8Array>} the bytes.
     */
    async serialize() {
        return this.#db.serializeToBytes();
    }

    /**
     * Closes the connection, finalizing any statement prepared through it
     * that is still open — node:sqlite's semantics, and required here:
     * this package refuses to close a connection holding an unfinalized
     * statement (`SQLITE_BUSY: unable to close due to unfinalized
     * statements`).
     *
     * Divergence: the close is queued (this package's close is
     * asynchronous), so the connection refuses further work at once but
     * the file handle is released a turn later — use `await using` /
     * `Symbol.asyncDispose`, or `await db.native.close()`, when a caller
     * must know the file is free, e.g. before deleting or reopening it on
     * Windows. A close that still fails (a statement prepared directly on
     * `db.native`, say) is reported on the connection's `'error'` event
     * rather than discarded; with no listener attached that surfaces as an
     * uncaught error, which is the point — the connection stayed open.
     *
     * @returns {void}
     */
    close() {
        if (this.#db.open) {
            this.#finalizeStatements();
            const db = this.#db;
            db.close((err) => {
                if (err) db.emit('error', err);
            });
        }
    }

    /**
     * `await using` support: finalizes outstanding statements, then waits
     * for the close to complete (unlike {@link DatabaseSync.close}, which
     * only starts it).
     *
     * @returns {Promise<void>} resolves once closed.
     */
    async [Symbol.asyncDispose]() {
        if (this.#db.open) {
            this.#finalizeStatements();
            await this.#db.close();
        }
    }
}

export { DatabaseSync, StatementSync };
