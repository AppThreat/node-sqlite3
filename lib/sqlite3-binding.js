// Loads the native addon through node-gyp-build, which prefers a
// prebuilds/ binary over a local build/ when both exist.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import nodeGypBuild from 'node-gyp-build';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');

const binding = nodeGypBuild(rootDir);

// The addon object carries everything; the classes are additionally
// exported by name so `export { Database } from './sqlite3-binding.js'`
// in lib/sqlite3.js is a real ESM re-export (whose declaration emit keeps
// the class's dual value+type meaning for the generated types).
const { Database, Statement, Backup, Session, Blob } = binding;

export { Backup, Blob, Database, Session, Statement };
export default binding;
