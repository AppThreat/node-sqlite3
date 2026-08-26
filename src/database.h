
#ifndef NODE_SQLITE3_SRC_DATABASE_H
#define NODE_SQLITE3_SRC_DATABASE_H


#include <assert.h>
#include <string>
#include <queue>

#include <sqlite3.h>
#include <napi.h>

#include "async.h"
#include "macros.h"

using namespace Napi;

namespace node_sqlite3 {

class Database;
struct JsFunc;
struct FunctionBaton;
struct RemoveFunctionBaton;
struct UserFunctionOps;


class Database : public Napi::ObjectWrap<Database> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    // How INTEGER columns and lastID are converted to JS
    // (configure('integerMode', mode)). 'number' throws a RangeError on
    // values outside the safe-integer range rather than truncating;
    // 'bigint' always returns BigInt; 'mixed' picks per value.
    enum IntegerMode {
        INTEGER_NUMBER = 0,
        INTEGER_BIGINT = 1,
        INTEGER_MIXED = 2
    };

    // The connection's lifecycle. Replaces the former overloaded `locked`
    // bool, which meant "an exclusive call is in flight" while busy and
    // "this object is dead" after a successful close — every consumer had
    // to know which, and forgetting the tombstone reading was a bug class
    // of its own.
    enum class DbState {
        Opening,  // constructor ran, sqlite3_open not yet completed
        Open,     // handle live, no close in flight
        Closing,  // sqlite3_close in flight on the worker
        Closed    // close completed (or the object was never opened);
                  // terminal for scheduling purposes
    };

    static inline bool HasInstance(Napi::Value val) {
        auto env = val.Env();
        Napi::HandleScope scope(env);
        if (!val.IsObject()) return false;
        auto obj = val.As<Napi::Object>();
        auto constructor =
            env.GetInstanceData<Napi::FunctionReference>();
        return obj.InstanceOf(constructor->Value());
    }

    struct Baton {
        napi_async_work request = NULL;
        Database* db;
        Napi::FunctionReference callback;
        int status;
        std::string message;
        // Payload for SetBusyTimeout (the only scheduled call that needs
        // one); other work uses the fields of its derived baton.
        int timeout = 0;

        Baton(Database* db_, Napi::Function cb_) :
                db(db_), status(SQLITE_OK) {
            db->Ref();
            if (!cb_.IsUndefined() && cb_.IsFunction()) {
                callback.Reset(cb_, 1);
            }
        }
        virtual ~Baton() {
            if (request) napi_delete_async_work(db->Env(), request);
            db->Unref();
            callback.Reset();
        }
    };

    struct OpenBaton : Baton {
        std::string filename;
        int mode;
        OpenBaton(Database* db_, Napi::Function cb_, const char* filename_, int mode_) :
            Baton(db_, cb_), filename(filename_), mode(mode_) {}
        virtual ~OpenBaton() override = default;
    };

    struct ExecBaton : Baton {
        std::string sql;
        ExecBaton(Database* db_, Napi::Function cb_, const char* sql_) :
            Baton(db_, cb_), sql(sql_) {}
        virtual ~ExecBaton() override = default;
    };

    struct LoadExtensionBaton : Baton {
        std::string filename;
        LoadExtensionBaton(Database* db_, Napi::Function cb_, const char* filename_) :
            Baton(db_, cb_), filename(filename_) {}
        virtual ~LoadExtensionBaton() override = default;
    };

    struct LimitBaton : Baton {
        int id;
        int value;
        LimitBaton(Database* db_, Napi::Function cb_, int id_, int value_) :
            Baton(db_, cb_), id(id_), value(value_) {}
        virtual ~LimitBaton() override = default;
    };

    typedef void (*Work_Callback)(Baton* baton);

    struct Call {
        Call(Work_Callback cb_, Baton* baton_, bool exclusive_ = false) :
            callback(cb_), exclusive(exclusive_), baton(baton_) {};
        Work_Callback callback;
        bool exclusive;
        Baton* baton;
    };

    struct ProfileInfo {
        std::string sql;
        sqlite3_int64 nsecs;
    };

    struct UpdateInfo {
        int type;
        std::string database;
        std::string table;
        sqlite3_int64 rowid;
    };

    // The sqlite handle exists and has not been closed. Note that Closing
    // counts as open: work scheduled during a close waits behind it and is
    // only failed (or runs) once the close's outcome is known. This is the
    // old `open` bool's exact semantics.
    bool IsOpen() { return db_state == DbState::Open || db_state == DbState::Closing; }
    // Terminal: a close completed. The old `locked` tombstone.
    bool IsClosed() { return db_state == DbState::Closed; }

    typedef Async<std::string, Database> AsyncTrace;
    typedef Async<ProfileInfo, Database> AsyncProfile;
    typedef Async<UpdateInfo, Database> AsyncUpdate;

