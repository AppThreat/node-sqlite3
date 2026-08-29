// Child-process scenario runner for test/permission.test.js.
//
// The Node permission model cannot be enabled inside an already-running
// process, and every interesting assertion here is about the interaction
// of two *flags*, so each scenario runs as a real child with real
// --permission flags chosen by the parent. The child reports raw
// observations (error codes, messages, outcomes) as one JSON line per
// step; the parent owns the assertions — nothing here decides pass or
// fail.
//
// Usage: node permission_child.mjs <scenario> <fixture-root>
// The fixture root (under the repo, created by the parent) holds the
// inside/ and outside/ trees; the parent's --allow-fs-* grants are
// computed from it.

import { tmpdir } from 'node:os';
import path from 'node:path';

import sqlite3 from '../../lib/sqlite3.js';

const [, , scenario, fixtureRoot] = process.argv;
const inside = path.join(fixtureRoot, 'inside');
// The outside tree deliberately lives under the OS temp directory, NOT
// inside the repo: the children are granted fs.read of the repo (they
// must read the driver itself), so an "outside" fixture under the repo
// would be inside the grant and prove nothing.
const outside = path.join(
    tmpdir(),
    `permission-outside-${path.basename(fixtureRoot)}`,
);

/** @type {unknown[]} */
const report = [];
const say = (entry) => {
    report.push(entry);
    console.log(`STEP ${JSON.stringify(entry)}`);
};

/**
 * Makes a step value JSON-safe: run results carry BigInts (`lastID`),
 * which JSON.stringify refuses.
 *
 * @param {unknown} value the raw value.
 * @returns {unknown} a serializable stand-in.
 */
function jsonSafe(value) {
    if (typeof value === 'bigint') return `${value}n`;
    if (Array.isArray(value)) return value.map(jsonSafe);
    if (value !== null && typeof value === 'object') {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
        return out;
    }
    return value;
}

/**
 * Runs one step and reports the raw outcome (value or error
 * code/message), never judging it.
 *
 * @param {string} name the step name.
 * @param {() => unknown} fn the action.
 */
async function step(name, fn) {
    try {
        const value = await fn();
        say({ name, ok: true, value: jsonSafe(value ?? null) });
    } catch (err) {
        const e =
            /** @type {Error & { code?: string, permission?: string, resource?: string }} */ (
                err
            );
        say({
            name,
            ok: false,
            code: e.code ?? null,
            permission: e.permission ?? null,
            resource: e.resource ?? null,
            message: e.message,
        });
    }
}

