// The JS half of the driver. The native binding (lib/sqlite3-binding.js)
// provides the Database/Statement/Backup classes and the constants; this
// file adds the callback conveniences around them — the statement cache,
// Database#run/get/all/each/map on top of Statement, backup creation,
// trace/profile/change event wiring — and then installs the promise API
// from lib/promises.js over the finished surface.
//
// Types come from lib/native.d.ts (the native layer's shape); everything
// this file adds to the public surface is declared in lib/augment.d.ts
// and emitted into the generated lib/sqlite3.d.ts.

import diagnostics_channel from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { migrate } from './migrate.js';
import { pool } from './pool.js';
import {
    associateStatement,
    installPromiseApi,
    retracePromiseApi,
} from './promises.js';
import binding from './sqlite3-binding.js';
import { extendTrace } from './trace.js';

/**
 * A native class (Database, Statement or Backup) before the EventEmitter
 * prototype is copied onto it.
 *
 * @typedef {new (...args: never[]) => object} NativeClass
 */
/**
 * `sqlite3.cached` — a registry of connections shared by resolved
 * database path. Special filenames (`''`, `':memory:'`) are never
 * cached; a second call with the same path returns the open connection
 * and still fires the callback once it is ready.
 *
 * @typedef {object} CachedRegistry
 * @property {(filename: string, callback?: (this: import('./sqlite3-binding.js').Database, err: Error | null) => void) => import('./sqlite3-binding.js').Database} Database Open (or reuse) a connection, optionally with a callback.
 * @property {Record<string, import('./sqlite3-binding.js').Database>} objects The registry itself, keyed by resolved path.
 */

/**
 * The constructor type of the v9 `Database` wrapper: every pre-v9
 * positional form plus the {@link OpenOptions} object forms. Declared
 * explicitly (rather than as `typeof` the class) so the namespace typedef
 * below does not reference the module it lives in — that self-reference
 * is a type-resolution cycle.
 *
 * @typedef {new (filename: string, a?: number | OpenOptions | ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void), b?: ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void) | OpenOptions) => import('./sqlite3-binding.js').Database} DatabaseConstructor
 * @since 9.0.0
 */

/**
 * The public `sqlite3` namespace object the package exports as its
 * default: the native binding (the five classes and every SQLite
 * constant with its literal value) plus the JS-layer `verbose`,
 * `cached`, `open`, `deserializeFromBytes` and `pool`. `Database` is the
 * v9 wrapper constructor (a real subclass of the native class) so the
 * {@link OpenOptions} constructor forms typecheck; instances satisfy the
 * native type everywhere.
 *
 * @typedef {import('./sqlite3-binding.js').NativeBinding & {
 *   Database: DatabaseConstructor,
 *   verbose: () => sqlite3,
 *   cached: CachedRegistry,
 *   open: import('./promises.js').OpenFunction,
 *   deserializeFromBytes: (bytes: Uint8Array | ArrayBuffer | DataView, options?: import('./native.js').DeserializeOptions) => Promise<import('./sqlite3-binding.js').Database>,
 *   pool: typeof import('./pool.js').pool,
 *   iterdump: (db: import('./sqlite3-binding.js').Database) => AsyncGenerator<string, void, void>,
 *   migrate: typeof import('./migrate.js').migrate,
 *   subscribeQueries: (onMessage: (message: { sql: string, database: import('./sqlite3-binding.js').Database, duration: bigint, durationMs: number }) => void) => () => void,
 *   flushQuerySpans: () => void,
 * }} sqlite3
 */

const sqlite3 = /** @type {sqlite3} */ (/** @type {unknown} */ (binding));

const { Database: NativeDatabase, Statement, Backup, Session, Blob } = sqlite3;

/**
 * Compiles a function that builds one result row from its arguments.
 *
 * The addon calls this once per result shape and caches what it returns, then
 * builds every row with a single call into it. That is much faster than
 * storing each column into a fresh object from C++: a generated function has
 * one monomorphic shape, so V8 allocates the row with its final layout
 * instead of growing and re-shaping it column by column.
 *
 * The generated object is a plain object literal, which is what makes it a
 * drop-in for the previous per-column stores — same prototype, same
 * result-column order, same last-duplicate-wins collapse, and the same
 * treatment of a `__proto__` column (the literal form assigns the prototype
 * rather than creating an own property, exactly as a property store did).
 *
 * `new Function` is the only way to get a per-shape monomorphic builder, and
 * it is unavailable in realms that forbid code generation from strings. The
 * addon treats a throw here as "no factory" and falls back to its own store
 * loop, so this is a performance feature that degrades rather than fails.
 * @param {string[]} names the result column names, in column order.
 * @param {boolean} wantArray true for the `{ rowMode: 'array' }` shape.
 * @returns {(...values: unknown[]) => unknown} the compiled row builder.
 */
function makeRowFactory(names, wantArray) {
    const params = names.map((_, i) => `v${i}`).join(',');
    if (wantArray) {
        return new Function(`return function(${params}){return [${params}]}`)();
    }
    // JSON.stringify is what escapes the column names into the source: they
    // come from user SQL and can contain quotes, backslashes and newlines.
    const body = names
        .map((name, i) => `${JSON.stringify(name)}:v${i}`)
        .join(',');
    return new Function(`return function(${params}){return {${body}}}`)();
}

sqlite3.setRowFactoryGenerator(makeRowFactory);

/**
 * Copies `source`'s prototype onto `target`, giving the native classes
 * EventEmitter behaviour without a runtime class hierarchy.
 *
 * @param {NativeClass} target the native class to extend.
 * @param {NativeClass} source the class whose prototype is copied.
 * @returns {void}
 * @private
 */
function inherits(target, source) {
    Object.assign(target.prototype, source.prototype);
}

inherits(NativeDatabase, EventEmitter);
inherits(Statement, EventEmitter);
inherits(Backup, EventEmitter);
inherits(Session, EventEmitter);
inherits(Blob, EventEmitter);

// --- Node permission model, extension policy, untrusted files (D11) -----
//
// Node's --permission model restricts the JS fs layer; this package's C
// layer calls open(2) directly, so without these checks a program run with
// --permission --allow-fs-read=/data could read and write any file on the
// system through a SQLite connection (proven by probe, see
// docs/security.md). The checks below run at the JS boundary every open
// path goes through. This is defence in depth, not a sandbox: SQL that
// reaches the filesystem through channels the checks and the ATTACH gate
// do not cover (an unrestricted custom authorizer, a VFS extension) can
// still touch it — docs/security.md names what remains open.

/**
 * True when Node's permission model is active for this process (or worker
 * environment). `process.permission` exists only under `--permission` on
 * every supported Node (observed on 24 and 26; there is no `isEnabled`
 * method — it was removed before Node 24), so its presence is the gate
 * and the cost when the model is off is one property read.
 *
 * @returns {boolean} whether the permission model is active.
 * @private
 */
function permissionModelActive() {
    return typeof process.permission?.has === 'function';
}

/**
 * Builds the refusal error for a permission-model denial: Node's own
 * `ERR_ACCESS_DENIED` shape (code plus `permission` and `resource`
 * properties) with a message that names the path, the scope and a remedy
 * that actually works.
 *
 * @param {'FileSystemRead' | 'FileSystemWrite'} permission the denied scope.
 * @param {string} resource the path that was denied.
 * @param {string} detail what the operation needed and why.
 * @returns {Error} the ERR_ACCESS_DENIED-shaped error.
 * @private
 */
function accessDenied(permission, resource, detail) {
    const flag =
        permission === 'FileSystemRead'
            ? '--allow-fs-read'
            : '--allow-fs-write';
    const err = new Error(
        `${detail} The Node permission model denies ${permission === 'FileSystemRead' ? 'fs.read' : 'fs.write'} for ${resource}; start Node with ${flag} to permit it (or drop --permission).`,
    );
    /** @type {any} */ (err).code = 'ERR_ACCESS_DENIED';
    /** @type {any} */ (err).permission = permission;
    /** @type {any} */ (err).resource = resource;
    return err;
}

/**
 * Parses a SQLite URI filename (`file:` prefix, only interpreted when the
 * open used `OPEN_URI`) using SQLite's own grammar — the WHATWG `URL`
 * parser is wrong here: it turns the relative `file:foo.db` into the
 * root-absolute `/foo.db`.
 *
 * Refuses URI forms this package cannot map to a checkable path, rather
 * than passing them through: an unparsed URI would reach `open(2)`
 * unchecked, which is exactly the hole the checks exist to close.
 *
 * @param {string} uri the `file:` URI.
 * @returns {{ memory: true } | { memory: false, path: string, readonly: boolean }}
 *   the parsed target: in-memory, or a path with its write mode.
 * @throws {Error} ERR_ACCESS_DENIED for URI forms that cannot be checked.
 * @private
 */
function parseSqliteUri(uri) {
    /**
     * @param {string} why the reason the URI cannot be checked.
     * @returns {never}
     */
    const refuse = (why) => {
        throw accessDenied(
            'FileSystemRead',
            uri,
            `Cannot check ${why} against the permission model; this package refuses file: URIs it cannot parse rather than opening them unchecked.`,
        );
    };
    if (!/^file:/i.test(uri)) refuse('a URI without a file: scheme');
    let rest = uri.slice(5);
    if (rest.startsWith('//')) {
        const end = rest.search(/[/?]/);
        const authority = end === -1 ? rest.slice(2) : rest.slice(2, end);
        if (end !== -1) rest = rest.slice(end);
        if (authority && authority.toLowerCase() !== 'localhost') {
            refuse(`the non-local URI authority '${authority}'`);
        }
    }
    let query = '';
    const q = rest.indexOf('?');
    if (q !== -1) {
        query = rest.slice(q + 1);
        rest = rest.slice(0, q);
    }
    let target = '';
    try {
        target = decodeURIComponent(rest);
    } catch {
        refuse('a URI path with invalid percent-escapes');
    }
    if (target === '') refuse('a URI with an empty path');
    const params = new URLSearchParams(query);
    const mode = params.get('mode');
    if (target === ':memory:' || mode === 'memory') {
        return { memory: true };
    }
    if (mode !== null && mode !== 'ro' && mode !== 'rw' && mode !== 'rwc') {
        refuse(`the URI mode parameter '${mode}'`);
    }
    return {
        memory: false,
        path: target,
        readonly: mode === 'ro' || params.get('immutable') === '1',
    };
}

/**
 * Requires fs.read permission for one path under the permission model.
 *
 * @param {string} abs the absolute path to check.
 * @param {string} what the operation being checked, for the message.
 * @returns {void}
 * @throws {Error} ERR_ACCESS_DENIED naming the path and the remedy.
 * @private
 */
function requireReadPermission(abs, what) {
    if (process.permission?.has('fs.read', abs)) return;
    throw accessDenied(
        'FileSystemRead',
        abs,
        `${what} requires reading ${abs}.`,
    );
}

/**
 * Requires fs.write permission for one path. A directory granted either
 * exactly (`--allow-fs-write=/data`) or by wildcard (`--allow-fs-write=/data/*`)
 * satisfies the check; an exact-file grant does not extend to a directory.
 *
 * @param {string} abs the absolute path to check.
 * @param {string} what the operation being checked, for the message.
 * @returns {void}
 * @throws {Error} ERR_ACCESS_DENIED naming the path and the remedy.
 * @private
 */
function requireWritePermission(abs, what) {
    const permission = process.permission;
    if (typeof permission?.has !== 'function') return;
    // Called on the object, not through a detached reference: whether
    // `has` happens to ignore its receiver is an implementation detail,
    // and this is a security check.
    if (
        permission.has('fs.write', abs) ||
        permission.has('fs.write', path.join(abs, '*'))
    ) {
        return;
    }
    throw accessDenied(
        'FileSystemWrite',
        abs,
        `${what} requires writing ${abs}.`,
    );
}

/**
 * Checks one database-file open (the flags a writable open needs on the
 * containing directory are why the directory is checked too: SQLite
 * creates the -journal/-wal/-shm sidecar files beside the database).
 *
 * @param {string} abs the absolute database path.
 * @param {string} who 'Opening' or the backup role, for messages.
 * @returns {void}
 * @throws {Error} ERR_ACCESS_DENIED naming what failed.
 * @private
 */
function checkDatabaseFileOpen(abs, who) {
    requireReadPermission(abs, `${who} ${abs}`);
    requireWritePermission(abs, `${who} ${abs}`);
    const dir = path.dirname(abs);
    if (
        !process.permission?.has('fs.write', dir) &&
        !process.permission?.has('fs.write', path.join(dir, '*'))
    ) {
        throw accessDenied(
            'FileSystemWrite',
            dir,
            `${who} ${abs} also requires writing the directory ${dir}: a writable SQLite database creates its -journal, -wal and -shm files beside it. Grant the directory with the wildcard form (--allow-fs-write="${dir}${path.sep}*"), which covers the database file and its sidecar files.`,
        );
    }
}

/**
 * Enforces the permission model for one `Database` open. Every open path
 * (the constructor, `sqlite3.open`, the cached registry, pool workers)
 * goes through the `Database` wrapper below, which calls this before the
 * native open is scheduled. No-op — one property read — when the model is
 * off.
 *
 * @param {string} filename the filename as passed.
 * @param {number | undefined} mode the open mode as passed (undefined is
 *   the native default: read-write create).
 * @returns {void}
 * @throws {Error} ERR_ACCESS_DENIED naming the path, the scope and a
 *   working remedy.
 * @private
 */
function assertOpenPermitted(filename, mode) {
    if (!permissionModelActive()) return;
    if (typeof filename !== 'string') return; // the native TypeError is better
    if (filename === ':memory:') return;
    const effective =
        typeof mode === 'number' && Number.isInteger(mode)
            ? mode
            : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
    /** @type {string} */
    let target = filename;
    let writable = (effective & sqlite3.OPEN_READONLY) === 0;
    if (effective & sqlite3.OPEN_URI) {
        const parsed = parseSqliteUri(filename);
        if (parsed.memory) return;
        target = parsed.path;
        if (parsed.readonly) writable = false;
    }
    if (target === '') {
        // '' is SQLite's private temporary database: a real file under the
        // temp directory, created and written by SQLite itself.
        requireWritePermission(
            os.tmpdir(),
            "Opening '' (SQLite creates a private temporary database under the temp directory)",
        );
        return;
    }
    const abs = path.resolve(target);
    if (writable) {
        checkDatabaseFileOpen(abs, 'Opening');
    } else {
        requireReadPermission(abs, `Opening ${abs} read-only`);
    }
}

// --- Extension loading policy (Deliverable 11 §2.2) ------------------------
//
// loadExtension loads and executes an arbitrary shared library — the same
// class of operation --allow-addons gates. Under the permission model it
// is refused unless explicitly allowlisted; a `{ deny: true }` policy
// disables it permanently on the connection. The policy is JS-layer state
// (the native entry point is refused before anything is scheduled), and
// the SQL load_extension() function is unreachable: it is off by default
// in the vendored SQLite (probed — see the note in src/database.cc) and
// loadExtension re-disables the C-API gate after every call.

/**
 * @typedef {object} ExtensionPolicy
 * @property {boolean} untrusted the connection was opened `{ untrusted: true }`.
 * @property {boolean} permadeny `configure('extensionPolicy', { deny: true })` was applied.
 * @property {boolean} configured an explicit policy was applied; its allowlist then governs
 *   even when the permission model is off.
 * @property {Set<string>} allow allowed extension paths (as written).
 * @private
 */

/** @type {WeakMap<object, ExtensionPolicy>} */
const extensionPolicies = new WeakMap();

/**
 * Reads (creating on first use) a connection's extension policy.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @returns {ExtensionPolicy} the policy record.
 * @private
 */
function extensionPolicyFor(db) {
    let policy = extensionPolicies.get(db);
    if (policy === undefined) {
        policy = {
            untrusted: false,
            permadeny: false,
            configured: false,
            allow: new Set(),
        };
        extensionPolicies.set(db, policy);
    }
    return policy;
}

/**
 * Applies a `configure('extensionPolicy', …)` request.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @param {unknown} spec `{ allow: [...] }` or `{ deny: true }`.
 * @returns {void}
 * @throws {TypeError} when the policy is malformed or the connection is
 *   hardened past extension loading.
 * @private
 */
function applyExtensionPolicy(db, spec) {
    const policy = extensionPolicyFor(db);
    if (policy.permadeny) {
        throw new TypeError(
            "loadExtension is permanently disabled on this connection: an earlier configure('extensionPolicy', { deny: true }) cannot be reversed",
        );
    }
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new TypeError(
            "configure('extensionPolicy') requires an options object",
        );
    }
    const known = new Set(['allow', 'deny']);
    for (const key of Object.keys(spec)) {
        if (!known.has(key)) {
            throw new TypeError(
                `extensionPolicy received unknown option '${key}'`,
            );
        }
    }
    const deny = /** @type {Record<string, unknown>} */ (spec).deny;
    if (deny !== undefined && typeof deny !== 'boolean') {
        throw new TypeError("extensionPolicy option 'deny' must be a boolean");
    }
    if (deny === true) {
        policy.permadeny = true;
        policy.configured = true;
        policy.allow.clear();
        return;
    }
    const allow = /** @type {Record<string, unknown>} */ (spec).allow;
    if (allow === undefined) {
        throw new TypeError(
            "extensionPolicy requires 'allow' (an array of paths) or 'deny: true'",
        );
    }
    if (!Array.isArray(allow)) {
        throw new TypeError(
            "extensionPolicy option 'allow' must be an array of paths",
        );
    }
    const entries = allow.map((entry, i) => {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new TypeError(
                `extensionPolicy allow[${i}] must be a non-empty string path`,
            );
        }
        return entry;
    });
    if (permissionModelActive()) {
        // Loading a shared library reads (and executes) it: every allowed
        // path must at least be readable under the permission model,
        // checked here — at declare time — because this is the only point
        // where JavaScript runs.
        for (const entry of entries) {
            requireReadPermission(
                path.resolve(entry),
                `Allowing the extension ${entry} for loadExtension`,
            );
        }
    }
    policy.allow = new Set(entries);
    policy.configured = true;
}

/**
 * Refuses or admits one loadExtension call under the active policies.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @param {unknown} filename the extension path as passed.
 * @returns {void}
 * @throws {Error} ERR_ACCESS_DENIED or TypeError when the call is refused.
 * @private
 */
function assertExtensionAllowed(db, filename) {
    const policy = extensionPolicyFor(db);
    if (policy.permadeny) {
        throw new Error(
            'loadExtension is disabled on this connection by its extension policy ({ deny: true } was applied, or it was opened { untrusted: true })',
        );
    }
    // An explicit allowlist governs in both modes; with no policy at all,
    // only the permission model refuses (the pre-v9 behaviour is kept
    // when the model is off).
    if (!policy.configured && !permissionModelActive()) return;
    if (typeof filename !== 'string') return; // the native TypeError is better
    const matches =
        policy.allow.has(filename) || policy.allow.has(path.resolve(filename));
    if (matches) return;
    if (!permissionModelActive()) {
        throw new Error(
            `loadExtension is refused: the extension policy configured on this connection permits only its allowlisted paths. Add ${JSON.stringify(filename)} with db.configure('extensionPolicy', { allow: [...] }).`,
        );
    }
    throw accessDenied(
        'FileSystemRead',
        filename,
        `Loading the extension ${filename} executes native code, which the Node permission model gates: loading shared libraries is what --allow-addons governs. To load this extension, declare it explicitly with db.configure('extensionPolicy', { allow: [${JSON.stringify(path.resolve(filename))}] }) and grant its path fs.read.`,
    );
}

// --- ATTACH gate wiring (Deliverable 11 §2.1) -------------------------------
//
// `ATTACH DATABASE '...' AS x` and `VACUUM INTO '...'` (which SQLite
// implements through an internal ATTACH) reach open(2) from SQL, where no
// JS check can run. The native `_setAttachGate` arms an authorizer
// pre-filter that denies SQLITE_ATTACH unless the target matches an
// allowlist; the allowlist is permission-checked here, at declare time,
// for the same reason as the extension policy. When the permission model
// is active every connection gets an empty (deny-all) gate at open.

/**
 * Applies a `configure('attachPaths', …)` request.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @param {unknown} value an array of allowed target paths, or null to
 *   disarm the gate.
 * @returns {void}
 * @throws {TypeError | Error} when the list is malformed, a path is not
 *   permitted, or the connection is untrusted.
 * @private
 */
