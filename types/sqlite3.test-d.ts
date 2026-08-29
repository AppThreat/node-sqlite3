// Type tests for the generated declarations, run by tsd via
// `pnpm run test:types`. Callbacks are written contextually: their
// parameter types come from the declarations, so a signature change
// anywhere in the pipeline fails here.

import type { Readable } from 'node:stream';

import { expectType } from 'tsd';

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

declare const db: Database;
declare const stmt: Statement;
declare const err: SqliteError;
declare const signal: AbortSignal;

// --- Namespace object -----------------------------------------------------

// Constants carry their literal values, so flag arithmetic is checkable.
expectType<1>(sqlite3.OPEN_READONLY);
expectType<2>(sqlite3.OPEN_READWRITE);
expectType<4>(sqlite3.OPEN_CREATE);
expectType<1555>(sqlite3.CONSTRAINT_PRIMARYKEY);
expectType<'3.53.4'>(sqlite3.VERSION);
expectType<3053004>(sqlite3.VERSION_NUMBER);
expectType<11>(sqlite3.LIMIT_WORKER_THREADS);

// verbose() returns the same namespace shape.
expectType<Sqlite3Namespace>(sqlite3.verbose());

// cached.Database reuses or opens connections; the registry is public.
expectType<Database>(sqlite3.cached.Database('file.db'));
expectType<Record<string, Database>>(sqlite3.cached.objects);

// open is the promise-native constructor form.
expectType<Promise<Database>>(sqlite3.open('file.db'));
expectType<Promise<Database>>(sqlite3.open('file.db', sqlite3.OPEN_READONLY));

// --- Database: callback mode ---------------------------------------------

expectType<Database>(
    db.run('INSERT INTO t VALUES (?)', 1, (e) => {
        expectType<SqliteError | null>(e);
    }),
);
expectType<Database>(
    db.run('INSERT INTO t VALUES (?)', [1], (e) => {
        expectType<SqliteError | null>(e);
    }),
);
expectType<Database>(
    db.get('SELECT 1', (e, row) => {
        expectType<SqliteError | null>(e);
        expectType<Row | undefined>(row);
    }),
);
expectType<Database>(
    db.all('SELECT 1', (e, rows) => {
        expectType<SqliteError | null>(e);
        expectType<Row[]>(rows);
    }),
);
expectType<Database>(
    db.each(
        'SELECT 1',
        (e, row) => {
            expectType<SqliteError | null>(e);
            expectType<Row>(row);
        },
        (e, count) => {
            expectType<SqliteError | null>(e);
            expectType<number>(count);
        },
    ),
);
expectType<Database>(
    db.exec('CREATE TABLE t (a)', (e) => {
        expectType<SqliteError | null>(e);
    }),
);
expectType<Statement>(db.prepare('SELECT 1'));
expectType<Statement>(db.prepare('SELECT ?', 1, () => undefined));

// --- Database: promise mode with bound parameters (D03 follow-up) --------

expectType<Promise<PromiseRunResult>>(db.run('INSERT INTO t VALUES (?)'));
expectType<Promise<PromiseRunResult>>(db.run('INSERT INTO t VALUES (?)', 1));
expectType<Promise<PromiseRunResult>>(db.run('INSERT INTO t VALUES (?)', [1]));
expectType<Promise<PromiseRunResult>>(
    db.run('INSERT INTO t VALUES (?)', 1, { signal }),
);
expectType<Promise<PromiseRunResult>>(
    db.run('INSERT INTO t VALUES (?)', [1], { signal }),
);

expectType<Promise<Row | undefined>>(db.get('SELECT 1'));
expectType<Promise<Row | undefined>>(db.get('SELECT 1', 1));
expectType<Promise<Row | undefined>>(db.get('SELECT 1', [1]));
expectType<Promise<Row | undefined>>(db.get('SELECT 1', 1, { signal }));

expectType<Promise<Row[]>>(db.all('SELECT 1'));
expectType<Promise<Row[]>>(db.all('SELECT 1', 1));
expectType<Promise<Row[]>>(db.all('SELECT 1', [1], { signal }));

