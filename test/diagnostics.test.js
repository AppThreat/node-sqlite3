import assert from 'node:assert';
import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// Phase 6: the diagnostics_channel query spans.

// Spans are delivered through a uv_async handle, so they arrive on a
// later loop turn — not necessarily the next one. A single setImmediate
// happened to be enough on macOS and was not on Windows; poll instead.
/**
 * @param {() => boolean} predicate the condition to wait for.
 * @param {string} what described in the timeout message.
 * @returns {Promise<void>} resolves once the predicate holds.
 */
async function waitFor(predicate, what) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe('diagnostics_channel', function () {
    /** @type {sqlite3.Database} */
    let db;

    beforeEach(async function () {
        db = new sqlite3.Database(':memory:');
        await db.exec('CREATE TABLE t (a)');
    });

    afterEach(async function () {
        await db.close();
    });

    it('publishes query spans while subscribed and stops after', async function () {
        /** @type {any[]} */
        const spans = [];
        const unsubscribe = sqlite3.subscribeQueries((span) =>
            spans.push(span),
        );
        try {
            await db.get('SELECT * FROM t');
            await db.run('INSERT INTO t VALUES (1)');
            await waitFor(() => spans.length >= 2, 'two query spans');
            assert.strictEqual(spans.length, 2);
            assert.strictEqual(spans[0].sql, 'SELECT * FROM t');
            assert.strictEqual(spans[0].database, db);
            assert.ok(typeof spans[0].durationMs === 'number');
            assert.ok(typeof spans[0].duration === 'bigint');
        } finally {
            unsubscribe();
        }
        const before = spans.length;
        await db.get('SELECT 1');
        // Nothing should arrive; give it the same grace a span would get.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.strictEqual(spans.length, before);
    });

    it('coexists with a profile listener the application registered', async function () {
        /** @type {string[]} */
        const mine = [];
        /** @type {any[]} */
        const spans = [];
        const listener = (/** @type {string} */ sql) => mine.push(sql);
        db.on('profile', listener);
        db.configure('profile', true);

        const unsubscribe = sqlite3.subscribeQueries((span) =>
            spans.push(span),
        );
        await db.get('SELECT 1 AS v');
        await waitFor(
            () => spans.length >= 1 && mine.length >= 1,
            'the span and the application listener',
        );
        // Arming used to bail out whenever any 'profile' listener existed,
        // which made subscribeQueries silently publish nothing.
        assert.strictEqual(spans.length, 1);
        assert.strictEqual(mine.length, 1);

        unsubscribe();
        // ... and unsubscribing used to removeAllListeners('profile'),
        // taking the application's listener with it.
        assert.strictEqual(db.listenerCount('profile'), 1);
        await db.get('SELECT 2 AS v');
        await waitFor(() => mine.length >= 2, "the application's second span");
        assert.strictEqual(mine.length, 2);
        assert.strictEqual(spans.length, 1);
        db.removeListener('profile', listener);
    });

    it('does not pin connections that are never closed', async function () {
        // The registry that lets a late subscriber arm existing
        // connections holds them weakly; a strong Set leaked the
        // connection, its sqlite handle and its file descriptor.
        const { execFileSync } = await import('node:child_process');
        const script = `
            import sqlite3 from './lib/sqlite3.js';
            const tick = () => new Promise((r) => setTimeout(r, 20));
            let collected = 0;
            const registry = new FinalizationRegistry(() => collected++);
            for (let i = 0; i < 20; i++) {
                const db = await sqlite3.open(':memory:');
                registry.register(db, i);
                await db.get('SELECT 1');
            }
            global.gc(); await tick(); global.gc(); await tick(); global.gc();
            await tick();
            // String() on purpose: newer Node (24.21+) styles a NUMBER
            // passed to console.log with ANSI when color is forced (as it
            // is under pnpm/CI), and the parent Number()-parses this
            // output. A string prints verbatim.
            console.log(String(collected));
        `;
        const out = execFileSync(
            process.execPath,
            ['--expose-gc', '--input-type=module', '-e', script],
            { encoding: 'utf8', cwd: new URL('..', import.meta.url) },
        );
        // Belt and braces: parse the digit run, ignoring any styling
        // escapes around it.
        const collectedCount = Number(out.match(/\d+/)?.[0] ?? '0');
        assert.ok(
            collectedCount >= 19,
            `only ${collectedCount} of 20 unclosed connections were collected`,
        );
    });

    it('mirrors onto the node:sqlite channel name', async function () {
        /** @type {any[]} */
        const mirrored = [];
        const onMessage = (message) => mirrored.push(message);
        diagnostics_channel.subscribe('sqlite.db.query', onMessage);
        const unsubscribe = sqlite3.subscribeQueries(() => undefined);
        try {
            await db.get('SELECT 42 AS v');
            await waitFor(() => mirrored.length >= 1, 'the mirrored span');
            assert.strictEqual(mirrored.length, 1);
            assert.strictEqual(mirrored[0].sql, 'SELECT 42 AS v');
            assert.ok(typeof mirrored[0].duration === 'bigint');
        } finally {
            unsubscribe();
            diagnostics_channel.unsubscribe('sqlite.db.query', onMessage);
        }
    });

    it('a late subscriber arms an existing connection', async function () {
        /** @type {any[]} */
        const spans = [];
        const unsubscribe = sqlite3.subscribeQueries((span) =>
            spans.push(span),
        );
        try {
            await db.all('SELECT 1');
            await waitFor(() => spans.length >= 1, 'the late subscriber span');
            assert.strictEqual(spans.length, 1);
        } finally {
            unsubscribe();
        }
    });

    it('flushQuerySpans() delivers the span of a query just awaited', async function () {
        // Spans ride a uv_async queue, so `await db.all(...)` returns
        // before the span for that query has been dispatched: reading the
        // collected spans right there saw nothing at all. The flush is the
        // documented drain point.
        /** @type {string[]} */
        const spans = [];
        const unsubscribe = sqlite3.subscribeQueries((span) =>
            spans.push(span.sql),
        );
        try {
            await db.all('SELECT 11 AS v');
            sqlite3.flushQuerySpans();
            assert.deepStrictEqual(spans, ['SELECT 11 AS v']);
            // Idempotent: a second flush has nothing left to deliver.
            sqlite3.flushQuerySpans();
            assert.deepStrictEqual(spans, ['SELECT 11 AS v']);
        } finally {
            unsubscribe();
        }
        // A no-op with nothing subscribed.
        sqlite3.flushQuerySpans();
    });

    it('unsubscribe delivers pending spans instead of losing them', async function () {
        /** @type {string[]} */
        const spans = [];
        const unsubscribe = sqlite3.subscribeQueries((span) =>
            spans.push(span.sql),
        );
        await db.all('SELECT 12 AS v');
        // The reported race: unsubscribing immediately after the await
        // used to drop the span for the awaited query.
        unsubscribe();
        assert.deepStrictEqual(spans, ['SELECT 12 AS v']);
        // And nothing arrives afterwards.
        await db.all('SELECT 13 AS v');
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepStrictEqual(spans, ['SELECT 12 AS v']);
    });

    it('validates the listener', function () {
        assert.throws(() => sqlite3.subscribeQueries(7), TypeError);
    });

    it('a throwing consumer does not break the query', async function () {
        const unsubscribe = sqlite3.subscribeQueries(() => {
            throw new Error('consumer bug');
        });
        try {
            const row = await db.get('SELECT 7 AS v');
            assert.strictEqual(row.v, 7);
        } finally {
            unsubscribe();
        }
    });
});
