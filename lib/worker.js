// The worker half of sqlite3.pool() (lib/pool.js). One worker owns one
// connection; the pool routes whole queries here and the connection is
// driven exactly one query at a time, which is what makes cancellation
// precise (the progress-flag slot is per connection) and keeps the
// writer a serializer rather than a race.
//
// Message protocol (parent → worker):
//   { kind: 'open', readOnly, readOnlyFile, walMode, busyTimeout,
//     integerMode }
//   { id, kind: 'query', method: 'all'|'get'|'run'|'exec', sql, params,
//     cancel?: SharedArrayBuffer }
//   { kind: 'close' }
// (worker → parent):
//   { kind: 'ready' } | { kind: 'openError', error }
//   { id, kind: 'result', value } | { id, kind: 'error', error }
//   { kind: 'closed' }
//
// The 'error' payloads are plain objects, not Errors: structured clone
// drops an Error's own properties (code/errno/primaryCode — verified,
// they arrive undefined), so serializeError/deserializeError in
// lib/pool.js carry them explicitly.

import { parentPort } from 'node:worker_threads';

import sqlite3 from './sqlite3.js';

// Non-null inside a worker thread by construction; the check keeps the
// type honest if this module is ever imported outside one.
if (parentPort === null) {
    throw new Error('lib/worker.js must run inside a worker thread');
}
const port = /** @type {import('node:worker_threads').MessagePort} */ (
    parentPort
);

// The filename rides the 'open' message, which is handled before any
// query can arrive (queries only start after 'ready').
/** @type {string | null} */
let connectionFilename = null;

// Set once the 'open' message has been handled.
/** @type {import('./sqlite3-binding.js').Database | null} */
let db = null;

// Cancellation flag period (VM instructions between checks) — the same
// default as db.cancellationToken().
const CANCEL_PERIOD = 1000;

// How long a read may keep retrying a shared-cache table lock: the
// connection's busy timeout, since that is the waiting budget the caller
// asked for (SQLite's own busy handler never fires for SQLITE_LOCKED —
// see runWithLockRetry). Replaced by the 'open' message's value.
let lockRetryBudget = 5000;

/**
 * Packs a query failure for the trip back: message, stack and the
 * SQLite diagnostics the driver attaches, none of which survive
 * structured clone on an Error object.
 *
 * @param {any} err the thrown value.
 * @returns {{ name: string, message: string, stack?: string,
 *     code?: string, errno?: number, primaryCode?: string }} the
 *     serializable form.
 * @private
 */
function serializeError(err) {
    /** @type {{ name: string, message: string, stack?: string,
     *     code?: string, errno?: number, primaryCode?: string }} */
    const out = {
        name: typeof err?.name === 'string' ? err.name : 'Error',
        message: String(err?.message ?? err),
    };
    if (typeof err?.stack === 'string') out.stack = err.stack;
    if (typeof err?.code === 'string') out.code = err.code;
    if (typeof err?.errno === 'number') out.errno = err.errno;
    if (typeof err?.primaryCode === 'string') {
        out.primaryCode = err.primaryCode;
    }
    return out;
}

/**
 * Runs one query on this worker's connection.
 *
 * With a `cancel` buffer, the shared flag is installed as the
 * connection's progress flag first: the pool serializes requests per
 * connection, so the connection is idle here and the install is
 * immediate (and precise — one query at a time means the slot aborts
 * exactly this query). The handler is removed afterwards; a stale
 * installed flag would be harmless (each request has its own buffer)
 * but the removal keeps the connection clean for the next request.
 *
 * @param {{ id: number, method: 'all' | 'get' | 'run' | 'exec',
 *     sql: string, params?: unknown, cancel?: SharedArrayBuffer }} msg
 *     the request.
 * @returns {Promise<void>} resolves once the reply is posted.
 * @private
 */
async function runQuery(msg) {
    const connection = /** @type {import('./sqlite3-binding.js').Database} */ (
        db
    );
    let installed = false;
    if (msg.cancel instanceof SharedArrayBuffer) {
        connection._progressFlag(new Int32Array(msg.cancel), CANCEL_PERIOD);
        installed = true;
    }
    try {
        const value = await runWithLockRetry(connection, msg);
        port.postMessage({ id: msg.id, kind: 'result', value });
    } catch (err) {
        port.postMessage({
            id: msg.id,
            kind: 'error',
            error: serializeError(err),
        });
    } finally {
        if (installed) connection._progressFlag();
    }
}

