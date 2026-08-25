import assert from 'node:assert';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('exec', function () {
    let db;
    before(function (_t, done) {
        db = new sqlite3.Database(':memory:', done);
    });

    it('Database#exec', function (_t, done) {
        const sql = fs.readFileSync(
            join(__dirname, 'support/script.sql'),
            'utf8',
        );
        db.exec(sql, done);
    });

    it('retrieve database structure', function (_t, done) {
        db.all(
            'SELECT type, name FROM sqlite_master ORDER BY type, name',
            function (err, rows) {
                if (err) throw err;
                assert.deepEqual(rows, [
                    { type: 'index', name: 'grid_key_lookup' },
                    { type: 'index', name: 'grid_utfgrid_lookup' },
                    { type: 'index', name: 'images_id' },
                    { type: 'index', name: 'keymap_lookup' },
                    { type: 'index', name: 'map_index' },
                    { type: 'index', name: 'name' },
                    { type: 'table', name: 'grid_key' },
                    { type: 'table', name: 'grid_utfgrid' },
                    { type: 'table', name: 'images' },
                    { type: 'table', name: 'keymap' },
                    { type: 'table', name: 'map' },
                    { type: 'table', name: 'metadata' },
                    { type: 'view', name: 'grid_data' },
                    { type: 'view', name: 'grids' },
                    { type: 'view', name: 'tiles' },
                ]);
                done();
            },
        );
    });
});
