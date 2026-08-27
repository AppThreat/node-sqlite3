// Resolves the test files in Node and runs them, instead of handing a
// glob to the shell.
//
// `node --test 'test/*.test.js'` looks portable and is not: POSIX sh
// strips the single quotes and Node expands the glob, but cmd.exe treats
// them as ordinary characters, so Node receives a pattern with quotes in
// it, matches nothing, reports "tests 0" and **exits 0**. Every Windows
// CI job was green on zero tests for months. A silently empty test run
// is worse than a failing one, so this script also refuses to pass when
// it finds implausibly few files.
//
//   node tools/run-tests.mjs                       # the whole suite
//   node tools/run-tests.mjs test/pool.test.js …   # explicit files
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A floor, not an exact count, so adding tests never edits this. It only
// has to be high enough that "the glob broke" cannot slip through.
const MINIMUM_TEST_FILES = 30;

const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const passthrough = process.argv.slice(2).filter((a) => a.startsWith('-'));

const files = explicit.length
    ? explicit
    : globSync('test/*.test.js', { cwd: root })
          .map((f) => relative(root, join(root, f)))
          .sort();

if (!explicit.length && files.length < MINIMUM_TEST_FILES) {
    console.error(
        `run-tests: found only ${files.length} test file(s) under test/, expected at least ` +
            `${MINIMUM_TEST_FILES}. Refusing to report success on an empty or truncated run — ` +
            'this is the failure mode where a broken glob makes CI green on zero tests.',
    );
    process.exit(1);
}

const args = [
    '--test',
    '--test-reporter=spec',
    '--test-timeout=20000',
    ...passthrough,
    ...files,
];

// process.execPath, so this follows whichever runtime invoked it — plain
// Node, or Electron's Node build under ELECTRON_RUN_AS_NODE.
const res = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (res.error) {
    console.error(`run-tests: failed to start: ${res.error.message}`);
    process.exit(1);
}
process.exit(res.status ?? 1);
