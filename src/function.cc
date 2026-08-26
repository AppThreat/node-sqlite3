// User-defined functions, aggregates, window functions and collations
// (Deliverable 06). See src/function.h for the round-trip design.
//
// Threading model, restated:
//
//  - sqlite invokes xFunc/xStep/xFinal/xValue/xInverse/xCollation on
//    whatever thread steps the statement: a libuv worker for everything
//    the async API runs, the JS thread for the *Sync methods.
//  - On a worker, the callback marshals its arguments into Cells and
//    makes a blocking round trip through the per-database
//    ThreadSafeFunction: the JS thread converts, runs the user's JS,
//    marshals the result back and signals a condition variable.
//  - On the JS thread (Database::sync_sqlite_depth > 0), a round trip
//    would deadlock — the JS thread is the one blocked inside sqlite —
//    so the call is refused with an explicit error instead.
//
// Lifetime answers (the checklist items this file must have settled):
//
//  - JsFunc holders own Napi references but are only ever read, mutated
//    and destroyed on the JS thread. xDestroy (JsFuncDestroy) fires from
//    sqlite3_create_function_v2 / sqlite3_close / unregister calls, all of
//    which this codebase makes from the JS thread (registration handlers,
//    RemoveUserFunctions in Work_BeginClose and ~Database — Work_Close
//    runs only after Work_BeginClose already unregistered everything, and
//    the failed-close path keeps the survivors precisely so no dangling
//    registration outlives its holder).
//  - Registrations are scheduled exclusively, i.e. they run only when
//    nothing is in flight (pending == 0). That is what makes the above
//    safe (no round trip can be executing while a holder is destroyed)
//    and what keeps the registration's sqlite3_create_function_v2 from
//    blocking the JS thread on the connection mutex a worker holds while
//    blocked mid-round-trip.
//  - The channel (one ThreadSafeFunction per database) is Unref'd at
//    creation so it never keeps the event loop alive, and Released once
//    the last registration is gone. Queued items — only ever aggregate
//    cleanups — are still delivered after Release, and at environment
//    teardown they may be dropped; that leaks the (small) AggState whose
//    Napi reference the environment reclaims anyway. Bounded, and
//    reachable only at teardown.
//  - FuncCall ownership: the worker allocates; for waited calls it also
//    frees (after the wake); fire-and-forget cleanups are freed by the JS
//    thread. Enqueue failure (environment shutting down) leaves ownership
//    with the worker.

#include <cstring>
#include <string>
#include <vector>

#include <sqlite3.h>
#include <napi.h>
#include <uv.h>

#include "macros.h"
#include "convert.h"
#include "database.h"
#include "function.h"

using namespace node_sqlite3;

