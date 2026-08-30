// Type-identity tests for the generated declarations, compiled by
// `tsc --noEmit` via `pnpm run test:types`. Callbacks are written
// contextually: their parameter types come from the declarations, so a
// signature change anywhere in the pipeline fails here.
//
// expectTypeOf(expr).toEqualTypeOf<T>() is a strict identity check —
// literal vs widened, any vs concrete, mutable vs readonly all mismatch —
// expressed entirely in the type system. It replaces the tsd runner this
// file used, which vendored its own compiler and dragged a jest-era
// dependency chain (read-pkg-up -> normalize-package-data -> semver@5).

import type { Readable } from 'node:stream';

import type {
    Backup,
    Database,
    FetchCallback,
    IntegerMode,
    PromiseRunResult,
    Row,
    SignalOptions,
    sqlite3 as Sqlite3Namespace,
    SqliteError,
    Statement,
    StatementRunSyncResult,
    TransactionOptions,
} from '../lib/sqlite3.js';
import sqlite3 from '../lib/sqlite3.js';

// The classic deferred-conditional identity test: two types are equal
// only if their naked conditional probes are mutually assignable.
type Equals<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;

declare function expectTypeOf<Actual>(value: Actual): {
    // A mismatch makes the rest parameter required, so the bare call
    // fails with "Expected 1 arguments, but got 0" on the assertion's
    // own line. Actual is inferred by the outer call — a single
    // expectType<T>(expr) shape cannot work, because an explicitly
    // given type argument makes every other parameter fall back to its
    // default instead of inferring.
    toEqualTypeOf<Expected>(
        ...mismatch: Equals<Actual, Expected> extends true
            ? []
            : [
                  'type mismatch: expression type is not identical to the type argument',
              ]
    ): void;
};

declare const db: Database;
declare const stmt: Statement;
declare const err: SqliteError;
declare const signal: AbortSignal;

// --- Namespace object -----------------------------------------------------

// Constants carry their literal values, so flag arithmetic is checkable.
expectTypeOf(sqlite3.OPEN_READONLY).toEqualTypeOf<1>();
expectTypeOf(sqlite3.OPEN_READWRITE).toEqualTypeOf<2>();
expectTypeOf(sqlite3.OPEN_CREATE).toEqualTypeOf<4>();
expectTypeOf(sqlite3.CONSTRAINT_PRIMARYKEY).toEqualTypeOf<1555>();
expectTypeOf(sqlite3.VERSION).toEqualTypeOf<'3.53.4'>();
expectTypeOf(sqlite3.VERSION_NUMBER).toEqualTypeOf<3053004>();
expectTypeOf(sqlite3.LIMIT_WORKER_THREADS).toEqualTypeOf<11>();

// verbose() returns the same namespace shape.
expectTypeOf(sqlite3.verbose()).toEqualTypeOf<Sqlite3Namespace>();

// cached.Database reuses or opens connections; the registry is public.
expectTypeOf(sqlite3.cached.Database('file.db')).toEqualTypeOf<Database>();
expectTypeOf(sqlite3.cached.objects).toEqualTypeOf<Record<string, Database>>();

// open is the promise-native constructor form.
expectTypeOf(sqlite3.open('file.db')).toEqualTypeOf<Promise<Database>>();
expectTypeOf(sqlite3.open('file.db', sqlite3.OPEN_READONLY)).toEqualTypeOf<
    Promise<Database>
>();

// --- Database: callback mode ---------------------------------------------

