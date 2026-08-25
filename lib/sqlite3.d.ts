// Type definitions for sqlite3
// Project: http://github.com/AppThreat/node-sqlite3

/// <reference types="node" />

import events = require('node:events');

export const OPEN_READONLY: number;
export const OPEN_READWRITE: number;
export const OPEN_CREATE: number;
export const OPEN_FULLMUTEX: number;
export const OPEN_SHAREDCACHE: number;
export const OPEN_PRIVATECACHE: number;
export const OPEN_URI: number;
/** Open flag: multi-thread contention disabling (sqlite3_open_v2). @returns {number} the raw SQLite value. */
export const OPEN_NOMUTEX: number;
/** Open flag: the database is always in-memory. @returns {number} the raw SQLite value. */
export const OPEN_MEMORY: number;
/** Open flag: return extended result codes from sqlite3_step. @returns {number} the raw SQLite value. */
export const OPEN_EXRESCODE: number;

export const VERSION: string;
export const SOURCE_ID: string;
export const VERSION_NUMBER: number;

export const OK: number;
export const ERROR: number;
export const INTERNAL: number;
export const PERM: number;
export const ABORT: number;
export const BUSY: number;
export const LOCKED: number;
export const NOMEM: number;
export const READONLY: number;
export const INTERRUPT: number;
export const IOERR: number;
export const CORRUPT: number;
export const NOTFOUND: number;
export const FULL: number;
export const CANTOPEN: number;
export const PROTOCOL: number;
export const EMPTY: number;
export const SCHEMA: number;
export const TOOBIG: number;
export const CONSTRAINT: number;
export const MISMATCH: number;
export const MISUSE: number;
export const NOLFS: number;
export const AUTH: number;
export const FORMAT: number;
export const RANGE: number;
export const NOTADB: number;

