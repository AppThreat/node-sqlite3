// GENERATED FILE — DO NOT EDIT.
// Regenerate with `pnpm run gen-types`. Sources, in order of truth:
//   1. the native layer's shape, hand-written in lib/native.d.ts,
//   2. the JS layer's members in lib/augment.d.ts,
//   3. the JSDoc of lib/*.js, from which tsc emits this file plus
//      lib/promises.d.ts and lib/trace.d.ts.
// The three shipped .d.ts files together form the public types.

/**
 * A native class (Database, Statement or Backup) before the EventEmitter
 * prototype is copied onto it.
 */
export type NativeClass = new (...args: never[]) => object;
/**
 * `sqlite3.cached` — a registry of connections shared by resolved
 * database path. Special filenames (`''`, `':memory:'`) are never
 * cached; a second call with the same path returns the open connection
 * and still fires the callback once it is ready.
 */
export type CachedRegistry = {
    /**
     * Open (or reuse) a connection, optionally with a callback.
     */
    Database: (filename: string, callback?: (this: import('./sqlite3-binding.js').Database, err: Error | null) => void) => import('./sqlite3-binding.js').Database;
    /**
     * The registry itself, keyed by resolved path.
     */
    objects: Record<string, import('./sqlite3-binding.js').Database>;
};
/**
 * The constructor type of the v9 `Database` wrapper: every pre-v9
 * positional form plus the {@link OpenOptions} object forms. Declared
 * explicitly (rather than as `typeof` the class) so the namespace typedef
 * below does not reference the module it lives in — that self-reference
 * is a type-resolution cycle.
 */
export type DatabaseConstructor = new (filename: string, a?: number | OpenOptions | ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void), b?: ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void) | OpenOptions) => import('./sqlite3-binding.js').Database;
/**
 * The public `sqlite3` namespace object the package exports as its
 * default: the native binding (the five classes and every SQLite
 * constant with its literal value) plus the JS-layer `verbose`,
 * `cached`, `open`, `deserializeFromBytes` and `pool`. `Database` is the
 * v9 wrapper constructor (a real subclass of the native class) so the
 * {@link OpenOptions} constructor forms typecheck; instances satisfy the
 * native type everywhere.
 */
export type sqlite3 = import('./sqlite3-binding.js').NativeBinding & {
    Database: DatabaseConstructor;
    verbose: () => sqlite3;
    cached: CachedRegistry;
    open: import('./promises.js').OpenFunction;
    deserializeFromBytes: (bytes: Uint8Array | ArrayBuffer | DataView, options?: import('./native.js').DeserializeOptions) => Promise<import('./sqlite3-binding.js').Database>;
    pool: typeof import('./pool.js').pool;
    iterdump: (db: import('./sqlite3-binding.js').Database) => AsyncGenerator<string, void, void>;
    migrate: typeof import('./migrate.js').migrate;
    subscribeQueries: (onMessage: (message: {
        sql: string;
        database: import('./sqlite3-binding.js').Database;
        duration: bigint;
        durationMs: number;
    }) => void) => () => void;
    flushQuerySpans: () => void;
};
declare const sqlite3: sqlite3;
declare const NativeDatabase: typeof import("./native.js").Database & DatabaseConstructor;
export type ExtensionPolicy = {
    /**
     * the connection was opened `{ untrusted: true }`.
     */
    untrusted: boolean;
    /**
     * `configure('extensionPolicy', { deny: true })` was applied.
     */
    permadeny: boolean;
    /**
     * an explicit policy was applied; its allowlist then governs
     * even when the permission model is off.
     */
    configured: boolean;
    /**
     * allowed extension paths (as written).
     */
    allow: Set<string>;
};
/**
 * Options for opening a database (v9). Accepted anywhere a mode number
 * could appear in the `Database` constructor and in `sqlite3.open`'s
 * second argument.
 */
export type OpenOptions = {
    /**
     * open flags, e.g. `sqlite3.OPEN_READWRITE`.
     */
    mode?: number;
    /**
     * harden the connection for an
     * attacker-supplied database file: defensive mode, untrusted schema,
     * writable_schema off, extension loading permanently disabled,
     * conservative run-time limits and a deny-all ATTACH gate. See
     * docs/security.md#untrusted-database-files.
     */
    untrusted?: boolean;
};
/**
 * A connection to a SQLite database — the v9 wrapper around the native
 * class. Adds the permission-model checks on every open path, the
 * {@link OpenOptions} forms, the `extensionPolicy`/`attachPaths`
 * configure options and the guarded `loadExtension`/`backup`; everything
 * else, including all pre-v9 positional constructor forms, behaves
 * exactly as before.
 *
 * @since 9.0.0
 */
