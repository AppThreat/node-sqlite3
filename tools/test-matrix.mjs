// Runs the test suite across a matrix of container targets locally, so a
// platform-specific or load-sensitive failure can be reproduced without
// pushing and waiting for CI.
//
// This exists because CI failures have repeatedly not reproduced on a
// developer machine: the D08 segfault was musl-only, and an
// ubuntu-22.04 flake in D10 needed glibc *and* Node 26 *and* a starved
// CPU before it showed up at all.
//
//   node tools/test-matrix.mjs                       # every target, full suite
//   node tools/test-matrix.mjs --only=ubuntu22-node26
//   node tools/test-matrix.mjs --cpus=1 --load=6     # reproduce a slow runner
//   node tools/test-matrix.mjs --repeat=20 --cmd='node test/support/foo.mjs'
//   node tools/test-matrix.mjs --list
//
// Notes on fidelity:
//   * The working tree is copied in, but node_modules/, build/,
//     prebuilds/ and test/tmp/ are left behind and the addon is rebuilt
//     inside the container. Copying those in silently changes results —
//     a stale test/tmp made a backup fixture fail fast and hid a race
//     that only appeared once the directory existed.
//   * Fixtures are generated inside the container (test/support/createdb.js),
//     not copied, for the same reason.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `node: null` means the base image already ships Node.
const TARGETS = {
    // Mirrors the CI ubuntu-22.04 job, which builds against Node 26.
    'ubuntu22-node26': {
        base: 'ubuntu:22.04',
        node: '26.0.0',
        pkg: 'apt',
        note: 'glibc 2.35, matches the CI ubuntu-22.04 job',
    },
    'ubuntu22-node24': {
        base: 'ubuntu:22.04',
        node: '24.19.0',
        pkg: 'apt',
        note: 'glibc 2.35, the engines floor',
    },
    'alpine-node24': {
        base: 'node:24-alpine',
        node: null,
        pkg: 'apk',
        note: 'musl — the D08 segfault was musl-only',
    },
    'debian-node24': {
        base: 'node:24',
        node: null,
        pkg: 'apt',
        note: 'glibc 2.36+',
    },
};

function parseArgs(argv) {
    const opts = {
        only: null,
        cpus: null,
        load: 0,
        repeat: 1,
        cmd: 'pnpm run test',
        platform: 'linux/amd64',
        list: false,
        keepGoing: true,
    };
    for (const arg of argv) {
        const [key, ...rest] = arg.replace(/^--/, '').split('=');
        const value = rest.join('=');
        if (key === 'list') opts.list = true;
        else if (key === 'only') opts.only = value.split(',').filter(Boolean);
        else if (key === 'cpus') opts.cpus = value;
        else if (key === 'load') opts.load = Number(value);
        else if (key === 'repeat') opts.repeat = Number(value);
        else if (key === 'cmd') opts.cmd = value;
        else if (key === 'platform') opts.platform = value;
        else {
            console.error(`unknown option: ${arg}`);
            process.exit(2);
        }
    }
    return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.list) {
    for (const [name, t] of Object.entries(TARGETS)) {
        console.log(`${name.padEnd(18)} ${t.base.padEnd(16)} ${t.note}`);
    }
    process.exit(0);
}

const selected = opts.only ?? Object.keys(TARGETS);
for (const name of selected) {
    if (!TARGETS[name]) {
        console.error(
            `unknown target: ${name}\nknown: ${Object.keys(TARGETS).join(', ')}`,
        );
        process.exit(2);
    }
}

// The pinned pnpm, so the container matches the repo rather than
// whatever npm's dist-tag happens to be today.
const packageManager =
    JSON.parse(
        execFileSync(
            'node',
            ['-p', 'JSON.stringify(require("./package.json"))'],
            {
                cwd: root,
                encoding: 'utf8',
            },
        ),
    ).packageManager ?? 'pnpm@11';