// Extended result codes (v9): err.code carries these, err.primaryCode the
// primary code, err.errno the extended number.
/** Extended code: SQLITE_ERROR_MISSING_COLLSEQ. @returns {number} the raw SQLite value. */
export const ERROR_MISSING_COLLSEQ: number;
/** Extended code: SQLITE_ERROR_RETRY. @returns {number} the raw SQLite value. */
export const ERROR_RETRY: number;
/** Extended code: SQLITE_ERROR_SNAPSHOT. @returns {number} the raw SQLite value. */
export const ERROR_SNAPSHOT: number;
/** Extended code: SQLITE_ERROR_RESERVESIZE. @returns {number} the raw SQLite value. */
export const ERROR_RESERVESIZE: number;
/** Extended code: SQLITE_ERROR_KEY. @returns {number} the raw SQLite value. */
export const ERROR_KEY: number;
/** Extended code: SQLITE_ERROR_UNABLE. @returns {number} the raw SQLite value. */
export const ERROR_UNABLE: number;
/** Extended code: SQLITE_IOERR_READ. @returns {number} the raw SQLite value. */
export const IOERR_READ: number;
/** Extended code: SQLITE_IOERR_SHORT_READ. @returns {number} the raw SQLite value. */
export const IOERR_SHORT_READ: number;
/** Extended code: SQLITE_IOERR_WRITE. @returns {number} the raw SQLite value. */
export const IOERR_WRITE: number;
/** Extended code: SQLITE_IOERR_FSYNC. @returns {number} the raw SQLite value. */
export const IOERR_FSYNC: number;
/** Extended code: SQLITE_IOERR_DIR_FSYNC. @returns {number} the raw SQLite value. */
export const IOERR_DIR_FSYNC: number;
/** Extended code: SQLITE_IOERR_TRUNCATE. @returns {number} the raw SQLite value. */
export const IOERR_TRUNCATE: number;
/** Extended code: SQLITE_IOERR_FSTAT. @returns {number} the raw SQLite value. */
export const IOERR_FSTAT: number;
/** Extended code: SQLITE_IOERR_UNLOCK. @returns {number} the raw SQLite value. */
export const IOERR_UNLOCK: number;
/** Extended code: SQLITE_IOERR_RDLOCK. @returns {number} the raw SQLite value. */
export const IOERR_RDLOCK: number;
/** Extended code: SQLITE_IOERR_DELETE. @returns {number} the raw SQLite value. */
export const IOERR_DELETE: number;
/** Extended code: SQLITE_IOERR_BLOCKED. @returns {number} the raw SQLite value. */
export const IOERR_BLOCKED: number;
/** Extended code: SQLITE_IOERR_NOMEM. @returns {number} the raw SQLite value. */
export const IOERR_NOMEM: number;
/** Extended code: SQLITE_IOERR_ACCESS. @returns {number} the raw SQLite value. */
export const IOERR_ACCESS: number;
/** Extended code: SQLITE_IOERR_CHECKRESERVEDLOCK. @returns {number} the raw SQLite value. */
export const IOERR_CHECKRESERVEDLOCK: number;
/** Extended code: SQLITE_IOERR_LOCK. @returns {number} the raw SQLite value. */
export const IOERR_LOCK: number;
/** Extended code: SQLITE_IOERR_CLOSE. @returns {number} the raw SQLite value. */
export const IOERR_CLOSE: number;
/** Extended code: SQLITE_IOERR_DIR_CLOSE. @returns {number} the raw SQLite value. */
export const IOERR_DIR_CLOSE: number;
/** Extended code: SQLITE_IOERR_SHMOPEN. @returns {number} the raw SQLite value. */
export const IOERR_SHMOPEN: number;
/** Extended code: SQLITE_IOERR_SHMSIZE. @returns {number} the raw SQLite value. */
export const IOERR_SHMSIZE: number;
/** Extended code: SQLITE_IOERR_SHMLOCK. @returns {number} the raw SQLite value. */
export const IOERR_SHMLOCK: number;
/** Extended code: SQLITE_IOERR_SHMMAP. @returns {number} the raw SQLite value. */
export const IOERR_SHMMAP: number;
/** Extended code: SQLITE_IOERR_SEEK. @returns {number} the raw SQLite value. */
export const IOERR_SEEK: number;
/** Extended code: SQLITE_IOERR_DELETE_NOENT. @returns {number} the raw SQLite value. */
export const IOERR_DELETE_NOENT: number;
/** Extended code: SQLITE_IOERR_MMAP. @returns {number} the raw SQLite value. */
export const IOERR_MMAP: number;
/** Extended code: SQLITE_IOERR_GETTEMPPATH. @returns {number} the raw SQLite value. */
export const IOERR_GETTEMPPATH: number;
/** Extended code: SQLITE_IOERR_CONVPATH. @returns {number} the raw SQLite value. */
export const IOERR_CONVPATH: number;
/** Extended code: SQLITE_IOERR_VNODE. @returns {number} the raw SQLite value. */
export const IOERR_VNODE: number;
/** Extended code: SQLITE_IOERR_AUTH. @returns {number} the raw SQLite value. */
export const IOERR_AUTH: number;
/** Extended code: SQLITE_IOERR_BEGIN_ATOMIC. @returns {number} the raw SQLite value. */
export const IOERR_BEGIN_ATOMIC: number;
/** Extended code: SQLITE_IOERR_COMMIT_ATOMIC. @returns {number} the raw SQLite value. */
export const IOERR_COMMIT_ATOMIC: number;
/** Extended code: SQLITE_IOERR_ROLLBACK_ATOMIC. @returns {number} the raw SQLite value. */
export const IOERR_ROLLBACK_ATOMIC: number;
/** Extended code: SQLITE_IOERR_DATA. @returns {number} the raw SQLite value. */
export const IOERR_DATA: number;
/** Extended code: SQLITE_IOERR_CORRUPTFS. @returns {number} the raw SQLite value. */
export const IOERR_CORRUPTFS: number;
/** Extended code: SQLITE_IOERR_IN_PAGE. @returns {number} the raw SQLite value. */
export const IOERR_IN_PAGE: number;
/** Extended code: SQLITE_IOERR_BADKEY. @returns {number} the raw SQLite value. */
export const IOERR_BADKEY: number;
/** Extended code: SQLITE_IOERR_CODEC. @returns {number} the raw SQLite value. */
export const IOERR_CODEC: number;
/** Extended code: SQLITE_LOCKED_SHAREDCACHE. @returns {number} the raw SQLite value. */
export const LOCKED_SHAREDCACHE: number;
/** Extended code: SQLITE_LOCKED_VTAB. @returns {number} the raw SQLite value. */
export const LOCKED_VTAB: number;
/** Extended code: SQLITE_BUSY_RECOVERY. @returns {number} the raw SQLite value. */
export const BUSY_RECOVERY: number;
/** Extended code: SQLITE_BUSY_SNAPSHOT. @returns {number} the raw SQLite value. */
export const BUSY_SNAPSHOT: number;
/** Extended code: SQLITE_BUSY_TIMEOUT. @returns {number} the raw SQLite value. */
export const BUSY_TIMEOUT: number;
/** Extended code: SQLITE_CANTOPEN_NOTEMPDIR. @returns {number} the raw SQLite value. */
export const CANTOPEN_NOTEMPDIR: number;
/** Extended code: SQLITE_CANTOPEN_ISDIR. @returns {number} the raw SQLite value. */
export const CANTOPEN_ISDIR: number;
/** Extended code: SQLITE_CANTOPEN_FULLPATH. @returns {number} the raw SQLite value. */
export const CANTOPEN_FULLPATH: number;
/** Extended code: SQLITE_CANTOPEN_CONVPATH. @returns {number} the raw SQLite value. */
export const CANTOPEN_CONVPATH: number;
/** Extended code: SQLITE_CANTOPEN_DIRTYWAL. @returns {number} the raw SQLite value. */
export const CANTOPEN_DIRTYWAL: number;
/** Extended code: SQLITE_CANTOPEN_SYMLINK. @returns {number} the raw SQLite value. */
export const CANTOPEN_SYMLINK: number;
/** Extended code: SQLITE_CORRUPT_VTAB. @returns {number} the raw SQLite value. */
export const CORRUPT_VTAB: number;
/** Extended code: SQLITE_CORRUPT_SEQUENCE. @returns {number} the raw SQLite value. */
export const CORRUPT_SEQUENCE: number;
/** Extended code: SQLITE_CORRUPT_INDEX. @returns {number} the raw SQLite value. */
export const CORRUPT_INDEX: number;
/** Extended code: SQLITE_READONLY_RECOVERY. @returns {number} the raw SQLite value. */
export const READONLY_RECOVERY: number;
/** Extended code: SQLITE_READONLY_CANTLOCK. @returns {number} the raw SQLite value. */
export const READONLY_CANTLOCK: number;
/** Extended code: SQLITE_READONLY_ROLLBACK. @returns {number} the raw SQLite value. */
export const READONLY_ROLLBACK: number;
/** Extended code: SQLITE_READONLY_DBMOVED. @returns {number} the raw SQLite value. */
export const READONLY_DBMOVED: number;
/** Extended code: SQLITE_READONLY_CANTINIT. @returns {number} the raw SQLite value. */
export const READONLY_CANTINIT: number;
/** Extended code: SQLITE_READONLY_DIRECTORY. @returns {number} the raw SQLite value. */
export const READONLY_DIRECTORY: number;
/** Extended code: SQLITE_ABORT_ROLLBACK. @returns {number} the raw SQLite value. */
export const ABORT_ROLLBACK: number;
/** Extended code: SQLITE_CONSTRAINT_CHECK. @returns {number} the raw SQLite value. */
export const CONSTRAINT_CHECK: number;
/** Extended code: SQLITE_CONSTRAINT_COMMITHOOK. @returns {number} the raw SQLite value. */
export const CONSTRAINT_COMMITHOOK: number;
/** Extended code: SQLITE_CONSTRAINT_FOREIGNKEY. @returns {number} the raw SQLite value. */
export const CONSTRAINT_FOREIGNKEY: number;
/** Extended code: SQLITE_CONSTRAINT_FUNCTION. @returns {number} the raw SQLite value. */
export const CONSTRAINT_FUNCTION: number;
/** Extended code: SQLITE_CONSTRAINT_NOTNULL. @returns {number} the raw SQLite value. */
export const CONSTRAINT_NOTNULL: number;
/** Extended code: SQLITE_CONSTRAINT_PRIMARYKEY. @returns {number} the raw SQLite value. */
export const CONSTRAINT_PRIMARYKEY: number;
/** Extended code: SQLITE_CONSTRAINT_TRIGGER. @returns {number} the raw SQLite value. */
export const CONSTRAINT_TRIGGER: number;
/** Extended code: SQLITE_CONSTRAINT_UNIQUE. @returns {number} the raw SQLite value. */
export const CONSTRAINT_UNIQUE: number;
/** Extended code: SQLITE_CONSTRAINT_VTAB. @returns {number} the raw SQLite value. */
export const CONSTRAINT_VTAB: number;
/** Extended code: SQLITE_CONSTRAINT_ROWID. @returns {number} the raw SQLite value. */
export const CONSTRAINT_ROWID: number;
/** Extended code: SQLITE_CONSTRAINT_PINNED. @returns {number} the raw SQLite value. */
export const CONSTRAINT_PINNED: number;
/** Extended code: SQLITE_CONSTRAINT_DATATYPE. @returns {number} the raw SQLite value. */
export const CONSTRAINT_DATATYPE: number;
/** Extended code: SQLITE_AUTH_USER. @returns {number} the raw SQLite value. */
export const AUTH_USER: number;