function applyAttachPaths(db, value) {
    const policy = extensionPolicyFor(db);
    if (policy.untrusted) {
        throw new TypeError(
            'untrusted connections cannot allow ATTACH: they were opened with the deny-all gate as part of their hardening',
        );
    }
    if (value === null || value === undefined) {
        /** @type {(...args: unknown[]) => unknown} */ (
            /** @type {unknown} */ (db._setAttachGate)
        ).call(db, false, []);
        return;
    }
    if (!Array.isArray(value)) {
        throw new TypeError(
            "configure('attachPaths') requires an array of paths, or null to disarm the gate",
        );
    }
    const entries = value.map((entry, i) => {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new TypeError(
                `attachPaths[${i}] must be a non-empty string path`,
            );
        }
        return entry;
    });
    if (permissionModelActive()) {
        for (const entry of entries) {
            // ATTACH opens its target read-write-create by default, so the
            // checks match a writable open of the same path. A read-only
            // URI (file:...?mode=ro / immutable=1) needs only fs.read.
            if (/^file:/i.test(entry)) {
                const parsed = parseSqliteUri(entry);
                if (parsed.memory) continue;
                requireReadPermission(
                    path.resolve(parsed.path),
                    `Allowing ATTACH of ${entry}`,
                );
                if (!parsed.readonly) {
                    checkDatabaseFileOpen(
                        path.resolve(parsed.path),
                        `Allowing ATTACH of ${entry}`,
                    );
                }
            } else {
                checkDatabaseFileOpen(
                    path.resolve(entry),
                    `Allowing ATTACH of ${entry}`,
                );
            }
        }
    }
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (db._setAttachGate)
    ).call(db, true, entries);
}

// --- Untrusted database files (Deliverable 11 §2.3) -------------------------

// One option flag standing in for a page of SQLite hardening lore. The
// values are deliberately conservative and documented in
// docs/security.md; they are applied as queued configuration before any
// user work can run (the open is FIFO-ahead of them).
// Capacity of the implicit statement cache the synchronous paths keep when
// the caller has not opted into cacheStatements(). Same default as that
// one; see Database#_statementForSync.
const SYNC_STMT_CACHE_MAX = 64;

/** @type {Array<[number, number]>} */
const UNTRUSTED_LIMITS = [
    // LIMIT_LENGTH: one string, BLOB, table or row budget (SQLite default
    // 1 GiB). 64 MiB bounds a hostile record without clipping real ones.
    [sqlite3.LIMIT_LENGTH, 64 * 1024 * 1024],
    // LIMIT_SQL_LENGTH: largest compiled statement (default 1 GiB).
    [sqlite3.LIMIT_SQL_LENGTH, 1024 * 1024],
    // LIMIT_EXPR_DEPTH: parser recursion per expression (default 1000).
    [sqlite3.LIMIT_EXPR_DEPTH, 100],
    // LIMIT_VDBE_OP: opcodes per prepared statement (default 250M).
    [sqlite3.LIMIT_VDBE_OP, 25000],
    // LIMIT_ATTACHED: no ATTACH at all, behind the deny-all gate.
    [sqlite3.LIMIT_ATTACHED, 0],
];

/**
 * Applies the untrusted-file hardening to a freshly constructed
 * connection. Runs immediately after `super()` in the wrapper: every call
 * below schedules onto the connection queue behind the still-pending
 * open, so the hardening is in place before any user work runs, with no
 * window in between (the queue is FIFO and the open has not completed).
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @returns {void}
 * @private
 */
function applyUntrustedHardening(db) {
    const policy = extensionPolicyFor(db);
    policy.untrusted = true;
    policy.permadeny = true;
    // Defensive mode + distrust the schema + writable_schema off: the
    // three switches that stop a hostile file's schema (views, triggers,
    // CHECK constraints) from invoking dangerous built-ins or from
    // rewriting sqlite_schema. _dbConfig is the native core; the JS
    // dbConfig() wrapper is dual-mode and would return promises here.
    const dbConfig = /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (db._dbConfig)
    );
    /**
     * The hardening verbs cannot realistically fail, but a failure must
     * surface somewhere: route it to the connection's 'error' event
     * rather than letting it vanish into a fire-and-forget call.
     *
     * @param {import('./native.js').SqliteError | null} err
     */
    const onHardeningError = (err) => {
        if (err) db.emit('error', err);
    };
    dbConfig.call(db, sqlite3.DBCONFIG_DEFENSIVE, 1, onHardeningError);
    dbConfig.call(db, sqlite3.DBCONFIG_TRUSTED_SCHEMA, 0, onHardeningError);
    dbConfig.call(db, sqlite3.DBCONFIG_WRITABLE_SCHEMA, 0, onHardeningError);
    // Resource ceilings and the deny-ATTACH authorizer gate.
    for (const [id, value] of UNTRUSTED_LIMITS) {
        db.configure('limit', id, value);
    }
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (db._setAttachGate)
    ).call(db, true, []);
}

// --- The Database wrapper ----------------------------------------------------
//
// Every connection goes through this wrapper (the namespace rebind below
// points sqlite3.Database, sqlite3.open, the cached registry and the pool
// workers at it). It runs the permission-model checks before the native
// open is scheduled, accepts the v9 open options, and applies the
// untrusted hardening. Instances are indistinguishable from native ones:
// instanceof holds in both directions and every prototype method — the
// ones below and the promise layer — applies unchanged.

/**
 * Options for opening a database (v9). Accepted anywhere a mode number
 * could appear in the `Database` constructor and in `sqlite3.open`'s
 * second argument.
 *
 * @typedef {object} OpenOptions
 * @property {number} [mode] open flags, e.g. `sqlite3.OPEN_READWRITE`.
 * @property {boolean} [untrusted] harden the connection for an
 *   attacker-supplied database file: defensive mode, untrusted schema,
 *   writable_schema off, extension loading permanently disabled,
 *   conservative run-time limits and a deny-all ATTACH gate. See
 *   docs/security.md#untrusted-database-files.
 * @since 9.0.0
 */

// Captured before the wrapper patches anything: the native halves the
// wrappers below delegate to.
const nativeConfigure = /** @type {(...args: unknown[]) => unknown} */ (
    /** @type {unknown} */ (NativeDatabase.prototype.configure)
);
const nativeLoadExtension = /** @type {(...args: unknown[]) => unknown} */ (
    /** @type {unknown} */ (NativeDatabase.prototype.loadExtension)
);

/**
 * True for a v9 open-options object (every own key is one of the known
 * option keys), used to pick the options argument out of the constructor's
 * legacy positional shapes.
 *
 * @param {unknown} value the candidate.
 * @returns {boolean} whether it is an options object.
 * @private
 */
function isOpenOptions(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const keys = Object.keys(value);
    return (
        keys.length > 0 &&
        keys.every(
            (key) =>
                key === 'mode' ||
                key === 'untrusted' ||
                // Internal: the node:sqlite compat shim's synchronous open
                // (lib/compat.js); not part of the public surface.
                key === 'syncOpen',
        )
    );
}

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
class DatabaseClass extends NativeDatabase {
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
    constructor(filename, a, b) {
        /** @type {number | undefined} */
        let mode;
        /** @type {((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void) | undefined} */
        let callback;
        let untrusted = false;
        if (typeof a === 'number' && Number.isInteger(a)) {
            mode = a;
        } else if (typeof a === 'function') {
            callback = a;
        } else if (isOpenOptions(a)) {
            const opts = /** @type {OpenOptions} */ (a);
            if (opts.mode !== undefined) {
                if (typeof opts.mode !== 'number') {
                    throw new TypeError(
                        "open option 'mode' must be a number (an OPEN_* flag set)",
                    );
                }
                mode = opts.mode;
            }
            if (opts.untrusted !== undefined) {
                if (typeof opts.untrusted !== 'boolean') {
                    throw new TypeError(
                        "open option 'untrusted' must be a boolean",
                    );
                }
                untrusted = opts.untrusted;
            }
        } else if (a !== undefined && a !== null) {
            throw new TypeError(
                'Database expects a mode number, an options object or a callback as its second argument',
            );
        }
        let syncOpen = false;
        if (
            isOpenOptions(a) &&
            /** @type {{ syncOpen?: unknown }} */ (/** @type {unknown} */ (a))
                .syncOpen !== undefined
        ) {
            const flag = /** @type {{ syncOpen?: unknown }} */ (
                /** @type {unknown} */ (a)
            ).syncOpen;
            if (typeof flag !== 'boolean') {
                throw new TypeError("open option 'syncOpen' must be a boolean");
            }
            syncOpen = flag;
        }
        if (b !== undefined && b !== null) {
            if (typeof b === 'function') {
                callback = b;
            } else if (isOpenOptions(b)) {
                const opts =
                    /** @type {OpenOptions & { syncOpen?: boolean }} */ (b);
                if (opts.mode !== undefined && mode === undefined) {
                    mode = opts.mode;
                }
                if (opts.untrusted === true) untrusted = true;
                if (opts.syncOpen === true) syncOpen = true;
            }
        }
        assertOpenPermitted(filename, mode);
        super(
            filename,
            ...(mode !== undefined ? [mode] : []),
            ...(callback !== undefined ? [callback] : []),
            ...(syncOpen ? [true] : []),
        );
        // diagnostics_channel (Phase 6): tracked so a subscriber arriving
        // after the connection was opened can arm query-span publication
        // on it; armed eagerly here when one is already listening.
        trackConnection(this);
        if (diagnosticsChannelSubscribers.size > 0) {
            armDiagnosticsFor(this);
        }
        if (untrusted) {
            applyUntrustedHardening(this);
        } else if (permissionModelActive()) {
            // The ATTACH gate closes the SQL-level path to the filesystem
            // (ATTACH and VACUUM INTO); the deny-all default is opened up
            // only through configure('attachPaths', ...).
            /** @type {(...args: unknown[]) => unknown} */ (
                /** @type {unknown} */ (this._setAttachGate)
            ).call(this, true, []);
        }
    }
}

// The namespace binding is a Proxy around the class for one reason: a
// native node-addon-api class and a JavaScript class word their
// call-without-new TypeError differently ("Class constructors cannot be
// invoked…" vs "Class constructor Database cannot be invoked…"), and the
// exact pre-v9 message is pinned by tests and matched by user code. The
// named export is the class itself; `import { Database }` callers get the
// plain subclass.
sqlite3.Database = /** @type {sqlite3['Database']} */ (
    /** @type {unknown} */ (
        new Proxy(DatabaseClass, {
            /**
             * Reproduces the native class's exact call-without-new
             * TypeError.
             *
             * @returns {never}
             */
            apply() {
                throw new TypeError(
                    "Class constructors cannot be invoked without 'new'",
                );
            },
        })
    )
);

// The rest of this file (and the promise layer) patches the class
// prototype; this alias keeps those assignments unchanged.
const Database = DatabaseClass;

/**
 * Configures the connection: the pre-v9 native options plus the v9
 * security policies.
 *
 * - `configure('extensionPolicy', { allow: [...] } | { deny: true })` —
 *   see {@link Database#loadExtension}.
 * - `configure('attachPaths', [...] | null)` — the ATTACH-gate allowlist
 *   (or null to disarm a manually-armed gate).
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} option the configuration option.
 * @param {...unknown} rest the option's arguments.
 * @returns {any} this database, for chaining.
 */
Database.prototype.configure = function (option, ...rest) {
    if (option === 'extensionPolicy') {
        applyExtensionPolicy(this, rest[0]);
        return this;
    }
    if (option === 'attachPaths') {
        applyAttachPaths(this, rest[0]);
        return this;
    }
    return /** @type {any} */ (nativeConfigure.call(this, option, ...rest));
};

/**
 * Loads a SQLite extension — arbitrary native code in a shared library,
 * gated by policy.
 *
 * Under Node's permission model every load is refused unless the exact
 * path was declared with `configure('extensionPolicy', { allow: [...] })`
 * and is fs.read-permitted. `configure('extensionPolicy', { deny: true })`
 * disables loading permanently for the connection. On untrusted
 * connections (`{ untrusted: true }`) loading is permanently disabled from
 * the start.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} filename the extension file.
 * @param {...unknown} rest optionally a callback.
 * @returns {any} this database in callback mode (the promise layer
 *   rewraps the core).
 * @throws {Error} when the policy refuses the load, naming the path and
 *   the remedy.
 */
Database.prototype.loadExtension = function (filename, ...rest) {
    assertExtensionAllowed(this, filename);
    return /** @type {any} */ (
        nativeLoadExtension.call(this, filename, ...rest)
    );
};

/**
 * Creates a backup. The filename side (destination in the short form,
 * source when `filenameIsDest` is false) is opened by the native Backup
 * layer directly, so under the permission model it is checked like any
 * other open — read and write on the file, write on its directory.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {...unknown} args filename and optional callback, or the full
 *   filename/source/dest/direction/callback form.
 * @returns {import('./sqlite3-binding.js').Backup} the created backup.
 * @throws {Error} ERR_ACCESS_DENIED under the permission model when the
 *   filename side is not permitted.
 */
// Database#backup(filename, [callback])
// Database#backup(filename, destName, sourceName, filenameIsDest, [callback])
Database.prototype.backup = function (...args) {
    if (permissionModelActive() && typeof args[0] === 'string') {
        const filenameIsDest =
            args.length <= 2 ||
            args[3] === undefined ||
            /** @type {boolean} */ (args[3]);
        const who = filenameIsDest ? 'Backing up into' : 'Backing up from';
        checkDatabaseFileOpen(path.resolve(args[0]), who);
    }
    /** @type {import('./sqlite3-binding.js').Backup} */
    let backup;
    if (args.length <= 2) {
        backup = new Backup(
            this,
            /** @type {string} */ (args[0]),
            'main',
            'main',
            true,
            /** @type {((err: Error | null) => void) | undefined} */ (args[1]),
        );
    } else {
        backup = new Backup(
            this,
            /** @type {string} */ (args[0]),
            /** @type {string} */ (args[1]),
            /** @type {string} */ (args[2]),
            /** @type {boolean} */ (args[3]),
            /** @type {((err: Error | null) => void) | undefined} */ (args[4]),
        );
    }
    // Per the sqlite docs, exclude the following errors as non-fatal by default.
    backup.retryErrors = [sqlite3.BUSY, sqlite3.LOCKED];
    return backup;
};

/**
 * Pops a trailing error-first callback off `args`, wrapped so it is
 * only invoked for a truthy error — the `err === null` success call is
 * the caller's business, not the extractErrBack user's.
 *
 * @param {unknown[]} args the call arguments.
 * @returns {((err: import('./native.js').SqliteError | null) => void) | undefined} the wrapped callback, or undefined.
 * @private
 */
function extractErrBack(args) {
    const last = args[args.length - 1];
    if (args.length > 0 && typeof last === 'function') {
        const callback =
            /** @type {(err: import('./native.js').SqliteError) => void} */ (
                last
            );
        /**
         * @param {import('./native.js').SqliteError | null} err
         */
        function rethrow(err) {
            if (err) callback(err);
        }
        return rethrow;
    }
    return undefined;
}

/**
 * Splits a call's trailing callback across the two native slots that can
 * both observe one failed prepare: the statement's error-only prepare
 * errback and the queued statement method's completion callback (which
 * also carries the call's results). When the prepare fails, both slots
 * fire with the same error; the shared token here keeps the user's
 * callback to a single invocation, whatever route delivered first.
 * Success calls flow through untouched.
 *
 * Mutates `args`, replacing the trailing callback with the guarded
 * completion wrapper.
 *
 * @param {unknown[]} args the call arguments, ending in a callback.
 * @returns {{
 *   errback: (this: import('./sqlite3-binding.js').Statement, err: import('./native.js').SqliteError | null) => void,
 *   completion: (this: import('./sqlite3-binding.js').Statement, ...call: unknown[]) => void,
 * } | null} the two slot handlers, or null with no trailing callback.
 * @private
 */
function splitPrepareCallback(args) {
    const errBack = extractErrBack(args);
    if (errBack === undefined) return null;
    const userCallback = /** @type {(...call: unknown[]) => void} */ (
        args[args.length - 1]
    );
    let delivered = false;
    /**
     * @param {import('./native.js').SqliteError | null} err
     * @this {import('./sqlite3-binding.js').Statement}
     */
    const errback = function (err) {
        if (!err || delivered) return;
        delivered = true;
        errBack.call(this, err);
    };
    /**
     * @param {...unknown} call
     * @this {import('./sqlite3-binding.js').Statement}
     */
    const completion = function (...call) {
        if (call[0] && delivered) return;
        if (call[0]) delivered = true;
        userCallback.apply(this, call);
    };
    args[args.length - 1] = completion;
    return { errback, completion };
}

// Captured before the promise API wraps Statement#bind: prepare()'s bind
// path must keep its synchronous statement return, and a dual-mode bind
// would hand back a promise instead.
/** @type {(...args: any[]) => any} */
const nativeStatementBind = Statement.prototype.bind;
// Internal fire-and-forget finalizes must not allocate a promise per call:
// they sit on the hot path of every uncached run/get/all/each/map.
/** @type {(...args: any[]) => any} */
const nativeStatementFinalize = Statement.prototype.finalize;

// --- Sessions, changesets, serialization and blob I/O (Deliverable 08) -----
//
// The native halves run through the same queues as statement work; these
// wrappers add option parsing and the promise layer (lib/promises.js)
// rewraps the cores for dual-mode use.

// sqlite3_deserialize flags, composed by deserializeFromBytes().
const DESERIALIZE_RESIZEABLE = 2;
const DESERIALIZE_READONLY = 4;

/**
 * Creates a session that records changes made through this connection.
 *
 * The returned session records every INSERT, UPDATE and DELETE on the
 * attached tables (only tables with a primary key are recordable); call
 * {@link Session#changeset} to harvest the recorded changes as a
 * `Uint8Array`, and `close()` when done. A session left open is closed
 * by `db.close()`.
 *
 * A connection has a single preupdate hook, shared between sessions and
 * the `'preupdate'` event: creating a session while a `'preupdate'`
 * listener is registered throws, and registering the listener while a
 * session is open fails the registration — one would silently stop the
 * other.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {import('./native.js').SessionOptions | ((err: import('./native.js').SqliteError | null) => void)} [options]
 *   the options object, or the ready callback.
 * @param {(this: import('./sqlite3-binding.js').Session, err: import('./native.js').SqliteError | null) => void} [callback]
 *   called once the session is recording (create errors surface here or
 *   on the session's `'error'` event).
 * @returns {import('./sqlite3-binding.js').Session} the session (it starts recording asynchronously).
 * @throws {TypeError} when the options are malformed or a 'preupdate'
 *   listener is registered on this connection.
 * @since 9.0.0
 * @example
 * const session = db.session({ table: 'users' });
 * await db.run('UPDATE users SET name = ? WHERE id = ?', 'x', 1);
 * const changeset = await session.changeset();
 * session.close();
 */
Database.prototype.session = function (options, callback) {
    /** @type {string} */
    let dbName = 'main';
    /** @type {string} */
    let table = '';
    let indirect = false;
    if (typeof options === 'function') {
        callback = options;
    } else if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('session() options must be an object');
        }
        const known = new Set(['db', 'table', 'indirect']);
        for (const key of Object.keys(options)) {
            if (!known.has(key)) {
                throw new TypeError(
                    `session() received unknown option '${key}'`,
                );
            }
        }
        if (options.db !== undefined) {
            if (typeof options.db !== 'string') {
                throw new TypeError("session() option 'db' must be a string");
            }
            dbName = options.db;
        }
        if (options.table !== undefined) {
            if (typeof options.table !== 'string') {
                throw new TypeError(
                    "session() option 'table' must be a string",
                );
            }
            table = options.table;
        }
        if (options.indirect !== undefined) {
            if (typeof options.indirect !== 'boolean') {
                throw new TypeError(
                    "session() option 'indirect' must be a boolean",
                );
            }
            indirect = options.indirect;
        }
    }
    return new Session(this, dbName, table, indirect, callback);
};

/**
 * Applies a changeset (or patchset) to this connection inside one
 * savepoint: either every change lands or the apply is rolled back.
 *
 * `options.conflict` decides what happens when a change cannot be
 * applied cleanly: `'abort'` (the default) rolls the whole apply back,
 * `'omit'` skips the conflicting change, `'replace'` overwrites the
 * conflicting row (legal for `'data'` and `'conflict'` conflicts only).
 * A function is the fully general form — it receives the conflict
 * description and returns one of those decisions; it runs as a blocking
 * round trip from the applying thread, so it must not use the
 * synchronous methods on this connection. `options.filter` receives
 * each affected table name and returns false to skip it.
 *
 * In callback mode returns this database; the promise layer rewraps the
 * core.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {Uint8Array | ArrayBuffer | DataView} changeset the changeset bytes.
 * @param {import('./native.js').ApplyChangesetOptions | ((this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void)} [options]
 *   the conflict policy and optional table filter, or the callback.
 * @param {(this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null) => void} [callback]
 *   called once the apply completed or rolled back.
 * @returns {any} this database in callback mode (the promise layer
 *   rewraps the core).
 * @throws {TypeError} when the bytes or options are malformed.
 * @since 9.0.0
 * @example
 * await db.applyChangeset(changeset, { conflict: 'replace' });
 */