expectType<Promise<Record<string, unknown>>>(db.map('SELECT 1'));
expectType<Promise<Record<string, unknown>>>(db.map('SELECT 1', 1, { signal }));

expectType<Promise<void>>(db.exec('CREATE TABLE t (a)'));
expectType<Promise<void>>(db.exec('CREATE TABLE t (a)', { signal }));
expectType<Promise<void>>(db.close());
expectType<Promise<void>>(db.wait());
expectType<Promise<void>>(db.loadExtension('ext.so'));

// Generic propagation: the type argument flows through every promise form.
expectType<Promise<{ a: number } | undefined>>(
    db.get<{ a: number }>('SELECT a'),
);
expectType<Promise<{ a: number } | undefined>>(
    db.get<{ a: number }>('SELECT a', 1),
);
expectType<Promise<{ a: number }[]>>(db.all<{ a: number }>('SELECT a'));
expectType<Promise<{ a: number }[]>>(
    db.all<{ a: number }>('SELECT a', 1, { signal }),
);
// and through the callback forms.
expectType<Database>(
    db.get<{ a: number }>('SELECT a', (e, row) => {
        expectType<SqliteError | null>(e);
        expectType<{ a: number } | undefined>(row);
    }),
);

// --- Database: sync fast path --------------------------------------------

expectType<Row | undefined>(db.getSync('SELECT 1'));
expectType<{ a: number } | undefined>(db.getSync<{ a: number }>('SELECT a'));
// lastID is number | bigint: it applies the connection's integer mode.
expectType<StatementRunSyncResult>(db.runSync('SELECT 1'));
expectType<Row[]>(db.allSync('SELECT 1'));
expectType<{ a: number }[]>(db.allSync<{ a: number }>('SELECT a'));
expectType<Statement>(db.prepareSync('SELECT 1'));
// rowMode: 'array' opts into the bulk-reader row shape (arrays).
expectType<unknown[] | undefined>(db.getSync('SELECT 1', { rowMode: 'array' }));
expectType<unknown[][]>(db.allSync('SELECT 1', { rowMode: 'array' }));
expectType<unknown[][]>(
    db.allSync('SELECT a FROM t WHERE b = ?', 5, { rowMode: 'array' }),
);

// --- Database: statement cache, backup, transactions, iteration ----------

expectType<Database>(db.cacheStatements());
expectType<Database>(db.cacheStatements(128));
expectType<Backup>(db.backup('copy.db'));
expectType<Backup>(db.backup('copy.db', 'main', 'main', true, () => undefined));

expectType<AsyncIterableIterator<Row>>(db.iterate('SELECT 1'));
expectType<AsyncIterableIterator<Row>>(db.iterate('SELECT 1', 1));
expectType<AsyncIterableIterator<Row>>(db.iterate('SELECT 1', [1]));
expectType<AsyncIterableIterator<Row>>(db.iterate('SELECT 1', 1, { signal }));

expectType<Readable>(db.stream('SELECT 1'));
expectType<Readable>(db.stream('SELECT 1', 1, { signal }));

expectType<Promise<{ a: number }>>(
    db.transaction(async (tx) => {
        expectType<Database>(tx);
        return { a: 1 };
    }),
);
expectType<Promise<undefined>>(db.transaction(async () => undefined));
const txOptions: TransactionOptions = {
    mode: 'immediate',
    savepoint: true,
    serialize: false,
    signal,
};
expectType<Promise<undefined>>(
    db.transaction(async () => undefined, txOptions),
);
const signalOptions: SignalOptions = { signal };
expectType<SignalOptions>(signalOptions);

// --- Database: events, accessors, disposal -------------------------------

expectType<Database>(
    db.on('trace', (sql) => {
        expectType<string>(sql);
    }),
);
expectType<Database>(
    db.on('profile', (sql, time) => {
        expectType<string>(sql);
        expectType<number>(time);
    }),
);
expectType<Database>(
    db.on('change', (type, database, table, rowid) => {
        expectType<string>(type);
        expectType<string>(database);
        expectType<string>(table);
        expectType<number>(rowid);
    }),
);
expectType<Database>(
    db.on('error', (e) => {
        expectType<SqliteError>(e);
    }),
);
expectType<Database>(db.on('open', () => undefined));

