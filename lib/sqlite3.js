import path from 'path';
import sqlite3 from './sqlite3-binding.js';
import { EventEmitter } from 'events';
import { extendTrace } from "./trace.js";

const { Database, Statement, Backup } = sqlite3;

function inherits(target, source) {
    Object.assign(target.prototype, source.prototype);
}

inherits(Database, EventEmitter);
inherits(Statement, EventEmitter);
inherits(Backup, EventEmitter);

function extractErrBack(args) {
    if (args.length > 0 && typeof args[args.length - 1] === 'function') {
        const callback = args[args.length - 1];
        return function(err) {
            if (err) callback(err);
        };
    }
    return undefined;
}

// Database#prepare stays uncached: the caller owns the returned statement.
Database.prototype.prepare = function(sql, ...args) {
    const statement = new Statement(this, sql, extractErrBack(args));
    return args.length ? statement.bind(...args) : statement;
};

// run/get/all/each/map reuse prepared statements when the caller enabled
// the cache with cacheStatements(). Under serialize() the cached path is
// bypassed: statement operations do not pass through the database queue,
// so strict FIFO ordering would be lost.
function cachedMethod(fn) {
    return function(sql, ...args) {
        const errBack = extractErrBack(args);

        // A cache hit skips the prepare, and statement operations never pass
        // through the database queue -- so while an exclusive operation
        // (exec/close/wait/loadExtension) is running or waiting, the cached
        // path would overtake it and run concurrently with it. Fall back to
        // the uncached path there: its prepare goes through
        // Database::Schedule and lands in the queue behind that operation.
        const cache = this._stmtCache;
        if (cache && !this._serialized && !this._closing && !this._queueBusy()) {
            let statement = cache.get(sql);
            if (statement !== undefined) {
                // Most recently used.
                cache.delete(sql);
                cache.set(sql, statement);
            }
            else {
                statement = new Statement(this, sql, function(err) {
                    if (!err) return;
                    // Failed to prepare: drop it so the next call retries.
                    cache.delete(sql);
                    if (errBack) errBack(err);
                    else statement.emit('error', err);
                });
                cache.set(sql, statement);
                if (cache.size > this._stmtCacheMax) {
                    const oldestSql = cache.keys().next().value;
                    const oldest = cache.get(oldestSql);
                    cache.delete(oldestSql);
                    oldest.finalize();
                }
            }
            return fn.call(this, statement, args, true);
        }

        const statement = new Statement(this, sql, errBack);
        return fn.call(this, statement, args, false);
    };
}

// Database#run(sql, [bind1, bind2, ...], [callback])
Database.prototype.run = cachedMethod(function(statement, params, cached) {
    statement.run(...params);
    if (!cached) statement.finalize();
    return this;
});

// Database#get(sql, [bind1, bind2, ...], [callback])
Database.prototype.get = cachedMethod(function(statement, params, cached) {
    statement.get(...params);
    if (!cached) statement.finalize();
    return this;
});

// Database#all(sql, [bind1, bind2, ...], [callback])
Database.prototype.all = cachedMethod(function(statement, params, cached) {
    statement.all(...params);
    if (!cached) statement.finalize();
    return this;
});

// Database#each(sql, [bind1, bind2, ...], [callback], [complete])
Database.prototype.each = cachedMethod(function(statement, params, cached) {
    statement.each(...params);
    if (!cached) statement.finalize();
    return this;
});

Database.prototype.map = cachedMethod(function(statement, params, cached) {
    statement.map(...params);
    if (!cached) statement.finalize();
    return this;
});

// Database#cacheStatements([maxEntries])
// Opt-in LRU cache of prepared statements for run/get/all/each/map.
// Defaults to 64 entries. Cached statements are finalized by close().
Database.prototype.cacheStatements = function(maxEntries) {
    if (!this._stmtCache) {
        this._stmtCache = new Map();
        this._stmtCacheMax = 64;
    }
    const max = parseInt(maxEntries, 10);
    if (max > 0) this._stmtCacheMax = max;
    while (this._stmtCache.size > this._stmtCacheMax) {
        const oldestSql = this._stmtCache.keys().next().value;
        const oldest = this._stmtCache.get(oldestSql);
        this._stmtCache.delete(oldestSql);
        oldest.finalize();
    }
    return this;
};

// Database#prepareSync(sql)
// Prepares synchronously on the main thread. Throws when the database is
// not fully idle. The returned statement also supports the getSync/
// runSync/allSync fast path.
Database.prototype.prepareSync = function(sql) {
    return new Statement(this, sql, undefined, true);
};

// Database#getSync(sql, [params...]) / runSync / allSync
// Execute synchronously, consulting (and filling) the statement cache when
// enabled. They throw when the database is not fully idle; no callback
// form exists. runSync returns { lastID, changes }.
Database.prototype.getSync = function(sql, ...params) {
    const entry = this._statementForSync(sql);
    try {
        return entry.statement.getSync(...params);
    } finally {
        if (entry.transient) entry.statement.finalize();
    }
};

Database.prototype.runSync = function(sql, ...params) {
    const entry = this._statementForSync(sql);
    try {
        entry.statement.runSync(...params);
        return { lastID: entry.statement.lastID,
                 changes: entry.statement.changes };
    } finally {
        if (entry.transient) entry.statement.finalize();
    }
};

Database.prototype.allSync = function(sql, ...params) {
    const entry = this._statementForSync(sql);
    try {
        return entry.statement.allSync(...params);
    } finally {
        if (entry.transient) entry.statement.finalize();
    }
};

