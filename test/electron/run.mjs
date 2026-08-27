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
child.on('error', (err) => {
    console.error(
        `failed to launch electron at ${electronBin}: ${err.message}`,
    );
    process.exit(2);
});
child.on('close', (code) => process.exit(code ?? 1));
