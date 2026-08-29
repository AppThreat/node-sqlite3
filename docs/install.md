# Installing @appthreat/sqlite3

This is the complete installation guide. Requirements: **Node.js >= 24**
(declared in `engines`). Any package manager works:

```bash
npm install @appthreat/sqlite3
pnpm add @appthreat/sqlite3
yarn add @appthreat/sqlite3
bun add @appthreat/sqlite3
```

Nothing is downloaded at install time and nothing is compiled at install time
on the platforms below — the prebuilt binaries ship inside the npm tarball
itself.

## Prebuild coverage

One binary per platform, built against Node-API (`napi_versions: [10]`), so a
single binary covers every supported Node version. Linux builds carry both
libc flavours side by side, tagged `.glibc.node` / `.musl.node`.

| Platform       | Files in `prebuilds/`                                           |
| -------------- | --------------------------------------------------------------- |
| `darwin-arm64` | `@appthreat+sqlite3.node`                                       |
| `darwin-x64`   | `@appthreat+sqlite3.node`                                       |
| `linux-arm64`  | `@appthreat+sqlite3.glibc.node`, `@appthreat+sqlite3.musl.node` |
| `linux-x64`    | `@appthreat+sqlite3.glibc.node`, `@appthreat+sqlite3.musl.node` |
| `win32-arm64`  | `@appthreat+sqlite3.node`                                       |
| `win32-x64`    | `@appthreat+sqlite3.node`                                       |

The binding is resolved at **runtime**, not install time:
`lib/sqlite3-binding.js` calls `node-gyp-build(rootDir)` on first import,
which looks in `prebuilds/<platform>/` first, then falls back to a
`build/Release/` build. (For `--tag-libc` builds the directory stays
`linux-<arch>` and the libc is carried by the file suffix.)

## pnpm 10+ and the blocked install script

pnpm 10 and later refuse to run a dependency's lifecycle scripts unless the
dependent allowlists it. This package declares `"install": "node-gyp-build"`,
so pnpm prints a notice like:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @appthreat/sqlite3@9.0.0
```

**You can ignore that notice.** Verified empirically (pnpm 11.23.0, macOS,
both the published v8 and a packed v9 tarball): with the script blocked, the
module still imports and `sqlite3.VERSION` prints, because a matching prebuild
exists and runtime resolution never needs the install script.

**No `onlyBuiltDependencies` entry is needed** — we ship prebuilds.

The one case where you _do_ need to allow the script is a **source build**:
no prebuild for your platform, or `--build-from-source`, `--sqlite=`,
SQLCipher, or a custom `sqlite_magic`. (Electron needs none of this: the
Node-API prebuild loads as-is on Electron >= 35 — see
[electron.md](electron.md).) Then the install script must actually run
`node-gyp`. Add to your `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - "@appthreat/sqlite3"
```

(or run `pnpm approve-builds` and select `@appthreat/sqlite3`), then trigger
the source build, e.g.:

```bash
npm_config_build_from_source=true pnpm rebuild @appthreat/sqlite3
```

`pnpm rebuild <pkg>` (the builtin, with the package named explicitly — here it
is the right tool) re-runs that dependency's build scripts, which invokes
`node-gyp-build`, which sees the `build_from_source` config and compiles
instead of resolving a prebuild.

## Source builds

A source build happens when:

- your platform has no prebuild in the table above;
- you pass `--build-from-source`;
- you build against an external SQLite or SQLCipher (`--sqlite=`,
  `--sqlite_libname=`);
- you set a custom file magic (`--sqlite_magic=`); or
- you build against Electron headers with a custom `--target` (only ever
  needed together with a source build; the default prebuild loads in
  Electron unchanged).

Toolchain requirements:

- **Python 3** (for node-gyp's gyp)
- a **C++17 toolchain**: Xcode CLT on macOS, MSVC (msbuild) on Windows,
  gcc/clang elsewhere
- **node-gyp 12.x** — installed automatically as an `optionalDependencies`
  entry when your environment needs it; no global install required

With npm everything works with the classic flags:

```bash
npm install @appthreat/sqlite3 --build-from-source
```

With pnpm, allow the script as shown above and set the config via the
environment (`npm_config_build_from_source=true`), since pnpm does not forward
npm-style `--` flags to dependency scripts.

### External SQLite, magic, SQLCipher

```bash
# external sqlite instead of the bundled amalgamation
npm install @appthreat/sqlite3 --build-from-source --sqlite=/usr/local

# homebrew sqlite on macOS
npm install @appthreat/sqlite3 --build-from-source --sqlite=/usr/local/opt/sqlite/

# custom 15-char file magic
npm install @appthreat/sqlite3 --build-from-source --sqlite_magic="MyCustomMagic15"

# SQLCipher
npm install @appthreat/sqlite3 --build-from-source --sqlite_libname=sqlcipher --sqlite=/usr/
```

For the full SQLCipher/Electron flag set see the
[README](../README.md#sqlcipher-encrypted-databases).

## Troubleshooting: "No native build was found"

```
Error: No native build was found for platform=linux arch=arm64 runtime=node ...
```

`node-gyp-build` found neither a matching `prebuilds/<platform>/` entry nor a
`build/Release/` binding. In order of likelihood:

1. **pnpm blocked the install script on a platform that needs a source
   build.** You saw the `ERR_PNPM_IGNORED_BUILDS` notice and ignored it, but
   there is no prebuild for your platform. Add the
   `onlyBuiltDependencies` snippet from above, then
   `pnpm rebuild @appthreat/sqlite3`.
2. **You are developing this repo** and have no build yet: run
   `pnpm install` (the root install script compiles the binding) or
   `pnpm run rebuild`.
3. **Stale `prebuilds/` while iterating on C++**: `node-gyp-build` prefers
   `prebuilds/` over `build/`, so your `pnpm run rebuild` output is being
   shadowed. Delete `prebuilds/` while iterating.
4. **Runtime below the Node-API floor** (Node < 22, Electron < 35): the
   binding loader refuses with an error naming the floors rather than
   crashing. On Electron the default prebuild needs no rebuild at all; only
   a source build against Electron headers uses `--runtime=electron
--target=<version> --dist-url=https://electronjs.org/headers` (see
   [electron.md](electron.md)).

## Development

This repo is developed with **pnpm >= 11** (pinned exactly in
`packageManager`; `corepack enable` picks it up). Node >= 24 required.

```bash
pnpm install                          # strictDepBuilds is on; frozen form: pnpm install --frozen-lockfile
pnpm run rebuild                      # node-gyp rebuild — always `pnpm run rebuild`
pnpm run test
pnpm run prebuild                     # prebuildify --napi --strip
pnpm pack                             # tarball includes prebuilds/ — smoke-test it in a scratch project
```

Notes:

- **Never bare `pnpm rebuild`** in this repo — that is pnpm's builtin for
  rebuilding _dependencies_; it silently does not run this repo's `rebuild`
  script. The same class of collision is why CI and docs use
  `pnpm run <script>` everywhere.
- `pnpm-workspace.yaml` (not a `pnpm` field in `package.json` — pnpm 11 no
  longer reads one) carries the supply-chain settings:
  `strictDepBuilds`, `blockExoticSubdeps`, `trustPolicy: no-downgrade` (with a
  3-day `trustPolicyIgnoreAfter` window), `minimumReleaseAge` of 3 days
  excluding `@appthreat/*`.
- `onlyBuiltDependencies` is intentionally empty today; `strictDepBuilds`
  fails the install naming anything blocked, so a needed entry cannot be
  missed silently. Expect `@biomejs/biome` to be added when Biome lands.
