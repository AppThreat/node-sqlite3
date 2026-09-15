#!/usr/bin/env node
// `pnpm run prebuild` — prebuildify with one platform rule enforced:
// **the libc tag belongs to linux builds only**.
//
// Why the wrapper exists. prebuildify resolves the libc tag as
// `PREBUILD_LIBC || (isAlpine() ? 'musl' : 'glibc')`, and node-gyp-build
// resolves the loader's libc the same way — so on macOS and Windows both
// sides say "glibc". A `--tag-libc` build there produces
// `prebuilds/darwin-arm64/@appthreat+sqlite3.glibc.node`, which matches
// the running platform *and* carries a tag, so it wins node-gyp-build's
// specificity sort over the untagged `@appthreat+sqlite3.node` sitting
// next to it. Two binaries in one directory, the tagged one always
// preferred: a stale build named that way is then loaded in preference to
// the current one, silently. That happened (a pre-9.1 Mach-O binary
// shadowing a 9.1 build) and it presented as missing 9.1 APIs rather than
// as a packaging fault.
//
// So: `--tag-libc` is passed through on linux and dropped everywhere
// else, with a line on stderr saying so. CI passes the flag
// unconditionally for every target; the platform rule lives here rather
// than in the workflow matrix so that a local `pnpm run prebuild
// --tag-libc` cannot recreate the trap either.
//
// Every other argument is forwarded untouched. tools/check-prebuilds.mjs
// re-checks the resulting directory, so a regression fails a build even
// when prebuildify is invoked directly.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Applies the platform rule to a prebuildify argument list.
 *
 * @param {string[]} argv the arguments after the script name.
 * @param {string} platform a `process.platform` value.
 * @returns {{ forwarded: string[], droppedLibcTag: boolean }} the
 *     arguments to pass on, and whether a libc tag was removed.
 */
export function applyLibcTagRule(argv, platform) {
    /** @type {string[]} */
    const forwarded = [];
    let droppedLibcTag = false;
    for (const arg of argv) {
        // Both spellings minimist accepts for the flag, bare and in
        // `=value` form. A `--tag-libc=musl` cross-tag on a non-linux
        // host is the same trap under a different filename, so it goes
        // too.
        if (/^--(tag-libc|tagLibc)(=|$)/.test(arg)) {
            if (platform === 'linux') forwarded.push(arg);
            else droppedLibcTag = true;
            continue;
        }
        forwarded.push(arg);
    }
    return { forwarded, droppedLibcTag };
}

/**
 * Runs prebuildify with the shipping flags and the filtered arguments.
 *
 * @returns {void}
 * @private
 */
function main() {
    const require = createRequire(import.meta.url);
    const prebuildifyBin = require.resolve('prebuildify/bin.js');
    const { forwarded, droppedLibcTag } = applyLibcTagRule(
        process.argv.slice(2),
        process.platform,
    );
    if (droppedLibcTag) {
        process.stderr.write(
            `tools/prebuild.mjs: dropped --tag-libc on ${process.platform} — ` +
                'the libc tag is meaningful only for linux builds, and a tagged ' +
                'binary in a non-linux prebuilds directory shadows the untagged ' +
                'one at load time. See the comment in tools/prebuild.mjs.\n',
        );
    }
    const child = spawn(
        process.execPath,
        [prebuildifyBin, '--napi', '--strip', ...forwarded],
        { stdio: 'inherit' },
    );
    child.on('exit', (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 1);
    });
}

// Run only as a script; importing this file (the test does) must not
// start a build.
const invoked = process.argv[1];
if (
    invoked !== undefined &&
    realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
) {
    main();
}
