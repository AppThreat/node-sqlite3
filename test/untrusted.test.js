// Untrusted database files (Deliverable 11 §2.3): the `untrusted: true`
// open option applies the hostile-file hardening recipe — defensive mode,
// untrusted schema, writable_schema off, extension loading permanently
// disabled, conservative run-time limits and a deny-all ATTACH gate — and
// the fixture below exercises each switch the way a hostile file would.

import assert from 'node:assert';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

const dir = join(import.meta.dirname, 'tmp');
const hostile = join(dir, `untrusted-hostile-${process.pid}.db`);
const malformed = join(dir, `untrusted-malformed-${process.pid}.db`);

/**
 * Builds a fresh one-table fixture with a trusted connection.
 *
 * @param {string} file where to write it.
 * @returns {Promise<void>} resolves once written and closed.
 */
async function makeFixture(file) {
    rmSync(file, { force: true });
    const plan = await sqlite3.open(file, {
        mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    });
    await plan.exec('CREATE TABLE innocent (x)');
    await plan.close();
}

before(async function () {
    mkdirSync(dir, { recursive: true });
    await makeFixture(hostile);
    // Not a database at all.
    const junk = Buffer.alloc(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 31) & 0xff;
    writeFileSync(malformed, junk);
});

after(function () {
    rmSync(hostile, { force: true });
    rmSync(malformed, { force: true });
    rmSync(join(dir, `untrusted-tamper-plain-${process.pid}.db`), {
        force: true,
    });
    rmSync(join(dir, `untrusted-tamper-careful-${process.pid}.db`), {
        force: true,
    });
});

