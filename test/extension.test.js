/*

// disabled because this is not a generically safe test to run on all systems

let spatialite_ext = '/usr/local/lib/libspatialite.dylib';

describe('loadExtension', function(_t, done) {
    let db;
    before(function(_t, done) {
        db = new sqlite3.Database(':memory:', done);
    });

    if (exists(spatialite_ext)) {
        it('libspatialite', function(_t, done) {
            db.loadExtension(spatialite_ext, done);
        });
    } else {
        it('libspatialite');
    }
});

*/
