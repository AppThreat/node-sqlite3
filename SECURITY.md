# Security policy

## Reporting a vulnerability

Report vulnerabilities privately to **cloud@appthreat.com** (the package
maintainers, Team AppThreat). Include:

- a minimal reproducer (code and, where relevant, a database file),
- the affected versions — of this package **and** of the vendored SQLite
  (`sqlite3.VERSION` reports it at runtime),
- the environment (Node/Electron version, OS and architecture, and
  whether the build is a shipped prebuild or a source build).

Please do not open public issues for unreported vulnerabilities. We aim
to respond within a week.

## Scope

This package embeds the SQLite amalgamation and exposes it to Node. A
report is in scope if it concerns:

- the JavaScript layer (`lib/`) or the native addon (`src/`) of this
  package, or
- a vulnerability in the vendored SQLite version that this package
  ships, including its default build configuration (the compile-time
  defines are in `deps/sqlite3.gyp`).

Out of scope: vulnerabilities requiring the attacker to already control
executed SQL (SQL is trusted input — see
[docs/security.md](docs/security.md)), or already-allowed extension
loading, which is arbitrary code execution **by design**.

## Vendored-SQLite CVE response

The amalgamation is pinned (`deps/sqlite-amalgamation-3530400`, SQLite
3.53.4) and the package inherits its CVEs. When a SQLite CVE is
published:

1. the maintainers assess whether the vulnerable code is reachable in
   this package's build (the amalgamation is compiled with a specific
   feature set — `deps/sqlite3.gyp` — which can exclude a vulnerable
   feature entirely);
2. if reachable, the amalgamation is bumped to the fixed SQLite version
   in a dedicated version bump (never folded silently into a feature
   change), and a release ships with the CVE identifier in the notes;
3. the policy for reporting SQLite CVEs upstream is the SQLite project's
   own process — this package does not adjudicate SQLite bugs, it tracks
   releases.

Check what you are running with `sqlite3.VERSION` and compare against
[SQLite's change log](https://sqlite.org/changes.html).