Database.prototype.applyChangeset = function (changeset, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    /** @type {number | undefined} */
    let decision;
    /** @type {import('./native.js').ApplyChangesetOptions['conflict']} */
    let onConflict;
    /** @type {((table: string) => boolean) | null | undefined} */
    let onFilter;
    let wantRebase = false;
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('applyChangeset() options must be an object');
        }
        const known = new Set(['conflict', 'onConflict', 'filter', 'rebase']);
        for (const key of Object.keys(options)) {
            if (!known.has(key)) {
                throw new TypeError(
                    `applyChangeset() received unknown option '${key}'`,
                );
            }
        }
        onConflict = options.conflict ?? options.onConflict;
        onFilter = options.filter;
        if (
            options.rebase !== undefined &&
            typeof options.rebase !== 'boolean'
        ) {
            throw new TypeError(
                "applyChangeset() option 'rebase' must be a boolean",
            );
        }
        wantRebase = options.rebase === true;
    }
    if (onConflict === undefined || onConflict === null) {
        decision = sqlite3.CHANGESET_ABORT;
    } else if (typeof onConflict === 'function') {
        decision = sqlite3.CHANGESET_ABORT;
    } else if (onConflict === 'abort') {
        decision = sqlite3.CHANGESET_ABORT;
    } else if (onConflict === 'omit') {
        decision = sqlite3.CHANGESET_OMIT;
    } else if (onConflict === 'replace') {
        decision = sqlite3.CHANGESET_REPLACE;
    } else {
        throw new TypeError(
            "applyChangeset() conflict must be 'abort', 'omit', 'replace' or a function",
        );
    }
    if (
        onFilter !== undefined &&
        onFilter !== null &&
        typeof onFilter !== 'function'
    ) {
        throw new TypeError('applyChangeset() filter must be a function');
    }
    // A string policy travels in `decision`; only a function is a
    // handler (a bare string must not reach the native handler slot).
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._applyChangeset)
    )(
        changeset,
        decision,
        typeof onConflict === 'function' ? onConflict : null,
        typeof onFilter === 'function' ? onFilter : null,
        callback,
        wantRebase,
    );
    return this;
};

/**
 * Serializes the whole database (or one attached schema) to a
 * `Uint8Array` — an in-memory snapshot of the exact bytes a file copy
 * would contain. Exclusive on the connection: it waits for in-flight
 * work so the snapshot cannot interleave with writes. Feed the result to
 * {@link sqlite3.deserializeFromBytes}.
 *
 * The snapshot carries every committed transaction: serialization reads
 * each page through the pager, and the pager reads through the WAL, so
 * frames not yet checkpointed are included. The returned bytes are
 * rewritten to rollback-journal format — a WAL-format image would demand
 * WAL recovery that a deserialized copy cannot perform (it has no `-wal`
 * file) — so the output is always valid input to
 * `deserializeFromBytes()`. The live database's journal mode is
 * untouched.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string | ((err: import('./native.js').SqliteError | null, bytes: Uint8Array) => void)} [dbName]
 *   the attached database name (default `'main'`), or the callback.
 * @param {(this: import('./sqlite3-binding.js').Database, err: import('./native.js').SqliteError | null, bytes: Uint8Array) => void} [callback]
 *   receives the bytes.
 * @returns {any} this database in callback mode (the promise layer
 *   rewraps the core to resolve the bytes).
 * @since 9.0.0
 * @example
 * const bytes = await db.serializeToBytes();
 */
Database.prototype.serializeToBytes = function (dbName, callback) {
    if (typeof dbName === 'function') {
        callback = dbName;
        dbName = 'main';
    }
    if (dbName !== undefined && dbName !== null && typeof dbName !== 'string') {
        throw new TypeError(
            'serializeToBytes() database name must be a string',
        );
    }
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._serializeToBytes)
    )(dbName ?? 'main', callback);
    return this;
};

/**
 * Opens an incremental blob handle for streaming reads and writes of one
 * row's blob column ({@link Blob#read}, {@link Blob#write},
 * `blob.createReadStream()`), instead of materialising the whole value
 * as one `Buffer`. Any write to the row invalidates open handles
 * (`SQLITE_ABORT`); `blob.reopen(rowid)` re-aims a handle after that.
 *
 * The handle is closed by `blob.close()` or by `db.close()`.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {import('./native.js').OpenBlobOptions} options what to open.
 * @param {(this: import('./sqlite3-binding.js').Blob, err: import('./native.js').SqliteError | null) => void} [callback]
 *   called once the handle is open (open errors surface here or on the
 *   blob's `'error'` event).
 * @returns {import('./sqlite3-binding.js').Blob} the blob handle (it opens asynchronously).
 * @throws {TypeError} when the options are malformed.
 * @since 9.0.0
 * @example
 * const blob = await db.openBlob({ table: 'files', column: 'data', rowid: 1 });
 * const chunk = new Uint8Array(65536);
 * const n = await blob.read(chunk, 0);
 * await blob.close();
 */
Database.prototype.openBlob = function (options, callback) {
    if (
        options === null ||
        typeof options !== 'object' ||
        Array.isArray(options)
    ) {
        throw new TypeError('openBlob() requires an options object');
    }
    const { table, column, rowid } = options;
    if (typeof table !== 'string' || table.length === 0) {
        throw new TypeError(
            "openBlob() option 'table' must be a non-empty string",
        );
    }
    if (typeof column !== 'string' || column.length === 0) {
        throw new TypeError(
            "openBlob() option 'column' must be a non-empty string",
        );
    }
    if (typeof rowid !== 'number' || !Number.isInteger(rowid)) {
        throw new TypeError("openBlob() option 'rowid' must be an integer");
    }
    const db = options.db ?? 'main';
    if (typeof db !== 'string') {
        throw new TypeError("openBlob() option 'db' must be a string");
    }
    const readOnly = options.readOnly ?? false;
    if (typeof readOnly !== 'boolean') {
        throw new TypeError("openBlob() option 'readOnly' must be a boolean");
    }
    return new Blob(this, db, table, column, rowid, readOnly, callback);
};

/**
 * Builds a database from serialized bytes (from
 * {@link Database#serializeToBytes} or a database file read into memory):
 * opens a fresh in-memory connection and installs the bytes as its
 * `main` schema.
 *
 * The bytes are **copied** into SQLite-owned memory — a `Uint8Array`'s
 * backing store cannot be handed to SQLite directly without a
 * use-after-free risk — so a large snapshot costs the copy's time and
 * memory once. Corrupt input rejects with `SQLITE_NOTADB`.
 *
 * @param {Uint8Array | ArrayBuffer | DataView} bytes the serialized database.
 * @param {import('./native.js').DeserializeOptions} [options] `readOnly`
 *   makes the result read-only; `resizable` lets it grow on write.
 * @returns {Promise<import('./sqlite3-binding.js').Database>} the opened database.
 * @throws {TypeError} when the bytes or options are malformed; rejects
 *   with `SQLITE_NOTADB` on corrupt input.
 * @since 9.0.0
 * @example
 * const db = await sqlite3.deserializeFromBytes(bytes, { resizable: true });
 */
sqlite3.deserializeFromBytes = async function deserializeFromBytes(
    bytes,
    options,
) {
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError(
                'deserializeFromBytes() options must be an object',
            );
        }
        const known = new Set(['readOnly', 'resizable']);
        for (const key of Object.keys(options)) {
            if (!known.has(key)) {
                throw new TypeError(
                    `deserializeFromBytes() received unknown option '${key}'`,
                );
            }
        }
        for (const key of known) {
            const value = /** @type {Record<string, unknown>} */ (options)[key];
            if (value !== undefined && typeof value !== 'boolean') {
                throw new TypeError(
                    `deserializeFromBytes() option '${key}' must be a boolean`,
                );
            }
        }
    }
    const flags =
        (options?.readOnly === true ? DESERIALIZE_READONLY : 0) |
        (options?.resizable === true ? DESERIALIZE_RESIZEABLE : 0);
    return new Promise((resolve, reject) => {
        try {
            // The callback sits in the mode slot at runtime (the
            // constructor skips a non-number there); the cast keeps the
            // variadic constructor shape honest for the type checker,
            // the same trick sqlite3.open uses.
            const OpenCtor =
                /** @type {new (filename: string, ...rest: unknown[]) => import('./sqlite3-binding.js').Database} */ (
                    /** @type {unknown} */ (Database)
                );
            /**
             * @param {Error | null} openErr
             */
            const onOpen = (openErr) => {
                if (openErr) {
                    reject(openErr);
                    return;
                }
                /**
                 * @param {import('./native.js').SqliteError | null} err
                 */
                const onDeserialized = (err) => {
                    if (err) {
                        db.close(() => reject(err));
                        return;
                    }
                    resolve(db);
                };
                /** @type {(...args: unknown[]) => unknown} */ (
                    /** @type {unknown} */ (db._deserialize)
                )(bytes, flags, onDeserialized);
            };
            const db = new OpenCtor(':memory:', onOpen);
        } catch (err) {
            reject(err);
        }
    });
};

// Database#prepare stays uncached: the caller owns the returned statement.
//
// The no-callback form returns a thenable wrapper around the statement.
// Awaiting it settles only once the worker has completed the prepare (and
// any bind), so the introspection accessors — `columns`, `parameterCount`,
// `parameterNames`, `readonly` — are populated at the first read after the
// await. The wrapper forwards every statement member, so pre-await
// chaining (`db.prepare(sql).run(...)`, `.finalize()`) keeps the
// historical synchronous surface; after the await, callers hold the
// statement itself. The callback form is unchanged: it returns the
// statement synchronously and a prepare error surfaces through its
// error-only errback rather than as a rejection.

/**
 * Wraps a statement whose prepare (and optional bind) is still queued:
 * awaiting the wrapper settles only once that work has landed, while every
 * statement member stays reachable for pre-await chaining. After the
 * await, callers hold the statement itself, not the wrapper.
 *
 * @param {import('./sqlite3-binding.js').Statement} statement the statement.
 * @param {Promise<import('./sqlite3-binding.js').Statement>} ready the completion promise.
 * @param {() => void} addAwaiter called for every read of `then`, so the
 *   failure routing can tell awaited wrappers from fire-and-forget ones.
 * @returns {import('./sqlite3-binding.js').Statement & Promise<import('./sqlite3-binding.js').Statement>} the thenable wrapper.
 * @private
 */
function prepareThenableWrapper(statement, ready, addAwaiter) {
    /** @type {import('./sqlite3-binding.js').Statement & Promise<import('./sqlite3-binding.js').Statement>} */
    let wrapper;
    wrapper =
        /** @type {import('./sqlite3-binding.js').Statement & Promise<import('./sqlite3-binding.js').Statement>} */ (
            /** @type {unknown} */ (
                new Proxy(statement, {
                    /**
                     * @param {import('./sqlite3-binding.js').Statement} target
                     * @param {string | symbol} prop
                     */
                    get(target, prop) {
                        if (prop === 'then') {
                            addAwaiter();
                            return /** @type {(onFulfilled?: (value: unknown) => unknown, onRejected?: (err: Error) => unknown) => unknown} */ (
                                resolve,
                                reject,
                            ) =>
                                ready.then(
                                    /**
                                     * @param {import('./sqlite3-binding.js').Statement} value
                                     */
                                    (value) =>
                                        /** @type {(value: unknown) => unknown} */ (
                                            resolve
                                        )(value),
                                    /**
                                     * @param {Error} err
                                     */
                                    (err) =>
                                        /** @type {(err: Error) => unknown} */ (
                                            reject
                                        )(err),
                                );
                        }
                        if (prop === 'catch') {
                            return (
                                /** @param {(err: Error) => unknown} onRejected */
                                (onRejected) => ready.catch(onRejected)
                            );
                        }
                        if (prop === 'finally') {
                            return (
                                /** @param {() => void} onFinally */
                                (onFinally) => ready.finally(onFinally)
                            );
                        }
                        const value = Reflect.get(target, prop, target);
                        if (typeof value !== 'function') return value;
                        // Native methods must run with the statement as
                        // the receiver: a proxy receiver cannot be
                        // unwrapped back to the ObjectWrap.
                        return /** @type {(...args: unknown[]) => unknown} */ (
                            ...args
                        ) => {
                            const result = value.apply(target, args);
                            // Methods that return `this` (the cores
                            // chain on it) hand back the wrapper, so
                            // pre-await chaining keeps one identity.
                            return result === target ? wrapper : result;
                        };
                    },
                })
            )
        );
    return wrapper;
}

/**
 * The no-callback form of {@link Database#prepare}: schedules the prepare
 * (and any bind) and returns the statement wrapped so awaiting it settles
 * only once that work has landed and the introspection metadata is
 * published.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @param {string} sql the SQL statement to prepare.
 * @param {unknown[]} bindArgs the bind parameters (no trailing callback).
 * @returns {import('./sqlite3-binding.js').Statement & Promise<import('./sqlite3-binding.js').Statement>} the statement, awaiting it gates on completion.
 * @private
 */
/**
 * The no-callback form of {@link Database#prepare}: schedules the prepare
 * (and any bind) and returns the statement wrapped so awaiting it settles
 * only once that work has landed and the introspection metadata is
 * published.
 *
 * Failure routing keeps both documented surfaces alive: a statement whose
 * `'error'` event has a listener hears the failure there (so callback-style
 * code holding the wrapper keeps working), an awaiter gets the rejection
 * alone, and code doing neither keeps the historical loudness — an
 * `'error'` event with no listener still throws.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @param {string} sql the SQL statement to prepare.
 * @param {unknown[]} bindArgs the bind parameters (no trailing callback).
 * @returns {import('./sqlite3-binding.js').Statement & Promise<import('./sqlite3-binding.js').Statement>} the statement, awaiting it gates on completion.
 * @private
 */
function prepareAsync(db, sql, bindArgs) {
    let settled = false;
    let awaiters = 0;
    /** @type {import('./sqlite3-binding.js').Statement | undefined} */
    let statement;
    /** @type {(value: import('./sqlite3-binding.js').Statement) => void} */
    let resolveReady;
    /** @type {(err: Error) => void} */
    let rejectReady;
    /** @type {Promise<import('./sqlite3-binding.js').Statement>} */
    const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // A rejection nobody awaits must not surface as an unhandled
    // rejection: the wrapper's `then` re-exposes it to actual awaiters,
    // and the statement's 'error' event stays the other surface.
    ready.catch(() => {
        // Deliberately empty; see above.
    });

    /**
     * @param {Error} err
     */
    const fail = (err) => {
        if (settled) return;
        settled = true;
        if (
            statement !== undefined &&
            (statement.listenerCount('error') > 0 || awaiters === 0)
        ) {
            statement.emit('error', err);
        }
        rejectReady(err);
    };
    const succeed = () => {
        if (settled) return;
        settled = true;
        resolveReady(
            /** @type {import('./sqlite3-binding.js').Statement} */ (statement),
        );
    };

    statement = associateStatement(
        db,
        new Statement(
            db,
            sql,
            /**
             * @param {import('./native.js').SqliteError | null} err
             */
            (err) => {
                if (err) fail(err);
                else if (bindArgs.length === 0) succeed();
            },
        ),
    );
    // A trailing { integerMode } bag is a prepare option, not a bind
    // argument; applied to the statement before any work is scheduled.
    applyPrepareOptions(statement, bindArgs);

    if (bindArgs.length > 0) {
        try {
            const bindVariadic =
                /** @type {(...args: unknown[]) => unknown} */ (
                    /** @type {unknown} */ (nativeStatementBind)
                );
            // The native bind runs behind the prepare (the statement
            // queues it), so its callback fires once both have completed.
            bindVariadic.call(
                statement,
                ...bindArgs,
                /**
                 * @param {import('./native.js').SqliteError | null} err
                 */
                (err) => {
                    if (err) fail(err);
                    else succeed();
                },
            );
        } catch (err) {
            // Strict binding throws synchronously (the historical
            // contract); the freshly prepared statement is orphaned, so
            // finalize it — close() could otherwise end up SQLITE_BUSY.
            nativeStatementFinalize.call(statement);
            throw err;
        }
    }

    return prepareThenableWrapper(statement, ready, () => {
        awaiters++;
    });
}

/**
 * Prepares a statement for the caller to own.
 *
 * The no-callback form returns the statement wrapped in a thenable:
 * `await db.prepare(sql)` (with or without bind parameters) resolves only
 * once the worker has completed the prepare and the introspection
 * accessors — `columns`, `parameterCount`, `parameterNames`, `readonly` —
 * are populated, and yields the statement itself. The wrapper still
 * forwards every statement member, so pre-await chaining
 * (`db.prepare(sql).run(...)`) keeps the synchronous surface. A prepare
 * failure rejects the await (and is reported on the statement's `'error'`
 * event when one is registered); a bind failure throws synchronously
 * after finalizing the orphan.
 *
 * The callback form is unchanged: it returns the statement synchronously
 * and the trailing callback is an error-only errback, so a prepare
 * failure surfaces there rather than as a rejection.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL statement to prepare.
 * @param {...unknown} args bind parameters, then optionally a callback.
 * @returns {any} the statement — wrapped in a completion gate in
 *   promise mode; the precise overload set lives in lib/augment.d.ts.
 */
Database.prototype.prepare = function (sql, ...args) {
    // No trailing function: promise mode. A function is never a legal bind
    // value, so the trailing-argument test is the same one the dual-mode
    // methods use to detect callback mode.
    if (args.length === 0 || typeof args[args.length - 1] !== 'function') {
        return prepareAsync(this, sql, args);
    }
    // The trailing callback sits in two native slots — the prepare
    // errback and the queued bind's completion — so a failed prepare
    // would otherwise reach it twice. The split guards that.
    const split = splitPrepareCallback(args);
    const statement = new Statement(
        this,
        sql,
        split === null ? undefined : split.errback,
    );
    associateStatement(this, statement);
    try {
        // A trailing { integerMode } bag is a prepare option, not a bind
        // argument.
        applyPrepareOptions(statement, args);
        const bindVariadic =
            /** @type {(...args: unknown[]) => import('./sqlite3-binding.js').Statement} */ (
                /** @type {unknown} */ (nativeStatementBind)
            );
        return bindVariadic.apply(statement, args);
    } catch (err) {
        // Bind TypeErrors leave the freshly prepared statement orphaned;
        // finalize it so close() cannot end up with SQLITE_BUSY.
        nativeStatementFinalize.call(statement);
        throw err;
    }
};

// run/get/all/each/map reuse prepared statements when the caller enabled
// the cache with cacheStatements(). Under serialize() the cached path is
// bypassed: statement operations do not pass through the database queue,
// so strict FIFO ordering would be lost.

/**
 * The inner body of a cached Database method: run the work against a
 * (possibly cached) statement and finalize it unless it stays cached.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {import('./sqlite3-binding.js').Statement} statement the statement to drive.
 * @param {unknown[]} params the caller's arguments after the SQL.
 * @param {boolean} cached whether the statement came from the cache.
 * @returns {unknown} whatever the method returns.
 * @private
 */
// Database#run(sql, [bind1, bind2, ...], [callback])
Database.prototype.run = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.run)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

// Database#get(sql, [bind1, bind2, ...], [callback])
Database.prototype.get = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        // A Database-level get is an independent call, not a cursor step
        // (that is stmt.fetch()'s job), so a cached statement re-run with
        // no bind parameters must start from its first row again. Left
        // alone it re-stepped the previous call's cursor: the second
        // db.get(sql) returned undefined, and the unreset statement held
        // the connection's WAL read snapshot open. An empty array marks
        // "bindings supplied" without binding anything, which forces the
        // reset — legal only when the statement takes no parameters
        // (parameterCount is undefined while the first prepare is still
        // in flight; that call needs no reset anyway).
        if (cached && params.length <= 1 && statement.parameterCount === 0) {
            /** @type {(...args: unknown[]) => unknown} */ (statement.get)(
                [],
                ...params,
            );
        } else {
            /** @type {(...args: unknown[]) => unknown} */ (statement.get)(
                ...params,
            );
        }
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

// Database#all(sql, [bind1, bind2, ...], [callback])
Database.prototype.all = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.all)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

// Database#each(sql, [bind1, bind2, ...], [callback], [complete])
Database.prototype.each = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.each)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

Database.prototype.map = cachedMethod(
    /**
     * @this {import('./sqlite3-binding.js').Database}
     * @param {import('./sqlite3-binding.js').Statement} statement
     * @param {unknown[]} params
     * @param {boolean} cached
     */
    function (statement, params, cached) {
        /** @type {(...args: unknown[]) => unknown} */ (statement.map)(
            ...params,
        );
        if (!cached) nativeStatementFinalize.call(statement);
        return this;
    },
);

