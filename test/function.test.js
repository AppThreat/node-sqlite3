import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';
import { bindableValues } from './support/corpus.js';

// User-defined scalar functions (Deliverable 06): registration, the
// REGEXP operator, marshalling through the shared D02 converter, the
// threading model (worker round trip, sync-path refusal), directOnly's
// security default, replacement/cache interactions, and teardown safety.

describe('user-defined functions', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await new Promise((resolve, reject) => {
            db.once('open', resolve);
            db.once('error', reject);
        });
        await db.exec(
            'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);\n' +
                "INSERT INTO t (name) VALUES ('apple'), ('banana'), ('cherry'), ('apricot')",
        );
    });

    afterEach(async function () {
        await db.close();
    });

    it('supports the REGEXP operator end-to-end', async function () {
        db.function('regexp', { deterministic: true }, (pattern, value) =>
            new RegExp(pattern).test(value) ? 1 : 0,
        );
        const rows = await db.all("SELECT name FROM t WHERE name REGEXP '^a'");
        assert.deepStrictEqual(
            rows.map((r) => r.name),
            ['apple', 'apricot'],
        );
    });

    it('registers zero-arity, fixed-arity and varargs functions', async function () {
        db.function('answer', () => 42);
        assert.strictEqual((await db.get('SELECT answer() AS v')).v, 42);

        db.function('plus', (a, b) => a + b);
        assert.strictEqual((await db.get('SELECT plus(2, 3) AS v')).v, 5);
        await assert.rejects(
            db.get('SELECT plus(1) AS v'),
            /wrong number of arguments/i,
        );
        await assert.rejects(
            db.get('SELECT plus(1, 2, 3) AS v'),
            /wrong number of arguments/i,
        );

        let seen = null;
        db.function('collect', { varargs: true }, (...args) => {
            seen = args;
            return args.length;
        });
        assert.strictEqual(
            (await db.get("SELECT collect(1, 'two', 3.5) AS v")).v,
            3,
        );
        assert.deepStrictEqual(seen, [1, 'two', 3.5]);
    });

    it('uses a rest-parameter implementation only with varargs', async function () {
        // fn.length is 0 for rest-parameter functions, so without varargs
        // this registers as a 0-arity function and calls with arguments
        // are arity errors — the documented reason to pass varargs.
        db.function('quiet', (...args) => args.length);
        await assert.rejects(
            db.get('SELECT quiet(1) AS v'),
            /wrong number of arguments/i,
        );
        assert.strictEqual((await db.get('SELECT quiet() AS v')).v, 0);
    });

    it('marshals every corpus value through arguments and return values', async function () {
        // The argument direction and the return direction must agree with
        // each other and with the corpus's expected storage class. 'mixed'
        // mode keeps the int64-boundary entries readable instead of
        // throwing, which the dedicated integer-mode test covers.
        db.configure('integerMode', 'mixed');
        /** @type {unknown[]} */
        const received = [];
        db.function('echo', { varargs: true, directOnly: false }, (v) => {
            received.push(v);
            return v;
        });
        const integerTypes = ['number', 'bigint'];
        for (const entry of bindableValues) {
            const roundtrip = await db.get('SELECT echo(?) AS v', entry.value);
            const arg = received.pop();
            assert.ok(
                equivalent(arg, roundtrip.v),
                `argument for ${entry.label}: ${show(arg)} vs return ${show(roundtrip.v)}`,
            );
            switch (entry.sqliteType) {
                case 'INTEGER':
                    assert.ok(
                        integerTypes.includes(typeof roundtrip.v),
                        `${entry.label}: expected integer, got ${show(roundtrip.v)}`,
                    );
                    break;
                case 'REAL':
                    assert.strictEqual(typeof roundtrip.v, 'number');
                    break;
                case 'TEXT':
                    assert.strictEqual(typeof roundtrip.v, 'string');
                    break;
                case 'BLOB':
                    assert.ok(roundtrip.v instanceof Uint8Array);
                    break;
                case 'NULL':
                    assert.strictEqual(roundtrip.v, null);
                    break;
                default:
                    assert.fail(`unknown sqliteType ${entry.sqliteType}`);
            }
        }
    });

    it('rejects unsupported return values instead of coercing them', async function () {
        db.function('obj', () => ({ nope: true }));
        await assert.rejects(
            db.get('SELECT obj() AS v'),
            (err) =>
                /the return value of function 'obj'/.test(err.message) &&
                /unsupported type/.test(err.message) &&
                err.code === 'SQLITE_ERROR',
        );
    });

    it('rejects out-of-range BigInt return values', async function () {
        db.function('huge', () => 2n ** 64n);
        await assert.rejects(
            db.get('SELECT huge() AS v'),
            /BigInt 18446744073709551616 is outside the signed 64-bit/,
        );
    });

    it('surfaces a thrown error as a SQLite error with cause, and leaves the db usable', async function () {
        const boom = new Error('kapow');
        db.function('boom', (_x) => {
            throw boom;
        });
        await assert.rejects(db.all('SELECT id, boom(name) FROM t'), (err) => {
            assert.strictEqual(err.code, 'SQLITE_ERROR');
            assert.match(
                err.message,
                /user-defined function 'boom' threw: kapow/,
            );
            // The original JS error rides along as cause.
            assert.strictEqual(err.cause, boom);
            return true;
        });
        // The CallGuard lesson from D05: a throwing callback must not
        // wedge the connection.
        assert.strictEqual(db.getSync('SELECT 1 AS v').v, 1);
    });

    it('applies the integer mode to INTEGER arguments', async function () {
        await db.exec(
            'CREATE TABLE big (x INTEGER);\n' +
                'INSERT INTO big VALUES (9007199254740993)',
        );
        db.configure('integerMode', 'bigint');
        let arg = null;
        db.function('peek', (v) => {
            arg = v;
            return 0;
        });
        await db.get('SELECT peek(x) AS v FROM big');
        assert.strictEqual(arg, 9007199254740993n);

        db.configure('integerMode', 'number');
        await assert.rejects(
            db.get('SELECT peek(x) AS v FROM big'),
            (err) =>
                /argument 1 of function 'peek'/.test(err.message) &&
                /outside the safe integer range/.test(err.message),
        );
        db.configure('integerMode', 'number');
    });

    it('refuses invocation from the sync methods instead of deadlocking', {
        timeout: 5000,
    }, async function () {
        db.function('nope', () => 1);
        for (const sql of ['SELECT nope()', 'SELECT nope() FROM t']) {
            assert.throws(
                () => db.getSync(sql),
                (err) =>
                    /cannot be invoked from a\s+synchronous method/.test(
                        err.message,
                    ) &&
                    /deadlock/.test(err.message) &&
                    /getSync\/runSync\/allSync/.test(err.message),
            );
            assert.throws(() => db.runSync(sql));
            assert.throws(() => db.allSync(sql));
        }
        // prepareSync statements refuse at step time too.
        const stmt = db.prepareSync('SELECT nope()');
        assert.throws(() => stmt.getSync(), /deadlock/);
        stmt.finalize();
        // And the connection is fine afterwards.
        assert.strictEqual(db.getSync('SELECT 7 AS v').v, 7);
    });

    it('keeps the sync methods working for functions they never call', function () {
        db.function('unused', () => 1);
        assert.strictEqual(db.getSync('SELECT 5 AS v').v, 5);
    });

    it('defaults to directOnly: schema SQL cannot even be installed', async function () {
        db.function('guarded', () => 1);
        // The DDL itself is refused: attacker-supplied schema SQL cannot
        // wire a JS callback into a CHECK constraint.
        await assert.rejects(
            db.exec('CREATE TABLE g (x INTEGER CHECK (guarded() = 1))'),
            /unsafe use of guarded/,
        );
        // Explicit opt-out allows it, including at INSERT time.
        db.function('openfn', { directOnly: false }, () => 1);
        await db.exec('CREATE TABLE g2 (x INTEGER CHECK (openfn() = 1))');
        await db.run('INSERT INTO g2 VALUES (1)');
        assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM g2')).n, 1);
    });

    it('allows deterministic functions in a partial index with directOnly: false', async function () {
        db.function('cheap', { deterministic: true, directOnly: false }, (x) =>
            x < 10 ? 1 : 0,
        );
        await db.exec('CREATE INDEX partial ON t (id) WHERE cheap(id) = 1');
        const used = await db.all(
            'EXPLAIN QUERY PLAN SELECT id FROM t WHERE cheap(id) = 1',
        );
        assert.match(
            used.map((r) => Object.values(r).join(' ')).join(' '),
            /USING (COVERING )?INDEX partial/,
        );
    });

    it('replaces an existing registration and flushes the statement cache', async function () {
        db.cacheStatements();
        db.function('v', () => 'old');
        assert.strictEqual((await db.get('SELECT v() AS v')).v, 'old');
        // The cached statement was compiled against the old
        // implementation; the re-registration must flush it.
        db.function('v', () => 'new');
        assert.strictEqual((await db.get('SELECT v() AS v')).v, 'new');
        db.removeFunction('v');
        await assert.rejects(db.get('SELECT v() AS v'), /no such function: v/);
        // Removing an unknown name is a no-op.
        db.removeFunction('never-registered');
    });

    it('reports SQLITE_BUSY on replacement while a cursor is suspended', async function () {
        db.function('v', () => 'one');
        const stmt = db.prepare('SELECT id, v() FROM t');
        const first = await new Promise((resolve, reject) => {
            stmt.get((err, row) => (err ? reject(err) : resolve(row)));
        });
        assert.ok(first);
        // (the cursor is now suspended after its first row)
        // The cursor is suspended mid-result: sqlite counts it as an
        // active VM and refuses the replacement.
        const reported = new Promise((resolve) => db.once('error', resolve));
        db.function('v', () => 'two');
        const err = await reported;
        assert.strictEqual(err.code, 'SQLITE_BUSY');
        await stmt.finalize();
        // With the cursor gone the replacement goes through.
        db.function('v', () => 'two');
        assert.strictEqual((await db.get('SELECT v() AS v')).v, 'two');
    });

    it('runs the same function concurrently from parallelized statements', {
        timeout: 10000,
    }, async function () {
        let calls = 0;
        db.function('tick', () => {
            calls++;
            return 1;
        });
        // parallelize() invokes the body synchronously and restores the
        // mode when it returns, so the concurrency itself is awaited via
        // the captured promise.
        const inParallel = new Promise((resolve, reject) => {
            db.parallelize(async () => {
                try {
                    const results = await Promise.all([
                        db.all('SELECT tick() AS v FROM t'),
                        db.all("SELECT tick() AS v FROM t WHERE name LIKE '%'"),
                    ]);
                    resolve(results);
                } catch (err) {
                    reject(err);
                }
            });
        });
        const results = await inParallel;
        assert.strictEqual(results[0].length, 4);
        assert.strictEqual(results[1].length, 4);
        assert.strictEqual(calls, 8);
    });

    it('invokes functions from each() and iterate()', async function () {
        let eachCount = 0;
        db.function('idfn', (x) => x);
        await new Promise((resolve, reject) => {
            db.each(
                'SELECT idfn(id) AS v FROM t',
                (err) => {
                    if (err) reject(err);
                    else eachCount++;
                },
                (err) => (err ? reject(err) : resolve()),
            );
        });
        assert.strictEqual(eachCount, 4);

        let iterated = 0;
        for await (const row of db.iterate('SELECT idfn(id) AS v FROM t')) {
            assert.ok(row.v > 0);
            iterated++;
        }
        assert.strictEqual(iterated, 4);
    });

    it('validates names, options and implementations', function () {
        assert.throws(() => db.function(''), /non-empty name/);
        assert.throws(() => db.function(42, () => 1), /non-empty name/);
        assert.throws(() => db.function('f'), /implementation function/);
        assert.throws(
            () => db.function('f', { nope: true }, () => 1),
            /unknown option 'nope'/,
        );
        assert.throws(
            () => db.function('f', { deterministic: 'yes' }, () => 1),
            /'deterministic' must be a boolean/,
        );
        const arrow128 = (...args) => args.length;
        Object.defineProperty(arrow128, 'length', { value: 128 });
        assert.throws(
            () => db.function('f', arrow128),
            /128 exceeds SQLite's 127-argument limit/,
        );
        assert.throws(() => db.removeFunction(''), /non-empty name/);
    });

    it('chains: registration returns the database', function () {
        const returned = db.function('chainme', () => 1);
        assert.strictEqual(returned, db);
    });

    it('exits cleanly with a registered function and no close (child process)', {
        timeout: 15000,
    }, async function () {
        // A ThreadSafeFunction that kept its event-loop reference would
        // hang this child forever.
        const child = execFile(
            process.execPath,
            [
                fileURLToPath(
                    new URL(
                        './support/function_exit_child.mjs',
                        import.meta.url,
                    ),
                ),
            ],
            { cwd: process.cwd() },
        );
        let stdout = '';
        child.stdout?.on('data', (c) => (stdout += c));
        const code = await new Promise((resolve) => {
            child.on('close', resolve);
        });
        assert.strictEqual(code, 0);
        assert.match(stdout, /CHILD-EXITING/);
    });

    it('keeps working after a function-using statement is finalized mid-aggregate-free', async function () {
        // Regression shape for the finalize paths: a statement invoking a
        // function, dropped without completion.
        db.function('countup', { varargs: true }, (...args) => args.length);
        const stmt = db.prepare('SELECT countup(id) FROM t');
        const got = await new Promise((resolve, reject) => {
            stmt.get((err, row) => (err ? reject(err) : resolve(row)));
        });
        assert.ok(got);
        await stmt.finalize();
        assert.strictEqual(db.getSync('SELECT 1 AS v').v, 1);
    });

    // configure()'s handlers drive sqlite from the JS thread, so with a
    // function registered they defer through the exclusive queue rather
    // than block on the connection mutex a round-tripping worker holds.
    // The deferred handler must finish its own sqlite call BEFORE it
    // releases the database: Process() dispatches queued statement work
    // immediately, and a worker that then enters a round trip owns the
    // mutex the handler still needs -- the very deadlock the deferral is
    // for. Release-then-call is what this pins (it left the handler
    // running with `pending` in the dozens; a debug build asserts).
    it('defers configure() past in-flight work without wedging', {
        timeout: 30000,
    }, async function () {
        db.parallelize();
        await new Promise((resolve, reject) => {
            db.exec("INSERT INTO t (id, name) VALUES (9, 'nine')", (err) =>
                err ? reject(err) : resolve(undefined),
            );
        });
        db.function('slowid', (x) => {
            const end = Date.now() + 1;
            while (Date.now() < end);
            return x;
        });

        const inflight = [db.all('SELECT slowid(id) FROM t')];
        // Deferred: a function is registered and work is in flight.
        db.configure('trace', function () {
            // Installing the hook is the point; the SQL itself is not read.
        });
        // Queued behind the deferred handler; these are what the premature
        // release used to dispatch while sqlite3_trace_v2 was still ahead.
        for (let i = 0; i < 40; i++) {
            inflight.push(db.all('SELECT slowid(id) FROM t'));
        }
        const settled = await Promise.allSettled(inflight);
        assert.strictEqual(
            settled.filter((s) => s.status === 'rejected').length,
            0,
        );
        // The connection is still usable and not wedged on the mutex.
        assert.strictEqual(db.getSync('SELECT 1 AS v').v, 1);
    });
});

/** Structural equivalence with Buffer/BigInt awareness. */
function equivalent(a, b) {
    if (a === b) return true;
    if (typeof a === 'bigint' || typeof b === 'bigint') {
        return typeof a === typeof b && Object.is(a, b);
    }
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
        return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
    }
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() === b.getTime();
    }
    return false;
}

function show(v) {
    if (v instanceof Uint8Array) return `Buffer(${v.length})`;
    return `${typeof v} ${String(v)}`;
}