expectType<boolean>(db.open);
expectType<string>(db.filename);
expectType<number>(db.mode);
expectType<IntegerMode>(db.integerMode);
expectType<Database>(db.configure('integerMode', 'mixed'));
expectType<Database>(db.configure('busyTimeout', 1000));
expectType<Database>(db.configure('limit', sqlite3.LIMIT_LENGTH, 1 << 30));
expectType<Database>(db.interrupt());
expectType<Database>(db.serialize());
expectType<Database>(db.parallelize());
expectType<Promise<void>>(db[Symbol.asyncDispose]());

// --- Statement: callback mode (contextual) --------------------------------

expectType<Statement>(
    stmt.bind(1, (e) => {
        expectType<SqliteError | null>(e);
    }),
);
expectType<Statement>(
    stmt.run(1, (e) => {
        expectType<SqliteError | null>(e);
    }),
);
expectType<Statement>(
    stmt.get(1, (e, row) => {
        expectType<SqliteError | null>(e);
        expectType<Row | undefined>(row);
    }),
);
expectType<Statement>(
    stmt.all(1, (e, rows) => {
        expectType<SqliteError | null>(e);
        expectType<Row[]>(rows);
    }),
);
expectType<Statement>(
    // biome-ignore lint/suspicious/useIterableCallbackReturn: Statement#map is the row-mapping SQL method, not Array#map
    stmt.map((e, map) => {
        expectType<SqliteError | null>(e);
        expectType<object>(map);
    }),
);
expectType<Statement>(
    stmt.reset((e) => {
        expectType<null>(e);
    }),
);
expectType<Database>(stmt.finalize(() => undefined));

// --- Statement: promise mode with bound parameters -----------------------

expectType<Promise<void>>(stmt.bind());
expectType<Promise<void>>(stmt.bind(1));
expectType<Promise<void>>(stmt.bind([1]));
expectType<Promise<PromiseRunResult>>(stmt.run());
expectType<Promise<PromiseRunResult>>(stmt.run(1));
expectType<Promise<PromiseRunResult>>(stmt.run([1]));
expectType<Promise<PromiseRunResult>>(stmt.run(1, { signal }));
expectType<Promise<Row | undefined>>(stmt.get());
expectType<Promise<Row | undefined>>(stmt.get(1));
expectType<Promise<Row | undefined>>(stmt.get(1, { signal }));
expectType<Promise<Row[]>>(stmt.all());
expectType<Promise<Row[]>>(stmt.all(1, { signal }));
expectType<Promise<Record<string, unknown>>>(stmt.map(1, { signal }));
expectType<Promise<void>>(stmt.reset());
expectType<Promise<void>>(stmt.finalize());

// fetch, iteration, sync, accessors
expectType<Statement>(
    stmt.fetch(100, (e, rows, done) => {
        expectType<SqliteError | null>(e);
        expectType<Row[]>(rows);
        expectType<boolean>(done);
    }),
);
const fetchCallback: FetchCallback = (e, rows, done) => {
    expectType<SqliteError | null>(e);
    expectType<Row[]>(rows);
    expectType<boolean>(done);
};
void fetchCallback;
expectType<Statement>(
    stmt.fetch(100, 1, (e, rows, done) => {
        expectType<SqliteError | null>(e);
        expectType<Row[]>(rows);
        expectType<boolean>(done);
    }),
);
expectType<AsyncIterableIterator<Row>>(stmt.iterate());
expectType<AsyncIterableIterator<Row>>(stmt.iterate(1));
expectType<AsyncIterableIterator<Row>>(stmt.iterate(1, { signal }));
expectType<Row | undefined>(stmt.getSync(1));
expectType<Row[]>(stmt.allSync(1));
expectType<unknown[] | undefined>(stmt.getSync(1, { rowMode: 'array' }));
expectType<unknown[][]>(stmt.allSync({ rowMode: 'array' }));
expectType<Statement>(stmt.runSync(1));
expectType<string>(stmt.sql);
expectType<number | bigint | undefined>(stmt.lastID);
expectType<bigint | undefined>(stmt.lastIDBigInt);
expectType<number | undefined>(stmt.changes);
expectType<Promise<void>>(stmt[Symbol.asyncDispose]());
expectType<void>(stmt[Symbol.dispose]());