namespace {

// The error a user-defined function reached from a sync-path statement
// reports instead of deadlocking. prepareSync is not listed because it is
// not gated (and should not be): preparing never invokes a function.
std::string SyncRefusalMessage(const std::string& name) {
    return "user-defined function '" + name + "' cannot be invoked from a "
        "synchronous method (getSync/runSync/allSync): the "
        "JavaScript thread is blocked inside SQLite and cannot run the "
        "callback, which would deadlock. Use the asynchronous get/run/all/"
        "each instead, or express the logic in SQL.";
}

std::string RemovedMidFlightMessage(const std::string& name) {
    return "user-defined function '" + name + "' was removed while a call "
        "to it was still in flight";
}

// Human-readable JS type name for comparator/return validation errors.
std::string JsTypeName(const Napi::Value& value) {
    switch (value.Type()) {
        case napi_null:      return "null";
        case napi_undefined: return "undefined";
        case napi_boolean:   return "boolean";
        case napi_number:    return "number";
        case napi_string:    return "string";
        case napi_symbol:    return "symbol";
        case napi_object:    return "object";
        case napi_function:  return "function";
        case napi_bigint:    return "bigint";
        default:             return "value";
    }
}

// Extracts an error message from a thrown JS value without ever leaving a
// pending exception behind (the message getter of a hostile object can
// throw; anything pending after the reads is cleared and ignored).
std::string JsErrorMessage(Napi::Env env, Napi::Value err) {
    if (err.IsObject()) {
        Napi::Value msg = err.As<Napi::Object>().Get("message");
        if (!env.IsExceptionPending() && msg.IsString()) {
            return msg.As<Napi::String>().Utf8Value();
        }
        napi_value unused = NULL;
        napi_get_and_clear_last_exception(env, &unused);
    }
    if (err.IsString()) return err.As<Napi::String>().Utf8Value();
    return "non-error value thrown";
}

void DisposeFuncCall(FuncCall* call) {
    uv_mutex_destroy(&call->mutex);
    uv_cond_destroy(&call->cond);
    delete call;
}

// Hands the call to the JS thread and blocks until it completes. Returns
// false (with the call still owned by the caller) when the channel cannot
// accept it — the environment is shutting down.
void ApplyCell(sqlite3_context* ctx, const Cell& cell) {
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

// Reports the round trip's outcome to sqlite and frees the call. Steps and
// inverses produce no result value; their only outcome is the error.
void FinishCall(sqlite3_context* ctx, FuncCall* call, bool has_result) {
    if (call->errored) {
        sqlite3_result_error(ctx, call->error.c_str(), -1);
    }
    else if (has_result) {
        ApplyCell(ctx, call->result);
    }
    DisposeFuncCall(call);
}

} // namespace

// Free functions that need Database's protected state. Everything the
// user-function machinery does to a Database outside its member functions
// lives here, so the friendship grant is one line and auditable.
namespace node_sqlite3 {

struct UserFunctionOps {
static bool RunBlockingRoundTrip(FuncCall* call) {
    napi_status st = napi_call_threadsafe_function(call->db->js_channel,
        call, napi_tsfn_blocking);
    if (st != napi_ok) {
        call->errored = true;
        call->error = "the JavaScript environment is shutting down; "
            "user-defined function '" + call->fn->name + "' cannot run";
        return false;
    }
    uv_mutex_lock(&call->mutex);
    while (!call->done) uv_cond_wait(&call->cond, &call->mutex);
    uv_mutex_unlock(&call->mutex);
    return true;
}
// Fire-and-forget variant used for aggregate-state cleanup from contexts
// that must not (or need not) wait: the JS-thread finalize paths.
static void EnqueueAggCleanup(Database* db, JsFunc* fn, AggState* agg) {
    FuncCall* call = new FuncCall(fn, FuncCall::kAggCleanup);
    call->agg = agg;
    call->fire_and_forget = true;
    napi_status st = napi_call_threadsafe_function(db->js_channel,
        call, napi_tsfn_nonblocking);
    if (st != napi_ok) {
        // Environment shutting down: the reference inside is reclaimed at
        // env teardown; freeing the struct here is all we can do. (The
        // Napi::Reference destructor needs the JS thread.)
        delete call;
    }
}
// --- The JS-thread half ----------------------------------------------------

// Records a JS exception (or a converter TypeError/RangeError) as the
// call's error, keeping the thrown value on the database as the `cause` of
// the step failure it is about to cause.
static void SetCallError(Database* db, FuncCall* call, const std::string& prefix) {
    Napi::Env env(db->Env());
    napi_value pending = NULL;
    napi_get_and_clear_last_exception(env, &pending);
    call->errored = true;
    if (pending == NULL) {
        call->error = prefix + "unknown error";
        return;
    }
    Napi::Value err(env, pending);
    call->error = prefix + JsErrorMessage(env, err);
    db->pending_js_error = Napi::Persistent(err);
}

// Converts a JS return value into the call's result Cell via the shared
// bind converter. A pending exception afterwards means ConvertToField
// rejected the value — its message already names the return value.
static void ConvertReturnValue(Database* db, FuncCall* call, Napi::Value value,
        const std::string& name) {
    auto field = ConvertToField(value,
        "the return value of function '" + name + "'");
    if (field == nullptr) {
        SetCallError(db, call, "");
        return;
    }
    switch (field->type) {
        case SQLITE_INTEGER: {
            call->result.type = SQLITE_INTEGER;
            call->result.integer =
                static_cast<Values::Integer*>(field.get())->value;
        } break;
        case SQLITE_FLOAT: {
            call->result.type = SQLITE_FLOAT;
            call->result.real =
                static_cast<Values::Float*>(field.get())->value;
        } break;
        case SQLITE_TEXT: {
            call->result.type = SQLITE_TEXT;
            call->result.str =
                std::move(static_cast<Values::Text*>(field.get())->value);
        } break;
        case SQLITE_BLOB: {
            auto* f = static_cast<Values::Blob*>(field.get());
            call->result.type = SQLITE_BLOB;
            call->result.str.assign(f->value, f->length);
        } break;
        default:
            call->result.type = SQLITE_NULL;
    }
}

static void ExecuteOnJsThread(napi_env nenv, FuncCall* call) {
    // Aggregate cleanups must not touch the registration or the database:
    // they can outlive both (a finalize path can enqueue one with nothing
    // in flight, after which an exclusive removal may destroy the holder).
    if (call->kind == FuncCall::kAggCleanup) {
        delete call->agg;
        call->agg = NULL;
        return;
    }

    Napi::Env env(nenv);
    Napi::HandleScope scope(env);

    JsFunc* fn = call->fn;

    // Copy every JS-side input out of the holder BEFORE running any user
    // JS: the callback is allowed to re-register or remove this very
    // function, which destroys the holder mid-call. The locals stay valid
    // for the rest of the round trip; `fn` is never read again.
    const bool dead = fn->dead;
    const std::string name = fn->name;
    Napi::Function scalar = fn->fn.IsEmpty() ? Napi::Function() : fn->fn.Value();
    Napi::Function start_f = fn->start.IsEmpty() ? Napi::Function() : fn->start.Value();
    Napi::Function step_f = fn->step.IsEmpty() ? Napi::Function() : fn->step.Value();
    Napi::Function result_f = fn->result.IsEmpty() ? Napi::Function() : fn->result.Value();
    Napi::Function inverse_f = fn->inverse.IsEmpty() ? Napi::Function() : fn->inverse.Value();
    // The integer mode at invocation time: user JS reached from here could
    // configure() a new one, which must not affect this call's arguments.
    const int integer_mode = call->db->integer_mode;
    Database* db = call->db;

    if (dead) {
        call->errored = true;
        call->error = RemovedMidFlightMessage(name);
        return;
    }

    // Function arguments (collations: the two compared values).
    std::vector<Napi::Value> argv;
    argv.reserve(call->args.size());
    for (size_t i = 0; i < call->args.size(); i++) {
        std::string what;
        if (call->kind == FuncCall::kCollation) {
            what = "a value compared by collation '" + name + "'";
        }
        else {
            what = "argument " + std::to_string(i + 1) +
                " of function '" + name + "'";
        }
        argv.push_back(CellToJS(env, call->args[i], integer_mode, what));
        if (env.IsExceptionPending()) {
            SetCallError(db, call,
                "cannot pass " + what + " to JavaScript: ");
            return;
        }
    }

    switch (call->kind) {
    case FuncCall::kScalar: {
        Napi::Value r = scalar.Call(env.Undefined(), argv);
        if (env.IsExceptionPending()) {
            SetCallError(db, call,
                "user-defined function '" + name + "' threw: ");
            return;
        }
        ConvertReturnValue(db, call, r, name);
    } break;

    case FuncCall::kStep:
    case FuncCall::kInverse: {
        const bool inverse = (call->kind == FuncCall::kInverse);
        AggState* agg = (call->agg_slot && *call->agg_slot)
            ? *call->agg_slot : NULL;
        if (agg == NULL) {
            agg = new AggState();
            *call->agg_slot = agg;
        }
        if (!agg->has_acc) {
            if (start_f.IsEmpty()) {
                agg->failed = true;
                call->errored = true;
                call->error = "aggregate function '" + name +
                    "' has no start implementation";
                return;
            }
            Napi::Value acc = start_f.Call(env.Undefined(), {});
            if (env.IsExceptionPending()) {
                agg->failed = true;
                SetCallError(db, call,
                    "aggregate function '" + name + "' threw in start: ");
                return;
            }
            agg->acc = Napi::Persistent(acc);
            agg->has_acc = true;
        }
        std::vector<Napi::Value> cargs;
        cargs.reserve(argv.size() + 1);
        cargs.push_back(agg->acc.Value());
        cargs.insert(cargs.end(), argv.begin(), argv.end());
        Napi::Function& impl = inverse ? inverse_f : step_f;
        Napi::Value next = impl.Call(env.Undefined(), cargs);
        if (env.IsExceptionPending()) {
            agg->failed = true;
            SetCallError(db, call, std::string("aggregate function '") +
                name + "' threw in " + (inverse ? "inverse" : "step") + ": ");
            return;
        }
        // Whatever the implementation returns is the new accumulator,
        // including undefined (a mutating implementation's return value is
        // its own business; the documented contract is return-the-acc).
        agg->acc = Napi::Persistent(next);
    } break;

    case FuncCall::kFinal:
    case FuncCall::kValue: {
        const bool keep_state = (call->kind == FuncCall::kValue);
        AggState* agg = (call->agg_slot && *call->agg_slot)
            ? *call->agg_slot : NULL;
        if (agg != NULL && agg->failed) {
            // A step already failed: the statement carries that error.
            // Unreachable through the worker (it filters failed states
            // before the round trip); pure defense. xFinal frees the
            // state; xValue leaves it for the aborting statement's xFinal.
            if (!keep_state) {
                *call->agg_slot = NULL;
                delete agg;
            }
            call->result.type = SQLITE_NULL;
            return;
        }
        Napi::Value acc;
        if (agg != NULL && agg->has_acc) {
            acc = agg->acc.Value();
        }
        else {
            // Empty group / empty window frame: materialize start().
            if (start_f.IsEmpty()) {
                call->errored = true;
                call->error = "aggregate function '" + name +
                    "' has no start implementation";
                return;
            }
            acc = start_f.Call(env.Undefined(), {});
            if (env.IsExceptionPending()) {
                if (!keep_state && agg != NULL) {
                    *call->agg_slot = NULL;
                    delete agg;
                }
                SetCallError(db, call,
                    "aggregate function '" + name + "' threw in start: ");
                return;
            }
        }
        Napi::Value r = result_f.Call(env.Undefined(), { acc });
        if (!keep_state && agg != NULL) {
            // The aggregate is over: the state must not outlive xFinal.
            *call->agg_slot = NULL;
            delete agg;
        }
        if (env.IsExceptionPending()) {
            SetCallError(db, call,
                "aggregate function '" + name + "' threw in result: ");
            return;
        }
        ConvertReturnValue(db, call, r, name);
    } break;

    case FuncCall::kCollation: {
        Napi::Value r = scalar.Call(env.Undefined(), argv);
        if (env.IsExceptionPending()) {
            SetCallError(db, call,
                "collation '" + name + "' comparator threw: ");
            return;
        }
        if (r.IsNumber()) {
            double d = r.As<Napi::Number>().DoubleValue();
            call->result.type = SQLITE_INTEGER;
            call->result.integer = d < 0 ? -1 : (d > 0 ? 1 : 0);
        }
        else {
            // Collations have no error channel; the worker interrupts the
            // query (see JsCollation). Synthesize the thrown value so the
            // interrupt's failure carries a cause.
            std::string msg = "collation '" + name +
                "' comparator must return a number, got " + JsTypeName(r);
            Napi::TypeError::New(env, msg).ThrowAsJavaScriptException();
            SetCallError(db, call, "");
        }
    } break;

    case FuncCall::kProgress: {
        // The JS progress callback (db.progress(n, cb)). Truthy return
        // aborts the running statement; a throw aborts it too, with the
        // thrown error kept as the interrupt failure's cause.
        Napi::Value r = scalar.Call(env.Undefined(), {});
        if (env.IsExceptionPending()) {
            SetCallError(db, call,
                "progress callback of this connection threw: ");
            return;
        }
        call->result.type = SQLITE_INTEGER;
        call->result.integer = r.ToBoolean().Value() ? 1 : 0;
    } break;

    case FuncCall::kAggCleanup:
        break; // handled above
    }
}

// The raw tsfn call-js callback. `data` is a FuncCall*; the napi_env is
// taken from the callback itself, never from the database (cleanup calls
// can outlive their Database).
static void TsfnCallJs(napi_env nenv, napi_value /*jsCallback*/,
        void* /*context*/, void* data) {
    if (data == NULL) return; // loop-teardown notification
    FuncCall* call = static_cast<FuncCall*>(data);
    ExecuteOnJsThread(nenv, call);
    // No exception may escape into the tsfn dispatch machinery. The check
    // must be napi_is_exception_pending: napi_get_and_clear_last_exception
    // alone reports a non-NULL "last exception" even after every exception
    // has been handled.
    bool stray_exception = false;
    napi_is_exception_pending(nenv, &stray_exception);
    if (stray_exception) {
        napi_value pending = NULL;
        napi_get_and_clear_last_exception(nenv, &pending);
        if (!call->errored) {
            call->errored = true;
            call->error = "internal error while invoking a user-defined "
                "function";
        }
    }
    if (call->fire_and_forget) {
        // The worker moved on the moment the enqueue succeeded.
        DisposeFuncCall(call);
        return;
    }
    uv_mutex_lock(&call->mutex);
    call->done = true;
    uv_cond_signal(&call->cond);
    uv_mutex_unlock(&call->mutex);
}
// Creates the per-database channel on first registration. Returns false
// only if napi_create_threadsafe_function failed, which in practice means
// a fatal condition; the caller reports and still releases the database.
static bool EnsureChannel(Database* db) {
    if (db->js_channel != NULL) return true;
    Napi::Env env = db->Env();
    // The `func` is never invoked (TsfnCallJs ignores it); a real function
    // is passed because napi tolerates NULL only when a custom call-js
    // callback is provided, and the no-op keeps both paths valid.
    Napi::Function noop = Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            return info.Env().Undefined();
        });
    napi_value resource_name = Napi::String::New(env,
        "sqlite3.Database.JsFunction");
    napi_threadsafe_function tsfn = NULL;
    napi_status st = napi_create_threadsafe_function(env, noop, NULL,
        resource_name,
        0,  // unbounded queue: blocking calls never block on the queue
        1,  // exactly one Release, from RemoveUserFunctions
        NULL, NULL, NULL, TsfnCallJs, &tsfn);
    if (st != napi_ok || tsfn == NULL) {
        return false;
    }
    // A registered function must not keep the event loop alive by itself
    // (the process-exit test): round trips only happen under in-flight
    // statement work, which holds the loop through its own async work.
    napi_unref_threadsafe_function(env, tsfn);
    db->js_channel = tsfn;
    return true;
}

// Drops holders whose registration sqlite already destroyed (a replace
// fires the old registration's xDestroy). Exclusive context, so nothing
// can be in flight against them.
static void SweepDeadRegistrations(Database* db) {
    auto sweep = [](std::vector<JsFunc*>& v) {
        for (auto it = v.begin(); it != v.end();) {
            if ((*it)->dead) {
                delete *it;
                it = v.erase(it);
            }
            else {
                ++it;
            }
        }
    };
    sweep(db->js_functions);
    sweep(db->js_collations);
}

static void ReleaseChannelIfIdle(Database* db) {
    if (db->js_channel != NULL && db->js_functions.empty()
            && db->js_collations.empty() && db->js_progress == NULL) {
        napi_release_threadsafe_function(db->js_channel,
            napi_tsfn_release);
        db->js_channel = NULL;
    }
}

// Registration failures have no caller callback to reach (the JS layer
// treats registration as synchronous); report on the connection's 'error'
// event, like exec and the other callback-less failures do. Safe to call
// repeatedly: an emit('error') with no listener throws, and building a
// Napi error while that exception is still pending is a fatal napi error,
// so the second failure rides on the first instead of compounding it.
static void ReportRegistrationError(Database* db, int rc) {
    Napi::Env env = db->Env();
    if (env.IsExceptionPending()) return;
    Napi::HandleScope scope(env);
    EXCEPTION(sqlite3_errmsg(db->_handle), rc, exception);
    Napi::Value info[] = {
        Napi::String::New(env, "error"),
        exception
    };
    EMIT_EVENT(db->Value(), 2, info);
}
};

} // namespace node_sqlite3