/**
 * Builds a Database method around `fn` that resolves its SQL to a
 * statement — from the cache when one is enabled, otherwise a fresh
 * (and afterwards finalized) one.
 *
 * A cache hit skips the prepare, and statement operations never pass
 * through the database queue — so while an exclusive operation
 * (exec/close/wait/loadExtension) is running or waiting, the cached
 * path would overtake it and run concurrently with it. It falls back to
 * the uncached path there: its prepare goes through Database::Schedule
 * and lands in the queue behind that operation.
 *
 * @param {(statement: import('./sqlite3-binding.js').Statement, params: unknown[], cached: boolean) => unknown} fn the method body.
 * @returns {(this: import('./sqlite3-binding.js').Database, sql: string, ...args: any[]) => any} the assembled method.
 * @private
 */
function cachedMethod(fn) {
    return function (sql, ...args) {
        const errBack = extractErrBack(args);
        // In the two paths below a fresh statement is prepared, so the
        // trailing callback sits in two native slots (prepare errback and
        // the queued method's completion) and a failed prepare would
        // reach it twice. The hit path has no prepare and pays nothing.
        const split = splitPrepareCallback(args);
        const prepareErrback = split?.errback ?? errBack;

        const cache = this._stmtCache;
        // Native state, read per field: while serialized, closing, or with
        // anything queued/in flight on the database queue, the cached
        // path would overtake that work (statement operations bypass
        // Database::Schedule), so fall back to the uncached path whose
        // prepare lands in the queue behind it. db.state is the same
        // information as one frozen object, but constructing it per call
        // measured +46% on the sync hot path (bench, Deliverable 05).
        if (
            cache &&
            !this.serialized &&
            !this.closing &&
            this.queued === 0 &&
            !(this.locked && this.pending > 0)
        ) {
            let statement = cache.get(sql);
            if (statement !== undefined) {
                // Most recently used.
                cache.delete(sql);
                cache.set(sql, statement);
            } else {
                /**
                 * @param {import('./native.js').SqliteError | null} err
                 */
                const onPrepareError = function (err) {
                    if (!err) return;
                    // Failed to prepare: drop it so the next call retries.
                    cache.delete(sql);
                    if (split) split.errback.call(fresh, err);
                    else fresh.emit('error', err);
                };
                const fresh = new Statement(this, sql, onPrepareError);
                statement = fresh;
                associateStatement(this, fresh);
                cache.set(sql, fresh);
                if (cache.size > /** @type {number} */ (this._stmtCacheMax)) {
                    const oldestSql = /** @type {string} */ (
                        /** @type {unknown} */ (cache.keys().next().value)
                    );
                    const oldest =
                        /** @type {import('./sqlite3-binding.js').Statement} */ (
                            /** @type {unknown} */ (cache.get(oldestSql))
                        );
                    cache.delete(oldestSql);
                    nativeStatementFinalize.call(oldest);
                }
            }
            /** @type {import('./sqlite3-binding.js').Statement} */
            const ready =
                /** @type {import('./sqlite3-binding.js').Statement} */ (
                    /** @type {unknown} */ (statement)
                );
            try {
                return fn.call(this, ready, args, true);
            } catch (err) {
                // A synchronous bind TypeError: the statement is cached
                // but nothing will ever drive it, so drop it rather than
                // keeping a dead entry (and a pending prepare) around.
                cache.delete(sql);
                nativeStatementFinalize.call(ready);
                throw err;
            }
        }

        const statement = new Statement(this, sql, prepareErrback);
        associateStatement(this, statement);
        try {
            return fn.call(this, statement, args, false);
        } catch (err) {
            // Same as above, uncached shape: finalize the orphaned
            // statement so close() cannot end up with SQLITE_BUSY.
            nativeStatementFinalize.call(statement);
            throw err;
        }
    };
}

/**
 * Enables the opt-in LRU cache of prepared statements for
 * run/get/all/each/map, keyed on the SQL string.
 *
 * Defaults to 64 entries. Cached statements are finalized by close().
 * Under serialize() the cache is bypassed to preserve strict FIFO
 * ordering.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {number} [maxEntries] cache capacity; a positive integer.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 */
Database.prototype.cacheStatements = function (maxEntries) {
    if (!this._stmtCache) {
        this._stmtCache = new Map();
        this._stmtCacheMax = 64;
    }
    /** @type {Map<string, import('./sqlite3-binding.js').Statement>} */
    const cache = this._stmtCache;
    const max = Number.parseInt(
        /** @type {string} */ (/** @type {unknown} */ (maxEntries)),
        10,
    );
    if (max > 0) this._stmtCacheMax = max;
    while (cache.size > /** @type {number} */ (this._stmtCacheMax)) {
        const oldestSql = /** @type {string} */ (
            /** @type {unknown} */ (cache.keys().next().value)
        );
        const oldest = /** @type {import('./sqlite3-binding.js').Statement} */ (
            /** @type {unknown} */ (cache.get(oldestSql))
        );
        cache.delete(oldestSql);
        nativeStatementFinalize.call(oldest);
    }
    return this;
};

/**
 * True for a trailing `{ integerMode }` prepare-options bag. Like the
 * rowMode bag: named bind keys carry a sigil, so a plain object owning
 * only `integerMode` could never have been a legal bind argument.
 *
 * @param {unknown} value the candidate.
 * @returns {boolean} whether it is the options bag.
 * @private
 */
function isPrepareOptions(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => key === 'integerMode');
}

/**
 * Applies a prepare-options bag (if the last bind argument is one) to the
 * statement. Returns true when a bag was consumed.
 *
 * @param {import('./sqlite3-binding.js').Statement} statement the fresh statement.
 * @param {unknown[]} bindArgs the bind arguments; a bag is popped in place.
 * @returns {boolean} whether an options bag was applied.
 * @throws {TypeError} for a bad integerMode value (the native setter's).
 * @private
 */
function applyPrepareOptions(statement, bindArgs) {
    const last = bindArgs[bindArgs.length - 1];
    if (bindArgs.length === 0 || !isPrepareOptions(last)) return false;
    bindArgs.pop();
    const mode =
        /** @type {{ integerMode?: 'number' | 'bigint' | 'mixed' }} */ (last)
            .integerMode;
    if (mode !== undefined) {
        /** @type {(...args: unknown[]) => unknown} */ (
            /** @type {unknown} */ (statement._setIntegerMode)
        )(mode);
    }
    return true;
}

/**
 * Prepares a statement synchronously on the main thread.
 *
 * Throws when the database is not fully idle. The returned statement
 * also supports the getSync/runSync/allSync fast path.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL statement to prepare.
 * @param {{ integerMode?: 'number' | 'bigint' | 'mixed' }} [options] a
 *   per-statement integer-mode override (node:sqlite's `readBigInts`,
 *   better-sqlite3's `safeIntegers`, as a one-shot option).
 * @returns {import('./sqlite3-binding.js').Statement} the prepared statement.
 * @throws {Error} When the database is not fully idle.
 */
Database.prototype.prepareSync = function (sql, options) {
    const statement = new Statement(this, sql, undefined, true);
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('prepareSync() options must be an object');
        }
        for (const key of Object.keys(options)) {
            if (key !== 'integerMode') {
                throw new TypeError(
                    `prepareSync() received unknown option '${key}'`,
                );
            }
        }
        if (options.integerMode !== undefined) {
            applyPrepareOptions(statement, [options]);
        }
    }
    return statement;
};

/**
 * True for the trailing `{ rowMode: ... }` options bag the sync read
 * paths accept. The native side re-validates; this only has to be a
 * cheap discriminator so the zero-parameter reset below still applies
 * when an options bag is the only other argument.
 *
 * @param {unknown} value the candidate last argument.
 * @returns {boolean} whether it is a rowMode options bag.
 * @private
 */
function isSyncReadOptions(value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        /** @type {Record<string, unknown>} */ (value).rowMode !== undefined
    );
}

/**
 * Executes `SELECT ... ` synchronously, consulting (and filling) the
 * statement cache when enabled.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @template T
 * @param {string} sql the query.
 * @param {...unknown} params bind parameters, optionally followed by a
 *   `{ rowMode: 'object' | 'array' }` options bag.
 * @returns {T | undefined} the first row, or undefined.
 * @throws {Error} When the database is not fully idle or binding fails.
 */
Database.prototype.getSync = function (sql, ...params) {
    const statement = this._statementForSync(sql);
    // A trailing options bag is not a bind parameter: pull it out so the
    // zero-parameter reset below still sees the true parameter count.
    let options;
    if (params.length > 0 && isSyncReadOptions(params[params.length - 1])) {
        options = params.pop();
    }
    // Same rule as the cached async get(): a Database-level get is an
    // independent first-row query, not a cursor step, so a cached
    // statement re-run without bind parameters starts from its first row
    // again (the sync statement's re-stepping otherwise returns undefined
    // from the second call on).
    if (params.length === 0 && statement.parameterCount === 0) {
        params = [[]];
    }
    return /** @type {T | undefined} */ (
        /** @type {(...args: unknown[]) => unknown} */ (statement.getSync)(
            ...params,
            ...(options ? [options] : []),
        )
    );
};

/**
 * Executes a statement synchronously; returns `{ lastID, changes }`.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the statement.
 * @param {...unknown} params bind parameters.
 * @returns {{ lastID: number, changes: number }} the run result.
 * @throws {Error} When the database is not fully idle or binding fails.
 */
Database.prototype.runSync = function (sql, ...params) {
    const statement = this._statementForSync(sql);
    /** @type {(...args: unknown[]) => unknown} */ (statement.runSync)(
        ...params,
    );
    return {
        lastID: /** @type {number} */ (statement.lastID),
        changes: /** @type {number} */ (statement.changes),
    };
};

/**
 * Executes a query synchronously, returning every row.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the query.
 * @param {...unknown} params bind parameters, optionally followed by a
 *   `{ rowMode: 'object' | 'array' }` options bag.
 * @template T
 * @returns {T[]} every result row.
 * @throws {Error} When the database is not fully idle or binding fails.
 */
Database.prototype.allSync = function (sql, ...params) {
    const statement = this._statementForSync(sql);
    return /** @type {T[]} */ (
        /** @type {(...args: unknown[]) => unknown} */ (statement.allSync)(
            ...params,
        )
    );
};

/**
 * Resolves `sql` to a statement for the sync methods.
 *
 * Always cached, so the statement outlives the call and the caller never
 * finalizes it; both caches are emptied by close() and by every
 * user-function registration.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL to prepare or reuse.
 * @returns {import('./sqlite3-binding.js').Statement} the prepared statement.
 * @private
 */
Database.prototype._statementForSync = function (sql) {
    const cache = this._stmtCache;
    // No closing check is needed here: a close in flight means either the
    // sync prepare throws (its gate requires a fully idle connection) or,
    // on a cache hit, the sync call itself does — and close() drains the
    // cache, so a post-close hit is impossible.
    if (cache) {
        const statement = cache.get(sql);
        if (statement !== undefined) {
            cache.delete(sql);
            cache.set(sql, statement);
            return statement;
        }
        const fresh = new Statement(this, sql, undefined, true);
        associateStatement(this, fresh);
        cache.set(sql, fresh);
        if (cache.size > /** @type {number} */ (this._stmtCacheMax)) {
            const oldestSql = /** @type {string} */ (
                /** @type {unknown} */ (cache.keys().next().value)
            );
            const oldest =
                /** @type {import('./sqlite3-binding.js').Statement} */ (
                    /** @type {unknown} */ (cache.get(oldestSql))
                );
            cache.delete(oldestSql);
            nativeStatementFinalize.call(oldest);
        }
        return fresh;
    }
    // No user-enabled cache: the sync paths still keep one of their own.
    //
    // Preparing and finalizing a statement per call costs far more than the
    // query it wraps — measured at ~5.6us against ~0.75us for the same
    // getSync against a cached statement, so the convenience form was ~7x
    // slower than the identical work through Database#prepare. That is the
    // opposite of what a call named getSync should do.
    //
    // This cache is deliberately separate from `_stmtCache`: enabling that
    // one would also change how the *asynchronous* calls behave on the same
    // connection, which is the user's choice to make via cacheStatements().
    // Both are emptied by _drainStatementCache, so close() and every
    // user-function registration invalidate them together.
    let syncCache = this._syncStmtCache;
    if (!syncCache) {
        syncCache = new Map();
        this._syncStmtCache = syncCache;
    }
    const cached = syncCache.get(sql);
    if (cached !== undefined) {
        // Refresh recency: Map preserves insertion order, so delete+set
        // moves the entry to the end and keys().next() stays the oldest.
        syncCache.delete(sql);
        syncCache.set(sql, cached);
        return cached;
    }
    const prepared = associateStatement(
        this,
        new Statement(this, sql, undefined, true),
    );
    syncCache.set(sql, prepared);
    if (syncCache.size > SYNC_STMT_CACHE_MAX) {
        const oldestSql = /** @type {string} */ (
            /** @type {unknown} */ (syncCache.keys().next().value)
        );
        const oldest = /** @type {import('./sqlite3-binding.js').Statement} */ (
            /** @type {unknown} */ (syncCache.get(oldestSql))
        );
        syncCache.delete(oldestSql);
        nativeStatementFinalize.call(oldest);
    }
    return prepared;
};

// Database#close flushes the statement cache first: sqlite3_close fails
// with SQLITE_BUSY while prepared statements are outstanding.
/** @type {(...args: unknown[]) => unknown} */
const nativeClose = Database.prototype.close;

/**
 * Refuses an operation that would disturb the statement SQLite is
 * stepping. `db._inSyncCall` is true exactly while a JavaScript callback
 * invoked re-entrantly by a synchronous method (`getSync`/`runSync`/
 * `allSync`, a virtual table's generator, a user function or aggregate)
 * is on the stack — the JS thread is inside `sqlite3_step`. Registrations
 * flush the statement cache, which finalizes that very statement, so they
 * must be refused *before* touching anything: the native entry points
 * refuse too, but by then the flush has already freed the live VM.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @param {string} what the refused operation, as a sentence opener.
 * @returns {void}
 * @throws {Error} when a synchronous method's callback is on the stack.
 * @private
 */
function assertNotInSyncCallback(db, what) {
    if (
        !(
            /** @type {{ _inSyncCall?: boolean }} */ (
                /** @type {unknown} */ (db)
            )._inSyncCall
        )
    ) {
        return;
    }
    throw new Error(
        `${what} from inside a JavaScript callback invoked by a ` +
            'synchronous method on this connection: SQLite is mid-step on ' +
            'this connection and the statement cache holds the executing ' +
            'statement. Do it before or after the query',
    );
}

/**
 * Finalizes every statement in the statement cache, emptying it.
 *
 * Used by close() (sqlite3_close fails with SQLITE_BUSY while prepared
 * statements are outstanding) and by every user-function registration or
 * removal: an existing prepared statement keeps invoking the function
 * implementation it was compiled against, so the cache must not hand one
 * back after the registration changed.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @returns {void}
 * @private
 */
Database.prototype._drainStatementCache = function () {
    // Never from inside a callback a synchronous method invoked: the
    // stepping statement is in the sync cache, and finalizing it would
    // free the VM sqlite is executing. Every caller checks first (see
    // assertNotInSyncCallback); this is the backstop.
    assertNotInSyncCallback(this, 'the statement cache cannot be flushed');
    // The implicit sync cache is drained on exactly the same events as the
    // opt-in one: close(), and every user-function registration or removal
    // (a prepared statement keeps invoking the implementation it was
    // compiled against).
    const syncCache = this._syncStmtCache;
    if (syncCache && syncCache.size > 0) {
        for (const [sql, statement] of syncCache) {
            syncCache.delete(sql);
            nativeStatementFinalize.call(statement);
        }
    }
    const cache = this._stmtCache;
    if (cache && cache.size > 0) {
        // The drain is synchronous and the internal finalize carries no
        // user callback, so no JS can run inside it and repopulate the
        // cache behind our backs. If a cached statement is busy, its
        // finalize queues behind that work; an exclusive native call
        // (close, registration) therefore lands after it either way.
        for (const [sql, statement] of cache) {
            cache.delete(sql);
            nativeStatementFinalize.call(statement);
        }
    }
};

/**
 * Closes the connection. In callback mode (a trailing function) returns
 * this database; otherwise returns a promise resolving once closed.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {...any} args optionally a callback.
 * @returns {any}
 */
Database.prototype.close = function (...args) {
    assertNotInSyncCallback(this, 'the connection cannot be closed');
    this._drainStatementCache();
    // See liveConnections (diagnostics_channel).
    untrackConnection(this);
    // Deliberately not deferred. close() is scheduled exclusively and
    // Work_BeginClose requires pending == 0, so the native queue already
    // makes it wait for the finalizes above (each either completes inline
    // when its statement is idle, or queues behind that statement's
    // in-flight work). Deferring the native call to a promise instead would
    // let operations issued after close() run before the close is even
    // requested.
    return nativeClose.apply(this, args);
};

// --- User-defined functions, aggregates, window functions, collations ----
//
// The native halves (_registerFunction & co.) run through the exclusive
// queue: they touch the connection under the same mutex a worker blocked
// in a JS round trip holds, so they must wait until nothing is in flight.
// The wrappers add option validation, arity computation and the statement
// cache flush (a cached statement keeps the implementation it was compiled
// against until re-prepared).

// sqlite3_create_function_v2 text-encoding OR-flags; not exported by the
// native binding because they are only meaningful at registration.
const SQLITE_DETERMINISTIC = 0x000000800;
const SQLITE_DIRECTONLY = 0x0000080000;
const SQLITE_INNOCUOUS = 0x000200000;

// sqlite3_limit(SQLITE_LIMIT_FUNCTION_ARG) default; names over 255 bytes
// are likewise rejected by sqlite3CreateFunc.
const MAX_FUNCTION_ARG = 127;
const MAX_FUNCTION_NAME = 255;

/**
 * Registers a scalar SQL function backed by a JavaScript callback.
 *
 * The callback runs on the JS thread while the worker thread that is
 * stepping the statement blocks, at a measured cost of a few microseconds
 * per call — see the README's "JavaScript functions and performance"
 * section before filtering large tables with one.
 *
 * A registered function cannot be invoked from the synchronous methods
 * (`getSync`/`runSync`/`allSync`): the JS thread is the one blocked inside
 * SQLite there, so the call fails with an explicit error instead of
 * deadlocking. Redefining an existing name replaces it (in-flight work
 * completes on the old implementation first; the statement cache is
 * flushed). Registration and removal are refused by SQLite with
 * `SQLITE_BUSY`, reported on the connection's `'error'` event, while a
 * cursor is suspended mid-query.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the SQL name (1..255 bytes).
 * @param {import('./native.js').FunctionOptions | ((...args: unknown[]) => unknown)} [options]
 *   the options object, or the implementation directly.
 * @param {(this: undefined, ...args: unknown[]) => unknown} [fn] the
 *   implementation; bind values and return values use exactly the bind
 *   marshalling rules (BigInt for large integers, Buffer for blobs; an
 *   unsupported return type is an error, never a coerced string).
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the name or implementation is missing or an
 *   option key is unknown.
 * @since 9.0.0
 * @example
 * db.function('regexp', { deterministic: true },
 *     (pattern, value) => (new RegExp(pattern).test(value) ? 1 : 0));
 * db.all("SELECT name FROM t WHERE name REGEXP '^a'");
 */
Database.prototype.function = function (name, options, fn) {
    assertNotInSyncCallback(this, 'a user function cannot be registered');
    if (typeof options === 'function') {
        fn = options;
        options = undefined;
    }
    const { nArg, flags } = parseFunctionOptions(
        name,
        options,
        typeof fn === 'function' ? fn.length : -1,
        'function()',
    );
    if (typeof fn !== 'function') {
        throw new TypeError('function() requires an implementation function');
    }
    // Flush the cache BEFORE registering: a cached statement suspended
    // mid-cursor counts as an active VM, and sqlite refuses to replace a
    // registration (SQLITE_BUSY) until every VM has halted. Finalizing
    // the cache first is what makes redefinition work in the common case.
    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (this._registerFunction)(
        name,
        nArg,
        flags,
        fn,
    );
    return this;
};