// Returns { statement, transient }. Without the cache the statement is
// transient and the caller must finalize it: otherwise every sync call
// leaks a prepared statement and close() fails with SQLITE_BUSY.
Database.prototype._statementForSync = function(sql) {
    const cache = this._stmtCache;
    if (cache && !this._closing) {
        let statement = cache.get(sql);
        if (statement !== undefined) {
            cache.delete(sql);
            cache.set(sql, statement);
            return { statement: statement, transient: false };
        }
        statement = new Statement(this, sql, undefined, true);
        cache.set(sql, statement);
        if (cache.size > this._stmtCacheMax) {
            const oldestSql = cache.keys().next().value;
            const oldest = cache.get(oldestSql);
            cache.delete(oldestSql);
            oldest.finalize();
        }
        return { statement: statement, transient: false };
    }
    return {
        statement: new Statement(this, sql, undefined, true),
        transient: true
    };
};

// Mirror of the native serialize state so cachedMethod knows when the
// FIFO guarantee is in effect (the native flag itself is not readable).
const nativeSerialize = Database.prototype.serialize;
Database.prototype.serialize = function(callback) {
    const before = !!this._serialized;
    this._serialized = true;
    const result = nativeSerialize.call(this, callback);
    if (typeof callback === 'function') this._serialized = before;
    return result;
};

const nativeParallelize = Database.prototype.parallelize;
Database.prototype.parallelize = function(callback) {
    const before = !!this._serialized;
    this._serialized = false;
    const result = nativeParallelize.call(this, callback);
    if (typeof callback === 'function') this._serialized = before;
    return result;
};

// Database#close flushes the statement cache first: sqlite3_close fails
// with SQLITE_BUSY while prepared statements are outstanding.
const nativeClose = Database.prototype.close;
Database.prototype.close = function(...args) {
    const cache = this._stmtCache;
    if (cache && cache.size > 0 && !this._closing) {
        // Mark closing before draining: a finalize callback that issues a
        // database call must not repopulate the cache behind us.
        this._closing = true;
        for (const [sql, statement] of cache) {
            cache.delete(sql);
            statement.finalize();
        }
    }
    // Deliberately not deferred. close() is scheduled exclusively and
    // Work_BeginClose requires pending == 0, so the native queue already
    // makes it wait for the finalizes above (each either completes inline
    // when its statement is idle, or queues behind that statement's
    // in-flight work). Deferring the native call to a promise instead would
    // let operations issued after close() run before the close is even
    // requested.
    return nativeClose.apply(this, args);
};

sqlite3.cached = {
    Database: function(file, a, b) {
        if (file === '' || file === ':memory:') {
            // Don't cache special databases.
            return new Database(file, a, b);
        }

        let db;
        file = path.resolve(file);

        if (!sqlite3.cached.objects[file]) {
            db = sqlite3.cached.objects[file] = new Database(file, a, b);
        } else {
            // Make sure the callback is called.
            db = sqlite3.cached.objects[file];
            const callback = (typeof a === 'number') ? b : a;
            if (typeof callback === 'function') {
                const cb = () => callback.call(db, null);
                if (db.open) process.nextTick(cb);
                else db.once('open', cb);
            }
        }

        return db;
    },
    objects: {}
};

// Database#backup(filename, [callback])
// Database#backup(filename, destName, sourceName, filenameIsDest, [callback])
Database.prototype.backup = function(...args) {
    let backup;
    if (args.length <= 2) {
        backup = new Backup(this, args[0], 'main', 'main', true, args[1]);
    } else {
        backup = new Backup(this, args[0], args[1], args[2], args[3], args[4]);
    }
    // Per the sqlite docs, exclude the following errors as non-fatal by default.
    backup.retryErrors = [sqlite3.BUSY, sqlite3.LOCKED];
    return backup;
};

Statement.prototype.map = function(...params) {
    const callback = params.pop();
    params.push((err, rows) => {
        if (err) return callback(err);
        const result = {};
        if (rows && rows.length) {
            const keys = Object.keys(rows[0]);
            const key = keys[0];
            if (keys.length > 2) {
                // Value is an object
                for (let i = 0; i < rows.length; i++) {
                    result[rows[i][key]] = rows[i];
                }
            } else {
                const value = keys[1];
                // Value is a plain value
                for (let i = 0; i < rows.length; i++) {
                    result[rows[i][key]] = rows[i][value];
                }
            }
        }
        callback(err, result);
    });
    return this.all(...params);
};

let isVerbose = false;

const supportedEvents = new Set(['trace', 'profile', 'change']);

Database.prototype.addListener = Database.prototype.on = function(type, ...args) {
    const val = EventEmitter.prototype.addListener.call(this, type, ...args);
    if (supportedEvents.has(type)) {
        this.configure(type, true);
    }
    return val;
};

Database.prototype.removeListener = function(type, ...args) {
    const val = EventEmitter.prototype.removeListener.call(this, type, ...args);
    if (supportedEvents.has(type) && !this.listenerCount(type)) {
        this.configure(type, false);
    }
    return val;
};

Database.prototype.removeAllListeners = function(type, ...args) {
    const val = EventEmitter.prototype.removeAllListeners.call(this, type, ...args);
    if (supportedEvents.has(type)) {
        this.configure(type, false);
    }
    return val;
};

// Save the stack trace over EIO callbacks.
sqlite3.verbose = function() {
    if (!isVerbose) {
        [
            'prepare', 'get', 'run', 'all', 'each', 'map', 'close', 'exec'
        ].forEach((name) => extendTrace(Database.prototype, name));

        [
            'bind', 'get', 'run', 'all', 'each', 'map', 'reset', 'finalize'
        ].forEach((name) => extendTrace(Statement.prototype, name));

        isVerbose = true;
    }
    return sqlite3;
};

export default sqlite3;
export { Database, Statement, Backup };