// --- Backup ---------------------------------------------------------------

declare const backup: Backup;
expectType<Backup>(
    backup.step(1, (e, completed) => {
        expectType<SqliteError | null>(e);
        expectType<boolean>(completed);
    }),
);
expectType<Backup>(backup.finish(() => undefined));
expectType<Promise<boolean>>(backup.step(1));
expectType<Promise<void>>(backup.finish());
expectType<boolean>(backup.idle);
expectType<boolean>(backup.completed);
expectType<boolean>(backup.failed);
expectType<number>(backup.remaining);
expectType<number>(backup.pageCount);
expectType<number[]>(backup.retryErrors);
expectType<string>(backup.filename);
expectType<string>(backup.sourceName);
expectType<string>(backup.destName);
expectType<boolean>(backup.filenameIsDest);
expectType<Promise<void>>(backup[Symbol.asyncDispose]());

// --- User-defined functions, aggregates, collations ------------------------

import type { AggregateDefinition, FunctionOptions } from '../lib/sqlite3.js';

expectType<Database>(db.function('regexp', (_pattern, _value) => 1));
expectType<Database>(db.function('regexp', { deterministic: true }, (_p) => 1));
expectType<Database>(
    db.function('seventh', { varargs: true }, (..._args: unknown[]) => 1),
);
expectType<Database>(
    db.aggregate('median', {
        start: () => [],
        step: (acc, _v) => acc,
        result: (acc) => acc,
        inverse: (acc, _v) => acc,
    }),
);
expectType<Database>(
    db.collation('german', (a, b) => a.localeCompare(b, 'de')),
);
expectType<Database>(db.removeFunction('regexp'));
expectType<Database>(db.removeCollation('german'));

// The option and aggregate types are exported from the package root.
declare const opts: FunctionOptions;
expectType<boolean | undefined>(opts.deterministic);
expectType<boolean | undefined>(opts.directOnly);
expectType<boolean | undefined>(opts.innocuous);
expectType<boolean | undefined>(opts.varargs);
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

expectType<string>(err.code);
expectType<string>(err.primaryCode);
expectType<number>(err.errno);
expectType<string>(err.message);

// --- Worker pool (Deliverable 09) -------------------------------------------

import type {
    PoolOptions,
    PoolQueryOptions,
    SqlitePool,
} from '../lib/sqlite3.js';

// The factory resolves a fully-typed pool.
declare const poolPromise: Promise<SqlitePool>;
expectType<Promise<SqlitePool>>(sqlite3.pool('app.db'));
expectType<Promise<SqlitePool>>(sqlite3.pool('app.db', { readers: 2 }));
expectType<Promise<SqlitePool>>(poolPromise);

// The option surface is closed over the declared keys.
declare const poolOpts: PoolOptions;
expectType<number | undefined>(poolOpts.readers);
expectType<boolean | undefined>(poolOpts.walMode);
expectType<number | undefined>(poolOpts.busyTimeout);
expectType<'number' | 'bigint' | 'mixed' | undefined>(poolOpts.integerMode);

// Query options carry the signal.
declare const queryOpts: PoolQueryOptions;
expectType<AbortSignal | undefined>(queryOpts.signal);

// The query surface.
declare const p: SqlitePool;
expectType<Promise<Row[]>>(p.read('SELECT a'));
expectType<Promise<Row | undefined>>(p.get('SELECT a'));
expectType<Promise<import('../lib/promises.js').PromiseRunResult>>(
    p.write('INSERT'),
);
expectType<Promise<void>>(p.exec('VACUUM'));
expectType<Promise<number>>(p.transaction(async () => 42));
expectType<string>(p.filename);
expectType<number>(p.readers);
expectType<boolean>(p.closed);
expectType<Promise<void>>(p.close());
expectType<Promise<void>>(p[Symbol.asyncDispose]());
