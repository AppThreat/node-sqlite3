import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../../lib/sqlite3.js';

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
        db.each(
            'SELECT * FROM foo',
            (err, row) => {
                if (err) throw err;
                results.push(row);
            },
            () => {
                console.timeEnd('db.each');
                console.time('db.all');
            },
        );
    }

    db.all('SELECT * FROM foo', (err, _rows) => {
        console.timeEnd('db.all');
        if (err) throw err;
    });

    db.close();
});
