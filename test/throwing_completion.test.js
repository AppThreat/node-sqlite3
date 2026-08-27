import assert from 'node:assert';
import { describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

// A throwing completion callback on a database-level exclusive operation
// (open/exec/close/loadExtension) must not wedge the connection. The
// completions end by draining the database queue (Process()); the JS
// callback fires first, and when it throws TRY_CATCH_CALL returns early —
// so the drain must run from a guard (Database::ProcessGuard, the same
// discipline as Statement::CallGuard). Without it, everything queued
// behind the exclusive call stays queued forever and every later call on
// the connection never settles.
//
// The pending exception from the throwing callback surfaces as an
// uncaughtException at the next tick boundary, so each test follows the
// test/sync.test.js "sync fast path after a throwing callback" pattern:
// detach node:test's uncaught handlers, capture the throw, assert the
// connection stayed live, restore the handlers.
function withCapturedThrow(message, run) {
    return new Promise((resolve, reject) => {
        const savedHandlers = process.listeners('uncaughtException');
        process.removeAllListeners('uncaughtException');

        let restored = false;
        const restore = () => {
            if (restored) return;
            restored = true;
            process.removeAllListeners('uncaughtException');
            for (const h of savedHandlers) process.on('uncaughtException', h);
        };

        process.once('uncaughtException', (err) => {
            if (!(err instanceof Error) || err.message !== message) {
                restore();
                return reject(
                    new Error(`unexpected uncaught exception: ${err?.message}`),
                );
            }
            // Give the drained queue a moment: the work queued behind the
            // exclusive call needs a worker round trip to settle.
            setTimeout(() => {
                restore();
                resolve();
            }, 150);
        });

        run().catch((err) => {
            restore();
            reject(err);
        });
    });
}

describe('throwing completion callbacks', () => {
    it('exec: a throwing completion callback does not wedge the connection', (_t, done) => {
        const db = new sqlite3.Database(':memory:');
        let settled = false;

        withCapturedThrow('boom from exec', async () => {
            // Queued behind the exec: this is what the guard must
            // dispatch when the exec completion callback throws.
            db.exec('CREATE TABLE t (i)', () => {
                throw new Error('boom from exec');
            });
            db.get('SELECT COUNT(*) AS n FROM sqlite_master', (err, row) => {
                // n === 1: the table the exec created — proves both that
                // the exec ran and that this query settled.
                if (!err) settled = row && row.n === 1;
            });
        })
            .then(() => {
                assert.strictEqual(
                    settled,
                    true,
                    'the query queued behind the throwing exec never settled',
                );
                db.close(done);
            })
            .catch((err) => done(err));
    });

    it('loadExtension: a throwing completion callback does not wedge the connection', (_t, done) => {
        const db = new sqlite3.Database(':memory:', (err) => {
            assert.ifError(err);
            let settled = false;

            withCapturedThrow('boom from loadExtension', async () => {
                // The load fails (no such file) and the error branch
                // fires the throwing callback — the same TRY_CATCH_CALL
                // early return as the success path.
                db.loadExtension('/nonexistent/ext.dylib', () => {
                    throw new Error('boom from loadExtension');
                });
                db.get('SELECT 1 AS v', (err2, row) => {
                    if (!err2) settled = row && row.v === 1;
                });
            })
                .then(() => {
                    assert.strictEqual(
                        settled,
                        true,
                        'the query queued behind the throwing loadExtension never settled',
                    );
                    db.close(done);
                })
                .catch((err3) => done(err3));
        });
    });

    it('open: a throwing open callback does not wedge the connection', (_t, done) => {
        let settled = false;

        withCapturedThrow('boom from open', async () => {
            const db = new sqlite3.Database(':memory:', () => {
                throw new Error('boom from open');
            });
            // Queued behind the open by construction: it was scheduled
            // while the connection was still Opening.
            db.get('SELECT 1 AS v', (err, row) => {
                if (!err) settled = row && row.v === 1;
            });
            setTimeout(() => {
                db.close(() => {
                    // nothing to assert; just release the handle
                });
            }, 100);
        })
            .then(() => {
                assert.strictEqual(
                    settled,
                    true,
                    'the query queued behind the throwing open never settled',
                );
                done();
            })
            .catch((err) => done(err));
    });

    it('close: a throwing close callback fails the work queued behind it', (_t, done) => {
        const db = new sqlite3.Database(':memory:', (err) => {
            assert.ifError(err);
            let settled = false;

            withCapturedThrow('boom from close', async () => {
                // Queued behind the close: scheduled while the close is
                // still Closing, so it can only be failed by the drain
                // after the close completes.
                db.close(() => {
                    throw new Error('boom from close');
                });
                db.get('SELECT 1 AS v', (err2) => {
                    // The connection is closed: the call must settle
                    // with the closed-database error, not hang forever.
                    settled = err2 && err2.code === 'SQLITE_MISUSE';
                });
            })
                .then(() => {
                    assert.strictEqual(
                        settled,
                        true,
                        'the query queued behind the throwing close never settled',
                    );
                    done();
                })
                .catch((err3) => done(err3));
        });
    });
});