export const LIMIT_LENGTH: number;
export const LIMIT_SQL_LENGTH: number;
export const LIMIT_COLUMN: number;
export const LIMIT_EXPR_DEPTH: number;
export const LIMIT_COMPOUND_SELECT: number;
export const LIMIT_VDBE_OP: number;
export const LIMIT_FUNCTION_ARG: number;
export const LIMIT_ATTACHED: number;
export const LIMIT_LIKE_PATTERN_LENGTH: number;
export const LIMIT_VARIABLE_NUMBER: number;
export const LIMIT_TRIGGER_DEPTH: number;
export const LIMIT_WORKER_THREADS: number;

export const cached: {
    Database(
        filename: string,
        callback?: (this: Database, err: Error | null) => void,
    ): Database;
    Database(
        filename: string,
        mode?: number,
        callback?: (this: Database, err: Error | null) => void,
    ): Database;
};

/** How INTEGER columns and lastID are converted to JS. */
export type IntegerMode = 'number' | 'bigint' | 'mixed';

/**
 * The error object delivered to callbacks / thrown by sync methods.
 * `code` is the extended result-code name (v9), `primaryCode` the primary
 * one, `errno` the extended numeric code.
 */
export interface SqliteError extends Error {
    code: string;
    primaryCode: string;
    errno: number;
}