/**
 * Runs one query, retrying a **read** that lost a shared-cache table lock.
 *
 * In shared-cache mode (`file:…?cache=shared`, the only way pool workers
 * can share an in-memory database) a reader that starts while the writer
 * holds a table lock fails with `SQLITE_LOCKED_SHAREDCACHE` — and the busy
 * timeout does not apply, because SQLite never calls the busy handler for
 * a shared-cache table lock: `sqlite3_unlock_notify` is the mechanism
 * there, and it needs a compile-time option this build does not carry. The
 * lock is held only for the writer's transaction, so the useful behaviour
 * is to wait and try again, which is what the caller's busy timeout budget
 * means.
 *
 * Only `all`/`get` are retried. Re-running an `exec` script, or a `run`
 * that may have been the second statement of a transaction, could repeat
 * work that already landed; a read repeats nothing.
 *
 * @param {import('./sqlite3-binding.js').Database} connection the connection.
 * @param {{ method: 'all' | 'get' | 'run' | 'exec', sql: string,
 *     params?: unknown, cancel?: SharedArrayBuffer }} msg the request.
 * @returns {Promise<unknown>} the query's value.
 * @private
 */
async function runWithLockRetry(connection, msg) {
    const deadline = Date.now() + lockRetryBudget;
    let delay = 1;
    for (;;) {
        try {
            return await runOnce(connection, msg);
        } catch (err) {
            const locked =
                /** @type {any} */ (err)?.primaryCode === 'SQLITE_LOCKED';
            const readOnlyQuery = msg.method === 'all' || msg.method === 'get';
            if (!locked || !readOnlyQuery || Date.now() >= deadline) throw err;
            // A cancellation asked for this query to stop, not to wait.
            if (
                msg.cancel instanceof SharedArrayBuffer &&
                Atomics.load(new Int32Array(msg.cancel), 0) !== 0
            ) {
                throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            if (delay < 50) delay *= 2;
        }
    }
}

/**
 * One attempt at the request's query.
 *
 * @param {import('./sqlite3-binding.js').Database} connection the connection.
 * @param {{ method: 'all' | 'get' | 'run' | 'exec', sql: string,
 *     params?: unknown }} msg the request.
 * @returns {Promise<unknown>} the query's value.
 * @private
 */
async function runOnce(connection, msg) {
    if (msg.method === 'exec') {
        await connection.exec(msg.sql);
        return undefined;
    }
    if (msg.method === 'run') {
        return await /** @type {(...args: unknown[]) => any} */ (
            connection.run
        )(msg.sql, msg.params);
    }
    // get is all + rows[0], deliberately: an all() runs its statement to
    // completion, so it can never leave a cursor mid-row holding the
    // connection's WAL read snapshot open (a get() that returned a row
    // does, until something resets it — stale reads for every later query
    // on the reader).
    const rows = await /** @type {(...args: unknown[]) => any} */ (
        connection.all
    )(msg.sql, msg.params);
    return msg.method === 'get' ? rows[0] : rows;
}

/**
 * Opens the connection and applies the pool configuration.
 *
 * @param {{ filename: string, readOnly?: boolean, readOnlyFile?: boolean,
 *     walMode?: boolean, busyTimeout?: number, integerMode?: string }} msg
 *     the open request.
 * @returns {Promise<void>} resolves once 'ready' (or 'openError') is posted.
 * @private
 */
async function open(msg) {
    // readOnlyFile: the filename is a URI asserting read-only access
    // (mode=ro, immutable=1). The writer opens read-only too then — with
    // OPEN_CREATE it would *create* a database the caller declared
    // immutable, and a missing file would come back as an empty one
    // instead of SQLITE_CANTOPEN.
    let flags =
        msg.readOnly || msg.readOnlyFile
            ? sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX
            : sqlite3.OPEN_READWRITE |
              sqlite3.OPEN_CREATE |
              sqlite3.OPEN_FULLMUTEX;
    // SQLite interprets a `file:` filename as a URI only with
    // SQLITE_OPEN_URI, and without it treats the whole string as a
    // literal path — so `pool('file:/db.sqlite?mode=ro')` used to fail
    // every worker with a bare SQLITE_CANTOPEN even though pool() and
    // sqlite3.open() both document the URI form. The flag is set for
    // exactly the filenames that look like URIs rather than
    // unconditionally: with it on, *every* filename becomes URI syntax,
    // which would change the meaning of a plain path that happens to
    // start with 'file:' (and widens what an untrusted filename can ask
    // for). Deliberately the same rule the permission-model check in
    // lib/sqlite3.js uses, so both see the same target path.
    if (/^file:/i.test(/** @type {string} */ (connectionFilename))) {
        flags |= sqlite3.OPEN_URI;
    }
    try {
        db = await new Promise((resolve, reject) => {
            const conn = new sqlite3.Database(
                /** @type {string} */ (connectionFilename),
                flags,
                (err) => {
                    if (err) reject(err);
                    else resolve(conn);
                },
            );
        });
    } catch (err) {
        port.postMessage({ kind: 'openError', error: serializeError(err) });
        return;
    }
    // Narrowed for the config block below: db is assigned, not null.
    const connection = /** @type {import('./sqlite3-binding.js').Database} */ (
        db
    );
    try {
        if (typeof msg.busyTimeout === 'number') {
            /** @type {(...args: unknown[]) => unknown} */ (
                /** @type {unknown} */ (connection.configure)
            )('busyTimeout', msg.busyTimeout);
            lockRetryBudget = msg.busyTimeout;
        }
        if (msg.integerMode !== undefined) {
            /** @type {(...args: unknown[]) => unknown} */ (
                /** @type {unknown} */ (connection.configure)
            )('integerMode', msg.integerMode);
        }
        // WAL is a persistent property of the file, so only the writer
        // needs to set it; readers pick it up from the file. Setting it
        // from a read-only connection is refused by SQLite anyway.
        if (msg.walMode && !msg.readOnly && !msg.readOnlyFile) {
            const mode = await /** @type {(...args: unknown[]) => any} */ (
                connection.get
            )('PRAGMA journal_mode = WAL');
            if (mode?.journal_mode !== 'wal') {
                throw new Error(
                    `could not enable WAL mode (got '${mode?.journal_mode}'); ` +
                        'the filesystem may not support it',
                );
            }
        }
        // Long-lived connections with a stable SQL mix: the statement
        // cache is the whole point of keeping workers alive.
        connection.cacheStatements();
        port.postMessage({ kind: 'ready' });
    } catch (err) {
        // A config failure (e.g. WAL on a filesystem that refuses it)
        // must not leak the connection; close it before reporting.
        try {
            await /** @type {(...args: unknown[]) => unknown} */ (
                connection.close
            )();
        } catch {
            // The config error is the story worth telling.
        }
        port.postMessage({ kind: 'openError', error: serializeError(err) });
    }
}

port.on('message', (/** @type {any} */ msg) => {
    if (msg.kind === 'open') {
        connectionFilename = msg.filename;
        open(msg);
        return;
    }
    if (msg.kind === 'query') {
        runQuery(msg);
        return;
    }
    if (msg.kind === 'close') {
        if (db === null) {
            // The open never completed (or failed); nothing to close.
            port.postMessage({ kind: 'closed' });
            port.close();
            return;
        }
        const connection =
            /** @type {import('./sqlite3-binding.js').Database} */ (db);
        // A close that fails (e.g. SQLITE_BUSY from a leaked statement)
        // is reported on the 'closed' message. process.exit() here would
        // abort the thread from inside the native completion callback —
        // a fatal napi error — so the exit is a natural one: closing the
        // parent port drops the last handle once the connection (and its
        // statement cache) is gone.
        connection.close((err) => {
            port.postMessage(
                err
                    ? { kind: 'closed', error: serializeError(err) }
                    : { kind: 'closed' },
            );
            port.close();
        });
    }
});