/**
 * Registers an aggregate SQL function backed by JavaScript: `start()`
 * creates an accumulator, `step(acc, ...args)` folds one row into it and
 * `result(acc)` produces the final value. Providing `inverse` registers a
 * window function instead (`OVER (...)` windows), where `inverse` removes
 * a row that left the frame.
 *
 * Every step is one JS round trip, so an aggregate over N rows costs N
 * calls; an empty group evaluates `start()` then `result()` with no step.
 *
 * Note: window functions (aggregates with `inverse`) are registered
 * through `sqlite3_create_window_function`, which has no flag slot —
 * `deterministic`/`directOnly`/`innocuous` cannot be applied to them and
 * are ignored.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the SQL name (1..255 bytes).
 * @param {import('./native.js').AggregateDefinition} spec the
 *   implementation.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when `start`, `step` or `result` is missing or not a
 *   function.
 * @since 9.0.0
 * @example
 * db.aggregate('median', {
 *     start: () => [],
 *     step: (acc, v) => { acc.push(v); return acc; },
 *     result: (acc) => {
 *         acc.sort((a, b) => a - b);
 *         return acc.length ? acc[acc.length >> 1] : null;
 *     },
 * });
 * db.get('SELECT median(salary) FROM employees');
 */
Database.prototype.aggregate = function (name, spec) {
    assertNotInSyncCallback(this, 'an aggregate cannot be registered');
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new TypeError(
            'aggregate() requires an implementation object with start, step and result functions',
        );
    }
    const { start, step, result } = spec;
    if (typeof start !== 'function') {
        throw new TypeError("aggregate() requires a 'start' function");
    }
    if (typeof step !== 'function') {
        throw new TypeError("aggregate() requires a 'step' function");
    }
    if (typeof result !== 'function') {
        throw new TypeError("aggregate() requires a 'result' function");
    }
    const inverse = spec.inverse;
    if (inverse !== undefined && typeof inverse !== 'function') {
        throw new TypeError(
            "aggregate() 'inverse', when given, must be a function",
        );
    }
    const { nArg, flags } = parseFunctionOptions(
        name,
        spec,
        Math.max(step.length - 1, 0),
        'aggregate()',
        ['start', 'step', 'result', 'inverse'],
    );
    // See function() for why the cache is flushed before registering.
    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._registerAggregate)
    )(name, nArg, flags, start, step, result, inverse);
    return this;
};

/**
 * Registers a collation under the given name, usable in `ORDER BY`,
 * `CREATE INDEX` and `COLLATE`: `ORDER BY name COLLATE mycoll`.
 *
 * The comparator receives two strings and returns a number with the
 * `Array#sort`/`localeCompare` sign convention. Each comparison is a JS
 * round trip on the JS thread — sorting N rows costs O(N log N) calls, so
 * for anything but small or one-off sorts, sorting in JS after `all()` is
 * faster.
 *
 * While a JavaScript collation is registered, the synchronous methods
 * (`getSync`/`runSync`/`allSync`) refuse to run: a comparison would need
 * the JS thread that is blocked inside SQLite, and unlike functions a
 * collation cannot report an error mid-comparison. {@link Database#withCollation}
 * scopes a registration to an awaited block, removing it again afterwards.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the collation name (1..255 bytes).
 * @param {(a: string, b: string) => number} fn the comparator.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the name or comparator is missing.
 * @since 9.0.0
 * @example
 * db.collation('locale', (a, b) => a.localeCompare(b, 'de'));
 * db.all('SELECT name FROM t ORDER BY name COLLATE locale');
 */
Database.prototype.collation = function (name, fn) {
    assertNotInSyncCallback(this, 'a collation cannot be registered');
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('collation() requires a non-empty name string');
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_FUNCTION_NAME) {
        throw new TypeError(
            `collation() name exceeds SQLite's ${MAX_FUNCTION_NAME}-byte limit`,
        );
    }
    if (typeof fn !== 'function') {
        throw new TypeError('collation() requires a comparator function');
    }
    // See function() for why the cache is flushed before registering.
    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (this._registerCollation)(
        name,
        fn,
    );
    return this;
};

/**
 * Removes every function and aggregate registered under `name`. In-flight
 * queries complete on the old implementation; the statement cache is
 * flushed so nothing re-uses a statement compiled against it. Removing an
 * unknown name is a no-op.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the function name to remove.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the name is not a non-empty string.
 * @since 9.0.0
 */
Database.prototype.removeFunction = function (name) {
    assertNotInSyncCallback(this, 'a user function cannot be removed');
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(
            'removeFunction() requires a non-empty name string',
        );
    }
    // Flush the cache before removing: see function() — a suspended
    // cached statement keeps sqlite refusing the change with SQLITE_BUSY.
    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (this._removeFunction)(name);
    return this;
};

/**
 * Removes the collation registered under `name`. Removing an unknown name
 * is a no-op; afterwards the synchronous methods work again.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the collation name to remove.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the name is not a non-empty string.
 * @since 9.0.0
 */
Database.prototype.removeCollation = function (name) {
    assertNotInSyncCallback(this, 'a collation cannot be removed');
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(
            'removeCollation() requires a non-empty name string',
        );
    }
    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (this._removeCollation)(
        name,
    );
    return this;
};

/**
 * Runs `fn` with a JavaScript collation registered, removing it again
 * afterwards — the blast radius of the registration is the awaited block,
 * not the connection's lifetime. Equivalent to
 * `db.collation(name, cmp)` / `try { ... } finally { db.removeCollation(name) }`.
 *
 * While the collation is registered the synchronous methods refuse to run
 * (see {@link Database#collation}); inside the block use the asynchronous
 * API. An error thrown by `fn` still removes the collation before the
 * rejection propagates. Interleaved or nested `withCollation` calls for
 * the *same* name are last-wins — use distinct names for concurrent scopes.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the collation name (1..255 bytes).
 * @param {(a: string, b: string) => number} cmp the comparator.
 * @param {(db: import('./sqlite3-binding.js').Database) => unknown} fn the
 *   body to run with the collation registered; awaited before removal.
 * @returns {Promise<unknown>} whatever `fn` resolves to.
 * @throws {TypeError} when the name, comparator or body is missing.
 * @since 9.0.2
 * @example
 * const rows = await db.withCollation('locale', (a, b) => a.localeCompare(b, 'de'),
 *     () => db.all('SELECT name FROM t ORDER BY name COLLATE locale'));
 * // here the collation is removed and the sync methods work again
 */
Database.prototype.withCollation = function (name, cmp, fn) {
    if (typeof fn !== 'function') {
        throw new TypeError('withCollation() requires a body function');
    }
    // collation() validates the name and comparator synchronously.
    this.collation(name, cmp);
    return (async () => {
        try {
            return await fn(this);
        } finally {
            this.removeCollation(name);
        }
    })();
};

// --- Ergonomics parity (Phase 1) and virtual tables (Phase 4) ---------------
//
// pragma()/explain()/batch()/dump() are thin, promise-native wrappers over
// the async paths; table()/values() wrap the native vtab registration with
// definition validation. The introspection helpers (status/limits/location)
// map friendly names onto the native entry points.

// Leading whitespace and SQL comments (line and block), so the keyword
// test below sees the statement's first real token.
const SQL_LEADING_NOISE_RE =
    /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))+/;
// Statements whose result is rows rather than a change count.
const BATCH_READ_RE = /^(select|pragma|explain|with|values)\b/i;
// ... and the modifying statements that also return rows: RETURNING makes
// an INSERT/UPDATE/DELETE a read as far as the caller is concerned, and
// running it through run() would throw the rows away.
const BATCH_RETURNING_RE = /\bRETURNING\b/i;

/**
 * Whether a batch entry's rows must be collected rather than its change
 * count.
 *
 * @param {string} sql one statement.
 * @returns {boolean} true when the statement yields rows.
 * @private
 */
function batchStatementReadsRows(sql) {
    const bare = sql.replace(SQL_LEADING_NOISE_RE, '');
    return BATCH_READ_RE.test(bare) || BATCH_RETURNING_RE.test(bare);
}

/**
 * @typedef {object} PragmaOptions
 * @property {boolean} [simple] return only the first column of the first
 *   row (the scalar form better-sqlite3 popularised).
 * @since 9.1.0
 */

/**
 * Runs a `PRAGMA` and resolves its parsed result rows — the recommended
 * way to run pragmas (they are statements, and this keeps them on the
 * async queue like every other statement). `PRAGMA ${source}` is
 * prepared as-is, so argument forms work too: `db.pragma('table_info(t)')`.
 *
 * With `{ simple: true }` resolves the first column of the first row
 * (`db.pragma('user_version', { simple: true })` → the number), or
 * undefined when the pragma returned no rows.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} source the pragma source (without the `PRAGMA` keyword).
 * @param {PragmaOptions} [options]
 * @returns {Promise<Record<string, unknown>[] | unknown>} the rows, or the
 *   scalar with `{ simple: true }`.
 * @throws {TypeError} when the source or options are malformed.
 * @since 9.1.0
 * @example
 * await db.pragma('journal_mode = WAL');
 * const version = await db.pragma('user_version', { simple: true });
 */
Database.prototype.pragma = async function pragma(source, options) {
    if (typeof source !== 'string' || source.length === 0) {
        throw new TypeError('pragma() requires a non-empty source string');
    }
    let simple = false;
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('pragma() options must be an object');
        }
        for (const key of Object.keys(options)) {
            if (key !== 'simple') {
                throw new TypeError(
                    `pragma() received unknown option '${key}'`,
                );
            }
        }
        if (
            options.simple !== undefined &&
            typeof options.simple !== 'boolean'
        ) {
            throw new TypeError("pragma() option 'simple' must be a boolean");
        }
        simple = options.simple === true;
    }
    const rows = /** @type {Record<string, unknown>[]} */ (
        await this.all(`PRAGMA ${source}`)
    );
    if (!simple) return rows;
    if (rows.length === 0) return undefined;
    const first = rows[0];
    const key = Object.keys(first)[0];
    return key === undefined ? undefined : first[key];
};

/**
 * Resolves the `EXPLAIN QUERY PLAN` rows for a statement — the query
 * planner's own account of what it will do (index choices, scan order),
 * without executing it. Parameters may be left unbound: a plan does not
 * run the statement. Pass `{ full: true }` for the raw VDBE program
 * (`EXPLAIN`), the low-level opcode listing.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the statement to explain.
 * @param {{ full?: boolean }} [options]
 * @returns {Promise<Record<string, unknown>[]>} the plan rows.
 * @throws {TypeError} when the sql or options are malformed.
 * @since 9.1.0
 * @example
 * const plan = await db.explain('SELECT * FROM t WHERE id = ?');
 */
Database.prototype.explain = async function explain(sql, options) {
    if (typeof sql !== 'string' || sql.length === 0) {
        throw new TypeError('explain() requires a non-empty SQL string');
    }
    let full = false;
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('explain() options must be an object');
        }
        for (const key of Object.keys(options)) {
            if (key !== 'full') {
                throw new TypeError(
                    `explain() received unknown option '${key}'`,
                );
            }
        }
        if (options.full !== undefined && typeof options.full !== 'boolean') {
            throw new TypeError("explain() option 'full' must be a boolean");
        }
        full = options.full === true;
    }
    return /** @type {Promise<Record<string, unknown>[]>} */ (
        this.all(`${full ? 'EXPLAIN' : 'EXPLAIN QUERY PLAN'} ${sql}`)
    );
};

/**
 * @typedef {object} BatchStatement
 * @property {string} sql one statement.
 * @property {unknown} [args] bind parameters: an array of positional
 *   values, an object of named parameters, or a single positional value.
 *   The parameters may also follow the SQL in an array entry
 *   (`[sql, ...params]`).
 * @since 9.1.0
 */

/**
 * Runs an array of statements atomically, inside one transaction: either
 * every statement lands or the whole batch rolls back. Entries are SQL
 * strings, `[sql, ...params]` arrays or `{ sql, args }` objects;
 * row-returning statements (`SELECT`/`PRAGMA`/`WITH`/`VALUES`/`EXPLAIN`,
 * and anything carrying a `RETURNING` clause) resolve their rows into the
 * results array, everything else resolves its `{ lastID, changes }`.
 *
 * `options.mode` maps the libsql batch modes onto BEGIN forms:
 * `'write'` (the default) → `BEGIN IMMEDIATE`, `'read'`/`'deferred'` →
 * `BEGIN DEFERRED`, `'exclusive'` → `BEGIN EXCLUSIVE`.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {(string | BatchStatement | [string, ...unknown[]])[]} statements
 * @param {{ mode?: 'write' | 'read' | 'deferred' | 'exclusive' }} [options]
 * @returns {Promise<unknown[]>} one result per statement.
 * @throws {TypeError} when the statements or mode are malformed.
 * @since 9.1.0
 * @example
 * await db.batch([
 *     'CREATE TABLE t (a)',
 *     { sql: 'INSERT INTO t VALUES (?)', args: 1 },
 * ]);
 */
Database.prototype.batch = async function batch(statements, options) {
    if (!Array.isArray(statements)) {
        throw new TypeError('batch() requires an array of statements');
    }
    const mode = options?.mode ?? 'write';
    const begin =
        mode === 'write'
            ? 'immediate'
            : mode === 'read' || mode === 'deferred'
              ? 'deferred'
              : mode === 'exclusive'
                ? 'exclusive'
                : null;
    if (begin === null) {
        throw new TypeError(
            "batch() mode must be 'write', 'read', 'deferred' or 'exclusive'",
        );
    }
    /** @type {{ sql: string, args?: unknown }[]} */
    const entries = statements.map((entry, i) => {
        if (typeof entry === 'string') return { sql: entry };
        if (Array.isArray(entry)) {
            if (entry.length === 0 || typeof entry[0] !== 'string') {
                throw new TypeError(
                    `batch()[${i}] must be a SQL string or [sql, ...params]`,
                );
            }
            return { sql: entry[0], args: entry.slice(1) };
        }
        if (
            entry === null ||
            typeof entry !== 'object' ||
            typeof entry.sql !== 'string'
        ) {
            throw new TypeError(
                `batch()[${i}] must be a SQL string, [sql, ...params] or { sql, args }`,
            );
        }
        return { sql: entry.sql, args: entry.args };
    });
    return this.transaction(
        async (tx) => {
            /** @type {unknown[]} */
            const results = [];
            for (const {
                sql,
                args,
            } of /** @type {{ sql: string, args?: unknown }[]} */ (entries)) {
                // args is a positional array, a named-parameter object
                // or a single positional value; all three are documented,
                // and spreading the last two used to throw "Spread
                // syntax requires ...iterable".
                const bindArgs =
                    args === undefined || args === null
                        ? []
                        : Array.isArray(args)
                          ? /** @type {any[]} */ (args)
                          : [args];
                if (batchStatementReadsRows(sql)) {
                    results.push(await tx.all(sql, ...bindArgs));
                } else {
                    results.push(await tx.run(sql, ...bindArgs));
                }
            }
            return results;
        },
        { mode: begin },
    );
};

/**
 * Serializes one SQL literal for {@link sqlite3.iterdump}: the inverse of
 * the bind marshalling (strings quoted, blobs as X'…' hex, BigInt exact).
 *
 * @param {unknown} value the value to serialize.
 * @returns {string} the SQL literal.
 * @private
 */
function dumpLiteral(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
        // `Infinity`/`NaN` are JavaScript spellings, not SQL: restoring
        // them fails with "no such column: Infinity". SQLite's own shell
        // writes the overflowing literal, which reloads as ±inf; NaN
        // cannot be stored by SQLite at all (it becomes NULL), so this
        // arm only matters for the value a REAL column can hold.
        if (Number.isNaN(value)) return 'NULL';
        if (value === Number.POSITIVE_INFINITY) return '9.0e+999';
        if (value === Number.NEGATIVE_INFINITY) return '-9.0e+999';
        return String(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'string') {
        return `'${value.replaceAll("'", "''")}'`;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `X'${Buffer.from(
            value.buffer,
            value.byteOffset,
            value.byteLength,
        ).toString('hex')}'`;
    }
    throw new TypeError(
        `iterdump cannot serialize a ${typeof value} column value`,
    );
}

/**
 * Quotes one identifier (schema, table or column name) for dump SQL.
 *
 * @param {string} name the identifier.
 * @returns {string} the quoted identifier.
 * @private
 */
function dumpIdent(name) {
    return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The columns of one table that a restore can INSERT into: everything
 * except generated columns (`PRAGMA table_xinfo` reports those as hidden
 * 2/3), which SQLite computes and refuses as INSERT targets.
 *
 * @param {import('./native.js').Database} db the connection.
 * @param {string} table the table name.
 * @returns {Promise<string[]>} the insertable column names, in order.
 * @private
 */
async function dumpInsertableColumns(db, table) {
    const info = /** @type {{ name: string, hidden: number }[]} */ (
        await db.all(`PRAGMA table_xinfo(${dumpIdent(table)})`)
    );
    return info
        .filter((column) => Number(column.hidden) === 0)
        .map((column) => column.name);
}

/**
 * Streams the database as `.dump`-style SQL: the schema (tables first,
 * then their rows, then indexes/views/triggers), the AUTOINCREMENT
 * counters and `user_version`, framed by the `BEGIN`/`COMMIT` a restore
 * needs. Python `sqlite3`'s `iterdump()` equivalent; nothing else in Node
 * has it.
 *
 * Rows are streamed (`iterate`), so dumping a table larger than memory is
 * fine, and the reads run inside a deferred transaction — unless the
 * caller already has one open — so the dump is a point-in-time snapshot.
 * Abandoning the iterator early rolls that transaction back.
 *
 * Virtual tables keep their content: the `CREATE VIRTUAL TABLE` statement
 * is emitted (which recreates the empty shadow tables), and each shadow
 * table's rows follow as `DELETE` + `INSERT` against a
 * `CREATE TABLE IF NOT EXISTS`, so an FTS index is restored exactly as it
 * was instead of being silently dropped. No `writable_schema` games, so
 * the output restores into a defensive-mode connection too.
 *
 * @param {import('./native.js').Database} db the connection.
 * @returns {AsyncGenerator<string, void, void>} the SQL statements.
 * @since 9.1.0
 * @example
 * for await (const statement of sqlite3.iterdump(db)) fs.write(statement);
 */
async function* iterdump(db) {
    // A snapshot needs one read transaction for the whole walk. When the
    // caller already has a transaction open, theirs is the snapshot.
    const ownTransaction = !db.inTransaction;
    if (ownTransaction) await db.exec('BEGIN DEFERRED');
    let committed = false;
    try {
        yield 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n';
        // sqlite_schema's rowid order is creation order — tables before
        // the indexes/triggers created for them, which is the restore-safe
        // order.
        const schema =
            /** @type {{ name: string, type: string, sql: string }[]} */ (
                await db.all(
                    'SELECT name, type, sql FROM sqlite_schema ' +
                        "WHERE sql NOT NULL AND name NOT LIKE 'sqlite_%' " +
                        'ORDER BY rowid',
                )
            );
        // Virtual tables keep their content, which lives in the shadow
        // tables CREATE VIRTUAL TABLE itself creates. Those are dumped
        // with IF NOT EXISTS + DELETE before their rows, so the restore
        // works whether the DDL made them or not — which also makes a
        // misidentified `<vtab>_*` user table harmless.
        const virtualTables = [
            ...new Set(
                schema
                    .filter(
                        (row) =>
                            row.type === 'table' &&
                            /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql),
                    )
                    .map((row) => row.name),
            ),
        ];
        /** @param {string} name @returns {boolean} */
        const isShadowTable = (name) =>
            virtualTables.some((vtab) => name.startsWith(`${vtab}_`));

        /** @type {{ name: string, sql: string }[]} */
        const deferred = [];
        for (const row of schema) {
            if (row.type !== 'table') {
                deferred.push(row);
                continue;
            }
            const shadow = isShadowTable(row.name);
            const target = dumpIdent(row.name);
            if (shadow && !/\bIF\s+NOT\s+EXISTS\b/i.test(row.sql)) {
                yield `${row.sql.replace(
                    /^\s*CREATE\s+TABLE\s+/i,
                    'CREATE TABLE IF NOT EXISTS ',
                )};\n`;
            } else {
                yield `${row.sql};\n`;
            }
            if (virtualTables.includes(row.name)) continue;
            if (shadow) yield `DELETE FROM ${target};\n`;
            const names = await dumpInsertableColumns(db, row.name);
            if (names.length === 0) continue;
            const columns = names.map(dumpIdent).join(',');
            for await (const data of db.iterate(
                `SELECT ${columns} FROM ${target}`,
            )) {
                const values = names
                    .map((name) =>
                        dumpLiteral(
                            /** @type {Record<string, unknown>} */ (data)[name],
                        ),
                    )
                    .join(',');
                yield `INSERT INTO ${target}(${columns}) VALUES(${values});\n`;
            }
        }
        // AUTOINCREMENT high-water marks: without these a restored
        // database reuses rowids the original had already handed out.
        const sequences = /** @type {{ name: string, seq: unknown }[]} */ (
            await db
                .all(
                    'SELECT name, seq FROM sqlite_schema JOIN sqlite_sequence USING (name) ' +
                        "WHERE sqlite_schema.type = 'table' ORDER BY name",
                )
                .catch(() => [])
        );
        if (sequences.length > 0) {
            yield 'DELETE FROM sqlite_sequence;\n';
            for (const row of sequences) {
                yield 'INSERT INTO sqlite_sequence(name,seq) VALUES' +
                    `(${dumpLiteral(row.name)},${dumpLiteral(row.seq)});\n`;
            }
        }
        for (const row of deferred) {
            yield `${row.sql};\n`;
        }
        // user_version carries the schema position sqlite3.migrate() and
        // most migration tools key on; a dump that dropped it would rewind
        // the restored database's migration state.
        const userVersion = Number(
            await db.pragma('user_version', { simple: true }),
        );
        if (Number.isInteger(userVersion) && userVersion !== 0) {
            yield `PRAGMA user_version = ${userVersion};\n`;
        }
        yield 'COMMIT;\n';
        if (ownTransaction) {
            await db.exec('COMMIT');
            committed = true;
        }
    } finally {
        // Abandoned early (break/throw): the read transaction must not
        // stay open on the connection.
        if (ownTransaction && !committed) {
            try {
                await db.exec('ROLLBACK');
            } catch {
                // Already resolved by an outer failure; nothing to undo.
            }
        }
    }
}

