#!/usr/bin/env node
// Asserts that prebuilds/ is laid out the way node-gyp-build resolves it.
// Run after `pnpm run prebuild` (CI does; see .github/workflows/ci.yml) and
// before shipping a tarball.
//
// Two classes of fault, both of which have happened and neither of which
// fails a build on its own:
//
//   1. A libc-tagged binary outside `prebuilds/linux-*/`. node-gyp-build
//      resolves libc to 'glibc' on every non-Alpine platform, macOS and
//      Windows included, so `darwin-arm64/@appthreat+sqlite3.glibc.node`
//      matches the platform and outranks the untagged binary beside it —
//      a stale copy is then loaded in preference to the current build,
//      silently. tools/prebuild.mjs stops producing these; this check
//      catches any other producer.
//   2. A binary whose object format does not match its directory (the
//      Mach-O file above sat in a directory whose name says darwin, but
//      the reverse — a Mach-O in linux-x64/ — is what a misconfigured
//      cross build emits, and it fails only at install time on a user's
//      machine).
//
// Usage: node tools/check-prebuilds.mjs [dir]
//
// `dir` is the prebuilds directory itself, or a package root containing
// one; it defaults to this repo's prebuilds/.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolves the directory to scan: the argument as given, or its
 * `prebuilds/` subdirectory when the argument is a package root (which is
 * what most callers reach for first).
 *
 * @param {string | undefined} arg the command-line argument.
 * @returns {string} the directory to scan.
 * @private
 */
function resolvePrebuildsDir(arg) {
    if (arg === undefined) return join(root, 'prebuilds');
    const given = resolve(process.cwd(), arg);
    try {
        const nested = join(given, 'prebuilds');
        if (statSync(nested).isDirectory()) return nested;
    } catch {
        // No prebuilds/ inside it: the argument is the directory itself.
    }
    return given;
}

const prebuildsDir = resolvePrebuildsDir(process.argv[2]);

/** Tags node-gyp-build reads as a libc constraint (node-gyp-build.js). */
const LIBC_TAGS = new Set(['glibc', 'musl']);

/**
 * Identifies an object file from its leading bytes.
 *
 * @param {string} file the path to inspect.
 * @returns {'elf' | 'macho' | 'pe' | 'unknown'} the detected format.
 * @private
 */
function objectFormat(file) {
    const head = Buffer.alloc(4);
    const fd = openSync(file, 'r');
    try {
        readSync(fd, head, 0, 4, 0);
    } finally {
        closeSync(fd);
    }
    if (head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        return 'elf';
    }
    const magic = head.readUInt32LE(0);
    // Mach-O 32/64-bit, both endiannesses, plus the fat/universal header
    // (which is big-endian by definition, hence the byte-swapped forms).
    if (
        magic === 0xfeedface ||
        magic === 0xfeedfacf ||
        magic === 0xcefaedfe ||
        magic === 0xcffaedfe ||
        magic === 0xbebafeca ||
        magic === 0xbfbafeca
    ) {
        return 'macho';
    }
    if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';
    return 'unknown';
}

/** @type {Record<string, 'elf' | 'macho' | 'pe'>} */
const EXPECTED_FORMAT = {
    linux: 'elf',
    android: 'elf',
    darwin: 'macho',
    win32: 'pe',
};

/** @type {string[]} */
const problems = [];
let checked = 0;

let entries;
try {
    entries = readdirSync(prebuildsDir, { withFileTypes: true });
} catch (err) {
    console.error(
        `check-prebuilds: cannot read ${prebuildsDir} — run \`pnpm run prebuild\` first ` +
            `(${/** @type {Error} */ (err).message})`,
    );
    process.exit(1);
}

for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(prebuildsDir, entry.name);
    // prebuildify names directories `<platform>-<arch>`; the platform is
    // everything before the last dash (no supported platform name
    // contains one, but the arch never does either way).
    const dash = entry.name.lastIndexOf('-');
    const platform = dash === -1 ? entry.name : entry.name.slice(0, dash);
    const expected = EXPECTED_FORMAT[platform];

    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.node')) continue;
        const path = join(dir, file);
        if (!statSync(path).isFile()) continue;
        checked++;

        const tags = file.slice(0, -'.node'.length).split('.').slice(1);
        const libcTags = tags.filter((t) => LIBC_TAGS.has(t));
        if (libcTags.length > 0 && platform !== 'linux') {
            problems.push(
                `${entry.name}/${file}: libc tag '${libcTags.join(',')}' on a ` +
                    `${platform} binary. node-gyp-build resolves libc to 'glibc' on ` +
                    'every non-Alpine platform, so this file outranks the untagged ' +
                    'binary in the same directory and is loaded in preference to it. ' +
                    'Build with tools/prebuild.mjs (which drops --tag-libc off linux) ' +
                    'and delete this file.',
            );
        }

        const format = objectFormat(path);
        if (expected === undefined) {
            problems.push(
                `${entry.name}/${file}: unknown platform '${platform}' — teach ` +
                    'EXPECTED_FORMAT in tools/check-prebuilds.mjs about it.',
            );
        } else if (format !== expected) {
            problems.push(
                `${entry.name}/${file}: expected a ${expected} binary for ` +
                    `${platform}, found ${format}.`,
            );
        }
    }
}

if (checked === 0) {
    problems.push(
        `no *.node files found under ${prebuildsDir} — nothing to check. ` +
            'Expected <platform>-<arch>/ subdirectories holding the addon ' +
            '(pass either a prebuilds/ directory or the package root that ' +
            'contains one, and run `pnpm run prebuild` first).',
    );
}

if (problems.length > 0) {
    console.error(
        'check-prebuilds: prebuilds/ layout is not loadable as intended:',
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}

console.log(
    `check-prebuilds: ${checked} binaries under ${prebuildsDir} are correctly tagged and formatted.`,
);
