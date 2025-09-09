#!/usr/bin/env node

import { existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from '../../lib/sqlite3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function randomString() {
  let str = '';
  let chars = 'abcdefghijklmnopqrstuvwxzyABCDEFGHIJKLMNOPQRSTUVWXZY0123456789  ';
  for (let i = Math.random() * 100; i > 0; i--) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}

function createdb(callback) {
  const count = 1000000;
  const db_path = join(__dirname, 'big.db');
  // Make sure the file exists and is also valid.
  if (existsSync(db_path) && statSync(db_path).size !== 0) {
    console.log('okay: database already created (' + db_path + ')');
    if (callback) callback();
  } else {
    console.log("Creating test database... This may take several minutes.");
    let db = new sqlite3.Database(db_path);
    db.serialize(function() {
      db.run("CREATE TABLE foo (id INT, txt TEXT)");
      db.run("BEGIN TRANSACTION");
      let stmt = db.prepare("INSERT INTO foo VALUES(?, ?)");
      for (let i = 0; i < count; i++) {
        stmt.run(i, randomString());
      }
      stmt.finalize();
      db.run("COMMIT TRANSACTION", [], function () {
        db.close(callback);
      });
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`.replaceAll('\\', '/')) {
  createdb();
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createdb();
}

export default createdb;