expectTypeOf(
    db.run('INSERT INTO t VALUES (?)', 1, (e) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.run('INSERT INTO t VALUES (?)', [1], (e) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.get('SELECT 1', (e, row) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(row).toEqualTypeOf<Row | undefined>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.all('SELECT 1', (e, rows) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(rows).toEqualTypeOf<Row[]>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.each(
        'SELECT 1',
        (e, row) => {
            expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
            expectTypeOf(row).toEqualTypeOf<Row>();
        },
        (e, count) => {
            expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
            expectTypeOf(count).toEqualTypeOf<number>();
        },
    ),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.exec('CREATE TABLE t (a)', (e) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
    }),
).toEqualTypeOf<Database>();
// The no-callback form is the statement AND a promise of it: awaiting
// gates on the native prepare completing (9.0.2).
expectTypeOf(db.prepare('SELECT 1')).toEqualTypeOf<
    Statement & Promise<Statement>
>();
expectTypeOf(
    db.prepare('SELECT ?', 1, () => undefined),
).toEqualTypeOf<Statement>();
expectTypeOf(db.prepare('SELECT ?', 1)).toEqualTypeOf<
    Statement & Promise<Statement>
>();

// --- Database: promise mode with bound parameters (D03 follow-up) --------

expectTypeOf(db.run('INSERT INTO t VALUES (?)')).toEqualTypeOf<
    Promise<PromiseRunResult>
>();
expectTypeOf(db.run('INSERT INTO t VALUES (?)', 1)).toEqualTypeOf<
    Promise<PromiseRunResult>
>();
expectTypeOf(db.run('INSERT INTO t VALUES (?)', [1])).toEqualTypeOf<
    Promise<PromiseRunResult>
>();
expectTypeOf(db.run('INSERT INTO t VALUES (?)', 1, { signal })).toEqualTypeOf<
    Promise<PromiseRunResult>
>();
expectTypeOf(db.run('INSERT INTO t VALUES (?)', [1], { signal })).toEqualTypeOf<
    Promise<PromiseRunResult>
>();

expectTypeOf(db.get('SELECT 1')).toEqualTypeOf<Promise<Row | undefined>>();
expectTypeOf(db.get('SELECT 1', 1)).toEqualTypeOf<Promise<Row | undefined>>();
expectTypeOf(db.get('SELECT 1', [1])).toEqualTypeOf<Promise<Row | undefined>>();
expectTypeOf(db.get('SELECT 1', 1, { signal })).toEqualTypeOf<
    Promise<Row | undefined>
>();

expectTypeOf(db.all('SELECT 1')).toEqualTypeOf<Promise<Row[]>>();
expectTypeOf(db.all('SELECT 1', 1)).toEqualTypeOf<Promise<Row[]>>();
expectTypeOf(db.all('SELECT 1', [1], { signal })).toEqualTypeOf<
    Promise<Row[]>
>();

expectTypeOf(db.map('SELECT 1')).toEqualTypeOf<
    Promise<Record<string, unknown>>
>();
expectTypeOf(db.map('SELECT 1', 1, { signal })).toEqualTypeOf<
    Promise<Record<string, unknown>>
>();

expectTypeOf(db.exec('CREATE TABLE t (a)')).toEqualTypeOf<Promise<void>>();
expectTypeOf(db.exec('CREATE TABLE t (a)', { signal })).toEqualTypeOf<
    Promise<void>
>();
expectTypeOf(db.close()).toEqualTypeOf<Promise<void>>();
expectTypeOf(db.wait()).toEqualTypeOf<Promise<void>>();
expectTypeOf(db.loadExtension('ext.so')).toEqualTypeOf<Promise<void>>();

// Generic propagation: the type argument flows through every promise form.
expectTypeOf(db.get<{ a: number }>('SELECT a')).toEqualTypeOf<
    Promise<{ a: number } | undefined>
>();
expectTypeOf(db.get<{ a: number }>('SELECT a', 1)).toEqualTypeOf<
    Promise<{ a: number } | undefined>
>();
expectTypeOf(db.all<{ a: number }>('SELECT a')).toEqualTypeOf<
    Promise<{ a: number }[]>
>();
expectTypeOf(db.all<{ a: number }>('SELECT a', 1, { signal })).toEqualTypeOf<
    Promise<{ a: number }[]>
>();
// and through the callback forms.
expectTypeOf(
    db.get<{ a: number }>('SELECT a', (e, row) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(row).toEqualTypeOf<{ a: number } | undefined>();
    }),
).toEqualTypeOf<Database>();

// --- Database: sync fast path --------------------------------------------

expectTypeOf(db.getSync('SELECT 1')).toEqualTypeOf<Row | undefined>();
expectTypeOf(db.getSync<{ a: number }>('SELECT a')).toEqualTypeOf<
    { a: number } | undefined
>();
// lastID is number | bigint: it applies the connection's integer mode.
expectTypeOf(db.runSync('SELECT 1')).toEqualTypeOf<StatementRunSyncResult>();
expectTypeOf(db.allSync('SELECT 1')).toEqualTypeOf<Row[]>();
expectTypeOf(db.allSync<{ a: number }>('SELECT a')).toEqualTypeOf<
    { a: number }[]
>();
expectTypeOf(db.prepareSync('SELECT 1')).toEqualTypeOf<Statement>();
// rowMode: 'array' opts into the bulk-reader row shape (arrays).
expectTypeOf(db.getSync('SELECT 1', { rowMode: 'array' })).toEqualTypeOf<
    unknown[] | undefined
>();
expectTypeOf(db.allSync('SELECT 1', { rowMode: 'array' })).toEqualTypeOf<
    unknown[][]
>();
expectTypeOf(
    db.allSync('SELECT a FROM t WHERE b = ?', 5, { rowMode: 'array' }),
).toEqualTypeOf<unknown[][]>();

// --- Database: statement cache, backup, transactions, iteration ----------

expectTypeOf(db.cacheStatements()).toEqualTypeOf<Database>();
expectTypeOf(db.cacheStatements(128)).toEqualTypeOf<Database>();
expectTypeOf(db.backup('copy.db')).toEqualTypeOf<Backup>();
expectTypeOf(
    db.backup('copy.db', 'main', 'main', true, () => undefined),
).toEqualTypeOf<Backup>();

expectTypeOf(db.iterate('SELECT 1')).toEqualTypeOf<
    AsyncIterableIterator<Row>
>();
expectTypeOf(db.iterate('SELECT 1', 1)).toEqualTypeOf<
    AsyncIterableIterator<Row>
>();
expectTypeOf(db.iterate('SELECT 1', [1])).toEqualTypeOf<
    AsyncIterableIterator<Row>
>();
expectTypeOf(db.iterate('SELECT 1', 1, { signal })).toEqualTypeOf<
    AsyncIterableIterator<Row>
>();

expectTypeOf(db.stream('SELECT 1')).toEqualTypeOf<Readable>();
expectTypeOf(db.stream('SELECT 1', 1, { signal })).toEqualTypeOf<Readable>();

expectTypeOf(
    db.transaction(async (tx) => {
        expectTypeOf(tx).toEqualTypeOf<Database>();
        return { a: 1 };
    }),
).toEqualTypeOf<Promise<{ a: number }>>();
expectTypeOf(db.transaction(async () => undefined)).toEqualTypeOf<
    Promise<undefined>
>();
const txOptions: TransactionOptions = {
    mode: 'immediate',
    savepoint: true,
    serialize: false,
    signal,
};
expectTypeOf(db.transaction(async () => undefined, txOptions)).toEqualTypeOf<
    Promise<undefined>
>();
const signalOptions: SignalOptions = { signal };
expectTypeOf(signalOptions).toEqualTypeOf<SignalOptions>();

// --- Database: events, accessors, disposal -------------------------------

expectTypeOf(
    db.on('trace', (sql) => {
        expectTypeOf(sql).toEqualTypeOf<string>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.on('profile', (sql, time) => {
        expectTypeOf(sql).toEqualTypeOf<string>();
        expectTypeOf(time).toEqualTypeOf<number>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.on('change', (type, database, table, rowid) => {
        expectTypeOf(type).toEqualTypeOf<string>();
        expectTypeOf(database).toEqualTypeOf<string>();
        expectTypeOf(table).toEqualTypeOf<string>();
        expectTypeOf(rowid).toEqualTypeOf<number>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.on('error', (e) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError>();
    }),
).toEqualTypeOf<Database>();
expectTypeOf(db.on('open', () => undefined)).toEqualTypeOf<Database>();

expectTypeOf(db.open).toEqualTypeOf<boolean>();
expectTypeOf(db.filename).toEqualTypeOf<string>();
expectTypeOf(db.mode).toEqualTypeOf<number>();
expectTypeOf(db.integerMode).toEqualTypeOf<IntegerMode>();
expectTypeOf(db.configure('integerMode', 'mixed')).toEqualTypeOf<Database>();
expectTypeOf(db.configure('busyTimeout', 1000)).toEqualTypeOf<Database>();
expectTypeOf(
    db.configure('limit', sqlite3.LIMIT_LENGTH, 1 << 30),
).toEqualTypeOf<Database>();
expectTypeOf(db.interrupt()).toEqualTypeOf<Database>();
expectTypeOf(db.serialize()).toEqualTypeOf<Database>();
expectTypeOf(db.parallelize()).toEqualTypeOf<Database>();
expectTypeOf(db[Symbol.asyncDispose]()).toEqualTypeOf<Promise<void>>();

// --- Statement: callback mode (contextual) --------------------------------

expectTypeOf(
    stmt.bind(1, (e) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
    }),
).toEqualTypeOf<Statement>();
expectTypeOf(
    stmt.run(1, (e) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
    }),
).toEqualTypeOf<Statement>();
expectTypeOf(
    stmt.get(1, (e, row) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(row).toEqualTypeOf<Row | undefined>();
    }),
).toEqualTypeOf<Statement>();
expectTypeOf(
    stmt.all(1, (e, rows) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(rows).toEqualTypeOf<Row[]>();
    }),
).toEqualTypeOf<Statement>();
expectTypeOf(
    // biome-ignore lint/suspicious/useIterableCallbackReturn: Statement#map is the row-mapping SQL method, not Array#map
    stmt.map((e, map) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(map).toEqualTypeOf<object>();
    }),
).toEqualTypeOf<Statement>();
expectTypeOf(
    stmt.reset((e) => {
        expectTypeOf(e).toEqualTypeOf<null>();
    }),
).toEqualTypeOf<Statement>();
expectTypeOf(stmt.finalize(() => undefined)).toEqualTypeOf<Database>();

// --- Statement: promise mode with bound parameters -----------------------

expectTypeOf(stmt.bind()).toEqualTypeOf<Promise<void>>();
expectTypeOf(stmt.bind(1)).toEqualTypeOf<Promise<void>>();
expectTypeOf(stmt.bind([1])).toEqualTypeOf<Promise<void>>();
expectTypeOf(stmt.run()).toEqualTypeOf<Promise<PromiseRunResult>>();
expectTypeOf(stmt.run(1)).toEqualTypeOf<Promise<PromiseRunResult>>();
expectTypeOf(stmt.run([1])).toEqualTypeOf<Promise<PromiseRunResult>>();
expectTypeOf(stmt.run(1, { signal })).toEqualTypeOf<
    Promise<PromiseRunResult>
>();
expectTypeOf(stmt.get()).toEqualTypeOf<Promise<Row | undefined>>();
expectTypeOf(stmt.get(1)).toEqualTypeOf<Promise<Row | undefined>>();
expectTypeOf(stmt.get(1, { signal })).toEqualTypeOf<Promise<Row | undefined>>();
expectTypeOf(stmt.all()).toEqualTypeOf<Promise<Row[]>>();
expectTypeOf(stmt.all(1, { signal })).toEqualTypeOf<Promise<Row[]>>();
expectTypeOf(stmt.map(1, { signal })).toEqualTypeOf<
    Promise<Record<string, unknown>>
>();
expectTypeOf(stmt.reset()).toEqualTypeOf<Promise<void>>();
expectTypeOf(stmt.finalize()).toEqualTypeOf<Promise<void>>();

// fetch, iteration, sync, accessors
expectTypeOf(
    stmt.fetch(100, (e, rows, done) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(rows).toEqualTypeOf<Row[]>();
        expectTypeOf(done).toEqualTypeOf<boolean>();
    }),
).toEqualTypeOf<Statement>();
const fetchCallback: FetchCallback = (e, rows, done) => {
    expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
    expectTypeOf(rows).toEqualTypeOf<Row[]>();
    expectTypeOf(done).toEqualTypeOf<boolean>();
};
void fetchCallback;
expectTypeOf(
    stmt.fetch(100, 1, (e, rows, done) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(rows).toEqualTypeOf<Row[]>();
        expectTypeOf(done).toEqualTypeOf<boolean>();
    }),
).toEqualTypeOf<Statement>();
expectTypeOf(stmt.iterate()).toEqualTypeOf<AsyncIterableIterator<Row>>();
expectTypeOf(stmt.iterate(1)).toEqualTypeOf<AsyncIterableIterator<Row>>();
expectTypeOf(stmt.iterate(1, { signal })).toEqualTypeOf<
    AsyncIterableIterator<Row>
