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

import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

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
        keys.every((key) => key === 'mode' || key === 'untrusted')
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
        if (b !== undefined && b !== null) {
            if (typeof b === 'function') {
                callback = b;
            } else if (isOpenOptions(b)) {
                const opts = /** @type {OpenOptions} */ (b);
                if (opts.mode !== undefined && mode === undefined) {
                    mode = opts.mode;
                }
                if (opts.untrusted === true) untrusted = true;
            }
        }
        assertOpenPermitted(filename, mode);
        super(
            filename,
            ...(mode !== undefined ? [mode] : []),
            ...(callback !== undefined ? [callback] : []),
        );
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

// Captured before the promise API wraps Statement#bind: prepare()'s
// no-callback form must keep returning the statement synchronously, and a
// dual-mode bind would hand back a promise instead.
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
    if (options !== undefined && options !== null) {
        if (typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('applyChangeset() options must be an object');
        }
        const known = new Set(['conflict', 'onConflict', 'filter']);
        for (const key of Object.keys(options)) {
            if (!known.has(key)) {
                throw new TypeError(
                    `applyChangeset() received unknown option '${key}'`,
                );
            }
        }
        onConflict = options.conflict ?? options.onConflict;
        onFilter = options.filter;
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
// It also keeps its synchronous return in every form (see the promise API
// notes in lib/promises.js): `await db.prepare(sql)` still yields the
// statement, but a prepare error surfaces on its error event rather than
// as a rejection.
/**
 * Prepares a statement for the caller to own.
 *
 * Always returns the statement synchronously, even in the callback form
 * (`await db.prepare(sql)` yields the statement): a prepare failure
 * surfaces on the statement's `'error'` event instead of a rejection, and
 * a bind failure throws synchronously after finalizing the orphan.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL statement to prepare.
 * @param {...unknown} args bind parameters, then optionally a callback.
 * @returns {import('./sqlite3-binding.js').Statement} the prepared statement.
 */
Database.prototype.prepare = function (sql, ...args) {
    const statement = new Statement(this, sql, extractErrBack(args));
    associateStatement(this, statement);
    if (!args.length) return statement;
    try {
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
                    if (errBack) errBack(err);
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

        const statement = new Statement(this, sql, errBack);
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
 * Prepares synchronously on the main thread.
 *
 * Throws when the database is not fully idle. The returned statement
 * also supports the getSync/runSync/allSync fast path.
 *
 * @this {import('./sqlite3-binding.js').Database}
 * @param {string} sql the SQL statement to prepare.
 * @returns {import('./sqlite3-binding.js').Statement} the prepared statement.
 * @throws {Error} When the database is not fully idle.
 */
Database.prototype.prepareSync = function (sql) {
    return new Statement(this, sql, undefined, true);
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
    this._drainStatementCache();
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
 * collation cannot report an error mid-comparison.
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
