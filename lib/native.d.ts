// Hand-written declarations for the native layer — the shape of the module
// that lib/sqlite3-binding.js loads from src/*.cc. This is the honest
// hand-written island of the generation pipeline (Deliverable 04): the
// classes and constants the C++ addon exports. Every JS-layer addition
// (the dual-mode promise wrappers, iterate/stream/transaction, events,
// disposal) is declared in lib/augment.d.ts and the JSDoc of lib/*.js,
// and merged in by the compiler; the shipped lib/sqlite3.d.ts is
// generated from all of it by `pnpm run gen-types`.
//
// Members that lib/promises.js rewraps in dual mode (run/get/all/each/
// map/bind/reset/finalize/close/exec/wait/loadExtension/step/finish) are
// declared there, not here: merged interface overloads resolve after the
// class's own, so a native optional-callback form on the class would
// shadow the promise overloads. The island keeps what reaches users
// unwrapped. Members marked `@internal` exist at runtime but only for
// the JS layer in lib/.

import { EventEmitter } from 'node:events';

/**
 * A value that can be bound to a `?`, `:name`, `$name` or `@name`
 * parameter. Anything else raises a `TypeError` naming the parameter
 * (strict binding since 9.0.0).
 */
export type BindValue =
    | string
    | number
    | bigint
    | boolean
    | null
    | undefined
    | Uint8Array
    | ArrayBuffer
    | DataView
    | Date
    | RegExp;

/**
 * How a call's bind parameters may be passed: as one array or named
 * object, or variadic as individual values.
 */
export type BindParams =
    | BindValue[]
    | Record<string, BindValue>
    | [Record<string, BindValue>];

/**
 * One result row of an untyped query: column names to marshalled values.
 * Values are `number | bigint` for INTEGER columns depending on the
 * integer mode, `string`, `Uint8Array` for BLOBs, and `null`.
 */
export type Row = Record<string, unknown>;

/**
 * How INTEGER columns and `lastID` are converted to JS.
 *
 * - `'number'` (default): numbers when safely representable, a
 *   `RangeError` otherwise (never a silently truncated double).
 * - `'bigint'`: always BigInt.
 * - `'mixed'`: number when safe, BigInt otherwise.
 *
 * @since 9.0.0
 */
export type IntegerMode = 'number' | 'bigint' | 'mixed';

/**
 * The error delivered to callbacks, emitted on `'error'`, or thrown by
 * sync methods. Since 9.0.0 `code` is the extended result-code name
 * (`SQLITE_CONSTRAINT_PRIMARYKEY`), `primaryCode` the primary one
 * (`SQLITE_CONSTRAINT`), and `errno` the extended numeric code.
 */
export interface SqliteError extends Error {
    /** Extended result-code name, e.g. `SQLITE_CONSTRAINT_PRIMARYKEY`. */
    code: string;
    /** Primary result-code name, e.g. `SQLITE_CONSTRAINT`. */
    primaryCode: string;
    /** Extended numeric result code, e.g. `1555`. */
    errno: number;
}

/**
 * The `this` of `run()` callbacks: the statement that ran, carrying its
 * `lastID`/`changes` accessors. A number when safely representable, a
 * BigInt in `'bigint'`/`'mixed'` integer mode, and a `RangeError` when
 * read in `'number'` mode after an insert with an unsafe rowid.
 */
export interface RunResult extends Statement {}

/**
 * A connection to a SQLite database file.
 *
 * Constructed with `new Database(filename, mode?, callback?)` or, in
 * promise form, with the namespace `open()`. Runs work on a background
 * thread through a FIFO queue; the synchronous `*Sync` methods require
 * the connection to be fully idle.
 */
export declare class Database extends EventEmitter {
    /**
     * Opens a database connection. The open itself is asynchronous; the
     * callback fires (or the `'open'` event emits) once it completes.
     *
     * @param filename path to the database file, `:memory:` or `''`.
     * @param mode bitwise OR of OPEN_* flags; defaults to read-write
     *   create with FULLMUTEX.
     * @param callback called with an error when the open fails.
     * @throws {TypeError} If filename is not a string.
     */
    constructor(
        filename: string,
        mode?: number,
        callback?: (this: Database, err: SqliteError | null) => void,
    );

