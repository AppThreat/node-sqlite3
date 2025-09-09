import sqlite3 from '../../lib/sqlite3.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.exec(readFileSync(`${__dirname}/select-data.sql`, 'utf8'), (err) => {
    if (err) throw err;
    console.time('db.each');
  });

  {
    const results = [];
    db.each('SELECT * FROM foo', (err, row) => {
      if (err) throw err;
      results.push(row);
    }, () => {
      console.timeEnd('db.each');
      console.time('db.all');
    });
  }

  db.all('SELECT * FROM foo', (err, rows) => {
    console.timeEnd('db.all');
    if (err) throw err;
  });

  db.close();
});