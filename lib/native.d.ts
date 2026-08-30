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
 * Options accepted by `Database#function` and `Database#aggregate`.
 *
 * - `deterministic` claims the function always returns the same output
 *   for the same input — required for indexes and generated columns, and
 *   a false claim silently corrupts results, hence opt-in.
 * - `directOnly` (default `true`) keeps the function out of triggers,
 *   views, CHECK constraints and index expressions in attacker-supplied
 *   schema SQL; opting out must be explicit.
 * - `innocuous` marks the function as safe inside schema SQL even when
 *   used without `directOnly`.
 * - `varargs` accepts any number of arguments; without it the arity comes
 *   from the implementation's `length`.
 *
 * @since 9.0.0
 */
export type FunctionOptions = {
    /** Claim output depends only on the inputs (SQLITE_DETERMINISTIC). */
    deterministic?: boolean;
    /** Restrict to direct top-level SQL (SQLITE_DIRECTONLY). Default true. */
    directOnly?: boolean;
    /** Mark safe for schema SQL (SQLITE_INNOCUOUS). */
    innocuous?: boolean;
    /** Accept any number of arguments. */
    varargs?: boolean;
};

/**
 * The implementation object `Database#aggregate` registers: `start`
 * creates an accumulator, `step` folds one row into it, `result` produces
 * the final value, and a provided `inverse` turns the aggregate into a
 * window function by removing a row that left the frame.
 *
 * @since 9.0.0
 */
export type AggregateDefinition = FunctionOptions & {
    /** Creates the accumulator for a new group. */
    start: (this: undefined) => unknown;
    /** Folds one row's arguments into the accumulator; returns the new one. */
    step: (this: undefined, acc: unknown, ...args: unknown[]) => unknown;
    /** Produces the aggregate's value from the accumulator. */
    result: (this: undefined, acc: unknown) => unknown;
    /**
     * Removes one row's arguments from the accumulator (window functions
     * only). Providing it registers the aggregate via
     * `sqlite3_create_window_function`.
     */
    inverse?: (this: undefined, acc: unknown, ...args: unknown[]) => unknown;
};

/**
 * One result row of an untyped query: column names to marshalled values.
 * Values are `number | bigint` for INTEGER columns depending on the
 * integer mode, `string`, `Uint8Array` for BLOBs, and `null`.
 */
export type Row = Record<string, unknown>;

/**
 * Row-shape options for the synchronous read paths (`getSync`/`allSync`).
 *
 * - `'object'` (the default) keeps the historical shape: one plain object
 *   per row on `Object.prototype`, in result-column order, with a
 *   duplicate column name collapsing to the last value.
 * - `'array'` yields one array per row instead — values in result-column
 *   order, duplicate column names keeping every value. The bulk-reader
 *   shape for CSV export / ETL / `SELECT` into a typed structure; it
 *   skips the per-cell property stores entirely and is the fastest row
 *   the synchronous paths can build.
 *
 * The option is recognised as a trailing `{ rowMode: ... }` argument; a
 * named bind parameter could never have that bare key (bind keys carry a
 * sigil or are positional numbers), so it is unambiguous.
 *
 * @since 9.0.0
 */
export interface SyncRowModeOptions {
    /** The requested row shape. */
    rowMode?: 'object' | 'array';
}

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
 * Options for `configure('extensionPolicy', …)`.
 *
 * @since 9.0.0
 */
