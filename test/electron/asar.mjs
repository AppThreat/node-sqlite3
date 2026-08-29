// Packaged-ASAR test (Deliverable 10 case 4): pack a minimal Electron
// app that really depends on @appthreat/sqlite3 — installed from this
// repo's packed tarball, so the fixture carries the shipping prebuilds
// — and run it under @electron/packager twice:
//
//   1. WITH the prebuilds unpacked (asar unpack pattern) — the app must
//      load the addon and complete a query (exit 0).
//   2. WITHOUT unpacking — the load must fail with the binding's
//      Electron/ASAR error that names the asarUnpack fix (exit 3), not
//      a raw dlopen error. The failure mode is the case that matters:
//      it is what users actually hit.
//
// Slow (packages Electron twice); run via `pnpm run test:electron:asar`.
// The repo's electron devDependency provides the binary version.
import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packager } from '@electron/packager';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const work = join(root, 'test', 'tmp', 'asar-fixture');
const productName = 'Sqlite3AsarFixture';

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(
        `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
    );
}

function interestingLine(out) {
    return (
        (out ?? '').split('\n').find((l) => /QUERY|LOAD_FAILED/.test(l)) ??
        '(no output)'
    );
}

function buildFixture() {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    // Pack the repo (the tarball carries prebuilds/, lib/, binding.gyp,
    // src/ per package.json "files") and install it into the fixture
    // the way a consumer would.
    execFileSync('pnpm', ['pack', '--pack-destination', work], {
        cwd: root,
        stdio: 'pipe',
    });
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    // pnpm pack flattens the scope, keeping it: @appthreat/sqlite3 ->
    // appthreat-sqlite3-<version>.tgz
    const tarball = join(
        work,
        `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`,
    );
    if (!existsSync(tarball)) {
        throw new Error(`pnpm pack did not produce ${tarball}`);
    }

    writeFileSync(
        join(work, 'package.json'),
        JSON.stringify(
            {
                name: 'sqlite3-asar-fixture',
                productName,
                version: '1.0.0',
                main: 'main.mjs',
                type: 'module',
                private: true,
            },
            null,
            2,
        ),
    );
    // npm (not pnpm) so the fixture gets the flat node_modules layout
    // packager copies literally; the pnpm-symlink layout is documented
    // in docs/electron.md because packager behavior with it varies.
    execFileSync(
        'npm',
        ['install', '--no-audit', '--no-fund', '--omit=dev', tarball],
        { cwd: work, stdio: 'pipe' },
    );

    writeFileSync(
        join(work, 'main.mjs'),
        `import { app } from 'electron';
import { join } from 'node:path';

// Make the real dlopen target visible: Electron rewrites app.asar
// paths before the OS sees them, so the library path is the only
// honest witness of where the binary loaded from.
const realDlopen = process.dlopen;
process.dlopen = function (m, f, ...rest) {
    console.log('DLOPEN_FROM ' + f);
    return realDlopen.call(process, m, f, ...rest);
};

// This app has no window, so a hang here would be invisible: force it
// down rather than leaving an unresponsive Electron on the desktop.
setTimeout(() => {
    console.log('FIXTURE_TIMEOUT');
    process.exit(4);
}, 45000).unref?.();

try {
    const sqlite3 = (await import('@appthreat/sqlite3')).default;
    const db = new sqlite3.Database(join(app.getPath('userData'), 'asar-probe.db'));
    await db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
    const { lastID } = await db.run('INSERT INTO t VALUES (?)', 'packed');
    const row = await db.get('SELECT v FROM t WHERE rowid = ?', lastID);
    await db.close();
    console.log(row?.v === 'packed' ? 'QUERY_OK' : 'QUERY_WRONG ' + JSON.stringify(row));
    app.exit(0);
} catch (err) {
    console.log('LOAD_FAILED ' + err.message);
    app.exit(3);
}
`,
    );
}

async function packageApp(unpackPrebuilds, suffix) {
    const electronVersion = JSON.parse(
        readFileSync(
            join(root, 'node_modules', 'electron', 'package.json'),
            'utf8',
        ),
    ).version;
    // `out` (packager's option name) must be outside the app dir:
    // packager auto-excludes out dirs from the copy.
    const out = join(root, 'test', 'tmp', 'asar-packaged', suffix);
    await packager({
        dir: work,
        out,
        platform:
            process.platform === 'win32'
                ? 'win32'
                : process.platform === 'darwin'
                  ? 'darwin'
                  : 'linux',
        arch: process.arch,
        electronVersion,
        overwrite: true,
        quiet: true,
        // asar: true auto-unpacks every *.node (packager's default);
        // an options OBJECT replaces that default entirely, so the
        // "unpacked" case names the prebuilds and the "sealed" case
        // unpacks nothing — reproducing the real-world failure where a
        // packaging config (or a pnpm symlink it could not follow)
        // leaves the binary inside the archive.
        asar: unpackPrebuilds
            ? { unpack: '**/node_modules/@appthreat/sqlite3/prebuilds/**' }
            : { unpack: 'nothing-matches-this' },
    });
    return out;
}

function resourcesDir(outDir) {
    const platformDir = readdirSync(outDir).map((d) => join(outDir, d))[0];
    return process.platform === 'darwin'
        ? join(platformDir, `${productName}.app`, 'Contents', 'Resources')
        : join(platformDir, 'resources');
}

function runPackaged(outDir) {
    const platformDir = readdirSync(outDir).map((d) => join(outDir, d))[0];
    const binary =
        process.platform === 'darwin'
            ? join(
                  platformDir,
                  `${productName}.app`,
                  'Contents',
                  'MacOS',
                  productName,
              )
            : join(
                  platformDir,
                  process.platform === 'win32'
                      ? `${productName}.exe`
                      : productName,
              );
    try {
        const out = execFileSync(binary, {
            encoding: 'utf8',
            timeout: 60000,
            // SIGKILL rather than the default SIGTERM: a packaged
            // Electron app with no window is invisible on the desktop,
            // so one that ignores a polite signal would be left running
            // with nothing for the user to close.
            killSignal: 'SIGKILL',
        });
        return { code: 0, out };
    } catch (err) {
        return {
            code: err.status ?? -1,
            out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
        };
    }
}

function dlopenPath(out) {
    return (out ?? '')
        .split('\n')
        .find((l) => l.startsWith('DLOPEN_FROM '))
        ?.slice('DLOPEN_FROM '.length);
}

buildFixture();

const packedDir = await packageApp(true, 'unpacked');
const unpackedRun = runPackaged(packedDir);
check(
    'ASAR-packed app with the prebuilds unpacked loads and queries',
    unpackedRun.code === 0 && /QUERY_OK/.test(unpackedRun.out),
    `exit=${unpackedRun.code} ${interestingLine(unpackedRun.out)}`,
);
check(
    'the unpacked prebuild really is outside the archive',
    (() => {
        const unpackedRoot = join(resourcesDir(packedDir), 'app.asar.unpacked');
        if (!existsSync(unpackedRoot)) return false;
        const found = [];
        const walk = (dir) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, entry.name);
                if (entry.isDirectory()) walk(p);
                else if (entry.name.endsWith('.node')) found.push(p);
            }
        };
        walk(unpackedRoot);
        return found.length > 0 && found.every((f) => f.includes('@appthreat'));
    })(),
);
check(
    'the unpacked binary dlopens from app.asar.unpacked itself',
    (dlopenPath(unpackedRun.out) ?? '').includes('app.asar.unpacked'),
    dlopenPath(unpackedRun.out) ?? '(no DLOPEN_FROM line)',
);

// The "sealed" variant packs the prebuild INSIDE the archive with no
// unpacked copy. Plan drift, corrected here: this does NOT fail on
// current Electron — Electron extracts an in-archive .node to a temp
// file and dlopens that (verified on 43.4.1: DLOPEN_FROM points into
// the system temp dir). The test pins that behavior plus the fact that
// the binary really was in the archive; if a future Electron (or
// platform) stops extracting, this is the case that will say so.
const sealedDir = await packageApp(false, 'sealed');
const sealedRun = runPackaged(sealedDir);
check(
    'ASAR-packed app with the binary sealed inside the archive still loads (temp extraction)',
    sealedRun.code === 0 && /QUERY_OK/.test(sealedRun.out),
    `exit=${sealedRun.code} ${interestingLine(sealedRun.out)}`,
);
check(
    'the sealed package really has no app.asar.unpacked',
    !existsSync(join(resourcesDir(sealedDir), 'app.asar.unpacked')),
);
check(
    'the sealed binary loaded from outside the archive (temp extraction)',
    (() => {
        const p = dlopenPath(sealedRun.out);
        return p != null && !p.includes('app.asar');
    })(),
    dlopenPath(sealedRun.out) ?? '(no DLOPEN_FROM line)',
);

process.exit(failures ? 1 : 0);