    /** The filename this connection was opened with. */
    readonly filename: string;

    /** The OPEN_* flag set this connection was opened with. */
    readonly mode: number;

    /**
     * Puts the database in serialized mode: all subsequent work runs in
     * strict FIFO order (statement operations pass through the queue).
     * With a callback, restores the previous mode after it completes.
     *
     * @param callback run inside serialized mode.
     * @returns this database, for chaining.
     */
    serialize(callback?: () => void): this;

    /**
     * Leaves serialized mode: statement operations may again complete
     * ahead of queued database work.
     *
     * @param callback run inside parallelized mode.
     * @returns this database, for chaining.
     */
    parallelize(callback?: () => void): this;

    /**
     * Configures the connection.
     *
     * @param option `'busyTimeout'` to set the busy handler timeout.
     * @param value the timeout in milliseconds.
     * @returns this database, for chaining.
     */
    configure(option: 'busyTimeout', value: number): this;
    /**
     * Configures the connection.
     *
     * @param option `'limit'` to change a run-time limit.
     * @param id one of the LIMIT_* constants.
     * @param value the new limit, or -1 to keep the current one.
     */
    configure(option: 'limit', id: number, value: number): this;
    /**
     * Configures the connection.
     *
     * @param option `'trace'`, `'profile'` or `'change'` to enable or
     *   disable the corresponding event.
     * @param value whether the event should be emitted.
     */
    configure(option: 'trace' | 'profile' | 'change', value: boolean): this;
    /**
     * Configures the connection.
     *
     * @param option `'integerMode'` to set how INTEGER columns and
     *   `lastID` are converted to JS.
     * @param value one of `'number'`, `'bigint'`, `'mixed'`.
     * @since 9.0.0
     */
    configure(option: 'integerMode', value: IntegerMode): this;

    /**
     * Interrupts every in-flight and queued database operation from
     * another thread; they fail with SQLITE_INTERRUPT. Also used by
     * AbortSignal handling (a cancellation is connection-wide).
     *
     * @returns this database, for chaining.
     */
    interrupt(): this;

    /**
     * True while an exclusive operation (exec/close/wait/loadExtension)
     * is running or waiting on the queue. Used by the statement cache in
     * lib/sqlite3.js to avoid overtaking it.
     *
     * @deprecated Use {@link Database.state} instead. Kept as an alias
     *   for one minor version; removed in a future release.
     * @internal
     * @returns whether the database queue is busy.
     */
    _queueBusy(): boolean;

    /** True from construction until `close()` completes. */
    readonly open: boolean;

    /**
     * The active integer mode; see {@link IntegerMode}.
     *
     * @since 9.0.0
     */
    readonly integerMode: IntegerMode;

    /**
     * A frozen snapshot of the connection's scheduling state, computed on
     * read from the native side — the authoritative source, replacing the
     * former JS-side `_serialized`/`_closing` mirrors (which could drift
     * when `serialize()`/`parallelize()` was reached other than through
     * the patched prototype).
     *
     * The individual fields are also exposed directly as accessors
     * ({@link closing}, {@link locked}, {@link serialized},
     * {@link pending}, {@link queued}) for hot paths: constructing the
     * frozen object on every call measurably slows the statement cache.
     *
     * @since 9.0.0
     */
    readonly state: DatabaseState;

    /**
     * True while an asynchronous close is in flight; the snapshot field
     * {@link DatabaseState.closing}. Also exposed individually because
     * the statement cache reads it on every cached call.
     *
     * @since 9.0.0
     */
    readonly closing: boolean;

    /**
     * True while an exclusive operation (exec/close/wait/loadExtension)
     * is running or waiting; the snapshot field
     * {@link DatabaseState.locked}.
     *
     * @since 9.0.0
     */
    readonly locked: boolean;

    /**
     * True while the connection is in serialize mode (strict FIFO); the
     * snapshot field {@link DatabaseState.serialized}.
     *
     * @since 9.0.0
     */
    readonly serialized: boolean;

    /**
     * Operations currently in flight on the connection; the snapshot
     * field {@link DatabaseState.pending}. Statement work bypasses the
     * database queue, so this is not the length of {@link queued}.
     *
     * @since 9.0.0
     */
    readonly pending: number;

