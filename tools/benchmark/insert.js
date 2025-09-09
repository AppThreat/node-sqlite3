import sqlite3 from '../../lib/sqlite3.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let iterations = 10000;

export const compare = {
  'insert literal file': function(finished) {
    let db = new sqlite3.Database('');
    let file = fs.readFileSync(join(__dirname, 'insert-transaction.sql'), 'utf8');
    db.exec(file);
    db.close(finished);
  },

  'insert with transaction and two statements': function(finished) {
    let db = new sqlite3.Database('');

    db.serialize(function() {
      db.run("CREATE TABLE foo (id INT, txt TEXT)");
      db.run("BEGIN");

      db.parallelize(function() {
        let stmt1 = db.prepare("INSERT INTO foo VALUES (?, ?)");
        let stmt2 = db.prepare("INSERT INTO foo VALUES (?, ?)");
        for (let i = 0; i < iterations; i++) {
          stmt1.run(i, 'Row ' + i);
          i++;
          stmt2.run(i, 'Row ' + i);
        }
        stmt1.finalize();
        stmt2.finalize();
      });

      db.run("COMMIT");
    });

    db.close(finished);
  },
  'insert with transaction': function(finished) {
    let db = new sqlite3.Database('');

    db.serialize(function() {
      db.run("CREATE TABLE foo (id INT, txt TEXT)");
      db.run("BEGIN");
      let stmt = db.prepare("INSERT INTO foo VALUES (?, ?)");
      for (let i = 0; i < iterations; i++) {
        stmt.run(i, 'Row ' + i);
      }
      stmt.finalize();
      db.run("COMMIT");
    });

    db.close(finished);
  },
  'insert without transaction': function(finished) {
    let db = new sqlite3.Database('');

    db.serialize(function() {
      db.run("CREATE TABLE foo (id INT, txt TEXT)");
      let stmt = db.prepare("INSERT INTO foo VALUES (?, ?)");
      for (let i = 0; i < iterations; i++) {
        stmt.run(i, 'Row ' + i);
      }
      stmt.finalize();
    });

    db.close(finished);
  }
};