    friend class Statement;
    friend class Backup;
    friend struct UserFunctionOps;

    // Marks that the JavaScript thread is itself inside a sqlite call on
    // this connection and therefore cannot service the ThreadSafeFunction
    // round trip a user-defined function needs. Set by every main-thread
    // sqlite-driving path (the *Sync methods, the synchronous prepare, and
    // every sqlite3_finalize — an aggregate's xFinal can fire from any of
    // them). Main-thread-only state; the worker callbacks read it as the
    // deadlock refusal test.
    unsigned sync_sqlite_depth = 0;

    struct SyncSqliteGuard {
        Database* db;
        explicit SyncSqliteGuard(Database* db_) : db(db_) { db->sync_sqlite_depth++; }
        ~SyncSqliteGuard() { db->sync_sqlite_depth--; }
        SyncSqliteGuard(const SyncSqliteGuard&) = delete;
        SyncSqliteGuard& operator=(const SyncSqliteGuard&) = delete;
    };

    Database(const Napi::CallbackInfo& info);

    ~Database() {
        RemoveCallbacks();
        RemoveUserFunctions();
        sqlite3_close(_handle);
        _handle = NULL;
        db_state = DbState::Closed;
    }

protected:
    WORK_DEFINITION(Open);
    WORK_DEFINITION(Exec);
    WORK_DEFINITION(Close);
    WORK_DEFINITION(LoadExtension);

    void Schedule(Work_Callback callback, Baton* baton, bool exclusive = false);
    void Process();

    Napi::Value Wait(const Napi::CallbackInfo& info);
    static void Work_Wait(Baton* baton);

    Napi::Value Serialize(const Napi::CallbackInfo& info);
    Napi::Value Parallelize(const Napi::CallbackInfo& info);
    Napi::Value Configure(const Napi::CallbackInfo& info);
    Napi::Value Interrupt(const Napi::CallbackInfo& info);

    /** Current integerMode as a string: 'number' | 'bigint' | 'mixed'. */
    Napi::Value IntegerModeGetter(const Napi::CallbackInfo& info);

    // Read-only snapshot of the connection's scheduling state, computed
    // on read from the authoritative fields; diagnostics and tests consume
    // it. The statement cache's hot guard reads the individual accessors
    // below instead (the per-call object construction measured +46% on
    // db.getSync cached in bench, Deliverable 05).
    Napi::Value StateGetter(const Napi::CallbackInfo& info);

    // Individual read-only views of the same authoritative fields, for
    // hot paths that must not pay for the state object's construction.
    Napi::Value ClosingGetter(const Napi::CallbackInfo& info);
    Napi::Value LockedGetter(const Napi::CallbackInfo& info);
    Napi::Value SerializedGetter(const Napi::CallbackInfo& info);
    Napi::Value PendingGetter(const Napi::CallbackInfo& info);
    Napi::Value QueuedGetter(const Napi::CallbackInfo& info);

    // True while an exclusive operation (exec/close/wait/loadExtension) is
    // running or waiting in the database queue. Deprecated in favour of
    // state; kept for one minor version as an alias.
    Napi::Value QueueBusy(const Napi::CallbackInfo& info);

    static void SetBusyTimeout(Baton* baton);
    static void SetLimit(Baton* baton);

    // Deferred main-thread sqlite work (see MayBlockOnWorkerRoundTrip):
    // exclusive, so each dispatches only once pending == 0 and the
    // connection mutex is provably free. Definitions in statement.cc.
    static void Work_DeferredStatementFinalize(Baton* baton);
    static void Work_DeferredHandleFinalize(Baton* baton);

    static void RegisterTraceCallback(Baton* baton);
    static void UpdateTraceMask(Database* db, sqlite3* handle);
    static int TraceV2Callback(unsigned int type, void* ctx, void* p, void* x);
    static void TraceCallback(Database* db, std::string* sql);

    static void RegisterProfileCallback(Baton* baton);
    static void ProfileCallback(Database* db, ProfileInfo* info);

    static void RegisterUpdateCallback(Baton* baton);
    static void UpdateCallback(void* db, int type, const char* database, const char* table, sqlite3_int64 rowid);
    static void UpdateCallback(Database* db, UpdateInfo* info);

    void RemoveCallbacks();

    // True when a main-thread sqlite call on this connection could block
    // on the connection mutex: a JS function or collation is registered
    // and statement work is in flight — a worker may be sitting inside a
    // round trip holding that mutex while it waits for this very thread.
    // Callers on the JS thread must defer their sqlite call (the exclusive
    // queue runs it once nothing is in flight) instead of touching the
    // handle. Without registered functions in-flight work never waits on
    // the JS thread, so the mutex is only ever held briefly and blocking
    // on it is fine — which is why every pre-existing path is unchanged.
    bool MayBlockOnWorkerRoundTrip() {
        return (!(js_functions.empty() && js_collations.empty()))
            && pending > 0;
    }

