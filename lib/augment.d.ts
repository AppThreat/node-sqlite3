// The JS layer's public surface, merged onto the native classes from
// lib/native.d.ts by declaration merging: this module augments
// './native.js' so `Database`, `Statement` and `Backup` carry the members
// that lib/sqlite3.js and lib/promises.js install on their prototypes —
// the dual-mode (callback | promise) methods, iterate/stream/transaction,
// the statement cache, backup construction and resource disposal.
//
// Every method that lib/promises.js rewraps in dual mode is declared
// here in full — including its callback form — and not in the island:
// merged members resolve class overloads first, so a native
// optional-callback form would shadow the promise overloads. The island
// keeps only what reaches users unwrapped.
//
// Dual-mode resolution rules (lib/promises.js dualMode): a call whose
// last argument is a function is callback mode and returns the receiver;
// anything else is promise mode. Promise-mode methods that accept an
// AbortSignal take it as a trailing `{ signal }` options object (named
// bind parameters cannot collide: their keys carry a `$`/`:`/`@`
// prefix). The variadic forms use leading-rest tuples
// (`[...BindValue[], Callback]`) so the trailing callback/options keep
// their types and callbacks get contextual parameter types.
//
// Shared option/result types come from the JSDoc in lib/promises.js
// (they are regenerated into lib/promises.d.ts and re-exported from the
// generated lib/sqlite3.d.ts).

import type { Readable, Writable } from 'node:stream';

import type {
    AggregateDefinition,
    ApplyChangesetOptions,
    AuthorizerPolicy,
    Backup,
    BindParams,
    BindValue,
    Blob,
    CancellationToken,
    CheckpointMode,
    CheckpointOptions,
    CheckpointResult,
    Database,
    FunctionOptions,
    OpenBlobOptions,
    Row,
    RunResult,
    Session,
    SessionOptions,
    SqliteError,
    Statement,
    StatementRunSyncResult,
    TableColumnInfo,
} from './native.js';
import type {
    FetchCallback,
    PromiseRunResult,
    SignalOptions,
    TransactionOptions,
} from './promises.js';

/**
 * The tagged-template statement store `db.createTagStore()` returns: an
 * LRU of prepared statements driven by template literals, with the
 * composition helpers ORMs need.
 *
 * @since 9.1.0
 */
export interface TagStore {
    /**
     * Template tag resolving the first row.
     * @param templates the template strings.
     * @param values the interpolated values.
     * @returns the first row, or undefined.
     */
    get(
        templates: TemplateStringsArray,
        ...values: unknown[]
    ): Promise<Row | undefined>;
    /**
     * Template tag resolving every row.
     * @param templates the template strings.
     * @param values the interpolated values.
     * @returns the rows.
     */
    all(templates: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
    /**
     * Template tag returning the backpressured async iterator.
     * @param templates the template strings.
     * @param values the interpolated values.
     * @returns the async iterator.
     */
    iterate(
        templates: TemplateStringsArray,
        ...values: unknown[]
    ): AsyncIterableIterator<Row>;
    /**
     * Template tag running the statement.
     * @param templates the template strings.
     * @param values the interpolated values.
     * @returns the run result.
     */
    run(
        templates: TemplateStringsArray,
        ...values: unknown[]
    ): Promise<import('./promises.js').PromiseRunResult>;
    /**
     * Drops every cached SQL key, and the connection statements they
     * name.
     * @returns nothing.
     */
    clear(): void;
    /** The number of composed SQL keys the store is holding. */
    readonly size: number;
    /** The maximum number of SQL keys the store holds. */
    readonly capacity: number;
    /** The connection. */
    readonly db: Database;
    /**
     * Builds a raw-SQL fragment.
     * @param text the SQL text.
     * @returns the fragment.
     */
    raw(text: string): SqlFragment;
    /**
     * Joins fragments and/or plain values with a separator (IN-lists and
     * friends). A fragment contributes its SQL text; anything else binds
     * as a parameter, which is what an IN-list of user data needs.
     * @param items the fragments or values.
     * @param separator the joining text.
     * @returns the joined fragment.
     */
    join(items: (SqlFragment | unknown)[], separator?: string): SqlFragment;
    /**
     * Quotes one SQL identifier for safe interpolation.
     * @param name the identifier.
     * @returns the quoted fragment.
     */
    identifier(name: string): SqlFragment;
    /**
     * Quotes a dotted identifier path part by part.
     * @param dotted the dot-separated path.
     * @returns the quoted fragment.
     */
    identifierPath(dotted: string): SqlFragment;
    /**
     * Builds the empty fragment.
     * @returns the fragment.
     */
    empty(): SqlFragment;
}

/**
 * One composed piece of SQL: literal text plus bind parameters.
 *
 * @since 9.1.0
 */
export interface SqlFragment {
    /** The SQL text. */
    text: string;
    /** The bind parameters, in text order. */
    params: unknown[];
}

declare module './native.js' {
    interface Database {
        // ---- Promise mode (v9): a call whose last argument is not a
        // function returns a promise instead of the receiver. Bind
        // parameters may be variadic values, one array/named object,
        // and — for the signal-aware methods — a trailing `{ signal }`.

        /** Runs a statement, resolving `{lastID, changes, lastIDBigInt}`. @since 9.0.0 */
        run(sql: string): Promise<PromiseRunResult>;
        /** Runs a statement with variadic bind values. @since 9.0.0 */
        run(sql: string, ...params: BindValue[]): Promise<PromiseRunResult>;
        /** Runs a statement with variadic bind values and a trailing signal. @since 9.0.0 */
        run(
            sql: string,
            ...params: [...BindValue[], SignalOptions]
        ): Promise<PromiseRunResult>;
        /** Runs a statement with one array/named bind object. @since 9.0.0 */
        run(
            sql: string,
            params: BindParams,
            options?: SignalOptions,
        ): Promise<PromiseRunResult>;

