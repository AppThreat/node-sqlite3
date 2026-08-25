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

export class Statement extends events.EventEmitter {
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
    verbose(): this;
}
