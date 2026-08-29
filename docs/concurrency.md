# Concurrency: one connection, many connections, workers, and the pool

One page on what is actually concurrent in this package, what merely
looks concurrent, and which tool to reach for. Everything here is about
`@appthreat/sqlite3` v9.

## What serialize() and parallelize() really do

`db.serialize()` does not make anything run in parallel — it is the
opposite. It makes the connection's **queue strictly FIFO**: while it is
in effect, every call through the database queue (statements' prepares,
`exec`, `close`, hook registrations…) waits for everything queued before
it. Under `serialize()` _every_ queued call is treated as exclusive, so
it is full serialization of the queue, not merely an ordering of starts.

`db.parallelize()` (the default) lets non-exclusive work overlap:
statement stepping happens on libuv worker threads while the JS thread
continues, and the driver's queues only enforce what SQLite itself
requires (one write at a time, exclusive operations waiting for a quiet
connection).

Two things bypass the database queue entirely:

- **Statement operations** (`stmt.get()`, `stmt.all()`, … on a statement
  you hold) never pass through the database queue — they run as soon as
  the statement itself is free. This is why `db.serialize()` disables
  the statement-cache fast path (`db.run/get/all/…` fall back to fresh
  prepares, which _do_ go through the queue): a cached statement would
  overtake the serialization you asked for.
- **The synchronous methods** (`getSync`/`runSync`/`allSync`) run on the
  JS thread and refuse to run unless the connection is fully idle — they
  are a fast path for quiet moments, not a way to jump the queue.

## SQLITE_BUSY, busy_timeout, and WAL

- SQLite allows **one writer at a time** per database file. A second
  write arriving while the first runs fails with `SQLITE_BUSY` — unless
  a busy timeout is set, in which case it waits. This driver sets
  `busy_timeout = 1000` on open; `configure('busyTimeout', ms)` or
  `PRAGMA busy_timeout` changes it.
- In rollback-journal mode (the default for new files created without
  WAL), a **reader also blocks the writer**: taking a read lock prevents
  the write lock.
- **WAL mode** (`PRAGMA journal_mode = WAL`) is the fix for
  reader/writer contention: readers read the committed snapshot without
  blocking the writer, and the writer appends to the WAL without
  blocking readers. It is a persistent property of the file — set it
  once. The tradeoffs: `-wal`/`-shm` sidecar files, and checkpointing
  (`db.checkpoint({ mode: 'truncate' })`) to keep the WAL bounded.

`SQLITE_BUSY` in one sentence: two connections (or a pool — see below)
wanted the same lock at once and nobody had set a timeout long enough to
absorb it. Fix it with WAL plus `busy_timeout`, or by serializing
yourself (one writer connection — which is what the pool does).

## When to use what

### One connection (the default)

A single `Database` object already gives you concurrency between SQLite
and your JS: queries step on worker threads while your code runs. For
most services — one process, mixed read/write, no long queries — one
connection is the right answer, and `db.transaction()` gives you
atomicity. Long-running queries will still delay the _connection_,
because SQLite serializes work per connection.

### Several connections to one file

Open one read-write connection per process (or a few), set WAL, set a
generous `busy_timeout`, and let readers multiply. This is the standard
scaling shape for multi-process access. Remember:

- one writer at a time, always — more writer connections does not mean
  more write throughput, only more `SQLITE_BUSY` unless you make writes
  single-threaded per process;
- readers see committed data only; a transaction's own uncommitted
  writes are visible to its own connection and nobody else.

### Worker threads: the path handoff

A `sqlite3*` handle, a `Database` JS object, a prepared statement — none
of these can cross a `worker_threads` boundary. What crosses cheaply is
**the path**:

```js
const { Worker } = require("node:worker_threads");
const w = new Worker("./db-worker.js", {
  workerData: { filename: "app.db", mode: sqlite3.OPEN_READONLY },
});
```

The worker opens its own connection to the same file. With WAL mode this
gives real read concurrency and keeps the main thread free of SQLite
work entirely. This is what most worker use cases actually want, and it
needs no special support — the addon is context-aware and loads cleanly
in every worker (each worker gets its own constructors; nothing
napi-shaped is shared between environments).

### Worker threads: the bytes handoff

An **in-memory** database can be moved across threads with one copy:

```js
// main thread
const bytes = await db.serializeToBytes();
const movable = bytes.slice().buffer; // plain ArrayBuffer copy
w.postMessage({ bytes: movable }, [movable]); // transfer: zero further copies

// worker
const { workerData } = require("node:worker_threads");
const db = await sqlite3.deserializeFromBytes(
  new Uint8Array(workerData.bytes),
  { resizable: true },
);
```

The `slice()` is required: `serializeToBytes()` returns a view over
SQLite-owned memory, which structured clone refuses to transfer. After
the transfer the worker owns a live, writable in-memory database; the
main thread's copy is gone (detached). This is the mechanism for
snapshotting to a worker for read-heavy analysis without touching the
original.

Cancelling a query across threads needs no round trip: create a
`db.cancellationToken()` in whichever thread owns the connection, send
its `buffer` (a `SharedArrayBuffer`, shared memory) to the other thread,
and `Atomics.store(new Int32Array(buffer), 0, 1)` there — the running
query aborts with `SQLITE_INTERRUPT`.

### The pool

```js
const pool = await sqlite3.pool("app.db", {
  readers: 4, // read-only worker connections
  walMode: true, // PRAGMA journal_mode = WAL (default)
  busyTimeout: 5000, // per connection (default)
});

const rows = await pool.read("SELECT * FROM t WHERE a = ?", [1]);
const user = await pool.get("SELECT * FROM t WHERE a = ?", [1]);
await pool.write("INSERT INTO t (a) VALUES (?)", [1]);

await pool.transaction(async (tx) => {
  // pinned to the writer; tx.get sees uncommitted writes
  const row = await tx.get("SELECT a FROM t");
  await tx.write("UPDATE t SET a = ?", [row.a + 1]);
});

await pool.close(); // drains, closes, terminates — no worker survives
```

One writer connection plus N reader connections, each on its own worker
thread. Writes queue on the writer (they were going to serialize inside
SQLite anyway — the pool converts `SQLITE_BUSY` retry loops into
queueing). Reads fan out to the least-busy reader. `pool.transaction()`
pins the whole transaction to the writer and holds it: concurrent
transactions wait, nothing interleaves inside yours, and the pool-facing
write methods refuse from inside a body (they would wait on your own
transaction) — use the `tx` handle.

What the pool is **not**: it is not the default API, and it is not for
bulk data. Rows are structured-cloned across `postMessage`, so a large
result set pays a full copy, and blob columns come back as plain
`Uint8Array` rather than `Buffer`. For `SELECT *` over a million rows,
use a dedicated worker with the path or bytes handoff instead. Errors
keep their SQLite diagnostics (`code`, `errno`, `primaryCode`) — the
worker re-serializes them explicitly, because structured clone drops an
Error's own properties.

`pool.close()` is idempotent, drains accepted work (a running
transaction finishes or rolls back), closes every connection and waits
for every worker's exit. `await using pool` works.

## Terminating a worker

`worker.terminate()` while a query is in flight used to abort the whole
process: the query's completion is delivered to the addon while V8 is
unwinding the isolate, and every call that enters JS there fails — but
the binding layer's error path is itself a JS call, so the failure
escalates to `FATAL ERROR: napi_throw` rather than an exception you can
catch. The addon now detects that state at the top of each completion
and drops the delivery instead.

The detection happens when the completion starts, so it does not cover
the case where termination lands **in the middle** of one: a completion
that is still converting rows when the isolate goes down can still abort
the process. In practice that needs several completions queued at once —
a tight loop issuing queries without awaiting them — and it is unchanged
from v8. Closing it fully means status-checking every JS call in the
completion handlers rather than relying on the binding layer's checked
helpers, which is a change of its own.

The safe pattern, and the one worth preferring regardless, is to shut a
worker down cooperatively — tell it to stop, `await db.close()`, let the
thread exit — and keep `terminate()` for workers that have stopped
responding. `pool.close()` does exactly this; the pool only calls
`terminate()` on the startup-failure path, where no query can be in
flight.

## A note on cancellation

All cancellation in this package (`{ signal }` options, the pool, the
cross-thread token above) is **cooperative and interrupt-based**: the
running statement is interrupted (`SQLITE_INTERRUPT`), work that was
queued but not started may simply never run, and an abort that loses the
race with a completing query still rejects and drops the result. None of
it can roll back a committed write — that is what transactions are for.
