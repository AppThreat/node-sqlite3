// The Node permission model under real child processes (Deliverable 11).
//
// --permission cannot be enabled inside an already-running process, and
// the interesting assertions are about the interaction of two flags, so
// every case here spawns a real child (test/support/permission_child.mjs)
// with a real flag combination. The child reports raw observations —
// error codes, messages, outcomes — and this file owns every assertion;
// nothing is stubbed, least of all process.permission.

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';

const repo = join(import.meta.dirname, '..');
const childScript = join(
    import.meta.dirname,
    'support',
    'permission_child.mjs',
);

// One fixture root per test-file process: inside/ is what the children's
// --allow-fs-* grants cover; the outside/ tree lives under the OS temp
// directory (see the child script for why it must not be under the repo).
// `node --test` may run files in parallel, so the root is unique to this
// file.
const fixtureRoot = join(repo, 'test', 'tmp', `permission-${process.pid}`);
const inside = join(fixtureRoot, 'inside');
const outside = join(tmpdir(), `permission-outside-permission-${process.pid}`);

/**
 * The flags every scenario child needs: the model, addons (the package
 * does not load without them under the model), the repo (the driver's
 * own code, its node_modules and its prebuilds/build), and — on Linux —
 * /etc/alpine-release, which node-gyp-build's musl detection stats at
 * module load; under the permission model that stat is denied and the
 * loader crashes before reaching this package's code (observed in the
 * alpine container; the file need only be readable, not present).
 *
 * @returns {string[]} the base flag set for this platform.
 */
function baseFlags() {
    const base = ['--permission', '--allow-addons', `--allow-fs-read=${repo}`];
    if (process.platform === 'linux') {
        base.push('--allow-fs-read=/etc/alpine-release');
    }
    return base;
}

/**
 * Spawns the scenario child with the given permission flags and returns
 * its reported steps keyed by name (plus the exit status).
 *
 * @param {string} scenario the scenario name.
 * @param {string[]} extraFlags permission flags beyond the base set.
 * @returns {{ steps: Map<string, any>, status: number, output: string }} the child's observations.
 */
function runChild(scenario, extraFlags = []) {
    const res = spawnSync(
        process.execPath,
        [
            ...baseFlags(),
            ...extraFlags.flat(),
            childScript,
            scenario,
            fixtureRoot,
        ],
        { encoding: 'utf8', timeout: 60000 },
    );
    assert.strictEqual(
        res.status,
        0,
        `child ${scenario} exited ${res.status}:\n${res.stderr || res.stdout}`,
    );
    const steps = new Map();
    for (const line of res.stdout.split('\n')) {
        if (line.startsWith('STEP ')) {
            steps.set(
                JSON.parse(line.slice(5)).name,
                JSON.parse(line.slice(5)),
            );
        }
    }
    assert.ok(
        steps.size > 0,
        `child ${scenario} reported no steps:\n${res.stdout}\n${res.stderr}`,
    );
    return { steps, status: res.status, output: res.stdout };
}

// Every grant the scenarios need, computed from the fixture paths. The
// wildcard grant is passed in both separator forms — Node's permission
// matching accepts forward slashes everywhere and the platform separator
// on Windows; the redundant form is harmless (multiple --allow-fs-write
// flags accumulate).
const grants = {
    insideWrite: [
        `--allow-fs-write=${inside}${sep}*`,
        `--allow-fs-write=${inside}/*`,
    ],
    exactFileOnly: `--allow-fs-write=${join(inside, 'exact-file-only.db')}`,
};

before(function () {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // A zero-byte file is a valid empty database for a read-only open.
    writeFileSync(join(inside, 'ro.db'), '');
    writeFileSync(join(inside, 'exact-file-only.db'), '');
});

