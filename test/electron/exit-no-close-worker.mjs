// Worker half of the exit-without-close teardown probe: opens its own
// connection in a worker_threads environment and never closes it. The
// main script exits the process while this connection is live.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sqlite3 = (await import(pathToFileURL(join(root, 'lib', 'sqlite3.js'))))
    .default;

const db = new sqlite3.Database(':memory:');
await db.exec('CREATE TABLE w (v TEXT)');
await db.run("INSERT INTO w VALUES ('worker connection left open')");
parentPort?.postMessage('worker-connection-live');
