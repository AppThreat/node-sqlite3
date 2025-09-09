import sqlite3 from '../lib/sqlite3.js';
import assert from "assert";
import { createHook, executionAsyncId } from "async_hooks";


describe('async_hooks', function() {
    let db;
    let dbId;
    let asyncHook;

    beforeEach(function() {
        db = new sqlite3.Database(':memory:');

        asyncHook = createHook({
            init(asyncId, type) {
                if (dbId == null && type.startsWith("sqlite3.")) {
                    dbId = asyncId;
                }
            }
        }).enable();
    });

    it('should support performance measuring with async hooks', function(done) {
        db.run("DROP TABLE user", () => {
            const cbId = executionAsyncId();
            assert.strictEqual(cbId, dbId);
            done();
        });
    });

    afterEach(function() {
        if (asyncHook != null) {
            asyncHook.disable();
        }
        dbId = null;
        if (db != null) {
            db.close();
        }
    });
});