// serializeToBytes / deserializeFromBytes (Deliverable 08): round trips
// of real data (the marshalling corpus: integers including unsafe ones,
// floats, text, blobs, nulls), the copy semantics, corrupt input, the
// readonly/resizable options, and the naming discipline (serialize means
// FIFO ordering, the byte form is serializeToBytes).
import assert from 'node:assert';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('serializeToBytes / deserializeFromBytes', function () {
    it('round-trips a database with every value shape', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec(`
            CREATE TABLE t (
                id INTEGER PRIMARY KEY,
                n REAL,
                s TEXT,
                b BLOB
            );
        `);
        const big = 9007199254740993n; // 2^53 + 1, unsafe as a number
        await db.run(
            'INSERT INTO t VALUES (?, ?, ?, ?)',
            1,
            1.5,
            'héllo',
            new Uint8Array([1, 2, 3, 0, 255]),
        );
        await db.run('INSERT INTO t VALUES (?, ?, ?, ?)', 2, null, null, null);
        await db.run(
            'INSERT INTO t VALUES (?, ?, ?, ?)',
            3,
            -0.0,
            '',
            new Uint8Array(0),
        );
        // An unsafe integer rowid, stored exactly through the bigint
        // bind.
        await db.run('INSERT INTO t (id, n) VALUES (?, ?)', big, 0);
        db.configure('integerMode', 'mixed');

        const bytes = await db.serializeToBytes();
        assert.ok(bytes instanceof Uint8Array, 'returns a Uint8Array');
        assert.ok(!Buffer.isBuffer(bytes), 'not a Buffer');
        assert.ok(bytes.length > 0);
        // A serialized database starts with the SQLite magic.
        assert.strictEqual(
            Buffer.from(bytes.buffer, bytes.byteOffset, 16).toString('latin1'),
            'SQLite format 3\u0000',
        );

        const copy = await sqlite3.deserializeFromBytes(bytes);
        copy.configure('integerMode', 'mixed');
        const rows = await copy.all('SELECT * FROM t ORDER BY id');
        assert.strictEqual(rows.length, 4);
        // (Blobs read back as Buffer — the established read-side type.)
        assert.deepStrictEqual(
            rows.map((r) => [typeof r.id, r.n, r.s, r.b?.length]),
            [
                ['number', 1.5, 'héllo', 5],
                ['number', null, null, undefined],
                ['number', 0, '', 0], // -0.0 stores as 0
                ['bigint', 0, null, undefined],
            ],
        );
        assert.deepStrictEqual([...rows[0].b], [1, 2, 3, 0, 255]);
        // The unsafe rowid survived the round trip exactly.
        assert.strictEqual(rows[3].id, big);
        await copy.close();
        await db.close();
    });

    it('round-trips a 10k-row database with identical queries', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        await db.transaction(async () => {
            const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
            for (let i = 1; i <= 10000; i++) {
                await stmt.run(i, `row-${i}`);
            }
            await stmt.finalize();
        });

        const bytes = await db.serializeToBytes();
        const copy = await sqlite3.deserializeFromBytes(bytes);
        assert.strictEqual(
            (await copy.get('SELECT count(*) c FROM t')).c,
            10000,
        );
        assert.deepStrictEqual(
            await copy.all('SELECT * FROM t WHERE id % 997 = 0 ORDER BY id'),
            await db.all('SELECT * FROM t WHERE id % 997 = 0 ORDER BY id'),
        );
        assert.deepStrictEqual(
            await copy.all('SELECT v FROM t ORDER BY RANDOM() LIMIT 0'),
            [],
        );
        await copy.close();
        await db.close();
    });

    it('deserializeFromBytes copies — the input stays usable afterwards', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec(
            "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('before')",
        );
        const bytes = await db.serializeToBytes();
        await db.close();

        const copy = await sqlite3.deserializeFromBytes(bytes);
        // Mutating the source bytes must not affect the deserialized db.
        bytes.fill(0);
        assert.strictEqual((await copy.get('SELECT v FROM t')).v, 'before');
        await copy.close();
    });

    it('deserializeFromBytes on corrupt bytes rejects with SQLITE_NOTADB', {
        timeout: 30000,
    }, async function () {
        const garbage = new Uint8Array(4096);
        for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 7) & 0xff;
        await assert.rejects(
            () => sqlite3.deserializeFromBytes(garbage),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_NOTADB');
                assert.strictEqual(err.errno, sqlite3.NOTADB);
                return true;
            },
        );
        // Truncated-but-valid-header input also fails, not crashes.
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (v)');
        const bytes = await db.serializeToBytes();
        await db.close();
        await assert.rejects(
            () => sqlite3.deserializeFromBytes(bytes.subarray(0, 100)),
            (err) => err instanceof Error,
        );
    });

    it('readOnly rejects writes; resizable lets the copy grow', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (v)');
        const bytes = await db.serializeToBytes();
        await db.close();

        const ro = await sqlite3.deserializeFromBytes(bytes, {
            readOnly: true,
        });
        await assert.rejects(
            () => ro.run("INSERT INTO t VALUES ('x')"),
            (err) => err.primaryCode === 'SQLITE_READONLY',
        );
        await ro.close();

        const rw = await sqlite3.deserializeFromBytes(bytes, {
            resizable: true,
        });
        for (let i = 0; i < 200; i++) {
            await rw.run('INSERT INTO t VALUES (?)', `row-${i}`);
        }
        assert.strictEqual((await rw.get('SELECT count(*) c FROM t')).c, 200);
        // Growth survives a second round trip.
        const grown = await rw.serializeToBytes();
        const again = await sqlite3.deserializeFromBytes(grown);
        assert.strictEqual(
            (await again.get('SELECT count(*) c FROM t')).c,
            200,
        );
        await rw.close();
        await again.close();
    });

    it('a deserialized db is a normal connection (events, close, transactions)', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (v)');
        const bytes = await db.serializeToBytes();
        await db.close();

        const copy = await sqlite3.deserializeFromBytes(bytes);
        const commits = [];
        copy.on('commit', () => commits.push(1));
        await copy.transaction(async () => {
            await copy.run("INSERT INTO t VALUES ('in tx')");
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEqual(commits.length, 1);
        assert.strictEqual((await copy.get('SELECT count(*) c FROM t')).c, 1);
        await copy.close();
    });

    it('serializeToBytes takes the schema name', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (v)');
        // serializing a nonexistent schema is an error, not a crash
        await assert.rejects(
            () => db.serializeToBytes('nosuch'),
            (err) => err instanceof Error,
        );
        await db.close();
    });

    it('accepts ArrayBuffer and DataView inputs, honouring offsets', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec("CREATE TABLE t (v); INSERT INTO t VALUES ('data')");
        const bytes = await db.serializeToBytes();
        await db.close();

        // The bytes embedded at an offset inside a larger buffer.
        const padded = new Uint8Array(bytes.length + 16);
        padded.set(bytes, 16);
        const asDataView = new DataView(padded.buffer, 16, bytes.length);
        const copy = await sqlite3.deserializeFromBytes(asDataView);
        assert.strictEqual((await copy.get('SELECT v FROM t')).v, 'data');
        await copy.close();
    });

    it('keeps the FIFO serialize() name distinct from serializeToBytes()', async function () {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE t (v)');
        // serialize() is still the FIFO-ordering control, returning this.
        assert.strictEqual(db.serialize(), db);
        assert.strictEqual(db.parallelize(), db);
        // serializeToBytes is the byte snapshot, returning bytes.
        const bytes = await db.serializeToBytes();
        assert.ok(bytes instanceof Uint8Array);
        await db.close();
    });
});
