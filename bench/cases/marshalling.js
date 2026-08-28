// Marshalling cases (Deliverable 13 §2.2): each value type in isolation,
// read as a single column so per-op cost is per-value conversion. This is
// the regression guard for the Deliverable 02/03b marshalling work — the
// hottest code in the addon (GetRow/RowToJS/CellToJS).
//
// Integer modes get three connections because configure('integerMode')
// is per-connection and the modes must not contaminate each other's
// numbers. All connections enable the statement cache: allSync on a
// cached statement is the purest read path this package has.
//
// Allocation is measured for every case here (alloc: true): the
// marshalling work is fundamentally about allocation, and external
// buffers (blobs >= 4096 bytes become zero-copy external buffers in
// CellToJS, src/convert.cc) do not show up in heapUsed at all — watch
// the `external` and `arrayBuffers` counters for those.

/** @typedef {import('../harness.js').CaseSpec} CaseSpec */

/**
 * One single-column marshalling case.
 *
 * @param {string} name case name.
 * @param {any} db connection to read on (cache enabled).
 * @param {string} table table name (single column `v`).
 * @param {number} rows row count.
 * @returns {CaseSpec} the case.
 */
function colCase(name, db, table, rows) {
    const sql = `SELECT v FROM ${table}`;
    return {
        name,
        group: 'marshalling',
        ops: rows,
        iter: (_env, n) => {
            for (let i = 0; i < n; i++) {
                const out = db.allSync(sql);
                if (out.length !== rows) throw new Error('bad row count');
            }
        },
        alloc: true,
        allocIter: (env, n) => {
            for (let i = 0; i < n; i++) {
                env.keep = db.allSync(sql);
            }
        },
    };
}

/**
 * Builds the marshalling cases on the given connections.
 *
 * @param {{ number: any, mixed: any, bigint: any }} dbs one cache-enabled connection per integer mode.
 * @returns {CaseSpec[]} the marshalling cases.
 */
export function marshallingCases(dbs) {
    const db = dbs.number;

    /** @param {string} cols @param {string} table */
    const make = (table, cols, rows) => {
        db.exec(`CREATE TABLE ${table} (v)`);
        db.exec(
            `INSERT INTO ${table} SELECT ${cols} FROM (WITH RECURSIVE cnt(x) AS ` +
                `(SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < ${rows}) SELECT x FROM cnt)`,
        );
    };

    const floatCols = 'x + 0.5';
    const shortTextCols = "'short-' || x";
    const longTextCols = "printf('%4096s', '') || x";
    const unicodeCols = "'説明コード🌟パフォーマンス' || x";
    const nullCols = 'NULL';
    const blob = (n) => `zeroblob(${n})`;

    // The int-mode tables exist on all three connections.
    for (const modeDb of [dbs.number, dbs.mixed, dbs.bigint]) {
        modeDb.exec('CREATE TABLE m_int (v)');
        modeDb.exec(
            'INSERT INTO m_int SELECT x FROM (WITH RECURSIVE cnt(x) AS ' +
                '(SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 20000) SELECT x FROM cnt)',
        );
        modeDb.cacheStatements();
    }

    make('m_float', floatCols, 20000);
    make('m_shorttext', shortTextCols, 20000);
    make('m_longtext', longTextCols, 20000);
    make('m_unicode', unicodeCols, 20000);
    make('m_null', nullCols, 20000);
    make('m_blob64', blob(64), 20000);
    // 4095/4096 straddle the external-buffer boundary in CellToJS:
    // < 4096 copies, >= 4096 moves the payload into a zero-copy external
    // Buffer. The pair exists to keep that boundary honest.
    make('m_blob4095', blob(4095), 20000);
    make('m_blob4k', blob(4096), 20000);
    make('m_blob64k', blob(65536), 4096);
    make('m_blob1m', blob(1024 * 1024), 256);
    db.cacheStatements();

    return [
        colCase(
            "marshalling/integer ×20,000 (mode 'number')",
            dbs.number,
            'm_int',
            20000,
        ),
        colCase(
            "marshalling/integer ×20,000 (mode 'mixed')",
            dbs.mixed,
            'm_int',
            20000,
        ),
        colCase(
            "marshalling/integer ×20,000 (mode 'bigint')",
            dbs.bigint,
            'm_int',
            20000,
        ),
        colCase('marshalling/float ×20,000', db, 'm_float', 20000),
        colCase('marshalling/short text ×20,000', db, 'm_shorttext', 20000),
        colCase('marshalling/long text 4 KiB ×20,000', db, 'm_longtext', 20000),
        colCase('marshalling/unicode text ×20,000', db, 'm_unicode', 20000),
        colCase('marshalling/NULL ×20,000', db, 'm_null', 20000),
        colCase('marshalling/blob 64 B ×20,000', db, 'm_blob64', 20000),
        colCase(
            'marshalling/blob 4,095 B ×20,000 (copy boundary)',
            db,
            'm_blob4095',
            20000,
        ),
        colCase(
            'marshalling/blob 4 KiB ×20,000 (external boundary)',
            db,
            'm_blob4k',
            20000,
        ),
        colCase('marshalling/blob 64 KiB ×4,096', db, 'm_blob64k', 4096),
        colCase('marshalling/blob 1 MiB ×256', db, 'm_blob1m', 256),
    ];
}