    /**
     * Calls waiting in the database queue; the snapshot field
     * {@link DatabaseState.queued}.
     *
     * @since 9.0.0
     */
    readonly queued: number;
}

/**
 * The scheduling state of a connection, as a frozen object computed on
 * read (`db.state`). Every field is main-thread state; the object is a
 * snapshot, so fields are consistent with each other but may change
 * immediately after the read.
 *
 * - `open`: the connection is open (true from open until close
 *   completes).
 * - `closing`: an asynchronous close is in flight.
 * - `locked`: an exclusive operation (exec/close/wait/loadExtension) is
 *   running or waiting; statement operations must not overtake it.
 * - `serialized`: the connection is in serialize mode (strict FIFO).
 * - `pending`: operations currently in flight on the connection
 *   (statement work bypasses the database queue, so this is not the
 *   length of `queued`).
 * - `queued`: calls waiting in the database queue.
 *
 * @since 9.0.0
 */
export interface DatabaseState {
    /** True from open until close completes. */
    open: boolean;
    /** True while an asynchronous close is in flight. */
    closing: boolean;
    /** True while an exclusive operation is running or waiting. */
    locked: boolean;
    /** True while the connection is in serialize mode. */
    serialized: boolean;
    /** Operations currently in flight on the connection. */
    pending: number;
    /** Calls waiting in the database queue. */
    queued: number;
}

/**
 * What `runSync()` resolves to on both `Database` and `Statement`.
 * `changes` is a plain safe number; `lastID` applies the connection's
 * integer mode (`number` or `bigint`). On the statement form `lastID`
 * is lazy: the `'number'`-mode `RangeError` for an unsafe rowid fires
 * when the field is read.
 *
 * @since 9.0.0
 */
export interface StatementRunSyncResult {
    /** The inserted rowid, subject to the integer mode. */
    lastID: number | bigint;
    /** Rows changed by the statement. */
    changes: number;
}

/**
 * A prepared statement, created with `new Statement(db, sql)`,
 * `db.prepare()` or `db.prepareSync()`. Binds and steps on a background
 * thread; carries the `lastID`/`changes` of its most recent `run()`.
 */
export declare class Statement extends EventEmitter {
    /**
     * Prepares a statement. Preparation itself is asynchronous; calls
     * issued before it completes are queued.
     *
     * @param database the owning connection.
     * @param sql the SQL statement to prepare.
     * @param callback called with an error when preparation fails.
     * @param syncPrepare prepare synchronously on the main thread
     *   instead; throws when the database is not fully idle.
     * @throws {TypeError} If the arguments have the wrong types.
     */
    constructor(
        database: Database,
        sql: string,
        callback?: (this: Statement, err: SqliteError | null) => void,
        syncPrepare?: boolean,
    );

    /** The SQL text this statement was constructed with. */
    readonly sql: string;

    /**
     * Steps up to `count` rows into one batch without resetting between
     * calls, so successive fetches continue one cursor. The native
     * backing of `iterate()`; usable directly for paged reads.
     *
     * @param args the maximum number of rows to fetch (>= 1), then bind
     *   parameters (bound on the first fetch of a run), then the
     *   callback receiving `(err, rows, done)`.
     * @returns this statement, for chaining.
     * @since 9.0.0
     */
    fetch(
        ...args: (
            | number
            | BindValue
            | BindParams
            | ((
                  this: Statement,
                  err: SqliteError | null,
                  rows: Row[],
                  done: boolean,
              ) => void)
        )[]
    ): this;

    /**
     * Synchronous fast path: steps once on the main thread and returns
     * the first row.
     *
     * @param params parameters as one array/named object or variadic
     *   values.
     * @returns the row, or undefined when the statement yields none.
     * @throws {Error} When the database is not fully idle, from inside an
     *   async completion callback, on an unsupported bind type, or when a
     *   callback is passed.
     */
    getSync(...params: (BindValue | BindParams)[]): Row | undefined;