declare class DatabaseClass extends NativeDatabase {
    /**
     * Opens a database connection. The open itself is asynchronous; the
     * callback fires (or the `'open'` event emits) once it completes.
     *
     * Under Node's permission model (`--permission`), the target is
     * checked against the process's fs allowances before anything is
     * opened: a read-only open needs `fs.read` for the file; a writable
     * open additionally needs `fs.write` for the file **and its
     * directory** (SQLite writes `-journal`/`-wal`/`-shm` files beside
     * it). A refusal names the path and the flag that permits it.
     *
     * @param {string} filename path to the database file, `:memory:`, `''`
     *   or (with `OPEN_URI`) a `file:` URI.
     * @param {number | OpenOptions | ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void)} [a]
     *   open flags, an options object, or the callback.
     * @param {((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void) | OpenOptions} [b]
     *   the callback (after a mode), or the options object.
     * @throws {Error} ERR_ACCESS_DENIED under the permission model when
     *   the target is not permitted, naming the path and the remedy.
     * @throws {TypeError} when the arguments are malformed.
     */
    constructor(filename: string, a?: number | OpenOptions | ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void), b?: ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void) | OpenOptions);
}
export type PragmaOptions = {
    /**
     * return only the first column of the first
     * row (the scalar form better-sqlite3 popularised).
     */
    simple?: boolean;
};
export type BatchStatement = {
    /**
     * one statement.
     */
    sql: string;
    /**
     * bind parameters: an array of positional
     * values, an object of named parameters, or a single positional value.
     * The parameters may also follow the SQL in an array entry
     * (`[sql, ...params]`).
     */
    args?: unknown;
};
/**
 * One composed piece of SQL for the tag store: literal text plus bind
 * parameters. `sql.raw`/`identifier`/`join` build these; a plain value in
 * a template hole becomes a bind parameter instead.
 */
export type SqlFragment = {
    /**
     * the SQL text.
     */
    text: string;
    /**
     * the bind parameters, in text order.
     */
    params: unknown[];
};
export type VtabDefinition = {
    /**
     *   the row generator: invoked once per query with the table-function
     *   parameter values; yields arrays (in column order) or objects keyed by
     *   column name.
     */
    rows: (this: undefined, ...args: unknown[]) => Iterable<unknown[] | Record<string, unknown>>;
    /**
     * the
     * result columns (a `'name TYPE'` string or `{ name, type }`; the type
     * is documentation — SQLite virtual tables are typeless).
     */
    columns: (string | {
        name: string;
        type?: string;
    })[];
    /**
     * a subset of `columns` to declare
     * HIDDEN — the table-valued function's arguments
     * (`SELECT * FROM name(arg)` passes `arg` to `rows`).
     *
     * A parameter is a real (hidden) column, and `name(arg)` is the
     * predicate `WHERE param = arg`, which SQLite re-checks against every
     * row the generator yields — the generator is not trusted to have
     * applied it. A row therefore either leaves that column NULL (it is
     * filled with the argument) or echoes the argument; a row reporting
     * anything else there contradicts the predicate and is filtered out.
     */
    parameters?: string[];
};
/**
 * The per-connection registry of db.values() tables: registration order
 * (for the cap) and the drop handles.
 */
export type ValuesRegistry = {
    /**
     * the table names, oldest registration first.
     */
    order: string[];
    /**
     * the handles.
     */
    byName: Map<string, {
        name: string;
        drop: () => void;
    }>;
};
/**
 * One finished-statement span, published on the diagnostics channels.
 */
export type QuerySpan = {
    /**
     * the expanded SQL text.
     */
    sql: string;
    /**
     * the connection.
     */
    database: import('./sqlite3-binding.js').Database;
    /**
     * the measured duration in nanoseconds.
     */
    duration: bigint;
    /**
     * the measured duration in milliseconds.
     */
    durationMs: number;
};
export default sqlite3;
export { Backup, Blob, Session, Statement } from './sqlite3-binding.js';
export { DatabaseClass as Database };
import './augment.js';
export type {
    FetchCallback,
    OpenFunction,
    PromiseRunResult,
    SignalOptions,
    TransactionOptions,
} from './promises.js';
export type {
    PoolOptions,
    PoolQueryOptions,
    PoolTransaction,
    SqlitePool,
} from './pool.js';
export type {
    AggregateDefinition,
    ApplyChangesetOptions,
    AuthorizerPolicy,
    AuthorizerRule,
    BindParams,
    BindValue,
    CancellationToken,
    ChangesetBytes,
    ChangesetConflict,
    ChangesetIterable,
    ChangesetOp,
    CheckpointMode,
    CheckpointOptions,
    CheckpointResult,
    ColumnMetadata,
    DatabaseState,
    DeserializeOptions,
    ExtensionPolicyOptions,
    FunctionOptions,
    IntegerMode,
    NativeBinding,
    OpenBlobOptions,
    PreupdateEventInfo,
    Row,
    RunResult,
    SessionOptions,
    SqliteError,
    StatementRunSyncResult,
    SyncRowModeOptions,
    TableColumnInfo,
} from './native.js';