        /** Gets the first row. @since 9.0.0 */
        get<T = Row>(sql: string): Promise<T | undefined>;
        /** Gets the first row with variadic bind values. @since 9.0.0 */
        get<T = Row>(
            sql: string,
            ...params: BindValue[]
        ): Promise<T | undefined>;
        /** Gets the first row with variadic bind values and a trailing signal. @since 9.0.0 */
        get<T = Row>(
            sql: string,
            ...params: [...BindValue[], SignalOptions]
        ): Promise<T | undefined>;
        /** Gets the first row with one array/named bind object. @since 9.0.0 */
        get<T = Row>(
            sql: string,
            params: BindParams,
            options?: SignalOptions,
        ): Promise<T | undefined>;

        /** Gets every row. @since 9.0.0 */
        all<T = Row>(sql: string): Promise<T[]>;
        /** Gets every row with variadic bind values. @since 9.0.0 */
        all<T = Row>(sql: string, ...params: BindValue[]): Promise<T[]>;
        /** Gets every row with variadic bind values and a trailing signal. @since 9.0.0 */
        all<T = Row>(
            sql: string,
            ...params: [...BindValue[], SignalOptions]
        ): Promise<T[]>;
        /** Gets every row with one array/named bind object. @since 9.0.0 */
        all<T = Row>(
            sql: string,
            params: BindParams,
            options?: SignalOptions,
        ): Promise<T[]>;

        /** Maps rows by their first column. @since 9.0.0 */
        map(sql: string): Promise<Record<string, unknown>>;
        /** Maps rows by their first column with variadic bind values. @since 9.0.0 */
        map(
            sql: string,
            ...params: BindValue[]
        ): Promise<Record<string, unknown>>;
        /** Maps rows by their first column with variadic bind values and a trailing signal. @since 9.0.0 */
        map(
            sql: string,
            ...params: [...BindValue[], SignalOptions]
        ): Promise<Record<string, unknown>>;
        /** Maps rows by their first column with one array/named bind object. @since 9.0.0 */
        map(
            sql: string,
            params: BindParams,
            options?: SignalOptions,
        ): Promise<Record<string, unknown>>;

        /** Executes statements that produce no rows. @since 9.0.0 */
        exec(sql: string, options?: SignalOptions): Promise<void>;
        /** Closes the connection. @since 9.0.0 */
        close(): Promise<void>;
        /** Waits for the queue to drain. @since 9.0.0 */
        wait(): Promise<void>;
        /** Loads an extension. @since 9.0.0 */
        loadExtension(filename: string): Promise<void>;

        // ---- Callback mode: the last argument is a function; the
        // return value is the receiver for chaining.

        /** Runs a statement, callback form. */
        run(
            sql: string,
            callback: (this: RunResult, err: SqliteError | null) => void,
        ): this;
        /** Runs a statement with one array/named bind object, callback form. */
        run(
            sql: string,
            params: BindParams,
            callback: (this: RunResult, err: SqliteError | null) => void,
        ): this;
        /** Runs a statement with variadic bind values, callback form. */
        run(
            sql: string,
            ...params: [
                ...BindValue[],
                (this: RunResult, err: SqliteError | null) => void,
            ]
        ): this;

        /** Gets the first row, callback form (no row when the statement yields none). */
        get<T = Row>(
            sql: string,
            callback: (
                this: Statement,
                err: SqliteError | null,
                row?: T,
            ) => void,
        ): this;
        /** Gets the first row with one array/named bind object, callback form. */
        get<T = Row>(
            sql: string,
            params: BindParams,
            callback: (
                this: Statement,
                err: SqliteError | null,
                row?: T,
            ) => void,
        ): this;
        /** Gets the first row with variadic bind values, callback form. */
        get<T = Row>(
            sql: string,
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, row?: T) => void,
            ]
        ): this;

