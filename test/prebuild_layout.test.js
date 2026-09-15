import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sqlite3 from '../lib/sqlite3.js';
import { applyLibcTagRule } from '../tools/prebuild.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// The failure this file guards against loaded silently: a libc-tagged
// binary inside prebuilds/darwin-arm64/ outranks the untagged current
// build (node-gyp-build resolves libc to 'glibc' on every non-Alpine
// platform), so a stale .node was preferred to a fresh one with nothing
// reporting it — 9.1 APIs simply appeared to be missing. Three layers are
// pinned here: the build never emits such a file, CI refuses a directory
// containing one, and the loader refuses a binary that does not match
// lib/.

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
const MACHO64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

/**
 * Builds a synthetic prebuilds/ tree and runs the checker over it.
 *
 * @param {string} label a unique directory suffix.
 * @param {Record<string, [string, Buffer][]>} layout directory name →
 *     [filename, header bytes] entries.
 * @returns {{ status: number | null, out: string }} the checker's result.
 * @private
 */
function checkLayout(label, layout) {
    const dir = join(root, 'test', 'tmp', `prebuilds-${process.pid}-${label}`);
    rmSync(dir, { recursive: true, force: true });
    for (const [platformDir, files] of Object.entries(layout)) {
        mkdirSync(join(dir, platformDir), { recursive: true });
        for (const [name, header] of files) {
            writeFileSync(join(dir, platformDir, name), header);
        }
    }
    const proc = spawnSync(
        process.execPath,
        [join(root, 'tools', 'check-prebuilds.mjs'), dir],
        { encoding: 'utf8', cwd: root },
    );
    rmSync(dir, { recursive: true, force: true });
    return { status: proc.status, out: proc.stdout + proc.stderr };
}