    // --- User-defined functions, aggregates, window functions and
    // collations (Deliverable 06). Implementation in src/function.cc.

    // JS-visible entry points. They validate argument types and schedule
    // the registration through the exclusive queue; the JS layer
    // (lib/sqlite3.js) wraps them with option parsing and the statement
    // cache flush.
    Napi::Value RegisterUserFunction(const Napi::CallbackInfo& info);
    Napi::Value RegisterUserAggregate(const Napi::CallbackInfo& info);
    Napi::Value RegisterUserCollation(const Napi::CallbackInfo& info);
    Napi::Value RemoveUserFunction(const Napi::CallbackInfo& info);
    Napi::Value RemoveUserCollation(const Napi::CallbackInfo& info);

    // Registration handlers. Exclusive: they touch the connection mutex
    // (sqlite3_create_function_v2 / sqlite3_create_collation take it), and
    // a worker blocked mid-round-trip inside sqlite3_step holds that mutex
    // while waiting for the JS thread — so a registration dispatched while
    // anything is in flight would deadlock the JS thread on the mutex.
    // Waiting for pending == 0 (the exclusive semantic) guarantees the
    // mutex is free.
    static void Work_RegisterFunction(Baton* baton);
    static void Work_RegisterAggregate(Baton* baton);
    static void Work_RegisterCollation(Baton* baton);
    static void Work_RemoveFunction(Baton* baton);
    static void Work_RemoveCollation(Baton* baton);

    // sqlite invokes these from whatever thread is stepping the statement.
    static void JsScalarFunc(sqlite3_context* ctx, int argc, sqlite3_value** argv);
    static void JsAggregateStep(sqlite3_context* ctx, int argc, sqlite3_value** argv);
    static void JsAggregateFinal(sqlite3_context* ctx);
    static void JsAggregateValue(sqlite3_context* ctx);
    static void JsAggregateInverse(sqlite3_context* ctx, int argc, sqlite3_value** argv);
    static int JsCollation(void* ctx, int len1, const void* d1, int len2, const void* d2);
    // xDestroy for every registration. Runs on the JS thread by
    // construction (see src/function.cc).
    static void JsFuncDestroy(void* data);

    // Unregisters and frees every user function and collation. Called from
    // Work_BeginClose and ~Database, both main-thread with nothing in
    // flight. Registrations sqlite refuses to drop (SQLITE_BUSY with a
    // suspended cursor — which also makes the close fail) are kept alive
    // with their holders, so the connection stays consistent.
    void RemoveUserFunctions();

    // Releases the callback channel when no registration is left. Only
    // called from live-loop contexts (the removal handlers, Work_BeginClose)
    // — never from a destructor, where it could re-enter the channel's own
    // teardown and hang the process at exit.
    void ReleaseJsChannelIfIdle();

    // Attaches the most recently thrown JS error from a user function as
    // `cause` on `err`, consuming it. The slot is set from the
    // ThreadSafeFunction callback while a worker is blocked mid-round-trip;
    // the step failure it causes is always the next error built for this
    // connection, which is where this is called from.
    void AttachPendingJsError(Napi::Object err);

protected:
    sqlite3* _handle = NULL;

    DbState db_state = DbState::Opening;
    // True only while an exclusive call (exec/close/wait/loadExtension)
    // holds the database: set when it is dispatched, cleared when it
    // completes. The old sticky `locked` flag stayed true after an
    // exclusive call finished (and forever after close); db.state exposes
    // this one honestly.
    bool exclusiveHeld = false;
    unsigned int pending = 0;

    bool serialize = false;

    // See IntegerMode above. Read by Statement when converting rows and
    // lastID; only ever mutated on the main thread by configure().
    int integer_mode = INTEGER_NUMBER;

    std::queue<Call*> queue;

    AsyncTrace* debug_trace = NULL;
    AsyncProfile* debug_profile = NULL;
    AsyncUpdate* update_event = NULL;

    // --- User-defined function state (Deliverable 06) ---

    // Registered callbacks, owned. Main-thread-only access: population
    // happens in the exclusive registration handlers, teardown in
    // RemoveUserFunctions and the same handlers' failure paths.
    std::vector<JsFunc*> js_functions;
    std::vector<JsFunc*> js_collations;

    // One raw ThreadSafeFunction per database carrying every user-function
    // round trip. Created lazily by the first registration, Unref'd (so it
    // never keeps the event loop alive) and released only when the last
    // registration is gone and nothing can be in flight.
    napi_threadsafe_function js_channel = NULL;

    // The JS error thrown inside a user function that caused the current
    // step failure: attached as `cause` on the SQLite error the statement
    // then reports. JS-thread-only (set in the channel callback, consumed
    // by the error builders).
    Napi::Reference<Napi::Value> pending_js_error;
};

}

#endif