export type ExtensionPolicyOptions = {
    /**
     * The only paths `loadExtension` may load. Under the permission model
     * each entry must also be fs.read-permitted.
     */
    allow?: string[];
    /** Permanently disable `loadExtension` on this connection. */
    deny?: boolean;
};

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
     * @param option `'trace'`, `'profile'`, `'change'`, `'commit'`,
     *   `'rollback'` or `'wal'` to enable or disable the corresponding
     *   event's native hook (normally done by `on()`/`removeListener()`,
     *   which call this for you).
     * @param value whether the event should be emitted.
     */
    configure(
        option: 'trace' | 'profile' | 'change' | 'commit' | 'rollback' | 'wal',
        value: boolean,
    ): this;
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
     * Configures the connection's extension-loading policy (a JS-layer
     * option, enforced by the Database wrapper in lib/sqlite3.js).
     * `{ allow: [...] }` restricts `loadExtension` to the listed paths;
     * `{ deny: true }` disables it permanently for the connection.
     *
     * @param option `'extensionPolicy'` to set the extension policy.
     * @param value the policy.
     * @since 9.0.0
     */
    configure(option: 'extensionPolicy', value: ExtensionPolicyOptions): this;
    /**
     * Configures the ATTACH-gate allowlist (a JS-layer option, enforced
     * by the native authorizer pre-filter). Every connection opened under
     * the permission model starts with an empty (deny-all) gate; listing
     * paths here allows `ATTACH`/`VACUUM INTO` for exactly those targets.
     * `null` disarms a manually-armed gate.
     *
     * @param option `'attachPaths'` to set the allowed ATTACH targets.
     * @param value the allowed absolute paths, or null to disarm.
     * @since 9.0.0
     */
    configure(option: 'attachPaths', value: string[] | null): this;

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

    // Internal user-function registration entry points (Deliverable 06):
    // option parsing, arity computation and the statement cache flush live
    // in the public wrappers in lib/sqlite3.js. `flags` is the
    // SQLITE_DETERMINISTIC / SQLITE_DIRECTONLY / SQLITE_INNOCUOUS word.

    /**
     * Registers a scalar function implementation.
     *
     * @internal
     * @param name the SQL function name.
     * @param nArg the arity, or -1 for varargs.
     * @param flags the SQLITE_DETERMINISTIC/DIRECTONLY/INNOCUOUS word.
     * @param fn the implementation.
     * @returns this database, for chaining.
     */
    _registerFunction(
        name: string,
        nArg: number,
        flags: number,
        fn: (this: undefined, ...args: unknown[]) => unknown,
    ): this;
    /**
     * Registers an aggregate (or, with `inverse`, a window function).
     *
     * @internal
     * @param name the SQL function name.
     * @param nArg the arity, or -1 for varargs.
     * @param flags ignored for window functions (no flag slot exists).
     * @param start creates the accumulator.
     * @param step folds one row into the accumulator.
     * @param result produces the final value.
     * @param inverse removes a row (window functions only).
     * @returns this database, for chaining.
     */
    _registerAggregate(
        name: string,
        nArg: number,
        flags: number,
        start: (this: undefined) => unknown,
        step: (this: undefined, acc: unknown, ...args: unknown[]) => unknown,
        result: (this: undefined, acc: unknown) => unknown,
        inverse?: (
            this: undefined,
            acc: unknown,
            ...args: unknown[]
        ) => unknown,
    ): this;
    /**
     * Registers a collation comparator.
     *
     * @internal
     * @param name the collation name.
     * @param fn the comparator (negative / zero / positive).
     * @returns this database, for chaining.
     */
    _registerCollation(
        name: string,
        fn: (a: string, b: string) => number,
    ): this;
    /**
     * Removes every registration under the function name.
     *
     * @internal
     * @param name the function name to remove.
     * @returns this database, for chaining.
     */
    _removeFunction(name: string): this;
    /**
     * Removes the collation under the name.
     *
     * @internal
     * @param name the collation name to remove.
     * @returns this database, for chaining.
     */
    _removeCollation(name: string): this;

    // Internal hook/authorizer/progress entry points (Deliverable 07):
    // option parsing and policy normalization live in the public wrappers
    // in lib/sqlite3.js.

    /**
     * Installs the normalized authorizer policy (rule rows are
     * `[action, verdict, arg1, arg2, database, trigger]`, action -1 and
     * empty strings are wildcards, deny rows first), or removes it when
     * called with no arguments.
     *
     * @internal
     * @param defaultDecision one of OK / DENY / IGNORE.
     * @param rules the normalized rule rows.
     * @returns this database, for chaining.
     */
    _setAuthorizer(defaultDecision?: number, rules?: unknown[][]): this;
    /**
     * Arms or disarms the permission-model ATTACH gate: while armed,
     * SQLITE_ATTACH actions (including VACUUM INTO's internal ATTACH) are
     * denied unless the target filename matches the allowlist. In-memory
     * targets always pass. Wrapped by lib/sqlite3.js, which
     * permission-checks each allowlist entry first.
     *
     * @internal
     * @param enabled whether the gate is armed.
     * @param allowedPaths the allowlisted target paths (may be empty).
     * @returns this database, for chaining.
     * @since 9.0.0
     */
    _setAttachGate(enabled: boolean, allowedPaths: string[]): this;
    /**
     * Installs the cancellation-token progress handler (an Int32Array over
     * a SharedArrayBuffer polled every `period` VM instructions), or
     * removes the progress handler when called with no arguments.
     *
     * @internal
     * @param flag the Int32Array flag view.
     * @param period VM instructions between checks.
     * @returns this database, for chaining.
     */
    _progressFlag(flag?: Int32Array, period?: number): this;
    /**
     * Installs the JavaScript progress callback (a blocking round trip
     * per invocation — the documented-slow form), or removes the progress
     * handler when called with no arguments.
     *
     * @internal
     * @param period VM instructions between invocations.
     * @param fn the callback; a truthy return aborts the statement.
     * @returns this database, for chaining.
     */
    _progressCallback(period?: number, fn?: () => unknown): this;
    /**
     * Runs a WAL checkpoint.
     *
     * @internal
     * @param database the attached database name.
     * @param mode a CHECKPOINT_* constant.
     * @param callback receives `{ busy, logFrames, checkpointedFrames }`.
     * @returns this database, for chaining.
     */
    _checkpoint(
        database: string,
        mode: number,
        callback?: (
            this: Database,
            err: SqliteError | null,
            result?: CheckpointResult,
        ) => void,
    ): this;
    /**
     * Reads one table's column metadata.
     *
     * @internal
     * @param database the attached database name.
     * @param table the table name.
     * @param callback receives the column array.
     * @returns this database, for chaining.
     */
    _tableInfo(
        database: string,
        table: string,
        callback?: (
            this: Database,
            err: SqliteError | null,
            columns?: TableColumnInfo[],
        ) => void,
    ): this;
    /**
     * Reads or changes one db_config switch.
     *
     * @internal
     * @param op a DBCONFIG_* constant.
     * @param value 1/0 to set, -1 to query.
     * @param callback receives the previous value as a boolean.
     * @returns this database, for chaining.
     */
    _dbConfig(
        op: number,
        value: number,
        callback?: (
            this: Database,
            err: SqliteError | null,
            value?: boolean,
        ) => void,
    ): this;

    // Internal session/serialization entry points (Deliverable 08):
    // option parsing and policy normalization live in the public
    // wrappers in lib/sqlite3.js. `decision` is a CHANGESET_* constant
    // used when no JS conflict handler is given; the handler functions
    // make the blocking round trip from inside sqlite3changeset_apply.
    // `flags` carries SQLITE_DESERIALIZE_RESIZEABLE / READONLY.

    /**
     * Applies a changeset.
     *
     * @internal
     * @param changeset the changeset bytes.
     * @param decision the CHANGESET_ABORT/OMIT/REPLACE default decision.
     * @param onConflict the JS conflict handler, or null.
     * @param onFilter the JS table filter, or null.
     * @param callback called once the apply completed or rolled back.
     * @returns this database, for chaining.
     */
    _applyChangeset(
        changeset: ChangesetBytes,
        decision: number,
        onConflict:
            | ((info: ChangesetConflict) => 'abort' | 'omit' | 'replace')
            | null,
        onFilter: ((table: string) => boolean) | null,
        callback?: (this: Database, err: SqliteError | null) => void,
    ): this;
    /**
     * Serializes the database to bytes.
     *
     * @internal
     * @param database the attached database name.
     * @param callback receives the bytes.
     * @returns this database, for chaining.
     */
    _serializeToBytes(
        database: string,
        callback?: (
            this: Database,
            err: SqliteError | null,
            bytes: Uint8Array,
        ) => void,
    ): this;
    /**
     * Installs serialized bytes as this connection's `main` schema.
     *
     * @internal
     * @param bytes the serialized database (copied into SQLite-owned
     *   memory; see deserializeFromBytes).
     * @param flags SQLITE_DESERIALIZE_RESIZEABLE / READONLY bits.
     * @param callback called once the image is installed and validated.
     * @returns this database, for chaining.
     */
    _deserialize(
        bytes: ChangesetBytes,
        flags: number,
        callback?: (this: Database, err: SqliteError | null) => void,
    ): this;

    /**
     * Rows changed by the most recent statement on this connection
     * (`sqlite3_changes64`), subject to the integer mode.
     *
     * @since 9.0.0
     */
    readonly changes: number | bigint;

    /**
     * Every row change since the connection opened
     * (`sqlite3_total_changes64`), subject to the integer mode.
     *
     * @since 9.0.0
     */
    readonly totalChanges: number | bigint;
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
 * One rule of a declarative authorizer policy: which SQLite actions are
 * allowed, denied or ignored, optionally narrowed to a table, column,
 * database or trigger. Omitted fields match anything.
 *
 * @since 9.0.0
 */
