// GENERATED FILE — DO NOT EDIT.
// Regenerate with `pnpm run gen-types`. Sources, in order of truth:
//   1. the native layer's shape, hand-written in lib/native.d.ts,
//   2. the JS layer's members in lib/augment.d.ts,
//   3. the JSDoc of lib/*.js, from which tsc emits this file plus
//      lib/promises.d.ts and lib/trace.d.ts.
// The three shipped .d.ts files together form the public types.

export default sqlite3;
export { DatabaseClass as Database };
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
    Database: (filename: string, callback?: (this: import("./sqlite3-binding.js").Database, err: Error | null) => void) => import("./sqlite3-binding.js").Database;
    /**
     * The registry itself, keyed by resolved path.
     */
    objects: Record<string, import("./sqlite3-binding.js").Database>;
};
/**
 * The constructor type of the v9 `Database` wrapper: every pre-v9
 * positional form plus the {@link OpenOptions} object forms. Declared
 * explicitly (rather than as `typeof` the class) so the namespace typedef
 * below does not reference the module it lives in — that self-reference
 * is a type-resolution cycle.
 */
export type DatabaseConstructor = new (filename: string, a?: number | OpenOptions | ((this: import("./sqlite3-binding.js").Database, err: import("./native.js").SqliteError | null) => void), b?: ((this: import("./sqlite3-binding.js").Database, err: import("./native.js").SqliteError | null) => void) | OpenOptions) => import("./sqlite3-binding.js").Database;
/**
 * The public `sqlite3` namespace object the package exports as its
 * default: the native binding (the five classes and every SQLite
 * constant with its literal value) plus the JS-layer `verbose`,
 * `cached`, `open`, `deserializeFromBytes` and `pool`. `Database` is the
 * v9 wrapper constructor (a real subclass of the native class) so the
 * {@link OpenOptions} constructor forms typecheck; instances satisfy the
 * native type everywhere.
 */
export type sqlite3 = import("./sqlite3-binding.js").NativeBinding & {
    Database: DatabaseConstructor;
    verbose: () => sqlite3;
    cached: CachedRegistry;
    open: import("./promises.js").OpenFunction;
    deserializeFromBytes: (bytes: Uint8Array | ArrayBuffer | DataView, options?: import("./native.js").DeserializeOptions) => Promise<import("./sqlite3-binding.js").Database>;
    pool: typeof import("./pool.js").pool;
};
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
    mode?: number | undefined;
    /**
     * harden the connection for an
     * attacker-supplied database file: defensive mode, untrusted schema,
     * writable_schema off, extension loading permanently disabled,
     * conservative run-time limits and a deny-all ATTACH gate. See
     * docs/security.md#untrusted-database-files.
     */
    untrusted?: boolean | undefined;
};
declare const sqlite3: sqlite3;
declare const DatabaseClass_base: typeof import("./native.js").Database & DatabaseConstructor;
/**
 * A connection to a SQLite database — the v9 wrapper around the native
 * class. Adds the permission-model checks on every open path, the
 * {@link OpenOptions} forms, the `extensionPolicy`/`attachPaths`
 * configure options and the guarded `loadExtension`/`backup`; everything
 * else, including all pre-v9 positional constructor forms, behaves
 * exactly as before.
 *
 * @extends {NativeDatabase}
 * @since 9.0.0
 */
declare class DatabaseClass extends DatabaseClass_base {
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
    constructor(filename: string, a?: number | OpenOptions | ((this: import("./sqlite3-binding.js").Database, err: import("./native.js").SqliteError | null) => void), b?: ((this: import("./sqlite3-binding.js").Database, err: import("./native.js").SqliteError | null) => void) | OpenOptions);
}
export { Backup, Blob, Session, Statement } from "./sqlite3-binding.js";
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
