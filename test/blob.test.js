import sqlite3 from '../lib/sqlite3.js';
import fs from 'fs';
import assert from 'assert';
import { Buffer } from 'buffer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// lots of elmo
let elmo = fs.readFileSync(join(__dirname, '/support/elmo.png'));

describe('blob', function() {
  let db;
  before(function(done) {
    db = new sqlite3.Database(':memory:');
    db.run("CREATE TABLE elmos (id INT, image BLOB)", done);
  });

  let total = 10;
  let inserted = 0;
  let retrieved = 0;


  it('should insert blobs', function(done) {
    for (let i = 0; i < total; i++) {
      db.run('INSERT INTO elmos (id, image) VALUES (?, ?)', i, elmo, function(err) {
        if (err) throw err;
        inserted++;
      });
    }
    db.wait(function() {
      assert.equal(inserted, total);
      done();
    });
  });

  it('should retrieve the blobs', function(done) {
    db.all('SELECT id, image FROM elmos ORDER BY id', function(err, rows) {
      if (err) throw err;
      for (let i = 0; i < rows.length; i++) {
        assert.ok(Buffer.isBuffer(rows[i].image));
        assert.ok(elmo.length, rows[i].image);

        for (let j = 0; j < elmo.length; j++) {
          if (elmo[j] !== rows[i].image[j]) {
            assert.ok(false, "Wrong byte");
          }
        }

        retrieved++;
      }

      assert.equal(retrieved, total);
      done();
    });
  });
});