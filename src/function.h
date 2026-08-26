#ifndef NODE_SQLITE3_SRC_FUNCTION_H
#define NODE_SQLITE3_SRC_FUNCTION_H

// User-defined functions, aggregates, window functions and collations
// (Deliverable 06). sqlite invokes these callbacks on whatever thread is
// executing the statement — a libuv worker here — so each invocation makes
// a blocking round trip to the JS thread through a ThreadSafeFunction:
// the worker marshals the arguments into Cells and waits on a condition
// variable; the JS thread converts, runs the user's JS, marshals the
// result back and signals.
//
// The deadlock this creates on the synchronous API (the JS thread is the
// one blocked inside sqlite) is refused with an explicit error, not
// deadlocked and not silently downgraded to inline execution — see
// Database::sync_sqlite_depth and the JsScalarFunc refusal path.

#include <string>
#include <vector>

#include <sqlite3.h>
#include <napi.h>
#include <uv.h>

#include "convert.h"
#include "database.h"

namespace node_sqlite3 {

// One registered JavaScript callback: a scalar function, an
// aggregate/window function (start/step/result/inverse), or a collation
// comparator. Owned by Database::js_functions / js_collations.
struct JsFunc {
    Database* db;
    std::string name;
    int nArg;
    bool is_collation = false;

    // Scalar / collation implementation.
    Napi::FunctionReference fn;
    // Aggregate implementation. A non-empty `inverse` makes it a window
    // function (registered via sqlite3_create_window_function).
    Napi::FunctionReference start;
    Napi::FunctionReference step;
    Napi::FunctionReference result;
    Napi::FunctionReference inverse;

    // Set when the registration is replaced or removed. The JS-thread
    // halves check it before touching the references; calls already in
    // flight see it and fail with an error instead of using freed state.
    // Exclusive scheduling makes in-flight calls impossible at removal
    // time; this covers calls queued behind the round trip of another.
    bool dead = false;

    JsFunc(Database* db_, std::string name_, int nArg_) :
            db(db_), name(std::move(name_)), nArg(nArg_) {
        db->Ref();
    }
};

// Per-aggregate-invocation state, pointed to by sqlite's aggregate
// context. Created, mutated and freed on the JS thread only (inside the
// round trips); the worker only carries the slot pointer across.
struct AggState {
    Napi::Reference<Napi::Value> acc;
    bool has_acc = false;
    bool failed = false;
};

// One round trip. Allocated on the worker, handed to the JS thread via
// the channel, and freed by whichever side the `fire_and_forget` flag
// names: the worker for waited calls (it resumes after the signal), the
// JS thread for fire-and-forget cleanups (the worker never touches the
// call again after a successful enqueue).
struct FuncCall {
    enum Kind {
        kScalar,      // fn(...args) -> result
        kStep,        // acc = step(acc, ...args)
        kFinal,       // result = result(acc); aggregate over, state freed
        kValue,       // result = result(acc); window frame value, state kept
        kInverse,     // acc = inverse(acc, ...args)
        kCollation,   // cmp(a, b) -> sign
        kAggCleanup   // free the aggregate state without touching JS state
    };

    JsFunc* fn;
    Database* db;
    Kind kind;
    std::vector<Cell> args;
    Cell result;
    // Aggregate-context slot for the step/final/value/inverse kinds; NULL
    // for scalars, collations and cleanups (cleanups carry the state
    // directly in `agg`).
    AggState** agg_slot = nullptr;
    AggState* agg = nullptr;

    bool errored = false;
    std::string error;

    bool fire_and_forget = false;
    uv_mutex_t mutex;
    uv_cond_t cond;
    bool done = false;

    FuncCall(JsFunc* fn_, Kind kind_) : fn(fn_), db(fn_->db), kind(kind_) {
        uv_mutex_init(&mutex);
        uv_cond_init(&cond);
    }
};

// Registration batons. The JS layer does option parsing; these carry the
// normalized result to the exclusive handler.
struct FunctionBaton : Database::Baton {
    std::string name;
    int nArg;
    int flags;
    bool is_collation = false;
    Napi::FunctionReference fn;       // scalar / collation
    // Aggregate halves:
    Napi::FunctionReference start;
    Napi::FunctionReference step;
    Napi::FunctionReference result;
    Napi::FunctionReference inverse;

    FunctionBaton(Database* db_, Napi::Function cb_, const char* name_,
            int nArg_, int flags_) :
            Baton(db_, cb_), name(name_), nArg(nArg_), flags(flags_) {}
    virtual ~FunctionBaton() override = default;
};

struct RemoveFunctionBaton : Database::Baton {
    std::string name;
    bool collation = false;
    RemoveFunctionBaton(Database* db_, Napi::Function cb_, const char* name_) :
            Baton(db_, cb_), name(name_) {}
    virtual ~RemoveFunctionBaton() override = default;
};

} // namespace node_sqlite3

#endif
