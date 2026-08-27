// Electron main-process harness for @appthreat/sqlite3 (Deliverable 10).
//
// Run with:  electron test/electron/main.mjs
//
// Two of the four Electron test cases live here — the load test (the
// deliverable's central claim: the Node-API prebuild loads in a real
// Electron main process with no rebuild) and the utility-process test
// (the recommended placement for database work in an Electron app).
// The bulk suite runs separately under ELECTRON_RUN_AS_NODE (see the
// test:electron script), and the packaged-ASAR cases live in
// test/electron/asar.mjs.
//
// Hand-rolled assert-and-exit rather than node:test's runner: the
// runner is a CLI that spawns process.execPath, which under Electron
// needs ELECTRON_RUN_AS_NODE and does not provide the app environment
// (app, utilityProcess) these cases exist to exercise.
//
// No top-level await on app.whenReady(): this file is loaded through
// Electron's default-app path (electron <file>), where ESM evaluation
// is asynchronous relative to app readiness and awaiting whenReady at
// module top level deadlocks. .then() chaining does not.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, utilityProcess } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const failures = [];
const passes = [];
function check(name, ok, detail = '') {
    (ok ? passes : failures).push(name);
    console.log(
        `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
    );
}

async function loadTest() {
    // PREBUILDS_ONLY makes node-gyp-build ignore a local build/
    // directory, so this proves the shipped prebuild loads — not a
    // dev rebuild. (Set by the test:electron script.)
    if (!existsSync(join(root, 'prebuilds'))) {
        check('prebuilds/ exists', false, 'run `pnpm run prebuild` first');
        return;
    }
    const sqlite3 = (
        await import(pathToFileURL(join(root, 'lib', 'sqlite3.js')))
    ).default;
    check(
        'addon loads in the Electron main process',
        typeof sqlite3?.Database === 'function',
        `sqlite3.VERSION=${sqlite3?.VERSION}`,
    );

    const db = new sqlite3.Database(':memory:');
    const row = await new Promise((resolve, reject) => {
        db.serialize();
        db.run('CREATE TABLE t (v TEXT)');
        db.run("INSERT INTO t VALUES ('electron-main')");
        db.get('SELECT v FROM t', (err, r) => (err ? reject(err) : resolve(r)));
        db.close();
    });
    check(
        'query round trip in the main process',
        row?.v === 'electron-main',
        `v=${row?.v}`,
    );
}

function utilityTest() {
    // utilityProcess.fork gives the child a full Node environment with
    // its own addon instances — exactly the "additional environment"
    // case the per-env AddonData slots exist for. Queries cross the
    // boundary as plain structured-clone messages.
    return new Promise((resolve) => {
        const child = utilityProcess.fork(join(here, 'utility-child.mjs'));

        let opened = false;
        let ranDdl = false;
        let selected = null;

        child.on('message', (msg) => {
            if (msg.event === 'ready') {
                opened = true;
                child.postMessage({
                    id: 1,
                    op: 'run',
                    sql: 'CREATE TABLE t (v TEXT)',
                });
            }
            if (msg.id === 1 && msg.ok) {
                ranDdl = true;
                child.postMessage({
                    id: 2,
                    op: 'get',
                    sql: 'SELECT ? AS who, (SELECT COUNT(*) FROM t) AS n',
                    params: ['utility'],
                });
            }
            if (msg.id === 2) {
                selected = msg;
                child.postMessage({ op: 'quit' });
            }
        });

        const timeout = setTimeout(() => {
            check('utility process completed', false, 'timed out after 20s');
            child.kill();
            resolve();
        }, 20000);

        child.once('exit', (code) => {
            clearTimeout(timeout);
            check('utility process opened the addon', opened);
            check(
                'utility process executed DDL',
                ranDdl && selected?.ok === true,
            );
            check(
                'utility process query result crosses the boundary',
                selected?.row?.who === 'utility' && selected?.row?.n === 0,
                JSON.stringify(selected?.row),
            );
            check('utility process exited cleanly', code === 0, `code=${code}`);
            resolve();
        });
    });
}

app.whenReady().then(async () => {
    try {
        await loadTest();
        await utilityTest();
    } catch (err) {
        check('harness ran without throwing', false, err?.stack ?? String(err));
    }
    console.log(
        `\n${passes.length} passed, ${failures.length} failed${failures.length ? `: ${failures.join('; ')}` : ''}`,
    );
    app.exit(failures.length === 0 ? 0 : 1);
});
