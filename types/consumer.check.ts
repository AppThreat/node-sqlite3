// Consumer-side compile checks under strict + node16 resolution,
// complementing the type-identity assertions in sqlite3.check.ts:
// `await using` disposal, async
// iteration, generic propagation, and the negatives the marshalling
// rules promise (unsupported bind types, invalid configure literals).
// Any line marked @ts-expect-error MUST fail; the file fails to compile
// if one of them starts passing.

import type { Database, Row } from '../lib/sqlite3.js';
import sqlite3 from '../lib/sqlite3.js';

async function consumer(): Promise<void> {
    // open + await using: the promise-native lifecycle
    await using db: Database = await sqlite3.open('file.db');

    // Generic propagation: db.all<{a: number}> gives {a: number}[]
    const rows: { a: number }[] = await db.all<{ a: number }>('SELECT a');
    void rows;

    // untyped all: Row[]
    const untyped: Row[] = await db.all('SELECT a');
    void untyped;

    // iterate: AsyncIterableIterator<Row>
    const iterator = db.iterate('SELECT a');
    for await (const row of iterator) {
        const value: unknown = row.a;
        void value;
    }

    // using: sync prepare + sync dispose
    using stmt = db.prepareSync('SELECT a');
    const first: Row | undefined = stmt.getSync();
    void first;

    // statement transaction shape
    const count = await db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (?)', 1);
        return 42;
    });
    const check: number = count;
    void check;

    // --- Deliverable 11: open options, extension policy, attach paths ---

    // open() accepts flags or a v9 options object.
    const untrusted = await sqlite3.open('downloaded.db', {
        mode: sqlite3.OPEN_READONLY,
        untrusted: true,
    });
    await untrusted.close();
    const flagged = await sqlite3.open('file.db', sqlite3.OPEN_READWRITE);
    await flagged.close();

    // The constructor takes the same options object (namespace or named
    // export — both are the wrapper).
    const constructed = new sqlite3.Database(':memory:', {
        untrusted: true,
    });
    // @ts-expect-error untrusted is boolean
    const constructed2 = new sqlite3.Database(':memory:', {
        untrusted: 'yes',
    });
    void constructed;
    void constructed2;

    // The security configure options typecheck with their shapes.
    db.configure('extensionPolicy', { allow: ['/abs/ext.so'] });
    db.configure('extensionPolicy', { deny: true });
    db.configure('attachPaths', ['/abs/aux.db']);
    db.configure('attachPaths', null);
    // @ts-expect-error unknown policy key
    db.configure('extensionPolicy', { maybe: true });
    // @ts-expect-error attachPaths wants paths or null
    db.configure('attachPaths', 'nope');

    // --- Negatives: these must NOT compile -------------------------------

    // Symbol is not a BindValue (strict binding, Deliverable 02).
    // @ts-expect-error
    await db.run('SELECT ?', Symbol('nope'));

    // configure takes the documented literals only.
    // @ts-expect-error
    db.configure('integerMode', 'float');

    // @ts-expect-error
    db.on('nonexistent-event', () => undefined);

    // the constants are literal-typed; a wrong value is a type error.
    const flag: 1 = sqlite3.OPEN_READONLY;
    void flag;
    // @ts-expect-error
    const wrong: 2 = sqlite3.OPEN_READONLY;
    void wrong;

    // open() needs a filename.
    // @ts-expect-error
    await sqlite3.open();
}

void consumer;