/**
 * The blob round-trip keeper from the pre-v9 bench (bind + read back),
 * at the old 2k × 256 KiB shape so history stays comparable.
 *
 * @param {any} db a cache-free connection.
 * @returns {CaseSpec} the case.
 */
export function blobRoundTripCase(db) {
    db.exec('CREATE TABLE m_rt (d BLOB)');
    const buf = Buffer.alloc(256 * 1024);
    for (let j = 0; j < buf.length; j++) buf[j] = j & 0xff;
    return {
        name: 'marshalling/blob round-trip: 2,000 × 256 KiB',
        group: 'marshalling',
        ops: 2000,
        iter: async (_env, n) => {
            for (let i = 0; i < n; i++) {
                await db.exec('DELETE FROM m_rt');
                await new Promise((resolve, reject) => {
                    const stmt = db.prepare('INSERT INTO m_rt (d) VALUES (?)');
                    for (let r = 0; r < 2000; r++) stmt.run(buf);
                    stmt.finalize((err) => (err ? reject(err) : resolve()));
                });
                const rows = await db.all('SELECT d FROM m_rt');
                if (rows.length !== 2000) throw new Error('bad count');
            }
        },
    };
}

/**
 * The incremental-blob stream round trip (Deliverable 08 keeper): 100 MiB
 * through createWriteStream and back through createReadStream. Sample
 * count is reduced — one iteration is ~half a second — and the case is
 * honest that its per-op number is a coarse whole-operation figure.
 *
 * @param {any} db a cache-free connection.
 * @returns {CaseSpec} the case.
 */
export function blobStreamCase(db) {
    return {
        name: 'marshalling/blob stream: 100 MiB round trip',
        group: 'marshalling',
        samples: 12,
        note: 'whole-operation figure; few samples by construction',
        setup: async () => {
            const { pipeline } = await import('node:stream/promises');
            await db.exec(
                'CREATE TABLE big (id INTEGER PRIMARY KEY, data BLOB)',
            );
            await db.exec(
                'INSERT INTO big VALUES (1, zeroblob(100 * 1024 * 1024))',
            );
            const blob = await new Promise((resolve, reject) => {
                const b = db.openBlob(
                    { table: 'big', column: 'data', rowid: 1 },
                    (/** @type {Error | null} */ err) =>
                        err ? reject(err) : resolve(b),
                );
            });
            const src = Buffer.alloc(1024 * 1024, 0xab);
            return { pipeline, blob, src };
        },
        teardown: async (env) => {
            await new Promise((resolve) => env.blob.close(resolve));
        },
        iter: async (env, n) => {
            for (let i = 0; i < n; i++) {
                await env.pipeline(
                    (async function* () {
                        for (let j = 0; j < 100; j++) yield env.src;
                    })(),
                    env.blob.createWriteStream(),
                );
                let readBytes = 0;
                await env.pipeline(
                    env.blob.createReadStream(),
                    async (source) => {
                        for await (const chunk of source) {
                            readBytes += chunk.length;
                        }
                    },
                );
                if (readBytes !== 100 * 1024 * 1024)
                    throw new Error('short read');
            }
        },
    };
}
