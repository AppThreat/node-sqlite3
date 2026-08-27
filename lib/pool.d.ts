/**
 * Options for {@link pool}.
 */
export type PoolOptions = {
    /**
     * how many read-only worker connections to
     * open (default 4). 0 routes reads to the writer, serializing them
     * with writes — the right shape for a write-heavy file or a
     * `:memory:` database.
     */
    readers?: number | undefined;
    /**
     * set `PRAGMA journal_mode = WAL` on the
     * writer before readers connect (default true). WAL is what lets
     * readers and the writer proceed concurrently; with `false` (or on a
     * filesystem that refuses WAL) readers can block on the writer and
     * rely on `busyTimeout`.
     */
    walMode?: boolean | undefined;
    /**
     * `PRAGMA busy_timeout` in milliseconds
     * for every connection (default 5000).
     */
    busyTimeout?: number | undefined;
    /**
     * the integer
     * conversion mode for every connection (see
     * `configure('integerMode', …)`); the driver default (`'number'`)
     * applies when omitted.
     */
    integerMode?: "number" | "bigint" | "mixed" | undefined;
};
/**
 * Options for a pool query.
 */
export type PoolQueryOptions = {
    /**
     * aborts the query: the connection
     * running it is interrupted through a shared-memory flag, and the
     * promise rejects with the signal's reason. As with the
     * single-connection API, an abort that loses the race with a
     * completing query still rejects and drops the result.
     */
    signal?: AbortSignal | undefined;
};
/**
 * The query surface inside {@link SqlitePool#transaction}, pinned to the
 * writer connection: reads see the transaction's own uncommitted writes,
 * writes join it.
 */
export type PoolTransaction = {
    /**
     *   runs a query on the writer, resolving every row.
     */
    read: (sql: string, params?: import("./native.js").BindParams) => Promise<import("./native.js").Row[]>;
    /**
     *   runs a query on the writer, resolving the first row (or undefined).
     */
    get: (sql: string, params?: import("./native.js").BindParams) => Promise<import("./native.js").Row | undefined>;
    /**
     *   runs a statement inside the transaction, resolving `{lastID, changes, lastIDBigInt}`.
     */
    write: (sql: string, params?: import("./native.js").BindParams) => Promise<import("./promises.js").PromiseRunResult>;
    /**
     *   runs raw SQL (DDL, pragmas) inside the transaction.
     */
    exec: (sql: string) => Promise<void>;
};
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
export function pool(filename: string, options?: PoolOptions): Promise<SqlitePool>;
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
export class SqlitePool {
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
    static create(filename: string, options: {
        readers: number;
        walMode: boolean;
        busyTimeout: number;
        integerMode: ("number" | "bigint" | "mixed") | undefined;
    }): Promise<SqlitePool>;
    /**
     * @param {string} filename the database file.
     * @param {{ readers: number, walMode: boolean, busyTimeout: number,
     *     integerMode: ('number' | 'bigint' | 'mixed') | undefined }} options
     *   validated options.
     */
    constructor(filename: string, options: {
        readers: number;
        walMode: boolean;
        busyTimeout: number;
        integerMode: ("number" | "bigint" | "mixed") | undefined;
    });
    /**
     * The database filename the pool was created with.
     *
     * @returns {string} the filename.
     * @since 9.0.0
     */
    get filename(): string;
    /**
     * How many read-only connections the pool was created with.
     *
     * @returns {number} the reader count.
     * @since 9.0.0
     */
    get readers(): number;
    /**
     * True once close() has started (the pool refuses new work).
     *
     * @returns {boolean} whether close() has started.
     * @since 9.0.0
     */
    get closed(): boolean;
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
    read(...args: any[]): Promise<import("./native.js").Row[]>;
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
    get(...args: any[]): Promise<import("./native.js").Row | undefined>;
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
    write(...args: any[]): Promise<import("./promises.js").PromiseRunResult>;
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
    exec(sql: string): Promise<void>;
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
    transaction<T>(fn: (tx: PoolTransaction) => T | Promise<T>, options?: {
        mode?: "deferred" | "immediate" | "exclusive";
    }): Promise<T>;
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
    close(): Promise<void>;
    /**
     * `await using pool` — disposes via {@link SqlitePool#close}.
     *
     * @returns {Promise<void>} resolves once the pool is closed.
     * @since 9.0.0
     */
    [Symbol.asyncDispose](): Promise<void>;
    #private;
}
