import assert from 'node:assert';
import { before, describe, it } from 'node:test';

import sqlite3 from '../lib/sqlite3.js';

describe('error handling', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:', done);
    });

    it('throw when calling Database() without new', function () {
        assert.throws(function () {
            sqlite3.Database(':memory:');
        }, /Class constructors cannot be invoked without 'new'/);

        assert.throws(function () {
            sqlite3.Statement();
        }, /Class constructors cannot be invoked without 'new'/);
    });

    it('should error when calling Database#get on a missing table', function (_t, done) {
        db.get('SELECT id, txt FROM foo', function (err, _row) {
            if (err) {
                assert.equal(err.message, 'SQLITE_ERROR: no such table: foo');
                assert.equal(err.errno, sqlite3.ERROR);
                assert.equal(err.code, 'SQLITE_ERROR');
                done();
            } else {
                done(
                    new Error(
                        'Completed query without error, but expected error',
                    ),
                );
            }
        });
    });

    it('Database#all prepare fail', function (_t, done) {
        db.all('SELECT id, txt FROM foo', function (err, _row) {
            if (err) {
                assert.equal(err.message, 'SQLITE_ERROR: no such table: foo');
                assert.equal(err.errno, sqlite3.ERROR);
                assert.equal(err.code, 'SQLITE_ERROR');
                done();
            } else {
                done(
                    new Error(
                        'Completed query without error, but expected error',
                    ),
                );
            }
        });
    });

    it('Database#run prepare fail', function (_t, done) {
        db.run('SELECT id, txt FROM foo', function (err, _row) {
            if (err) {
                assert.equal(err.message, 'SQLITE_ERROR: no such table: foo');
                assert.equal(err.errno, sqlite3.ERROR);
                assert.equal(err.code, 'SQLITE_ERROR');
                done();
            } else {
                done(
                    new Error(
                        'Completed query without error, but expected error',
                    ),
                );
            }
        });
    });

    it('Database#each prepare fail', function (_t, done) {
        db.each(
            'SELECT id, txt FROM foo',
            function (_err, _row) {
                assert.ok(false, 'this should not be called');
            },
            function (err, _num) {
                if (err) {
                    assert.equal(
                        err.message,
                        'SQLITE_ERROR: no such table: foo',
                    );
                    assert.equal(err.errno, sqlite3.ERROR);
                    assert.equal(err.code, 'SQLITE_ERROR');
                    done();
                } else {
                    done(
                        new Error(
                            'Completed query without error, but expected error',
                        ),
                    );
                }
            },
        );
    });

    it('Database#each prepare fail without completion handler', function (_t, done) {
        db.each('SELECT id, txt FROM foo', function (err, _row) {
            if (err) {
                assert.equal(err.message, 'SQLITE_ERROR: no such table: foo');
                assert.equal(err.errno, sqlite3.ERROR);
                assert.equal(err.code, 'SQLITE_ERROR');
                done();
            } else {
                done(
                    new Error(
                        'Completed query without error, but expected error',
                    ),
                );
            }
        });
    });

    it('Database#get prepare fail with param binding', function (_t, done) {
        db.get('SELECT id, txt FROM foo WHERE id = ?', 1, function (err, _row) {
            if (err) {
                assert.equal(err.message, 'SQLITE_ERROR: no such table: foo');
                assert.equal(err.errno, sqlite3.ERROR);
                assert.equal(err.code, 'SQLITE_ERROR');
                done();
            } else {
                done(
                    new Error(
                        'Completed query without error, but expected error',
                    ),
                );
            }
        });
    });

    it('Database#all prepare fail with param binding', function (_t, done) {
        db.all('SELECT id, txt FROM foo WHERE id = ?', 1, function (err, _row) {
            if (err) {
                assert.equal(err.message, 'SQLITE_ERROR: no such table: foo');
                assert.equal(err.errno, sqlite3.ERROR);
                assert.equal(err.code, 'SQLITE_ERROR');
                done();
            } else {
                done(
                    new Error(
                        'Completed query without error, but expected error',
                    ),
                );
            }
        });
    });

    it('Database#run prepare fail with param binding', function (_t, done) {
        db.run('SELECT id, txt FROM foo WHERE id = ?', 1, function (err, _row) {
            if (err) {
                assert.equal(err.message, 'SQLITE_ERROR: no such table: foo');
                assert.equal(err.errno, sqlite3.ERROR);
                assert.equal(err.code, 'SQLITE_ERROR');
                done();
            } else {
                done(
                    new Error(
                        'Completed query without error, but expected error',
                    ),
                );
            }
        });
    });

    it('Database#each prepare fail with param binding', function (_t, done) {
        db.each(
            'SELECT id, txt FROM foo WHERE id = ?',
            1,
            function (_err, _row) {
                assert.ok(false, 'this should not be called');
            },
            function (err, _num) {
                if (err) {
                    assert.equal(
                        err.message,
                        'SQLITE_ERROR: no such table: foo',
                    );
                    assert.equal(err.errno, sqlite3.ERROR);
                    assert.equal(err.code, 'SQLITE_ERROR');
                    done();
                } else {
                    done(
                        new Error(
                            'Completed query without error, but expected error',
                        ),
                    );
                }
            },
        );
    });

    it('Database#each prepare fail with param binding without completion handler', function (_t, done) {
        db.each(
            'SELECT id, txt FROM foo WHERE id = ?',
            1,
            function (err, _row) {
                if (err) {
                    assert.equal(
                        err.message,
                        'SQLITE_ERROR: no such table: foo',
                    );
                    assert.equal(err.errno, sqlite3.ERROR);
                    assert.equal(err.code, 'SQLITE_ERROR');
                    done();
                } else {
                    done(
                        new Error(
                            'Completed query without error, but expected error',
                        ),
                    );
                }
            },
        );
    });
});
