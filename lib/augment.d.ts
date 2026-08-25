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

import type { Readable } from 'node:stream';

import type {
    Backup,
    BindParams,
    BindValue,
    Row,
    RunResult,
    SqliteError,
    Statement,
} from './native.js';
import type {
    FetchCallback,
    PromiseRunResult,
    SignalOptions,
    TransactionOptions,
} from './promises.js';

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

        /** Prepares a statement; returns it synchronously in every form. */
        prepare(
            sql: string,
            callback?: (this: Statement, err: SqliteError | null) => void,
        ): Statement;
        /** Prepares a statement with one array/named bind object. */
        prepare(
            sql: string,
            params: BindParams,
            callback?: (this: Statement, err: SqliteError | null) => void,
        ): Statement;
        /** Prepares a statement with variadic bind values. */
        prepare(sql: string, ...params: [...BindValue[]]): Statement;
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

        /**
         * Enables the opt-in LRU cache of prepared statements for
         * run/get/all/each/map, keyed on the SQL string. Defaults to 64
         * entries. Cached statements are finalized by close(). Under
         * serialize() the cache is bypassed to preserve strict FIFO
         * ordering.
         */
        cacheStatements(maxEntries?: number): this;

        /** Synchronous get on the main thread. */
        getSync<T = Row>(sql: string, ...params: BindValue[]): T | undefined;
        /** Synchronous get with one array/named bind object. */
        getSync<T = Row>(sql: string, params: BindParams): T | undefined;
        /** Synchronous run on the main thread; returns `{lastID, changes}`. */
        runSync(
            sql: string,
            ...params: BindValue[]
        ): { lastID: number; changes: number };
        /** Synchronous run with one array/named bind object. */
        runSync(
            sql: string,
            params: BindParams,
        ): { lastID: number; changes: number };
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
        /** Mirror of the native serialize state. @internal */
        _serialized?: boolean;
        /** True once close() started draining the cache. @internal */
        _closing?: boolean;
        /** Sync-path statement resolver. @internal */
        _statementForSync(sql: string): {
            statement: Statement;
            transient: boolean;
        };
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
}
