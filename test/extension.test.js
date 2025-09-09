import sqlite3 from '../lib/sqlite3.js';
import assert from 'assert';
import { existsSync } from 'fs';

/*

// disabled because this is not a generically safe test to run on all systems

let spatialite_ext = '/usr/local/lib/libspatialite.dylib';

describe('loadExtension', function(done) {
    let db;
    before(function(done) {
        db = new sqlite3.Database(':memory:', done);
    });

    if (exists(spatialite_ext)) {
        it('libspatialite', function(done) {
            db.loadExtension(spatialite_ext, done);
        });
    } else {
        it('libspatialite');
    }
});

*/