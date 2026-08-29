// Opens a connection, uses the changeset iterator, and deliberately
// never closes anything, so the wrappers are torn down by the
// environment rather than by an explicit close.
//
// The addon's class constructors have to live in per-environment
// instance data for that to be safe: node-addon-api deletes instance
// data while the environment is still alive, whereas a file-static
// Napi::Reference is destroyed at process exit, after the environment is
// gone, and its napi_delete_reference then lands on a dead env. That
// segfaulted at exit on musl (glibc and macOS tolerated it), so this
// child asserts almost nothing and exists for its exit status.
//
// The connection is left with nothing else holding a reference on it: a
// session or blob kept open changes the finalization order and hides the
// crash, so this stays deliberately plain.
import sqlite3 from '../../lib/sqlite3.js';

const setup = await sqlite3.open(':memory:');
await setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v)');
const session = setup.session();
await setup.run('INSERT INTO t VALUES (1, ?)', ['x']);
const changeset = await session.changeset();
await session.close();

// Touch the changeset iterator: its constructor was the reference that
// outlived the environment.
const ops = [...sqlite3.iterateChangeset(changeset)];
if (ops.length !== 1) {
    console.log('UNEXPECTED-OPS', ops.length);
    process.exit(2);
}
await setup.close();

// Now the case that actually reproduces it: a live connection at exit.
new sqlite3.Database(':memory:');

console.log('CHILD-EXITING');
