// Hand-maintained declaration for the node:sqlite compatibility shim
// (lib/compat.js). The documented divergences from node:sqlite's surface
// are listed in the implementation file's header comment.

import type {
    ApplyChangesetOptions,
    Database,
    Row,
    Session,
} from './native.js';

/**
 * A prepared statement in the node:sqlite StatementSync shape, wrapping
 * this package's synchronous fast path.
 *
 * @since 9.1.0
 */
export declare class StatementSync {
    /** True once finalized (explicitly or through dispose). */
    get finalized(): boolean;
    /** The statement's SQL text. */
    get sourceSQL(): string;
    /** The SQL with the most recent bound values substituted. */
    get expandedSQL(): string;
    /** The statement's result columns. */
    columns(): Array<{
        name: string;
        database?: string;
        table?: string;
        column?: string;
        type?: string;
    }>;
    /** Steps once and returns the first row (or undefined). */
    get(...params: unknown[]): Row | undefined;
    /** Steps to completion and returns every row. */
    all(...params: unknown[]): Row[];
    /** Runs the statement, returning `{ changes, lastInsertRowid }`. */
    run(...params: unknown[]): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
    /**
     * A synchronous iterator over the rows. Divergence: the rows are
     * materialised first (the sync fast path has no mid-cursor
     * suspension).
     */
    iterate(...params: unknown[]): IterableIterator<Row>;
    /**
     * Sets whether integers read as BigInt, re-preparing the statement
     * (the integer mode belongs to the prepared statement here).
     */
    setReadBigInts(value: boolean): void;
    /** Sets whether rows are arrays. */
    setReturnArrays(value: boolean): void;
    /** Finalizes the statement. */
    close(): void;
    /** `using` support. */
    [Symbol.dispose](): void;
}

/**
 * A connection in the node:sqlite DatabaseSync shape, mapping onto this
 * package's synchronous fast path.
 *
 * @since 9.1.0
 */
export declare class DatabaseSync {
    /**
     * Opens a connection (synchronously — the connection is usable the
     * moment the constructor returns).
     */
    constructor(
        location: string,
        options?: {
            readOnly?: boolean;
            open?: boolean;
            enableForeignKeyConstraints?: boolean;
            enableDoubleQuotedStringLiterals?: boolean;
            allowExtension?: boolean;
            timeout?: number;
        },
    );
    /** The underlying connection (the full async surface). */
    get native(): Database;
    /** True while open. */
    get open(): boolean;
    /** Alias of `open` (node:sqlite's name). */
    get isOpen(): boolean;
    /** True inside an explicit transaction. */
    get isTransaction(): boolean;
    /** Runs a SQL script synchronously. */
    exec(sql: string): undefined;
    /** Prepares a statement synchronously. */
    prepare(
        sql: string,
        options?: {
            readBigInts?: boolean;
            returnArrays?: boolean;
            allowBareNamedParameters?: boolean;
            allowUnknownNamedParameters?: boolean;
            persistent?: boolean;
        },
    ): StatementSync;
    /** Registers a scalar SQL function. */
    function(
        name: string,
        options?:
            | ((...args: unknown[]) => unknown)
            | {
                  deterministic?: boolean;
                  directOnly?: boolean;
                  varargs?: boolean;
              },
        fn?: (...args: unknown[]) => unknown,
    ): void;
    /** Registers an aggregate (or window) SQL function. */
    aggregate(
        name: string,
        spec: {
            start: () => unknown;
            step: (acc: unknown, ...args: unknown[]) => unknown;
            result: (acc: unknown) => unknown;
            inverse?: (acc: unknown, ...args: unknown[]) => unknown;
            deterministic?: boolean;
            varargs?: boolean;
        },
    ): void;
    /** Loads a SQLite extension (gated by allowExtension). */
    loadExtension(path: string, entryPoint?: string): void;
    /** The allowExtension gate. */
    enableLoadExtension(allow: boolean): void;
    /** Toggles SQLite defensive mode. */
    enableDefensive(active: boolean): void;
    /**
     * The filesystem path of an attached database, or null for an
     * in-memory or temporary one (node:sqlite's shape).
     */
    location(dbName?: string): string | null;
    /**
     * Not available: this package's authorizer is declarative by design.
     * Use `db.native.authorizer(policy)`.
     */
    setAuthorizer(): never;
    /** Creates a changeset-recording session (async divergence). */
    createSession(options?: { table?: string }): Session;
    /** Applies a changeset (async divergence). */
    applyChangeset(
        changeset: Uint8Array,
        options?: ApplyChangesetOptions,
    ): Promise<void>;
    /** Serializes the database (async divergence). */
    serialize(): Promise<Uint8Array>;
    /**
     * Closes the connection, finalizing the statements prepared through
     * it (as node:sqlite does). The close itself is queued: the
     * connection refuses further work at once, the handle is released a
     * turn later. A close that still fails is reported on the underlying
     * connection's 'error' event.
     */
    close(): void;
    /**
     * `await using` support: finalizes outstanding statements, then waits
     * for the close to complete.
     */
    [Symbol.asyncDispose](): Promise<void>;
}
