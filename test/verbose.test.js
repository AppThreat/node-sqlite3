import sqlite3 from '../lib/sqlite3.js';
import assert from 'assert';

let invalid_sql = 'update non_existent_table set id=1';

let originalMethods = {
    Database: {},
    Statement: {},
};

function backupOriginalMethods() {
    for (let obj in originalMethods) {
        for (let attr in sqlite3[obj].prototype) {
            originalMethods[obj][attr] = sqlite3[obj].prototype[attr];
        }
    }
}

function resetVerbose() {
    for (let obj in originalMethods) {
        for (let attr in originalMethods[obj]) {
            sqlite3[obj].prototype[attr] = originalMethods[obj][attr];
        }
    }
}

describe('verbose', function() {
    it('Shoud add trace info to error when verbose is called', function(done) {
        let db = new sqlite3.Database(':memory:');
        backupOriginalMethods();
        sqlite3.verbose();

        db.run(invalid_sql, function(err) {
            assert(err instanceof Error);
            assert(
                err.stack.indexOf(`Database#run('${invalid_sql}'`) > -1,
                `Stack shoud contain trace info, stack = ${err.stack}`
            );

            done();
            resetVerbose();
        });
    });

    it('Shoud not add trace info to error when verbose is not called', function(done) {
        let db = new sqlite3.Database(':memory:');

        db.run(invalid_sql, function(err) {
            assert(err instanceof Error);
            assert(
                err.stack.indexOf(invalid_sql) === -1,
                `Stack shoud not contain trace info, stack = ${err.stack}`
            );

            done();
        });
    });
});