/**
 * Serializes the whole database to `.dump`-style SQL text (see
 * {@link sqlite3.iterdump} for the streaming form).
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @returns {Promise<string>} the SQL text of the dump.
 * @since 9.1.0
 * @example
 * fs.writeFileSync('backup.sql', await db.dump());
 */
Database.prototype.dump = async function dump() {
    let out = '';
    for await (const statement of iterdump(this)) {
        out += statement;
    }
    return out;
};

sqlite3.iterdump = iterdump;
sqlite3.migrate = migrate;

// Friendly names for the run-time limits db.limits reports, over the
// LIMIT_* constants the binding exports.
const LIMIT_NAMES = /** @type {const} */ ([
    ['length', 'LIMIT_LENGTH'],
    ['sqlLength', 'LIMIT_SQL_LENGTH'],
    ['column', 'LIMIT_COLUMN'],
    ['exprDepth', 'LIMIT_EXPR_DEPTH'],
    ['compoundSelect', 'LIMIT_COMPOUND_SELECT'],
    ['vdbeOp', 'LIMIT_VDBE_OP'],
    ['functionArg', 'LIMIT_FUNCTION_ARG'],
    ['attached', 'LIMIT_ATTACHED'],
    ['likePatternLength', 'LIMIT_LIKE_PATTERN_LENGTH'],
    ['variableNumber', 'LIMIT_VARIABLE_NUMBER'],
    ['triggerDepth', 'LIMIT_TRIGGER_DEPTH'],
    ['workerThreads', 'LIMIT_WORKER_THREADS'],
]);

// Friendly names for the db.status() counters, over the DBSTATUS_*
// constants the binding exports.
const DB_STATUS_NAMES = /** @type {const} */ ([
    ['lookasideUsed', 'DBSTATUS_LOOKASIDE_USED'],
    ['cacheUsed', 'DBSTATUS_CACHE_USED'],
    ['schemaUsed', 'DBSTATUS_SCHEMA_USED'],
    ['stmtUsed', 'DBSTATUS_STMT_USED'],
    ['lookasideHit', 'DBSTATUS_LOOKASIDE_HIT'],
    ['lookasideMissSize', 'DBSTATUS_LOOKASIDE_MISS_SIZE'],
    ['lookasideMissFull', 'DBSTATUS_LOOKASIDE_MISS_FULL'],
    ['cacheHit', 'DBSTATUS_CACHE_HIT'],
    ['cacheMiss', 'DBSTATUS_CACHE_MISS'],
    ['cacheWrite', 'DBSTATUS_CACHE_WRITE'],
    ['cacheSpill', 'DBSTATUS_CACHE_SPILL'],
    ['deferredFks', 'DBSTATUS_DEFERRED_FKS'],
]);

/**
 * Reads one `sqlite3_db_status` counter for the connection — cache
 * hits/misses, schema memory, and friends. Pass the counter by friendly
 * name (`'cacheHit'`) or by `sqlite3.DBSTATUS_*` constant. Resolves
 * `{ current, highwater }`; `{ reset: true }` zeroes the counters after
 * reading.
 *
 * Note: this build compiles with `SQLITE_DEFAULT_MEMSTATUS=0`, so the
 * process-wide memory counters report zero; the cache and schema
 * counters are the useful ones.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string | number} op the counter name or constant.
 * @param {{ reset?: boolean }} [options]
 * @returns {{ current: number, highwater: number }} the counter values.
 * @throws {TypeError} when the name is unknown.
 * @since 9.1.0
 * @example
 * const { current } = db.status('cacheHit');
 */
Database.prototype.status = function status(op, options) {
    const reset = options?.reset === true;
    if (typeof op === 'string') {
        const entry = DB_STATUS_NAMES.find(([name]) => name === op);
        if (entry === undefined) {
            throw new TypeError(`db.status() received unknown counter '${op}'`);
        }
        return this._dbStatus(/** @type {any} */ (sqlite3)[entry[1]], reset);
    }
    return this._dbStatus(op, reset);
};

/**
 * Releases non-essential memory held by this connection (page cache
 * beyond the working set) — the pool-pressure lever. Returns the number
 * of bytes freed (`sqlite3_db_release_memory`).
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @returns {number} bytes freed.
 * @since 9.1.0
 */
Database.prototype.releaseMemory = function releaseMemory() {
    return /** @type {number} */ (this._releaseMemory());
};

/**
 * The current run-time limits, by friendly name — the read form of
 * `configure('limit', sqlite3.LIMIT_*, value)`.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @name Database#limits
 * @type {Record<string, number>}
 * @since 9.1.0
 */
Object.defineProperty(Database.prototype, 'limits', {
    get() {
        /** @type {Record<string, number>} */
        const out = {};
        for (const [name, constant] of LIMIT_NAMES) {
            out[name] = /** @type {number} */ (
                this._getLimit(/** @type {any} */ (sqlite3)[constant])
            );
        }
        return out;
    },
    configurable: true,
});

/**
 * Resolves the filesystem path of an attached database (`''` for
 * in-memory or temporary schemas) — `sqlite3_db_filename`.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} [dbName] the attached name (default `'main'`).
 * @returns {string} the path.
 * @since 9.1.0
 */
Database.prototype.location = function location(dbName) {
    return /** @type {string} */ (this._dbLocation(dbName ?? 'main'));
};

// --- Tagged-template queries (Phase 5) ----------------------------------------

// The fragment brand. Composition helpers (raw/identifier/identifierPath/
// join/empty) mint fragments carrying this symbol, and only a value
// carrying it is spliced into the SQL as text. Structural detection ("has
// a `text` property") would turn any attacker-shaped object arriving in a
// template hole — `JSON.parse('{"text":"1 OR 1=1","params":[]}')` — into
// raw SQL. Everything unbranded is a bind parameter, always.
const SQL_FRAGMENT = Symbol('@appthreat/sqlite3.sqlFragment');

/**
 * One composed piece of SQL for the tag store: literal text plus bind
 * parameters. `sql.raw`/`identifier`/`join` build these; a plain value in
 * a template hole becomes a bind parameter instead.
 *
 * @typedef {object} SqlFragment
 * @property {string} text the SQL text.
 * @property {unknown[]} params the bind parameters, in text order.
 * @private
 */

/**
 * Builds a fragment.
 *
 * @param {string} text the SQL text.
 * @param {unknown[]} params the bind parameters.
 * @returns {SqlFragment} the fragment.
 * @private
 */
function fragment(text, params) {
    return Object.freeze({ text, params, [SQL_FRAGMENT]: true });
}

/**
 * True for a value minted by one of this store's composition helpers.
 *
 * @param {unknown} value the candidate.
 * @returns {boolean} whether it is a branded fragment.
 * @private
 */
function isFragment(value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        /** @type {{ [SQL_FRAGMENT]?: unknown }} */ (value)[SQL_FRAGMENT] ===
            true
    );
}

/**
 * A SQL identifier quoted for safe interpolation — the Kysely/Sequelize
 * helper names Bun notably lacks. Accepts plain identifiers and quoted
 * forms (already-`"quoted"` strings pass through).
 *
 * @param {string} name the identifier.
 * @returns {SqlFragment} the quoted fragment.
 * @throws {TypeError} for anything that is not a plain identifier.
 * @since 9.1.0
 */
function sqlIdentifier(name) {
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('sql.identifier() requires a non-empty string');
    }
    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
        return fragment(`"${name}"`, []);
    }
    // Schema-qualified or already-quoted forms pass through. The pattern
    // is what makes that safe: every part is wrapped in double quotes and
    // may not contain one, so nothing can close the quoting early. (The
    // previous guard also rejected every name containing a quote, which
    // made this branch unreachable.)
    if (!/[\\\0]/.test(name) && /^"[^"]+"(\."[^"]+")*$/.test(name)) {
        return fragment(name, []);
    }
    throw new TypeError(
        `sql.identifier() received ${JSON.stringify(name)}, which is not ` +
            'a plain identifier (quote each part yourself for exotic names)',
    );
}

/**
 * A dotted identifier path quoted part by part: `identifierPath('main.t.x')`.
 *
 * @param {string} dotted the dot-separated path.
 * @returns {SqlFragment} the quoted fragment.
 * @throws {TypeError} for empty or malformed parts.
 * @since 9.1.0
 */
function sqlIdentifierPath(dotted) {
    if (typeof dotted !== 'string' || dotted.length === 0) {
        throw new TypeError('sql.identifierPath() requires a non-empty string');
    }
    // Dots inside a "quoted part" belong to the name, not to the path:
    // identifierPath('"a.b".c') is two parts, not three.
    /** @type {string[]} */
    const parts = [];
    let current = '';
    let quoted = false;
    for (const ch of dotted) {
        if (ch === '"') {
            quoted = !quoted;
            current += ch;
        } else if (ch === '.' && !quoted) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    if (quoted) {
        throw new TypeError(
            'sql.identifierPath() received an unterminated quoted part',
        );
    }
    return fragment(
        parts
            .map((part) => {
                if (part.length === 0) {
                    throw new TypeError(
                        'sql.identifierPath() received an empty part',
                    );
                }
                return sqlIdentifier(part).text;
            })
            .join('.'),
        [],
    );
}

/**
 * Interpolates one template-hole value into the SQL under construction.
 *
 * @param {string[]} out the accumulated SQL chunks.
 * @param {unknown[]} params the accumulated bind parameters.
 * @param {unknown} value the hole's value.
 * @returns {void}
 * @private
 */
function appendHole(out, params, value) {
    if (isFragment(value)) {
        const frag = /** @type {SqlFragment} */ (value);
        out.push(frag.text);
        params.push(...frag.params);
        return;
    }
    out.push('?');
    params.push(value);
}

/**
 * Builds the {@link TagStore} — tagged-template queries driven by an LRU
 * of composed SQL (`store.all\`SELECT … WHERE id = ${id}\``), the
 * node:sqlite `createTagStore` shape plus the composition helpers ORMs
 * need: `store.raw`, `store.join`, `store.identifier`,
 * `store.identifierPath` and `store.empty`. Interpolated values become
 * positional `?` parameters (only a fragment from those helpers is
 * spliced in as SQL text); the joined SQL is the cache key.
 *
 * Statement reuse is the connection's: creating a store enables the
 * connection statement cache ({@link Database#cacheStatements}) if it is
 * not already on (an existing one is left at its own size), since
 * composing the same SQL repeatedly is the whole point of a tag store.
 * The store's own LRU holds the composed SQL keys (never the bound
 * values, which would pin every buffer the first call bound), and
 * `clear()` empties both.
 *
 * Promise-native (an improvement on node's sync-only store).
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {number} [maxSize=200] the cache capacity.
 * @returns {import('./augment.js').TagStore} the store.
 * @throws {TypeError} for a non-positive capacity.
 * @since 9.1.0
 * @example
 * const store = db.createTagStore();
 * const rows = await store.all`SELECT * FROM t WHERE id = ${id}`;
 */
Database.prototype.createTagStore = function createTagStore(maxSize = 200) {
    if (
        typeof maxSize !== 'number' ||
        !Number.isInteger(maxSize) ||
        maxSize < 1
    ) {
        throw new TypeError(
            'createTagStore() maxSize must be a positive integer',
        );
    }
    const db = this;
    // The composed-SQL keys this store has seen, most recently used last
    // (Map insertion order). Values are never retained: the statements
    // themselves live in the connection's cache.
    /** @type {Set<string>} */
    const cache = new Set();
    if (!db._stmtCache) db.cacheStatements();

    /**
     * Builds (or reuses) the statement arguments for one template call.
     *
     * @param {TemplateStringsArray} templates the template strings.
     * @param {unknown[]} values the interpolated values.
     * @returns {{ sql: string, params: unknown[] }} the statement and bind values.
     */
    const build = (templates, values) => {
        /** @type {string[]} */
        const chunks = [];
        /** @type {unknown[]} */
        const params = [];
        chunks.push(templates.raw[0]);
        for (let i = 0; i < values.length; i++) {
            appendHole(chunks, params, values[i]);
            chunks.push(templates.raw[i + 1]);
        }
        const sql = chunks.join('');
        // Most recently used last; the oldest key is evicted at capacity.
        cache.delete(sql);
        cache.add(sql);
        if (cache.size > maxSize) {
            const oldest = cache.values().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        return { sql, params };
    };

    /** @type {import('./augment.js').TagStore} */
    const store = /** @type {import('./augment.js').TagStore} */ (
        /** @type {unknown} */ ({
            get db() {
                return db;
            },
            get size() {
                return cache.size;
            },
            get capacity() {
                return maxSize;
            },
            clear() {
                // The statements themselves live in the connection's
                // statement cache (keyed by the same SQL strings); clear
                // that too or clear() frees nothing. Refuse first, before
                // either half is touched: flushing the cache from inside a
                // sync-invoked callback would finalize the statement
                // sqlite is stepping.
                assertNotInSyncCallback(db, 'the tag store cannot be cleared');
                cache.clear();
                db._drainStatementCache();
            },
        })
    );
    /**
     * @param {string} method
     * @param {TemplateStringsArray} templates
     * @param {unknown[]} values
     * @returns {any}
     */
    const tag = (method, templates, values) => {
        // (typed by the JSDoc above)
        if (!Array.isArray(templates) || !Array.isArray(templates.raw)) {
            throw new TypeError(
                'the tag store is used as a template tag: store.' +
                    `${method}\`SELECT …\``,
            );
        }
        const { sql, params } = build(templates, values);
        return /** @type {any} */ (db)[method](sql, ...params);
    };
    store.get = (templates, ...values) => tag('get', templates, values);
    store.all = (templates, ...values) => tag('all', templates, values);
    store.iterate = (templates, ...values) => tag('iterate', templates, values);
    store.run = (templates, ...values) => tag('run', templates, values);
    store.raw = (text) => {
        if (typeof text !== 'string') {
            throw new TypeError('sql.raw() requires a string');
        }
        return fragment(text, []);
    };
    store.join = (items, separator = ', ') => {
        if (!Array.isArray(items) || items.length === 0) {
            throw new TypeError('sql.join() requires a non-empty array');
        }
        if (typeof separator !== 'string') {
            throw new TypeError('sql.join() separator must be a string');
        }
        /** @type {string[]} */
        const parts = [];
        /** @type {unknown[]} */
        const params = [];
        for (const item of items) {
            // Fragments compose as text; anything else binds. An IN-list
            // of plain values is the common case (`join(ids)`), and it
            // must not require the caller to reach for raw() — which on
            // user data would be an injection.
            if (isFragment(item)) {
                const frag = /** @type {SqlFragment} */ (item);
                parts.push(frag.text);
                params.push(...frag.params);
            } else {
                parts.push('?');
                params.push(item);
            }
        }
        return fragment(parts.join(separator), params);
    };
    store.identifier = sqlIdentifier;
    store.identifierPath = sqlIdentifierPath;
    store.empty = () => fragment('', []);
    return store;
};

// --- JavaScript virtual tables (Phase 4) -------------------------------------

/**
 * Normalizes one column spec: `'name'`, `'name TYPE'` or
 * `{ name, type }` into the bare column name.
 *
 * @param {unknown} spec the column spec.
 * @param {string} who the call site, for error messages.
 * @returns {string} the column name.
 * @throws {TypeError} when the spec is malformed.
 * @private
 */
function vtabColumnName(spec, who) {
    if (typeof spec === 'string') {
        const name = spec.split(/\s+/)[0];
        if (name.length > 0) return name;
    } else if (
        spec !== null &&
        typeof spec === 'object' &&
        typeof (/** @type {{ name?: unknown }} */ (spec).name) === 'string' &&
        /** @type {{ name?: unknown }} */ (spec).name !== undefined &&
        /** @type {string} */ (/** @type {{ name?: unknown }} */ (spec).name)
            .length > 0
    ) {
        return /** @type {{ name: string }} */ (spec).name;
    }
    throw new TypeError(`${who} column specs must be strings or { name }`);
}

/**
 * @typedef {object} VtabDefinition
 * @property {(this: undefined, ...args: unknown[]) => Iterable<unknown[] | Record<string, unknown>>} rows
 *   the row generator: invoked once per query with the table-function
 *   parameter values; yields arrays (in column order) or objects keyed by
 *   column name.
 * @property {(string | { name: string, type?: string })[]} columns the
 *   result columns (a `'name TYPE'` string or `{ name, type }`; the type
 *   is documentation — SQLite virtual tables are typeless).
 * @property {string[]} [parameters] a subset of `columns` to declare
 *   HIDDEN — the table-valued function's arguments
 *   (`SELECT * FROM name(arg)` passes `arg` to `rows`).
 * @since 9.1.0
 */

/**
 * Registers a read-only virtual table computed by a JavaScript generator
 * — better-sqlite3's marquee feature, none of the other JS drivers have
 * it, and here it works from both the async paths (one worker round trip
 * per query — the whole generator output is materialised at filter time)
 * and the sync methods (a direct re-entrant call).
 *
 * The object form registers an **eponymous-only** module: the table
 * exists immediately under `name` (no `CREATE VIRTUAL TABLE`). The
 * factory-function form (`db.table(name, (arg, ...) => definition)`)
 * registers a named module instantiated per
 * `CREATE VIRTUAL TABLE ... USING name(args)`; the arguments arrive as
 * the SQL literal strings from the DDL.
 *
 * Registration is asynchronous but ordered: a query issued right after
 * `db.table()` queues behind the registration and sees the table. The
 * statement cache is flushed (a cached statement cannot gain the table).
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the module/table name (1..255 bytes).
 * @param {VtabDefinition | ((...args: string[]) => unknown)} definition
 *   the definition object, or a factory function for a named module.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the name or definition is malformed.
 * @since 9.1.0
 * @example
 * db.table('sequence', {
 *     columns: ['value'],
 *     rows: function* (count) {
 *         for (let i = 0; i < count; i++) yield [i];
 *     },
 * });
 * const rows = await db.all('SELECT value FROM sequence(5)');
 */
Database.prototype.table = function table(name, definition) {
    assertNotInSyncCallback(this, 'a virtual table cannot be registered');
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('table() requires a non-empty name string');
    }
    if (Buffer.byteLength(name, 'utf8') > 255) {
        throw new TypeError(
            "table() name exceeds SQLite's 255-byte module-name limit",
        );
    }
    const isFactory = typeof definition === 'function';
    if (
        definition === null ||
        (typeof definition !== 'object' && typeof definition !== 'function')
    ) {
        throw new TypeError(
            'table() requires a definition object or a factory function',
        );
    }

    /**
     * Extracts the shape from the definition (the factory's own columns
     * are declared up front by the module).
     *
     * @param {VtabDefinition | ((...args: string[]) => VtabDefinition)} def
     * @param {boolean} allowMissingRows
     * @returns {{ columns: string[], params: string[], rows: unknown }}
     */
    const parse = (def, allowMissingRows) => {
        if (def === null || typeof def !== 'object' || Array.isArray(def)) {
            throw new TypeError(
                'table() definition must be an object with columns and rows',
            );
        }
        const known = new Set(['rows', 'columns', 'parameters']);
        for (const key of Object.keys(def)) {
            if (!known.has(key)) {
                throw new TypeError(
                    `table() definition received unknown option '${key}'`,
                );
            }
        }
        if (!Array.isArray(def.columns)) {
            throw new TypeError(
                "table() definition requires a 'columns' array",
            );
        }
        const columns = def.columns.map((spec) =>
            vtabColumnName(spec, 'table()'),
        );
        const parameters = def.parameters ?? [];
        if (!Array.isArray(parameters)) {
            throw new TypeError(
                "table() option 'parameters' must be an array of column names",
            );
        }
        for (const param of parameters) {
            if (typeof param !== 'string' || param.length === 0) {
                throw new TypeError(
                    "table() 'parameters' entries must be non-empty strings",
                );
            }
            if (!columns.includes(param)) {
                throw new TypeError(
                    `table() parameter '${param}' is not one of the columns; ` +
                        'parameters are the subset of columns declared HIDDEN',
                );
            }
        }
        const rows = /** @type {unknown} */ (def.rows);
        if (typeof rows !== 'function' && !allowMissingRows) {
            throw new TypeError(
                "table() definition requires a 'rows' generator function",
            );
        }
        return { columns, params: parameters, rows };
    };

    let columns;
    let params;
    let factory = null;
    let rows = null;
    if (isFactory) {
        // A factory's instances all share the module's declared shape, so
        // the factory itself carries the columns (same spec shapes as a
        // definition's); the definitions it returns supply only rows.
        factory = definition;
        const fn = /** @type {{ columns?: unknown, parameters?: unknown }} */ (
            /** @type {unknown} */ (definition)
        );
        if (!Array.isArray(fn.columns)) {
            throw new TypeError(
                'a table() factory must declare its columns as factory ' +
                    ".columns (same shape as a definition's), so the module " +
                    'can declare them for every instance',
            );
        }
        columns = fn.columns.map((spec) => vtabColumnName(spec, 'table()'));
        const fparams = fn.parameters ?? [];
        if (!Array.isArray(fparams)) {
            throw new TypeError(
                'factory.parameters must be an array of column names',
            );
        }
        for (const param of fparams) {
            if (typeof param !== 'string' || !columns.includes(param)) {
                throw new TypeError(
                    `factory parameter '${String(param)}' is not one of the columns`,
                );
            }
        }
        params = fparams;
    } else {
        const parsed = parse(definition, false);
        columns = parsed.columns;
        params = parsed.params;
        rows = parsed.rows;
    }

    // See function(): a cached statement keeps the schema it was compiled
    // against, so the cache must not hand one back across a registration.
    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._registerVtab)
    )(name, columns, params, factory, rows);
    return this;
};

