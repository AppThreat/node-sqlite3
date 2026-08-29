// Fails the run if any test file still carries an .only marker.
// node:test ignores `only` without --test-only (and --test-only would
// silently skip every unmarked test), so the only safe posture is to
// reject the marker outright.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields
// "/C:/...", which join() turns into an unusable path.
const dir = fileURLToPath(new URL('../test/', import.meta.url));
let found = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
        if (/\b(?:it|describe|test)\.only\s*[.(]/.test(line)) {
            console.error(`${f}:${i + 1}: stray .only marker: ${line.trim()}`);
            found++;
        }
    }
}
if (found > 0) {
    console.error(
        `check-no-only: ${found} stray .only marker(s) — remove them before running the suite`,
    );
    process.exit(1);
}
console.log('check-no-only: no stray .only markers.');