    /**
     * Synchronous fast path: steps once on the main thread and records
     * `lastID`/`changes`. Returns the statement itself (not a result
     * object) so calls chain, unlike `Database#runSync`, whose private
     * statement it cannot return — read `lastID`/`changes` off the
     * statement; they stay lazy, so the `'number'`-mode `RangeError`
     * for an unsafe rowid fires on read.
     *
     * @param params parameters as one array/named object or variadic
     *   values.
     * @returns this statement — read `lastID`/`changes` off it.
     * @throws {Error} When the database is not fully idle, from inside an
     *   async completion callback, on an unsupported bind type, or when a
     *   callback is passed.
     */
    runSync(...params: (BindValue | BindParams)[]): this;

    /**
     * Synchronous fast path: steps through every row on the main thread.
     *
     * @param params parameters as one array/named object or variadic
     *   values.
     * @returns every result row.
     * @throws {Error} When the database is not fully idle, from inside an
     *   async completion callback, on an unsupported bind type, or when a
     *   callback is passed.
     */
    allSync(...params: (BindValue | BindParams)[]): Row[];

    /**
     * Rowid of the last `run()`: a number when safely representable, a
     * BigInt in `'bigint'`/`'mixed'` integer mode, and a `RangeError`
     * otherwise (the `'number'` default refuses to truncate). Undefined
     * before the first run.
     */
    readonly lastID: number | bigint | undefined;

    /**
     * Rowid of the last `run()` as a BigInt, exact in every integer
     * mode. Undefined before the first run.
     *
     * @since 9.0.0
     */
    readonly lastIDBigInt: bigint | undefined;

    /**
     * Number of rows changed by the last `run()`. Undefined before the
     * first run.
     */
    readonly changes: number | undefined;

    /**
     * True once the statement has been finalized: explicitly with
     * `finalize()`, automatically after a failed prepare, or by the GC
     * safety net. Operations on a finalized statement fail with
     * `SQLITE_MISUSE`.
     *
     * @since 9.0.0
     */
    readonly finalized: boolean;
}

/**
 * An online backup between two database handles, created with
 * `db.backup(filename)` (which returns it synchronously).
 */
export declare class Backup extends EventEmitter {
    /**
     * Creates a backup object. Prefer `db.backup()`, which fills in the
     * source/destination names and the retry list.
     *
     * @param database the source connection.
     * @param filename the file to back up to (or from).
     * @param sourceName the source database name (usually `'main'`).
     * @param destName the destination database name (usually `'main'`).
     * @param filenameIsDest true when filename is the destination.
     * @param callback called once the backup handle is ready.
     * @throws {TypeError} Unless called with `new` and these arguments.
     */
    constructor(
        database: Database,
        filename: string,
        sourceName: string,
        destName: string,
        filenameIsDest: boolean,
        callback?: (this: Backup, err: SqliteError | null) => void,
    );

    /** The file the backup writes to (or reads from). */
    readonly filename: string;

    /** The source database name. */
    readonly sourceName: string;

    /** The destination database name. */
    readonly destName: string;

    /** True when `filename` is the destination of the backup. */
    readonly filenameIsDest: boolean;

    /** True when no step is in flight. */
    readonly idle: boolean;

    /** True when the backup has fully copied. */
    readonly completed: boolean;

    /** True when the backup failed unrecoverably. */
    readonly failed: boolean;

    /** Pages still to copy. */
    readonly remaining: number;

    /** Total pages in the source database. */
    readonly pageCount: number;

    /**
     * Result codes retried on the next step instead of failing the
     * backup. `db.backup()` presets `[BUSY, LOCKED]`.
     */
    retryErrors: number[];
}

/**
 * The object the native addon exports: the three classes plus every
 * SQLite constant with its literal value, so flag combinations like
 * `OPEN_READWRITE | OPEN_CREATE` are checkable. The public namespace
 * type (`sqlite3` from `import sqlite3 from '@appthreat/sqlite3'`) is
 * this shape plus the JS-layer `verbose`, `cached` and `open`.
 */