/**
 * The `this` of run() callbacks. lastID/changes are inherited from
 * Statement: a number when safely representable, a BigInt in
 * 'bigint'/'mixed' integer mode, and a RangeError when read in 'number'
 * mode after an insert with an unsafe rowid.
 */
export interface RunResult extends Statement {}

/**
 * Options accepted by every promise-mode method and by iterate()/
 * transaction(). Aborting interrupts the whole connection (a SQLite
 * constraint) and rejects with the signal's reason.
 * @since 9.0.0
 */
export interface SignalOptions {
    signal?: AbortSignal;
}

/**
 * What promise-mode run() resolves to. The values are captured when the
 * statement completes (a reused statement cannot corrupt an older result),
 * and lastID keeps the 'number'-mode RangeError lazy: it throws only when
 * read, never merely because the promise resolved. lastIDBigInt is exact
 * in every integer mode.
 * @since 9.0.0
 */
export interface PromiseRunResult {
    /** The inserted rowid, subject to the integer mode. */
    readonly lastID: number | bigint;
    /** The inserted rowid, exact in every integer mode. */
    readonly lastIDBigInt: bigint;
    /** Rows changed by the statement. */
    readonly changes: number;
}

/** One row as returned for untyped queries. */
export type Row = Record<string, unknown>;

/**
 * Callback of Statement#fetch: receives up to `count` rows and whether the
 * cursor is exhausted.
 * @since 9.0.0
 */
export type FetchCallback = (
    /** the failure, if any. */
    err: Error | null,
    /** up to `count` result rows. */
    rows: Row[],
    /** true when the cursor is exhausted. */
    done: boolean,
) => void;

/** Options for Database#transaction. @since 9.0.0 */
export interface TransactionOptions extends SignalOptions {
    /** Transaction start mode. Default 'deferred'. */
    mode?: 'deferred' | 'immediate' | 'exclusive';
    /** Nest via SAVEPOINT even at the top level. */
    savepoint?: boolean;
    /**
     * Run the body inside serialize() (strict FIFO, at the cost of
     * bypassing the statement cache). Default false: a transaction is
     * connection-wide and concurrent work on the same connection races it.
     */
    serialize?: boolean;
}

export class Statement extends events.EventEmitter {
    // ---- Promise mode (v9): a call whose last argument is not a function
    // returns a promise instead of `this`. The overloads below express the
    // arity-0 promise calls exactly; calls that bind parameters without a
    // callback resolve to Promise at runtime but fall through to the
    // variadic callback overloads until Deliverable 04 regenerates these
    // definitions.

    /** @returns Promise<void>. @since 9.0.0 */
    bind(): Promise<void>;
    /** @returns Promise<PromiseRunResult>. @since 9.0.0 */
    run(): Promise<PromiseRunResult>;
    /** @returns Promise<Row | undefined>. @since 9.0.0 */
    get(): Promise<Row | undefined>;
    /** @returns Promise<Row[]>. @since 9.0.0 */
    all(): Promise<Row[]>;
    /** @returns Promise<Record<string, unknown>>. @since 9.0.0 */
    map(): Promise<Record<string, unknown>>;
    /** @returns Promise<void>. @since 9.0.0 */
    reset(): Promise<void>;
    /** @returns Promise<void>. @since 9.0.0 */
    finalize(): Promise<void>;

    /**
     * Steps up to `count` rows into one batch without resetting the
     * statement between calls, so successive fetches continue one cursor.
     * The native backing of iterate(); usable directly for paged reads.
     *
     * @param count maximum number of rows to fetch (>= 1).
     * @param params bind parameters, bound on the first fetch of a run.
     * @param callback receives (err, rows, done).
     * @returns this, for chaining.
     * @since 9.0.0
     * @example
     * stmt.fetch(100, (err, rows, done) => { ... });
     */
    fetch(count: number, callback: FetchCallback): this;
    fetch(count: number, params: any, callback: FetchCallback): this;