switch (scenario) {
    case 'model-shape':
        say({
            name: 'shape',
            permissionType: typeof process.permission,
            hasType: typeof process.permission?.has,
            isEnabledType: typeof process.permission?.isEnabled,
        });
        break;

    case 'ro-open-allowed': {
        const db = await sqlite3.open(path.join(inside, 'ro.db'), {
            mode: sqlite3.OPEN_READONLY,
        });
        await step('read', () => db.get('SELECT 1 AS v'));
        await step('close', () => db.close());
        break;
    }

    case 'rw-open-denied-dir': {
        // The exact file is write-granted but its directory is not: the
        // journal/WAL check is what must refuse, naming the directory.
        const target = path.join(inside, 'exact-file-only.db');
        await step('open', () => sqlite3.open(target));
        break;
    }

    case 'rw-open-allowed': {
        const db = await sqlite3.open(path.join(inside, 'w.db'));
        await step('write', () => db.exec('CREATE TABLE IF NOT EXISTS t (x)'));
        await step('close', () => db.close());
        break;
    }

    case 'open-outside': {
        await step('open', () =>
            sqlite3.open(path.join(outside, 'x.db'), {
                mode: sqlite3.OPEN_READONLY,
            }),
        );
        break;
    }

    case 'temp-filename': {
        await step("open ''", () => sqlite3.open(''));
        break;
    }

    case 'attach': {
        const db = await sqlite3.open(':memory:');
        await step('attach-outside', () =>
            db.exec(`ATTACH '${path.join(outside, 'y.db')}' AS y`),
        );
        await step('vacuum-into-outside', () =>
            db.exec(`VACUUM INTO '${path.join(outside, 'z.db')}'`),
        );
        await step('attach-memory', () => db.exec("ATTACH ':memory:' AS m"));
        await step('close', () => db.close());
        break;
    }

    case 'attach-allowed': {
        const db = await sqlite3.open(':memory:');
        const target = path.join(inside, 'attach-target.db');
        await step('configure', () => db.configure('attachPaths', [target]));
        await step('attach-allowed-target', () =>
            db.exec(`ATTACH '${target}' AS ok`),
        );
        await step('attach-other-inside', () =>
            db.exec(`ATTACH '${path.join(inside, 'other.db')}' AS nope`),
        );
        await step('vacuum-into-allowed-target', () =>
            db.exec(`VACUUM INTO '${path.join(inside, 'vac.db')}'`),
        );
        await step('close', () => db.close());
        break;
    }

    case 'load-extension': {
        const db = await sqlite3.open(':memory:');
        await step('load-unlisted', () =>
            db.loadExtension('/tmp/definitely-not-there.ext'),
        );
        await step('configure-allow', () =>
            db.configure('extensionPolicy', {
                allow: ['/tmp/definitely-not-there.ext'],
            }),
        );
        // Allowlisted: the policy lets it through, so the failure is the
        // native dlopen of a missing file — a different error than the
        // policy refusal, which is the observable distinction.
        await step('load-allowlisted', () =>
            db.loadExtension('/tmp/definitely-not-there.ext'),
        );
        await step('sql-load-extension-fn', () =>
            db.exec("SELECT load_extension('/tmp/x')"),
        );
        await step('close', () => db.close());
        break;
    }

    case 'uri': {
        await step('uri-ro-inside', () =>
            sqlite3.open(`file:${path.join(inside, 'ro.db')}?mode=ro`, {
                mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
            }),
        );
        await step('uri-outside', () =>
            sqlite3.open(`file:${path.join(outside, 'x.db')}?mode=ro`, {
                mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
            }),
        );
        await step('uri-outside-noquery', () =>
            sqlite3.open(`file:${path.join(outside, 'x.db')}`, {
                mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
            }),
        );
        await step('uri-memory', () =>
            sqlite3.open('file::memory:', {
                mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_URI,
            }),
        );
        await step('uri-bad-mode', () =>
            sqlite3.open(`file:${path.join(inside, 'ro.db')}?mode=bogus`, {
                mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
            }),
        );
        await step('uri-non-file-scheme', () =>
            sqlite3.open('http://host/x.db', {
                mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
            }),
        );
        break;
    }

    case 'backup': {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE b (x)');
        await step(
            'backup-outside',
            () =>
                new Promise((resolve, reject) => {
                    const backup = db.backup(path.join(outside, 'b.db'));
                    backup.step(-1, (err) => (err ? reject(err) : resolve()));
                    backup.on('error', reject);
                }),
        );
        await step(
            'backup-inside',
            () =>
                new Promise((resolve, reject) => {
                    const backup = db.backup(path.join(inside, 'b.db'));
                    backup.on('error', reject);
                    backup.step(-1, () => {
                        backup.finish(() => resolve());
                    });
                }),
        );
        await step('close', () => db.close());
        break;
    }

    case 'memory-unaffected': {
        const db = await sqlite3.open(':memory:');
        await db.exec('CREATE TABLE m (a); INSERT INTO m VALUES (1)');
        await step('read', () => db.get('SELECT a FROM m'));
        await step('close', () => db.close());
        break;
    }

    case 'untrusted-under-permissions': {
        const db = await sqlite3.open(path.join(inside, 'ro.db'), {
            mode: sqlite3.OPEN_READONLY,
            untrusted: true,
        });
        await step('read', () => db.get('SELECT 1 AS v'));
        await step('attach-refused', () => db.exec("ATTACH ':memory:' AS m"));
        await step('close', () => db.close());
        break;
    }

    case 'exit-unclosed': {
        // Opens, reads, and exits without closing anything. The exit code
        // is the assertion (139 would be a segfault at teardown).
        const db = await sqlite3.open(path.join(inside, 'ro.db'), {
            mode: sqlite3.OPEN_READONLY,
        });
        await db.get('SELECT 1 AS v');
        say({ name: 'unclosed-live', ok: true });
        process.exit(0);
        break;
    }

    case 'exit-after-refusal': {
        try {
            await sqlite3.open(path.join(outside, 'x.db'));
        } catch {
            // Refused; nothing was opened, nothing to close.
        }
        say({ name: 'refused-and-alive', ok: true });
        process.exit(0);
        break;
    }

    case 'off-model': {
        // Runs with NO --permission flag: the zero-cost path. Behaviour
        // must be identical to pre-v9.
        say({
            name: 'shape',
            permissionType: typeof process.permission,
        });
        const db = await sqlite3.open(path.join(inside, 'w.db'));
        await step('write', () => db.exec('CREATE TABLE IF NOT EXISTS t (x)'));
        await step('attach-outside', () =>
            db.exec(`ATTACH '${path.join(outside, 'y.db')}' AS y`),
        );
        await step('load-extension-reaches-native', () =>
            db.loadExtension('/tmp/definitely-not-there.ext'),
        );
        await step('close', () => db.close());
        break;
    }

    case 'worker-pool': {
        // The pool opens its connections inside worker threads: the
        // wrapper's checks run there too (workers see the same
        // permission model; the parent grants this file's dir for the
        // writer's read-write open).
        const p = await sqlite3.pool(path.join(inside, 'pool.db'), {
            readers: 0,
        });
        await step('pool-get', () => p.get('SELECT 1 AS v'));
        await step('pool-write', () =>
            p.write('CREATE TABLE IF NOT EXISTS pw (x)'),
        );
        await step('pool-close', () => p.close());
        break;
    }

    default:
        console.error(`unknown scenario ${scenario}`);
        process.exit(2);
}

console.log('CHILD_DONE');
process.exit(0);