>();
expectTypeOf(stmt.getSync(1)).toEqualTypeOf<Row | undefined>();
expectTypeOf(stmt.allSync(1)).toEqualTypeOf<Row[]>();
expectTypeOf(stmt.getSync(1, { rowMode: 'array' })).toEqualTypeOf<
    unknown[] | undefined
>();
expectTypeOf(stmt.allSync({ rowMode: 'array' })).toEqualTypeOf<unknown[][]>();
expectTypeOf(stmt.runSync(1)).toEqualTypeOf<Statement>();
expectTypeOf(stmt.sql).toEqualTypeOf<string>();
expectTypeOf(stmt.lastID).toEqualTypeOf<number | bigint | undefined>();
expectTypeOf(stmt.lastIDBigInt).toEqualTypeOf<bigint | undefined>();
expectTypeOf(stmt.changes).toEqualTypeOf<number | undefined>();
expectTypeOf(stmt[Symbol.asyncDispose]()).toEqualTypeOf<Promise<void>>();
expectTypeOf(stmt[Symbol.dispose]()).toEqualTypeOf<void>();

// --- Backup ---------------------------------------------------------------

declare const backup: Backup;
expectTypeOf(
    backup.step(1, (e, completed) => {
        expectTypeOf(e).toEqualTypeOf<SqliteError | null>();
        expectTypeOf(completed).toEqualTypeOf<boolean>();
    }),
).toEqualTypeOf<Backup>();
expectTypeOf(backup.finish(() => undefined)).toEqualTypeOf<Backup>();
expectTypeOf(backup.step(1)).toEqualTypeOf<Promise<boolean>>();
expectTypeOf(backup.finish()).toEqualTypeOf<Promise<void>>();
expectTypeOf(backup.idle).toEqualTypeOf<boolean>();
expectTypeOf(backup.completed).toEqualTypeOf<boolean>();
expectTypeOf(backup.failed).toEqualTypeOf<boolean>();
expectTypeOf(backup.remaining).toEqualTypeOf<number>();
expectTypeOf(backup.pageCount).toEqualTypeOf<number>();
expectTypeOf(backup.retryErrors).toEqualTypeOf<number[]>();
expectTypeOf(backup.filename).toEqualTypeOf<string>();
expectTypeOf(backup.sourceName).toEqualTypeOf<string>();
expectTypeOf(backup.destName).toEqualTypeOf<string>();
expectTypeOf(backup.filenameIsDest).toEqualTypeOf<boolean>();
expectTypeOf(backup[Symbol.asyncDispose]()).toEqualTypeOf<Promise<void>>();

