import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Phase 4: JavaScript virtual tables — db.table() in both the eponymous
// and factory forms, db.values(), the sync path's direct calls, error
// propagation and teardown.

describe('virtual tables', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await db.exec(
            'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n' +
                "INSERT INTO users (name) VALUES ('a'), ('b'), ('c')",
        );
    });

    afterEach(async function () {
        await db.close();
    });

    it('serves an eponymous table from a generator', async function () {
        db.table('letters', {
            columns: ['c'],
            rows: function* () {
                yield ['x'];
                yield ['y'];
            },
        });
        assert.deepStrictEqual(await db.all('SELECT c FROM letters'), [
            { c: 'x' },
            { c: 'y' },
        ]);
    });

    it('passes HIDDEN parameters to the generator (table-valued function)', async function () {
        db.table('sequence', {
            columns: ['value', 'count'],
            parameters: ['count'],
            rows: function* seq(count) {
                for (let i = 0; i < count; i++) yield [i, count];
            },
        });
        assert.deepStrictEqual(await db.all('SELECT value FROM sequence(3)'), [
            { value: 0 },
            { value: 1 },
            { value: 2 },
        ]);
        // Hidden columns do not appear in SELECT *.
        assert.deepStrictEqual(await db.all('SELECT * FROM sequence(1)'), [
            { value: 0 },
        ]);
    });

    it('delivers several HIDDEN parameters in declaration order', async function () {
        // Regression: xBestIndex used to hand xFilter the constraints in
        // reverse (argvIndex = size - p), so a two-parameter table
        // function received its arguments swapped.
        db.table('pair', {
            columns: ['first', 'second', 'n', 'm'],
            parameters: ['n', 'm'],
            rows: function* pair(n, m) {
                yield [n, m, 'seen'];
            },
        });
        assert.deepStrictEqual(await db.all('SELECT * FROM pair(10, 20)'), [
            { first: 10, second: 20 },
        ]);
        // The WHERE-constraint spelling reaches the same xBestIndex path.
        assert.deepStrictEqual(
            await db.all('SELECT * FROM pair WHERE n = 1 AND m = 2'),
            [{ first: 1, second: 2 }],
        );
        assert.deepStrictEqual(db.allSync('SELECT * FROM pair(7, 9)'), [
            { first: 7, second: 9 },
        ]);
    });

    it('runs from the synchronous methods too', function () {
        db.table('sequence', {
            columns: ['value'],
            parameters: ['value'],
            rows: function* seq(count) {
                for (let i = 0; i < count; i++) yield [i];
            },
        });
        assert.deepStrictEqual(db.allSync('SELECT value FROM sequence(2)'), [
            { value: 0 },
            { value: 1 },
        ]);
    });

    it('joins against real tables', async function () {
        db.table('ids', {
            columns: ['n'],
            rows: function* () {
                yield [1];
                yield [2];
            },
        });
        const rows = await db.all(
            'SELECT users.name FROM users JOIN ids ON users.id = ids.n',
        );
        assert.deepStrictEqual(rows, [{ name: 'a' }, { name: 'b' }]);
    });

    it('accepts object rows keyed by column name', async function () {
        db.table('objrows', {
            columns: ['a', 'b'],
            rows: function* () {
                yield { a: 1, b: 'two' };
            },
        });
        assert.deepStrictEqual(await db.all('SELECT * FROM objrows'), [
            { a: 1, b: 'two' },
        ]);
    });

    it('accepts bare values for single-column tables', async function () {
        db.table('singles', {
            columns: ['v'],
            rows: function* () {
                yield 7;
                yield 'eight';
            },
        });
        assert.deepStrictEqual(await db.all('SELECT v FROM singles'), [
            { v: 7 },
            { v: 'eight' },
        ]);
    });

    it('applies the strict marshalling to yielded values', async function () {
        db.table('badcell', {
            columns: ['v'],
            rows: function* () {
                yield [{ not: 'bindable' }];
            },
        });
        await assert.rejects(
            db.all('SELECT v FROM badcell'),
            /unsupported type/i,
        );
    });

    it('stops pulling an unbounded generator at LIMIT', async function () {
        let produced = 0;
        db.table('naturals', {
            columns: ['n'],
            rows: function* () {
                for (let i = 0; ; i++) {
                    // A generator with no end is the canonical sequence
                    // table; materialising it would never return.
                    if (++produced > 100_000) throw new Error('ran away');
                    yield [i];
                }
            },
        });
        assert.deepStrictEqual(await db.all('SELECT n FROM naturals LIMIT 3'), [
            { n: 0 },
            { n: 1 },
            { n: 2 },
        ]);
        // One batch, not one row and not everything.
        assert.ok(produced < 1000, `produced ${produced}`);
    });

    it('survives concurrent queries against the same table', async function () {
        // Regression (deadlock): a worker inside the generator round trip
        // holds the connection mutex while it waits for the JS thread, so
        // the first query's completion handler must not call
        // sqlite3_finalize inline — it would want that mutex. Virtual
        // tables were missing from MayBlockOnWorkerRoundTrip(), so two
        // concurrent queries hung the process, event loop and all.
        db.table('nums', {
            columns: ['v'],
            rows: function* () {
                for (let i = 0; i < 300; i++) yield [i];
            },
        });
        const results = await Promise.all([
            db.all('SELECT count(*) AS c FROM nums'),
            db.all('SELECT count(*) AS c FROM nums'),
            db.all('SELECT v FROM nums LIMIT 2'),
            db.get('SELECT max(v) AS m FROM nums'),
        ]);
        assert.deepStrictEqual(results[0], [{ c: 300 }]);
        assert.deepStrictEqual(results[1], [{ c: 300 }]);
        assert.deepStrictEqual(results[2], [{ v: 0 }, { v: 1 }]);
        assert.deepStrictEqual(results[3], { m: 299 });
    });

    it('survives concurrent queries against a values() table', async function () {
        const rows = Array.from({ length: 2500 }, (_, i) => i);
        const table = db.values(rows);
        const [a, b] = await Promise.all([
            db.get(`SELECT count(*) AS c FROM ${table.name}`),
            db.get(`SELECT sum(value) AS s FROM ${table.name}`),
        ]);
        assert.strictEqual(a.c, 2500);
        assert.strictEqual(b.s, (2499 * 2500) / 2);
        table.drop();
    });

    it('reports a generator that throws mid-scan and stays usable', async function () {
        db.table('flaky', {
            columns: ['v'],
            rows: function* () {
                for (let i = 0; i < 5000; i++) {
                    // Past the first batch, so the failure lands in xNext.
                    if (i === 100) throw new Error('mid-scan failure');
                    yield [i];
                }
            },
        });
        await assert.rejects(db.all('SELECT v FROM flaky'), /mid-scan failure/);
        assert.strictEqual((await db.get('SELECT 1 AS v')).v, 1);
    });

    it('re-filters a cursor for each row of a correlated subquery', async function () {
        db.table('upto', {
            columns: ['v', 'n'],
            parameters: ['n'],
            rows: function* (n) {
                for (let i = 0; i < Number(n ?? 0); i++) yield [i];
            },
        });
        assert.deepStrictEqual(
            await db.all(
                'SELECT id, (SELECT count(*) FROM upto(id)) AS c FROM users',
            ),
            [
                { id: 1, c: 1 },
                { id: 2, c: 2 },
                { id: 3, c: 3 },
            ],
        );
    });

    it('keeps rowids monotonic across batch boundaries', async function () {
        db.table('many', {
            columns: ['n'],
            rows: function* () {
                for (let i = 0; i < 5000; i++) yield [i];
            },
        });
        const rows = /** @type {any[]} */ (
            await db.all('SELECT rowid AS r, n FROM many')
        );
        assert.strictEqual(rows.length, 5000);
        assert.strictEqual(rows[0].r, 1);
        assert.strictEqual(rows.at(-1)?.r, 5000);
        assert.strictEqual(
            new Set(rows.map((row) => row.r)).size,
            5000,
            'a per-batch counter would repeat rowids',
        );
        assert.strictEqual(
            (await db.get('SELECT COUNT(DISTINCT n) AS n FROM many')).n,
            5000,
        );
    });

    it('streams the same rows through the sync path', function () {
        db.table('lots', {
            columns: ['n'],
            rows: function* () {
                for (let i = 0; i < 3000; i++) yield [i];
            },
        });
        const rows = db.allSync('SELECT n FROM lots');
        assert.strictEqual(rows.length, 3000);
        assert.strictEqual(db.getSync('SELECT n FROM lots LIMIT 1').n, 0);
    });

    it('accepts constraints on any hidden parameter, in any number', async function () {
        db.table('pair', {
            columns: ['v', 'a', 'b'],
            parameters: ['a', 'b'],
            rows: function* (a, b) {
                yield [`${a}/${b}`];
            },
        });
        // Only the second parameter constrained: the argvIndex values must
        // still be 1..N without gaps, or sqlite fails the statement with
        // "xBestIndex malfunction".
        assert.deepStrictEqual(await db.all('SELECT v FROM pair WHERE b = 2'), [
            { v: 'undefined/2' },
        ]);
        assert.deepStrictEqual(await db.all('SELECT v FROM pair(1, 2)'), [
            { v: '1/2' },
        ]);
        // A duplicate equality on one parameter must not double-assign it.
        db.table('seq', {
            columns: ['value', 'count'],
            parameters: ['count'],
            rows: function* (count) {
                for (let i = 0; i < Number(count ?? 0); i++) yield [i];
            },
        });
        assert.deepStrictEqual(
            await db.all('SELECT value FROM seq WHERE count = 2 AND count = 2'),
            [{ value: 0 }, { value: 1 }],
        );
        // Contradictory constraints select nothing rather than erroring.
        assert.deepStrictEqual(
            await db.all('SELECT value FROM seq WHERE count = 2 AND count = 3'),
            [],
        );
    });

    it('reports a hidden parameter the generator did not yield', async function () {
        db.table('echo', {
            columns: ['value', 'n'],
            parameters: ['n'],
            rows: function* (n) {
                for (let i = 0; i < Number(n); i++) yield [i];
            },
        });
        // The argument fills the HIDDEN column the generator left NULL.
        assert.deepStrictEqual(await db.all('SELECT value, n FROM echo(2)'), [
            { value: 0, n: 2 },
            { value: 1, n: 2 },
        ]);
    });

    it('releases a dropped table generator (and what it captured)', async function () {
        // Regression: dead module holders used to live until the connection
        // was destroyed, pinning the closure — and any array it captured.
        const { execFileSync } = await import('node:child_process');
        const script = `
            import sqlite3 from './lib/sqlite3.js';
            const tick = () => new Promise((r) => setTimeout(r, 20));
            let collected = 0;
            const registry = new FinalizationRegistry(() => collected++);
            const db = await sqlite3.open(':memory:');
            for (let i = 0; i < 20; i++) {
                const rows = new Array(1000).fill(i);
                registry.register(rows, i);
                const table = db.values(rows);
                await db.all(\`SELECT count(*) FROM \${table.name}\`);
                table.drop();
                await db.wait();
            }
            global.gc(); await tick(); global.gc(); await tick(); global.gc();
            await tick();
            console.log(collected);
            await db.close();
        `;
        const out = execFileSync(
            process.execPath,
            ['--expose-gc', '--input-type=module', '-e', script],
            { encoding: 'utf8', cwd: new URL('..', import.meta.url) },
        );
        // The last iteration's array is still referenced by the loop body.
        assert.ok(
            Number(out.trim()) >= 19,
            `only ${out.trim()} of 20 dropped values() arrays were collected`,
        );
    });

    it('propagates generator throws as query errors', async function () {
        db.table('broken', {
            columns: ['v'],
            // Throwing before the first yield is the case under test: a
            // generator function that throws on its first next().
            rows: function* () {
                if (Date.now() > 0) throw new Error('generator exploded');
                yield 0;
            },
        });
        await assert.rejects(
            db.all('SELECT v FROM broken'),
            (err) =>
                /generator exploded/.test(err.message) ||
                /broken/.test(err.message),
        );
        // The connection survives.
        assert.strictEqual((await db.get('SELECT 1 AS v')).v, 1);
    });

    it('supports factory modules with CREATE VIRTUAL TABLE', async function () {
        // Factory arguments arrive as the SQL literal strings from the
        // DDL ("10", "12"); coerce as needed.
        /** @type {any} */
        const range = (lo, hi) => ({
            rows: function* () {
                for (let i = Number(lo); i <= Number(hi); i++) yield [i];
            },
        });
        range.columns = ['value'];
        db.table('mod_range', range);
        await db.exec('CREATE VIRTUAL TABLE r3 USING mod_range(10, 12)');
        assert.deepStrictEqual(await db.all('SELECT * FROM r3'), [
            { value: 10 },
            { value: 11 },
            { value: 12 },
        ]);
    });

    it('validates definitions loudly', function () {
        assert.throws(() => db.table(''), /non-empty name/);
        assert.throws(() => db.table('x', 7), /definition object/);
        assert.throws(
            () => db.table('x', { columns: ['a'] }),
            /requires a 'rows' generator/,
        );
        assert.throws(
            () => db.table('x', { columns: 'no' }),
            /requires a 'columns' array/,
        );
        assert.throws(
            () =>
                db.table('x', {
                    columns: ['a'],
                    parameters: ['b'],
                    rows: function* () {
                        yield ['a'];
                    },
                }),
            /parameter 'b' is not one of the columns/,
        );
        assert.throws(
            () => db.table('x', { columns: ['a'], rows: null }),
            /requires a 'rows' generator/,
        );
        // v1 is read-only with no pattern push-down: the option must not
        // be accepted silently.
        assert.throws(
            () =>
                db.table('x', {
                    columns: ['a'],
                    pattern: 'x%',
                    rows: function* () {
                        yield ['a'];
                    },
                }),
            /unknown option 'pattern'/,
        );
    });

    it('removeTable makes the name fail loudly', async function () {
        db.table('temp1', {
            columns: ['v'],
            rows: function* () {
                yield [1];
            },
        });
        assert.ok((await db.all('SELECT v FROM temp1')).length === 1);
        db.removeTable('temp1');
        await assert.rejects(
            db.all('SELECT v FROM temp1'),
            /was removed|no such module/i,
        );
    });

    it('values() exposes a JS array as a table', async function () {
        const ids = db.values([1, 3]);
        const rows = await db.all(
            `SELECT users.name FROM users JOIN ${ids.name} ON users.id = ${ids.name}.value`,
        );
        assert.deepStrictEqual(rows, [{ name: 'a' }, { name: 'c' }]);
        ids.drop();
        await assert.rejects(
            db.all(`SELECT * FROM ${ids.name}`),
            /was removed|no such module/i,
        );
    });

    it('values() handles strings, nulls and blobs', async function () {
        const values = db.values(['x', null, Buffer.from([1, 2])]);
        const rows = await db.all(
            `SELECT key, value FROM ${values.name} ORDER BY key`,
        );
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].value, 'x');
        assert.strictEqual(rows[1].value, null);
        assert.deepStrictEqual(
            Buffer.from(/** @type {Buffer} */ (rows[2].value)),
            Buffer.from([1, 2]),
        );
    });

    it('values() validates its input', function () {
        assert.throws(() => db.values(7), /requires an iterable/);
        assert.throws(
            () => db.values([1], { bogus: 1 }),
            /unknown option 'bogus'/,
        );
    });

    it('closes cleanly with tables and values registered', async function () {
        db.table('closeme', {
            columns: ['v'],
            rows: function* () {
                yield [1];
            },
        });
        db.values([1, 2, 3]);
        await db.close();
        // afterEach would double-close; reopen so the hook stays valid.
        db = new sqlite3.Database(':memory:');
    });
});
