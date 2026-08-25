// Micro-benchmarks for the hot paths targeted by the marshalling
// optimisations: row conversion (all/each), bind marshalling (run),
// and blob transfers. Run: node bench/bench.js
import sqlite3 from '../lib/sqlite3.js';

function bench(name, fn) {
    return new Promise((resolve) => {
        // warmup
        fn(() => {
            const start = process.hrtime.bigint();
            fn(() => {
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                resolve({ name, ms });
            });
        });
    });
}

const results = [];

async function main() {
    const db = new sqlite3.Database(':memory:');
    const db2 = new sqlite3.Database(':memory:');
    const db3 = new sqlite3.Database(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b REAL, c TEXT, d BLOB)');
    db.exec('CREATE TABLE t2 (a INTEGER, b REAL, c TEXT, d BLOB)');
    db2.exec('CREATE TABLE t2 (a INTEGER, b REAL, c TEXT, d BLOB)');
    db3.exec('CREATE TABLE t (a INTEGER, b REAL, c TEXT, d BLOB)');
    await new Promise((r) => {
        const s = db3.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
        const buf = Buffer.alloc(64);
        for (let i = 0; i < 20000; i++) { buf[0] = i & 0xff; s.run(i, i + 0.5, 'text-value-' + i, buf); }
        s.finalize(r);
    });
    db.exec('CREATE TABLE t3 (d BLOB)');

    await new Promise((r) => {
        const stmt = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
        const buf = Buffer.alloc(64);
        for (let i = 0; i < 20000; i++) {
            buf[0] = i & 0xff;
            stmt.run(i, i + 0.5, 'text-value-' + i, buf);
        }
        stmt.finalize(r);
    });

    results.push(await bench('all: 20k rows x 4 cols (read cache)', (done) => {
        db.all('SELECT a, b, c, d FROM t', () => done());
    }));

    results.push(await bench('each: 20k rows x 4 cols', (done) => {
        let n = 0;
        db.each('SELECT a, b, c, d FROM t', () => { n++; }, () => done());
    }));

    results.push(await bench('run: 10k inserts (bind+exec)', (done) => {
        db.exec('DELETE FROM t2', () => {
            const stmt = db.prepare('INSERT INTO t2 VALUES (?, ?, ?, ?)');
            const buf = Buffer.alloc(64);
            for (let i = 0; i < 10000; i++) {
                buf[0] = i & 0xff;
                stmt.run(i, i + 0.5, 'text-value-' + i, buf);
            }
            stmt.finalize(() => done());
        });
    }));

    results.push(await bench('db.run: 10k (prepare per call)', (done) => {
        db.exec('DELETE FROM t2', () => {
            let i = 0;
            const next = () => {
                if (i === 10000) return done();
                db.run('INSERT INTO t2 VALUES (?, ?, ?, ?)', i, i + 0.5, 'text-value-' + i, Buffer.alloc(64), () => { i++; next(); });
            };
            next();
        });
    }));

    results.push(await bench('db.run + trace: 10k', (done) => {
        const onTrace = function() {};
        db.on('trace', onTrace);
        db.exec('DELETE FROM t2', () => {
            let i = 0;
            const next = () => {
                if (i === 10000) {
                    db.removeListener('trace', onTrace);
                    return done();
                }
                db.run('INSERT INTO t2 VALUES (?, ?, ?, ?)', i, i + 0.5, 'text-value-' + i, Buffer.alloc(64), () => { i++; next(); });
            };
            next();
        });
    }));

    results.push(await bench('db.run + profile: 10k', (done) => {
        const onProfile = function() {};
        db.on('profile', onProfile);
        db.exec('DELETE FROM t2', () => {
            let i = 0;
            const next = () => {
                if (i === 10000) {
                    db.removeListener('profile', onProfile);
                    return done();
                }
                db.run('INSERT INTO t2 VALUES (?, ?, ?, ?)', i, i + 0.5, 'text-value-' + i, Buffer.alloc(64), () => { i++; next(); });
            };
            next();
        });
    }));

    results.push(await bench('db.run cached: 10k', (done) => {
        db2.cacheStatements();
        db2.exec('DELETE FROM t2', () => {
            let i = 0;
            const next = () => {
                if (i === 10000) return done();
                db2.run('INSERT INTO t2 VALUES (?, ?, ?, ?)', i, i + 0.5, 'text-value-' + i, Buffer.alloc(64), () => { i++; next(); });
            };
            next();
        });
    }));

    // Pure synchronous loop: the intended usage pattern for the sync API.
    {
        db3.cacheStatements();
        let warm = db3.getSync('SELECT a, b, c, d FROM t WHERE rowid = ?', 1);
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < 10000; i++) {
            warm = db3.getSync('SELECT a, b, c, d FROM t WHERE rowid = ?', (i % 20000) + 1);
        }
        if (warm === undefined) throw new Error('lookup failed');
        results.push({ name: 'db.getSync cached: 10k lookups', ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    }

    results.push(await bench('get: 10k single-row lookups', (done) => {
        const stmt = db.prepare('SELECT a, b, c, d FROM t WHERE rowid = ?');
        let i = 0;
        const next = () => {
            if (i === 10000) return stmt.finalize(() => done());
            i++;
            stmt.get((i % 20000) + 1, next);
        };
        next();
    }));

    results.push(await bench('blob: 2k x 256KB round-trip', (done) => {
        const buf = Buffer.alloc(256 * 1024);
        for (let j = 0; j < buf.length; j++) buf[j] = j & 0xff;
        db.exec('DELETE FROM t3', () => {
            const stmt = db.prepare('INSERT INTO t3 (d) VALUES (?)');
            for (let i = 0; i < 2000; i++) stmt.run(buf);
            stmt.finalize(() => {
                db.all('SELECT d FROM t3', () => done());
            });
        });
    }));

    for (const r of results) {
        console.log(r.name.padEnd(40), r.ms.toFixed(1).padStart(8) + ' ms');
    }
    await new Promise((r) => db.close(() => db2.close(() => db3.close(r))));
}

main();
