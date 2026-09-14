import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Phase 1 (ergonomics parity) and the Phase 6 quick wins: pragma(),
// explain(), batch(), dump()/iterdump, the reusable transaction form,
// async-path row modes (array/pluck), err.offset, inTransaction/txnState,
// db.status()/limits/location/releaseMemory, complete()/compileOptions()
// and the expandedSQL/normalizedSQL accessors.

describe('ergonomics parity', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await db.exec(
            'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n' +
                "INSERT INTO t (v) VALUES ('a'), ('b'), ('c')",
        );
    });

    afterEach(async function () {
        await db.close();
    });

    describe('pragma()', function () {
        it('resolves the pragma rows', async function () {
            const rows = await db.pragma('journal_mode');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].journal_mode, 'memory');
        });

        it('resolves the scalar with { simple: true }', async function () {
            await db.pragma('user_version = 7');
            assert.strictEqual(
                await db.pragma('user_version', { simple: true }),
                7,
            );
        });

        it('accepts argument forms', async function () {
            const rows = await db.pragma('table_info(t)');
            assert.strictEqual(rows.length, 2);
            assert.strictEqual(rows[0].name, 'id');
        });

        it('simple resolves undefined for statements-only pragmas', async function () {
            assert.strictEqual(
                await db.pragma('user_version = 9', { simple: true }),
                undefined,
            );
            assert.strictEqual(
                await db.pragma('user_version', { simple: true }),
                9,
            );
        });

        it('rejects malformed input', async function () {
            await assert.rejects(db.pragma(''), TypeError);
            await assert.rejects(db.pragma(7), TypeError);
            await assert.rejects(
                db.pragma('user_version', { bogus: true }),
                /unknown option 'bogus'/,
            );
        });
    });

    describe('explain()', function () {
        it('resolves the EXPLAIN QUERY PLAN rows without executing', async function () {
            const plan = await db.explain('SELECT * FROM t WHERE id = 1');
            assert.ok(plan.length > 0);
            assert.ok('detail' in plan[0]);
        });

        it('supports parameters left unbound', async function () {
            const plan = await db.explain('SELECT * FROM t WHERE id = ?');
            assert.ok(plan.length > 0);
        });

        it('{ full: true } yields the VDBE program', async function () {
            const program = await db.explain('SELECT 1', { full: true });
            assert.ok(program.length > 0);
            assert.ok('opcode' in program[0]);
        });

        it('rejects malformed input', async function () {
            await assert.rejects(db.explain(''), TypeError);
            await assert.rejects(
                db.explain('SELECT 1', { bogus: 1 }),
                /unknown option 'bogus'/,
            );
        });
    });

    describe('batch()', function () {
        it('runs statements atomically', async function () {
            const results = await db.batch([
                { sql: 'INSERT INTO t (v) VALUES (?)', args: 'x' },
                { sql: 'INSERT INTO t (v) VALUES (?)', args: 'y' },
            ]);
            assert.strictEqual(results.length, 2);
            assert.strictEqual(results[0].changes, 1);
            assert.strictEqual(
                (await db.get('SELECT COUNT(*) AS n FROM t')).n,
                5,
            );
        });

        it('rolls the whole batch back on failure', async function () {
            await assert.rejects(
                db.batch([
                    { sql: 'INSERT INTO t (v) VALUES (?)', args: 'x' },
                    'INSERT INTO nonexistent VALUES (1)',
                ]),
            );
            assert.strictEqual(
                (await db.get('SELECT COUNT(*) AS n FROM t')).n,
                3,
            );
        });

        it('accepts strings, [sql, params] pairs and objects', async function () {
            const results = await db.batch([
                "INSERT INTO t (v) VALUES ('s')",
                ['INSERT INTO t (v) VALUES (?)', 'p'],
                { sql: 'INSERT INTO t (v) VALUES (?)', args: 'o' },
            ]);
            assert.strictEqual(results.length, 3);
            assert.strictEqual(
                (await db.get('SELECT COUNT(*) AS n FROM t')).n,
                6,
            );
        });

        it('accepts a scalar or named-object args, not just arrays', async function () {
            // Documented shapes that used to throw "Spread syntax requires
            // ...iterable[Symbol.iterator] to be a function".
            const results = await db.batch([
                { sql: 'INSERT INTO t (v) VALUES (?)', args: 'scalar' },
                { sql: 'INSERT INTO t (v) VALUES ($v)', args: { $v: 'named' } },
            ]);
            assert.strictEqual(results.length, 2);
            assert.deepStrictEqual(
                await db.all(
                    "SELECT v FROM t WHERE v IN ('scalar','named') ORDER BY v",
                ),
                [{ v: 'named' }, { v: 'scalar' }],
            );
        });

        it('collects the rows of a RETURNING statement', async function () {
            const results = await db.batch([
                { sql: "INSERT INTO t (v) VALUES ('r') RETURNING id, v" },
                { sql: '/* a comment */ SELECT COUNT(*) AS n FROM t' },
            ]);
            assert.strictEqual(
                /** @type {any[]} */ (results[0])[0].v,
                'r',
                'RETURNING rows must not be thrown away',
            );
            assert.strictEqual(/** @type {any[]} */ (results[1])[0].n, 4);
        });

        it('resolves read-shaped statements as rows', async function () {
            const results = await db.batch([
                'SELECT COUNT(*) AS n FROM t',
                'PRAGMA user_version',
            ]);
            assert.strictEqual(results[0][0].n, 3);
            assert.ok('user_version' in results[1][0]);
        });

        it('maps libsql modes onto BEGIN forms', async function () {
            await db.batch(['INSERT INTO t (v) VALUES (1)'], {
                mode: 'read',
            });
            await assert.rejects(
                db.batch([], { mode: 'bogus' }),
                /mode must be/,
            );
        });
    });

    describe('dump() / iterdump', function () {
        it('produces restorable SQL text', async function () {
            const dump = await db.dump();
            assert.ok(dump.startsWith('PRAGMA foreign_keys=OFF;'));
            assert.ok(dump.includes('CREATE TABLE t'));
            assert.ok(dump.includes('INSERT INTO "t"("id","v") VALUES'));

            const restored = new sqlite3.Database(':memory:');
            await restored.exec(dump);
            assert.strictEqual(
                (await restored.get('SELECT COUNT(*) AS n FROM t')).n,
                3,
            );
            await restored.close();
        });

        it('iterdump streams statement by statement', async function () {
            /** @type {string[]} */
            const statements = [];
            for await (const statement of sqlite3.iterdump(db)) {
                statements.push(statement);
            }
            assert.ok(statements.length >= 4);
            assert.ok(statements.at(-1)?.includes('COMMIT'));
        });

        it('keeps AUTOINCREMENT counters, user_version and ±Infinity', async function () {
            const source = new sqlite3.Database(':memory:');
            await source.exec(
                'CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, x REAL,' +
                    ' d GENERATED ALWAYS AS (x * 2));\n' +
                    'INSERT INTO a (x) VALUES (1), (2);\n' +
                    'DELETE FROM a;\n' +
                    'PRAGMA user_version = 12',
            );
            await source.run(
                'INSERT INTO a (x) VALUES (?)',
                Number.POSITIVE_INFINITY,
            );
            const dump = await source.dump();
            // A JavaScript `Infinity` literal is not SQL; the overflowing
            // decimal is what SQLite reads back as +inf.
            assert.ok(!/Infinity/.test(dump), dump);
            assert.ok(dump.includes('sqlite_sequence'));
            assert.ok(dump.includes('PRAGMA user_version = 12'));
            // A generated column cannot be an INSERT target.
            assert.ok(!/INSERT INTO "a"\("id","x","d"\)/.test(dump), dump);

            const restored = new sqlite3.Database(':memory:');
            await restored.exec(dump);
            assert.strictEqual(
                (await restored.get('SELECT x, d FROM a')).x,
                Number.POSITIVE_INFINITY,
            );
            assert.strictEqual(
                await restored.pragma('user_version', { simple: true }),
                12,
            );
            // The AUTOINCREMENT high-water mark survived, so no rowid is
            // handed out twice.
            const inserted = await restored.get(
                'INSERT INTO a (x) VALUES (5) RETURNING id',
            );
            assert.strictEqual(inserted.id, 4);
            await restored.close();
            await source.close();
        });

        it('round-trips a virtual table with its content', async function () {
            const source = new sqlite3.Database(':memory:');
            await source.exec(
                'CREATE VIRTUAL TABLE docs USING fts5(body);\n' +
                    "INSERT INTO docs (body) VALUES ('hello world');\n" +
                    // A table that only looks like a shadow table.
                    'CREATE TABLE docs_notes (note);\n' +
                    "INSERT INTO docs_notes VALUES ('keep me')",
            );
            const dump = await source.dump();
            const restored = new sqlite3.Database(':memory:');
            await restored.exec(dump);
            assert.deepStrictEqual(
                await restored.all(
                    "SELECT body FROM docs WHERE docs MATCH 'hello'",
                ),
                [{ body: 'hello world' }],
            );
            assert.deepStrictEqual(
                await restored.all('SELECT note FROM docs_notes'),
                [{ note: 'keep me' }],
            );
            assert.strictEqual(
                await restored.pragma('integrity_check', { simple: true }),
                'ok',
            );
            await restored.close();
            await source.close();
        });

        it('reads inside a transaction and releases it when abandoned', async function () {
            const iterator = sqlite3.iterdump(db);
            await iterator.next();
            // A deferred transaction is open (it takes its read lock at
            // the first read), so the walk is a point-in-time snapshot.
            assert.strictEqual(db.inTransaction, true);
            await iterator.return();
            assert.strictEqual(db.inTransaction, false);
            // ... and a completed walk commits it.
            await db.dump();
            assert.strictEqual(db.inTransaction, false);
        });

        it('serializes blobs and quotes safely', async function () {
            await db.exec('CREATE TABLE blobs (b BLOB)');
            await db.run(
                'INSERT INTO blobs VALUES (?)',
                Buffer.from([0x00, 0xde, 0xad]),
            );
            await db.run("INSERT INTO t (v) VALUES ('it''s quoted')");
            const dump = await db.dump();
            const restored = new sqlite3.Database(':memory:');
            await restored.exec(dump);
            const row = await restored.get('SELECT b FROM blobs');
            assert.deepStrictEqual(
                Buffer.from(/** @type {Buffer} */ (row.b)),
                Buffer.from([0x00, 0xde, 0xad]),
            );
            await restored.close();
        });
    });

    describe('createTransaction()', function () {
        it('returns a reusable wrapper', async function () {
            const insert = db.createTransaction((tx, v) =>
                tx.run('INSERT INTO t (v) VALUES (?)', v),
            );
            await insert('x');
            await insert('y');
            assert.strictEqual(
                (await db.get('SELECT COUNT(*) AS n FROM t')).n,
                5,
            );
        });

        it('carries .deferred/.immediate/.exclusive variants', async function () {
            let seenMode = '';
            const probe = db.createTransaction(async (tx, tag) => {
                seenMode = tag;
                await tx.run('INSERT INTO t (v) VALUES (?)', tag);
            });
            await probe.deferred('d');
            await probe.immediate('i');
            await probe.exclusive('e');
            assert.strictEqual(seenMode, 'e');
            assert.strictEqual(
                (await db.get('SELECT COUNT(*) AS n FROM t')).n,
                6,
            );
        });

        it('rolls back on throw and stays reusable', async function () {
            const insertUnlessFlagged = db.createTransaction((tx, v, fail) => {
                const step = tx.run('INSERT INTO t (v) VALUES (?)', v);
                return fail
                    ? step.then(() => {
                          throw new Error('body failure');
                      })
                    : step;
            });
            await assert.rejects(
                insertUnlessFlagged('boom', true),
                /body failure/,
            );
            await insertUnlessFlagged.immediate('boom', false);
            assert.strictEqual(
                (await db.get("SELECT COUNT(*) AS n FROM t WHERE v = 'boom'"))
                    .n,
                1,
            );
        });

        it('validates its arguments', function () {
            assert.throws(
                () => db.createTransaction(),
                /requires a function body/,
            );
            assert.throws(
                () => db.createTransaction(() => undefined, { mode: 'x' }),
                /mode must be/,
            );
        });
    });

    describe('async-path row modes', function () {
        it('array rows on get/all/iterate/each/fetch', async function () {
            assert.deepStrictEqual(
                await db.all('SELECT id, v FROM t', { rowMode: 'array' }),
                [
                    [1, 'a'],
                    [2, 'b'],
                    [3, 'c'],
                ],
            );
            assert.deepStrictEqual(
                await db.get('SELECT id, v FROM t WHERE id = 2', {
                    rowMode: 'array',
                }),
                [2, 'b'],
            );
            const rows = [];
            for await (const row of db.iterate('SELECT id FROM t', {
                rowMode: 'array',
            })) {
                rows.push(row);
            }
            assert.deepStrictEqual(rows, [[1], [2], [3]]);
            const each = await new Promise((resolve, reject) => {
                /** @type {unknown[]} */
                const out = [];
                db.each(
                    'SELECT id FROM t',
                    { rowMode: 'array' },
                    (err, row) => {
                        if (err) reject(err);
                        else out.push(row);
                    },
                    () => resolve(out),
                );
            });
            assert.deepStrictEqual(each, [[1], [2], [3]]);
            const stmt = await db.prepare('SELECT id FROM t');
            assert.deepStrictEqual(
                await new Promise((resolve, reject) => {
                    stmt.fetch(2, { rowMode: 'array' }, (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    });
                }),
                [[1], [2]],
            );
            await stmt.finalize();
        });

        it('pluck rows serve the first column', async function () {
            assert.strictEqual(
                await db.get('SELECT id, v FROM t WHERE id = 1', {
                    rowMode: 'pluck',
                }),
                1,
            );
            assert.deepStrictEqual(
                await db.all('SELECT v FROM t ORDER BY id', {
                    rowMode: 'pluck',
                }),
                ['a', 'b', 'c'],
            );
            assert.strictEqual(
                db.getSync('SELECT v FROM t WHERE id = 2', {
                    rowMode: 'pluck',
                }),
                'b',
            );
        });

        it('works alongside parameters', async function () {
            assert.deepStrictEqual(
                await db.all('SELECT id FROM t WHERE id > ?', 1, {
                    rowMode: 'array',
                }),
                [[2], [3]],
            );
        });
    });

    describe('err.offset', function () {
        it('carries the failing token byte offset of a failed prepare', async function () {
            await assert.rejects(
                db.prepare('SELECT * FRUM t'),
                (err) => err.offset === 9,
            );
            assert.throws(
                () => db.prepareSync('SELECT * FRUM t'),
                (err) => err.offset === 9,
            );
        });

        it('is absent when the error carries no position', async function () {
            // A step-time failure (constraint violation), not a prepare one.
            await assert.rejects(
                db.run("INSERT INTO t (id, v) VALUES (1, 'dup')"),
                (err) => err.offset === undefined,
            );
        });
    });

    describe('inTransaction / txnState', function () {
        it('track explicit transactions', async function () {
            assert.strictEqual(db.inTransaction, false);
            assert.strictEqual(db.txnState, 'none');
            await db.exec('BEGIN');
            assert.strictEqual(db.inTransaction, true);
            await db.get('SELECT * FROM t');
            assert.strictEqual(db.txnState, 'read');
            await db.exec("INSERT INTO t (v) VALUES ('d')");
            assert.strictEqual(db.txnState, 'write');
            await db.exec('COMMIT');
            assert.strictEqual(db.inTransaction, false);
        });

        it('works inside the transaction helper', async function () {
            await db.transaction(async () => {
                assert.strictEqual(db.inTransaction, true);
            });
            assert.strictEqual(db.inTransaction, false);
        });
    });

    describe('status, limits, location, memory', function () {
        it('db.status() reads counters by name and constant', async function () {
            await db.all('SELECT * FROM t');
            const hit = db.status('cacheHit');
            assert.ok(typeof hit.current === 'number');
            assert.ok(typeof hit.highwater === 'number');
            const byConstant = db.status(sqlite3.DBSTATUS_CACHE_HIT);
            assert.ok(typeof byConstant.current === 'number');
            assert.throws(() => db.status('bogus'), /unknown counter 'bogus'/);
        });

        it('db.limits reads every run-time limit', function () {
            const limits = db.limits;
            assert.strictEqual(limits.attached, 10);
            assert.strictEqual(limits.column, 2000);
            assert.ok(Number.isInteger(limits.length));
        });

        it('db.location() resolves attached paths', function () {
            assert.strictEqual(db.location(), '');
            assert.strictEqual(db.location('main'), '');
        });

        it('db.releaseMemory() returns a number', function () {
            assert.ok(typeof db.releaseMemory() === 'number');
        });
    });

    describe('complete() and compileOptions()', function () {
        it('complete() detects finished statements', function () {
            assert.strictEqual(sqlite3.complete('SELECT 1;'), true);
            assert.strictEqual(sqlite3.complete('SELECT'), false);
            assert.throws(() => sqlite3.complete(7), TypeError);
        });

        it('compileOptions() lists the build configuration', function () {
            const options = sqlite3.compileOptions();
            assert.ok(Array.isArray(options));
            assert.ok(options.includes('ENABLE_FTS5'));
            assert.ok(options.includes('ENABLE_SESSION'));
            assert.ok(options.includes('ENABLE_NORMALIZE'));
        });
    });

    describe('SQL accessors and per-statement integer mode', function () {
        it('expandedSQL substitutes the last bound values', async function () {
            const stmt = await db.prepare('SELECT * FROM t WHERE id = ?');
            await stmt.get(2);
            assert.strictEqual(
                stmt.expandedSQL,
                'SELECT * FROM t WHERE id = 2',
            );
            await stmt.finalize();
        });

        it('normalizedSQL folds literals to ?', async function () {
            const stmt = await db.prepare(
                "SELECT * FROM t WHERE v = 'x' AND id = 5",
            );
            assert.ok(stmt.normalizedSQL.includes('?'));
            assert.ok(!stmt.normalizedSQL.includes("'x'"));
            await stmt.finalize();
        });

        it('prepareSync accepts { integerMode }', function () {
            const stmt = db.prepareSync('SELECT 9223372036854775807 AS v', {
                integerMode: 'bigint',
            });
            assert.strictEqual(typeof stmt.getSync().v, 'bigint');
            stmt.finalize();
        });

        it('async prepare accepts { integerMode }', async function () {
            const stmt = await db.prepare('SELECT 9223372036854775807 AS v', {
                integerMode: 'bigint',
            });
            const row = await stmt.get();
            assert.strictEqual(typeof row.v, 'bigint');
            await stmt.finalize();
        });
    });
});
