// JavaScript virtual tables (Phase 4). See src/vtab.h for the design.
//
// JavaScript is reached from xFilter (invoke the generator, take the first
// batch of rows) and from xNext when a cursor runs out of buffered rows —
// never from the prepare path, which is pure C++. Rows are pulled in
// growing batches (kVtabFirstBatch..kVtabMaxBatch) instead of draining the
// iterator, so `SELECT … LIMIT 3` over an unbounded generator stops after
// one batch instead of running forever, and a table larger than memory
// streams. On the sync path each pull is a direct re-entrant call (Phase 2
// machinery, same guard: sync_sqlite_depth > 0 implies the JS thread); on
// a worker it blocks on the per-database vtab channel like a user
// function.

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <sqlite3.h>
#include <napi.h>
#include <uv.h>

#include "macros.h"
#include "convert.h"
#include "database.h"
#include "vtab.h"

using namespace node_sqlite3;

namespace {

// One xFilter (or factory-instantiation) round trip: the worker fills the
// request half, the JS thread runs the generator (or factory) and fills
// `rows`, then whoever waits is signalled. Direct sync calls fill the same
// struct inline without the channel.
// How many rows one pull asks the generator for. The first batch is small
// so a LIMIT 1 query does not run a generator 1024 times; later batches
// grow so a full scan pays one round trip per 1024 rows.
const size_t kVtabFirstBatch = 64;
const size_t kVtabMaxBatch = 1024;

struct VtabCall {
    // kCreate instantiates a factory module; kOpen invokes the generator
    // and takes the first batch; kPull takes the next batch from the
    // iterator a kOpen left on the cursor.
    enum Kind { kCreate, kOpen, kPull };

    Database* db;
    VtabModule* module;
    Kind kind = kOpen;
    // Factory instantiation: the CREATE VIRTUAL TABLE argument strings,
    // and the definition's rows generator is published as a raw napi_ref.
    std::vector<std::string> create_args;
    napi_ref factory_rows = NULL;

    // xFilter: the hidden-parameter values, and the generator to invoke —
    // the instance's factory-produced one (a raw napi_ref, because
    // xDisconnect must be able to hand it back to the JS thread from any
    // thread), or the module's (a FunctionReference read on this, the JS,
    // thread).
    napi_ref instance_rows = NULL;
    Napi::FunctionReference* module_rows = NULL;
    std::vector<Cell> params;
    // Which entries of `params` the query actually supplied: an
    // unconstrained HIDDEN parameter reaches the generator as `undefined`
    // (SQL NULL is a value someone passed on purpose).
    std::vector<bool> params_supplied;

    // The live iterator: produced by kOpen, consumed by every kPull, owned
    // by the cursor in between (a raw napi_ref for the same reason as
    // instance_rows: xClose can run on a worker).
    napi_ref iterator = NULL;
    size_t want = kVtabFirstBatch;
    bool exhausted = false;

    // Result half.
    Rows rows_out;
    bool errored = false;
    std::string error;

    uv_mutex_t mutex;
    uv_cond_t cond;
    bool done = false;

