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
export function installPromiseApi(sqlite3: import("./sqlite3.js").sqlite3): void;
/**
 * Rewires `sqlite3.verbose()`: wraps the callback-mode cores with the
 * long-stack-trace machinery, then reinstalls the dual-mode wrappers so
 * promise rejections go through the same augmentation path.
 *
 * @param {(object: Record<string, import('./trace.js').Traceable>, property: string) => void} extendTrace the trace wrapper from lib/trace.js.
 * @returns {void}
 */
export function retracePromiseApi(extendTrace: (object: Record<string, import("./trace.js").Traceable>, property: string) => void): void;
/**
 * Options driving {@link createAsyncIterator}.
 */
export type IteratorOptions = {
    /**
     * bind parameters for the first fetch.
     */
    params?: unknown[] | undefined;
    /**
     * whether the iterator finalizes (true)
     * or merely resets (false) its statement on teardown.
     */
    ownsStatement?: boolean | undefined;
    /**
     * abort the iteration mid-cursor.
     */
    signal?: AbortSignal | undefined;
    /**
     * interrupt the connection on abort.
     */
    interrupt?: (() => void) | undefined;
    /**
     * lazily create the statement (db.iterate).
     */
    prepare?: ((callback: (err: Error | null) => void) => import("./sqlite3.js").Statement) | undefined;
};
/**
 * What promise-mode `run()` resolves to.
 *
 * The values are captured when the run's callback fires (so a reused
 * cached statement cannot corrupt an older result), but the possible
 * `lastID` RangeError stays lazy: reading `lastID` in `'number'` integer
 * mode after an insert with an unsafe rowid throws exactly when read,
 * never merely because the promise resolved. `lastIDBigInt` is exact in
 * every mode.
 */
export type PromiseRunResult = {
    /**
     * The inserted rowid, subject to the integer mode.
     */
    lastID: number | bigint;
    /**
     * The inserted rowid, exact in every integer mode.
     */
    lastIDBigInt: bigint;
    /**
     * Rows changed by the statement.
     */
    changes: number;
};
/**
 * Options accepted by every promise-mode method and by `iterate()` /
 * `transaction()`. Aborting interrupts the whole connection (a SQLite
 * constraint) and rejects with the signal's reason.
 */
export type SignalOptions = {
    /**
     * Abort this operation by interrupting the connection.
     */
    signal?: AbortSignal | undefined;
};
/**
 * Options for `Database#transaction`.
 */
export type TransactionOptions = {
    /**
     * Transaction start mode.
     */
    mode?: "deferred" | "immediate" | "exclusive" | undefined;
    /**
     * Nest via SAVEPOINT even at the top level.
     */
    savepoint?: boolean | undefined;
    /**
     * Run the body inside serialize() (strict
     * FIFO, at the cost of bypassing the statement cache).
     */
    serialize?: boolean | undefined;
    /**
     * Abort via `db.interrupt()` and reject with the signal's reason.
     */
    signal?: AbortSignal | undefined;
};
/**
 * Callback of `Statement#fetch`: receives up to `count` rows and whether
 * the cursor is exhausted.
 */
export type FetchCallback = (err: import("./native.js").SqliteError | null, rows: import("./native.js").Row[], done: boolean) => void;
/**
 * Opens a database and resolves once the connection is ready. The
 * `Database` constructor cannot return a promise; this is the
 * promise-native form. `new Database(...)` is unchanged. The second
 * argument is either open flags or a v9 options object (`mode`,
 * `untrusted`).
 */
export type OpenFunction = (filename: string, modeOrOptions?: number | import("./sqlite3.js").OpenOptions) => Promise<import("./native.js").Database>;
export type Installed = {
    sqlite3: import("./sqlite3.js").sqlite3;
    Database: typeof import("./sqlite3-binding.js").Database;
    Statement: typeof import("./sqlite3-binding.js").Statement;
    Backup: typeof import("./sqlite3-binding.js").Backup;
};
/**
 * Records which database owns a statement, so AbortSignal handling can
 * reach `db.interrupt()` from a statement method.
 *
 * @param {import('./sqlite3-binding.js').Database} db the owning connection.
 * @param {import('./sqlite3.js').Statement} statement the prepared statement.
 * @returns {import('./sqlite3.js').Statement} the statement, for inline use.
 */
export function associateStatement(db: import("./sqlite3-binding.js").Database, statement: import("./sqlite3.js").Statement): import("./sqlite3.js").Statement;
