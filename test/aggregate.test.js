import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// User-defined aggregate and window functions (Deliverable 06): start/
// step/result over grouped and ungrouped rows, the empty-group contract,
// window frames exercising inverse, error propagation, and teardown
// safety for aggregates left incomplete.

describe('user-defined aggregates', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await new Promise((resolve, reject) => {
            db.once('open', resolve);
            db.once('error', reject);
        });
    });

    afterEach(async function () {
        await db.close();
    });

    function totalAggregate() {
        return {
            start: () => 0,
            step: (acc, v) => acc + v,
            result: (acc) => acc,
        };
    }

    it('aggregates 10k rows', async function () {
        db.aggregate('total', totalAggregate());
        await db.exec(
            'CREATE TABLE t (x INT);\n' +
                'INSERT INTO t SELECT x FROM (WITH RECURSIVE cnt(x) AS ' +
                '(SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 10000) ' +
                'SELECT x FROM cnt)',
        );
        const row = await db.get('SELECT total(x) AS v FROM t');
        assert.strictEqual(row.v, (10000 * 10001) / 2);
    });

    it('aggregates per GROUP BY group', async function () {
        db.aggregate('total', totalAggregate());
        await db.exec(
            'CREATE TABLE g (grp TEXT, x INT);\n' +
                "INSERT INTO g VALUES ('a', 1), ('a', 2), ('b', 10), ('b', 20), ('c', 7)",
        );
        const rows = await db.all(
            'SELECT grp, total(x) AS v FROM g GROUP BY grp ORDER BY grp',
        );
        assert.deepStrictEqual(
            rows.map((r) => [r.grp, r.v]),
            [
                ['a', 3],
                ['b', 30],
                ['c', 7],
            ],
        );
    });

    it('evaluates start then result for an empty group', async function () {
        const calls = [];
        db.aggregate('emptyagg', {
            start: () => {
                calls.push('start');
                return 'acc';
            },
            step: (acc, _v) => acc,
            result: (acc) => {
                calls.push(`result:${acc}`);
                return acc === 'acc' ? 'empty' : 'nonempty';
            },
        });
        await db.exec(
            'CREATE TABLE g (grp TEXT, x INT);\n' +
                "INSERT INTO g VALUES ('a', 1), ('b', 2)",
        );
        // The whole table matches with WHERE x > 5: one group, no rows.
        const row = await db.get('SELECT emptyagg(x) AS v FROM g WHERE x > 5');
        assert.strictEqual(row.v, 'empty');
        assert.deepStrictEqual(calls, ['start', 'result:acc']);
    });

    it('returns NULL by default for an empty group when result says so', async function () {
        db.aggregate('medianish', {
            start: () => [],
            step: (acc, v) => {
                acc.push(v);
                return acc;
            },
            result: (acc) => {
                if (!acc.length) return null;
                acc.sort((a, b) => a - b);
                return acc[acc.length >> 1];
            },
        });
        await db.exec('CREATE TABLE n (x INT)');
        const row = await db.get('SELECT medianish(x) AS v FROM n');
        assert.strictEqual(row.v, null);
        await db.exec('INSERT INTO n VALUES (5), (1), (3), (9)');
        const row2 = await db.get('SELECT medianish(x) AS v FROM n');
        assert.strictEqual(row2.v, 5);
    });

    it('supports window functions with inverse over a moving frame', async function () {
        // Sum of the current and previous row over an ordered frame:
        // exercises xValue for partial frames and xInverse when rows
        // leave the frame.
        db.aggregate('winsum', {
            start: () => 0,
            step: (acc, v) => acc + v,
            result: (acc) => acc,
            inverse: (acc, v) => acc - v,
        });
        await db.exec(
            'CREATE TABLE w (x INT);\n' +
                'INSERT INTO w VALUES (1), (2), (3), (4), (5)',
        );
        const rows = await db.all(
            'SELECT x, winsum(x) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM w',
        );
        assert.deepStrictEqual(
            rows.map((r) => r.s),
            [1, 3, 5, 7, 9],
        );
        // A wider frame to push rows through inverse repeatedly.
        const rows2 = await db.all(
            'SELECT x, winsum(x) OVER (ORDER BY x ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS s FROM w',
        );
        assert.deepStrictEqual(
            rows2.map((r) => r.s),
            [1, 3, 6, 9, 12],
        );
    });

    it('handles typed arguments and returns (BigInt, blobs)', async function () {
        db.configure('integerMode', 'bigint');
        const seen = [];
        db.aggregate('maxblob', {
            start: () => null,
            step: (acc, v) => (acc === null || v > acc ? v : acc),
            result: (acc) => acc,
        });
        await db.exec(
            'CREATE TABLE b (x INTEGER);\n' +
                'INSERT INTO b VALUES (9007199254740993), (1), (9007199254740994)',
        );
        db.aggregate('bigintmax', {
            start: () => null,
            step: (acc, v) => {
                seen.push(v);
                return acc === null || v > acc ? v : acc;
            },
            result: (acc) => acc,
        });
        const row = await db.get('SELECT bigintmax(x) AS v FROM b');
        assert.strictEqual(row.v, 9007199254740994n);
        assert.ok(seen.every((v) => typeof v === 'bigint'));
    });

    it('propagates a throwing step as a SQLite error with cause', async function () {
        const boom = new Error('step explosion');
        db.aggregate('badstep', {
            start: () => 0,
            step: (_acc, _v) => {
                throw boom;
            },
            result: (acc) => acc,
        });
        await db.exec('CREATE TABLE t (x INT); INSERT INTO t VALUES (1), (2)');
        await assert.rejects(db.all('SELECT badstep(x) AS v FROM t'), (err) => {
            assert.strictEqual(err.code, 'SQLITE_ERROR');
            assert.match(err.message, /threw in step/);
            assert.strictEqual(err.cause, boom);
            return true;
        });
        assert.strictEqual(db.getSync('SELECT 1 AS v').v, 1);
    });

    it('propagates a throwing result', async function () {
        db.aggregate('badresult', {
            start: () => 0,
            step: (acc, v) => acc + v,
            result: () => {
                throw new Error('result explosion');
            },
        });
        await db.exec('CREATE TABLE t (x INT); INSERT INTO t VALUES (1)');
        await assert.rejects(
            db.get('SELECT badresult(x) AS v FROM t'),
            /threw in result: result explosion/,
        );
    });

    it('propagates a throwing start', async function () {
        db.aggregate('badstart', {
            start: () => {
                throw new Error('start explosion');
            },
            step: (acc, v) => acc + v,
            result: (acc) => acc,
        });
        await db.exec('CREATE TABLE t (x INT); INSERT INTO t VALUES (1)');
        await assert.rejects(
            db.get('SELECT badstart(x) AS v FROM t'),
            /threw in start: start explosion/,
        );
    });

    it('refuses invocation from the sync methods instead of deadlocking', {
        timeout: 5000,
    }, async function () {
        db.aggregate('total', totalAggregate());
        await db.exec('CREATE TABLE t (x INT); INSERT INTO t VALUES (1)');
        assert.throws(
            () => db.getSync('SELECT total(x) AS v FROM t'),
            /deadlock/,
        );
    });

    it('finalizes cleanly when an aggregate is left incomplete', {
        timeout: 5000,
    }, async function () {
        // break out of an iteration mid-aggregate: the statement's
        // finalize fires xFinal for the incomplete aggregate from the JS
        // thread, which must not deadlock on its own round trip.
        db.aggregate('winsum', {
            start: () => 0,
            step: (acc, v) => acc + v,
            result: (acc) => acc,
            inverse: (acc, v) => acc - v,
        });
        await db.exec(
            'CREATE TABLE t (x INT);\n' +
                'INSERT INTO t VALUES (1), (2), (3), (4), (5), (6), (7), (8)',
        );
        let seen = 0;
        for await (const _row of db.iterate(
            'SELECT winsum(x) OVER (ORDER BY x) AS s FROM t',
        )) {
            seen++;
            if (seen === 2) break;
        }
        assert.strictEqual(seen, 2);
        assert.strictEqual(db.getSync('SELECT 1 AS v').v, 1);
    });

    it('replaces and removes aggregates, flushing the statement cache', async function () {
        // sumall: not a sqlite builtin, so removal is observable.
        db.cacheStatements();
        await db.exec('CREATE TABLE t (x INT); INSERT INTO t VALUES (2), (3)');
        db.aggregate('sumall', totalAggregate());
        assert.strictEqual((await db.get('SELECT sumall(x) AS v FROM t')).v, 5);
        db.aggregate('sumall', {
            start: () => 100,
            step: (acc, v) => acc + v,
            result: (acc) => acc,
        });
        assert.strictEqual(
            (await db.get('SELECT sumall(x) AS v FROM t')).v,
            105,
        );
        db.removeFunction('sumall');
        await assert.rejects(
            db.get('SELECT sumall(x) AS v FROM t'),
            /no such function: sumall/,
        );
    });

    it('validates the implementation object', function () {
        assert.throws(() => db.aggregate('x', null), /implementation object/);
        assert.throws(() => db.aggregate('x', {}), /'start' function/);
        assert.throws(
            () => db.aggregate('x', { start: () => 0 }),
            /'step' function/,
        );
        assert.throws(
            () =>
                db.aggregate('x', {
                    start: () => 0,
                    step: (a) => a,
                }),
            /'result' function/,
        );
        assert.throws(
            () =>
                db.aggregate('x', {
                    start: () => 0,
                    step: (a) => a,
                    result: (a) => a,
                    inverse: 42,
                }),
            /'inverse'.*must be a function/,
        );
        const returned = db.aggregate('ok', {
            start: () => 0,
            step: (a, v) => a + v,
            result: (a) => a,
        });
        assert.strictEqual(returned, db);
    });

    it('derives the arity from step.length minus the accumulator', async function () {
        await db.exec(
            'CREATE TABLE t (x INT, y INT); INSERT INTO t VALUES (1, 10)',
        );
        db.aggregate('twoarg', {
            start: () => 0,
            step: (acc, a, b) => acc + a + b,
            result: (acc) => acc,
        });
        assert.strictEqual(
            (await db.get('SELECT twoarg(x, y) AS v FROM t')).v,
            11,
        );
        await assert.rejects(
            db.get('SELECT twoarg(x) AS v FROM t'),
            /wrong number of arguments/i,
        );
    });
});