// --- sqlite callbacks (worker thread, or the JS thread under the sync guard)

void Database::JsScalarFunc(sqlite3_context* ctx, int argc,
        sqlite3_value** argv) {
    JsFunc* fn = static_cast<JsFunc*>(sqlite3_user_data(ctx));
    Database* db = fn->db;

    if (db->sync_sqlite_depth > 0) {
        sqlite3_result_error(ctx, SyncRefusalMessage(fn->name).c_str(), -1);
        return;
    }

    FuncCall* call = new FuncCall(fn, FuncCall::kScalar);
    call->args.reserve(argc);
    for (int i = 0; i < argc; i++) {
        call->args.emplace_back();
        ValueToCell(&call->args.back(), argv[i]);
    }
    UserFunctionOps::RunBlockingRoundTrip(call);
    FinishCall(ctx, call, true);
}

void Database::JsAggregateStep(sqlite3_context* ctx, int argc,
        sqlite3_value** argv) {
    JsFunc* fn = static_cast<JsFunc*>(sqlite3_user_data(ctx));
    Database* db = fn->db;

    if (db->sync_sqlite_depth > 0 || fn->dead) {
        const std::string& refusal = (db->sync_sqlite_depth > 0)
            ? SyncRefusalMessage(fn->name) : RemovedMidFlightMessage(fn->name);
        sqlite3_result_error(ctx, refusal.c_str(), -1);
        return;
    }

    // Allocates (zeroed) on the first step of the group; the JS side owns
    // the AggState it stores here.
    AggState** slot = static_cast<AggState**>(
        sqlite3_aggregate_context(ctx, sizeof(AggState*)));
    if (slot == NULL) {
        sqlite3_result_error(ctx, "out of memory", -1);
        return;
    }

    FuncCall* call = new FuncCall(fn, FuncCall::kStep);
    call->agg_slot = slot;
    call->args.reserve(argc);
    for (int i = 0; i < argc; i++) {
        call->args.emplace_back();
        ValueToCell(&call->args.back(), argv[i]);
    }
    UserFunctionOps::RunBlockingRoundTrip(call);
    FinishCall(ctx, call, false);
}

