// Checks the shipped type declarations for declarations that lack a doc
// comment, a @param tag for each parameter, or a @returns tag on a
// non-void function return. Biome has no require-jsdoc equivalent, so
// the public surface is checked here instead.
//
// Since Deliverable 04 the surface is split across the declaration files
// that ship in lib/: the generated lib/sqlite3.d.ts (the package entry)
// plus the declarations it resolves through — lib/native.d.ts (the
// hand-written native shapes), lib/augment.d.ts (the JS layer's members)
// and the generated lib/promises.d.ts, lib/trace.d.ts and lib/pool.d.ts.
// All of them
// are checked; every finding exits non-zero.
//
// Two parser rules keep the check honest without false positives:
//   - Only call-signature declarations (`name(...)` methods, functions,
//     constructors) need @param/@returns. Data fields
//     (`readonly lastID: number`) and function-typed *types* (typedefs
//     like `(err, rows, done) => void`) do not: their arrow parameters
//     are types, not declarations.
//   - Members inside type-literal bodies (`type X = {...}`) are skipped:
//     they are part of a type alias's shape, documented at the alias.
import { readFileSync } from 'node:fs';

const FILES = [
    'lib/sqlite3.d.ts',
    'lib/native.d.ts',
    'lib/augment.d.ts',
    'lib/promises.d.ts',
    'lib/trace.d.ts',
    'lib/pool.d.ts',
];

const root = new URL('..', import.meta.url);
const problems = [];

// Walk upwards from the declaration; return its doc comment, or '' if the
// nearest non-comment line above is not part of a /** */ block.
function docFor(lines, index) {
    const out = [];
    for (let i = index - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith('/**')) return t === '/**' ? out.join('\n') : t;
        if (t.endsWith('*/') || t.startsWith('*')) {
            out.unshift(t);
            continue;
        }
        return '';
    }
    return '';
}

// The parameter list of a call signature that opens on this line,
// including the parts that continue on following lines until the
// parentheses balance. `name(` at member position, or a top-level
// `function`/`constructor` declaration.
function signatureFrom(lines, i) {
    const open = lines[i].indexOf('(');
    if (open === -1) return null;
    let text = lines[i];
    let depth = 0;
    let opened = false;
    // Close on the parenthesis that rebalances the first one, regardless
    // of commas: merging further lines would swallow the next overload.
    const step = (line, from) => {
        for (let j = from; j < line.length; j++) {
            const c = line[j];
            if (c === '(' || c === '<' || c === '[') {
                depth++;
                opened = true;
            } else if (c === ')' || c === '>' || c === ']') {
                depth--;
                if (opened && depth <= 0) return true;
            }
        }
        return false;
    };
    if (step(text, open)) return { text };
    // Continue onto following lines until balanced (or give up after 12).
    for (let k = i + 1; k < Math.min(i + 13, lines.length); k++) {
        text += ` ${lines[k].trim()}`;
        if (step(lines[k], 0)) return { text };
    }
    return null;
}

// Count top-level commas in a balanced parameter list (angles included so
// generic parameter defaults with `<K = string>` do not confuse depth).
function countParams(list) {
    let depth = 0;
    let count = 0;
    let seen = false;
    for (const c of list) {
        if (c === '(' || c === '<' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === '>' || c === ']' || c === '}') {
            depth--;
        } else if (c === ',' && depth === 0) count++;
        else seen = true;
    }
    if (count === 0) return seen ? 1 : 0;
    return count + 1;
}

const decl =
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const member =
    /^ {4}(?:(?:get|set)\s+)?(?:readonly\s+)?(?:override\s+)?([A-Za-z_$][\w$]*)\s*[(:<]/;
const methodLike = /:\s*[^=]*=>/; // function-typed type, not a signature

for (const file of FILES) {
    const lines = readFileSync(new URL(file, root), 'utf8').split('\n');
    const seen = new Set();
    // Depth of `type X = {` literals: members inside them are shape, not
    // declarations.
    let typeLiteralDepth = 0;

    lines.forEach((line, i) => {
        if (/^export type \w+ =.*\{/.test(line)) {
            typeLiteralDepth =
                (line.match(/\{/g) ?? []).length -
                (line.match(/\}/g) ?? []).length;
            // The alias is still a declaration; record it so the value
            // twin below (`declare const x: x`) shares its docs.
            seen.add(line.match(/^export type (\w+)/)[1]);
            return;
        }
        if (typeLiteralDepth > 0) {
            for (const c of line) {
                if (c === '{') typeLiteralDepth++;
                else if (c === '}') typeLiteralDepth--;
            }
            if (typeLiteralDepth > 0) return;
        }

        // A signature (method, function, constructor) needs docs, params
        // and a return; a data property needs docs only. Skip overloads
        // after the first (later overloads share the family's docs).
        const m = line.match(decl) ?? line.match(member);
        if (!m) return;
        const name = m[1];
        const where = `${file} ${name} (line ${i + 1})`;
        if (name === 'constructor' || seen.has(name)) return;
        // tsc's declaration emit synthesizes `<Name>_base` aliases for
        // heritage clauses in the generated entry (e.g. DatabaseClass_base
        // for `class DatabaseClass extends NativeDatabase`); there is no
        // source-level doc comment they could carry.
        if (name.endsWith('_base') && file === 'lib/sqlite3.d.ts') return;
        seen.add(name);

        const doc = docFor(lines, i);
        if (!doc) {
            problems.push(`${where}: missing doc comment`);
            return;
        }

        const hasParens = /[(:<]/.test(line) && line.includes('(');
        const isFnType = methodLike.test(line);
        if (hasParens && !isFnType) {
            const sig = signatureFrom(lines, i);
            if (sig) {
                const list = sig.text.slice(
                    sig.text.indexOf('(') + 1,
                    sig.text.lastIndexOf(')'),
                );
                const params = countParams(list);
                const tags = (doc.match(/@param/g) ?? []).length;
                if (params > tags) {
                    problems.push(
                        `${where}: ${params - tags} @param tag(s) missing (has ${tags}, needs ${params})`,
                    );
                }
                if (
                    !/\)\s*:\s*(void|never)\b/.test(sig.text) &&
                    !/@returns/.test(doc)
                ) {
                    problems.push(`${where}: missing @returns tag`);
                }
            }
        }
    });
}

console.log(
    `check-jsdoc: ${problems.length} finding(s) across ${FILES.length} declaration files`,
);
for (const p of problems) console.log(`  - ${p}`);
if (problems.length === 0) {
    console.log('check-jsdoc: every shipped declaration is documented.');
} else {
    process.exitCode = 1;
}
