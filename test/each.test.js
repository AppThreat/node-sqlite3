import sqlite3 from '../lib/sqlite3.js';
import assert from 'assert';
import path from "node:path";
import {fileURLToPath} from "url";
import {dirname} from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('each', function() {
    let db;
    before(function(done) {
        db = new sqlite3.Database(path.join(__dirname, 'support', 'big.db'), sqlite3.OPEN_READONLY, done);
    });

    it('retrieve 100,000 rows with Statement#each', function(done) {
        let total = 100000;
        let retrieved = 0;


        db.each('SELECT id, txt FROM foo LIMIT 0, ?', total, function(err, row) {
            if (err) throw err;
            retrieved++;

            if(retrieved === total) {
                assert.equal(retrieved, total, "Only retrieved " + retrieved + " out of " + total + " rows.");
                done();
            }
        });
    });

    it('Statement#each with complete callback', function(done) {
        let total = 10000;
        let retrieved = 0;

        db.each('SELECT id, txt FROM foo LIMIT 0, ?', total, function(err, row) {
            if (err) throw err;
            retrieved++;
        }, function(err, num) {
            assert.equal(retrieved, num);
            assert.equal(retrieved, total, "Only retrieved " + retrieved + " out of " + total + " rows.");
            done();
        });
    });
});