describe('prebuild packaging guards', () => {
    it('keeps --tag-libc on linux and drops it on darwin and win32', () => {
        const args = ['--arch', 'arm64', '--tag-libc'];
        const linux = applyLibcTagRule(args, 'linux');
        assert.deepStrictEqual(linux.forwarded, args);
        assert.strictEqual(linux.droppedLibcTag, false);

        for (const platform of ['darwin', 'win32']) {
            const other = applyLibcTagRule(args, platform);
            assert.deepStrictEqual(other.forwarded, ['--arch', 'arm64']);
            assert.strictEqual(other.droppedLibcTag, true);
        }
    });

    it('drops the camelCase and =value spellings of the flag too', () => {
        // minimist aliases tagLibc → tag-libc, and --tag-libc=musl is the
        // same trap under a different filename.
        for (const arg of ['--tagLibc', '--tag-libc=musl', '--tagLibc=glibc']) {
            const { forwarded, droppedLibcTag } = applyLibcTagRule(
                [arg, '--strip'],
                'darwin',
            );
            assert.deepStrictEqual(forwarded, ['--strip'], `for ${arg}`);
            assert.strictEqual(droppedLibcTag, true, `for ${arg}`);
        }
    });

    it('leaves unrelated arguments alone', () => {
        const args = ['--arch', 'ia32', '--target', '24.0.0', '--quiet'];
        const { forwarded, droppedLibcTag } = applyLibcTagRule(args, 'darwin');
        assert.deepStrictEqual(forwarded, args);
        assert.strictEqual(droppedLibcTag, false);
    });

    it('accepts a correctly tagged and formatted prebuilds tree', () => {
        const { status, out } = checkLayout('ok', {
            'darwin-arm64': [['@appthreat+sqlite3.node', MACHO64]],
            'linux-x64': [
                ['@appthreat+sqlite3.glibc.node', ELF],
                ['@appthreat+sqlite3.musl.node', ELF],
            ],
            'win32-x64': [['@appthreat+sqlite3.node', PE]],
        });
        assert.strictEqual(status, 0, out);
        assert.match(out, /4 binaries/);
    });

    it('rejects a libc-tagged binary in a darwin directory', () => {
        const { status, out } = checkLayout('darwin-glibc', {
            'darwin-arm64': [
                ['@appthreat+sqlite3.node', MACHO64],
                ['@appthreat+sqlite3.glibc.node', MACHO64],
            ],
        });
        assert.strictEqual(status, 1, out);
        assert.match(out, /libc tag 'glibc' on a darwin binary/);
        assert.match(out, /outranks the untagged binary/);
    });

    it('rejects a libc-tagged binary in a win32 directory', () => {
        const { status, out } = checkLayout('win32-musl', {
            'win32-x64': [['@appthreat+sqlite3.musl.node', PE]],
        });
        assert.strictEqual(status, 1, out);
        assert.match(out, /libc tag 'musl' on a win32 binary/);
    });

    it('rejects a binary whose object format contradicts its directory', () => {
        // The reported case was a Mach-O file; a cross build putting one
        // in linux-x64/ fails only on a user's machine otherwise.
        const { status, out } = checkLayout('wrong-format', {
            'linux-x64': [['@appthreat+sqlite3.glibc.node', MACHO64]],
        });
        assert.strictEqual(status, 1, out);
        assert.match(out, /expected a elf binary for linux, found macho/);
    });

    it('rejects an empty prebuilds tree', () => {
        const { status, out } = checkLayout('empty', { 'darwin-arm64': [] });
        assert.strictEqual(status, 1, out);
        assert.match(out, /nothing to check/);
        // The message must say what shape was expected, since the argument
        // may as easily have been the wrong directory as an empty build.
        assert.match(out, /<platform>-<arch>/);
    });

    it('accepts a package root as well as a prebuilds directory', () => {
        // `node tools/check-prebuilds.mjs <package root>` used to report
        // "no *.node files" without hinting that the argument should be
        // the prebuilds/ directory; it now finds the nested one.
        const pkg = join(root, 'test', 'tmp', `pkgroot-${process.pid}`);
        rmSync(pkg, { recursive: true, force: true });
        mkdirSync(join(pkg, 'prebuilds', 'darwin-arm64'), { recursive: true });
        writeFileSync(
            join(pkg, 'prebuilds', 'darwin-arm64', '@appthreat+sqlite3.node'),
            MACHO64,
        );
        const proc = spawnSync(
            process.execPath,
            [join(root, 'tools', 'check-prebuilds.mjs'), pkg],
            { encoding: 'utf8', cwd: root },
        );
        rmSync(pkg, { recursive: true, force: true });
        const out = proc.stdout + proc.stderr;
        assert.strictEqual(proc.status, 0, out);
        assert.match(out, /1 binaries/);
    });

    it('exposes a native interface version that lib/ and src/ agree on', () => {
        // The staleness canary: lib/sqlite3-binding.js refuses a binding
        // reporting any other number, which is what turns "a stale .node
        // was resolved" into an error instead of missing methods. Both
        // constants are bumped in the same commit; this test fails when
        // only one of them is.
        const reported = /** @type {any} */ (sqlite3).NATIVE_INTERFACE_VERSION;
        assert.strictEqual(typeof reported, 'number');

        const cc = readFileSync(join(root, 'src', 'node_sqlite3.cc'), 'utf8');
        const native = cc.match(
            /#define NODE_SQLITE3_NATIVE_INTERFACE\s+(\d+)/,
        );
        assert.ok(native, 'src/node_sqlite3.cc must define the marker');
        assert.strictEqual(reported, Number(native[1]));

        const loader = readFileSync(
            join(root, 'lib', 'sqlite3-binding.js'),
            'utf8',
        );
        const expected = loader.match(/NATIVE_INTERFACE_EXPECTED\s*=\s*(\d+)/);
        assert.ok(expected, 'lib/sqlite3-binding.js must pin the marker');
        assert.strictEqual(
            reported,
            Number(expected[1]),
            'lib/ and src/ disagree on the native interface version — bump both',
        );
    });

    it('refuses a binding whose native interface does not match lib/', () => {
        // Simulated by pointing the loader at a stubbed node-gyp-build
        // that returns a binding without the marker — exactly what a
        // pre-check binary looks like.
        const fixture = join(
            root,
            'test',
            'tmp',
            `stale-binding-${process.pid}`,
        );
        rmSync(fixture, { recursive: true, force: true });
        mkdirSync(join(fixture, 'node_modules', 'node-gyp-build'), {
            recursive: true,
        });
        mkdirSync(join(fixture, 'lib'), { recursive: true });
        writeFileSync(
            join(fixture, 'node_modules', 'node-gyp-build', 'package.json'),
            JSON.stringify({
                name: 'node-gyp-build',
                version: '0.0.0',
                main: 'index.js',
            }),
        );
        writeFileSync(
            join(fixture, 'node_modules', 'node-gyp-build', 'index.js'),
            // A 9.0-era binding: classes present, marker absent.
            `function load () {
                 return { Database: class {}, Statement: class {},
                          Backup: class {}, Session: class {}, Blob: class {} };
             }
             load.path = function () { return '/fake/prebuilds/darwin-arm64/@appthreat+sqlite3.glibc.node' };
             module.exports = load;\n`,
        );
        writeFileSync(
            join(fixture, 'lib', 'sqlite3-binding.js'),
            readFileSync(join(root, 'lib', 'sqlite3-binding.js')),
        );

        const proc = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import('${new URL(`file://${join(fixture, 'lib', 'sqlite3-binding.js')}`).href}')
                     .then(() => console.log('UNEXPECTED_LOAD'))
                     .catch((err) => console.log(err.message.replaceAll('\\n', ' ')));`,
            ],
            { encoding: 'utf8', cwd: fixture },
        );
        const out = proc.stdout + proc.stderr;
        rmSync(fixture, { recursive: true, force: true });

        assert.ok(!out.includes('UNEXPECTED_LOAD'), out);
        assert.match(out, /does not match this JavaScript/);
        assert.match(out, /no NATIVE_INTERFACE_VERSION at all/);
        // The remedy and the offending file are both named.
        assert.match(out, /rm -rf prebuilds build/);
        assert.match(out, /@appthreat\+sqlite3\.glibc\.node/);
    });
});
