// Launcher for the Electron test modes, so package.json scripts stay
// cross-platform (inline `VAR=x electron …` does not work under the
// Windows shell) and the environment is set in exactly one place.
//
//   node test/electron/run.mjs suite   — the full test suite inside
//       Electron's Node build (ELECTRON_RUN_AS_NODE): proves the addon
//       behaves identically under Electron's V8/Node.
//   node test/electron/run.mjs main    — the Electron app-environment
//       harness (load test + utility process).
//
// Both run with PREBUILDS_ONLY=1 so node-gyp-build ignores a local
// build/ directory and proves the shipped prebuild — not a dev rebuild.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const mode = process.argv[2];

if (!['suite', 'main'].includes(mode)) {
    console.error('usage: node test/electron/run.mjs suite|main');
    process.exit(2);
}

if (!existsSync(join(root, 'prebuilds'))) {
    console.error(
        'prebuilds/ not found — run `pnpm run prebuild` before the Electron tests ' +
            '(they exist to prove the shipped binary loads without a rebuild).',
    );
    process.exit(2);
}

// require('electron') resolves to the binary path (the npm package's
// main exports a string), not the API.
const electronBin = createRequire(import.meta.url)('electron');

const env = {
    ...process.env,
    PREBUILDS_ONLY: '1',
    // suite mode only: run Electron's binary as plain Node, which the
    // node:test runner needs (it spawns process.execPath).
    ...(mode === 'suite' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
};

const args =
    mode === 'suite'
        ? [
              '--test',
              '--test-reporter=spec',
              '--test-timeout=20000',
              'test/*.test.js',
          ]
        : [join(here, 'main.mjs')];

const child = spawn(electronBin, args, { cwd: root, env, stdio: 'inherit' });

// Never leave an Electron process behind. A main process with no window
// is invisible on the desktop, so a hung child is not something the user
// can see or close — it just sits there consuming a core. Three ways it
// gets cleaned up: a watchdog here (in case the child's own watchdog is
// the thing that failed), forwarding the signals that stop us, and a
// last-chance kill on parent exit.
let settled = false;

function stopChild(signal = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    // SIGKILL anything that ignores the polite request.
    setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
    }, 5000).unref?.();
}

const TIMEOUT_MS = Number(
    process.env.ELECTRON_RUN_TIMEOUT_MS ?? (mode === 'suite' ? 900000 : 180000),
);
const watchdog = setTimeout(() => {
    console.error(
        `electron ${mode} exceeded ${TIMEOUT_MS} ms — terminating the child`,
    );
    stopChild();
    // Give the kill a moment to land, then fail loudly rather than
    // inheriting the hang we were trying to prevent.
    setTimeout(() => {
        if (!settled) process.exit(1);
    }, 8000).unref?.();
}, TIMEOUT_MS);
watchdog.unref?.();

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
        stopChild(sig === 'SIGHUP' ? 'SIGTERM' : sig);
    });
}
process.on('exit', () => stopChild('SIGKILL'));

child.on('error', (err) => {
    settled = true;
    clearTimeout(watchdog);
    console.error(
        `failed to launch electron at ${electronBin}: ${err.message}`,
    );
    process.exit(2);
});
child.on('close', (code, signal) => {
    settled = true;
    clearTimeout(watchdog);
    if (code === null) {
        console.error(`electron ${mode} terminated by ${signal}`);
        process.exit(1);
    }
    process.exit(code);
});