export interface AuthorizerRule {
    /** One of the CREATE_* / READ / SELECT / … action constants. */
    action?: number;
    /** The first action argument (table for table/read actions, index name for index actions). */
    arg1?: string;
    /** Alias for `arg1`. */
    table?: string;
    /** The second action argument (column for READ). */
    arg2?: string;
    /** Alias for `arg2`. */
    column?: string;
    /** The schema name. */
    database?: string;
    /** The trigger name. */
    trigger?: string;
}

/**
 * A declarative authorization policy for `Database#authorizer`,
 * evaluated inside SQLite itself — no JavaScript runs on the prepare
 * path. `deny` rules are evaluated before `allow` rules, so a deny can
 * never be overridden.
 *
 * @since 9.0.0
 */
export interface AuthorizerPolicy {
    /** The decision for actions no rule matches; `'deny'` makes the policy a sandbox. */
    default?: 'allow' | 'deny' | 'ignore';
    /** Rules that permit (sqlite3.OK). */
    allow?: AuthorizerRule[];
    /** Rules that refuse (sqlite3.DENY); evaluated first. */
    deny?: AuthorizerRule[];
    /** Rules that make SQLite treat the object as nonexistent (sqlite3.IGNORE). */
    ignore?: AuthorizerRule[];
}

/**
 * A cancellation token from `Database#cancellationToken`: a shared flag
 * the native progress handler polls, aborting the running statement the
 * moment it is set. Works from any thread.
 *
 * @since 9.0.0
 */