void Database::JsAggregateFinal(sqlite3_context* ctx) {
    JsFunc* fn = static_cast<JsFunc*>(sqlite3_user_data(ctx));
    Database* db = fn->db;

    // sqlite3_aggregate_context(ctx, 0) never allocates: an empty group
    // (or a step that never got past its refusal) has no slot at all.
    AggState** slot = static_cast<AggState**>(
        sqlite3_aggregate_context(ctx, 0));
    AggState* agg = (slot != NULL && *slot != NULL) ? *slot : NULL;

    if (db->sync_sqlite_depth > 0 || fn->dead) {
        // Reached from a main-thread sqlite3_finalize (the sync methods,
        // Statement::Finalize_, the GC safety net) or after removal. A
        // round trip would deadlock (or touch freed state); free the
        // accumulator without running JS, off-thread of nothing — the
        // cleanup itself is what gets deferred.
        if (agg != NULL) {
            UserFunctionOps::EnqueueAggCleanup(db, fn, agg);
            *slot = NULL;
        }
        sqlite3_result_null(ctx);
        return;
    }

    if (agg != NULL && agg->failed) {
        // A step already failed; the statement carries that error. Just
        // release the accumulator.
        UserFunctionOps::EnqueueAggCleanup(db, fn, agg);
        *slot = NULL;
        sqlite3_result_null(ctx);
        return;
    }

    FuncCall* call = new FuncCall(fn, FuncCall::kFinal);
    call->agg_slot = slot;
    UserFunctionOps::RunBlockingRoundTrip(call);
    FinishCall(ctx, call, true);
}

