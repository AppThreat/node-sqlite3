# Using @appthreat/sqlite3 in Electron

`@appthreat/sqlite3` v9 is a [Node-API](https://nodejs.org/api/n-api.html) 10 addon
shipped as prebuilt binaries. **Node-API is ABI-stable across runtimes, so the same
`prebuilds/<platform>-<arch>/*.node` that Node loads is the one Electron loads — no
rebuild, no `electron-rebuild`, no `--runtime=electron` flags.**

- **Minimum Electron: 35** (`engines.electron >= 35`). Electron 35 is the first
  major whose bundled Node (22.16) exposes Node-API 10; Electron 32–34 bundle
  Node 20 (`process.versions.napi === 9`). This number is **verified, not read from
  a table**: the shipping prebuild was loaded in Electron 35.7.5 and 44.0.0 and
  queried in both. On Electron 34 the load does not fail cleanly — the process
  segfaults inside module registration — which is why the binding loader checks
  `process.versions.napi` *before* the dlopen and throws an error naming the
  floors instead.
- Rebuilds are only ever needed for a **source build** — SQLCipher via
  `--sqlite=<prefix> --sqlite_libname=sqlcipher`, or a custom `sqlite_magic`
  header. See [Rebuilds, when they are needed](#rebuilds-when-they-are-needed).

## Quick start (main process)

```js
// ESM main process (Electron >= 28)
import { app } from 'electron';
import sqlite3 from '@appthreat/sqlite3';

const db = new sqlite3.Database(`${app.getPath('userData')}/app.db`);
```

From a CommonJS main process, use dynamic import — the package is ESM-only and
dual-publishing an ESM/CJS native module invites the dual-package hazard, so there
is deliberately no CJS entry:

```js
const sqlite3 = (await import('@appthreat/sqlite3')).default;
```

Note for ESM main processes: module evaluation is asynchronous relative to app
readiness. `await app.whenReady()` at the **top level of the entry script** can
deadlock when the file is launched through Electron's default-app path
(`electron path/to/file.mjs`); `app.whenReady().then(...)` or a `package.json`
`"main"` entry (the normal app shape) are both fine.

## Where to put the database code

Three valid placements; one recommendation.

### Utility process — recommended

`utilityProcess.fork` gives the child a full Node environment with its own module
registry — a second environment loading the same `.node` gets its own addon
constructors (this is exactly what the addon's per-environment instance data is
for). The child is crash-isolated from your windows and off the main process's
event loop.

```js
// main process: db-service-parent.mjs
import { utilityProcess } from 'electron';

const child = utilityProcess.fork(new URL('./db-service.mjs', import.meta.url).pathname);
child.on('message', (msg) => { /* replies */ });

function query(sql, ...params) {
    return new Promise((resolve) => {
        const id = nextId();
        const onMessage = (msg) => {
            if (msg.id === id) { child.off('message', onMessage); resolve(msg); }
        };
        child.on('message', onMessage);
        child.postMessage({ id, sql, params });
    });
}
```

```js
// utility process: db-service.mjs
import { app } from 'electron';
import { join } from 'node:path';
import sqlite3 from '@appthreat/sqlite3';

const db = new sqlite3.Database(join(app.getPath('userData'), 'app.db'));
const parent = process.parentPort;

parent.on('message', ({ data }) => {
    if (data.op === 'quit') return db.close(() => process.exit(0));
    db.get(data.sql, ...data.params, (err, row) => {
        // structured clone strips error properties; re-send the essentials
        parent.postMessage({
            id: data.id,
            ok: !err,
            row: row ?? null,
            err: err ? { code: err.code, errno: err.errno, message: err.message } : null,
        });
    });
});
```

`test/electron/main.mjs` in this repo is a working version of exactly this
service, run in CI.

**Pool or utility process?** The v9 connection pool
(`sqlite3.pool()`, see [docs/concurrency.md](concurrency.md)) is the same idea —
many connections, each off the main thread — without any Electron API. Use the
pool inside any single process (main, utility, or plain Node); use a utility
process when you want *process-level* isolation (a native crash cannot take down
your windows) or the database work owned by a service with its own lifecycle.

### Main process — fine

Everything works in the main process; the trade-off is that every query competes
with your UI's IPC on one event loop. The v9 API is asynchronous on worker
threads, so queries do not block the loop — but heavy result-set conversion still
costs main-process milliseconds. Prefer `db.iterate()`/`db.stream()` over `all()`
for large reads, or move to a utility process.

### Renderer — not supported; preload only with `sandbox: false`

With `contextIsolation: true` and `sandbox: true` — both Electron defaults since
v20 — a renderer cannot load native modules at all, and `@appthreat/sqlite3`
must not be used there. The supported alternative is a `preload` script with
`sandbox: false` exposing narrow functions over `contextBridge`; this is
discouraged (the preload shares the renderer's lifecycle). Keep database work in
the main or a utility process and expose it through IPC.

## ASAR packaging

A `.node` inside `app.asar` is handled by Electron in one of two ways, depending
on packaging:

- **Unpacked at package time** (recommended, and what the major packagers do by
  default): the binary sits in `app.asar.unpacked/` next to the archive and is
  dlopen'd from there directly.
- **Sealed inside the archive**: current Electron extracts it to a temp file and
  loads that — it works, but every launch pays the extraction and you are
  depending on a behavior the asar docs do not promise for every platform.

Configure unpacking explicitly with electron-builder:

```json
{
    "build": {
        "asarUnpack": ["**/node_modules/@appthreat/sqlite3/prebuilds/**"]
    }
}
```

and with `@electron/packager` / electron-forge's packager config:

```js
// forge.packagerConfig
{ asar: { unpack: '**/node_modules/@appthreat/sqlite3/prebuilds/**' } }
```

Two footguns:

- `@electron/packager`'s default `asar: true` already unpacks every `*.node`.
  Passing an options **object replaces that default** — if you set
  `asar: { unpack: <something else> }`, add the sqlite3 prebuilds pattern or the
  binary ends up sealed inside the archive.
- **pnpm**: the default symlinked `node_modules` layout has historically
  confused electron-builder and `@electron/packager` when resolving and
  unpacking `.node` files — the packager follows the symlink, or fails to, and
  the binary ends up inside the archive or missing entirely. The known
  consumer-side workaround is a hoisted layout:

  ```yaml
  # .npmrc (pnpm) or pnpm-workspace.yaml
  nodeLinker: hoisted
  ```

  If you stay on symlinks, verify the packaged app actually contains
  `app.asar.unpacked/**/@appthreat/sqlite3/prebuilds/**`.

When the binding cannot load, `lib/sqlite3-binding.js` throws an error that names
the resolved package root, notes when that path is inside an `app.asar` archive,
and points at the `asarUnpack` configuration above — instead of the raw
`No native build was found ...` from `node-gyp-build` (which is preserved as
`err.cause`).

## Bundlers

If you bundle the main process (electron-forge's Vite and Webpack templates do),
the package must be **external** — a bundler that tries to inline a `.node`
require produces a confusing failure.

- Vite: `build.rollupOptions.external: ['@appthreat/sqlite3']` (and keep
  `node_modules/@appthreat/sqlite3` out of the bundle output).
- Webpack: `externals: { '@appthreat/sqlite3': 'commonjs2 @appthreat/sqlite3' }`
  — `commonjs2` is safe even though the package is ESM, because webpack only
  uses it to name the require it emits; or use
  `externalsPresets: { node: true }`.
- esbuild: `--external:@appthreat/sqlite3`.

## Database location

Never write next to the app bundle (read-only on macOS; `Program Files` on
Windows). The correct location is the per-user data directory:

```js
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = app.getPath('userData');
mkdirSync(dir, { recursive: true });          // not guaranteed to exist yet
const db = new sqlite3.Database(join(dir, 'app.db'));
```

In a utility process, `app.getPath('userData')` resolves to the same directory
as in the main process.

## Rebuilds, when they are needed

Only for a **source build** — SQLCipher or a custom `sqlite_magic` header. The
default prebuild needs nothing. For a source build against Electron's headers,
use [`@electron/rebuild`](https://github.com/electron/rebuild) (the current
package name; `electron-rebuild` is the old one):

```bash
# from your app, with this repo checked out (or installed with source build forced)
npm install --build-from-source --sqlite=/usr/local --sqlite_libname=sqlcipher \
    --runtime=electron --target=<your Electron version> \
    --dist-url=https://electronjs.org/headers
```

or, in an app with `@electron/rebuild` installed:

```bash
npx @electron/rebuild -f -w @appthreat/sqlite3 \
    -s <sqlcipher-prefix> --sqlite_libname sqlcipher
```

This is **not** required for the default build — that is the point of the
Node-API prebuilds.

## What is tested, and where

`pnpm run test:electron` runs (against the shipping `prebuilds/`, forced by
`PREBUILDS_ONLY=1`):

1. **Load + query in the main process** and a **utility-process service** with a
   MessagePort round trip and a clean exit — `test/electron/main.mjs`.
2. **The entire Node test suite** (all `test/*.test.js`) inside Electron's
   Node/V8 build via `ELECTRON_RUN_AS_NODE` — proving behavioral parity with
   Node, not just loadability.

`pnpm run test:electron:asar` packages a real consumer install (from the packed
tarball) with `@electron/packager` both ways and asserts where the binary
loaded from — slow, macOS/Linux/Windows-local, and ubuntu-only in CI.

`test/electron/exit-no-close.mjs` is a teardown probe: it opens connections in
the main process *and* a worker, uses the API, and exits without closing
anything — expecting exit status 0 (a teardown segfault reports 139 and is
invisible to in-process assertions).
