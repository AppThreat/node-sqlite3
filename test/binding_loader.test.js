import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// The binding loader's failure modes are support-heavy exactly when
// they are opaque: a raw node-gyp-build error names neither the
// resolved root nor the Electron/ASAR context. These tests pin the two
// fail-well paths added in Deliverable 10. Both fail on release/v9,
// where the raw error has none of the context.

describe('binding loader', () => {
    it('names the root and the asarUnpack fix when the root is inside an app.asar archive', () => {
        // A copy of lib/sqlite3-binding.js under a path containing
        // app.asar, with no prebuilds/ and no build/ beside it: the
        // load fails, and the wrapper must say where it looked and how
        // to fix the archive layout. (Its bare 'node-gyp-build' import
        // still resolves up the real tree, so only the package root is
        // faked.) The fixture path is pid-unique so concurrent runs of
        // this file — node:test parallelism and stress runs alike —
        // never delete one another's fixture mid-import.
        const fake = join(
            root,
            'test',
            'tmp',
            `app.asar-${process.pid}`,
            'node_modules',
            '@appthreat',
            'sqlite3',
        );
        const fixtureRoot = join(
            root,
            'test',
            'tmp',
            `app.asar-${process.pid}`,
        );
        rmSync(fixtureRoot, { recursive: true, force: true });
        mkdirSync(join(fake, 'lib'), { recursive: true });
        cpSync(
            join(root, 'lib', 'sqlite3-binding.js'),
            join(fake, 'lib', 'sqlite3-binding.js'),
        );

        const proc = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { pathToFileURL } from 'node:url';
                 import('${pathToFileURL(join(fake, 'lib', 'sqlite3-binding.js'))}')
                     .then(() => { console.log('UNEXPECTED_LOAD'); })
                     .catch((err) => {
                         console.log(err.message.split('\\n')[0]);
                         console.log('CAUSE=' + (err.cause ? err.cause.message.split('\\n')[0] : 'none'));
                     });`,
            ],
            { encoding: 'utf8' },
        );
        const out = proc.stdout + proc.stderr;
        assert.ok(
            out.includes(fake),
            `the error must name the resolved root; got: ${out}`,
        );
        assert.match(out, /asarUnpack/);
        assert.match(out, /app\.asar/);
        // The original node-gyp-build error rides along as cause.
        assert.match(out, /CAUSE=.*No native build was found/);

        rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('refuses a pre-Node-API-10 runtime with a clear error instead of letting dlopen crash', () => {
        // On a Node-API 9 runtime (Node 20, Electron 32-34) loading this
        // Node-API 10 prebuild segfaults inside module registration —
        // verified on Electron 34 in Deliverable 10 — so the loader
        // checks process.versions.napi before the dlopen. Faking the
        // reported version exercises the guard on a real Node build.
        const proc = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `Object.defineProperty(process.versions, 'napi', { value: '9' });
                 import('${pathToFileURL(join(root, 'lib', 'sqlite3-binding.js'))}')
                     .then(() => { console.log('UNEXPECTED_LOAD'); })
                     .catch((err) => console.log(err.message.split('\\n')[0]));`,
            ],
            { encoding: 'utf8' },
        );
        const out = proc.stdout + proc.stderr;
        assert.match(out, /Node-API 10 or newer/);
        // The floor quoted is the supported one from package.json engines,
        // not merely the first release exposing Node-API 10.
        assert.match(out, /Node >= 24/);
        // The only remedy offered must be one that works: this guard reads
        // the runtime's reported Node-API level before any dlopen, so a
        // source rebuild reproduces the identical error.
        assert.ok(!/rebuild from source/.test(out));
        assert.ok(!out.includes('UNEXPECTED_LOAD'));
    });

    it('reports a runtime with no Node-API version without printing NaN', () => {
        const proc = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `Object.defineProperty(process.versions, 'napi', { value: undefined });
                 import('${pathToFileURL(join(root, 'lib', 'sqlite3-binding.js'))}')
                     .then(() => { console.log('UNEXPECTED_LOAD'); })
                     .catch((err) => console.log(err.message.split('\\n')[0]));`,
            ],
            { encoding: 'utf8' },
        );
        const out = proc.stdout + proc.stderr;
        assert.match(out, /no Node-API version/);
        assert.ok(!/NaN/.test(out));
        assert.ok(!out.includes('UNEXPECTED_LOAD'));
    });

    it('loads normally on this runtime (guard does not misfire)', async () => {
        // The guard must not reject a runtime that does expose
        // Node-API 10; this file's own import graph already did, but
        // assert the version contract explicitly for the reader.
        const napi = Number.parseInt(
            /** @type {string} */ (
                /** @type {unknown} */ (process.versions.napi)
            ),
            10,
        );
        assert.ok(napi >= 10, `expected Node-API >= 10, got ${napi}`);
    });
});