    /**
     * Iterates this statement's results with backpressure, pulling batches
     * (64..1024 rows) only as the consumer asks. On break/throw the
     * statement is reset (not finalized) and stays usable; two concurrent
     * iterators over the same statement throw.
     *
     * @param params bind parameters, then optionally `{ signal }`.
     * @returns an async iterator that is itself async-iterable.
     * @since 9.0.0
     * @example
     * for await (const row of stmt.iterate(42)) { ... }
     */
    iterate(...params: any[]): AsyncIterableIterator<Row>;

    /**
     * `await using` support: finalizes the statement. Idempotent.
     * @since 9.0.0
     */
    [Symbol.asyncDispose](): Promise<void>;

    /**
     * `using` support for prepareSync() results: initiates an async
     * finalize synchronously. @since 9.0.0
     */
    [Symbol.dispose](): void;

    bind(callback?: (err: Error | null) => void): this;
    bind(...params: any[]): this;

    reset(callback?: (err: null) => void): this;

    finalize(callback?: (err: Error) => void): Database;

    run(callback?: (err: Error | null) => void): this;
    run(
        params: any,
        callback?: (this: RunResult, err: Error | null) => void,
    ): this;
    run(...params: any[]): this;

    get<T>(callback?: (err: Error | null, row?: T) => void): this;
    get<T>(
        params: any,
        callback?: (this: RunResult, err: Error | null, row?: T) => void,
    ): this;
    get(...params: any[]): this;

    all<T>(callback?: (err: Error | null, rows: T[]) => void): this;
    all<T>(
        params: any,
        callback?: (this: RunResult, err: Error | null, rows: T[]) => void,
    ): this;
    all(...params: any[]): this;

    each<T>(
        callback?: (err: Error | null, row: T) => void,
        complete?: (err: Error | null, count: number) => void,
    ): this;
    each<T>(
        params: any,
        callback?: (this: RunResult, err: Error | null, row: T) => void,
        complete?: (err: Error | null, count: number) => void,
    ): this;
    each(...params: any[]): this;

    /**
     * Synchronous fast path. Throws when the database is not fully idle
     * (async work in flight or queued) or when called from inside an async
     * completion callback. Accepts no callback argument.
     */
    getSync<T>(...params: any[]): T | undefined;
    runSync(...params: any[]): this;
    allSync<T>(...params: any[]): T[];

    /**
     * Rowid of the last run() as a BigInt, exact in every integer mode.
     * Undefined before the first run.
     *
     * @returns the last insert rowid as a BigInt.
     * @since 9.0.0
     */
    readonly lastIDBigInt: bigint | undefined;

    /**
     * Number of rows changed by the last run(). Undefined before the
     * first run.
     *
     * @returns the change count of the last run().
     * @since 9.0.0
     */
    readonly changes: number | undefined;

    /**
     * Rowid of the last run(): number when safely representable, BigInt
     * in 'bigint'/'mixed' integer mode, and a RangeError otherwise (the
     * 'number' default refuses to truncate). Undefined before the first
     * run.
     *
     * @returns the last insert rowid, mode-dependent.
     * @since 9.0.0
     */
    readonly lastID: number | bigint | undefined;
}

export class Database extends events.EventEmitter {
    constructor(filename: string, callback?: (err: Error | null) => void);
    constructor(
        filename: string,
        mode?: number,
        callback?: (err: Error | null) => void,
    );

    // ---- Promise mode (v9): a call whose last argument is not a function
    // returns a promise instead of `this`. The overloads below express the
    // arity-1 promise calls exactly; calls that bind parameters without a
    // callback resolve to Promise at runtime but fall through to the
    // variadic callback overloads until Deliverable 04 regenerates these
    // definitions.

    /**
     * @returns a promise resolving once the connection is closed.
     * @since 9.0.0
     */
    close(): Promise<void>;
    /**
     * @param sql the statement to run.
     * @returns a promise resolving the run result.
     * @since 9.0.0
     */
    run(sql: string): Promise<PromiseRunResult>;
    /**
     * @param sql the query to run.
     * @returns a promise resolving the first row, or undefined.
     * @since 9.0.0
     */
    get(sql: string): Promise<Row | undefined>;
    /**
     * @param sql the query to run.
     * @returns a promise resolving every result row.
     * @since 9.0.0
     */
    all(sql: string): Promise<Row[]>;
    /**
     * @param sql the query to run.
     * @returns a promise resolving the rows keyed by their first column.
     * @since 9.0.0
     */
    map(sql: string): Promise<Record<string, unknown>>;
    /**
     * @param sql one or more statements to execute.
     * @returns a promise resolving once every statement has run.
     * @since 9.0.0
     */
    exec(sql: string): Promise<void>;
    /**
     * @returns a promise resolving once the queue has drained.
     * @since 9.0.0
     */
    wait(): Promise<void>;
    /**
     * @param filename path to the extension to load.
     * @returns a promise resolving once the extension is loaded.
     * @since 9.0.0
     */
    loadExtension(filename: string): Promise<void>;

