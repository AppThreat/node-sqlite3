// GENERATED FILE — DO NOT EDIT.
// Regenerate with `pnpm run gen-types`. Sources, in order of truth:
//   1. the native layer's shape, hand-written in lib/native.d.ts,
//   2. the JS layer's members in lib/augment.d.ts,
//   3. the JSDoc of lib/*.js, from which tsc emits this file plus
//      lib/promises.d.ts and lib/trace.d.ts.
// The three shipped .d.ts files together form the public types.

export default sqlite3;
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
 * The public `sqlite3` namespace object the package exports as its
 * default: the native binding (the three classes and every SQLite
 * constant with its literal value) plus the JS-layer `verbose`,
 * `cached` and `open`.
 */
export type sqlite3 = import("./sqlite3-binding.js").NativeBinding & {
    verbose: () => sqlite3;
    cached: CachedRegistry;
    open: import("./promises.js").OpenFunction;
};
declare const sqlite3: sqlite3;
export { Backup, Database, Statement } from "./sqlite3-binding.js";
import './augment.js';
export type {
    FetchCallback,
    OpenFunction,
    PromiseRunResult,
    SignalOptions,
    TransactionOptions,
} from './promises.js';
export type {
    BindParams,
    BindValue,
    DatabaseState,
    IntegerMode,
    NativeBinding,
    Row,
    RunResult,
    SqliteError,
    StatementRunSyncResult,
} from './native.js';
