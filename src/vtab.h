#ifndef NODE_SQLITE3_SRC_VTAB_H
#define NODE_SQLITE3_SRC_VTAB_H

// JavaScript virtual tables (Phase 4): `db.table(name, definition)`.
//
// The better-sqlite3-proven shape, read-only in v1: a JS generator
// function produces rows, described by a column list; entries of
// `parameters` are declared HIDDEN, which turns the module into a
// table-valued function (`SELECT * FROM name(arg)` passes `arg` to the
// generator through an equality constraint — see xBestIndex). A factory
// function instead of a definition registers a named module instantiated
// per `CREATE VIRTUAL TABLE ... USING name(args)`.
//
// Threading:
//
//  - xBestIndex/xEof/xColumn/xRowid are pure C++ over the rows buffered on
//    the cursor, so the query planner (prepare path) never calls
//    JavaScript — the same design principle as the C++ authorizer.
//  - xFilter invokes the generator and buffers its first batch of rows;
//    xNext pulls another batch only when the cursor has consumed the last
//    one (64 rows, doubling to 1024). Batching is what makes `LIMIT 3`
//    over an unbounded generator terminate, and what keeps a table larger
//    than memory streamable, while a full scan still pays only one round
//    trip per 1024 rows. On a worker each pull is one blocking round trip
//    to the JS thread; on the synchronous path (sync_sqlite_depth > 0) it
//    is a direct re-entrant call, like Phase 2's user functions.
//  - A scan abandoned early (LIMIT, or an error) drops the iterator
//    without resuming it: the generator is left suspended, so a `finally`
//    inside it does not run. Generator cleanup is not a place to release
//    resources.
//  - Registration/removal are scheduled exclusively and refuse from
//    inside a sync-invoked callback (a stepping VM holds the module).
//
// Instances keep a raw VtabModule*. The registry on Database owns the
// holders, and sqlite decides when one may die: it calls the
// sqlite3_create_module_v2 destructor (VtabOps::ModuleDestroy) once the
// registration has been replaced or dropped *and* every instance created
// against it has been disconnected. That destructor can fire on a worker
// (sqlite3_close), where napi calls are illegal, so it hands the holder to
// Database::QueueVtabModule and the JS thread frees it (Process /
// ~Database). RemoveVtabs only mops up holders sqlite never took.

#include <string>
#include <vector>

#include <sqlite3.h>
#include <napi.h>
#include <uv.h>

#include "convert.h"
#include "database.h"

namespace node_sqlite3 {

// One registered module. Columns/params are captured here so xConnect can
// build the declare_vtab DDL without JavaScript.
struct VtabModule {
    Database* db;
    std::string name;
    std::vector<std::string> columns;   // visible result columns
    std::vector<std::string> params;    // HIDDEN table-function parameters
    bool has_factory = false;
    Napi::FunctionReference factory;    // has_factory: (args...) => definition
    Napi::FunctionReference rows;       // otherwise: the generator itself
    sqlite3_module* module = NULL;      // the registration handed to sqlite
    bool dead = false;                  // dropped; instances may still hold it
};

// Per-instance state (eponymous: one per connection; factory: one per
// CREATE VIRTUAL TABLE). Carries the factory-produced definition when the
// module was registered through a factory.
struct VtabInstance {
    sqlite3_vtab base;
    VtabModule* module;
    // A factory instantiation's own rows generator (NULL for eponymous
    // instances, which use the module's). A raw napi_ref because
    // xDisconnect — which must hand it back — can run on a worker thread
    // (sqlite3_close), where napi calls are not allowed; it queues onto
    // Database::pending_vtab_refs instead and the JS thread deletes it.
    napi_ref rows_ref = NULL;
};

struct VtabCursor {
    sqlite3_vtab_cursor base;
    VtabInstance* instance;
    Rows rows;          // the current batch
    size_t pos = 0;     // position within the batch
    // The live iterator (a raw napi_ref: xClose can run on a worker, so
    // the reference is queued for the JS thread like rows_ref), the next
    // batch size, and whether the generator is done.
    napi_ref iterator = NULL;
    size_t batch = 0;
    bool exhausted = false;
    // Rows delivered by earlier batches, so xRowid stays monotonic across
    // batch boundaries (it is `produced + pos + 1`).
    size_t produced = 0;
    // The hidden-parameter values xFilter received, indexed by parameter
    // position, and which of them were supplied: a row that leaves a
    // HIDDEN column NULL reports the argument the table-valued function
    // was called with, so `SELECT count FROM seq(3)` and a second
    // equality constraint on the same parameter both behave.
    std::vector<Cell> args;
    std::vector<bool> has_arg;
};

// JS-visible entry points on Database (wrapped by lib/sqlite3.js, which
// validates the definition and flushes the statement cache). Declarations
// live in database.h alongside the other registration surface; this file
// declares the module/instance/cursor types above.

} // namespace node_sqlite3

#endif