void Database::JsAggregateValue(sqlite3_context* ctx) {
    JsFunc* fn = static_cast<JsFunc*>(sqlite3_user_data(ctx));
    Database* db = fn->db;

    if (db->sync_sqlite_depth > 0 || fn->dead) {
        sqlite3_result_null(ctx);
        return;
    }

    AggState** slot = static_cast<AggState**>(
        sqlite3_aggregate_context(ctx, 0));
    FuncCall* call = new FuncCall(fn, FuncCall::kValue);
    call->agg_slot = slot;
    UserFunctionOps::RunBlockingRoundTrip(call);
    FinishCall(ctx, call, true);
}

void Database::JsAggregateInverse(sqlite3_context* ctx, int argc,
        sqlite3_value** argv) {
    JsFunc* fn = static_cast<JsFunc*>(sqlite3_user_data(ctx));
    Database* db = fn->db;

    if (db->sync_sqlite_depth > 0 || fn->dead) {
        const std::string& refusal = (db->sync_sqlite_depth > 0)
            ? SyncRefusalMessage(fn->name) : RemovedMidFlightMessage(fn->name);
        sqlite3_result_error(ctx, refusal.c_str(), -1);
        return;
    }

    AggState** slot = static_cast<AggState**>(
        sqlite3_aggregate_context(ctx, sizeof(AggState*)));
    if (slot == NULL) {
        sqlite3_result_error(ctx, "out of memory", -1);
        return;
    }

    FuncCall* call = new FuncCall(fn, FuncCall::kInverse);
    call->agg_slot = slot;
    call->args.reserve(argc);
    for (int i = 0; i < argc; i++) {
        call->args.emplace_back();
        ValueToCell(&call->args.back(), argv[i]);
    }
    UserFunctionOps::RunBlockingRoundTrip(call);
    FinishCall(ctx, call, false);
}

