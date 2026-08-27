// Generates the shipped type declarations.
//
//   pnpm run gen-types
//
// Runs `tsc -p tsconfig.types.json`, which typechecks lib/*.js (checkJs)
// against the hand-written native declarations in lib/native.d.ts and
// emits declarations into the gitignored types-gen/ scratch directory.
// This script then copies them into lib/, post-processing the package's
// `types` entry (lib/sqlite3.d.ts) in three deterministic steps:
//
//   1. prepend the GENERATED header,
//   2. append `import './augment.js'` so consumers of the package load
//      the JS-layer member augmentation in lib/augment.d.ts,
//   3. append re-exports of the public type declarations of
//      lib/native.d.ts and lib/promises.d.ts, so the type surface
//      (`Row`, `BindValue`, `SignalOptions`, …) is importable from the
//      package root, as it was when the .d.ts was hand-written.
//
// The previously generated lib/sqlite3.d.ts, lib/promises.d.ts and
// lib/trace.d.ts are deleted up front: sitting next to their .js
// sources they would win module resolution, and tsc would check the JS
// against the stale declarations instead of emitting them.
//
// The result is committed; CI regenerates and fails on any diff, so a
// declaration can neither drift from the JSDoc nor be silently dropped.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
const generated = ['sqlite3.d.ts', 'promises.d.ts', 'trace.d.ts', 'pool.d.ts'];

// Stale outputs first, so resolution during the run sees the sources.
for (const file of generated) {
    rmSync(path.join(root, 'lib', file), { force: true });
}

execFileSync(tsc, ['-p', path.join(root, 'tsconfig.types.json')], {
    stdio: 'inherit',
    cwd: root,
});

const emitDir = path.join(root, 'types-gen');
const entry = path.join(root, 'lib', 'sqlite3.d.ts');

// tsc's JS emit attaches the original JSDoc verbatim, so a rendered
// `export type X` can be followed by a second, raw copy of its @typedef
// block. Drop those: the rendered declaration carries the same docs.
function stripRawTypedefComments(text) {
    return text.replace(/\/\*\*(?:[^*]|\*(?!\/))*?@typedef[\s\S]*?\*\/\n/g, '');
}

const emitted = stripRawTypedefComments(
    readFileSync(path.join(emitDir, 'sqlite3.d.ts'), 'utf8'),
);

// Every `export type X` / `export interface X` in the hand-written
// island, keys sorted for a stable diff. Classes are re-exported by the
// emitted module re-export already; functions stay in their module.
const nativeTypes = [
    ...readFileSync(path.join(root, 'lib', 'native.d.ts'), 'utf8').matchAll(
        /^export (?:type|interface) ([A-Za-z_$][\w$]*)/gm,
    ),
].map((m) => m[1]);

// The public types authored in lib/promises.js' JSDoc. Internal helpers
// (Installed, IteratorOptions, …) stay inside lib/promises.d.ts.
const promisesPublicTypes = [
    'FetchCallback',
    'OpenFunction',
    'PromiseRunResult',
    'SignalOptions',
    'TransactionOptions',
];

// The pool's public types, authored in lib/pool.js' JSDoc.
const poolPublicTypes = [
    'PoolOptions',
    'PoolQueryOptions',
    'PoolTransaction',
    'SqlitePool',
];

const augmentImport = "import './augment.js';";
const block = (from, names) =>
    `export type {\n${[...names]
        .sort()
        .map((n) => `    ${n},`)
        .join('\n')}\n} from './${from}';\n`;

const header = `// GENERATED FILE — DO NOT EDIT.
// Regenerate with \`pnpm run gen-types\`. Sources, in order of truth:
//   1. the native layer's shape, hand-written in lib/native.d.ts,
//   2. the JS layer's members in lib/augment.d.ts,
//   3. the JSDoc of lib/*.js, from which tsc emits this file plus
//      lib/promises.d.ts and lib/trace.d.ts.
// The three shipped .d.ts files together form the public types.

`;

writeFileSync(
    entry,
    `${header}${emitted}${augmentImport}\n` +
        block('promises.js', promisesPublicTypes) +
        block('pool.js', poolPublicTypes) +
        block('native.js', nativeTypes),
);

copyFileSync(
    path.join(emitDir, 'promises.d.ts'),
    path.join(root, 'lib', 'promises.d.ts'),
);
copyFileSync(
    path.join(emitDir, 'trace.d.ts'),
    path.join(root, 'lib', 'trace.d.ts'),
);
copyFileSync(
    path.join(emitDir, 'pool.d.ts'),
    path.join(root, 'lib', 'pool.d.ts'),
);

console.log(
    'gen-types: lib/sqlite3.d.ts, lib/promises.d.ts, lib/trace.d.ts, lib/pool.d.ts regenerated.',
);