after(function () {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

describe('permission model', function () {
    // The guard on the whole file: if Node ever changes the shape (an
    // isEnabled return, a different process.permission availability),
    // these probes say so instead of every case failing opaquely.
    it('process.permission shape under --permission', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('model-shape');
        const shape = steps.get('shape');
        assert.strictEqual(shape.permissionType, 'object');
        assert.strictEqual(shape.hasType, 'function');
        // Observed on Node 24 and 26: isEnabled does not exist. The
        // implementation gates on process.permission's presence, never on
        // a method that may not be there.
        assert.strictEqual(shape.isEnabledType, 'undefined');
    });

    it('read-only open inside the allowed fs works', {
        timeout: 60000,
    }, async function () {
        const { steps } = runChild('ro-open-allowed');
        assert.ok(steps.get('read')?.ok, 'read inside allowed fs');
        assert.ok(steps.get('close')?.ok);
    });

    it('writable open inside a read-only-permitted directory is refused, naming the directory', {
        timeout: 60000,
    }, function () {
        // The exact database file IS write-granted; its directory is not
        // (no wildcard), so SQLite could not create the -journal file a
        // writable database needs. The refusal must name the directory
        // and explain the sidecar files, not blame the file.
        const { steps } = runChild('rw-open-denied-dir', [
            grants.exactFileOnly,
        ]);
        const open = steps.get('open');
        assert.strictEqual(open?.ok, false);
        assert.strictEqual(open?.code, 'ERR_ACCESS_DENIED');
        assert.strictEqual(open?.permission, 'FileSystemWrite');
        assert.strictEqual(open?.resource, inside, 'must name the directory');
        assert.match(
            open?.message ?? '',
            /-journal/,
            'must explain why the directory is needed',
        );
        assert.match(
            open?.message ?? '',
            /--allow-fs-write/,
            'must name the remedy',
        );
    });

    it('writable open with the directory granted works', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('rw-open-allowed', [grants.insideWrite]);
        assert.ok(steps.get('write')?.ok, 'write inside granted dir');
        assert.ok(steps.get('close')?.ok);
    });

    it('open outside the allowed fs is refused, naming the path', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('open-outside');
        const open = steps.get('open');
        assert.strictEqual(open?.ok, false);
        assert.strictEqual(open?.code, 'ERR_ACCESS_DENIED');
        assert.strictEqual(open?.permission, 'FileSystemRead');
        assert.strictEqual(open?.resource, join(outside, 'x.db'));
        assert.match(open?.message ?? '', /--allow-fs-read/);
    });

    it("opening '' is refused when the temp directory is not writable", {
        timeout: 60000,
    }, function () {
        // '' is SQLite's private temporary database: a real on-disk file
        // under the temp directory, not a special name that needs no fs.
        const { steps } = runChild('temp-filename');
        const open = steps.get("open ''");
        assert.strictEqual(open?.ok, false);
        assert.strictEqual(open?.code, 'ERR_ACCESS_DENIED');
        assert.strictEqual(open?.permission, 'FileSystemWrite');
        assert.strictEqual(open?.resource, tmpdir());
    });

    it('ATTACH and VACUUM INTO outside the allowed fs are refused by the gate', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('attach');
        // VACUUM INTO opens its output through an internal ATTACH, so one
        // gate covers both SQL-level paths to the filesystem.
        assert.strictEqual(steps.get('attach-outside')?.code, 'SQLITE_AUTH');
        assert.strictEqual(
            steps.get('vacuum-into-outside')?.code,
            'SQLITE_AUTH',
        );
        assert.ok(
            steps.get('attach-memory')?.ok,
            ':memory: ATTACH is not an fs path',
        );
    });

    it('configure(attachPaths) admits only its permission-checked targets', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('attach-allowed', [
            grants.insideWrite,
            `--allow-fs-read=${join(inside, 'attach-target.db')}`,
        ]);
        assert.ok(
            steps.get('configure')?.ok,
            'configure accepts a permitted target',
        );
        assert.ok(
            steps.get('attach-allowed-target')?.ok,
            'the allowlisted target attaches',
        );
        assert.strictEqual(
            steps.get('attach-other-inside')?.code,
            'SQLITE_AUTH',
            'a different target inside the same dir is still denied (exact-match allowlist)',
        );
        assert.strictEqual(
            steps.get('vacuum-into-allowed-target')?.code,
            'SQLITE_AUTH',
            'VACUUM INTO needs its own allowlist entry — it is not a free pass',
        );
    });

    it('loadExtension is refused unless allowlisted, and SQL load_extension() stays off', {
        timeout: 60000,
    }, function () {
        // The allowlist grant makes the extension path fs.read-permitted,
        // so configure('extensionPolicy') accepts it and the load reaches
        // the native dlopen (of a file that does not exist — the point is
        // which layer refuses, not that the load succeeds).
        const { steps } = runChild('load-extension', [
            '--allow-fs-read=/tmp/definitely-not-there.ext',
        ]);
        const unlisted = steps.get('load-unlisted');
        assert.strictEqual(unlisted?.ok, false);
        assert.strictEqual(unlisted?.code, 'ERR_ACCESS_DENIED');
        assert.match(unlisted?.message ?? '', /extensionPolicy/);
        assert.match(unlisted?.message ?? '', /--allow-addons/);
        // The allowlisted path passes the policy and fails at the native
        // dlopen of the missing file — a different, native error, which
        // is exactly how the two refusals are told apart.
        assert.strictEqual(
            steps.get('load-allowlisted')?.code,
            'SQLITE_ERROR',
            'allowlisted path reaches the native load (dlopen of a missing file)',
        );
        // The SQL function is off by default in the vendored SQLite
        // (observed: probed on 3.53.4 before any change) and stays off.
        assert.strictEqual(
            steps.get('sql-load-extension-fn')?.code,
            'SQLITE_ERROR',
        );
        assert.match(
            steps.get('sql-load-extension-fn')?.message ?? '',
            /not authorized/,
        );
    });

    it('file: URIs are checked (or refused when unparsable)', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('uri');
        assert.ok(steps.get('uri-ro-inside')?.ok, 'ro URI inside allowed fs');
        assert.strictEqual(steps.get('uri-outside')?.code, 'ERR_ACCESS_DENIED');
        assert.strictEqual(
            steps.get('uri-outside-noquery')?.code,
            'ERR_ACCESS_DENIED',
        );
        assert.ok(steps.get('uri-memory')?.ok, 'file::memory: needs no fs');
        // Unparsable forms are refused rather than passed through.
        assert.strictEqual(
            steps.get('uri-bad-mode')?.code,
            'ERR_ACCESS_DENIED',
        );
        assert.match(
            steps.get('uri-bad-mode')?.message ?? '',
            /mode parameter 'bogus'/,
        );
        assert.strictEqual(
            steps.get('uri-non-file-scheme')?.code,
            'ERR_ACCESS_DENIED',
        );
    });

    it('backup destinations are checked like opens', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('backup', [grants.insideWrite]);
        const outsideBackup = steps.get('backup-outside');
        assert.strictEqual(outsideBackup?.ok, false);
        assert.strictEqual(outsideBackup?.code, 'ERR_ACCESS_DENIED');
        assert.strictEqual(
            outsideBackup?.resource,
            join(outside, 'b.db'),
            'names the backup destination',
        );
        assert.ok(
            steps.get('backup-inside')?.ok,
            'granted destination backs up',
        );
    });

    it(':memory: is unaffected by the model', { timeout: 60000 }, function () {
        const { steps } = runChild('memory-unaffected');
        assert.deepStrictEqual(steps.get('read')?.value, { a: 1 });
    });

    it('untrusted hardening composes with the permission model', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('untrusted-under-permissions');
        assert.ok(steps.get('read')?.ok);
        // The ATTACH refusal comes from the LIMIT_ATTACHED=0 ceiling with
        // the message naming it — the deny-all gate is behind the limit
        // here; both are part of the hardening.
        const attach = steps.get('attach-refused');
        assert.strictEqual(attach?.code, 'SQLITE_ERROR');
        assert.match(attach?.message ?? '', /too many attached databases/);
    });

    it('the pool opens its worker connections under the model', {
        timeout: 60000,
    }, function () {
        const { steps } = runChild('worker-pool', [
            '--allow-worker',
            grants.insideWrite,
            `--allow-fs-read=${join(inside, 'pool.db')}`,
        ]);
        assert.deepStrictEqual(steps.get('pool-get')?.value, { v: 1 });
        assert.ok(steps.get('pool-write')?.ok);
        assert.ok(steps.get('pool-close')?.ok);
    });

    it('exiting without closing is a clean exit 0 (also after a refused open)', {
        timeout: 60000,
    }, function () {
        for (const scenario of ['exit-unclosed', 'exit-after-refusal']) {
            const res = spawnSync(
                process.execPath,
                [
                    ...baseFlags(),
                    ...grants.insideWrite,
                    childScript,
                    scenario,
                    fixtureRoot,
                ],
                { encoding: 'utf8', timeout: 60000 },
            );
            // 139 would be a teardown segfault, invisible to any
            // in-process assertion.
            assert.strictEqual(
                res.status,
                0,
                `${scenario}: stderr:\n${res.stderr}`,
            );
        }
    });

    it('with the model off, none of the above changes behaviour (the zero-cost path)', {
        timeout: 60000,
    }, function () {
        // Same child, NO --permission flag: process.permission is
        // undefined and every open/attach/load behaves as it did pre-v9.
        const res = spawnSync(
            process.execPath,
            [childScript, 'off-model', fixtureRoot],
            { encoding: 'utf8', timeout: 60000 },
        );
        assert.strictEqual(res.status, 0, `stderr:\n${res.stderr}`);
        const steps = new Map();
        for (const line of res.stdout.split('\n')) {
            if (line.startsWith('STEP ')) {
                const parsed = JSON.parse(line.slice(5));
                steps.set(parsed.name, parsed);
            }
        }
        assert.strictEqual(steps.get('shape')?.permissionType, 'undefined');
        assert.ok(steps.get('write')?.ok, 'writable open without any grants');
        // ATTACH outside any grant works — the whole point of the flag.
        assert.ok(
            steps.get('attach-outside')?.ok,
            'ATTACH is ungated when the model is off',
        );
        // loadExtension reaches the native layer (dlopen of a missing
        // file), not a policy refusal.
        assert.strictEqual(
            steps.get('load-extension-reaches-native')?.code,
            'SQLITE_ERROR',
        );
        assert.ok(steps.get('close')?.ok);
    });
});