// --- User-defined functions, aggregates, collations ------------------------

import type { AggregateDefinition, FunctionOptions } from '../lib/sqlite3.js';

expectTypeOf(
    db.function('regexp', (_pattern, _value) => 1),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.function('regexp', { deterministic: true }, (_p) => 1),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.function('seventh', { varargs: true }, (..._args: unknown[]) => 1),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.aggregate('median', {
        start: () => [],
        step: (acc, _v) => acc,
        result: (acc) => acc,
        inverse: (acc, _v) => acc,
    }),
).toEqualTypeOf<Database>();
expectTypeOf(
    db.collation('german', (a, b) => a.localeCompare(b, 'de')),
).toEqualTypeOf<Database>();
expectTypeOf(db.removeFunction('regexp')).toEqualTypeOf<Database>();
expectTypeOf(db.removeCollation('german')).toEqualTypeOf<Database>();

// The option and aggregate types are exported from the package root.
declare const opts: FunctionOptions;
expectTypeOf(opts.deterministic).toEqualTypeOf<boolean | undefined>();
expectTypeOf(opts.directOnly).toEqualTypeOf<boolean | undefined>();
expectTypeOf(opts.innocuous).toEqualTypeOf<boolean | undefined>();
expectTypeOf(opts.varargs).toEqualTypeOf<boolean | undefined>();
declare const spec: AggregateDefinition;
// Assignability (not invocation: the implementations are `this: undefined`).
const aggStart: (this: undefined) => unknown = spec.start;
const aggStep: (this: undefined, acc: unknown, ...args: unknown[]) => unknown =
    spec.step;