int Database::JsCollation(void* ctx, int len1, const void* d1,
        int len2, const void* d2) {
    JsFunc* fn = static_cast<JsFunc*>(ctx);
    Database* db = fn->db;

    if (db->sync_sqlite_depth > 0 || fn->dead) {
        // Unreachable through the public API (the sync methods refuse to
        // run while a JS collation is registered), but a collation has no
        // error channel: if it ever got here, the only sound answer is to
        // kill the query before a mis-comparison can escape.
        sqlite3_interrupt(db->_handle);
        return 0;
    }

    FuncCall* call = new FuncCall(fn, FuncCall::kCollation);
    call->args.reserve(2);
    call->args.emplace_back(Cell(SQLITE_TEXT));
    if (len1 > 0 && d1 != NULL) {
        call->args.back().str.assign(static_cast<const char*>(d1), len1);
    }
    call->args.emplace_back(Cell(SQLITE_TEXT));
    if (len2 > 0 && d2 != NULL) {
        call->args.back().str.assign(static_cast<const char*>(d2), len2);
    }

    UserFunctionOps::RunBlockingRoundTrip(call);

    int r = 0;
    if (call->errored) {
        // The comparator threw or returned a non-number (the JS side kept
        // the thrown value as the pending cause). Interrupting aborts the
        // whole query — connection-wide, like every cancellation here —
        // rather than letting wrongly-ordered rows escape; returning 0 is
        // fine because this comparison's result is then never used.
        sqlite3_interrupt(db->_handle);
    }
    else if (call->result.type == SQLITE_INTEGER) {
        int64_t v = call->result.integer;
        r = v < 0 ? -1 : (v > 0 ? 1 : 0);
    }
    else if (call->result.type == SQLITE_FLOAT) {
        double v = call->result.real;
        r = v < 0 ? -1 : (v > 0 ? 1 : 0);
    }
    else {
        sqlite3_interrupt(db->_handle);
    }
    DisposeFuncCall(call);
    return r;
}

void Database::JsFuncDestroy(void* data) {
    // Runs on the JS thread by construction: every unregister/replace/close
    // of a registration happens from the exclusive handlers,
    // RemoveUserFunctions (Work_BeginClose, ~Database) or sqlite3_close in
    // the destructor — all main-thread. Marks the holder dead for any
    // round trip queued behind another, releases its JS references and its
    // database ref. The registry owner deletes the struct afterwards.
    JsFunc* fn = static_cast<JsFunc*>(data);
    if (fn->dead) return;
    fn->dead = true;
    fn->fn.Reset();
    fn->start.Reset();
    fn->step.Reset();
    fn->result.Reset();
    fn->inverse.Reset();
    fn->db->Unref();
}

// --- JS-visible entry points -----------------------------------------------

Napi::Value Database::RegisterUserFunction(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, name);
    REQUIRE_ARGUMENT_INTEGER(1, nArg);
    REQUIRE_ARGUMENT_INTEGER(2, flags);
    REQUIRE_ARGUMENT_FUNCTION(3, fn);

    auto* baton = new FunctionBaton(db, Napi::Function(), name.c_str(),
        nArg, flags);
    baton->fn.Reset(fn, 1);
    db->Schedule(Work_RegisterFunction, baton, true);

    return info.This();
}

Napi::Value Database::RegisterUserAggregate(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, name);
    REQUIRE_ARGUMENT_INTEGER(1, nArg);
    REQUIRE_ARGUMENT_INTEGER(2, flags);
    // start, step, result required; inverse optional (a non-undefined
    // inverse makes this a window function).
    REQUIRE_ARGUMENT_FUNCTION(3, start);
    REQUIRE_ARGUMENT_FUNCTION(4, step);
    REQUIRE_ARGUMENT_FUNCTION(5, result);
    Napi::Function inverse;
    if (info.Length() > 6 && !info[6].IsUndefined()) {
        if (!info[6].IsFunction()) {
            Napi::TypeError::New(env,
                "Argument 6 must be a function"
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
        inverse = info[6].As<Napi::Function>();
    }

    auto* baton = new FunctionBaton(db, Napi::Function(), name.c_str(),
        nArg, flags);
    baton->start.Reset(start, 1);
    baton->step.Reset(step, 1);
    baton->result.Reset(result, 1);
    if (!inverse.IsEmpty()) baton->inverse.Reset(inverse, 1);
    db->Schedule(Work_RegisterAggregate, baton, true);

    return info.This();
}

Napi::Value Database::RegisterUserCollation(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, name);
    REQUIRE_ARGUMENT_FUNCTION(1, fn);

    auto* baton = new FunctionBaton(db, Napi::Function(), name.c_str(),
        0, 0);
    baton->is_collation = true;
    baton->fn.Reset(fn, 1);
    db->Schedule(Work_RegisterCollation, baton, true);

    return info.This();
}

Napi::Value Database::RemoveUserFunction(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, name);

    auto* baton = new RemoveFunctionBaton(db, Napi::Function(), name.c_str());
    baton->collation = false;
    db->Schedule(Work_RemoveFunction, baton, true);

    return info.This();
}

Napi::Value Database::RemoveUserCollation(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, name);

    auto* baton = new RemoveFunctionBaton(db, Napi::Function(), name.c_str());
    baton->collation = true;
    db->Schedule(Work_RemoveCollation, baton, true);

    return info.This();
}

// --- Registration handlers (main thread, exclusive) -------------------------