        /** Gets every row, callback form. */
        all<T = Row>(
            sql: string,
            callback: (
                this: Statement,
                err: SqliteError | null,
                rows: T[],
            ) => void,
        ): this;
        /** Gets every row with one array/named bind object, callback form. */
        all<T = Row>(
            sql: string,
            params: BindParams,
            callback: (
                this: Statement,
                err: SqliteError | null,
                rows: T[],
            ) => void,
        ): this;
        /** Gets every row with variadic bind values, callback form. */
        all<T = Row>(
            sql: string,
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, rows: T[]) => void,
            ]
        ): this;

        /** Streams rows one at a time; the row callback is required. */
        each<T = Row>(
            sql: string,
            callback: (
                this: Statement,
                err: SqliteError | null,
                row: T,
            ) => void,
            complete?: (err: SqliteError | null, count: number) => void,
        ): this;
        /** Streams rows with one array/named bind object; the row callback is required. */
        each<T = Row>(
            sql: string,
            params: BindParams,
            callback: (
                this: Statement,
                err: SqliteError | null,
                row: T,
            ) => void,
            complete?: (err: SqliteError | null, count: number) => void,
        ): this;
        /** Streams rows with variadic bind values; the row callback is required. */
        each<T = Row>(
            sql: string,
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, row: T) => void,
            ]
        ): this;
        /** Streams rows with variadic bind values and a complete callback. */
        each<T = Row>(
            sql: string,
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, row: T) => void,
                (err: SqliteError | null, count: number) => void,
            ]
        ): this;

        /** Closes the connection, callback form. */
        close(
            callback: (this: Database, err: SqliteError | null) => void,
        ): this;
        /** Executes statements, callback form. */
        exec(
            sql: string,
            callback: (this: Statement, err: SqliteError | null) => void,
        ): this;
        /** Waits for the queue to drain, callback form. */
        wait(callback: (this: Database, param: null) => void): this;
        /** Loads an extension, callback form. */
        loadExtension(
            filename: string,
            callback: (this: Database, err: SqliteError | null) => void,
        ): this;

        /**
         * Prepares a statement. The no-callback form returns the statement
         * wrapped in a thenable: awaiting it settles only once the native
         * prepare (and any bind) has completed and the introspection
         * accessors — `columns`, `parameterCount`, `parameterNames`,
         * `readonly` — are populated, and yields the statement itself.
         * Before the await, the wrapper forwards every statement member,
         * so `db.prepare(sql).run(...)` keeps its synchronous surface. A
         * prepare failure rejects the await.
         * @since 9.0.2 the await gates on prepare completion.
         */
        prepare(sql: string): Statement & Promise<Statement>;
        /** Prepares a statement; the callback is an error-only errback. */
        prepare(
            sql: string,
            callback: (this: Statement, err: SqliteError | null) => void,
        ): Statement;
        /** Prepares a statement with one array/named bind object. */
        prepare(
            sql: string,
            params: BindParams,
            callback?: (this: Statement, err: SqliteError | null) => void,
        ): Statement;
        /**
         * Prepares a statement with variadic bind values; awaiting the
         * result gates on the prepare and the bind both completing.
         * @since 9.0.2 the await gates on prepare + bind completion.
         */
        prepare(
            sql: string,
            ...params: [...BindValue[]]
        ): Statement & Promise<Statement>;
        /** Prepares a statement with variadic bind values and a callback. */
        prepare(
            sql: string,
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null) => void,
            ]
        ): Statement;

        /** Maps rows by their first column, callback form. */
        map(
            sql: string,
            callback: (
                this: Statement,
                err: SqliteError | null,
                map: object,
            ) => void,
        ): this;
        /** Maps rows by their first column with one array/named bind object, callback form. */
        map(
            sql: string,
            params: BindParams,
            callback: (
                this: Statement,
                err: SqliteError | null,
                map: object,
            ) => void,
        ): this;
        /** Maps rows by their first column with variadic bind values, callback form. */
        map(
            sql: string,
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, map: object) => void,
            ]
        ): this;

        /**
         * Iterates query results with backpressure, pulling batches
         * (64..1024 rows) only as the consumer asks. The statement is
         * prepared on first use and finalized when the iteration ends
         * (drain, break, throw or abort).
         *
         * @since 9.0.0
         * @example
         * for await (const row of db.iterate('SELECT * FROM big')) { ... }
         */
        iterate(sql: string): AsyncIterableIterator<Row>;
        /** Iterates with one array/named bind object and optional signal. @since 9.0.0 */
        iterate(
            sql: string,
            params: BindParams,
            options?: SignalOptions,
        ): AsyncIterableIterator<Row>;
        /** Iterates with variadic bind values. @since 9.0.0 */
        iterate(
            sql: string,
            ...params: BindValue[]
        ): AsyncIterableIterator<Row>;
        /** Iterates with variadic bind values and a trailing signal. @since 9.0.0 */
        iterate(
            sql: string,
            ...params: [...BindValue[], SignalOptions]
        ): AsyncIterableIterator<Row>;

        /**
         * `iterate()` as an object-mode Readable, for piping into the
         * rest of the stream ecosystem.
         *
         * @since 9.0.0
         * @example
         * db.stream('SELECT * FROM big').pipe(someTransform);
         */
        stream(sql: string): Readable;
        /** Streams with one array/named bind object and optional signal. @since 9.0.0 */
        stream(
            sql: string,
            params: BindParams,
            options?: SignalOptions,
        ): Readable;
        /** Streams with variadic bind values. @since 9.0.0 */
        stream(sql: string, ...params: BindValue[]): Readable;
        /** Streams with variadic bind values and a trailing signal. @since 9.0.0 */
        stream(
            sql: string,
            ...params: [...BindValue[], SignalOptions]
        ): Readable;

        /**
         * Runs `fn` inside a transaction: BEGIN / COMMIT, ROLLBACK on
         * throw; if the rollback fails too, an AggregateError carries
         * both. Nested calls automatically use savepoints. The callback
         * receives the connection itself as `tx` — a transaction is
         * connection-wide in SQLite, and work issued on `db` directly
         * from inside the callback races it unless
         * `{ serialize: true }` is passed.
         *
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

        /** `await using` support: closes the database. @since 9.0.0 */
        [Symbol.asyncDispose](): Promise<void>;

        // ---- User-defined functions, aggregates, collations (v9).

        /**
         * Registers a scalar SQL function backed by a JavaScript callback.
         *
         * The callback runs on the JS thread while the worker stepping the
         * statement blocks — a few microseconds per call. It cannot be
         * invoked from the synchronous methods (`getSync`/`runSync`/
         * `allSync`): those fail with an explicit error instead of
         * deadlocking. Redefining a name replaces the function and flushes
         * the statement cache.
         *
         * @since 9.0.0
         * @example
         * db.function('regexp', { deterministic: true },
         *     (pattern, value) => (new RegExp(pattern).test(value) ? 1 : 0));
         */
        function(
            name: string,
            fn: (this: undefined, ...args: unknown[]) => unknown,
        ): this;
        /** Registers a scalar function with options. @since 9.0.0 */
        function(
            name: string,
            options: FunctionOptions,
            fn: (this: undefined, ...args: unknown[]) => unknown,
        ): this;

        /**
         * Registers an aggregate SQL function: `start()` creates an
         * accumulator, `step(acc, ...args)` folds a row into it and
         * `result(acc)` produces the value. A provided `inverse` makes it
         * a window function (flags cannot be applied to window functions;
         * see the aggregate documentation in the README).
         *
         * @since 9.0.0
         * @example
         * db.aggregate('median', {
         *     start: () => [],
         *     step: (acc, v) => { acc.push(v); return acc; },
         *     result: (acc) => acc.sort((a, b) => a - b)[acc.length >> 1],
         * });
         */
        aggregate(name: string, spec: AggregateDefinition): this;

        /**
         * Registers a collation for `ORDER BY`, indexes and `COLLATE`.
         * Each comparison is one JS round trip; while a JavaScript
         * collation is registered the synchronous methods refuse to run.
         *
         * @since 9.0.0
         * @example
         * db.collation('locale', (a, b) => a.localeCompare(b, 'de'));
         */
        collation(name: string, fn: (a: string, b: string) => number): this;

        /**
         * Removes every function and aggregate registered under `name`
         * (a no-op for unknown names) and flushes the statement cache.
         *
         * @since 9.0.0
         */
        removeFunction(name: string): this;

        /**
         * Removes the collation under `name`; the synchronous methods
         * work again once no JavaScript collation remains.
         *
         * @since 9.0.0
         */
        removeCollation(name: string): this;

        /**
         * Runs `fn` with a JavaScript collation registered, removing it
         * again afterwards: the blast radius of the registration is the
         * awaited block, not the connection's lifetime. Inside the block
         * the synchronous methods refuse to run, as with `collation()`;
         * an error thrown by `fn` still removes the collation before the
         * rejection propagates. Interleaved or nested scopes for the same
         * name are last-wins — use distinct names for concurrent scopes.
         *
         * @since 9.0.2
         * @example
         * const rows = await db.withCollation('locale',
         *     (a, b) => a.localeCompare(b, 'de'),
         *     () => db.all('SELECT name FROM t ORDER BY name COLLATE locale'));
         */
        withCollation(
            name: string,
            cmp: (a: string, b: string) => number,
            fn: (db: Database) => unknown,
        ): Promise<unknown>;

        // ---- Hooks, authorizer, progress, WAL, introspection (v9).

        /**
         * Installs (or removes) a declarative authorizer: a rule list
         * evaluated inside SQLite, in C++ — no JavaScript runs on the
         * prepare path. The supported way to sandbox user-supplied SQL;
         * `deny` rules win over `allow` rules, and the statement cache is
         * flushed on every change so nothing compiled under the old
         * policy survives.
         *
         * @since 9.0.0
         * @example
         * db.authorizer({
         *     default: 'deny',
         *     allow: [
         *         { action: sqlite3.SELECT },
         *         { action: sqlite3.READ, table: 'users' },
         *     ],
         * });
         */
        authorizer(policy?: AuthorizerPolicy | null): this;

        /**
         * Installs a JavaScript progress callback invoked every `period`
         * VM instructions; a truthy return aborts the statement. Each
         * invocation is a blocking round trip to the JS thread — the
         * documented-slow form. While installed, the synchronous methods
         * refuse to run. Without a callback, removes the handler.
         *
         * @since 9.0.0
         */
        progress(
            period?: number | (() => unknown),
            callback?: () => unknown,
        ): this;

        /**
         * Creates a cancellation token: a `SharedArrayBuffer` flag the
         * native progress handler polls, aborting the running statement
         * the moment it is set — from any thread, with zero per-check JS
         * cost.
         *
         * @since 9.0.0
         */
        cancellationToken(options?: { period?: number }): CancellationToken;

        /** Runs a WAL checkpoint (promise mode). @since 9.0.0 */
        checkpoint(
            options?: CheckpointOptions | CheckpointMode | string,
        ): Promise<CheckpointResult>;
        /** Runs a WAL checkpoint (callback mode). @since 9.0.0 */
        checkpoint(
            options: CheckpointOptions | CheckpointMode | string,
            callback: (
                this: Database,
                err: SqliteError | null,
                result: CheckpointResult,
            ) => void,
        ): this;
        /** Runs a WAL checkpoint (callback only). @since 9.0.0 */
        checkpoint(
            callback: (
                this: Database,
                err: SqliteError | null,
                result: CheckpointResult,
            ) => void,
        ): this;

        /** Reads a table's column metadata (promise mode). @since 9.0.0 */
        tableInfo(table: string, dbName?: string): Promise<TableColumnInfo[]>;
        /** Reads a table's column metadata (callback mode). @since 9.0.0 */
        tableInfo(
            table: string,
            callback: (
                this: Database,
                err: SqliteError | null,
                columns: TableColumnInfo[],
            ) => void,
        ): this;
        /** Reads a table's column metadata with a database name (callback mode). @since 9.0.0 */
        tableInfo(
            table: string,
            dbName: string,
            callback: (
                this: Database,
                err: SqliteError | null,
                columns: TableColumnInfo[],
            ) => void,
        ): this;

        /** Reads or changes a db_config switch (promise mode). @since 9.0.0 */
        dbConfig(op: number, value?: boolean | number): Promise<boolean>;
        /** Reads or changes a db_config switch (callback mode). @since 9.0.0 */
        dbConfig(
            op: number,
            value: boolean | number | undefined,
            callback: (
                this: Database,
                err: SqliteError | null,
                value: boolean,
            ) => void,
        ): this;
        /** Reads a db_config switch (callback only). @since 9.0.0 */
        dbConfig(
            op: number,
            callback: (
                this: Database,
                err: SqliteError | null,
                value: boolean,
            ) => void,
        ): this;

        /**
         * Enables the opt-in LRU cache of prepared statements for
         * run/get/all/each/map, keyed on the SQL string. Defaults to 64
         * entries. Cached statements are finalized by close(). Under
         * serialize() the cache is bypassed to preserve strict FIFO
         * ordering.
         */
        cacheStatements(maxEntries?: number): this;

        /**
         * Synchronous get returning the first row as an array of values
         * in result-column order (`rowMode: 'array'`). Duplicate columns
         * keep every value. The bulk-reader shape.
         * @since 9.0.0
         */
        getSync(
            sql: string,
            ...params: [...BindValue[], { rowMode: 'array' }]
        ): unknown[] | undefined;
        /** Synchronous get on the main thread. */
        getSync<T = Row>(sql: string, ...params: BindValue[]): T | undefined;
        /** Synchronous get with one array/named bind object. */
        getSync<T = Row>(sql: string, params: BindParams): T | undefined;
        /**
         * Synchronous run on the main thread; returns
         * {@link StatementRunSyncResult} with `lastID` read eagerly
         * (the `'number'`-mode `RangeError` for an unsafe rowid fires
         * here).
         */
        runSync(sql: string, ...params: BindValue[]): StatementRunSyncResult;
        /** Synchronous run with one array/named bind object. */
        runSync(sql: string, params: BindParams): StatementRunSyncResult;
        /**
         * Synchronous all returning one array of values per row in
         * result-column order (`rowMode: 'array'`). Duplicate columns
         * keep every value. The bulk-reader shape.
         * @since 9.0.0
         */
        allSync(
            sql: string,
            ...params: [...BindValue[], { rowMode: 'array' }]
        ): unknown[][];
        /** Synchronous all on the main thread. */
        allSync<T = Row>(sql: string, ...params: BindValue[]): T[];
        /** Synchronous all with one array/named bind object. */
        allSync<T = Row>(sql: string, params: BindParams): T[];

        /**
         * Prepares synchronously on the main thread. Throws when the
         * database is not fully idle. The returned statement also
         * supports the getSync/runSync/allSync fast path.
         */
        prepareSync(sql: string): Statement;
        /**
         * Prepares synchronously with a per-statement integer-mode
         * override (node:sqlite's `readBigInts`, better-sqlite3's
         * `safeIntegers`, as a one-shot option).
         * @since 9.1.0
         */
        prepareSync(
            sql: string,
            options: { integerMode?: 'number' | 'bigint' | 'mixed' },
        ): Statement;

        /**
         * Runs a `PRAGMA` and resolves its parsed rows; `{ simple: true }`
         * resolves the first column of the first row.
         * @since 9.1.0
         */
        pragma(
            source: string,
            options?: { simple?: boolean },
        ): Promise<Record<string, unknown>[] | unknown>;
        /**
         * Resolves the `EXPLAIN QUERY PLAN` rows (or, with
         * `{ full: true }`, the VDBE program) without executing the
         * statement.
         * @since 9.1.0
         */
        explain(
            sql: string,
            options?: { full?: boolean },
        ): Promise<Record<string, unknown>[]>;
        /**
         * Runs an array of statements atomically in one transaction;
         * read-shaped statements resolve their rows, others their run
         * result.
         * @since 9.1.0
         */
        batch(
            statements: Array<
                | string
                | { sql: string; args?: BindParams }
                | [string, ...BindValue[]]
            >,
            options?: {
                mode?: 'write' | 'read' | 'deferred' | 'exclusive';
            },
        ): Promise<unknown[]>;
        /**
         * Serializes the database to `.dump`-style SQL text.
         * @since 9.1.0
         */
        dump(): Promise<string>;
        /**
         * Reads one `sqlite3_db_status` counter, by friendly name
         * (`'cacheHit'`) or DBSTATUS_* constant.
         * @since 9.1.0
         */
        status(
            op: string | number,
            options?: { reset?: boolean },
        ): { current: number; highwater: number };
        /**
         * Releases non-essential page-cache memory; returns the bytes
         * freed.
         * @since 9.1.0
         */
        releaseMemory(): number;
        /**
         * The current run-time limits, by friendly name.
         * @since 9.1.0
         */
        readonly limits: Record<string, number>;
        /**
         * The filesystem path of an attached database (empty for
         * in-memory/temp schemas).
         * @since 9.1.0
         */
        location(dbName?: string): string;
        /**
         * Registers a read-only virtual table computed by a JavaScript
         * generator (eponymous form). `parameters` names the subset of
         * `columns` declared HIDDEN — the table-valued function's
         * arguments. Rows are pulled in batches as the query consumes
         * them, so an unbounded generator works with `LIMIT`; a scan that
         * stops early leaves the generator suspended without resuming it.
         * @since 9.1.0
         */
        table(
            name: string,
            definition: {
                columns: Array<string | { name: string; type?: string }>;
                parameters?: string[];
                rows: (
                    this: undefined,
                    ...args: unknown[]
                ) => Iterable<unknown[] | Record<string, unknown>>;
            },
        ): this;
        /**
         * Registers a named virtual-table module instantiated per
         * `CREATE VIRTUAL TABLE ... USING name(args)`; the factory
         * declares its columns as `factory.columns` and receives the
         * DDL argument strings.
         * @since 9.1.0
         */
        table(
            name: string,
            factory: ((...args: string[]) => unknown) & {
                columns: Array<string | { name: string; type?: string }>;
                parameters?: string[];
            },
        ): this;
        /**
         * Removes a virtual-table module registered with `db.table()`.
         * @since 9.1.0
         */
        removeTable(name: string): this;
        /**
         * Exposes one JS array (or iterable) as a queryable table with
         * `key`/`value` columns; returns `{ name, drop() }`. Anonymous
         * registrations are capped at 32 per connection (the oldest is
         * dropped), so `drop()` each handle when done or pass an explicit
         * `{ name }`, which opts out of the cap.
         * @since 9.1.0
         */
        values(
            iterable: Iterable<unknown>,
            options?: { name?: string },
        ): { name: string; drop(): void };
        /**
         * Builds a tagged-template statement store (an LRU keyed on the
         * joined SQL) with `get`/`all`/`iterate`/`run` tags and the
         * `raw`/`join`/`identifier`/`identifierPath`/`empty` composition
         * helpers. Enables the connection statement cache if it is not
         * already on; only a fragment from those helpers is spliced in as
         * SQL text, every other interpolated value binds.
         * @since 9.1.0
         */
        createTagStore(maxSize?: number): TagStore;
        /**
         * Builds a reusable transaction wrapper carrying
         * `.deferred()`/`.immediate()`/`.exclusive()` begin-mode
         * variants.
         * @since 9.1.0
         */
        createTransaction(
            fn: (tx: Database, ...args: unknown[]) => unknown,
            options?: TransactionOptions,
        ): ((...args: unknown[]) => Promise<unknown>) & {
            deferred(...args: unknown[]): Promise<unknown>;
            immediate(...args: unknown[]): Promise<unknown>;
            exclusive(...args: unknown[]): Promise<unknown>;
        };

        /** Backs the database up to a file, returned synchronously. */
        backup(
            filename: string,
            callback?: (this: Backup, err: SqliteError | null) => void,
        ): Backup;
        /** Backs up between named databases. */
        backup(
            filename: string,
            sourceName: string,
            destName: string,
            filenameIsDest: boolean,
            callback?: (this: Backup, err: SqliteError | null) => void,
        ): Backup;

        /** trace event. */
        on(event: 'trace', listener: (sql: string) => void): this;
        /** profile event. */
        on(
            event: 'profile',
            listener: (sql: string, time: number) => void,
        ): this;
        /** change event. */
        on(
            event: 'change',
            listener: (
                type: string,
                database: string,
                table: string,
                rowid: number,
            ) => void,
        ): this;
        /**
         * commit event: fired after a transaction commits, on the JS
         * thread, after that transaction's change events. Observational
         * only — the commit has already happened and cannot be vetoed.
         * @since 9.0.0
         */
        on(event: 'commit', listener: () => void): this;
        /**
         * rollback event: fired after a transaction rolls back, on the JS
         * thread, after that transaction's change events.
         * @since 9.0.0
         */
        on(event: 'rollback', listener: () => void): this;
        /**
         * wal event: fired after a commit writes frames into the WAL,
         * with the database name and the number of frames now in the WAL.
         * Observational only — the automatic checkpoint cannot be vetoed.
         * @since 9.0.0
         */
        on(
            event: 'wal',
            listener: (database: string, pages: number) => void,
        ): this;
        /** error event. */
        on(event: 'error', listener: (err: SqliteError) => void): this;
        /** open/close events. */
        on(event: 'open' | 'close', listener: () => void): this;

        // ---- Internal state managed by lib/sqlite3.js. Not part of the
        // supported surface; declared so the JS layer typechecks.

        /** Statement cache, created by `cacheStatements()`. @internal */
        _stmtCache?: Map<string, Statement>;
        /** Statement cache capacity. @internal */
        _stmtCacheMax?: number;
        /**
         * Statement cache the synchronous paths keep on their own, so that
         * `getSync`/`allSync`/`runSync` do not prepare and finalize a
         * statement per call. Separate from `_stmtCache` because enabling
         * that one also changes how the asynchronous calls behave, which is
         * the caller's choice via `cacheStatements()`. @internal
         */
        _syncStmtCache?: Map<string, Statement>;
        /** Sync-path statement resolver; always cached. @internal */
        _statementForSync(sql: string): Statement;
        /** Finalizes every cached statement, emptying the cache. @internal */
        _drainStatementCache(): void;
        /**
         * True while the JavaScript thread is inside SQLite on this
         * connection — i.e. inside a callback a synchronous method invoked
         * re-entrantly. The operations that finalize the executing
         * statement (every registration, which flushes the statement
         * cache) refuse then. @internal
         */
        readonly _inSyncCall: boolean;

        // ---- Sessions, changesets, serialization and blob I/O
        // (Deliverable 08).

        /**
         * Creates a change-recording session on this connection.
         * @since 9.0.0
         */
        session(
            options?: SessionOptions,
            callback?: (this: Session, err: SqliteError | null) => void,
        ): Session;
        /** Creates a session, callback form. */
        session(
            callback: (this: Session, err: SqliteError | null) => void,
        ): Session;

        /**
         * Applies a changeset inside one savepoint (either every change
         * lands or the apply rolls back), resolving once done.
         * @since 9.0.0
         */
        applyChangeset(
            changeset: Uint8Array | ArrayBuffer | DataView,
            options?: ApplyChangesetOptions,
        ): Promise<void>;
        /** Applies a changeset, callback form. */
        applyChangeset(
            changeset: Uint8Array | ArrayBuffer | DataView,
            options: ApplyChangesetOptions | undefined,
            callback: (this: Database, err: SqliteError | null) => void,
        ): this;
        /** Applies a changeset with the default policy, callback form. */
        applyChangeset(
            changeset: Uint8Array | ArrayBuffer | DataView,
            callback: (this: Database, err: SqliteError | null) => void,
        ): this;

        /**
         * Serializes the database (or one attached schema) to bytes.
         * @since 9.0.0
         */
        serializeToBytes(dbName?: string): Promise<Uint8Array>;
        /** Serializes the database, callback form. */
        serializeToBytes(
            dbName: string | undefined,
            callback: (
                this: Database,
                err: SqliteError | null,
                bytes: Uint8Array,
            ) => void,
        ): this;
        /** Serializes the database, callback form. */
        serializeToBytes(
            callback: (
                this: Database,
                err: SqliteError | null,
                bytes: Uint8Array,
            ) => void,
        ): this;

        /**
         * Opens an incremental blob handle on one row's blob column.
         * @since 9.0.0
         */
        openBlob(
            options: OpenBlobOptions,
            callback?: (this: Blob, err: SqliteError | null) => void,
        ): Blob;
    }

    interface Statement {
        // ---- Promise mode (v9): a call whose last argument is not a
        // function returns a promise instead of the receiver.

        /** Binds parameters. @since 9.0.0 */
        bind(...params: BindValue[]): Promise<void>;
        /** Binds one array/named bind object. @since 9.0.0 */
        bind(params: BindParams): Promise<void>;
        /** Runs the statement. @since 9.0.0 */
        run(...params: BindValue[]): Promise<PromiseRunResult>;
        /** Runs with one array/named bind object and optional signal. @since 9.0.0 */
        run(
            params: BindParams,
            options?: SignalOptions,
        ): Promise<PromiseRunResult>;
        /** Runs with variadic bind values and a trailing signal. @since 9.0.0 */
        run(
            ...params: [...BindValue[], SignalOptions]
        ): Promise<PromiseRunResult>;
        /** Gets the first row. @since 9.0.0 */
        get(...params: BindValue[]): Promise<Row | undefined>;
        /** Gets the first row with one array/named bind object and optional signal. @since 9.0.0 */
        get(
            params: BindParams,
            options?: SignalOptions,
        ): Promise<Row | undefined>;
        /** Gets the first row with variadic bind values and a trailing signal. @since 9.0.0 */
        get(
            ...params: [...BindValue[], SignalOptions]
        ): Promise<Row | undefined>;
        /** Gets every row. @since 9.0.0 */
        all(...params: BindValue[]): Promise<Row[]>;
        /** Gets every row with one array/named bind object and optional signal. @since 9.0.0 */
        all(params: BindParams, options?: SignalOptions): Promise<Row[]>;
        /** Gets every row with variadic bind values and a trailing signal. @since 9.0.0 */
        all(...params: [...BindValue[], SignalOptions]): Promise<Row[]>;
        /** Maps rows by their first column. @since 9.0.0 */
        map(...params: BindValue[]): Promise<Record<string, unknown>>;
        /** Maps rows with one array/named bind object and optional signal. @since 9.0.0 */
        map(
            params: BindParams,
            options?: SignalOptions,
        ): Promise<Record<string, unknown>>;
        /** Maps rows with variadic bind values and a trailing signal. @since 9.0.0 */
        map(
            ...params: [...BindValue[], SignalOptions]
        ): Promise<Record<string, unknown>>;
        /** Resets the statement. @since 9.0.0 */
        reset(): Promise<void>;
        /** Finalizes the statement. @since 9.0.0 */
        finalize(): Promise<void>;

        // ---- Callback mode.

        /** Binds parameters, callback form. */
        bind(
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null) => void,
            ]
        ): this;
        /** Runs the statement, callback form. */
        run(
            ...params: [
                ...BindValue[],
                (this: RunResult, err: SqliteError | null) => void,
            ]
        ): this;
        /** Runs with one array/named bind object, callback form. */
        run(
            params: BindParams,
            callback: (this: RunResult, err: SqliteError | null) => void,
        ): this;
        /** Gets the first row, callback form (no row when the statement yields none). */
        get(
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, row?: Row) => void,
            ]
        ): this;
        /** Gets the first row with one array/named bind object, callback form. */
        get(
            params: BindParams,
            callback: (
                this: Statement,
                err: SqliteError | null,
                row?: Row,
            ) => void,
        ): this;
        /** Gets every row, callback form. */
        all(
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, rows: Row[]) => void,
            ]
        ): this;
        /** Gets every row with one array/named bind object, callback form. */
        all(
            params: BindParams,
            callback: (
                this: Statement,
                err: SqliteError | null,
                rows: Row[],
            ) => void,
        ): this;
        /** Streams rows one at a time; the row callback is required. */
        each(
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, row: Row) => void,
            ]
        ): this;
        /** Streams rows one at a time with a complete callback. */
        each(
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, row: Row) => void,
                (err: SqliteError | null, count: number) => void,
            ]
        ): this;
        /** Maps rows by their first column, callback form. */
        map(
            ...params: [
                ...BindValue[],
                (this: Statement, err: SqliteError | null, map: object) => void,
            ]
        ): this;
        /** Resets the statement, callback form. */
        reset(callback: (this: Statement, err: null) => void): this;
        /** Finalizes the statement, callback form. */
        finalize(
            callback: (this: Statement, err: SqliteError | null) => void,
        ): Database;

        /**
         * Fetches a batch of rows for paged reads without resetting
         * between calls, so successive fetches continue one cursor.
         *
         * @example
         * stmt.fetch(100, (err, rows, done) => { ... });
         */
        fetch(count: number, callback: FetchCallback): this;
        /** Fetches a batch with variadic bind values, bound on the first fetch of a run. */
        fetch(count: number, ...params: [...BindValue[], FetchCallback]): this;

        /**
         * Iterates this statement's results with backpressure; on break
         * the statement is reset, not finalized.
         *
         * @since 9.0.0
         * @example
         * for await (const row of stmt.iterate(42)) { ... }
         */
        iterate(...params: BindValue[]): AsyncIterableIterator<Row>;
        /** Iterates with one array/named bind object and optional signal. @since 9.0.0 */
        iterate(
            params: BindParams,
            options?: SignalOptions,
        ): AsyncIterableIterator<Row>;
        /** Iterates with variadic bind values and a trailing signal. @since 9.0.0 */
        iterate(
            ...params: [...BindValue[], SignalOptions]
        ): AsyncIterableIterator<Row>;

        /** `await using` support: finalizes the statement. @since 9.0.0 */
        [Symbol.asyncDispose](): Promise<void>;
        /** `using` support: initiates an async finalize. @since 9.0.0 */
        [Symbol.dispose](): void;
    }

    interface Backup {
        /** Steps the backup, resolving whether it is complete. @since 9.0.0 */
        step(pages: number): Promise<boolean>;
        /** Finishes the backup. @since 9.0.0 */
        finish(): Promise<void>;
        /** Steps the backup, callback form. */
        step(
            pages: number,
            callback: (
                this: Backup,
                err: SqliteError | null,
                completed: boolean,
            ) => void,
        ): this;
        /** Finishes the backup, callback form. */
        finish(callback: (this: Backup, err: SqliteError | null) => void): this;
        /** `await using` support: finishes the backup. @since 9.0.0 */
        [Symbol.asyncDispose](): Promise<void>;
    }

    interface Session {
        /**
         * Records the differences between `fromDb`'s table and this
         * session's table into the session (sqlite3session_diff),
         * without either database being written; harvest with
         * `changeset()`. @since 9.1.0
         */
        diff(table: string, fromDb: string): Promise<void>;
        /** session.diff, callback form. @since 9.1.0 */
        diff(
            table: string,
            fromDb: string,
            callback: (this: Session, err: SqliteError | null) => void,
        ): this;
        /** Harvests the recorded changes as a changeset. @since 9.0.0 */
        changeset(): Promise<Uint8Array>;
        /** Harvests the recorded changes, callback form. */
        changeset(
            callback: (
                this: Session,
                err: SqliteError | null,
                changeset: Uint8Array,
            ) => void,
        ): this;
        /**
         * Harvests the recorded changes as a patchset (new rows only —
         * smaller, but unusable for conflict detection on updates).
         * @since 9.0.0
         */
        patchset(): Promise<Uint8Array>;
        /** Harvests the recorded changes as a patchset, callback form. */
        patchset(
            callback: (
                this: Session,
                err: SqliteError | null,
                patchset: Uint8Array,
            ) => void,
        ): this;
        /** Closes the session; a second close is a benign no-op. @since 9.0.0 */
        close(): Promise<void>;
        /** Closes the session, callback form. */
        close(callback: (this: Session, err: SqliteError | null) => void): this;
        /** `using` support: initiates an asynchronous close. @since 9.0.0 */
        [Symbol.dispose](): void;
        /** `await using` support: closes the session. @since 9.0.0 */
        [Symbol.asyncDispose](): Promise<void>;
    }

    interface Blob {
        /**
         * Reads `target.length` bytes starting at the blob offset into
         * the target, resolving the byte count.
         * @since 9.0.0
         */
        read(target: Uint8Array, offset?: number): Promise<number>;
        /** Reads into the target, callback form. */
        read(
            target: Uint8Array,
            offset: number | undefined,
            callback: (
                this: Blob,
                err: SqliteError | null,
                transferred: number,
            ) => void,
        ): this;
        /** Reads into the target, callback form. */
        read(
            target: Uint8Array,
            callback: (
                this: Blob,
                err: SqliteError | null,
                transferred: number,
            ) => void,
        ): this;
        /**
         * Writes `source.length` bytes from the source at the blob
         * offset, resolving the byte count.
         * @since 9.0.0
         */
        write(source: Uint8Array, offset?: number): Promise<number>;
        /** Writes from the source, callback form. */
        write(
            source: Uint8Array,
            offset: number | undefined,
            callback: (
                this: Blob,
                err: SqliteError | null,
                transferred: number,
            ) => void,
        ): this;
        /** Writes from the source, callback form. */
        write(
            source: Uint8Array,
            callback: (
                this: Blob,
                err: SqliteError | null,
                transferred: number,
            ) => void,
        ): this;
        /** Re-aims the handle at a new rowid (after a row invalidation). @since 9.0.0 */
        reopen(rowid: number): Promise<void>;
        /** Re-aims the handle at a new rowid, callback form. */
        reopen(
            rowid: number,
            callback: (this: Blob, err: SqliteError | null) => void,
        ): this;
        /** Closes the handle; a second close is a benign no-op. @since 9.0.0 */
        close(): Promise<void>;
        /** Closes the handle, callback form. */
        close(callback: (this: Blob, err: SqliteError | null) => void): this;
        /**
         * Streams the blob's bytes as a binary Readable in chunks.
         * @since 9.0.0
         */
        createReadStream(options?: { highWaterMark?: number }): Readable;
        /**
         * Streams into the blob at a moving offset. The blob cannot
         * grow: size the column first (e.g. `zeroblob(n)`).
         * @since 9.0.0
         */
        createWriteStream(options?: { highWaterMark?: number }): Writable;
        /** `using` support: initiates an asynchronous close. @since 9.0.0 */
        [Symbol.dispose](): void;
        /** `await using` support: closes the handle. @since 9.0.0 */
        [Symbol.asyncDispose](): Promise<void>;
    }
}
