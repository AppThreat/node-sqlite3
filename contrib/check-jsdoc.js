// Checks lib/sqlite3.d.ts for exported declarations that lack a doc
// comment, a @param tag for each parameter, or a @returns tag on
// non-void returns. Biome has no require-jsdoc equivalent, so the
// generated public surface is checked here instead.
// Report-only in Deliverable 12 (exit 0); Deliverable 04 flips the exit
// code once the JSDoc pass lands.
import { readFileSync } from 'node:fs';

const lines = readFileSync(
    new URL('../lib/sqlite3.d.ts', import.meta.url),
    'utf8',
).split('\n');
const problems = [];

// Walk upwards from the declaration; return its doc comment, or '' if the
// nearest non-comment line above is not part of a /** */ block.
function docFor(index) {
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

// Number of parameters in the balanced paren list opening on this line.
// Multi-line signatures undercount on their first line; the @param check
// is therefore a lower bound, which is the safe direction for a report.
function countParams(line) {
    const start = line.indexOf('(');
    if (start === -1) return 0;
    let depth = 0;
    let count = 0;
    let seen = false;
    for (let j = start + 1; j < line.length; j++) {
        const c = line[j];
        if (c === '(' || c === '<' || c === '[') depth++;
        else if (c === ')' || c === '>' || c === ']') {
            depth--;
            if (depth <= 0) return seen ? count + 1 : 0;
        } else if (c === ',' && depth === 0) count++;
        else seen = true;
    }
    return count ? count + 1 : seen ? 1 : 0;
}

const decl =
    /^(?:export\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)|^ {4}(?:get\s+|set\s+|readonly\s+)?([A-Za-z_$][\w$]*)\s*[(:<]/;
const seen = new Set();
lines.forEach((line, i) => {
    const m = line.match(decl);
    if (!m) return;
    const name = m[1] ?? m[2];
    if (seen.has(name)) return; // later overloads share the family's doc
    seen.add(name);
    const where = `${name} (line ${i + 1})`;
    const doc = docFor(i);
    if (!doc) {
        problems.push(`${where}: missing doc comment`);
        return;
    }
    const params = countParams(line);
    const tags = (doc.match(/@param/g) ?? []).length;
    if (params > tags) {
        problems.push(
            `${where}: ${params - tags} @param tag(s) missing (has ${tags}, needs ${params})`,
        );
    }
    if (
        !/:\s*void\s*;?\s*$/.test(line) &&
        /:\s*[A-Za-z[{]/.test(line) &&
        !/@returns/.test(doc)
    ) {
        problems.push(`${where}: missing @returns tag`);
    }
});

console.log(`check-jsdoc: ${problems.length} finding(s) in lib/sqlite3.d.ts`);
for (const p of problems) console.log(`  - ${p}`);
if (problems.length === 0) {
    console.log('check-jsdoc: every exported declaration is documented.');
}