export interface CancellationToken {
    /** Whether the token has been cancelled. */
    readonly cancelled: boolean;
    /** An AbortSignal that fires with `cancel()`; usable as `{ signal }`. */
    readonly signal: AbortSignal;
    /** The underlying SharedArrayBuffer — postMessage it to a Worker. */
    readonly buffer: SharedArrayBuffer;
    /**
     * Sets the flag (idempotent); aborts every statement on the
     * connection.
     *
     * @param reason the AbortSignal's reason; defaults to the standard
     *   abort error.
     */
    cancel(reason?: unknown): void;
    /** Clears the flag so the token can be reused. Does not revive `signal`. */
    reset(): void;
    /**
     * Removes the underlying progress handler and releases the buffer.
     *
     * A connection has a single progress slot, so a later
     * `cancellationToken()` or `progress()` call takes it over. Calling
     * `destroy()` on a token that no longer holds the slot clears only
     * its own flag and leaves the current handler installed.
     */
    destroy(): void;
}

/** A WAL checkpoint mode. @since 9.0.0 */
export type CheckpointMode = 'passive' | 'full' | 'restart' | 'truncate';

/** Options for `Database#checkpoint`. @since 9.0.0 */
export interface CheckpointOptions {
    /** The checkpoint mode; default `'passive'`. */
    mode?: CheckpointMode;
    /** The attached database to checkpoint; default `'main'`. */
    db?: string;
}

/** The result of `Database#checkpoint`. @since 9.0.0 */
export interface CheckpointResult {
    /** True when another connection's reader or writer prevented the checkpoint. */
    busy: boolean;
    /** Frames in the WAL after the checkpoint. */
    logFrames: number;
    /** Frames copied back into the database file. */
    checkpointedFrames: number;
}

/**
 * One column of a table, as reported by `Database#tableInfo`.
 *
 * @since 9.0.0
 */
export interface TableColumnInfo {
    /** The zero-based column index. */
    cid: number;
    /** The column name. */
    name: string;
    /** The declared type (empty for columns without one). */
    type: string;
    /** Whether the column is NOT NULL. */
    notNull: boolean;
    /** The DEFAULT clause's literal SQL text; present only when the column has one. */
    defaultValue?: string;
    /** 1 for a PRIMARY KEY column (2+ for composite keys). */
    primaryKey: number;
    /** The column's collation. */
    collate: string;
    /** Whether the column is AUTOINCREMENT. */
    autoIncrement: boolean;
}

/**
 * Metadata for one result column of a prepared statement, from the
 * introspection snapshot taken at prepare time. Fields SQLite reports as
 * absent (expression and alias columns have no origin, expression
 * columns no declared type) are omitted, not nulled.
 *
 * @since 9.0.0
 */
export interface ColumnMetadata {
    /** The result column's name. */
    name: string;
    /** The underlying column's declared type, when there is one. */
    declaredType?: string;
    /** The schema the column comes from. */
    database?: string;
    /** The table the column comes from. */
    table?: string;
    /** The column's original name (before an alias). */
    origin?: string;
}

// ---- Sessions, changesets, serialization and blob I/O (Deliverable 08)

/**
 * Binary input the changeset/serialization APIs accept.
 *
 * @since 9.0.0
 */
export type ChangesetBytes = Uint8Array | ArrayBuffer | DataView;

/**
 * Options for `Database#session`.
 *
 * @since 9.0.0
 */
export type SessionOptions = {
    /** The attached database to record (default `'main'`). */
    db?: string;
    /** Record only this table; omit to record every table with a primary key. */
    table?: string;
    /**
     * Mark the recorded changes indirect (sqlite3session_indirect): the
     * changeset consumer decides whether to apply indirect changes.
     */
    indirect?: boolean;
};

/**
 * One change reported by a changeset iterator
 * (`sqlite3.iterateChangeset`). `oldRow`/`newRow` are plain value arrays
 * (integer mode `mixed`: numbers when safe, BigInt otherwise); an
 * UPDATE's arrays carry `null` in the positions sqlite left unset (only
 * primary-key and modified columns are stored).
 *
 * @since 9.0.0
 */
export interface ChangesetOp {
    /** `'insert'`, `'update'` or `'delete'`. */
    op: 'insert' | 'update' | 'delete';
    /** The table the change was recorded on. */
    table: string;
    /** Whether the change was marked indirect. */
    indirect: boolean;
    /** Which columns (by position) are primary keys. */
    primaryKey: boolean[];
    /** The pre-change row, for update/delete changes. */
    oldRow?: unknown[];
    /** The post-change row, for insert/update changes. */
    newRow?: unknown[];
}

/**
 * The conflict description handed to a `Database#applyChangeset` conflict
 * handler. `conflictRow` is the existing database row for `'data'` and
 * `'conflict'` conflicts; `oldRow`/`newRow` carry the change itself.
 *
 * @since 9.0.0
 */
export interface ChangesetConflict {
    /** `'insert'`, `'update'` or `'delete'`. */
    op: 'insert' | 'update' | 'delete';
    /** The table the conflicting change targets. */
    table: string;
    /**
     * Why the handler fired: `'data'` (row changed underneath),
     * `'notFound'` (row gone), `'conflict'` (insert hits an existing
     * key), `'constraint'` or `'foreignKey'`.
     */
    conflict: 'data' | 'notFound' | 'conflict' | 'constraint' | 'foreignKey';
    /** The table's column count at record time. */
    columnCount: number;
    /** Which columns (by position) are primary keys. */
    primaryKey: boolean[];
    /** The existing row, for `'data'`/`'conflict'` conflicts. */
    conflictRow?: unknown[];
    /** The change's pre-change row, for update/delete changes. */
    oldRow?: unknown[];
    /** The change's post-change row, for insert/update changes. */
    newRow?: unknown[];
}