/**
 * Removes a virtual table module registered with {@link Database#table}.
 * In-flight queries complete; a later query against the name fails
 * loudly ("this virtual table module was removed").
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} name the module name.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the name is malformed.
 * @since 9.1.0
 */
Database.prototype.removeTable = function removeTable(name) {
    assertNotInSyncCallback(this, 'a virtual table cannot be removed');
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('removeTable() requires a non-empty name string');
    }
    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._removeVtab)
    )(name);
    return this;
};

// The auto-incrementing suffix for db.values() table names.
let valuesTableCounter = 0;
/**
 * The per-connection registry of db.values() tables: registration order
 * (for the cap) and the drop handles.
 *
 * @typedef {object} ValuesRegistry
 * @property {string[]} order the table names, oldest registration first.
 * @property {Map<string, { name: string, drop: () => void }>} byName the handles.
 */
/** @type {WeakMap<object, ValuesRegistry>} */
const valuesTables = new WeakMap();
const VALUES_TABLES_MAX = 32;

/**
 * Registers one JS array (or any iterable) as a queryable table — the
 * rusqlite `rarray()` ergonomics no JS driver has: `WHERE id IN (SELECT
 * value FROM v)` and `JOIN` against in-memory data, no string-building.
 *
 * Returns `{ name, drop() }`: `name` is the (unquoted) table name to use
 * in SQL, keyed by position (`key`, 0-based) and element (`value`).
 * `drop()` removes one explicitly, and the whole connection is cleaned up
 * at close.
 *
 * Anonymous registrations are capped at 32 per connection: the 33rd drops
 * the oldest, whose handle then refers to a table that no longer exists
 * (a query against it fails with "this virtual table module was removed").
 * The cap exists so a forgotten `drop()` cannot grow without bound —
 * `drop()` each handle when you are done with it, or pass an explicit
 * `{ name }`, which opts out of the cap entirely.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {Iterable<unknown>} iterable the array/iterable to expose.
 * @param {{ name?: string }} [options] an explicit table name (then no
 *   LRU applies — drop() it yourself).
 * @returns {{ name: string, drop: () => void }} the table handle.
 * @throws {TypeError} when the values or options are malformed.
 * @since 9.1.0
 * @example
 * const ids = db.values([4, 8, 15]);
 * const rows = await db.all(
 *     `SELECT * FROM users JOIN ${ids.name} v ON users.id = v.value`,
 * );
 */
Database.prototype.values = function values(iterable, options) {
    assertNotInSyncCallback(this, 'a values table cannot be registered');
    if (iterable === null || typeof iterable[Symbol.iterator] !== 'function') {
        throw new TypeError('values() requires an iterable');
    }
    let explicitName;
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('values() options must be an object');
        }
        for (const key of Object.keys(options)) {
            if (key !== 'name') {
                throw new TypeError(
                    `values() received unknown option '${key}'`,
                );
            }
        }
        if (options.name !== undefined) {
            if (typeof options.name !== 'string' || options.name.length === 0) {
                throw new TypeError(
                    "values() option 'name' must be a non-empty string",
                );
            }
            explicitName = options.name;
        }
    }
    let registry = valuesTables.get(this);
    if (registry === undefined) {
        registry = { order: [], byName: new Map() };
        valuesTables.set(this, registry);
    }
    const name = explicitName ?? `sqlite_values_${++valuesTableCounter}`;
    this.table(name, {
        columns: ['key', 'value'],
        rows: function* () {
            let key = 0;
            for (const value of iterable) {
                yield [key++, value];
            }
        },
    });
    /** @type {() => void} */
    let drop = () => {
        this.removeTable(name);
        registry?.byName.delete(name);
        const at = registry?.order.indexOf(name);
        if (at !== undefined && at >= 0) registry?.order.splice(at, 1);
        // Dropped once; a second call is a no-op rather than a second
        // removeTable (which would refuse or drop a re-registered name).
        drop = () => undefined;
    };
    const existing = registry.byName.get(name);
    if (existing !== undefined) existing.drop();
    registry.byName.set(name, { name, drop: () => drop() });
    if (!explicitName) {
        registry.order.push(name);
        while (registry.order.length > VALUES_TABLES_MAX) {
            const oldest = registry.order.shift();
            const entry =
                oldest !== undefined ? registry.byName.get(oldest) : undefined;
            if (entry !== undefined) entry.drop();
        }
    }
    return { name, drop: () => drop() };
};

// --- Hooks, authorizer, progress, WAL and introspection (Deliverable 07) --
//
// The commit/rollback/wal hooks are installed by the on()/removeListener()
// overrides above: the native sqlite hook exists only while a listener is
// registered, so an installed-but-unused hook costs nothing.

/**
 * Installs (or removes) a declarative authorizer on the connection.
 *
 * The policy is evaluated inside SQLite itself, in C++ — there is no
 * JavaScript callback on the prepare path, so it is fast and safe from any
 * thread that prepares a statement. This is the supported way to sandbox
 * user-supplied SQL: with `{ default: 'deny' }` everything is refused
 * unless a rule explicitly allows it.
 *
 * `deny` rules are evaluated before `allow` rules, and a denied action
 * fails the statement with `SQLITE_AUTH` ("not authorized"). The statement
 * cache is flushed on every change: a cached statement was compiled while
 * the old policy was in force and would bypass the new one entirely.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {import('./native.js').AuthorizerPolicy | null} [policy] the
 *   policy to install, or null/undefined to remove the authorizer.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the policy or one of its rules is malformed.
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
Database.prototype.authorizer = function (policy) {
    assertNotInSyncCallback(this, 'the authorizer policy cannot be changed');
    if (policy === null || policy === undefined) {
        this._drainStatementCache();
        /** @type {(...args: unknown[]) => unknown} */ (
            /** @type {unknown} */ (this._setAuthorizer)
        )();
        return this;
    }
    if (typeof policy !== 'object' || Array.isArray(policy)) {
        throw new TypeError('authorizer() policy must be an object or null');
    }
    const known = new Set(['default', 'allow', 'deny', 'ignore']);
    for (const key of Object.keys(policy)) {
        if (!known.has(key)) {
            throw new TypeError(
                `authorizer() received unknown option '${key}'`,
            );
        }
    }
    const decisions = new Set(['allow', 'deny', 'ignore']);
    const decisionOf = /** @type {Record<string, number>} */ ({
        allow: sqlite3.OK,
        deny: sqlite3.DENY,
        ignore: sqlite3.IGNORE,
    });
    const fallback = policy.default === undefined ? 'allow' : policy.default;
    if (!decisions.has(fallback)) {
        throw new TypeError(
            "authorizer() default must be 'allow', 'deny' or 'ignore'",
        );
    }

    /**
     * Normalizes one rule list into native rows
     * [action, verdict, arg1, arg2, database, trigger].
     *
     * @param {unknown} rules the raw rule list.
     * @param {string} verdict the list's decision name ('allow' etc).
     * @param {string} who the list's name in the policy, for error messages.
     * @returns {unknown[][]} the native rule rows.
     */
    const normalize = (rules, verdict, who) => {
        if (rules === undefined || rules === null) return [];
        if (!Array.isArray(rules)) {
            throw new TypeError(
                `authorizer() '${who}' must be an array of rules`,
            );
        }
        return rules.map((rule, i) => {
            if (
                rule === null ||
                typeof rule !== 'object' ||
                Array.isArray(rule)
            ) {
                throw new TypeError(
                    `authorizer() ${who}[${i}] must be a rule object`,
                );
            }
            const where = `authorizer() ${who}[${i}]`;
            // null = match anything; an explicit '' targets an empty
            // argument (previously unexpressible — D08 closes the D07
            // finding).
            const row = /** @type {(number | string | null)[]} */ ([
                -1,
                decisionOf[verdict],
                null,
                null,
                null,
                null,
            ]);
            if (rule.action !== undefined) {
                if (
                    typeof rule.action !== 'number' ||
                    !Number.isInteger(rule.action)
                ) {
                    throw new TypeError(
                        `${where} action must be an integer constant`,
                    );
                }
                row[0] = rule.action;
            }
            const arg1 = rule.arg1 !== undefined ? rule.arg1 : rule.table;
            const arg2 = rule.arg2 !== undefined ? rule.arg2 : rule.column;
            const parts = [
                [arg1, 'arg1'],
                [arg2, 'arg2'],
                [rule.database, 'database'],
                [rule.trigger, 'trigger'],
            ];
            parts.forEach((part, j) => {
                const value = part[0];
                const name = /** @type {string} */ (part[1]);
                if (value === undefined || value === null) return;
                if (typeof value !== 'string') {
                    throw new TypeError(`${where} ${name} must be a string`);
                }
                row[2 + j] = value;
            });
            return row;
        });
    };

    // Deny first: the sandbox reading — a deny must not be rescuable by a
    // later allow, whatever the array order.
    const rows = [
        ...normalize(policy.deny, 'deny', 'deny'),
        ...normalize(policy.ignore, 'ignore', 'ignore'),
        ...normalize(policy.allow, 'allow', 'allow'),
    ];

    this._drainStatementCache();
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._setAuthorizer)
    )(decisionOf[fallback], rows);
    return this;
};

/**
 * Installs a progress handler. Two forms:
 *
 * - `db.progress(period, callback)` — a JavaScript callback invoked every
 *   `period` VM instructions; returning truthy aborts the running
 *   statement with `SQLITE_INTERRUPT`. Each invocation is a blocking
 *   round trip to the JS thread from whatever thread is executing SQL,
 *   so it is the expensive form: fine for progress bars over a handful
 *   of long queries, wrong for anything per-row. While it is installed,
 *   the synchronous methods (`getSync`/`runSync`/`allSync` and
 *   `prepareSync`) refuse to run — the callback could fire on the thread
 *   that would have to service it.
 * - `db.cancellationToken()` — the recommended form; see there.
 *
 * Calling `db.progress()` with no callback removes the handler.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {number | (() => unknown)} [period] VM instructions between
 *   invocations (default 1000), or the callback directly.
 * @param {() => unknown} [callback] called with no arguments; a truthy
 *   return aborts the statement.
 * @returns {import('./sqlite3-binding.js').Database} this database, for chaining.
 * @throws {TypeError} when the period or callback has the wrong type.
 * @since 9.0.0
 * @example
 * db.progress(10000, () => shouldStop);
 */
Database.prototype.progress = function (period, callback) {
    if (typeof period === 'function' && callback === undefined) {
        callback = period;
        period = 1000;
    }
    if (callback === undefined || callback === null) {
        // Also the documented removal form: db.progress().
        progressOwner.delete(this);
        /** @type {(...args: unknown[]) => unknown} */ (
            /** @type {unknown} */ (this._progressCallback)
        )();
        return this;
    }
    if (typeof period !== 'number' || !Number.isInteger(period) || period < 1) {
        throw new TypeError('progress() period must be a positive integer');
    }
    if (typeof callback !== 'function') {
        throw new TypeError('progress() callback must be a function');
    }
    // The callback form takes the slot from any token that held it.
    progressOwner.delete(this);
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._progressCallback)
    )(period, callback);
    return this;
};

// SQLite has exactly one progress-handler slot per connection, but three
// things claim it: cancellationToken(), progress(fn) and progress()'s
// removal form. Whoever claims it last owns it, and only the owner may
// release it — otherwise a stale token's destroy() silently disarms
// whatever replaced it, and a cancel() that should abort a runaway query
// does nothing (leaving the connection wedged on it).
/** @type {WeakMap<object, object>} */
const progressOwner = new WeakMap();

/**
 * Creates a {@link CancellationToken} for this connection. The flag lives
 * in a `SharedArrayBuffer`, so `cancel()` works from any thread — hand
 * the token's `signal` or the buffer itself to a `worker_threads` Worker
 * and it can stop a query running on the main connection.
 *
 * The handler is installed until `token.destroy()` or the connection
 * closes; while it is installed every query pays one relaxed atomic load
 * per `period` VM instructions (measured in bench: within noise for the
 * default period of 1000).
 *
 * A connection has one progress slot: creating a second token, or
 * calling {@link Database#progress}, replaces the first. `destroy()` on
 * a token that no longer owns the slot only clears its own flag.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {{ period?: number }} [options] `period`: VM instructions
 *   between flag checks (default 1000; lower aborts sooner and costs
 *   proportionally more).
 * @returns {import('./native.js').CancellationToken} the token.
 * @throws {TypeError} when the period is not a positive integer.
 * @since 9.0.0
 * @example
 * const token = db.cancellationToken();
 * db.all('WITH RECURSIVE ...', () => {}).catch(() => {});
 * token.cancel();
 */
Database.prototype.cancellationToken = function (options) {
    const period = options?.period ?? 1000;
    if (typeof period !== 'number' || !Number.isInteger(period) || period < 1) {
        throw new TypeError(
            'cancellationToken() period must be a positive integer',
        );
    }
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    const controller = new AbortController();
    /** @type {import('./sqlite3-binding.js').Database} */
    const db = this;
    /** @type {boolean} */
    let cancelled = false;
    /** @type {import('./native.js').CancellationToken} */
    const token = {
        get cancelled() {
            return Atomics.load(flag, 0) !== 0;
        },
        get signal() {
            return controller.signal;
        },
        get buffer() {
            return sab;
        },
        cancel(reason) {
            if (cancelled) return;
            cancelled = true;
            Atomics.store(flag, 0, 1);
            controller.abort(reason);
        },
        reset() {
            cancelled = false;
            Atomics.store(flag, 0, 0);
        },
        destroy() {
            Atomics.store(flag, 0, 0);
            // Only the current owner may release the slot; see
            // progressOwner above.
            if (progressOwner.get(db) !== token) return;
            progressOwner.delete(db);
            /** @type {(...args: unknown[]) => unknown} */ (
                /** @type {unknown} */ (db._progressFlag)
            )();
        },
    };
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._progressFlag)
    )(flag, period);
    progressOwner.set(this, token);
    return token;
};

/**
 * Runs a WAL checkpoint on this connection.
 *
 * The result reports `busy` (another connection's reader or writer
 * prevented the checkpoint), `logFrames` (frames in the WAL) and
 * `checkpointedFrames` (frames copied back into the database). This is
 * the lever for keeping a WAL file bounded under sustained writes; see
 * also the `'wal'` event for a per-commit notification.
 *
 * In callback mode returns this database; otherwise returns a promise
 * resolving the result.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {import('./native.js').CheckpointOptions | import('./native.js').CheckpointMode | string | ((err: import('./native.js').SqliteError | null, result: import('./native.js').CheckpointResult) => void)} [options] the
 *   options object, or just the mode, or just the attached database
 *   name, or just the callback.
 * @param {(err: import('./native.js').SqliteError | null, result: import('./native.js').CheckpointResult) => void} [callback]
 *   called with the checkpoint result.
 * @returns {any} this database in callback mode (the promise layer
 *   rewraps the core).
 * @throws {TypeError} when the mode is unknown.
 * @since 9.0.0
 * @example
 * await db.checkpoint({ mode: 'truncate' });
 */
Database.prototype.checkpoint = function (options, callback) {
    /** @type {string} */
    let dbName = 'main';
    /** @type {string} */
    let mode = 'passive';
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    } else if (typeof options === 'string') {
        mode = options;
    } else if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('checkpoint() options must be an object');
        }
        if (options.db !== undefined) {
            if (typeof options.db !== 'string') {
                throw new TypeError(
                    "checkpoint() option 'db' must be a string",
                );
            }
            dbName = options.db;
        }
        if (options.mode !== undefined) {
            mode = options.mode;
        }
    }
    const modes = /** @type {Record<string, number>} */ ({
        passive: sqlite3.CHECKPOINT_PASSIVE,
        full: sqlite3.CHECKPOINT_FULL,
        restart: sqlite3.CHECKPOINT_RESTART,
        truncate: sqlite3.CHECKPOINT_TRUNCATE,
    });
    const modeInt = modes[mode];
    if (modeInt === undefined) {
        throw new TypeError(
            "checkpoint() mode must be 'passive', 'full', 'restart' or 'truncate'",
        );
    }
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._checkpoint)
    )(dbName, modeInt, callback);
    return this;
};

/**
 * Reads one table's column metadata (`PRAGMA table_info` enriched with
 * `sqlite3_table_column_metadata`). Runs a `PRAGMA` on the connection, so
 * an installed deny-by-default authorizer must allow `sqlite3.PRAGMA`.
 *
 * In callback mode returns this database; the promise layer rewraps the
 * core so promise mode resolves the column array. An empty array means
 * the table has no columns or does not exist.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} table the table name.
 * @param {string | ((err: import('./native.js').SqliteError | null, columns: import('./native.js').TableColumnInfo[]) => void)} [dbName]
 *   the attached database (default `'main'`), or the callback.
 * @param {(err: import('./native.js').SqliteError | null, columns: import('./native.js').TableColumnInfo[]) => void} [callback]
 *   called with the column array.
 * @returns {any} this database in callback mode (the promise layer
 *   rewraps the core).
 * @throws {TypeError} when the table name is missing.
 * @since 9.0.0
 * @example
 * const columns = await db.tableInfo('users');
 */
Database.prototype.tableInfo = function (table, dbName, callback) {
    if (typeof table !== 'string' || table.length === 0) {
        throw new TypeError('tableInfo() requires a non-empty table name');
    }
    if (typeof dbName === 'function') {
        callback = dbName;
        dbName = 'main';
    }
    if (dbName !== undefined && dbName !== null && typeof dbName !== 'string') {
        throw new TypeError('tableInfo() database name must be a string');
    }
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._tableInfo)
    )(dbName ?? 'main', table, callback);
    return this;
};

/**
 * Reads or changes one of the safe `sqlite3_db_config` switches:
 * `sqlite3.DBCONFIG_ENABLE_FKEY`, `_ENABLE_TRIGGER`, `_ENABLE_VIEW`,
 * `_ENABLE_LOAD_EXTENSION`, `_DEFENSIVE`, `_WRITABLE_SCHEMA` and
 * `_TRUSTED_SCHEMA`.
 *
 * Passing `true`/`false` (or 1/0) sets the switch and the promise resolves
 * its previous value; passing `-1` (or omitting the value) only reads it.
 *
 * In callback mode returns this database; the promise layer rewraps the
 * core so promise mode resolves the resulting boolean.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {number} op one of the `DBCONFIG_*` constants.
 * @param {boolean | number | ((err: import('./native.js').SqliteError | null, value: boolean) => void)} [value]
 *   true/false to set, -1 to query, or the callback.
 * @param {(err: import('./native.js').SqliteError | null, value: boolean) => void} [callback]
 *   called with the previous value.
 * @returns {any} this database in callback mode (the promise layer
 *   rewraps the core).
 * @throws {TypeError} when the op is not a known DBCONFIG constant or the
 *   value is invalid.
 * @since 9.0.0
 * @example
 * const was = await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE, true);
 */
