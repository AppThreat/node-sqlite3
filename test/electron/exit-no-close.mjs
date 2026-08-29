// Teardown probe, not an assertion: open a connection, use the API,
// and exit the process without closing anything. Exit status 0 is the
// pass condition — a segfault at environment teardown reports 139 and
// is invisible to every assertion that could run inside the process
// (the D08 musl segfault looked exactly like this).
//
// Runs under both runtimes:
//   node    test/electron/exit-no-close.mjs
//   electron test/electron/exit-no-close.mjs   (main process)
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const inElectronMain = Boolean(process.versions.electron);

async function run() {
    const sqlite3 = (
        await import(pathToFileURL(join(root, 'lib', 'sqlite3.js')))
    ).default;
    const db = new sqlite3.Database(':memory:');
    await db.exec('CREATE TABLE t (v TEXT)');
    await db.run('INSERT INTO t VALUES (?)', 'left open on purpose');
    const row = await db.get('SELECT COUNT(*) AS n FROM t');
    if (row?.n !== 1) throw new Error(`unexpected count ${row?.n}`);

    // Also leave a live connection on a worker environment when
    // available, wait until it reports itself live, then exit with
    // everything open.
    if (typeof Worker === 'function') {
        await new Promise((resolve) => {
            const w = new Worker(
                new URL('exit-no-close-worker.mjs', import.meta.url),
            );
            const giveUp = setTimeout(resolve, 5000);
            w.onmessage = () => {
                clearTimeout(giveUp);
                resolve();
            };
            w.onerror = () => {
                clearTimeout(giveUp);
                resolve();
            };
        });
    }

    console.log(
        `EXITING_WITHOUT_CLOSE runtime=${inElectronMain ? `electron ${process.versions.electron}` : `node ${process.versions.node}`}`,
    );
    process.exit(0);
}

// No top-level await on app.whenReady() under Electron: this probe runs
// via `electron <file>` (the default-app path), where ESM evaluation is
// asynchronous relative to app readiness and awaiting whenReady at
// module top level deadlocks (see test/electron/main.mjs).
if (inElectronMain) {
    const { app } = await import('electron');
    app.whenReady()
        .then(run)
        .catch((err) => {
            console.error(err?.stack ?? String(err));
            process.exit(1);
        });
} else {
    await run();
}
