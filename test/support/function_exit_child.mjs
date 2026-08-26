// Child process for the function-registration process-exit test: a
// registered function's ThreadSafeFunction must not keep the event loop
// alive, so a process that registers (and uses) functions without closing
// the database still exits. Prints CHILD-EXITING right before returning to
// the event loop for the last time; the parent asserts exit code 0.
import sqlite3 from '../../lib/sqlite3.js';

const db = new sqlite3.Database(':memory:');
db.function('double', (x) => x * 2);
db.collation('rev', (a, b) => b.localeCompare(a));
db.aggregate('total', {
    start: () => 0,
    step: (acc, v) => acc + v,
    result: (acc) => acc,
});

db.exec('CREATE TABLE t (a INT); INSERT INTO t VALUES (1), (2), (3)', (err) => {
    if (err) {
        console.error('CHILD-ERROR', err);
        process.exit(1);
    }
    db.get('SELECT total(a) AS v FROM t', (err2, row) => {
        if (err2 || row.v !== 6) {
            console.error('CHILD-ERROR', err2 ?? row);
            process.exit(1);
        }
        db.get('SELECT double(21) AS v', (err3, row2) => {
            if (err3 || row2.v !== 42) {
                console.error('CHILD-ERROR', err3 ?? row2);
                process.exit(1);
            }
            // No close(): the connection is deliberately left open. The
            // process must exit on its own.
            console.log('CHILD-EXITING');
        });
    });
});