    VtabCall(Database* db_, VtabModule* module_) : db(db_), module(module_) {
        uv_mutex_init(&mutex);
        uv_cond_init(&cond);
    }
    ~VtabCall() {
        uv_mutex_destroy(&mutex);
        uv_cond_destroy(&cond);
    }
};

void DisposeVtabCall(VtabCall* call) {
    delete call;
}

// Applies one materialised Cell to a cursor column result slot (same
// mapping ApplyCell uses for function results in src/function.cc).
void ApplyCellToResult(sqlite3_context* ctx, const Cell& cell) {
    switch (cell.type) {
        case SQLITE_INTEGER:
            sqlite3_result_int64(ctx, cell.integer);
            break;
        case SQLITE_FLOAT:
            sqlite3_result_double(ctx, cell.real);
            break;
        case SQLITE_TEXT:
            sqlite3_result_text(ctx, cell.str.data(),
                static_cast<int>(cell.str.size()), SQLITE_TRANSIENT);
            break;
        case SQLITE_BLOB:
            sqlite3_result_blob(ctx,
                cell.str.empty() ? "" : cell.str.data(),
                static_cast<int>(cell.str.size()), SQLITE_TRANSIENT);
            break;
        default:
            sqlite3_result_null(ctx);
    }
}

// Consumes the pending JS exception: appends its `message` to `text` (when
// it has one) and keeps the thrown value on the database as the `cause` of
// the step failure this is about to produce — the same contract a throwing
// user-defined function gets (src/function.cc SetCallError), so
// `err.cause` means the same thing whichever kind of callback threw.
static void CaptureVtabThrow(Napi::Env env, Database* db, std::string* text) {
    napi_value pending = NULL;
    napi_get_and_clear_last_exception(env, &pending);
    if (pending == NULL) return;
    Napi::Value err(env, pending);
    if (err.IsObject()) {
        Napi::Value msg = err.As<Napi::Object>().Get("message");
        if (!env.IsExceptionPending()) {
            if (text != NULL && msg.IsString()) {
                *text += ": " + msg.As<Napi::String>().Utf8Value();
            }
        }
        else {
            // Reading .message threw (a hostile getter); the value is
            // still worth carrying as the cause.
            napi_value stray = NULL;
            napi_get_and_clear_last_exception(env, &stray);
        }
    }
    db->SetPendingJsError(err);
}

// Converts one yielded JS value into a Cell via the shared bind converter
// (strict marshalling: no [object Object], no silent coercion). Returns
// false with the call marked errored.
bool YieldedValueToCell(Napi::Env env, Database* db, VtabCall* call,
        Napi::Value value, const std::string& what, Cell* out) {
    auto field = ConvertToField(value, what);
    if (field == nullptr) {
        call->errored = true;
        napi_value pending = NULL;
        napi_get_and_clear_last_exception(env, &pending);
        Napi::Value err(env, pending);
        if (err.IsObject()) {
            Napi::Value msg = err.As<Napi::Object>().Get("message");
            if (!env.IsExceptionPending() && msg.IsString()) {
                call->error = msg.As<Napi::String>().Utf8Value();
                return false;
            }
            napi_get_and_clear_last_exception(env, &pending);
        }
        call->error = "a row yielded by virtual table module '" +
            call->module->name + "' holds an unsupported value";
        return false;
    }
    switch (field->type) {
        case SQLITE_INTEGER:
            out->type = SQLITE_INTEGER;
            out->integer = static_cast<Values::Integer*>(field.get())->value;
            break;
        case SQLITE_FLOAT:
            out->type = SQLITE_FLOAT;
            out->real = static_cast<Values::Float*>(field.get())->value;
            break;
        case SQLITE_TEXT:
            out->type = SQLITE_TEXT;
            out->str = std::move(static_cast<Values::Text*>(field.get())->value);
            break;
        case SQLITE_BLOB: {
            auto* f = static_cast<Values::Blob*>(field.get());
            out->type = SQLITE_BLOB;
            out->str.assign(f->value, f->length);
            break;
        }
        default:
            out->type = SQLITE_NULL;
    }
    return true;
}

// Reads one row-shaped yielded value into `row`. Returns false with the
// call marked errored.
bool YieldedRowToCells(Napi::Env env, Database* db, VtabCall* call,
        Napi::Value yielded, size_t ncols, Row* row) {
    VtabModule* module = call->module;
    const std::string where = "row " +
        std::to_string(call->rows_out.size() + 1) +
        " of the virtual table '" + module->name + "'";
    if (yielded.IsArray()) {
        Napi::Array arr = yielded.As<Napi::Array>();
        uint32_t len = arr.Length();
        if (len > ncols) len = static_cast<uint32_t>(ncols);
        for (uint32_t i = 0; i < len; i++) {
            Napi::Value v = arr.Get(i);
            if (env.IsExceptionPending()) {
                napi_value pending = NULL;
                napi_get_and_clear_last_exception(env, &pending);
            }
            if (!YieldedValueToCell(env, db, call, v, where, &(*row)[i])) {
                return false;
            }
        }
        return true;
    }
    if (yielded.IsObject() && !yielded.IsFunction()) {
        Napi::Object obj = yielded.As<Napi::Object>();
        for (size_t i = 0; i < ncols; i++) {
            Napi::Value v = obj.Get(module->columns[i]);
            if (env.IsExceptionPending()) {
                call->errored = true;
                call->error = "a row yielded by virtual table '" +
                    module->name + "' has a hostile property getter";
                napi_value pending = NULL;
                napi_get_and_clear_last_exception(env, &pending);
                return false;
            }
            if (!YieldedValueToCell(env, db, call, v, where, &(*row)[i])) {
                return false;
            }
        }
        return true;
    }
    // A bare value: the single-column-table convenience.
    if (ncols == 1) {
        return YieldedValueToCell(env, db, call, yielded, where, &(*row)[0]);
    }
    call->errored = true;
    call->error = "a row yielded by virtual table '" + module->name +
        "' must be an array or an object (the table has " +
        std::to_string(ncols) + " columns)";
    return false;
}

// Pulls up to call->want rows out of `iter`, appending them to
// call->rows_out and setting call->exhausted when the iterator is done.
void PullRows(Napi::Env env, Database* db, VtabCall* call, Napi::Object iter) {
    VtabModule* module = call->module;
    const size_t ncols = module->columns.size();

    Napi::Value next_v = iter.Get("next");
    if (env.IsExceptionPending() || !next_v.IsFunction()) {
        call->errored = true;
        call->error = "the rows generator of virtual table '" +
            module->name + "' did not return an iterable";
        napi_value pending = NULL;
        napi_get_and_clear_last_exception(env, &pending);
        return;
    }
    Napi::Function next_fn = next_v.As<Napi::Function>();

    while (call->rows_out.size() < call->want) {
        Napi::Value step = next_fn.Call(iter, {});
        if (env.IsExceptionPending()) {
            call->errored = true;
            call->error = "the rows generator of virtual table '" +
                module->name + "' threw";
            CaptureVtabThrow(env, db, &call->error);
            return;
        }
        if (!step.IsObject()) {
            call->errored = true;
            call->error = "the rows generator of virtual table '" +
                module->name + "' produced a malformed iteration result";
            return;
        }
        Napi::Object result = step.As<Napi::Object>();
        Napi::Value done_v = result.Get("done");
        if (env.IsExceptionPending() || !done_v.IsBoolean()) {
            call->errored = true;
            call->error = "the rows generator of virtual table '" +
                module->name + "' produced a malformed iteration result";
            napi_value pending = NULL;
            napi_get_and_clear_last_exception(env, &pending);
            return;
        }
        if (done_v.As<Napi::Boolean>().Value()) {
            call->exhausted = true;
            return;
        }
        Napi::Value yielded = result.Get("value");
        if (env.IsExceptionPending()) {
            napi_value pending = NULL;
            napi_get_and_clear_last_exception(env, &pending);
        }
        Row row(ncols);
        if (!YieldedRowToCells(env, db, call, yielded, ncols, &row)) return;
        call->rows_out.emplace_back(std::move(row));
    }
}

// The JS-thread half of one VtabCall.
void ExecuteVtabCallOnJsThread(napi_env nenv, VtabCall* call) {
    Napi::Env env(nenv);
    Napi::HandleScope scope(env);
    Database* db = call->db;
    VtabModule* module = call->module;

    if (module->dead) {
        call->errored = true;
        call->error = "virtual table module '" + module->name +
            "' was removed while a query against it was in flight";
        return;
    }

    if (call->kind == VtabCall::kCreate) {
        // Factory instantiation: run the factory with the CREATE VIRTUAL
        // TABLE argument strings; the definition it returns supplies this
        // instance's rows generator.
        Napi::Function factory = module->factory.IsEmpty()
            ? Napi::Function() : module->factory.Value();
        if (factory.IsEmpty()) {
            call->errored = true;
            call->error = "virtual table module '" + module->name +
                "' has no factory";
            return;
        }
        std::vector<napi_value> argv;
        argv.reserve(call->create_args.size());
        for (const auto& arg : call->create_args) {
            argv.push_back(Napi::String::New(env, arg));
        }
        Napi::Value definition = factory.Call(env.Undefined(), argv);
        if (env.IsExceptionPending()) {
            call->errored = true;
            call->error = "the factory of virtual table module '" +
                module->name + "' threw";
            CaptureVtabThrow(env, db, &call->error);
            return;
        }
        Napi::Value rows = definition.IsObject()
            ? definition.As<Napi::Object>().Get("rows")
            : env.Undefined();
        if (env.IsExceptionPending()) {
            napi_value pending = NULL;
            napi_get_and_clear_last_exception(env, &pending);
        }
        if (!rows.IsFunction()) {
            call->errored = true;
            call->error = "the factory of virtual table module '" +
                module->name + "' must return a definition with a rows " +
                "generator function";
            return;
        }
        napi_create_reference(env, rows, 1, &call->factory_rows);
        return;
    }

    if (call->kind == VtabCall::kPull) {
        // The cursor's iterator, mid-scan: take the next batch.
        napi_value iter_v = NULL;
        if (call->iterator != NULL) {
            napi_get_reference_value(env, call->iterator, &iter_v);
        }
        if (iter_v == NULL) {
            call->errored = true;
            call->error = "the rows iterator of virtual table '" +
                module->name + "' disappeared mid-scan";
            return;
        }
        PullRows(env, db, call, Napi::Object(env, iter_v));
        return;
    }

    // kOpen (xFilter): convert the parameters, invoke the generator, take
    // its iterator and the first batch of rows.
    Napi::Function rows_fn;
    if (call->instance_rows != NULL) {
        napi_value fn = NULL;
        napi_get_reference_value(env, call->instance_rows, &fn);
        if (fn != NULL) rows_fn = Napi::Function(env, fn);
    }
    else if (call->module_rows != NULL && !call->module_rows->IsEmpty()) {
        rows_fn = call->module_rows->Value();
    }
    if (rows_fn.IsEmpty()) {
        call->errored = true;
        call->error = "virtual table module '" + module->name +
            "' has no rows generator";
        return;
    }

    const int integer_mode = db->IntegerMode();
    std::vector<napi_value> argv;
    argv.reserve(call->params.size());
    for (size_t i = 0; i < call->params.size(); i++) {
        const bool supplied = i < call->params_supplied.size()
            && call->params_supplied[i];
        argv.push_back(supplied
            ? CellToJS(env, call->params[i], integer_mode,
                "argument " + std::to_string(i + 1) +
                    " of the virtual table '" + module->name + "'")
            : static_cast<napi_value>(env.Undefined()));
        if (env.IsExceptionPending()) {
            call->errored = true;
            call->error = "cannot pass an argument of the virtual table '" +
                module->name + "' to JavaScript";
            napi_value pending = NULL;
            napi_get_and_clear_last_exception(env, &pending);
            return;
        }
    }

    Napi::Value iterable_v = rows_fn.Call(env.Undefined(), argv);
    if (env.IsExceptionPending() || !iterable_v.IsObject()) {
        call->errored = true;
        if (env.IsExceptionPending()) {
            call->error = "the rows generator of virtual table '" +
                module->name + "' threw";
            CaptureVtabThrow(env, db, &call->error);
        }
        else {
            call->error = "the rows generator of virtual table '" +
                module->name + "' did not return an iterable";
        }
        return;
    }

    Napi::Object iterable = iterable_v.As<Napi::Object>();
    // for..of drives [Symbol.iterator]() first.
    Napi::Value iter_fn = iterable.Get(
        Napi::Symbol::WellKnown(env, "iterator"));
    if (env.IsExceptionPending() || !iter_fn.IsFunction()) {
        call->errored = true;
        call->error = "the rows generator of virtual table '" +
            module->name + "' did not return an iterable";
        napi_value pending = NULL;
        napi_get_and_clear_last_exception(env, &pending);
        return;
    }
    Napi::Value iter_v = iter_fn.As<Napi::Function>().Call(iterable, {});
    if (env.IsExceptionPending() || !iter_v.IsObject()) {
        call->errored = true;
        call->error = "the rows generator of virtual table '" +
            module->name + "' threw";
        napi_value pending = NULL;
        napi_get_and_clear_last_exception(env, &pending);
        return;
    }
    Napi::Object iter = iter_v.As<Napi::Object>();
    // The cursor keeps the iterator alive between pulls; xClose hands the
    // reference back to the JS thread (Database::QueueVtabRef).
    if (napi_create_reference(env, iter, 1, &call->iterator) != napi_ok) {
        call->errored = true;
        call->error = "cannot retain the rows iterator of virtual table '" +
            module->name + "'";
        return;
    }
    PullRows(env, db, call, iter);
}

// The tsfn dispatch: runs the call, then wakes the worker (a direct sync
// call never goes through here).
void VtabCallJs(napi_env nenv, napi_value /*jsCallback*/, void* /*context*/,
        void* data) {
    if (data == NULL) return;
    VtabCall* call = static_cast<VtabCall*>(data);
    ExecuteVtabCallOnJsThread(nenv, call);
    // No exception may escape into the tsfn dispatch machinery; always
    // clear a stray one (the check must be napi_is_exception_pending —
    // napi_get_and_clear_last_exception alone reports a non-NULL "last
    // exception" even after every exception has been handled).
    bool stray = false;
    napi_is_exception_pending(nenv, &stray);
    if (stray) {
        napi_value pending = NULL;
        napi_get_and_clear_last_exception(nenv, &pending);
        if (!call->errored) {
            call->errored = true;
            call->error = "internal error while invoking a virtual table's " +
                std::string("rows generator");
        }
    }
    uv_mutex_lock(&call->mutex);
    call->done = true;
    uv_cond_signal(&call->cond);
    uv_mutex_unlock(&call->mutex);
}

} // namespace

