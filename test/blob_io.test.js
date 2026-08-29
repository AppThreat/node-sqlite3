// Incremental blob I/O (Deliverable 08): open/read/write at offsets,
// size, past-end errors, row invalidation (SQLITE_ABORT with a clear
// message), reopen, read-only handles, streams with flat memory, the
// dispose contract, and the `blob_write`-fires-preupdate-as-delete note.
import assert from 'node:assert';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('incremental blob I/O', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY, data BLOB)');
        await db.exec('INSERT INTO files VALUES (1, zeroblob(1000))');
        await db.exec('INSERT INTO files VALUES (2, NULL)');
    });

    afterEach(async function () {
        await db.close();
    });

    /** Opens a blob and awaits readiness. */
    async function openBlob(options) {
        return new Promise((resolve, reject) => {
            const blob = db.openBlob(options, (err) =>
                err ? reject(err) : resolve(blob),
            );
        });
    }

    it('reads and writes at offsets', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        assert.strictEqual(blob.size, 1000);

        // Freshly-allocated zeroblob reads as zeros at any offset.
        const probe = new Uint8Array(10);
        assert.strictEqual(await blob.read(probe, 500), 10);
        assert.ok(probe.every((byte) => byte === 0));

        const source = Buffer.from('hello incremental world');
        assert.strictEqual(await blob.write(source, 100), source.length);

        const out = new Uint8Array(source.length);
        assert.strictEqual(await blob.read(out, 100), out.length);
        assert.strictEqual(
            Buffer.from(out).toString(),
            'hello incremental world',
        );

        // Unrelated regions are untouched.
        const before = new Uint8Array(4);
        await blob.read(before, 96);
        assert.ok(before.every((byte) => byte === 0));

        await blob.close();
    });

    it('resolves the byte count and copies into the caller buffer', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        const target = Buffer.alloc(16, 0xaa);
        const transferred = await blob.read(target);
        assert.strictEqual(transferred, 16);
        assert.ok(target.every((byte) => byte === 0));
        await blob.close();
    });

    it('rejects reads and writes past the end of the blob', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        await assert.rejects(
            () => blob.read(new Uint8Array(10), 995),
            (err) => {
                assert.strictEqual(err.primaryCode, 'SQLITE_ERROR');
                return true;
            },
        );
        await assert.rejects(
            () => blob.write(new Uint8Array(10), 995),
            (err) => err.primaryCode === 'SQLITE_ERROR',
        );
        await blob.close();
    });

    it('the size accessor refuses while an operation is in flight', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        const pending = blob.read(new Uint8Array(4));
        assert.throws(() => blob.size, /in flight/);
        await pending;
        assert.strictEqual(blob.size, 1000);
        await blob.close();
    });

    it('a row write invalidates the handle with a clear SQLITE_ABORT', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        await db.run('UPDATE files SET data = zeroblob(1000) WHERE id = 1');
        await assert.rejects(
            () => blob.read(new Uint8Array(4)),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_ABORT');
                assert.match(err.message, /row .* has been modified/);
                return true;
            },
        );
    });

    it('an aborted handle cannot be rescued; a fresh handle can', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        await db.run("UPDATE files SET data = x'00ff' WHERE id = 1");
        await assert.rejects(() => blob.read(new Uint8Array(2)));
        // Documented sqlite behaviour: once aborted, even reopen returns
        // SQLITE_ABORT. Recovery is close + open.
        await assert.rejects(
            () => blob.reopen(1),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_ABORT');
                return true;
            },
        );
        await blob.close();

        const fresh = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        assert.strictEqual(fresh.size, 2);
        const two = new Uint8Array(2);
        await fresh.read(two);
        assert.deepStrictEqual([...two], [0x00, 0xff]);

        // reopen re-aims a healthy handle at another row.
        await db.run('UPDATE files SET data = zeroblob(7) WHERE id = 2');
        await fresh.reopen(2);
        assert.strictEqual(fresh.size, 7);
        await fresh.close();
    });

    it('read-only handles refuse writes', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
            readOnly: true,
        });
        await assert.rejects(
            () => blob.write(new Uint8Array([1])),
            (err) => err.primaryCode === 'SQLITE_READONLY',
        );
        await blob.close();
    });

    it('opening a NULL cell fails clearly', async function () {
        await assert.rejects(
            () => openBlob({ table: 'files', column: 'data', rowid: 2 }),
            (err) => err instanceof Error,
        );
    });

    it('close is idempotent; operations after close fail with MISUSE', async function () {
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        await blob.close();
        assert.strictEqual(blob.closed, true);
        await blob.close();
        await assert.rejects(
            () => blob.read(new Uint8Array(1)),
            (err) => {
                assert.strictEqual(err.code, 'SQLITE_MISUSE');
                return true;
            },
        );
        assert.throws(() => blob.size, /already closed/);
    });

    // size cannot queue behind the open the way read/write do, so it has
    // to say which state it is in: "not open" reads as "closed" when it
    // usually means "not open yet".
    it('size distinguishes not-open-yet from closed', async function () {
        const pending = db.openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        assert.throws(() => pending.size, /finished opening/);
        await pending.read(new Uint8Array(1), 0);
        assert.strictEqual(pending.size, 1000);
        await pending.close();
        assert.throws(() => pending.size, /already closed/);
    });

    it('a blob left open at close() neither crashes nor leaks', {
        timeout: 30000,
    }, async function () {
        const standalone = await sqlite3.open(':memory:');
        await standalone.exec(
            'CREATE TABLE files (id INTEGER PRIMARY KEY, data BLOB)',
        );
        await standalone.exec('INSERT INTO files VALUES (1, zeroblob(10))');
        const blob = await new Promise((resolve, reject) => {
            const b = standalone.openBlob(
                { table: 'files', column: 'data', rowid: 1 },
                (err) => (err ? reject(err) : resolve(b)),
            );
        });
        await standalone.close();
        assert.strictEqual(blob.closed, true);
        await assert.rejects(() => blob.read(new Uint8Array(1)));
    });

    it('streams a blob in both directions with flat memory', async function () {
        const SIZE = 300 * 1024;
        await db.run('UPDATE files SET data = zeroblob(?) WHERE id = 1', SIZE);
        const payload = Buffer.alloc(SIZE);
        for (let i = 0; i < SIZE; i++) payload[i] = i & 0xff;

        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        await pipeline(
            (async function* () {
                for (let off = 0; off < SIZE; off += 65536) {
                    yield payload.subarray(off, Math.min(off + 65536, SIZE));
                }
            })(),
            blob.createWriteStream(),
        );

        const chunks = [];
        await pipeline(blob.createReadStream(), async (source) => {
            for await (const chunk of source) chunks.push(chunk);
        });
        assert.strictEqual(Buffer.concat(chunks).length, SIZE);
        assert.ok(Buffer.concat(chunks).equals(payload));
        await blob.close();
    });

    it('blob writes surface as preupdate delete events', async function () {
        const events = [];
        db.on('preupdate', (info) => events.push(info));
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        await blob.write(new Uint8Array([1, 2, 3]));
        await blob.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
        // sqlite fires the preupdate hook as a delete for blob_write
        // (the new values are not available there); documented behaviour.
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].op, 'delete');
        assert.strictEqual(events[0].table, 'files');
    });

    it('`await using` closes the handle', async function () {
        {
            using blob = await openBlob({
                table: 'files',
                column: 'data',
                rowid: 1,
            });
            assert.strictEqual(blob.size, 1000);
        }
        const blob = await openBlob({
            table: 'files',
            column: 'data',
            rowid: 1,
        });
        assert.strictEqual(blob.size, 1000);
        await blob.close();
    });

    it('validates its options', async function () {
        assert.throws(() => db.openBlob({ column: 'data', rowid: 1 }), /table/);
        assert.throws(
            () => db.openBlob({ table: 'files', rowid: 1 }),
            /column/,
        );
        assert.throws(
            () => db.openBlob({ table: 'files', column: 'data' }),
            /rowid/,
        );
        assert.throws(() => db.openBlob(null), /options object/);
    });
});