    close(callback?: (err: Error | null) => void): void;

    run(
        sql: string,
        callback?: (this: RunResult, err: Error | null) => void,
    ): this;
    run(
        sql: string,
        params: any,
        callback?: (this: RunResult, err: Error | null) => void,
    ): this;
    run(sql: string, ...params: any[]): this;

    get<T>(
        sql: string,
        callback?: (this: Statement, err: Error | null, row: T) => void,
    ): this;
    get<T>(
        sql: string,
        params: any,
        callback?: (this: Statement, err: Error | null, row: T) => void,
    ): this;
    get(sql: string, ...params: any[]): this;

    all<T>(
        sql: string,
        callback?: (this: Statement, err: Error | null, rows: T[]) => void,
    ): this;
    all<T>(
        sql: string,
        params: any,
        callback?: (this: Statement, err: Error | null, rows: T[]) => void,
    ): this;
    all(sql: string, ...params: any[]): this;

    each<T>(
        sql: string,
        callback?: (this: Statement, err: Error | null, row: T) => void,
        complete?: (err: Error | null, count: number) => void,
    ): this;
    each<T>(
        sql: string,
        params: any,
        callback?: (this: Statement, err: Error | null, row: T) => void,
        complete?: (err: Error | null, count: number) => void,
    ): this;
    each(sql: string, ...params: any[]): this;

    exec(
        sql: string,
        callback?: (this: Statement, err: Error | null) => void,
    ): this;

    prepare(
        sql: string,
        callback?: (this: Statement, err: Error | null) => void,
    ): Statement;
    prepare(
        sql: string,
        params: any,
        callback?: (this: Statement, err: Error | null) => void,
    ): Statement;
    prepare(sql: string, ...params: any[]): Statement;

    /**
     * Prepares synchronously on the main thread. Throws when the database
     * is not fully idle. The returned statement also supports the
     * getSync/runSync/allSync fast path.
     */
    prepareSync(sql: string): Statement;

    /** Callback form of map(): keys rows by their first column. */
    map(
        sql: string,
        callback?: (this: Statement, err: Error | null, map: object) => void,
    ): this;
    map(
        sql: string,
        params: any,
        callback?: (this: Statement, err: Error | null, map: object) => void,
    ): this;

    /**
     * Iterates query results with backpressure, pulling batches (64..1024
     * rows) only as the consumer asks. The statement is prepared on first
     * use and finalized when the iteration ends (drain, break, throw or
     * abort).
     *
     * @param sql the query to iterate.
     * @param params bind parameters, then optionally `{ signal }`.
     * @returns an async iterator that is itself async-iterable.
     * @since 9.0.0
     * @example
     * for await (const row of db.iterate('SELECT * FROM big')) { ... }
     */
    iterate(sql: string, ...params: any[]): AsyncIterableIterator<Row>;

    /**
     * db.iterate() as an object-mode Readable, for piping into the rest of
     * the stream ecosystem.
     *
     * @param sql the query to stream.
     * @param params bind parameters, then optionally `{ signal }`.
     * @returns an object-mode stream of rows.
     * @since 9.0.0
     */
    stream(sql: string, ...params: any[]): import('node:stream').Readable;

    /**
     * Runs `fn` inside a transaction: BEGIN / COMMIT, ROLLBACK on throw;
     * if the rollback fails too, an AggregateError carries both errors.
     * Nested calls automatically use savepoints. The callback receives
     * the connection itself as `tx` — a transaction is connection-wide in
     * SQLite, and work issued on `db` directly from inside the callback
     * races it unless `{ serialize: true }` is passed.
     *
     * @param fn the transaction body, receives `(tx)`.
     * @param options mode, savepoint, serialize and signal.
     * @returns whatever `fn` resolves to.
     * @throws rejects with a TypeError for an invalid body or mode.
     * @since 9.0.0
     * @example
     * const rows = await db.transaction(async (tx) => {
     *     await tx.run('INSERT INTO t VALUES (?)', 1);
     *     return tx.all('SELECT * FROM t');
     * });
     */
    transaction<T = unknown>(
        fn: (tx: Database) => T | Promise<T>,
        options?: TransactionOptions,
    ): Promise<T>;

    /**
     * `await using` support: closes the database. Idempotent; real close
     * errors (e.g. SQLITE_BUSY from unfinalized statements) propagate.
     * @since 9.0.0
     */
    [Symbol.asyncDispose](): Promise<void>;