const aggResult: (this: undefined, acc: unknown) => unknown = spec.result;
type InverseFn = (this: undefined, acc: unknown, ...args: unknown[]) => unknown;
const aggInverse: InverseFn | undefined = spec.inverse;
void aggStart;
void aggStep;
void aggResult;
void aggInverse;
// The aggregate definition carries the function options.
declare const asOptions: FunctionOptions;
const withFlags: AggregateDefinition = {
    deterministic: true,
    ...asOptions,
    start: () => 0,
    step: (acc) => acc,
    result: (acc) => acc,
};
void withFlags;

// --- Errors ----------------------------------------------------------------

expectTypeOf(err.code).toEqualTypeOf<string>();
expectTypeOf(err.primaryCode).toEqualTypeOf<string>();
expectTypeOf(err.errno).toEqualTypeOf<number>();
expectTypeOf(err.message).toEqualTypeOf<string>();

// --- Worker pool (Deliverable 09) -------------------------------------------

import type {
    PoolOptions,
    PoolQueryOptions,
    SqlitePool,
} from '../lib/sqlite3.js';

// The factory resolves a fully-typed pool.
declare const poolPromise: Promise<SqlitePool>;
expectTypeOf(sqlite3.pool('app.db')).toEqualTypeOf<Promise<SqlitePool>>();
expectTypeOf(sqlite3.pool('app.db', { readers: 2 })).toEqualTypeOf<
    Promise<SqlitePool>