/**
 * Options for `Database#applyChangeset`.
 *
 * @since 9.0.0
 */
export interface ApplyChangesetOptions {
    /**
     * The conflict policy: `'abort'` (default) rolls the whole apply
     * back, `'omit'` skips the conflicting change, `'replace'` overwrites
     * the conflicting row, or a function returning one of those decisions
     * per conflict (a blocking round trip; avoid the synchronous methods
     * on the connection from inside it).
     */
    conflict?:
        | 'abort'
        | 'omit'
        | 'replace'
        | ((info: ChangesetConflict) => 'abort' | 'omit' | 'replace');
    /** Alias of `conflict`. */
    onConflict?: ApplyChangesetOptions['conflict'];
    /** Receives each affected table name; return false to skip it. */
    filter?: (table: string) => boolean;
}

/**
 * Options for `sqlite3.deserializeFromBytes`.
 *
 * @since 9.0.0
 */
export type DeserializeOptions = {
    /** The deserialized database rejects writes (`SQLITE_READONLY`). */
    readOnly?: boolean;
    /** Let SQLite grow the buffer when the database outgrows the copy. */
    resizable?: boolean;
};

/**
 * Options for `Database#openBlob`.
 *
 * @since 9.0.0
 */
export type OpenBlobOptions = {
    /** The table holding the blob column. */
    table: string;
    /** The blob column's name. */
    column: string;
    /** The row's rowid. */
    rowid: number;
    /** The attached database (default `'main'`). */
    db?: string;
    /** Open read-only; writes then fail with `SQLITE_READONLY`. */
    readOnly?: boolean;
};

/**
 * The payload of a `'preupdate'` event: what the row looked like before
 * and after each write. `oldRow` is null for inserts, `newRow` null for
 * deletes; `oldRowid`/`rowid` differ exactly on a rowid-changing update.
 * Note that `sqlite3_blob_write` fires the hook as a delete (the new
 * values are not yet available there).
 *
 * @since 9.0.0
 */
export interface PreupdateEventInfo {
    /** `'insert'`, `'update'` or `'delete'`. */
    op: 'insert' | 'update' | 'delete';
    /** The attached database name. */
    database: string;
    /** The table. */
    table: string;
    /** The rowid being inserted/deleted/updated (null on insert). */
    oldRowid: number | bigint | null;
    /** The rowid after the change (the new rowid on a rowid-changing update). */
    rowid: number | bigint;
    /** The pre-change row values, or null on insert. */
    oldRow: unknown[] | null;
    /** The post-change row values, or null on delete. */
    newRow: unknown[] | null;
}

/**
 * A change-recording session, created with `db.session()`. Records
 * INSERT/UPDATE/DELETE on the attached tables until
 * `changeset()` harvests the changes or the session is closed.
 *
 * One preupdate hook exists per connection and is shared with the
 * `'preupdate'` event: a session and a `'preupdate'` listener cannot
 * coexist on one connection, and attempting it fails loudly in both
 * directions.
 */
export declare class Session extends EventEmitter {
    /**
     * Creates a session. Prefer `db.session()`, which validates options.
     *
     * @param database the connection to record changes on.
     * @param dbName the attached database (usually `'main'`).
     * @param table the table to record, or `''` for every table with a
     *   primary key.
     * @param indirect mark the recorded changes indirect.
     * @param callback called once recording started.
     * @throws {TypeError} Unless called with `new` and these arguments,
     *   or when a 'preupdate' listener is registered on the connection.
     */
    constructor(
        database: Database,
        dbName: string,
        table: string,
        indirect: boolean,
        callback?: (this: Session, err: SqliteError | null) => void,
    );

    /** The attached database name this session records. */
    readonly db: string;

    /** The table this session records (`''` = every table). */
    readonly table: string;

    /** Whether the recorded changes are marked indirect. */
    readonly indirect: boolean;

    /** True once closed — explicitly, by `db.close()`, or after a failed create. */
    readonly closed: boolean;
}

/**
 * An incremental blob handle, created with `db.openBlob()`. Reads and
 * writes the blob in place, chunk by chunk, without materialising the
 * whole value.
 */
export declare class Blob extends EventEmitter {
    /**
     * Opens a blob handle. Prefer `db.openBlob()`, which validates
     * options.
     *
     * @param database the connection.
     * @param dbName the attached database (usually `'main'`).
     * @param table the table holding the blob column.
     * @param column the blob column.
     * @param rowid the row.
     * @param readOnly open read-only.
     * @param callback called once the handle is open.
     * @throws {TypeError} Unless called with `new` and these arguments.
     */
    constructor(
        database: Database,
        dbName: string,
        table: string,
        column: string,
        rowid: number,
        readOnly: boolean,
        callback?: (this: Blob, err: SqliteError | null) => void,
    );