    /**
     * Opt-in LRU cache of prepared statements for run/get/all/each/map,
     * keyed on the SQL string. Defaults to 64 entries. Cached statements
     * are finalized by close(). Under serialize() the cache is bypassed to
     * preserve strict FIFO ordering.
     */
    cacheStatements(maxEntries?: number): this;

    /**
     * Synchronous fast path. Throws when the database is not fully idle
     * (async work in flight or queued) or when called from inside an async
     * completion callback. Accepts no callback argument.
     */
    getSync<T>(sql: string, ...params: any[]): T | undefined;
    runSync(sql: string, ...params: any[]): { lastID: number; changes: number };
    allSync<T>(sql: string, ...params: any[]): T[];

    serialize(callback?: () => void): void;
    parallelize(callback?: () => void): void;

    /**
     * Sets how INTEGER columns and lastID are converted to JS.
     *
     * - 'number' (default): numbers when safely representable, otherwise
     *   a RangeError rather than a silently truncated double.
     * - 'bigint': always BigInt.
     * - 'mixed': number when safe, BigInt otherwise. Recommended for
     *   anything touching rowids.
     *
     * Applies to all statements of this database, including already
     * prepared ones, at read time.
     *
     * @param option must be 'integerMode'.
     * @param value one of 'number', 'bigint', 'mixed'.
     * @returns this database, for chaining.
     * @since 9.0.0
     * @example
     * db.configure('integerMode', 'mixed');
     */
    configure(option: 'integerMode', value: IntegerMode): void;

    /** The active integer mode. @since 9.0.0 */
    readonly integerMode: IntegerMode;

    on(event: 'trace', listener: (sql: string) => void): this;
    on(event: 'profile', listener: (sql: string, time: number) => void): this;
    on(
        event: 'change',
        listener: (
            type: string,
            database: string,
            table: string,
            rowid: number,
        ) => void,
    ): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'open' | 'close', listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;

    configure(option: 'busyTimeout', value: number): void;
    configure(option: 'limit', id: number, value: number): void;

    loadExtension(
        filename: string,
        callback?: (err: Error | null) => void,
    ): this;

    wait(callback?: (param: null) => void): this;

    interrupt(): void;
}

export function verbose(): sqlite3;

/**
 * An online backup between two database handles, created by
 * `db.backup(filename)` (which returns it synchronously).
 */
export class Backup extends events.EventEmitter {
    /**
     * @param pages pages to copy, or -1 for all remaining.
     * @returns a promise resolving true once the backup is complete.
     * @since 9.0.0
     */
    step(pages: number): Promise<boolean>;
    step(
        pages: number,
        callback: (this: Backup, err: Error | null, completed: boolean) => void,
    ): this;
    /**
     * @returns a promise resolving once the backup handle is released.
     * @since 9.0.0
     */
    finish(): Promise<void>;
    finish(callback: (this: Backup, err: Error | null) => void): this;

    /**
     * @returns True when no step is in flight.
     */
    readonly idle: boolean;
    /**
     * @returns True when the backup has fully copied.
     */
    readonly completed: boolean;
    /**
     * @returns True when the backup failed unrecoverably.
     */
    readonly failed: boolean;
    /**
     * @returns Pages still to copy.
     */
    readonly remaining: number;
    /**
     * @returns Total pages in the source database.
     */
    readonly pageCount: number;
    /**
     * @returns Result codes that are retried instead of failing the backup.
     */
    retryErrors: number[];

    /**
     * `await using` support: finishes the backup. Idempotent.
     * @since 9.0.0
     */
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Opens a database and resolves once the connection is ready. The
 * `Database` constructor cannot return a promise; this is the
 * promise-native form. `new Database(...)` is unchanged.
 *
 * @param filename the database file (or `:memory:` / `''`).
 * @param mode open flags, e.g. `sqlite3.OPEN_READWRITE`.
 * @returns the opened database.
 * @since 9.0.0
 * @example
 * const db = await sqlite3.open('app.db', sqlite3.OPEN_READWRITE);
 */
export function open(filename: string, mode?: number): Promise<Database>;

export interface sqlite3 {
    OPEN_READONLY: number;
    OPEN_READWRITE: number;
    OPEN_CREATE: number;
    OPEN_FULLMUTEX: number;
    OPEN_SHAREDCACHE: number;
    OPEN_PRIVATECACHE: number;
    OPEN_URI: number;
    OPEN_NOMUTEX: number;
    OPEN_MEMORY: number;
    OPEN_EXRESCODE: number;

    VERSION: string;
    SOURCE_ID: string;
    VERSION_NUMBER: number;