namespace node_sqlite3 {

// The sqlite3_module callbacks. Pure C++ except xConnect's factory half
// and xFilter's generator half, which round-trip (or run directly on the
// sync path).
struct VtabOps {

// Builds the CREATE TABLE declaration handed to sqlite3_declare_vtab.
// The parameters are a subset of the columns (the better-sqlite3
// contract): `parameters: ['n']` marks the column `n` HIDDEN, which is
// what turns the module into a table-valued function.
static std::string BuildDeclareSql(const VtabModule* module) {
    std::string sql = "CREATE TABLE x(";
    for (size_t i = 0; i < module->columns.size(); i++) {
        if (i > 0) sql += ",";
        sql += "\"" + module->columns[i] + "\"";
        for (const auto& param : module->params) {
            if (param == module->columns[i]) {
                sql += " HIDDEN";
                break;
            }
        }
    }
    sql += ")";
    return sql;
}

// Column index -> parameter position, or -1: the map xBestIndex/xFilter
// agree on. A parameter is whichever column the name names.
static int ParamIndex(const VtabModule* module, int col) {
    if (col < 0 || col >= static_cast<int>(module->columns.size())) {
        return -1;
    }
    const std::string& name = module->columns[static_cast<size_t>(col)];
    for (size_t p = 0; p < module->params.size(); p++) {
        if (module->params[p] == name) {
            return static_cast<int>(p);
        }
    }
    return -1;
}

static int Connect(sqlite3* handle, void* aux, int argc,
        const char* const* argv, sqlite3_vtab** vtab_out,
        char** pzErr) {
    auto* module = static_cast<VtabModule*>(aux);
    Database* db = module->db;

    // Factory modules: the instance gets its own rows generator from the
    // factory (one round trip / direct call). Eponymous modules use the
    // registered generator directly.
    auto* instance = new VtabInstance();
    instance->module = module;

    if (module->has_factory) {
        VtabCall* call = new VtabCall(db, module);
        call->kind = VtabCall::kCreate;
        // argv[3..] are the CREATE VIRTUAL TABLE arguments, as SQL text.
        for (int i = 3; i < argc; i++) {
            call->create_args.emplace_back(
                argv[i] != NULL ? argv[i] : "");
        }
        if (db->sync_sqlite_depth > 0) {
            ExecuteVtabCallOnJsThread(db->Env(), call);
            // Same always-clear rule as VtabCallJs: no exception may
            // escape into sqlite's C frames from the direct path.
            bool stray = false;
            napi_is_exception_pending(db->Env(), &stray);
            if (stray) {
                napi_value pending = NULL;
                napi_get_and_clear_last_exception(db->Env(), &pending);
                if (!call->errored) {
                    call->errored = true;
                    call->error = "internal error while invoking a virtual "
                        "table factory";
                }
            }
        }
        else {
            napi_status st = napi_call_threadsafe_function(
                db->vtab_channel, call, napi_tsfn_blocking);
            if (st != napi_ok) {
                call->errored = true;
                call->error = "the JavaScript environment is shutting down";
            }
            else {
                uv_mutex_lock(&call->mutex);
                while (!call->done) uv_cond_wait(&call->cond, &call->mutex);
                uv_mutex_unlock(&call->mutex);
            }
        }
        if (call->errored) {
            std::string err = call->error;
            DisposeVtabCall(call);
            delete instance;
            *vtab_out = NULL;
            if (pzErr != NULL) *pzErr = sqlite3_mprintf("%s", err.c_str());
            return SQLITE_ERROR;
        }
        instance->rows_ref = call->factory_rows;
        call->factory_rows = NULL;
        DisposeVtabCall(call);
    }

    int rc = sqlite3_declare_vtab(handle, BuildDeclareSql(module).c_str());
    if (rc != SQLITE_OK) {
        // Still on the creating thread's responsibility: hand the ref to
        // the queue rather than deleting it here (this can run on a
        // worker during CREATE VIRTUAL TABLE).
        db->QueueVtabRef(instance->rows_ref);
        delete instance;
        *vtab_out = NULL;
        return rc;
    }
    *vtab_out = &instance->base;
    return SQLITE_OK;
}

static int Disconnect(sqlite3_vtab* vtab) {
    auto* instance = reinterpret_cast<VtabInstance*>(vtab);
    // Runs on whatever thread dropped the table or closed the database
    // (a worker, for close). napi_delete_reference is not callable there,
    // so the reference is queued and deleted on the JS thread — see
    // Database::DrainVtabRefs.
    instance->module->db->QueueVtabRef(instance->rows_ref);
    delete instance;
    return SQLITE_OK;
}

// Factory modules are writable-shaped too in sqlite's eyes, but v1 is
// read-only: no xUpdate slot is registered at all.

static int BestIndex(sqlite3_vtab* vtab, sqlite3_index_info* info) {
    auto* instance = reinterpret_cast<VtabInstance*>(vtab);
    VtabModule* module = instance->module;

    // Equality constraints on the hidden parameters are the table-valued
    // function's arguments. sqlite requires the argvIndex values to be
    // 1..N with no gaps and no duplicates (it fails the statement with
    // "xBestIndex malfunction" otherwise), so they are handed out in the
    // order the constraints are consumed and the argv position -> declared
    // parameter mapping travels to xFilter in idxStr. Assigning
    // `parameter position + 1` instead — which is what this did — broke
    // `WHERE b = ?` on a later parameter and any duplicate constraint on
    // one parameter.
    //
    // Nothing is omitted. `aConstraintUsage[i].omit = 1` promises sqlite
    // the virtual table applied the constraint itself, and sqlite then
    // drops it from the WHERE clause entirely — but the constraint value
    // is only *delivered* to the generator as an argument, and a generator
    // is free to ignore it. A generator that writes its own values into a
    // parameter's column therefore defeated the query silently:
    // `WHERE n = 1` returned every row it yielded, `WHERE n IN (1,2)`
    // concatenated one unfiltered scan per IN value, and a join on that
    // column multiplied rows. Leaving omit at 0 costs one comparison per
    // row against the column value xColumn reports and makes *any*
    // generator correct — including the well-behaved shape, where xFilter
    // fills the HIDDEN columns the generator left NULL with the argument
    // (ApplyCursorArgs), so the re-check sees exactly what the caller
    // passed and passes.
    std::string mapping;
    int argv_n = 0;
    std::vector<bool> taken(module->params.size(), false);
    for (int i = 0; i < info->nConstraint; i++) {
        const auto& c = info->aConstraint[i];
        if (!c.usable || c.op != SQLITE_INDEX_CONSTRAINT_EQ) continue;
        int p = ParamIndex(module, c.iColumn);
        if (p < 0 || taken[static_cast<size_t>(p)]) continue;
        taken[static_cast<size_t>(p)] = true;
        info->aConstraintUsage[i].argvIndex = ++argv_n;
        if (!mapping.empty()) mapping += ",";
        mapping += std::to_string(p);
    }
    if (argv_n > 0) {
        info->idxStr = sqlite3_mprintf("%s", mapping.c_str());
        if (info->idxStr == NULL) return SQLITE_NOMEM;
        info->needToFreeIdxStr = 1;
    }
    info->estimatedCost = argv_n > 0 ? 10.0 : 1000000.0;
    info->estimatedRows = argv_n > 0 ? 10 : 1000000;
    info->idxNum = argv_n;
    return SQLITE_OK;
}

static int Open(sqlite3_vtab* vtab, sqlite3_vtab_cursor** cursor_out) {
    auto* instance = reinterpret_cast<VtabInstance*>(vtab);
    auto* cursor = new VtabCursor();
    cursor->base.pVtab = vtab;
    cursor->instance = instance;
    *cursor_out = &cursor->base;
    return SQLITE_OK;
}

static int Close(sqlite3_vtab_cursor* cursor_base) {
    auto* cursor = reinterpret_cast<VtabCursor*>(cursor_base);
    // Runs on whichever thread stepped the statement, so the iterator
    // reference is handed to the JS thread (napi_delete_reference is not
    // callable from a worker). An abandoned scan leaves the generator
    // suspended and never resumes it — see src/vtab.h.
    if (cursor->iterator != NULL) {
        cursor->instance->module->db->QueueVtabRef(cursor->iterator);
        cursor->iterator = NULL;
    }
    delete cursor;
    return SQLITE_OK;
}

static bool RunVtabCall(VtabCall* call, VtabInstance* instance) {
    Database* db = instance->module->db;
    if (db->sync_sqlite_depth > 0) {
        // Direct re-entrant call: this is the JS thread inside a *Sync
        // call (Phase 2 machinery). Same always-clear rule as VtabCallJs.
        ExecuteVtabCallOnJsThread(db->Env(), call);
        bool stray = false;
        napi_is_exception_pending(db->Env(), &stray);
        if (stray) {
            napi_value pending = NULL;
            napi_get_and_clear_last_exception(db->Env(), &pending);
            if (!call->errored) {
                call->errored = true;
                call->error =
                    "internal error while invoking a virtual table's rows " +
                    std::string("generator");
            }
        }
    }
    else {
        napi_status st = napi_call_threadsafe_function(
            db->vtab_channel, call, napi_tsfn_blocking);
        if (st != napi_ok) {
            call->errored = true;
            call->error =
                "the JavaScript environment is shutting down; the rows " +
                std::string("generator of virtual table '") +
                instance->module->name + "' cannot run";
            return false;
        }
        uv_mutex_lock(&call->mutex);
        while (!call->done) uv_cond_wait(&call->cond, &call->mutex);
        uv_mutex_unlock(&call->mutex);
    }
    return !call->errored;
}

// Reports a failed pull on the vtab instance, replacing any previous
// message (sqlite frees zErrMsg when it imports it, but never assume).
static void SetVtabError(VtabInstance* instance, const std::string& message) {
    if (instance->base.zErrMsg != NULL) {
        sqlite3_free(instance->base.zErrMsg);
    }
    instance->base.zErrMsg = sqlite3_mprintf("%s", message.c_str());
}

// Fills the HIDDEN parameter columns a row left NULL with the argument
// xFilter received for them (see BestIndex).
static void ApplyCursorArgs(VtabCursor* cursor, Row* row) {
    VtabModule* module = cursor->instance->module;
    for (size_t p = 0; p < cursor->args.size(); p++) {
        if (!cursor->has_arg[p]) continue;
        // The column this parameter names.
        for (size_t col = 0; col < module->columns.size(); col++) {
            if (module->columns[col] != module->params[p]) continue;
            if (col < row->size() && (*row)[col].type == SQLITE_NULL) {
                (*row)[col] = cursor->args[p];
            }
            break;
        }
    }
}

// One batch: kOpen for the first (xFilter), kPull afterwards (xNext).
static int PullBatch(VtabCursor* cursor, bool first) {
    auto* instance = cursor->instance;
    VtabModule* module = instance->module;

    VtabCall* call = new VtabCall(module->db, module);
    call->kind = first ? VtabCall::kOpen : VtabCall::kPull;
    call->want = cursor->batch;
    if (first) {
        // Factory instances carry their own generator; eponymous instances
        // use the module's.
        if (instance->rows_ref != NULL) {
            call->instance_rows = instance->rows_ref;
        }
        else {
            call->module_rows = &module->rows;
        }
        call->params = cursor->args;
        call->params_supplied = cursor->has_arg;
    }
    else {
        call->iterator = cursor->iterator;
        // The rows about to be replaced have all been delivered.
        cursor->produced += cursor->rows.size();
    }

    bool ok = RunVtabCall(call, instance);
    if (first && call->iterator != NULL) {
        // Taken even on failure: the reference exists and must be freed.
        cursor->iterator = call->iterator;
        call->iterator = NULL;
    }
    if (!ok) {
        std::string err = call->error;
        DisposeVtabCall(call);
        cursor->rows.clear();
        cursor->pos = 0;
        cursor->exhausted = true;
        SetVtabError(instance, err);
        return SQLITE_ERROR;
    }
    cursor->rows = std::move(call->rows_out);
    cursor->pos = 0;
    cursor->exhausted = call->exhausted;
    DisposeVtabCall(call);
    if (!cursor->args.empty()) {
        for (auto& row : cursor->rows) ApplyCursorArgs(cursor, &row);
    }
    // Grow the next batch: a scan pays one round trip per kVtabMaxBatch
    // rows, a LIMIT query only the small first one.
    if (cursor->batch < kVtabMaxBatch) {
        cursor->batch = cursor->batch * 2 < kVtabMaxBatch
            ? cursor->batch * 2 : kVtabMaxBatch;
    }
    return SQLITE_OK;
}

static int Filter(sqlite3_vtab_cursor* cursor_base, int /*idxNum*/,
        const char* idxStr, int argc, sqlite3_value** argv) {
    auto* cursor = reinterpret_cast<VtabCursor*>(cursor_base);
    auto* instance = cursor->instance;
    VtabModule* module = instance->module;

    // A cursor can be re-filtered (a correlated subquery re-runs it): drop
    // the previous scan's iterator first.
    if (cursor->iterator != NULL) {
        module->db->QueueVtabRef(cursor->iterator);
        cursor->iterator = NULL;
    }
    cursor->rows.clear();
    cursor->pos = 0;
    cursor->exhausted = false;
    cursor->batch = kVtabFirstBatch;
    cursor->produced = 0;

    // idxStr maps argv positions onto declared parameters (BestIndex).
    cursor->args.assign(module->params.size(), Cell());
    cursor->has_arg.assign(module->params.size(), false);
    int consumed = 0;
    if (idxStr != NULL) {
        const char* p = idxStr;
        while (*p != '\0' && consumed < argc) {
            char* end = NULL;
            long which = strtol(p, &end, 10);
            if (end == p) break;
            if (which >= 0 && which < static_cast<long>(cursor->args.size())) {
                ValueToCell(&cursor->args[static_cast<size_t>(which)],
                    argv[consumed]);
                cursor->has_arg[static_cast<size_t>(which)] = true;
            }
            consumed++;
            p = (*end == ',') ? end + 1 : end;
        }
    }

    return PullBatch(cursor, true);
}

static int Next(sqlite3_vtab_cursor* cursor_base) {
    auto* cursor = reinterpret_cast<VtabCursor*>(cursor_base);
    cursor->pos++;
    if (cursor->pos < cursor->rows.size() || cursor->exhausted) {
        return SQLITE_OK;
    }
    // The batch is spent and the generator has more: pull the next one.
    return PullBatch(cursor, false);
}

static int Eof(sqlite3_vtab_cursor* cursor_base) {
    auto* cursor = reinterpret_cast<VtabCursor*>(cursor_base);
    // xFilter and xNext always leave a row buffered unless the generator
    // is done, so an empty remainder means end of table.
    return cursor->pos >= cursor->rows.size() ? 1 : 0;
}

static int Column(sqlite3_vtab_cursor* cursor_base,
        sqlite3_context* ctx, int col) {
    auto* cursor = reinterpret_cast<VtabCursor*>(cursor_base);
    const size_t ncols = cursor->instance->module->columns.size();
    if (col < 0 || static_cast<size_t>(col) >= ncols
            || cursor->pos >= cursor->rows.size()) {
        sqlite3_result_null(ctx);
        return SQLITE_OK;
    }
    ApplyCellToResult(ctx,
        cursor->rows[cursor->pos][static_cast<size_t>(col)]);
    return SQLITE_OK;
}

static int Rowid(sqlite3_vtab_cursor* cursor_base, sqlite3_int64* rowid) {
    auto* cursor = reinterpret_cast<VtabCursor*>(cursor_base);
    // Position in the whole scan, not in the current batch: a per-batch
    // counter would hand out the same rowid to every batch.
    *rowid = static_cast<sqlite3_int64>(cursor->produced + cursor->pos) + 1;
    return SQLITE_OK;
}

// xDestroy for the sqlite3_create_module_v2 registration. sqlite calls it
// once the registration has been replaced or dropped *and* every instance
// created against it has been disconnected (sqlite3VtabModuleUnref), which
// is exactly when the holder may die — including at sqlite3_close, which
// unrefs every module. Waiting for ~Database instead (what this used to
// do) meant a dropped module's generator closure — and everything it
// captured, an entire db.values() array — stayed alive for the life of the
// connection.
//
// It can run on a worker (close, or a DROP dispatched there), so the
// holder is handed to the JS thread, which frees it (and its
// FunctionReferences) from Database::DrainVtabRefs.
static void ModuleDestroy(void* aux) {
    auto* module = static_cast<VtabModule*>(aux);
    module->dead = true;
    Database* db = module->db;
    auto& live = db->js_vtabs;
    for (auto it = live.begin(); it != live.end(); ++it) {
        if (*it == module) {
            live.erase(it);
            break;
        }
    }
    db->QueueVtabModule(module);
}

static void ReportVtabError(Database* db, const std::string& message,
        int rc = SQLITE_ERROR) {
    Napi::Env env = db->Env();
    if (env.IsExceptionPending()) return;
    Napi::HandleScope scope(env);
    Napi::Error err = Napi::Error::New(env, message);
    err.Value().As<Napi::Object>().Set("errno", Napi::Number::New(env, rc));
    Napi::Value info[] = { Napi::String::New(env, "error"), err.Value() };
    EMIT_EVENT(db->Value(), 2, info);
}

// Builds the sqlite3_module for one registration. Eponymous-only modules
// leave xCreate NULL (the table exists by name immediately and cannot be
// CREATE VIRTUAL TABLE'd); factory modules set both xCreate and xConnect.
static sqlite3_module* MakeModule(bool has_factory) {
    sqlite3_module* m = new sqlite3_module();
    // iVersion 0 keeps the modern fields unread (no xShadowName etc.).
    m->iVersion = 0;
    m->xCreate = has_factory ? Connect : NULL;
    m->xConnect = Connect;
    m->xBestIndex = BestIndex;
    m->xDisconnect = Disconnect;
    m->xDestroy = has_factory ? Disconnect : NULL;
    m->xOpen = Open;
    m->xClose = Close;
    m->xFilter = Filter;
    m->xNext = Next;
    m->xEof = Eof;
    m->xColumn = Column;
    m->xRowid = Rowid;
    m->xUpdate = NULL;
    m->xBegin = NULL;
    m->xSync = NULL;
    m->xCommit = NULL;
    m->xRollback = NULL;
    m->xFindFunction = NULL;
    m->xRename = NULL;
    m->xSavepoint = NULL;
    m->xRelease = NULL;
    m->xRollbackTo = NULL;
    m->xShadowName = NULL;
    return m;
}

static bool EnsureChannel(Database* db) {
    if (db->vtab_channel != NULL) return true;
    Napi::Env env = db->Env();
    Napi::Function noop = Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return info.Env().Undefined();
        });
    napi_value resource_name = Napi::String::New(env,
        "sqlite3.Database.Vtab");
    napi_threadsafe_function tsfn = NULL;
    napi_status st = napi_create_threadsafe_function(env, noop, NULL,
        resource_name, 0, 1, NULL, NULL, NULL, VtabCallJs, &tsfn);
    if (st != napi_ok || tsfn == NULL) return false;
    napi_unref_threadsafe_function(env, tsfn);
    db->vtab_channel = tsfn;
    return true;
}