void Database::Work_RegisterFunction(Baton* b) {
    auto baton = std::unique_ptr<FunctionBaton>(static_cast<FunctionBaton*>(b));
    auto* db = baton->db;

    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    UserFunctionOps::SweepDeadRegistrations(db);
    if (!UserFunctionOps::EnsureChannel(db)) {
        UserFunctionOps::ReportRegistrationError(db, SQLITE_NOMEM);
        db->exclusiveHeld = false;
        db->Process();
        return;
    }

    auto* holder = new JsFunc(db, baton->name, baton->nArg);
    holder->fn = std::move(baton->fn);

    // xDestroy is invoked with the pApp pointer, which is also the user
    // data the callbacks receive.
    int rc = sqlite3_create_function_v2(db->_handle,
        baton->name.c_str(), baton->nArg, SQLITE_UTF8 | baton->flags,
        holder, JsScalarFunc, NULL, NULL, JsFuncDestroy);
    if (rc != SQLITE_OK) {
        UserFunctionOps::ReportRegistrationError(db, rc);
        JsFuncDestroy(holder);
        delete holder;
    }
    else {
        db->js_functions.push_back(holder);
    }

    // Inline like Work_Wait: the exclusive call completes here, so the
    // database is released for whatever Process dispatches next.
    db->exclusiveHeld = false;
    db->Process();
}