    OK: number;
    ERROR: number;
    INTERNAL: number;
    PERM: number;
    ABORT: number;
    BUSY: number;
    LOCKED: number;
    NOMEM: number;
    READONLY: number;
    INTERRUPT: number;
    IOERR: number;
    CORRUPT: number;
    NOTFOUND: number;
    FULL: number;
    CANTOPEN: number;
    PROTOCOL: number;
    EMPTY: number;
    SCHEMA: number;
    TOOBIG: number;
    CONSTRAINT: number;
    MISMATCH: number;
    MISUSE: number;
    NOLFS: number;
    AUTH: number;
    FORMAT: number;
    RANGE: number;
    NOTADB: number;

    ERROR_MISSING_COLLSEQ: number;
    ERROR_RETRY: number;
    ERROR_SNAPSHOT: number;
    ERROR_RESERVESIZE: number;
    ERROR_KEY: number;
    ERROR_UNABLE: number;
    IOERR_READ: number;
    IOERR_SHORT_READ: number;
    IOERR_WRITE: number;
    IOERR_FSYNC: number;
    IOERR_DIR_FSYNC: number;
    IOERR_TRUNCATE: number;
    IOERR_FSTAT: number;
    IOERR_UNLOCK: number;
    IOERR_RDLOCK: number;
    IOERR_DELETE: number;
    IOERR_BLOCKED: number;
    IOERR_NOMEM: number;
    IOERR_ACCESS: number;
    IOERR_CHECKRESERVEDLOCK: number;
    IOERR_LOCK: number;
    IOERR_CLOSE: number;
    IOERR_DIR_CLOSE: number;
    IOERR_SHMOPEN: number;
    IOERR_SHMSIZE: number;
    IOERR_SHMLOCK: number;
    IOERR_SHMMAP: number;
    IOERR_SEEK: number;
    IOERR_DELETE_NOENT: number;
    IOERR_MMAP: number;
    IOERR_GETTEMPPATH: number;
    IOERR_CONVPATH: number;
    IOERR_VNODE: number;
    IOERR_AUTH: number;
    IOERR_BEGIN_ATOMIC: number;
    IOERR_COMMIT_ATOMIC: number;
    IOERR_ROLLBACK_ATOMIC: number;
    IOERR_DATA: number;
    IOERR_CORRUPTFS: number;
    IOERR_IN_PAGE: number;
    IOERR_BADKEY: number;
    IOERR_CODEC: number;
    LOCKED_SHAREDCACHE: number;
    LOCKED_VTAB: number;
    BUSY_RECOVERY: number;
    BUSY_SNAPSHOT: number;
    BUSY_TIMEOUT: number;
    CANTOPEN_NOTEMPDIR: number;
    CANTOPEN_ISDIR: number;
    CANTOPEN_FULLPATH: number;
    CANTOPEN_CONVPATH: number;
    CANTOPEN_DIRTYWAL: number;
    CANTOPEN_SYMLINK: number;
    CORRUPT_VTAB: number;
    CORRUPT_SEQUENCE: number;
    CORRUPT_INDEX: number;
    READONLY_RECOVERY: number;
    READONLY_CANTLOCK: number;
    READONLY_ROLLBACK: number;
    READONLY_DBMOVED: number;
    READONLY_CANTINIT: number;
    READONLY_DIRECTORY: number;
    ABORT_ROLLBACK: number;
    CONSTRAINT_CHECK: number;
    CONSTRAINT_COMMITHOOK: number;
    CONSTRAINT_FOREIGNKEY: number;
    CONSTRAINT_FUNCTION: number;
    CONSTRAINT_NOTNULL: number;
    CONSTRAINT_PRIMARYKEY: number;
    CONSTRAINT_TRIGGER: number;
    CONSTRAINT_UNIQUE: number;
    CONSTRAINT_VTAB: number;
    CONSTRAINT_ROWID: number;
    CONSTRAINT_PINNED: number;
    CONSTRAINT_DATATYPE: number;
    AUTH_USER: number;

    LIMIT_LENGTH: number;
    LIMIT_SQL_LENGTH: number;
    LIMIT_COLUMN: number;
    LIMIT_EXPR_DEPTH: number;
    LIMIT_COMPOUND_SELECT: number;
    LIMIT_VDBE_OP: number;
    LIMIT_FUNCTION_ARG: number;
    LIMIT_ATTACHED: number;
    LIMIT_LIKE_PATTERN_LENGTH: number;
    LIMIT_VARIABLE_NUMBER: number;
    LIMIT_TRIGGER_DEPTH: number;
    LIMIT_WORKER_THREADS: number;

    cached: typeof cached;
    RunResult: RunResult;
    Statement: typeof Statement;
    Database: typeof Database;
    Backup: typeof Backup;
    verbose(): this;
    /** @since 9.0.0 */
    open: typeof open;
}