Database.prototype.dbConfig = function (op, value, callback) {
    if (typeof value === 'function') {
        callback = value;
        value = -1;
    }
    /** @type {Set<number>} */
    const known = new Set([
        sqlite3.DBCONFIG_ENABLE_FKEY,
        sqlite3.DBCONFIG_ENABLE_TRIGGER,
        sqlite3.DBCONFIG_ENABLE_VIEW,
        sqlite3.DBCONFIG_ENABLE_LOAD_EXTENSION,
        sqlite3.DBCONFIG_DEFENSIVE,
        sqlite3.DBCONFIG_WRITABLE_SCHEMA,
        sqlite3.DBCONFIG_TRUSTED_SCHEMA,
    ]);
    if (typeof op !== 'number' || !known.has(op)) {
        throw new TypeError(
            'dbConfig() op must be one of the DBCONFIG_* constants',
        );
    }
    /** @type {number} */
    let valueInt;
    if (value === undefined || value === null || value === -1) {
        valueInt = -1;
    } else if (value === true) {
        valueInt = 1;
    } else if (value === false) {
        valueInt = 0;
    } else if (typeof value === 'number' && (value === 0 || value === 1)) {
        valueInt = value;
    } else {
        throw new TypeError('dbConfig() value must be a boolean or -1');
    }
    /** @type {(...args: unknown[]) => unknown} */ (
        /** @type {unknown} */ (this._dbConfig)
    )(op, valueInt, callback);
    return this;
};

/**
 * Validates the shared function/aggregate options and computes the SQLite
 * arity and flag word.
 *
 * @param {string} name the requested SQL name.
 * @param {unknown} options the raw options object (or undefined).
 * @param {number} defaultArity the arity derived from the implementation.
 * @param {string} who the calling method, for error messages.
 * @param {string[]} [extraKeys] option keys owned by the caller (the
 *   aggregate implementation functions).
 * @returns {{ nArg: number, flags: number }} the arity and flag word.
 * @throws {TypeError} on an invalid name or option.
 * @private
 */
function parseFunctionOptions(name, options, defaultArity, who, extraKeys) {
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(`${who} requires a non-empty name string`);
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_FUNCTION_NAME) {
        throw new TypeError(
            `${who} name exceeds SQLite's ${MAX_FUNCTION_NAME}-byte limit`,
        );
    }
    const opts = options === undefined || options === null ? {} : options;
    if (typeof opts !== 'object' || Array.isArray(opts)) {
        throw new TypeError(`${who} options must be an object`);
    }
    const known = new Set([
        'deterministic',
        'directOnly',
        'innocuous',
        'varargs',
        ...(extraKeys ?? []),
    ]);
    for (const key of Object.keys(opts)) {
        if (!known.has(key)) {
            throw new TypeError(`${who} received unknown option '${key}'`);
        }
    }
    // Only the flag keys are boolean-typed; the aggregate implementation
    // keys are functions validated by the caller.
    const flagKeys = /** @type {string[]} */ ([
        'deterministic',
        'directOnly',
        'innocuous',
        'varargs',
    ]);
    for (const key of flagKeys) {
        const value = /** @type {Record<string, unknown>} */ (opts)[key];
        if (value !== undefined && typeof value !== 'boolean') {
            throw new TypeError(`${who} option '${key}' must be a boolean`);
        }
    }
    /**
     * @param {string} key
     */
    const get = (key) =>
        /** @type {Record<string, unknown>} */ (opts)[key] === true;

    let nArg;
    if (get('varargs')) {
        nArg = -1;
    } else {
        nArg = defaultArity;
        if (nArg > MAX_FUNCTION_ARG) {
            throw new TypeError(
                `${who} arity ${nArg} exceeds SQLite's ` +
                    `${MAX_FUNCTION_ARG}-argument limit; use { varargs: true }`,
            );
        }
    }
    // directOnly defaults to true: the security posture that keeps a JS
    // callback from being invoked through a trigger, view or CHECK
    // constraint in attacker-supplied schema SQL. Opting out is explicit.
    const flags =
        (get('deterministic') ? SQLITE_DETERMINISTIC : 0) |
        (opts &&
        /** @type {Record<string, unknown>} */ (opts).directOnly === false
            ? 0
            : SQLITE_DIRECTONLY) |
        (get('innocuous') ? SQLITE_INNOCUOUS : 0);
    return { nArg, flags };
}

sqlite3.cached = {
    /**
     * Opens a connection, or reuses the one already open for the
     * resolved path.
     *
     * @param {string} file the database filename.
     * @param {number | ((this: import('./sqlite3-binding.js').Database, err: Error | null) => void)} [a] open mode, or the callback.
     * @param {(this: import('./sqlite3-binding.js').Database, err: Error | null) => void} [b] the callback when a mode was given.
     * @returns {import('./sqlite3-binding.js').Database} the connection.
     */
    Database: function (file, a, b) {
        /** @type {any} */
        const modeOrCallback = a;
        /** @type {any} */
        const callback = b;
        if (file === '' || file === ':memory:') {
            // Don't cache special databases.
            return new Database(file, modeOrCallback, callback);
        }

        /** @type {import('./sqlite3-binding.js').Database} */
        let db;
        file = path.resolve(file);

        if (!sqlite3.cached.objects[file]) {
            db = sqlite3.cached.objects[file] = new Database(
                file,
                modeOrCallback,
                callback,
            );
        } else {
            // Make sure the callback is called.
            db = sqlite3.cached.objects[file];
            const callback = typeof a === 'number' ? b : a;
            if (typeof callback === 'function') {
                const cb = () => callback.call(db, null);
                if (db.open) process.nextTick(cb);
                else db.once('open', cb);
            }
        }

        return db;
    },
    objects: {},
};

// Database#backup (the guarded definition) lives with the other
// Deliverable 11 wrappers above, before installPromiseApi runs.

/**
 * Maps rows by their first column via `all`, then reshapes the result.
 *
 * With two columns the value is the second column; with any other count
 * (including a single column) the value is the whole row — the
 * single-column case used to yield `undefined` for every entry
 * (REVIEW-LOG, D03).
 *
 * @this {import('./sqlite3-binding.js').Statement}
 * @param {...any} params bind parameters, then the callback.
 * @returns {any} this statement in callback mode, a promise otherwise.
 */
Statement.prototype.map = function (...params) {
    const popped = params.pop();
    const callback =
        /** @type {(err: Error | null, map?: Record<string, unknown>) => void} */ (
            /** @type {unknown} */ (popped)
        );
    /**
     * @param {Error | null} err
     * @param {Record<string, unknown>[] | null} rows
     */
    const reshape = (err, rows) => {
        // An error means there are no rows to reshape: hand the caller the
        // error alone, exactly as the callback-mode contract has always
        // done (a second argument here would be a fake empty result).
        if (err) return callback(err, undefined);
        /** @type {Record<string, unknown>} */
        const result = {};
        if (rows?.length) {
            const keys = Object.keys(rows[0]);
            const key = keys[0];
            if (keys.length > 2) {
                // Value is an object
                for (let i = 0; i < rows.length; i++) {
                    result[/** @type {string} */ (rows[i][key])] = rows[i];
                }
            } else if (keys.length === 2) {
                const value = keys[1];
                // Value is a plain value
                for (let i = 0; i < rows.length; i++) {
                    result[/** @type {string} */ (rows[i][key])] =
                        rows[i][value];
                }
            } else {
                // Single column: the key column is the only data there is,
                // so the value is the whole row (same rule as >2). Used to
                // return `undefined` for every entry (REVIEW-LOG, D03).
                for (let i = 0; i < rows.length; i++) {
                    result[/** @type {string} */ (rows[i][key])] = rows[i];
                }
            }
        }
        callback(err, result);
    };
    params.push(reshape);
    return /** @type {(...args: any[]) => any} */ (this.all)(...params);
};

let isVerbose = false;

const supportedEvents = new Set([
    'trace',
    'profile',
    'change',
    'commit',
    'rollback',
    'wal',
    // Deliverable 08. Shares SQLite's single preupdate hook with the
    // session extension; the registration fails loudly while a session
    // is open, and db.session() throws while a listener is registered.
    'preupdate',
]);

// --- diagnostics_channel (Phase 6) -------------------------------------------
//
// Node's own node:sqlite publishes finished-statement spans on the
// 'sqlite.db.query' channel when it has subscribers; APM tooling can
// subscribe to that name. This package publishes the same payload shape
// there AND on '@appthreat/sqlite3.query' (the named channel is this
// package's documented surface; the sqlite.db.query mirror exists for
// tool compatibility). The SQLITE_TRACE_PROFILE machinery is armed only
// while a subscriber exists, so the cost when nobody listens is nothing
// at all: no hook, no per-query work.

const DIAGNOSTIC_OWN_CHANNEL = '@appthreat/sqlite3.query';
const DIAGNOSTIC_NODE_CHANNEL = 'sqlite.db.query';

// Every open connection, so a subscriber arriving late can arm tracing on
// connections that already exist. Maintained by the Database wrapper
// (constructor adds, close removes) — and held *weakly*: a connection
// dropped without close() must still be collectable, or this registry
// would pin every Database (and its sqlite handle and file descriptor)
// for the life of the process. Dead references are pruned on iteration.
/** @type {Set<WeakRef<import('./sqlite3-binding.js').Database>>} */
const liveConnections = new Set();

/**
 * Registers a connection with the diagnostics registry.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @returns {void}
 * @private
 */
function trackConnection(db) {
    liveConnections.add(new WeakRef(db));
}

/**
 * Drops a connection from the diagnostics registry (close()), pruning
 * collected entries while it walks.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @returns {void}
 * @private
 */
function untrackConnection(db) {
    for (const ref of liveConnections) {
        const live = ref.deref();
        if (live === undefined || live === db) liveConnections.delete(ref);
    }
}

/**
 * The live connections, pruning collected entries as it goes.
 *
 * @returns {import('./sqlite3-binding.js').Database[]} the connections.
 * @private
 */
function trackedConnections() {
    /** @type {import('./sqlite3-binding.js').Database[]} */
    const live = [];
    for (const ref of liveConnections) {
        const db = ref.deref();
        if (db === undefined) liveConnections.delete(ref);
        else live.push(db);
    }
    return live;
}
/**
 * One finished-statement span, published on the diagnostics channels.
 *
 * @typedef {object} QuerySpan
 * @property {string} sql the expanded SQL text.
 * @property {import('./sqlite3-binding.js').Database} database the connection.
 * @property {bigint} duration the measured duration in nanoseconds.
 * @property {number} durationMs the measured duration in milliseconds.
 * @since 9.1.0
 */
// The sqlite3.subscribeQueries() consumers (Phase 6): non-empty means the
// profile tracing is armed.
/** @type {Set<(message: QuerySpan) => void>} */
const diagnosticsChannelSubscribers = new Set();

/**
 * The internal profile listener forwarding one connection's finished
 * statements into the channels. Kept as one shared function so it can be
 * removed again on unsubscribe.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @param {string} sql the expanded SQL text.
 * @param {number} ms the measured duration in milliseconds.
 */
function publishQuerySpan(db, sql, ms) {
    const message = {
        sql,
        database: db,
        duration: BigInt(Math.round(ms * 1e6)),
        durationMs: ms,
    };
    for (const onMessage of diagnosticsChannelSubscribers) {
        try {
            onMessage(/** @type {QuerySpan} */ (message));
        } catch {
            // A throwing consumer must not break the query pipeline.
        }
    }
    diagnostics_channel.channel(DIAGNOSTIC_OWN_CHANNEL).publish(message);
    diagnostics_channel.channel(DIAGNOSTIC_NODE_CHANNEL).publish(message);
}

// The listener this module installed on each armed connection, so arming
// and disarming touch exactly that one: a user's own 'profile' listener
// must neither block publication (the old `listenerCount === 0` test made
// subscribeQueries silently inert next to one) nor be removed by an
// unsubscribe (removeAllListeners took them with it).
/** @type {WeakMap<object, (sql: string, ms: number) => void>} */
const armedProfileListeners = new WeakMap();

/**
 * Arms span publication on one connection (the per-connection half of
 * {@link armDiagnostics}).
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @returns {void}
 * @private
 */
function armDiagnosticsFor(db) {
    if (armedProfileListeners.has(db)) return;
    /** @type {(sql: string, ms: number) => void} */
    const listener = (sql, ms) => publishQuerySpan(db, sql, ms);
    armedProfileListeners.set(db, listener);
    // The user may already have a 'profile' listener (and therefore
    // tracing already on); adding ours is additive, and configure() is
    // idempotent.
    db.on('profile', listener);
    db.configure('profile', true);
}

/**
 * Disarms span publication on one connection, leaving any listener the
 * user registered — and the tracing it needs — in place.
 *
 * @param {import('./sqlite3-binding.js').Database} db the connection.
 * @returns {void}
 * @private
 */
function disarmDiagnosticsFor(db) {
    const listener = armedProfileListeners.get(db);
    if (listener === undefined) return;
    armedProfileListeners.delete(db);
    db.removeListener('profile', listener);
    // Only stop tracing when nobody else is listening for it.
    if (db.listenerCount('profile') === 0) db.configure('profile', false);
}

/**
 * Arms or disarms span publication on every live connection.
 *
 * @param {boolean} arm true to arm, false to disarm.
 * @returns {void}
 * @private
 */
function armDiagnostics(arm) {
    for (const db of trackedConnections()) {
        if (arm) armDiagnosticsFor(db);
        else disarmDiagnosticsFor(db);
    }
}

/**
 * Delivers the spans already recorded but not yet dispatched, to every
 * current subscriber, synchronously.
 *
 * SQLite reports a finished statement's timing on the thread that ran it
 * — before that statement's own completion reaches JS — and the timing
 * crosses to the JS thread through a queue drained on a later loop turn,
 * so it arrives after the query it belongs to has resolved. Draining is
 * how a caller reads it at a known moment.
 *
 * @returns {void}
 * @private
 */
function flushQuerySpansNow() {
    for (const db of trackedConnections()) {
        if (!armedProfileListeners.has(db)) continue;
        try {
            /** @type {any} */ (db)._flushProfile();
        } catch {
            // A connection closing underneath the drain is not a failure
            // worth propagating out of a flush.
        }
    }
}

/**
 * Subscribes to query spans: every finished statement is published as
 * `{ sql, database, duration (bigint ns), durationMs }` on the
 * `@appthreat/sqlite3.query` diagnostics channel (and mirrored onto
 * node:sqlite's `sqlite.db.query` channel name, for APM-tool
 * compatibility). The underlying SQLITE_TRACE_PROFILE tracing is armed by
 * the first subscriber and disarmed when the last one goes — nothing runs
 * while nobody listens.
 *
 * **Delivery is asynchronous.** SQLite reports a statement's timing on
 * the thread that executed it, and the span reaches the JS thread through
 * a queue drained on a later event-loop turn — so immediately after
 * `await db.all(sql)` the span for that query has usually not been
 * delivered yet. Await a macrotask (`setImmediate`), or call
 * {@link sqlite3.flushQuerySpans} to deliver what is pending right now,
 * before asserting on or flushing collected spans. The unsubscribe
 * function returned here drains first, so nothing recorded before it is
 * lost.
 *
 * Returns the unsubscribe function. Connections opened while a
 * subscription is active publish their spans too.
 *
 * @param {(message: { sql: string, database: import('./sqlite3-binding.js').Database, duration: bigint, durationMs: number }) => void} onMessage
 *   the span consumer.
 * @returns {() => void} the unsubscribe function.
 * @since 9.1.0
 * @example
 * const unsubscribe = sqlite3.subscribeQueries(({ sql, durationMs }) =>
 *     console.log(sql, durationMs.toFixed(3)));
 * await db.all('SELECT 1');
 * sqlite3.flushQuerySpans(); // the span for that query is delivered now
 * unsubscribe();
 */
sqlite3.subscribeQueries = function subscribeQueries(onMessage) {
    if (typeof onMessage !== 'function') {
        throw new TypeError('subscribeQueries() requires a listener function');
    }
    diagnosticsChannelSubscribers.add(onMessage);
    armDiagnostics(true);
    return () => {
        // Drain before dropping the subscriber: the spans of queries it
        // already awaited are sitting in the queue, and disarming would
        // otherwise deliver them after it stopped listening.
        flushQuerySpansNow();
        diagnosticsChannelSubscribers.delete(onMessage);
        if (diagnosticsChannelSubscribers.size === 0) {
            armDiagnostics(false);
        }
    };
};

/**
 * Delivers every query span recorded but not yet dispatched,
 * synchronously, to the current subscribers and channels.
 *
 * Spans are inherently asynchronous (see {@link sqlite3.subscribeQueries}):
 * this is the drain point for code that must read them at a known moment
 * — a test asserting on the span of a query it just awaited, or a
 * shutdown path flushing to an APM sink. A no-op when nothing is
 * subscribed.
 *
 * @returns {void}
 * @since 9.1.0
 * @example
 * const spans = [];
 * const unsubscribe = sqlite3.subscribeQueries((s) => spans.push(s.sql));
 * await db.all('SELECT 1');
 * sqlite3.flushQuerySpans();
 * // spans now contains 'SELECT 1'
 * unsubscribe();
 */
sqlite3.flushQuerySpans = function flushQuerySpans() {
    flushQuerySpansNow();
};

/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} type
 * @param {...any} args
 * @returns {any}
 */
Database.prototype.addListener = Database.prototype.on = function (
    type,
    ...args
) {
    const val = /** @type {(...callArgs: any[]) => any} */ (
        EventEmitter.prototype.addListener
    ).call(this, type, ...args);
    if (supportedEvents.has(type)) {
        this.configure(
            /** @type {'trace' | 'profile' | 'change' | 'commit' | 'rollback' | 'wal'} */ (
                type
            ),
            true,
        );
    }
    return val;
};

/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} type
 * @param {...any} args
 * @returns {any}
 */
Database.prototype.removeListener = function (type, ...args) {
    const val = /** @type {(...callArgs: any[]) => any} */ (
        EventEmitter.prototype.removeListener
    ).call(this, type, ...args);
    if (supportedEvents.has(type) && !this.listenerCount(type)) {
        this.configure(
            /** @type {'trace' | 'profile' | 'change' | 'commit' | 'rollback' | 'wal'} */ (
                type
            ),
            false,
        );
    }
    return val;
};

/**
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} type
 * @param {...any} args
 * @returns {any}
 */
Database.prototype.removeAllListeners = function (type, ...args) {
    const val = /** @type {(...callArgs: any[]) => any} */ (
        EventEmitter.prototype.removeAllListeners
    ).call(this, type, ...args);
    if (supportedEvents.has(type)) {
        this.configure(
            /** @type {'trace' | 'profile' | 'change' | 'commit' | 'rollback' | 'wal'} */ (
                type
            ),
            false,
        );
    }
    return val;
};

/**
 * Enables long stack traces for every method: errors delivered to
 * callbacks (and promise rejections) carry the call site's stack,
 * filtered of driver frames.
 *
 * Irreversible for the process — once on, always on — and global: it
 * wraps the method cores, so every connection created afterwards is
 * traced too.
 *
 * @returns {sqlite3} the same namespace, for chaining.
 */
sqlite3.verbose = function () {
    if (!isVerbose) {
        // Dual-mode methods are traced at their callback cores and the
        // promise wrappers are then rebuilt around the traced cores, so a
        // promise rejection carries the same augmented stack as a callback
        // error. (Wrapping the dual-mode wrapper itself would see no
        // trailing function in promise mode and capture nothing.)
        retracePromiseApi(extendTrace);

        // prepare keeps its synchronous, non-dual contract; trace it on the
        // prototype as before.
        extendTrace(
            /** @type {Record<string, import('./trace.js').Traceable>} */ (
                /** @type {unknown} */ (Database.prototype)
            ),
            'prepare',
        );

        isVerbose = true;
    }
    return sqlite3;
};

// The worker-thread pool (Deliverable 09): opt-in, promise-only, and
// documented in lib/pool.js and docs/concurrency.md. A single Database
// remains the primary object; the pool is for moving all SQLite work
// off the main thread.
sqlite3.pool = pool;

// Promise API, async iteration, transactions and disposal — installed after
// every callback-mode method above is final.
installPromiseApi(sqlite3);

export default sqlite3;

export { Backup, Blob, Session, Statement } from './sqlite3-binding.js';
// Database is the v9 wrapper (lib/sqlite3.js) — a real subclass of the
// native class carrying the permission-model checks; the other classes
// pass through unchanged.
export { DatabaseClass as Database };