    /** The attached database name the handle was opened on. */
    readonly db: string;

    /** The table. */
    readonly table: string;

    /** The blob column. */
    readonly column: string;

    /** The rowid the handle was opened on (before any `reopen`). */
    readonly rowid: number;

    /** Whether the handle is read-only. */
    readonly readOnly: boolean;

    /** The blob's size in bytes (`sqlite3_blob_bytes`). */
    readonly size: number;

    /** True once closed — explicitly or by `db.close()`. */
    readonly closed: boolean;
}

/**
 * The iterator `sqlite3.iterateChangeset` returns: sync-re iterable over
 * the recorded changes.
 *
 * @since 9.0.0
 */
export interface ChangesetIterable extends Iterable<ChangesetOp> {
    /**
     * Advances to the next change.
     *
     * @returns The next change, or `{done: true}`.
     */
    next(): IteratorResult<ChangesetOp>;
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
     * Synchronous fast path returning the first row as an array of the
     * row's values in result-column order (duplicate columns keep every
     * value). The bulk-reader shape: no per-cell property stores.
     *
     * @param params parameters as one array/named object or variadic
     *   values, followed by the `{ rowMode: 'array' }` options bag.
     * @returns the row's values, or undefined when the statement yields
     *   none.
     * @throws {Error} When the database is not fully idle, from inside an
     *   async completion callback, on an unsupported bind type, or when a
     *   callback is passed.
     * @since 9.0.0
     */
    getSync(
        ...params: [...(BindValue | BindParams)[], { rowMode: 'array' }]
    ): unknown[] | undefined;

    /**
     * Synchronous fast path: steps once on the main thread and returns
     * the first row as an object (the default row shape).
     *
     * @param params parameters as one array/named object or variadic
     *   values, optionally followed by a `{ rowMode: ... }` options bag.
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
     * Synchronous fast path stepping through every row, returning one
     * array of values per row in result-column order (duplicate columns
     * keep every value). The bulk-reader shape: no per-cell property
     * stores.
     *
     * @param params parameters as one array/named object or variadic
     *   values, followed by the `{ rowMode: 'array' }` options bag.
     * @returns every result row, as arrays.
     * @throws {Error} When the database is not fully idle, from inside an
     *   async completion callback, on an unsupported bind type, or when a
     *   callback is passed.
     * @since 9.0.0
     */
    allSync(
        ...params: [...(BindValue | BindParams)[], { rowMode: 'array' }]
    ): unknown[][];

    /**
     * Synchronous fast path: steps through every row on the main thread,
     * returning one object per row (the default row shape).
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

    // ---- Introspection (Deliverable 07). Served from a snapshot taken
    // once, on the thread that prepared — these never touch the sqlite
    // statement handle at read time. All are undefined until the
    // asynchronous prepare has completed.

    /**
     * Whether the statement makes no direct changes to the database file
     * (`sqlite3_stmt_readonly`).
     *
     * @since 9.0.0
     */
    readonly readonly: boolean | undefined;

    /**
     * The number of bind parameters (`sqlite3_bind_parameter_count`).
     *
     * @since 9.0.0
     */
    readonly parameterCount: number | undefined;

    /**
     * The bind parameter names in 1-based order: `':a'`, `'@b'`, `'$c'`,
     * `'?1'`. `undefined` for a fully positional statement (every
     * parameter a bare `?`): there are no names to report. A mixed
     * statement keeps one array entry per parameter, with null at every
     * positional index so indices stay aligned.
     *
     * @since 9.0.0
     */
    readonly parameterNames: Array<string | null> | undefined;

    /**
     * The result columns' metadata: name, and — when they have one —
     * declaredType, database, table and origin (the pre-alias column
     * name). Expression columns carry only a name.
     *
     * @since 9.0.0
     */
    readonly columns: ColumnMetadata[] | undefined;

    /**
     * Reads one `sqlite3_stmt_status` counter (the `STMTSTATUS_*`
     * constants), e.g. `FULLSCAN_STEP` — nonzero after a query scanned a
     * table without an index. Live counters, read under the connection
     * mutex.
     *
     * @param op a STMTSTATUS_* constant.
     * @param reset zero the counter after reading it.
     * @returns the counter value.
     * @throws {Error} When the statement is not prepared, is finalized, or
     *   a JavaScript callback is mid-call on the connection.
     * @since 9.0.0
     * @example
     * const stmt = await db.prepare('SELECT * FROM big');
     * await stmt.all();
     * const fullscanSteps = stmt.status(sqlite3.STMTSTATUS_FULLSCAN_STEP);
     */
    status(op: number, reset?: boolean): number;
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

    /** The Session class constructor (create via `db.session()`). @since 9.0.0 */
    Session: typeof Session;

    /** The Blob class constructor (create via `db.openBlob()`). @since 9.0.0 */
    Blob: typeof Blob;

    /**
     * Inverts a changeset: applying the result undoes applying the input.
     * Synchronous and connection-free; throws on a malformed changeset.
     *
     * @param changeset the changeset bytes.
     * @returns the inverted changeset.
     * @since 9.0.0
     */
    invertChangeset(changeset: ChangesetBytes): Uint8Array;

    /**
     * Installs the generator the addon uses to compile a row builder for
     * each result shape, so a row costs one call into JS instead of one
     * property store per column from C++. Called once by lib/sqlite3.js at
     * module load; not part of the supported surface.
     *
     * @param generator builds a row function from the column names and a
     *   flag selecting the array row shape.
     * @returns nothing.
     * @internal
     */
    setRowFactoryGenerator(
        generator: (
            names: string[],
            wantArray: boolean,
        ) => (...values: unknown[]) => unknown,
    ): void;

    /**
     * Concatenates two changesets into one equivalent to applying both in
     * order. Synchronous and connection-free; throws on malformed input.
     *
     * @param a the first changeset.
     * @param b the changeset applied after `a`.
     * @returns the combined changeset.
     * @since 9.0.0
     */
    concatChangeset(a: ChangesetBytes, b: ChangesetBytes): Uint8Array;

    /**
     * Iterates a changeset's changes synchronously (`for (const op of …)`).
     * Walks a private copy of the bytes; throws on a malformed changeset.
     *
     * @param changeset the changeset bytes.
     * @returns an iterator over the recorded changes.
     * @since 9.0.0
     */
    iterateChangeset(changeset: ChangesetBytes): ChangesetIterable;

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

    // Authorizer action codes (Deliverable 07), for `db.authorizer()`
    // rules. @since 9.0.0
    /** Authorizer action: CREATE INDEX. arg1 is the index, arg2 the table. @since 9.0.0 */ readonly CREATE_INDEX: 1;
    /** Authorizer action: CREATE TABLE. arg1 is the table. @since 9.0.0 */ readonly CREATE_TABLE: 2;
    /** Authorizer action: CREATE TEMP INDEX. @since 9.0.0 */ readonly CREATE_TEMP_INDEX: 3;
    /** Authorizer action: CREATE TEMP TABLE. @since 9.0.0 */ readonly CREATE_TEMP_TABLE: 4;
    /** Authorizer action: CREATE TEMP TRIGGER. @since 9.0.0 */ readonly CREATE_TEMP_TRIGGER: 5;
    /** Authorizer action: CREATE TEMP VIEW. @since 9.0.0 */ readonly CREATE_TEMP_VIEW: 6;
    /** Authorizer action: CREATE TRIGGER. @since 9.0.0 */ readonly CREATE_TRIGGER: 7;
    /** Authorizer action: CREATE VIEW. @since 9.0.0 */ readonly CREATE_VIEW: 8;
    /** Authorizer action: DELETE. arg1 is the table. @since 9.0.0 */ readonly DELETE: 9;
    /** Authorizer action: DROP INDEX. @since 9.0.0 */ readonly DROP_INDEX: 10;
    /** Authorizer action: DROP TABLE. @since 9.0.0 */ readonly DROP_TABLE: 11;
    /** Authorizer action: DROP TEMP INDEX. @since 9.0.0 */ readonly DROP_TEMP_INDEX: 12;
    /** Authorizer action: DROP TEMP TABLE. @since 9.0.0 */ readonly DROP_TEMP_TABLE: 13;
    /** Authorizer action: DROP TEMP TRIGGER. @since 9.0.0 */ readonly DROP_TEMP_TRIGGER: 14;
    /** Authorizer action: DROP TEMP VIEW. @since 9.0.0 */ readonly DROP_TEMP_VIEW: 15;
    /** Authorizer action: DROP TRIGGER. @since 9.0.0 */ readonly DROP_TRIGGER: 16;
    /** Authorizer action: DROP VIEW. @since 9.0.0 */ readonly DROP_VIEW: 17;
    /** Authorizer action: INSERT. arg1 is the table. @since 9.0.0 */ readonly INSERT: 18;
    /** Authorizer action: PRAGMA. arg1 is the pragma name. @since 9.0.0 */ readonly PRAGMA: 19;
    /** Authorizer action: READ. arg1 is the table, arg2 the column. @since 9.0.0 */ readonly READ: 20;
    /** Authorizer action: SELECT (fires once per SELECT, no args). @since 9.0.0 */ readonly SELECT: 21;
    /** Authorizer action: BEGIN/COMMIT/ROLLBACK statements. @since 9.0.0 */ readonly TRANSACTION: 22;
    /** Authorizer action: UPDATE. arg1 is the table. @since 9.0.0 */ readonly UPDATE: 23;
    /** Authorizer action: ATTACH. arg1 is the filename. @since 9.0.0 */ readonly ATTACH: 24;
    /** Authorizer action: DETACH. arg1 is the database name. @since 9.0.0 */ readonly DETACH: 25;
    /** Authorizer action: ALTER TABLE. arg1 is the table, arg2 the new name. @since 9.0.0 */ readonly ALTER_TABLE: 26;
    /** Authorizer action: REINDEX. @since 9.0.0 */ readonly REINDEX: 27;
    /** Authorizer action: ANALYZE. @since 9.0.0 */ readonly ANALYZE: 28;
    /** Authorizer action: CREATE VTABLE. @since 9.0.0 */ readonly CREATE_VTABLE: 29;
    /** Authorizer action: DROP VTABLE. @since 9.0.0 */ readonly DROP_VTABLE: 30;
    /** Authorizer action: invoke a function. arg2 is the name. @since 9.0.0 */ readonly FUNCTION: 31;
    /** Authorizer action: SAVEPOINT. @since 9.0.0 */ readonly SAVEPOINT: 32;
    /** Authorizer action: recursive query without a term. @since 9.0.0 */ readonly RECURSIVE: 33;
    /** Authorizer decision: refuse the action (SQLITE_DENY). @since 9.0.0 */ readonly DENY: 1;
    /** Authorizer decision: pretend the object does not exist (SQLITE_IGNORE). @since 9.0.0 */ readonly IGNORE: 2;

    // Statement status counters, for `Statement#status`. @since 9.0.0
    /** stmt status: full-scan steps — nonzero when no index was used. @since 9.0.0 */ readonly STMTSTATUS_FULLSCAN_STEP: 1;
    /** stmt status: sort algorithm invocations. @since 9.0.0 */ readonly STMTSTATUS_SORT: 2;
    /** stmt status: auto-index steps. @since 9.0.0 */ readonly STMTSTATUS_AUTOINDEX: 3;
    /** stmt status: virtual machine steps. @since 9.0.0 */ readonly STMTSTATUS_VM_STEP: 4;
    /** stmt status: re-preparations. @since 9.0.0 */ readonly STMTSTATUS_REPREPARE: 5;
    /** stmt status: times the statement was run. @since 9.0.0 */ readonly STMTSTATUS_RUN: 6;
    /** stmt status: filter misses. @since 9.0.0 */ readonly STMTSTATUS_FILTER_MISS: 7;
    /** stmt status: filter hits. @since 9.0.0 */ readonly STMTSTATUS_FILTER_HIT: 8;

    // db_config switches, for `Database#dbConfig`. @since 9.0.0
    /** dbConfig op: enforce foreign keys. @since 9.0.0 */ readonly DBCONFIG_ENABLE_FKEY: 1002;
    /** dbConfig op: enable triggers. @since 9.0.0 */ readonly DBCONFIG_ENABLE_TRIGGER: 1003;
    /** dbConfig op: enable views. @since 9.0.0 */ readonly DBCONFIG_ENABLE_VIEW: 1015;
    /** dbConfig op: enable load_extension(). @since 9.0.0 */ readonly DBCONFIG_ENABLE_LOAD_EXTENSION: 1005;
    /** dbConfig op: put the connection in defensive mode. @since 9.0.0 */ readonly DBCONFIG_DEFENSIVE: 1010;
    /** dbConfig op: allow writes to the schema tables. @since 9.0.0 */ readonly DBCONFIG_WRITABLE_SCHEMA: 1011;
    /** dbConfig op: trust schema SQL (off for untrusted schemas). @since 9.0.0 */ readonly DBCONFIG_TRUSTED_SCHEMA: 1017;

    // WAL checkpoint modes, for `Database#checkpoint`. @since 9.0.0
    /** Checkpoint mode: checkpoint without blocking (default). @since 9.0.0 */ readonly CHECKPOINT_PASSIVE: 0;
    /** Checkpoint mode: wait for writers, checkpoint everything. @since 9.0.0 */ readonly CHECKPOINT_FULL: 1;
    /** Checkpoint mode: full, then wait for readers to restart the WAL. @since 9.0.0 */ readonly CHECKPOINT_RESTART: 2;
    /** Checkpoint mode: restart, then truncate the WAL file. @since 9.0.0 */ readonly CHECKPOINT_TRUNCATE: 3;

    // Changeset decisions (what a conflict handler answers) and conflict
    // codes (why it was asked), for `Database#applyChangeset`. @since 9.0.0
    /** Conflict decision: skip the conflicting change. @since 9.0.0 */ readonly CHANGESET_OMIT: 0;
    /** Conflict decision: overwrite the conflicting row. @since 9.0.0 */ readonly CHANGESET_REPLACE: 1;
    /** Conflict decision: roll the whole apply back (the default). @since 9.0.0 */ readonly CHANGESET_ABORT: 2;
    /** Conflict code: the row changed since the changeset was recorded. @since 9.0.0 */ readonly CHANGESET_DATA: 1;
    /** Conflict code: the row no longer exists. @since 9.0.0 */ readonly CHANGESET_NOTFOUND: 2;
    /** Conflict code: an insert hit an existing primary key. @since 9.0.0 */ readonly CHANGESET_CONFLICT: 3;
    /** Conflict code: a non-key constraint failed. @since 9.0.0 */ readonly CHANGESET_CONSTRAINT: 4;
    /** Conflict code: the apply would violate a foreign key. @since 9.0.0 */ readonly CHANGESET_FOREIGN_KEY: 5;
};

/**
 * The shape of the native addon's export object, as a named type for
 * JSDoc references (`import('./native.js').default` is not addressable
 * in type position by tsc's node16 resolver).
 */
export type NativeBinding = typeof binding;

export default binding;