function dockerfileFor(target) {
    const lines = [`FROM ${target.base}`];
    if (target.pkg === 'apt') {
        lines.push(
            'ENV DEBIAN_FRONTEND=noninteractive',
            'RUN apt-get update && apt-get install -y --no-install-recommends ' +
                'curl python3 make g++ xz-utils ca-certificates ' +
                '>/dev/null 2>&1 && rm -rf /var/lib/apt/lists/*',
        );
    } else {
        lines.push('RUN apk add --no-cache python3 make g++ >/dev/null 2>&1');
    }
    if (target.node) {
        lines.push(
            `RUN curl -fsSL https://nodejs.org/dist/v${target.node}/node-v${target.node}-linux-x64.tar.xz -o /n.tar.xz \\
 && tar -xJf /n.tar.xz -C /usr/local --strip-components=1 && rm /n.tar.xz`,
        );
    }
    // Node 26 no longer bundles corepack, so install pnpm outright.
    lines.push(`RUN npm i -g ${packageManager} >/dev/null 2>&1`);
    return lines.join('\n');
}

function buildImage(name, target) {
    const tag = `sq3-matrix-${name}`;
    const dir = mkdtempSync(join(tmpdir(), 'sq3-matrix-'));
    writeFileSync(join(dir, 'Dockerfile'), dockerfileFor(target));
    const res = spawnSync(
        'docker',
        ['build', '--platform', opts.platform, '-t', tag, dir],
        { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
    );
    if (res.status !== 0) {
        throw new Error(
            `docker build failed for ${name}:\n${res.stderr?.slice(-1500)}`,
        );
    }
    return tag;
}

// Everything volatile is rebuilt inside the container; see the header.
const SETUP = [
    'cp -R /src /work',
    'cd /work',
    'rm -rf node_modules prebuilds build test/tmp',
    'pnpm install --ignore-scripts >/dev/null 2>&1',
    'pnpm run rebuild >/dev/null 2>&1 || { echo "REBUILD FAILED"; exit 90; }',
    'mkdir -p test/tmp',
    'node test/support/createdb.js >/dev/null 2>&1',
].join('; ');

function runTarget(name, target) {
    const tag = buildImage(name, target);
    const spinners =
        opts.load > 0
            ? `for i in $(seq 1 ${opts.load}); do (while :; do :; done) & done; `
            : '';
    const body =
        opts.repeat > 1
            ? `F=0; for i in $(seq 1 ${opts.repeat}); do ${opts.cmd} >/dev/null 2>&1 || F=$((F+1)); done; ` +
              `echo "REPEAT_FAILURES=$F/${opts.repeat}"; [ "$F" = "0" ]`
            : opts.cmd;
    const args = ['run', '--rm', '--platform', opts.platform];
    if (opts.cpus) args.push(`--cpus=${opts.cpus}`);
    args.push(
        '-v',
        `${root}:/src:ro`,
        tag,
        'sh',
        '-c',
        `${SETUP}; ${spinners}${body}`,
    );

    const started = Date.now();
    const res = spawnSync('docker', args, { encoding: 'utf8' });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    process.stdout.write(out);
    return {
        name,
        status: res.status,
        seconds: Math.round((Date.now() - started) / 1000),
        summary: summarise(out, res.status),
    };
}

function summarise(out, status) {
    const repeat = out.match(/REPEAT_FAILURES=(\S+)/)?.[1];
    if (repeat) return `failures ${repeat}`;
    if (out.includes('REBUILD FAILED')) return 'native build failed';
    const pass = out.match(/^ℹ pass (\d+)$/m)?.[1];
    const fail = out.match(/^ℹ fail (\d+)$/m)?.[1];
    if (pass !== undefined) return `pass ${pass}, fail ${fail ?? '?'}`;
    return status === 0 ? 'ok' : `exit ${status}`;
}

const results = [];
for (const name of selected) {
    console.log(`\n=== ${name} (${TARGETS[name].base}) ===`);
    try {
        results.push(runTarget(name, TARGETS[name]));
    } catch (err) {
        console.error(err.message);
        results.push({
            name,
            status: 1,
            seconds: 0,
            summary: 'image build failed',
        });
    }
}

console.log('\n──────── matrix summary ────────');
for (const r of results) {
    const mark = r.status === 0 ? 'PASS' : 'FAIL';
    console.log(
        `${mark}  ${r.name.padEnd(18)} ${r.summary.padEnd(22)} ${r.seconds}s`,
    );
}
const failed = results.filter((r) => r.status !== 0);
console.log(
    failed.length
        ? `\n${failed.length} of ${results.length} targets failed`
        : `\nall ${results.length} targets passed`,
);
process.exit(failed.length ? 1 : 0);