>();
expectTypeOf(poolPromise).toEqualTypeOf<Promise<SqlitePool>>();

// The option surface is closed over the declared keys.
declare const poolOpts: PoolOptions;
expectTypeOf(poolOpts.readers).toEqualTypeOf<number | undefined>();
expectTypeOf(poolOpts.walMode).toEqualTypeOf<boolean | undefined>();
expectTypeOf(poolOpts.busyTimeout).toEqualTypeOf<number | undefined>();
expectTypeOf(poolOpts.integerMode).toEqualTypeOf<
    'number' | 'bigint' | 'mixed' | undefined
>();

// Query options carry the signal.
declare const queryOpts: PoolQueryOptions;
expectTypeOf(queryOpts.signal).toEqualTypeOf<AbortSignal | undefined>();

// The query surface.
declare const p: SqlitePool;
expectTypeOf(p.read('SELECT a')).toEqualTypeOf<Promise<Row[]>>();
expectTypeOf(p.get('SELECT a')).toEqualTypeOf<Promise<Row | undefined>>();
expectTypeOf(p.write('INSERT')).toEqualTypeOf<
    Promise<import('../lib/promises.js').PromiseRunResult>
>();
expectTypeOf(p.exec('VACUUM')).toEqualTypeOf<Promise<void>>();
expectTypeOf(p.transaction(async () => 42)).toEqualTypeOf<Promise<number>>();
expectTypeOf(p.filename).toEqualTypeOf<string>();
expectTypeOf(p.readers).toEqualTypeOf<number>();
expectTypeOf(p.closed).toEqualTypeOf<boolean>();
expectTypeOf(p.close()).toEqualTypeOf<Promise<void>>();
expectTypeOf(p[Symbol.asyncDispose]()).toEqualTypeOf<Promise<void>>();
