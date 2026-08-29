// Loads the native addon through node-gyp-build, which prefers a
// prebuilds/ binary over a local build/ when both exist.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import nodeGypBuild from 'node-gyp-build';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');

// The Node-API level this addon is built against (package.json
// binary.napi_versions; binding.gyp compiles with the same number). A
// runtime that does not expose at least this level cannot load the
// addon — and the failure is not graceful: loading a Node-API 10
// prebuild into a Node-API 9 runtime (Node 20, Electron 32–34)
// segfaults inside module registration rather than throwing, so the
// check below must run before the dlopen, not after it. The floors in
// the message are the first releases that expose Node-API 10; verified
// by loading the prebuild, not by reading a compatibility table.
const NAPI_VERSION_REQUIRED = 10;
// The supported floors from package.json `engines`, not merely the first
// releases that expose Node-API 10 (Node 22 does, but this package is not
// supported there) — pointing a user at a runtime `engines` rejects would
// only move them to the next failure.
const MIN_NODE = '24';
const MIN_ELECTRON = '35';

const rawNapi = process.versions.napi;
const napiVersion = Number.parseInt(
    /** @type {string} */ (/** @type {unknown} */ (rawNapi)),
    10,
);
if (!(napiVersion >= NAPI_VERSION_REQUIRED)) {
    const runtime = process.versions.electron
        ? `Electron ${process.versions.electron} (Node ${process.versions.node})`
        : `Node ${process.versions.node}`;
    const floor = process.versions.electron
        ? `Electron >= ${MIN_ELECTRON} (Node >= ${MIN_NODE})`
        : `Node >= ${MIN_NODE}`;
    // A runtime with no `process.versions.napi` at all reports NaN above;
    // say "no Node-API" rather than printing NaN back at the user.
    const reported = Number.isNaN(napiVersion)
        ? 'no Node-API version'
        : `Node-API ${napiVersion}`;
    // Deliberately no "rebuild from source" remedy: this check runs on the
    // runtime's reported Node-API level, before any dlopen, and
    // package.json `binary.napi_versions` builds at Node-API 10 regardless
    // — so a source rebuild produces this identical error. Upgrading the
    // runtime is the only thing that works.
    throw new Error(
        `@appthreat/sqlite3 requires a runtime with Node-API ${NAPI_VERSION_REQUIRED} or newer ` +
            `(${floor}); this runtime is ${runtime}, reporting ${reported}. ` +
            'Upgrade the runtime; see docs/electron.md and docs/install.md.',
    );
}

let binding;
try {
    binding = nodeGypBuild(rootDir);
} catch (err) {
    // Make the two support-heavy failure modes name their cause: where
    // the package root was resolved from, and — when that root sits
    // inside an app.asar archive — the archive context. (Current
    // Electron extracts a .node from inside an archive to a temp file
    // transparently, so an in-archive binary often still loads; the
    // failure this hint addresses is the packaging configurations that
    // leave the binary missing or unreadable.)
    const insideAsar = rootDir.includes('app.asar');
    let hint = `@appthreat/sqlite3 could not load its native binding; resolved package root: ${rootDir}`;
    if (insideAsar) {
        hint +=
            '. The package is inside an app.asar archive: when the archive does not ' +
            'expose a loadable binary, it must be unpacked at package time — ' +
            "electron-builder: add '**/node_modules/@appthreat/sqlite3/prebuilds/**' to build.asarUnpack; " +
            '@electron/packager: asar: { unpack: "**/node_modules/@appthreat/sqlite3/prebuilds/**" } ' +
            '(its default asar: true already unpacks *.node). See docs/electron.md#asar';
    } else if (process.versions.electron) {
        hint +=
            '. Running under Electron: the prebuild loads without a rebuild on Node-API 10 ' +
            `(Electron >= ${MIN_ELECTRON}); see docs/electron.md`;
    }
    throw new Error(hint, { cause: err });
}

// The addon object carries everything; the classes are additionally
// exported by name so `export { Database } from './sqlite3-binding.js'`
// in lib/sqlite3.js is a real ESM re-export (whose declaration emit keeps
// the class's dual value+type meaning for the generated types).
const { Database, Statement, Backup, Session, Blob } = binding;

export { Backup, Blob, Database, Session, Statement };
export default binding;
