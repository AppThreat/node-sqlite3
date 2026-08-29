// Generates the shipped type declarations.
//
//   pnpm run gen-types
//
// Runs `tsc -p tsconfig.types.json`, which typechecks lib/*.js (checkJs)
// against the hand-written native declarations in lib/native.d.ts and
// emits declarations into the gitignored types-gen/ scratch directory.
// This script then normalizes the emit with two deterministic steps
// before post-processing the package's `types` entry (lib/sqlite3.d.ts):
//
//   1. strip the raw `@typedef` blocks the JS emit copies verbatim,
//   2. re-attach each @typedef's summary text from its lib/*.js source
//      to the rendered `export type` it produced. TS 5.9 attached this
//      summary itself; TS 7 drops it (and, in lib/promises.js and
//      lib/pool.js, drops the raw block too), which would silently
//      strip every type summary from the shipped docs.
//
// The entry is then post-processed in three deterministic steps:
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
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// block. Drop those: the rendered declaration carries the same docs
// once the summaries below are re-attached.
function stripRawTypedefComments(text) {
    return text.replace(/\/\*\*(?:[^*]|\*(?!\/))*?@typedef[\s\S]*?\*\/\n/g, '');
}

// The summary text of every `@typedef` in a source file: the comment
// lines before the first @tag (the @property/@since tags are rendered
// or dropped by tsc itself). Blocks without a summary — e.g.
// ExtensionPolicy, documented only through its @property tags — are
// skipped; there is nothing to re-attach for them.
function typedefSummaries(source) {
    const summaries = new Map();
    for (const match of source.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
        const name = match[0].match(
            /@typedef\s*\{[\s\S]*?\}\s*([A-Za-z_$][\w$]*)/,
        )?.[1];
        if (!name || summaries.has(name)) continue;
        const summary = [];
        for (const line of match[0].split('\n').slice(1, -1)) {
            const text = line.replace(/^\s*\/?\*+\s?/, '').replace(/\*\/$/, '');
            if (/^@\w/.test(text.trim())) break;
            summary.push(text.trimEnd());
        }
        while (summary.length && !summary.at(-1).trim()) summary.pop();
        if (summary.some((line) => line.trim())) summaries.set(name, summary);
    }
    return summaries;
}

// Prepend each typedef's summary to the rendered `export type` it
// produced, unless the emit already documents that declaration (TS 7
// keeps docs on functions and classes; only the rendered type aliases
// come out bare).
function attachTypedefSummaries(text, summaries) {
    const out = [];
    for (const line of text.split('\n')) {
        const name = line.match(/^export type ([A-Za-z_$][\w$]*)\b/)?.[1];
        const summary = name === undefined ? undefined : summaries.get(name);
        if (summary && out.at(-1) !== ' */') {
            out.push('/**');
            for (const text of summary) out.push(` * ${text}`.trimEnd());
            out.push(' */');
        }
        out.push(line);
    }
    return out.join('\n');
}

// The lib/*.js source each emitted declaration file is generated from.
const summarySources = {
    'sqlite3.d.ts': 'sqlite3.js',
    'promises.d.ts': 'promises.js',
    'trace.d.ts': 'trace.js',
    'pool.d.ts': 'pool.js',
};

const emitted = {};
for (const [declaration, source] of Object.entries(summarySources)) {
    let text = readFileSync(path.join(emitDir, declaration), 'utf8');
    if (declaration === 'sqlite3.d.ts') text = stripRawTypedefComments(text);
    emitted[declaration] = attachTypedefSummaries(
        text,
        typedefSummaries(readFileSync(path.join(root, 'lib', source), 'utf8')),
    );
}

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
    `${header}${emitted['sqlite3.d.ts']}${augmentImport}\n` +
        block('promises.js', promisesPublicTypes) +
        block('pool.js', poolPublicTypes) +
        block('native.js', nativeTypes),
);

writeFileSync(
    path.join(root, 'lib', 'promises.d.ts'),
    emitted['promises.d.ts'],
);
writeFileSync(path.join(root, 'lib', 'trace.d.ts'), emitted['trace.d.ts']);
writeFileSync(path.join(root, 'lib', 'pool.d.ts'), emitted['pool.d.ts']);

console.log(
    'gen-types: lib/sqlite3.d.ts, lib/promises.d.ts, lib/trace.d.ts, lib/pool.d.ts regenerated.',
);
