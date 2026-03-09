import path from 'path';
import sqlite3 from './sqlite3-binding.js';
import { EventEmitter } from 'events';
import { extendTrace } from "./trace.js";

function normalizeMethod(fn) {
    return function(sql, ...args) {
        let errBack;

        if (args.length > 0 && typeof args[args.length - 1] === 'function') {
            const callback = args[args.length - 1];
            errBack = function(err) {
                if (err) callback(err);
            };
        }

        const statement = new Statement(this, sql, errBack);
        return fn.call(this, statement, args);
    };
}

function inherits(target, source) {
    Object.assign(target.prototype, source.prototype);
}

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

const { Database, Statement, Backup } = sqlite3;

inherits(Database, EventEmitter);
inherits(Statement, EventEmitter);
inherits(Backup, EventEmitter);

// Database#prepare(sql, [bind1, bind2, ...], [callback])
Database.prototype.prepare = normalizeMethod(function(statement, params) {
    return params.length ? statement.bind(...params) : statement;
});

// Database#run(sql, [bind1, bind2, ...], [callback])
Database.prototype.run = normalizeMethod(function(statement, params) {
    statement.run(...params).finalize();
    return this;
});

// Database#get(sql, [bind1, bind2, ...], [callback])
Database.prototype.get = normalizeMethod(function(statement, params) {
    statement.get(...params).finalize();
    return this;
});

// Database#all(sql, [bind1, bind2, ...], [callback])
Database.prototype.all = normalizeMethod(function(statement, params) {
    statement.all(...params).finalize();
    return this;
});

// Database#each(sql, [bind1, bind2, ...], [callback], [complete])
Database.prototype.each = normalizeMethod(function(statement, params) {
    statement.each(...params).finalize();
    return this;
});

Database.prototype.map = normalizeMethod(function(statement, params) {
    statement.map(...params).finalize();
    return this;
});

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