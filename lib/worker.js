// The worker half of sqlite3.pool() (lib/pool.js). One worker owns one
// connection; the pool routes whole queries here and the connection is
// driven exactly one query at a time, which is what makes cancellation
// precise (the progress-flag slot is per connection) and keeps the
// writer a serializer rather than a race.
//
// Message protocol (parent → worker):
//   { kind: 'open', readOnly, walMode, busyTimeout, integerMode }
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
        let value;
        if (msg.method === 'exec') {
            await connection.exec(msg.sql);
        } else if (msg.method === 'run') {
            value = await /** @type {(...args: unknown[]) => any} */ (
                connection.run
            )(msg.sql, msg.params);
        } else {
            // get is all + rows[0], deliberately: an all() runs its
            // statement to completion, so it can never leave a cursor
            // mid-row holding the connection's WAL read snapshot open
            // (a get() that returned a row does, until something resets
            // it — stale reads for every later query on the reader).
            const rows = await /** @type {(...args: unknown[]) => any} */ (
                connection.all
            )(msg.sql, msg.params);
            value = msg.method === 'get' ? rows[0] : rows;
        }
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
 * Opens the connection and applies the pool configuration.
 *
 * @param {{ filename: string, readOnly?: boolean, walMode?: boolean,
 *     busyTimeout?: number, integerMode?: string }} msg the open request.
 * @returns {Promise<void>} resolves once 'ready' (or 'openError') is posted.
 * @private
 */
async function open(msg) {
    const flags = msg.readOnly
        ? sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX
        : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX;
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
        }
        if (msg.integerMode !== undefined) {
            /** @type {(...args: unknown[]) => unknown} */ (
                /** @type {unknown} */ (connection.configure)
            )('integerMode', msg.integerMode);
        }
        // WAL is a persistent property of the file, so only the writer
        // needs to set it; readers pick it up from the file. Setting it
        // from a read-only connection is refused by SQLite anyway.
        if (msg.walMode && !msg.readOnly) {
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