declare const binding: {
    /** The Database class constructor. */
    Database: typeof Database;

    /** The Statement class constructor. */
    Statement: typeof Statement;

    /** The Backup class constructor. */
    Backup: typeof Backup;

    // Open flags for the `mode` argument of `new Database(filename, mode)`.
    /** Open flag: open the database for reading only. */ readonly OPEN_READONLY: 1;
    /** Open flag: open the database for reading and writing. */ readonly OPEN_READWRITE: 2;
    /** Open flag: create the database if it does not exist. */ readonly OPEN_CREATE: 4;
    /** Open flag: open the database with a shared connection mutex (serialized). */ readonly OPEN_FULLMUTEX: 65536;
    /** Open flag: interpret the filename as a URI (`file:...` with query parameters). */ readonly OPEN_URI: 64;
    /** Open flag: share the page cache between connections. */ readonly OPEN_SHAREDCACHE: 131072;
    /** Open flag: use a private page cache for this connection. */ readonly OPEN_PRIVATECACHE: 262144;
    /** Open flag: open with a per-connection mutex (multi-thread mode). */ readonly OPEN_NOMUTEX: 32768;
    /** Open flag: the database is always in-memory. */ readonly OPEN_MEMORY: 128;
    /** Open flag: return extended result codes from sqlite3_step. */ readonly OPEN_EXRESCODE: 33554432;

    // Compiled-in SQLite version identifiers.
    /** The compiled-in SQLite library version string. */ readonly VERSION: '3.53.4';
    /** The compiled-in SQLite source identifier. */ readonly SOURCE_ID: '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc';
    /** The compiled-in SQLite version as an integer (e.g. 3053004). */ readonly VERSION_NUMBER: 3053004;

    // Primary SQLite result codes.
    /** Result code: SQLITE_OK (success). */ readonly OK: 0;
    /** Result code: SQLITE_ERROR. */ readonly ERROR: 1;
    /** Result code: SQLITE_INTERNAL. */ readonly INTERNAL: 2;
    /** Result code: SQLITE_PERM. */ readonly PERM: 3;
    /** Result code: SQLITE_ABORT. */ readonly ABORT: 4;
    /** Result code: SQLITE_BUSY. */ readonly BUSY: 5;
    /** Result code: SQLITE_LOCKED. */ readonly LOCKED: 6;
    /** Result code: SQLITE_NOMEM. */ readonly NOMEM: 7;
    /** Result code: SQLITE_READONLY. */ readonly READONLY: 8;
    /** Result code: SQLITE_INTERRUPT. */ readonly INTERRUPT: 9;
    /** Result code: SQLITE_IOERR. */ readonly IOERR: 10;
    /** Result code: SQLITE_CORRUPT. */ readonly CORRUPT: 11;
    /** Result code: SQLITE_NOTFOUND. */ readonly NOTFOUND: 12;
    /** Result code: SQLITE_FULL. */ readonly FULL: 13;
    /** Result code: SQLITE_CANTOPEN. */ readonly CANTOPEN: 14;
    /** Result code: SQLITE_PROTOCOL. */ readonly PROTOCOL: 15;
    /** Result code: SQLITE_EMPTY. */ readonly EMPTY: 16;
    /** Result code: SQLITE_SCHEMA. */ readonly SCHEMA: 17;
    /** Result code: SQLITE_TOOBIG. */ readonly TOOBIG: 18;
    /** Result code: SQLITE_CONSTRAINT. */ readonly CONSTRAINT: 19;
    /** Result code: SQLITE_MISMATCH. */ readonly MISMATCH: 20;
    /** Result code: SQLITE_MISUSE. */ readonly MISUSE: 21;
    /** Result code: SQLITE_NOLFS. */ readonly NOLFS: 22;
    /** Result code: SQLITE_AUTH. */ readonly AUTH: 23;
    /** Result code: SQLITE_FORMAT. */ readonly FORMAT: 24;
    /** Result code: SQLITE_RANGE. */ readonly RANGE: 25;
    /** Result code: SQLITE_NOTADB. */ readonly NOTADB: 26;

    // Extended result codes. Since 9.0.0 errors carry the extended code in
    // `err.code`/`err.errno` and the primary code in `err.primaryCode`.
    /** Extended result code: SQLITE_ERROR_MISSING_COLLSEQ. @since 9.0.0 */ readonly ERROR_MISSING_COLLSEQ: 257;
    /** Extended result code: SQLITE_ERROR_RETRY. @since 9.0.0 */ readonly ERROR_RETRY: 513;
    /** Extended result code: SQLITE_ERROR_SNAPSHOT. @since 9.0.0 */ readonly ERROR_SNAPSHOT: 769;
    /** Extended result code: SQLITE_ERROR_RESERVESIZE. @since 9.0.0 */ readonly ERROR_RESERVESIZE: 1025;
    /** Extended result code: SQLITE_ERROR_KEY. @since 9.0.0 */ readonly ERROR_KEY: 1281;
    /** Extended result code: SQLITE_ERROR_UNABLE. @since 9.0.0 */ readonly ERROR_UNABLE: 1537;
    /** Extended result code: SQLITE_IOERR_READ. @since 9.0.0 */ readonly IOERR_READ: 266;
    /** Extended result code: SQLITE_IOERR_SHORT_READ. @since 9.0.0 */ readonly IOERR_SHORT_READ: 522;
    /** Extended result code: SQLITE_IOERR_WRITE. @since 9.0.0 */ readonly IOERR_WRITE: 778;
    /** Extended result code: SQLITE_IOERR_FSYNC. @since 9.0.0 */ readonly IOERR_FSYNC: 1034;
    /** Extended result code: SQLITE_IOERR_DIR_FSYNC. @since 9.0.0 */ readonly IOERR_DIR_FSYNC: 1290;
    /** Extended result code: SQLITE_IOERR_TRUNCATE. @since 9.0.0 */ readonly IOERR_TRUNCATE: 1546;
    /** Extended result code: SQLITE_IOERR_FSTAT. @since 9.0.0 */ readonly IOERR_FSTAT: 1802;
    /** Extended result code: SQLITE_IOERR_UNLOCK. @since 9.0.0 */ readonly IOERR_UNLOCK: 2058;
    /** Extended result code: SQLITE_IOERR_RDLOCK. @since 9.0.0 */ readonly IOERR_RDLOCK: 2314;
    /** Extended result code: SQLITE_IOERR_DELETE. @since 9.0.0 */ readonly IOERR_DELETE: 2570;
    /** Extended result code: SQLITE_IOERR_BLOCKED. @since 9.0.0 */ readonly IOERR_BLOCKED: 2826;
    /** Extended result code: SQLITE_IOERR_NOMEM. @since 9.0.0 */ readonly IOERR_NOMEM: 3082;
    /** Extended result code: SQLITE_IOERR_ACCESS. @since 9.0.0 */ readonly IOERR_ACCESS: 3338;
    /** Extended result code: SQLITE_IOERR_CHECKRESERVEDLOCK. @since 9.0.0 */ readonly IOERR_CHECKRESERVEDLOCK: 3594;
    /** Extended result code: SQLITE_IOERR_LOCK. @since 9.0.0 */ readonly IOERR_LOCK: 3850;
    /** Extended result code: SQLITE_IOERR_CLOSE. @since 9.0.0 */ readonly IOERR_CLOSE: 4106;
    /** Extended result code: SQLITE_IOERR_DIR_CLOSE. @since 9.0.0 */ readonly IOERR_DIR_CLOSE: 4362;
    /** Extended result code: SQLITE_IOERR_SHMOPEN. @since 9.0.0 */ readonly IOERR_SHMOPEN: 4618;
    /** Extended result code: SQLITE_IOERR_SHMSIZE. @since 9.0.0 */ readonly IOERR_SHMSIZE: 4874;
    /** Extended result code: SQLITE_IOERR_SHMLOCK. @since 9.0.0 */ readonly IOERR_SHMLOCK: 5130;
    /** Extended result code: SQLITE_IOERR_SHMMAP. @since 9.0.0 */ readonly IOERR_SHMMAP: 5386;
    /** Extended result code: SQLITE_IOERR_SEEK. @since 9.0.0 */ readonly IOERR_SEEK: 5642;
    /** Extended result code: SQLITE_IOERR_DELETE_NOENT. @since 9.0.0 */ readonly IOERR_DELETE_NOENT: 5898;
    /** Extended result code: SQLITE_IOERR_MMAP. @since 9.0.0 */ readonly IOERR_MMAP: 6154;
    /** Extended result code: SQLITE_IOERR_GETTEMPPATH. @since 9.0.0 */ readonly IOERR_GETTEMPPATH: 6410;
    /** Extended result code: SQLITE_IOERR_CONVPATH. @since 9.0.0 */ readonly IOERR_CONVPATH: 6666;
    /** Extended result code: SQLITE_IOERR_VNODE. @since 9.0.0 */ readonly IOERR_VNODE: 6922;
    /** Extended result code: SQLITE_IOERR_AUTH. @since 9.0.0 */ readonly IOERR_AUTH: 7178;
    /** Extended result code: SQLITE_IOERR_BEGIN_ATOMIC. @since 9.0.0 */ readonly IOERR_BEGIN_ATOMIC: 7434;
    /** Extended result code: SQLITE_IOERR_COMMIT_ATOMIC. @since 9.0.0 */ readonly IOERR_COMMIT_ATOMIC: 7690;
    /** Extended result code: SQLITE_IOERR_ROLLBACK_ATOMIC. @since 9.0.0 */ readonly IOERR_ROLLBACK_ATOMIC: 7946;
    /** Extended result code: SQLITE_IOERR_DATA. @since 9.0.0 */ readonly IOERR_DATA: 8202;
    /** Extended result code: SQLITE_IOERR_CORRUPTFS. @since 9.0.0 */ readonly IOERR_CORRUPTFS: 8458;
    /** Extended result code: SQLITE_IOERR_IN_PAGE. @since 9.0.0 */ readonly IOERR_IN_PAGE: 8714;
    /** Extended result code: SQLITE_IOERR_BADKEY. @since 9.0.0 */ readonly IOERR_BADKEY: 8970;
    /** Extended result code: SQLITE_IOERR_CODEC. @since 9.0.0 */ readonly IOERR_CODEC: 9226;
    /** Extended result code: SQLITE_LOCKED_SHAREDCACHE. @since 9.0.0 */ readonly LOCKED_SHAREDCACHE: 262;
    /** Extended result code: SQLITE_LOCKED_VTAB. @since 9.0.0 */ readonly LOCKED_VTAB: 518;
    /** Extended result code: SQLITE_BUSY_RECOVERY. @since 9.0.0 */ readonly BUSY_RECOVERY: 261;
    /** Extended result code: SQLITE_BUSY_SNAPSHOT. @since 9.0.0 */ readonly BUSY_SNAPSHOT: 517;
    /** Extended result code: SQLITE_BUSY_TIMEOUT. @since 9.0.0 */ readonly BUSY_TIMEOUT: 773;
    /** Extended result code: SQLITE_CANTOPEN_NOTEMPDIR. @since 9.0.0 */ readonly CANTOPEN_NOTEMPDIR: 270;
    /** Extended result code: SQLITE_CANTOPEN_ISDIR. @since 9.0.0 */ readonly CANTOPEN_ISDIR: 526;
    /** Extended result code: SQLITE_CANTOPEN_FULLPATH. @since 9.0.0 */ readonly CANTOPEN_FULLPATH: 782;
    /** Extended result code: SQLITE_CANTOPEN_CONVPATH. @since 9.0.0 */ readonly CANTOPEN_CONVPATH: 1038;
    /** Extended result code: SQLITE_CANTOPEN_DIRTYWAL. @since 9.0.0 */ readonly CANTOPEN_DIRTYWAL: 1294;
    /** Extended result code: SQLITE_CANTOPEN_SYMLINK. @since 9.0.0 */ readonly CANTOPEN_SYMLINK: 1550;
    /** Extended result code: SQLITE_CORRUPT_VTAB. @since 9.0.0 */ readonly CORRUPT_VTAB: 267;
    /** Extended result code: SQLITE_CORRUPT_SEQUENCE. @since 9.0.0 */ readonly CORRUPT_SEQUENCE: 523;
    /** Extended result code: SQLITE_CORRUPT_INDEX. @since 9.0.0 */ readonly CORRUPT_INDEX: 779;
    /** Extended result code: SQLITE_READONLY_RECOVERY. @since 9.0.0 */ readonly READONLY_RECOVERY: 264;
    /** Extended result code: SQLITE_READONLY_CANTLOCK. @since 9.0.0 */ readonly READONLY_CANTLOCK: 520;
    /** Extended result code: SQLITE_READONLY_ROLLBACK. @since 9.0.0 */ readonly READONLY_ROLLBACK: 776;
    /** Extended result code: SQLITE_READONLY_DBMOVED. @since 9.0.0 */ readonly READONLY_DBMOVED: 1032;
    /** Extended result code: SQLITE_READONLY_CANTINIT. @since 9.0.0 */ readonly READONLY_CANTINIT: 1288;
    /** Extended result code: SQLITE_READONLY_DIRECTORY. @since 9.0.0 */ readonly READONLY_DIRECTORY: 1544;
    /** Extended result code: SQLITE_ABORT_ROLLBACK. @since 9.0.0 */ readonly ABORT_ROLLBACK: 516;
    /** Extended result code: SQLITE_CONSTRAINT_CHECK. @since 9.0.0 */ readonly CONSTRAINT_CHECK: 275;
    /** Extended result code: SQLITE_CONSTRAINT_COMMITHOOK. @since 9.0.0 */ readonly CONSTRAINT_COMMITHOOK: 531;
    /** Extended result code: SQLITE_CONSTRAINT_FOREIGNKEY. @since 9.0.0 */ readonly CONSTRAINT_FOREIGNKEY: 787;
    /** Extended result code: SQLITE_CONSTRAINT_FUNCTION. @since 9.0.0 */ readonly CONSTRAINT_FUNCTION: 1043;
    /** Extended result code: SQLITE_CONSTRAINT_NOTNULL. @since 9.0.0 */ readonly CONSTRAINT_NOTNULL: 1299;
    /** Extended result code: SQLITE_CONSTRAINT_PRIMARYKEY. @since 9.0.0 */ readonly CONSTRAINT_PRIMARYKEY: 1555;
    /** Extended result code: SQLITE_CONSTRAINT_TRIGGER. @since 9.0.0 */ readonly CONSTRAINT_TRIGGER: 1811;
    /** Extended result code: SQLITE_CONSTRAINT_UNIQUE. @since 9.0.0 */ readonly CONSTRAINT_UNIQUE: 2067;
    /** Extended result code: SQLITE_CONSTRAINT_VTAB. @since 9.0.0 */ readonly CONSTRAINT_VTAB: 2323;
    /** Extended result code: SQLITE_CONSTRAINT_ROWID. @since 9.0.0 */ readonly CONSTRAINT_ROWID: 2579;
    /** Extended result code: SQLITE_CONSTRAINT_PINNED. @since 9.0.0 */ readonly CONSTRAINT_PINNED: 2835;
    /** Extended result code: SQLITE_CONSTRAINT_DATATYPE. @since 9.0.0 */ readonly CONSTRAINT_DATATYPE: 3091;
    /** Extended result code: SQLITE_AUTH_USER. @since 9.0.0 */ readonly AUTH_USER: 279;

    // Run-time limit identifiers for `configure('limit', id, value)`.
    /** Limit id: maximum length of a string, BLOB or table column. */ readonly LIMIT_LENGTH: 0;
    /** Limit id: maximum length of an SQL statement. */ readonly LIMIT_SQL_LENGTH: 1;
    /** Limit id: maximum number of columns in a table or index. */ readonly LIMIT_COLUMN: 2;
    /** Limit id: maximum expression tree depth. */ readonly LIMIT_EXPR_DEPTH: 3;
    /** Limit id: maximum number of terms in a compound SELECT. */ readonly LIMIT_COMPOUND_SELECT: 4;
    /** Limit id: maximum number of virtual machine opcodes. */ readonly LIMIT_VDBE_OP: 5;
    /** Limit id: maximum number of function arguments. */ readonly LIMIT_FUNCTION_ARG: 6;
    /** Limit id: maximum number of attached databases. */ readonly LIMIT_ATTACHED: 7;
    /** Limit id: maximum LIKE/GLOB pattern length. */ readonly LIMIT_LIKE_PATTERN_LENGTH: 8;
    /** Limit id: maximum index of a bind parameter. */ readonly LIMIT_VARIABLE_NUMBER: 9;
    /** Limit id: maximum nested trigger depth. */ readonly LIMIT_TRIGGER_DEPTH: 10;
    /** Limit id: maximum number of auxiliary worker threads. */ readonly LIMIT_WORKER_THREADS: 11;
};

/**
 * The shape of the native addon's export object, as a named type for
 * JSDoc references (`import('./native.js').default` is not addressable
 * in type position by tsc's node16 resolver).
 */
export type NativeBinding = typeof binding;

export default binding;
