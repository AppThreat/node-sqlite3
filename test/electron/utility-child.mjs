// The child side of the Electron utility-process test: a tiny database
// service. Forked by test/electron/main.mjs via utilityProcess.fork(),
// which gives this process a full Node environment with its own module
// registry and addon instances (this is why every per-environment
// constructor in the addon lives in instance data — a second
// environment loading the same .node must get its own).
//
// Protocol: {id, op: 'run'|'get', sql, params?} -> {id, ok, row?, err?}
// and {op: 'quit'} -> closes the connection and exits 0.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sqlite3 = (await import(pathToFileURL(join(root, 'lib', 'sqlite3.js'))))
    .default;

const db = new sqlite3.Database(':memory:');
const parent = process.parentPort;

parent.on('message', (e) => {
    const msg = e.data;
    if (msg.op === 'quit') {
        db.close(() => process.exit(0));
        return;
    }
    const settle = (err, row) => {
        if (err) {
            parent.postMessage({ id: msg.id, ok: false, err: err.message });
        } else {
            parent.postMessage({ id: msg.id, ok: true, row: row ?? null });
        }
    };
    const args = msg.params ? [...msg.params, settle] : [settle];
    if (msg.op === 'run') db.run(msg.sql, ...args);
    else if (msg.op === 'get') db.get(msg.sql, ...args);
});

db.on('open', () => {
    parent.postMessage({ event: 'ready' });
});
