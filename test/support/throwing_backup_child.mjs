// Child scenario for the Backup CallGuard regression test
// (test/state_machine.test.js). Runs in its own process because a
// deliberate throw from a native async callback surfaces as an
// uncaughtException, which node:test attributes to the running test even
// when a user listener absorbs it.
//
// Signals on stdout (one per line):
//   GETSYNC_OK / GETSYNC_FAIL:<message> — the sync fast path after the throw
//   CLOSE_OK / CLOSE_TIMEOUT            — db.close() completing afterwards
// Exit status is 0 only when both succeeded.
import path from 'node:path';

import sqlite3 from '../../lib/sqlite3.js';

process.on('uncaughtException', (err) => {
    console.log(`UNCAUGHT:${err.message}`);
});

const exit = setTimeout(() => {
    console.log('CLOSE_TIMEOUT');
    process.exit(1);
}, 15000);
exit.unref?.();

const db = await sqlite3.open(':memory:');
await db.exec('CREATE TABLE t (a INT); INSERT INTO t VALUES (1),(2)');

const backup = db.backup(
    path.join(
        import.meta.dirname,
        '..',
        'tmp',
        `backup-throw-${process.pid}.db`,
    ),
);
backup.step(-1, function () {
    throw new Error('step callback boom');
});

await new Promise((resolve) => setTimeout(resolve, 100));

try {
    const row = db.getSync('SELECT 1 AS x');
    if (row && row.x === 1) {
        console.log('GETSYNC_OK');
    } else {
        console.log(`GETSYNC_FAIL:unexpected row ${JSON.stringify(row)}`);
        process.exit(1);
    }
} catch (err) {
    console.log(`GETSYNC_FAIL:${err.message}`);
    process.exit(1);
}

try {
    await db.close();
    console.log('CLOSE_OK');
    process.exit(0);
} catch (err) {
    console.log(`CLOSE_FAIL:${err.message}`);
    process.exit(1);
}