void Database::Work_RegisterAggregate(Baton* b) {
    auto baton = std::unique_ptr<FunctionBaton>(static_cast<FunctionBaton*>(b));
    auto* db = baton->db;

    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    UserFunctionOps::SweepDeadRegistrations(db);
    if (!UserFunctionOps::EnsureChannel(db)) {
        UserFunctionOps::ReportRegistrationError(db, SQLITE_NOMEM);
        db->exclusiveHeld = false;
        db->Process();
        return;
    }

    const bool is_window = !baton->inverse.IsEmpty();
    auto* holder = new JsFunc(db, baton->name, baton->nArg);
    holder->start = std::move(baton->start);
    holder->step = std::move(baton->step);
    holder->result = std::move(baton->result);
    if (is_window) holder->inverse = std::move(baton->inverse);

    int rc;
    if (is_window) {
        // sqlite3_create_window_function has no flags slot (its eTextRep
        // must be SQLITE_UTF8): deterministic/directOnly/innocuous cannot
        // be applied to window functions. Documented in the JS layer.
        rc = sqlite3_create_window_function(db->_handle,
            baton->name.c_str(), baton->nArg, SQLITE_UTF8, holder,
            JsAggregateStep, JsAggregateFinal, JsAggregateValue,
            JsAggregateInverse, JsFuncDestroy);
    }
    else {
        rc = sqlite3_create_function_v2(db->_handle,
            baton->name.c_str(), baton->nArg, SQLITE_UTF8 | baton->flags,
            holder, NULL, JsAggregateStep, JsAggregateFinal,
            JsFuncDestroy);
    }
    if (rc != SQLITE_OK) {
        UserFunctionOps::ReportRegistrationError(db, rc);
        JsFuncDestroy(holder);
        delete holder;
    }
    else {
        db->js_functions.push_back(holder);
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::Work_RegisterCollation(Baton* b) {
    auto baton = std::unique_ptr<FunctionBaton>(static_cast<FunctionBaton*>(b));
    auto* db = baton->db;

    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    UserFunctionOps::SweepDeadRegistrations(db);
    if (!UserFunctionOps::EnsureChannel(db)) {
        UserFunctionOps::ReportRegistrationError(db, SQLITE_NOMEM);
        db->exclusiveHeld = false;
        db->Process();
        return;
    }

    auto* holder = new JsFunc(db, baton->name, 0);
    holder->is_collation = true;
    holder->fn = std::move(baton->fn);

    int rc = sqlite3_create_collation(db->_handle, baton->name.c_str(),
        SQLITE_UTF8, holder, JsCollation);
    if (rc != SQLITE_OK) {
        UserFunctionOps::ReportRegistrationError(db, rc);
        JsFuncDestroy(holder);
        delete holder;
    }
    else {
        db->js_collations.push_back(holder);
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::Work_RemoveFunction(Baton* b) {
    auto baton = std::unique_ptr<RemoveFunctionBaton>(
        static_cast<RemoveFunctionBaton*>(b));
    auto* db = baton->db;

    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    bool failed = false;
    for (auto it = db->js_functions.begin(); it != db->js_functions.end();) {
        JsFunc* fn = *it;
        if (fn->dead) {
            // A replaced registration sqlite already destroyed: just drop
            // the holder instead of unregistering through it (which would
            // hit the live replacement and double-report failures).
            delete fn;
            it = db->js_functions.erase(it);
            continue;
        }
        if (fn->name == baton->name) {
            // All-NULL callbacks delete the registration; the old
            // registration's xDestroy fires from inside this call.
            int rc = sqlite3_create_function_v2(db->_handle,
                fn->name.c_str(), fn->nArg, SQLITE_UTF8,
                NULL, NULL, NULL, NULL, NULL);
            if (rc == SQLITE_OK) {
                JsFuncDestroy(fn);
                delete fn;
                it = db->js_functions.erase(it);
                continue;
            }
            // SQLITE_BUSY: a suspended cursor counts as an active VM, so
            // sqlite refuses. Keep the registration and say so.
            failed = true;
            UserFunctionOps::ReportRegistrationError(db, rc);
        }
        ++it;
    }

    if (!failed) UserFunctionOps::SweepDeadRegistrations(db);
    UserFunctionOps::ReleaseChannelIfIdle(db);

    db->exclusiveHeld = false;
    db->Process();
}

void Database::Work_RemoveCollation(Baton* b) {
    auto baton = std::unique_ptr<RemoveFunctionBaton>(
        static_cast<RemoveFunctionBaton*>(b));
    auto* db = baton->db;

    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    for (auto it = db->js_collations.begin(); it != db->js_collations.end();) {
        JsFunc* fn = *it;
        if (fn->dead) {
            delete fn;
            it = db->js_collations.erase(it);
            continue;
        }
        if (fn->name == baton->name) {
            int rc = sqlite3_create_collation(db->_handle,
                fn->name.c_str(), SQLITE_UTF8, NULL, NULL);
            if (rc == SQLITE_OK) {
                JsFuncDestroy(fn);
                delete fn;
                it = db->js_collations.erase(it);
                continue;
            }
            UserFunctionOps::ReportRegistrationError(db, rc);
        }
        ++it;
    }

    UserFunctionOps::ReleaseChannelIfIdle(db);

    db->exclusiveHeld = false;
    db->Process();
}

void Database::RemoveUserFunctions() {
    // Called from Work_BeginClose and ~Database: main thread, nothing in
    // flight. Registrations sqlite refuses to drop (a suspended cursor
    // makes the close fail too) stay alive with their holders so the
    // still-usable connection keeps working.
    if (_handle != NULL) {
        for (auto it = js_functions.begin(); it != js_functions.end();) {
            JsFunc* fn = *it;
            if (fn->dead) {
                delete fn;
                it = js_functions.erase(it);
                continue;
            }
            int rc = sqlite3_create_function_v2(_handle,
                fn->name.c_str(), fn->nArg, SQLITE_UTF8,
                NULL, NULL, NULL, NULL, NULL);
            if (rc == SQLITE_OK) {
                JsFuncDestroy(fn);
                delete fn;
                it = js_functions.erase(it);
            }
            else {
                ++it;
            }
        }
        for (auto it = js_collations.begin(); it != js_collations.end();) {
            JsFunc* fn = *it;
            if (fn->dead) {
                delete fn;
                it = js_collations.erase(it);
                continue;
            }
            int rc = sqlite3_create_collation(_handle, fn->name.c_str(),
                SQLITE_UTF8, NULL, NULL);
            if (rc == SQLITE_OK) {
                JsFuncDestroy(fn);
                delete fn;
                it = js_collations.erase(it);
            }
            else {
                ++it;
            }
        }
    }
    else {
        // The handle is gone (never opened, or a prior close completed in
        // a prior destructor call): no sqlite state to unregister.
        for (JsFunc* fn : js_functions) {
            JsFuncDestroy(fn);
            delete fn;
        }
        js_functions.clear();
        for (JsFunc* fn : js_collations) {
            JsFuncDestroy(fn);
            delete fn;
        }
        js_collations.clear();
    }
    // Deliberately NOT releasing the channel here: RemoveUserFunctions
    // also runs from ~Database, which the environment can invoke from
    // inside the channel's own teardown — releasing it there re-enters
    // the tsfn destructor and hangs the process at exit. The channel is
    // unref'd, so an unreleased one costs nothing while the loop lives,
    // and environment teardown destroys it regardless.
}

void Database::ReleaseJsChannelIfIdle() {
    UserFunctionOps::ReleaseChannelIfIdle(this);
}

bool Database::EnsureJsChannel() {
    return UserFunctionOps::EnsureChannel(this);
}

void Database::ReportRegistrationFailure(int rc) {
    UserFunctionOps::ReportRegistrationError(this, rc);
}

// The sqlite progress handler (Deliverable 07). Flag mode is one relaxed
// atomic load — set from any thread via the SharedArrayBuffer-backed
// cancellation token. Callback mode makes the standard blocking round
// trip; the sync methods are gated against it (BindSync and the sync
// prepare path), and the depth check below is belt-and-braces for any
// path that slips through: continuing is the only non-deadlocking
// answer there, since the handler cannot report an error.
int Database::ProgressHandler(void* ctx) {
    auto* db = static_cast<Database*>(ctx);
    switch (db->progress_mode) {
        case ProgressMode::Flag:
            return db->progress_flag->load(std::memory_order_relaxed) != 0
                ? 1 : 0;
        case ProgressMode::Callback: {
            JsFunc* fn = db->js_progress;
            if (fn == NULL || fn->dead) return 0;
            if (db->sync_sqlite_depth > 0) return 0;
            FuncCall* call = new FuncCall(fn, FuncCall::kProgress);
            UserFunctionOps::RunBlockingRoundTrip(call);
            bool stop = !call->errored && call->result.type == SQLITE_INTEGER
                && call->result.integer != 0;
            bool failed = call->errored;
            DisposeFuncCall(call);
            if (failed) {
                // The callback threw: the thrown value is already stashed
                // as the pending cause; abort the statement so the
                // SQLITE_INTERRUPT failure carries it.
                sqlite3_interrupt(db->_handle);
                return 1;
            }
            return stop ? 1 : 0;
        }
        default:
            return 0;
    }
}

void Database::AttachPendingJsError(Napi::Object err) {
    if (pending_js_error.IsEmpty()) return;
    err.Set("cause", pending_js_error.Value());
    pending_js_error.Reset();
}