describe('untrusted database files', function () {
    it('opens the file read-only and reads fine', async function () {
        const db = await sqlite3.open(hostile, {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        const row = await db.get('SELECT count(*) AS n FROM innocent');
        assert.strictEqual(row.n, 0);
        await db.close();
    });

    it('applies the hardening switches', async function () {
        const db = await sqlite3.open(hostile, {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        assert.strictEqual(
            await db.dbConfig(sqlite3.DBCONFIG_DEFENSIVE),
            true,
            'defensive mode is on',
        );
        assert.strictEqual(
            await db.dbConfig(sqlite3.DBCONFIG_TRUSTED_SCHEMA),
            false,
            'the schema is not trusted',
        );
        assert.strictEqual(
            await db.dbConfig(sqlite3.DBCONFIG_WRITABLE_SCHEMA),
            false,
            'writable_schema is off',
        );
        await db.close();
    });

    it('refuses the schema tamper a plain connection allows', async function () {
        const tamper =
            "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql='CREATE TABLE evil (pwned)' WHERE name='innocent'";
        // The plain connection is the control: without the hardening the
        // rewrite goes through (this is the classic hostile-file lever).
        // It gets its own fixture because a successful tamper leaves the
        // schema genuinely inconsistent — that corruption is the point.
        const plainFile = join(dir, `untrusted-tamper-plain-${process.pid}.db`);
        await makeFixture(plainFile);
        const plain = await sqlite3.open(plainFile, {
            mode: sqlite3.OPEN_READWRITE,
        });
        await assert.doesNotReject(
            plain.exec(tamper),
            'control: a plain connection must allow the tamper for this contrast to mean anything',
        );
        await plain.close();

        const carefulFile = join(
            dir,
            `untrusted-tamper-careful-${process.pid}.db`,
        );
        await makeFixture(carefulFile);
        const careful = await sqlite3.open(carefulFile, {
            mode: sqlite3.OPEN_READWRITE,
            untrusted: true,
        });
        // The untrusted connection refuses (writable_schema DBCONFIG 0
        // turns the PRAGMA into a no-op, so the update hits sqlite's
        // hard protection of sqlite_master).
        await assert.rejects(careful.exec(tamper), (err) =>
            /may not be modified|readonly database/.test(
                /** @type {Error} */ (err).message,
            ),
        );
        // And the schema really is untouched.
        const row = await careful.get(
            "SELECT count(*) AS n FROM sqlite_master WHERE name='evil'",
        );
        assert.strictEqual(row.n, 0);
        await careful.close();
    });

    it('denies ATTACH and VACUUM INTO', async function () {
        const db = await sqlite3.open(hostile, {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        await assert.rejects(
            db.exec("ATTACH ':memory:' AS m"),
            (err) =>
                /** @type {Error & { code?: string }} */ (
                    err.code === 'SQLITE_ERROR' ||
                        /** @type {Error & { code?: string }} */ (err).code ===
                            'SQLITE_AUTH'
                ) &&
                /too many attached databases|not authorized/.test(
                    /** @type {Error} */ (err).message,
                ),
        );
        await assert.rejects(
            db.exec(`VACUUM INTO '${join(dir, 'untrusted-vac.db')}'`),
            (err) =>
                /too many attached databases|not authorized|authorization denied|readonly/.test(
                    /** @type {Error} */ (err).message,
                ),
        );
        await db.close();
        rmSync(join(dir, 'untrusted-vac.db'), { force: true });
    });

    it('permanently disables extension loading', async function () {
        const db = await sqlite3.open(hostile, {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        await assert.rejects(db.loadExtension('/nonexistent.ext'), (err) =>
            /untrusted|permanently disabled/.test(
                /** @type {Error} */ (err).message,
            ),
        );
        // And it cannot be re-enabled from SQL either: load_extension()
        // is not authorized on the vendored SQLite (observed default).
        await assert.rejects(
            db.exec("SELECT load_extension('/nonexistent.ext')"),
            (err) => /not authorized/.test(/** @type {Error} */ (err).message),
        );
        // configure('attachPaths') is refused too: the deny-all gate is
        // part of the hardening, not a starting point.
        assert.throws(
            () => db.configure('attachPaths', ['/tmp/x.db']),
            /untrusted connections cannot allow ATTACH/,
        );
        assert.throws(
            () =>
                db.configure('extensionPolicy', {
                    allow: ['/tmp/x.ext'],
                }),
            /permanently disabled/,
        );
        await db.close();
    });

    it('applies conservative run-time limits', async function () {
        const db = await sqlite3.open(hostile, {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        // 200-deep arithmetic nesting: over the EXPR_DEPTH ceiling of 100.
        const deep = `SELECT ${'1+('.repeat(200)}1${')'.repeat(200)}`;
        await assert.rejects(db.exec(deep), (err) =>
            /Expression tree is too large/.test(
                /** @type {Error} */ (err).message,
            ),
        );
        // Compound SELECT beyond the ceiling.
        const union = `SELECT 1 ${'UNION ALL SELECT 1 '.repeat(600)}`;
        await assert.rejects(db.exec(union), (err) =>
            /too many terms in compound SELECT/.test(
                /** @type {Error} */ (err).message,
            ),
        );
        // Normal queries are unaffected.
        assert.strictEqual((await db.get('SELECT 41+1 AS v')).v, 42);
        await db.close();
    });

    it('a malformed file errors gracefully, without crashing', async function () {
        const db = await sqlite3.open(malformed, {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        // The open of a non-database file succeeds lazily; the read is
        // what reports NOTADB — an error, never a crash.
        await assert.rejects(
            db.get('SELECT count(*) AS n FROM sqlite_master'),
            (err) =>
                /** @type {Error & { code?: string }} */ (err).code ===
                'SQLITE_NOTADB',
        );
        await db.close();
    });

    it('validates the option shape', function () {
        assert.throws(
            () =>
                new sqlite3.Database(':memory:', {
                    untrusted: 'yes',
                }),
            /untrusted.*must be a boolean/,
        );
        assert.throws(
            () =>
                new sqlite3.Database(':memory:', {
                    mode: 'rw',
                }),
            /mode.*must be a number/,
        );
        assert.throws(
            () => new sqlite3.Database(':memory:', 'nonsense'),
            /expects a mode number, an options object or a callback/,
        );
    });

    it('the constructor form accepts options in either slot', async function () {
        // (filename, options) and (filename, mode, options) — the latter
        // is what sqlite3.open produces internally.
        const a = new sqlite3.Database(hostile, {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        await a.close();
        const b = new sqlite3.Database(hostile, sqlite3.OPEN_READONLY, {
            untrusted: true,
        });
        await b.close();
    });
});

// The ATTACH gate matches target filenames lexically, and two of its
// early spellings-based shortcuts were fail-*open*: each let an ATTACH
// create a real file outside the permission-checked allowlist. Both are
// pinned here because the failure is silent — the ATTACH succeeds and the
// file simply appears.
describe('ATTACH gate spelling rules', function () {
    const probe = join(dir, `gate-probe-${process.pid}`);

    before(function () {
        rmSync(probe, { force: true, recursive: true });
        mkdirSync(probe, { recursive: true });
    });
    after(function () {
        rmSync(probe, { force: true, recursive: true });
    });

    /**
     * Opens a gated connection whose allowlist holds exactly one path.
     *
     * @param {string} allowed the single permitted ATTACH target.
     * @param {number} [mode] open flags; defaults to in-memory read/write.
     * @returns {Promise<import('../lib/sqlite3.js').Database>} the connection.
     */
    async function gated(allowed, mode) {
        const db = await sqlite3.open(':memory:', {
            mode: mode ?? sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
        });
        db.configure('attachPaths', [allowed]);
        return db;
    }

    it('denies URI memory spellings on a connection without OPEN_URI', async function () {
        // Without SQLITE_OPEN_URI (the default) SQLite reads 'file:…' as
        // an ordinary *filename*, so treating these as in-memory admitted
        // a real file: ATTACH 'file::memory:' created a file of that
        // literal name in the process cwd, outside the allowlist.
        const db = await gated(join(probe, 'allowed.db'));
        for (const target of ['file::memory:', 'file:x.db?mode=memory']) {
            await assert.rejects(
                db.exec(`ATTACH DATABASE '${target}' AS z`),
                (err) =>
                    /** @type {Error & { code?: string }} */ (err).code ===
                    'SQLITE_AUTH',
                `${target} must be denied without OPEN_URI`,
            );
        }
        await db.close();
    });

    it('allows URI memory spellings when the connection did open with OPEN_URI', async function () {
        // There they really are in-memory, so denying them would be a
        // gratuitous narrowing rather than a safety property.
        const db = await gated(
            join(probe, 'allowed.db'),
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_URI,
        );
        for (const target of ['file::memory:', 'file:x.db?mode=memory']) {
            await db.exec(`ATTACH DATABASE '${target}' AS z; DETACH z`);
        }
        await db.close();
    });

    it('does not treat a backslash as a separator on POSIX', async function () {
        // 'dir\x.db' and 'dir/x.db' are two different files on POSIX, and
        // only the latter was permission-checked. Normalising separators
        // here (correct on Windows) widened the allowlist to a file that
        // was never checked, and the ATTACH created it.
        if (process.platform === 'win32') return;
        const db = await gated(join(probe, 'sub', 'ok.db'));
        await assert.rejects(
            db.exec(`ATTACH DATABASE '${join(probe, 'sub')}\\ok.db' AS z`),
            (err) =>
                /** @type {Error & { code?: string }} */ (err).code ===
                'SQLITE_AUTH',
        );
        assert.deepStrictEqual(readdirSync(probe), []);
        await db.close();
    });
});
