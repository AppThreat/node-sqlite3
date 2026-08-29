import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';

// Deliverable 02: extended result codes. Every error carries
// err.code (the extended name), err.errno (the extended integer) and
// err.primaryCode (the primary name) — the documented migration for
// code that matched bare 'SQLITE_CONSTRAINT' etc. in v8.
describe('extended result codes', function () {
    function setup(db, cb) {
        db.exec(
            `
            CREATE TABLE uniq (x INTEGER UNIQUE);
            CREATE TABLE strict (x INTEGER NOT NULL);
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (pid INTEGER REFERENCES parent (id));
            PRAGMA foreign_keys = ON;
        `,
            cb,
        );
    }

    it('reports UNIQUE violations as SQLITE_CONSTRAINT_UNIQUE', async function () {
        const db = new sqlite3.Database(':memory:');
        await new Promise((resolve) => setup(db, resolve));
        try {
            db.runSync('INSERT INTO uniq VALUES (1)');
            assert.throws(
                () => db.runSync('INSERT INTO uniq VALUES (1)'),
                (err) =>
                    err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
                    err.primaryCode === 'SQLITE_CONSTRAINT' &&
                    err.errno === sqlite3.CONSTRAINT_UNIQUE &&
                    /UNIQUE constraint failed/.test(err.message),
            );
            const err = await new Promise((resolve) =>
                db.run('INSERT INTO uniq VALUES (1)', (e) => resolve(e)),
            );
            assert.strictEqual(err.code, 'SQLITE_CONSTRAINT_UNIQUE');
            assert.strictEqual(err.primaryCode, 'SQLITE_CONSTRAINT');
            assert.strictEqual(err.errno, sqlite3.CONSTRAINT_UNIQUE);
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });

    it('reports NOT NULL violations as SQLITE_CONSTRAINT_NOTNULL', async function () {
        const db = new sqlite3.Database(':memory:');
        await new Promise((resolve) => setup(db, resolve));
        try {
            const err = await new Promise((resolve) =>
                db.run('INSERT INTO strict VALUES (NULL)', (e) => resolve(e)),
            );
            assert.strictEqual(err.code, 'SQLITE_CONSTRAINT_NOTNULL');
            assert.strictEqual(err.primaryCode, 'SQLITE_CONSTRAINT');
            assert.strictEqual(err.errno, sqlite3.CONSTRAINT_NOTNULL);
            assert.throws(
                () => db.runSync('INSERT INTO strict VALUES (NULL)'),
                (e) => e.code === 'SQLITE_CONSTRAINT_NOTNULL',
            );
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });

    it('reports FOREIGN KEY violations as SQLITE_CONSTRAINT_FOREIGNKEY', async function () {
        const db = new sqlite3.Database(':memory:');
        await new Promise((resolve) => setup(db, resolve));
        try {
            const err = await new Promise((resolve) =>
                db.run('INSERT INTO child VALUES (42)', (e) => resolve(e)),
            );
            assert.strictEqual(err.code, 'SQLITE_CONSTRAINT_FOREIGNKEY');
            assert.strictEqual(err.primaryCode, 'SQLITE_CONSTRAINT');
            assert.strictEqual(err.errno, sqlite3.CONSTRAINT_FOREIGNKEY);
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });

    it('keeps primary codes primary (no fabricated extensions)', async function () {
        const db = new sqlite3.Database(':memory:');
        await new Promise((resolve) => db.exec('SELECT 1', resolve));
        try {
            const err = await new Promise((resolve) =>
                db.run('SELECT * FROM missing_table', (e) => resolve(e)),
            );
            assert.strictEqual(err.code, 'SQLITE_ERROR');
            assert.strictEqual(err.primaryCode, 'SQLITE_ERROR');
            assert.strictEqual(err.errno, sqlite3.ERROR);
        } finally {
            await new Promise((resolve) => db.close(resolve));
        }
    });

    it('exports the extended constant families', function () {
        // Spot checks against the documented numeric values.
        assert.strictEqual(sqlite3.CONSTRAINT_CHECK, 275);
        assert.strictEqual(sqlite3.CONSTRAINT_UNIQUE, 2067);
        assert.strictEqual(sqlite3.CONSTRAINT_FOREIGNKEY, 787);
        assert.strictEqual(sqlite3.CONSTRAINT_NOTNULL, 1299);
        assert.strictEqual(sqlite3.CONSTRAINT_PRIMARYKEY, 1555);
        assert.strictEqual(sqlite3.CONSTRAINT_ROWID, 2579);
        assert.strictEqual(sqlite3.CONSTRAINT_DATATYPE, 3091);
        assert.strictEqual(sqlite3.BUSY_RECOVERY, 261);
        assert.strictEqual(sqlite3.BUSY_SNAPSHOT, 517);
        assert.strictEqual(sqlite3.BUSY_TIMEOUT, 773);
        assert.strictEqual(sqlite3.READONLY_ROLLBACK, 776);
        assert.strictEqual(sqlite3.READONLY_DIRECTORY, 1544);
        assert.strictEqual(sqlite3.IOERR_READ, 266);
        assert.strictEqual(sqlite3.IOERR_IN_PAGE, 8714);
        assert.strictEqual(sqlite3.CANTOPEN_NOTEMPDIR, 270);
        assert.strictEqual(sqlite3.CANTOPEN_SYMLINK, 1550);
        assert.strictEqual(sqlite3.LOCKED_SHAREDCACHE, 262);
        assert.strictEqual(sqlite3.CORRUPT_INDEX, 779);
        assert.strictEqual(sqlite3.ABORT_ROLLBACK, 516);
        assert.strictEqual(sqlite3.AUTH_USER, 279);
        assert.strictEqual(sqlite3.ERROR_SNAPSHOT, 769);
    });

    it('exports the previously missing open flags', function () {
        assert.strictEqual(sqlite3.OPEN_NOMUTEX, 0x00008000);
        assert.strictEqual(sqlite3.OPEN_MEMORY, 0x00000080);
        assert.strictEqual(sqlite3.OPEN_EXRESCODE, 0x02000000);
    });

    it('opens an in-memory database via OPEN_MEMORY', async function () {
        // The name is a real path, so this proves the MEMORY flag (and
        // doubles as a guard against flag-value regressions: a wrong
        // value would create the file).
        const file = fileURLToPath(
            new URL('../tmp/err-ext-open-memory.db', import.meta.url),
        );
        rmSync(file, { force: true });
        const db = new sqlite3.Database(
            file,
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_MEMORY,
        );
        try {
            await new Promise((resolve, reject) =>
                db.exec('CREATE TABLE t (a)', (err) =>
                    err ? reject(err) : resolve(),
                ),
            );
            db.runSync('INSERT INTO t VALUES (1)');
            assert.strictEqual(db.getSync('SELECT a FROM t').a, 1);
        } finally {
            await new Promise((resolve) => db.close(resolve));
            rmSync(file, { force: true });
        }
    });
});