static void ReleaseChannelIfIdle(Database* db) {
    if (db->vtab_channel != NULL && db->js_vtabs.empty()) {
        napi_release_threadsafe_function(db->vtab_channel,
            napi_tsfn_release);
        db->vtab_channel = NULL;
    }
}

}; // struct VtabOps

} // namespace node_sqlite3

namespace node_sqlite3 {

// --- JS-visible entry points -----------------------------------------------

// The registration baton: the module holder travels to the exclusive
// handler through it.
struct VtabBaton : Database::Baton {
    VtabModule* module = NULL;
    explicit VtabBaton(Database* db_, VtabModule* module_) :
            Baton(db_, Napi::Function()), module(module_) {}
    virtual ~VtabBaton() override = default;
};

// The stub a removed module is replaced with: every prepare against the
// name fails loudly instead of silently using stale JavaScript.
static int RefusedConnect(sqlite3*, void*, int, const char* const*,
        sqlite3_vtab** vtab_out, char** pzErr) {
    *vtab_out = NULL;
    if (pzErr != NULL) {
        *pzErr = sqlite3_mprintf(
            "this virtual table module was removed with db.removeTable()");
    }
    return SQLITE_ERROR;
}

// _registerVtab(name, columns[], params[], factory|null, rows|null).
// The JS layer validates the definition, flushes the statement cache and
// refuses while a sync-invoked callback is on the stack.
Napi::Value Database::RegisterVtab(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, name);
    if (info.Length() < 2 || !info[1].IsArray()) {
        Napi::TypeError::New(env,
            "Argument 1 must be the column name array").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (info.Length() < 3 || !info[2].IsArray()) {
        Napi::TypeError::New(env,
            "Argument 2 must be the parameter name array").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (db->sync_sqlite_depth > 0) {
        Napi::Error::New(env,
            "virtual tables cannot be registered from inside a JavaScript "
            "callback invoked by a synchronous method on this connection"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* module = new VtabModule();
    module->db = db;
    module->name = name;

    auto cols = info[1].As<Napi::Array>();
    module->columns.reserve(cols.Length());
    for (uint32_t i = 0; i < cols.Length(); i++) {
        Napi::Value c = cols.Get(i);
        if (!c.IsString()) {
            delete module;
            Napi::TypeError::New(env, "column names must be strings")
                .ThrowAsJavaScriptException();
            return env.Null();
        }
        module->columns.push_back(c.As<Napi::String>().Utf8Value());
    }
    auto params = info[2].As<Napi::Array>();
    module->params.reserve(params.Length());
    for (uint32_t i = 0; i < params.Length(); i++) {
        Napi::Value p = params.Get(i);
        if (!p.IsString()) {
            delete module;
            Napi::TypeError::New(env, "parameter names must be strings")
                .ThrowAsJavaScriptException();
            return env.Null();
        }
        module->params.push_back(p.As<Napi::String>().Utf8Value());
    }

    if (info.Length() > 3 && info[3].IsFunction()) {
        module->has_factory = true;
        module->factory.Reset(info[3].As<Napi::Function>(), 1);
    }
    else if (info.Length() > 4 && info[4].IsFunction()) {
        module->rows.Reset(info[4].As<Napi::Function>(), 1);
    }
    else {
        delete module;
        Napi::TypeError::New(env,
            "a virtual table definition requires a rows generator (or a "
            "factory function)").ThrowAsJavaScriptException();
        return env.Null();
    }
    db->Schedule(Work_RegisterVtab, new VtabBaton(db, module), true);
    return info.This();
}

// _removeVtab(name).
Napi::Value Database::RemoveVtab(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, name);
    if (db->sync_sqlite_depth > 0) {
        Napi::Error::New(env,
            "virtual tables cannot be removed from inside a JavaScript "
            "callback invoked by a synchronous method on this connection"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* baton = new Baton(db, Napi::Function());
    baton->message = name;
    db->Schedule(Work_RemoveVtab, baton, true);
    return info.This();
}

void Database::Work_RegisterVtab(Baton* b) {
    auto baton = std::unique_ptr<VtabBaton>(static_cast<VtabBaton*>(b));
    auto* db = baton->db;
    auto* module = baton->module;

    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    // A same-name re-registration replaces the module: sqlite disconnects
    // the old registration's instances and unrefs the old Module, which
    // calls VtabOps::ModuleDestroy — the holder is freed then, not here,
    // because a stepping VM may still hold an instance created against it
    // and its sqlite3_module must outlive that.
    for (auto* existing : db->js_vtabs) {
        if (existing->name == module->name) existing->dead = true;
    }

    if (!VtabOps::EnsureChannel(db)) {
        VtabOps::ReportVtabError(db, "cannot create the virtual table "
            "round-trip channel", SQLITE_NOMEM);
        delete module;
        db->exclusiveHeld = false;
        db->Process();
        return;
    }

    module->module = VtabOps::MakeModule(module->has_factory);
    int rc = sqlite3_create_module_v2(db->_handle, module->name.c_str(),
        module->module, module, VtabOps::ModuleDestroy);
    if (rc != SQLITE_OK) {
        VtabOps::ReportVtabError(db,
            "cannot register virtual table module '" + module->name +
                "': " + std::string(sqlite3_errmsg(db->_handle)), rc);
        delete module->module;
        module->module = NULL;
        delete module;
    }
    else {
        db->js_vtabs.push_back(module);
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::Work_RemoveVtab(Baton* b) {
    auto baton = std::unique_ptr<Baton>(b);
    auto* db = baton->db;

    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    // sqlite3_drop_modules works from a keep-list (it would also drop the
    // built-in fts5/rtree/... modules), so removal replaces the
    // registration with a stub whose xConnect refuses. sqlite unrefs (and
    // disconnects the instances of) the module being replaced.
    static sqlite3_module refused_module = []() {
        sqlite3_module m = {};
        m.iVersion = 0;
        m.xConnect = RefusedConnect;
        return m;
    }();
    bool found = false;
    for (auto* module : db->js_vtabs) {
        if (module->name == baton->message && !module->dead) {
            found = true;
            module->dead = true;
        }
    }
    int rc = SQLITE_OK;
    if (found) {
        rc = sqlite3_create_module(db->_handle, baton->message.c_str(),
            &refused_module, NULL);
        if (rc != SQLITE_OK) {
            VtabOps::ReportVtabError(db,
                "cannot remove virtual table module '" + baton->message +
                    "': " + std::string(sqlite3_errmsg(db->_handle)), rc);
        }
    }
    // The holder is freed by VtabOps::ModuleDestroy once sqlite has
    // disconnected the last instance created against it; until then the
    // dead flag fails any round trip that could still reach one.
    VtabOps::ReleaseChannelIfIdle(db);

    db->exclusiveHeld = false;
    db->Process();
}

void Database::RemoveVtabs() {
    // ~Database, after sqlite3_close: every module was unrefed by the
    // close, so VtabOps::ModuleDestroy has already queued each holder —
    // draining frees them. Whatever is left in js_vtabs was never handed
    // to sqlite (a failed sqlite3_create_module, or a connection that
    // never opened), so it is ours to free.
    DrainVtabRefs();
    for (auto* module : js_vtabs) {
        delete module->module;
        module->module = NULL;
        delete module;
    }
    js_vtabs.clear();
}

void Database::QueueVtabRef(napi_ref ref) {
    if (ref == NULL) return;
    uv_mutex_lock(&vtab_refs_mutex);
    pending_vtab_refs.push_back(ref);
    uv_mutex_unlock(&vtab_refs_mutex);
}

void Database::QueueVtabModule(VtabModule* module) {
    if (module == NULL) return;
    uv_mutex_lock(&vtab_refs_mutex);
    pending_vtab_modules.push_back(module);
    uv_mutex_unlock(&vtab_refs_mutex);
}

void Database::DrainVtabRefs() {
    // JS thread only: deleting the queued instance references and module
    // holders is napi work (a holder owns FunctionReferences), which is why
    // xDisconnect and xDestroy queued them instead.
    uv_mutex_lock(&vtab_refs_mutex);
    std::vector<napi_ref> refs;
    refs.swap(pending_vtab_refs);
    std::vector<VtabModule*> modules;
    modules.swap(pending_vtab_modules);
    uv_mutex_unlock(&vtab_refs_mutex);
    for (napi_ref ref : refs) {
        napi_delete_reference(Env(), ref);
    }
    for (VtabModule* module : modules) {
        // The sqlite3_module struct dies with the holder: sqlite has
        // dropped its last reference to both by now.
        delete module->module;
        module->module = NULL;
        delete module;
    }
}

bool Database::EnsureVtabChannel() {
    return VtabOps::EnsureChannel(this);
}

void Database::ReleaseVtabChannelIfIdle() {
    VtabOps::ReleaseChannelIfIdle(this);
}

} // namespace node_sqlite3
