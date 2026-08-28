
#ifndef NODE_SQLITE3_SRC_DATABASE_H
#define NODE_SQLITE3_SRC_DATABASE_H


#include <assert.h>
#include <atomic>
#include <string>
#include <queue>
#include <vector>

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
struct SessionOps;
class Session;
class Blob;
// One queued 'preupdate' event (Deliverable 08); defined in
// src/session.h, which can see the Cell type from src/convert.h.
struct PreupdateInfo;


class Database : public Napi::ObjectWrap<Database> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    // The declarative authorizer: a rule list evaluated in C++ (a JS
    // callback would need a blocking round trip from inside
    // sqlite3_prepare, on whatever thread is preparing).
    struct AuthRule {
        int action = -1;   // -1 matches any authorizer action
        int verdict;       // SQLITE_OK / SQLITE_DENY / SQLITE_IGNORE
        std::string arg1;  // table, index, pragma name…
        std::string arg2;  // column, new name…
        std::string database;
        std::string trigger;
        // An unspecified field (null/undefined in the rule row) matches
        // anything; an explicitly-passed empty string matches only an
        // empty argument, which D07's wildcard-"" encoding could not
        // express.
        bool arg1_any = true;
        bool arg2_any = true;
        bool database_any = true;
        bool trigger_any = true;
    };
    struct AuthPolicy {
        int default_decision = SQLITE_OK;
        // Deny rules first, then ignore, then allow: a deny can never be
        // rescued by a later allow, which is the safe reading for a
        // sandbox (the JS layer orders them this way).
        std::vector<AuthRule> rules;
    };

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

    // Per-environment constructor references, one slot per exported
    // class. These must live in instance data rather than in file
    // statics: node-addon-api deletes instance data at env teardown, while
    // a static Napi::Reference is destroyed at process exit — after the
    // env is gone — so its napi_delete_reference lands on a dead
    // environment (a segfault at exit, seen on musl). Instance data is
    // also per-env, which a static is not: every worker thread gets its
    // own napi env, and a static would hand one environment a constructor
    // belonging to another. Database::Init allocates the block (it runs
    // first in RegisterModule); each class's Init fills in its own slot.
    struct AddonData {
        Napi::FunctionReference database_ctor;
        Napi::FunctionReference statement_ctor;
        Napi::FunctionReference backup_ctor;
        Napi::FunctionReference session_ctor;
        Napi::FunctionReference blob_ctor;
        Napi::FunctionReference changeset_iter_ctor;
        // Cached verdict of EnvCannotRunJs: once an environment refuses
        // JS mutation it is being torn down and never comes back, so the
        // probe never needs repeating. probe_object/probe_key are the
        // reusable probe pair (built once on a live env) so the per-
        // completion cost is two reference reads and one set_property.
        bool cannot_run_js = false;
        napi_ref probe_object = NULL;
        napi_ref probe_key = NULL;
        // The JS row-factory generator, registered once at module load by
        // lib/sqlite3.js. Given the result column names it compiles a
        // monomorphic function that builds one row from its arguments, so
        // a row costs one napi_call_function instead of one V8 property
        // store per column. NULL when the JS half never registered it, or
        // when the environment forbids code generation from strings — both
        // fall back to the per-cell store loop.
        napi_ref row_factory_generator = NULL;
        // Set once the generator has refused (a CSP/no-codegen realm), so
        // the refusal is not retried per statement.
        bool row_factory_unavailable = false;
    };

    // True when this environment can no longer accept JS mutation — it
    // is being torn down. A terminated worker has its remaining
    // async-work completions delivered while the isolate is unwinding,
    // where any JS construction, throw or checked property operation is
    // fatal (node-addon-api's error path calls napi_throw, which fatals
    // in turn); those completions must bail out instead. Probed with a
    // real property operation on a per-env cached pair — the cheap calls
    // (get_global, typeof, reference get/create/delete) still succeed on
    // a dying env; property access is where it is refused.
    //
    // A refused probe has exactly two causes: the isolate is terminating,
    // or an exception is already pending. `pending_means_alive` says
    // which one the caller can be in, and the two callers genuinely
    // differ:
    //
    //   * Synchronous callers (CleanQueue, reached while a throwing
    //     JS callback unwinds) legitimately run with an exception
    //     pending on a perfectly healthy env — pass true.
    //   * Async-work completions enter a fresh callback scope with no
    //     exception pending on a healthy env, so a refusal there means
    //     the isolate is terminating — pass false. Treating it as alive
    //     is what let a terminated worker with several queued
    //     completions still fatal in Work_AfterAll: V8's termination
    //     exception is pending, so the probe was refused *and* reported
    //     alive, and the handler walked straight into the throw.
    //
    // The verdict is cached in AddonData (teardown never reverses), but
    // only when it was reached without a pending exception: if the
    // premise above is ever wrong, the cost is one dropped completion
    // rather than a permanently dead connection.
    static inline bool EnvCannotRunJs(napi_env e,
            bool pending_means_alive = true) {
        auto env = Napi::Env(e);
        auto* data = env.GetInstanceData<AddonData>();
        if (data != nullptr && data->cannot_run_js) return true;

        napi_value obj = nullptr;
        napi_value key = nullptr;
        bool refused;
        if (data != nullptr && data->probe_object != NULL) {
            // Hot path: the reusable probe pair, two reference reads.
            bool has = false;
            refused = napi_get_reference_value(e, data->probe_object, &obj) != napi_ok
                || napi_get_reference_value(e, data->probe_key, &key) != napi_ok
                || napi_has_property(e, obj, key, &has) != napi_ok;
        } else {
            refused = napi_create_object(e, &obj) != napi_ok
                || napi_create_string_utf8(e, "sqlite3_probe", 13, &key) != napi_ok
                || napi_set_property(e, obj, key, key) != napi_ok;
            if (!refused && data != nullptr) {
                // Keep the pair for every later probe on this env. If
                // the reference creation fails the pair is simply not
                // cached; the probe above already ran.
                napi_ref obj_ref = NULL;
                napi_ref key_ref = NULL;
                if (napi_create_reference(e, obj, 1, &obj_ref) == napi_ok
                        && napi_create_reference(e, key, 1, &key_ref) == napi_ok) {
                    data->probe_object = obj_ref;
                    data->probe_key = key_ref;
                }
            }
        }
        if (!refused) return false;
        bool pending = false;
        napi_is_exception_pending(e, &pending);
        if (pending && pending_means_alive) return false;
        // Only a refusal with no exception pending is provably terminal;
        // see the note above on why the pending case is not cached.
        if (!pending && data != nullptr) data->cannot_run_js = true;
        return true;
    }

    static inline bool HasInstance(Napi::Value val) {
        return HasInstanceIn(val, &AddonData::database_ctor);
    }

    // InstanceOf against a constructor held in this env's AddonData.
    // Shared by every class's HasInstance (Statement, Backup, Session,
    // Blob): one instance-data slot per env holds all of them, so
    // cross-class argument validation does not collide the way a single
    // SetInstanceData slot did. False, not an error, when the class is not
    // initialized in this env.
    static inline bool HasInstanceIn(Napi::Value val,
            Napi::FunctionReference AddonData::*slot) {
        auto env = val.Env();
        Napi::HandleScope scope(env);
        auto* data = env.GetInstanceData<AddonData>();
        if (data == nullptr || (data->*slot).IsEmpty()) return false;
        if (!val.IsObject()) return false;
        return val.As<Napi::Object>().InstanceOf((data->*slot).Value());
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

    // Deliverable 07: hook registration carries the wanted state (the JS
    // layer calls configure(type, true) for every addListener, so a toggle
    // here would uninstall a hook on the second listener).
    struct HookBaton : Baton {
        bool enable = false;
        HookBaton(Database* db_, Napi::Function cb_, bool enable_) :
            Baton(db_, cb_), enable(enable_) {}
        virtual ~HookBaton() override = default;
    };

    struct CheckpointBaton : Baton {
        std::string database;
        int mode;
        int log_frames = 0;
        int ckpt_frames = 0;
        CheckpointBaton(Database* db_, Napi::Function cb_,
                const char* database_, int mode_) :
            Baton(db_, cb_), database(database_), mode(mode_) {}
        virtual ~CheckpointBaton() override = default;
    };

    struct TableInfoBaton : Baton {
        struct Column {
            int cid;
            std::string name;
            std::string type;
            bool not_null;
            std::string dflt;
            int pk;
            std::string collate;
            bool autoinc;
        };
        std::string database;
        std::string table;
        std::vector<Column> columns;
        TableInfoBaton(Database* db_, Napi::Function cb_,
                const char* database_, const char* table_) :
            Baton(db_, cb_), database(database_), table(table_) {}
        virtual ~TableInfoBaton() override = default;
    };

    struct DbConfigBaton : Baton {
        int op;
        int value;
        int previous = 0;
        DbConfigBaton(Database* db_, Napi::Function cb_, int op_, int value_) :
            Baton(db_, cb_), op(op_), value(value_) {}
        virtual ~DbConfigBaton() override = default;
    };

    // Authorizer registration. Owns `policy` until the exclusive handler
    // installs it (or the schedule fails and the baton destructor frees
    // it).
    struct AuthBaton : Baton {
        AuthPolicy* policy = NULL;
        bool remove = false;
        AuthBaton(Database* db_, Napi::Function cb_) : Baton(db_, cb_) {}
        virtual ~AuthBaton() override { delete policy; }
    };

    // ATTACH-gate registration (Deliverable 11). Carries the enabled flag
    // and the allowlist until the exclusive handler installs them.
    struct AttachGateBaton : Baton {
        bool enable = false;
        std::vector<std::string> allow;
        AttachGateBaton(Database* db_, Napi::Function cb_) : Baton(db_, cb_) {}
        virtual ~AttachGateBaton() override = default;
    };

    // Cancellation-token registration. Owns the Int32Array reference (and
    // the captured flag pointer) until the exclusive handler installs it.
    struct ProgressFlagBaton : Baton {
        int period;
        std::atomic<int32_t>* flag = NULL;
        Napi::Reference<Napi::Value> buffer;
        ProgressFlagBaton(Database* db_, Napi::Function cb_, int period_) :
            Baton(db_, cb_), period(period_) {}
        virtual ~ProgressFlagBaton() override = default;
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
        // Which connection event this queued item delivers. change,
        // commit and rollback share one ordered channel so a
        // transaction's change events always reach JS before its commit
        // (or rollback) event: three separate uv_async_t watchers would
        // be drained in handle-init order, not send order, whenever two
        // were pending in the same loop wakeup.
        enum Kind { kChange, kCommit, kRollback } kind = kChange;
        int type = 0;                      // kChange only (SQLITE_INSERT/…)
        std::string database;
        std::string table;
        sqlite3_int64 rowid = 0;
    };

    struct WalInfo {
        std::string database;
        int pages;
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
    typedef Async<WalInfo, Database> AsyncWal;
    typedef Async<PreupdateInfo, Database> AsyncPreupdate;

    friend class Statement;
    friend class Backup;
    friend class Session;
    friend class Blob;
    friend struct UserFunctionOps;
    friend struct SessionOps;

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

    // Drains the database queue on every exit path from a Work_After*
    // handler, including TRY_CATCH_CALL's early return when a JS
    // callback throws. The database-level completions (open/exec/close/
    // loadExtension) call Process() as their last statement; a throwing
    // completion callback used to skip it, leaving everything queued
    // behind the exclusive call undispatched forever — every later
    // query on the connection never settled. Same discipline as
    // Statement::CallGuard, which runs the statement-side bookkeeping
    // on every exit path for the same reason.
    //
    // When the handler exits through a throwing callback the exception
    // is still pending, and Process() cannot deliver JS under it —
    // napi_call_function is refused while an exception is pending, so
    // the Closed-state branch (which fails queued batons inline) would
    // bail out of its first callback and strand the rest. The guard
    // lifts the pending exception for the drain and re-arms it
    // afterwards, so the uncaught-exception delivery the runtime
    // performs is unchanged.
    struct ProcessGuard {
        Database* db;
        explicit ProcessGuard(Database* db_) : db(db_) {}
        ~ProcessGuard() {
            auto env = db->Env();
            napi_value pending = nullptr;
            bool had_pending = false;
            napi_is_exception_pending(env, &had_pending);
            if (had_pending) {
                napi_get_and_clear_last_exception(env, &pending);
            }
            db->Process();
            // Re-arm the lifted exception — unless the drain itself
            // threw, in which case that newer exception wins and the
            // lifted one is dropped (one exception still surfaces).
            if (pending != nullptr) {
                bool still_clean = false;
                napi_is_exception_pending(env, &still_clean);
                if (!still_clean) napi_throw(env, pending);
            }
        }
        ProcessGuard(const ProcessGuard&) = delete;
        ProcessGuard& operator=(const ProcessGuard&) = delete;
    };

    Database(const Napi::CallbackInfo& info);

    ~Database() {
        RemoveCallbacks();
        RemoveUserFunctions();
        RemoveAuthorizer();
        RemoveProgressHandler();
        RemovePreupdateHook();
        // owner_dying: this Database is mid-destruction, so the
        // detaching objects must not call back into it.
        CloseLiveSessions(true);
        CloseLiveBlobs(true);
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
    // Same deferral for a collected Session's native handle. Definition
    // in src/session.cc.
    static void Work_DeferredSessionDelete(Baton* baton);

    static void RegisterTraceCallback(Baton* baton);
    static void UpdateTraceMask(Database* db, sqlite3* handle);
    static int TraceV2Callback(unsigned int type, void* ctx, void* p, void* x);
    static void TraceCallback(Database* db, std::string* sql);

    static void RegisterProfileCallback(Baton* baton);
    static void ProfileCallback(Database* db, ProfileInfo* info);

    static void RegisterUpdateCallback(Baton* baton);
    static void UpdateCallback(void* db, int type, const char* database, const char* table, sqlite3_int64 rowid);
    static void UpdateCallback(Database* db, UpdateInfo* info);

    // --- Transaction hooks (commit / rollback), the WAL hook, the
    // declarative authorizer and the progress handler (Deliverable 07).
    // All registration goes through the exclusive queue with the
    // MayBlockOnWorkerRoundTrip deferral — every sqlite3_*_hook /
    // sqlite3_set_authorizer / sqlite3_progress_handler call takes the
    // connection mutex.

    static void RegisterCommitCallback(Baton* baton);
    static void RegisterRollbackCallback(Baton* baton);
    static void RegisterWalCallback(Baton* baton);
    // The sqlite hooks. Advisory by design: the commit/rollback/wal
    // return values are ignored (always "proceed"), because a veto would
    // block the committing worker on the JS thread — the D06 deadlock
    // shape, on the commit path. A NULL channel (hooks removed, close in
    // progress) means drop the event: sqlite itself may still fire a hook
    // during the implicit rollback of sqlite3_close.
    static int CommitHook(void* ctx);
    static void RollbackHook(void* ctx);
    static int WalHook(void* ctx, sqlite3* handle, const char* database,
            int pages);
    static void TxnCallback(Database* db, UpdateInfo* info);
    static void WalCallback(Database* db, WalInfo* info);
    // Creates the shared channel on first need / releases it when no
    // transaction hook is left. Exclusive contexts only.
    static void EnsureTxnChannel(Database* db);
    static void MaybeDropTxnChannel(Database* db);

    Napi::Value SetAuthorizer(const Napi::CallbackInfo& info);
    static void Work_SetAuthorizer(Baton* baton);
    // Runs on whatever thread is preparing. auth_policy is only ever
    // swapped by the exclusive handler (pending == 0, so no prepare is
    // running) and freed after the swap, so the pointer read here is
    // stable for the whole call.
    static int AuthorizerCallback(void* ctx, int action, const char* arg1,
        const char* arg2, const char* database, const char* trigger);
    void RemoveAuthorizer();

    // --- ATTACH gate (Deliverable 11). SQLite exposes exactly one
    // authorizer slot per connection, and the declarative authorizer above
    // occupies it whenever a policy is installed — so the gate is not a
    // second authorizer but a pre-filter evaluated inside
    // AuthorizerCallback: while attach_gate is set, every SQLITE_ATTACH
    // action (which is also what VACUUM INTO fires for its output file)
    // is denied unless the target filename matches the allowlist. The
    // allowlist is populated by the JS layer, which permission-checks each
    // entry against Node's permission model at declare time — the C side
    // cannot query it, and a JS callback here would put JavaScript on the
    // prepare path. Matching is lexical (exact string, separator-
    // normalised, or joined with the process cwd); symlinks are not
    // resolved, so a mismatched spelling is denied — fail-closed.
    // attach_gate/attach_allow follow auth_policy's lifetime discipline:
    // written only by the exclusive handler at pending == 0 (no prepare
    // can be reading them), cleared in Work_BeginClose and ~Database.
    Napi::Value SetAttachGate(const Napi::CallbackInfo& info);
    static void Work_SetAttachGate(Baton* baton);
    static bool AttachTargetAllowed(const Database* db, const char* arg1);

    // --- Preupdate event (Deliverable 08). One preupdate hook slot
    // exists per connection and is shared with the session extension:
    // sqlite3session_create installs its own hook, displacing ours.
    // Ownership is therefore exclusive — see the note in src/session.h —
    // and enforced on the JS thread at pending == 0 in both directions.
    // The trampoline materialises old/new rows eagerly (the
    // sqlite3_preupdate_old/new values die with the callback) and defers
    // the JS event through the shared channel; the JS-thread half
    // converts with the connection's integer mode.
    static void RegisterPreupdateCallback(Baton* baton);
    static void PreupdateTrampoline(void* ctx, sqlite3* handle, int op,
        const char* database, const char* table, sqlite3_int64 key1,
        sqlite3_int64 key2);
    static void PreupdateCallback(Database* db, PreupdateInfo* info);
    void RemovePreupdateHook();

    // Progress handler: either an atomic flag inside a SharedArrayBuffer
    // (db.cancellationToken(); zero per-invocation cost, cancellable from
    // any thread) or a JS callback making the D06 blocking round trip
    // (observability; documented as slow). One sqlite3_progress_handler
    // slot per connection, so the two forms replace each other.
    enum class ProgressMode { None, Flag, Callback };
    Napi::Value SetProgressFlag(const Napi::CallbackInfo& info);
    Napi::Value SetProgressCallback(const Napi::CallbackInfo& info);
    static void Work_SetProgressFlag(Baton* baton);
    static void Work_SetProgressCallback(Baton* baton);
    // The sqlite handler. Flag mode is a relaxed atomic load; callback
    // mode round-trips to the JS thread and aborts the statement when the
    // callback returns truthy or throws. Defined in src/function.cc with
    // the round-trip machinery. ApplyProgressHandler (re)installs or
    // removes the sqlite hook from the current state; exclusive contexts
    // only.
    static int ProgressHandler(void* ctx);
    static void ApplyProgressHandler(Database* db);
    void RemoveProgressHandler();
    // Frees the JS-callback holder, releasing its JS references and its
    // database ref exactly like JsFuncDestroy does for registered
    // functions (no sqlite registration exists to call xDestroy for us).
    void DropJsProgressHolder();

    // WAL checkpoints (sqlite3_wal_checkpoint_v2), table metadata
    // (PRAGMA table_info + sqlite3_table_column_metadata) and the safe
    // sqlite3_db_config subset. Scheduled work; the sqlite calls run on
    // the worker pool like statement work.
    Napi::Value Checkpoint(const Napi::CallbackInfo& info);
    static void Work_BeginCheckpoint(Baton* baton);
    static void Work_Checkpoint(napi_env env, void* data);
    static void Work_AfterCheckpoint(napi_env env, napi_status status, void* data);

    Napi::Value TableInfo(const Napi::CallbackInfo& info);
    static void Work_BeginTableInfo(Baton* baton);
    static void Work_TableInfo(napi_env env, void* data);
    static void Work_AfterTableInfo(napi_env env, napi_status status, void* data);

    Napi::Value DbConfig(const Napi::CallbackInfo& info);
    static void Work_BeginDbConfig(Baton* baton);
    static void Work_DbConfig(napi_env env, void* data);
    static void Work_AfterDbConfig(napi_env env, napi_status status, void* data);

    // --- Changeset apply, serialize/deserialize and session/blob
    // tracking (Deliverable 08). Definitions in src/session.cc and
    // src/blob.cc. _applyChangeset runs on the worker pool like
    // statement work (it is one big savepoint-wrapped write); the JS
    // conflict/filter forms round-trip through a per-apply
    // ThreadSafeFunction (js_apply_depth keeps MayBlockOnWorkerRoundTrip
    // truthful while any are in flight). _serializeToBytes and
    // _deserialize are exclusive: a snapshot must not interleave with
    // writes, and deserialize replaces the schema image outright.
    Napi::Value ApplyChangeset(const Napi::CallbackInfo& info);
    static void Work_BeginApplyChangeset(Baton* baton);
    static void Work_ApplyChangeset(napi_env env, void* data);
    static void Work_AfterApplyChangeset(napi_env env, napi_status status, void* data);

    Napi::Value SerializeToBytes(const Napi::CallbackInfo& info);
    static void Work_BeginSerializeToBytes(Baton* baton);
    static void Work_SerializeToBytes(napi_env env, void* data);
    static void Work_AfterSerializeToBytes(napi_env env, napi_status status, void* data);

    Napi::Value Deserialize(const Napi::CallbackInfo& info);
    static void Work_BeginDeserialize(Baton* baton);
    static void Work_Deserialize(napi_env env, void* data);
    static void Work_AfterDeserialize(napi_env env, napi_status status, void* data);

    // JS-thread, nothing in flight (Work_BeginClose / ~Database): delete
    // every tracked session handle / close every tracked blob handle so
    // sqlite3_close cannot leave them dangling. Both are idempotent.
    void CloseLiveSessions(bool owner_dying = false);
    void CloseLiveBlobs(bool owner_dying = false);

    // sqlite3_changes64 / sqlite3_total_changes64, subject to the
    // connection's integer mode.
    Napi::Value ChangesGetter(const Napi::CallbackInfo& info);
    Napi::Value TotalChangesGetter(const Napi::CallbackInfo& info);

    void RemoveCallbacks();

    // True when a main-thread sqlite call on this connection could block
    // on the connection mutex: a JS function, collation or progress
    // callback is registered and statement work is in flight, or a
    // changeset apply carrying JS conflict/filter handlers is queued or
    // in flight (the apply holds the connection mutex for its whole
    // run, and its handlers block on this thread) — a worker may be
    // sitting inside a round trip holding that mutex while it waits for
    // this very thread. Callers on the JS thread must defer their sqlite
    // call (the exclusive queue runs it once nothing is in flight)
    // instead of touching the handle. Without registered callbacks in-flight work never waits on the JS thread, so the mutex
    // is only ever held briefly and blocking on it is fine — which is why
    // every pre-existing path is unchanged.
    bool MayBlockOnWorkerRoundTrip() {
        return (!(js_functions.empty() && js_collations.empty()
                    && js_progress == NULL && js_apply_depth == 0))
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

    // Defined in src/function.cc beside the channel they serve: creates
    // the shared ThreadSafeFunction on demand (the progress callback form
    // needs it without any SQL function being registered), and reports a
    // registration failure on the connection's 'error' event.
    bool EnsureJsChannel();
    void ReportRegistrationFailure(int rc);

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

    // The sqlite3_open_v2 flags this connection was opened with, recorded
    // in Work_Open. The ATTACH gate reads SQLITE_OPEN_URI from it: without
    // that flag a 'file:…' target is an ordinary filename, not a URI.
    int open_mode = 0;

    // Set when Work_Open failed: the connection then lands in DbState::Closed
    // (it will never become usable), and Process()'s closed-state drain
    // fails work queued behind the failed open with THIS error rather than
    // the generic "Database handle is closed" — the caller queued against a
    // database that never existed, and the open failure is the error that
    // explains it. Before Deliverable 11 that work sat stranded in the
    // queue forever: Process() never dispatched from the Opening state.
    bool open_failed = false;
    std::string open_error_message;
    int open_error_status = SQLITE_OK;
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
    // Shared, ordered channel for the change/commit/rollback events (see
    // UpdateInfo::Kind). The per-hook installed flags say which sqlite
    // hooks feed it.
    AsyncUpdate* txn_event = NULL;
    bool hook_change = false;
    bool hook_commit = false;
    bool hook_rollback = false;
    AsyncWal* wal_event = NULL;

    // --- Preupdate event and session/blob tracking (Deliverable 08) ---
    //
    // Lifetime answers (the checklist items these must settle):
    //
    //  - preupdate_event is an Async channel exactly like txn_event:
    //    created by the exclusive registration handler, finished in
    //    RemovePreupdateHook (Work_BeginClose, ~Database). The sqlite
    //    hook is uninstalled before the channel is finished; a NULL
    //    channel inside the trampoline means "drop the event" (removed /
    //    closing), the same contract the update hook has.
    //  - live_sessions / live_blobs are JS-thread-only registries of the
    //    wrappers holding native handles. Population: session/blob
    //    construction (before the handle exists, so the preupdate-slot
    //    ownership check cannot miss one still being created) and blob
    //    open-completion. Teardown: each object's close-completion, the
    //    create/open failure paths, and CloseLiveSessions/CloseLiveBlobs
    //    (Work_BeginClose, ~Database — main thread, pending == 0).
    //    Disposing twice is a benign no-op (the handle is NULL the
    //    second time); disposing after the database closed finds the
    //    handle already NULL; and unlike the progress slot these
    //    objects do not displace one another, so "disposed after
    //    something else took its place" cannot occur.
    //  - js_apply_depth counts the changeset applies with JS
    //    conflict/filter handlers that are queued or in flight
    //    (JS-thread writes: the entry point increments, the
    //    after-handler decrements), and is read by
    //    MayBlockOnWorkerRoundTrip. A count, not a flag: nothing
    //    serialises applies, so two can overlap, and a flag cleared by
    //    the first to finish would declare the connection safe while the
    //    second still held the mutex inside sqlite3changeset_apply —
    //    which is precisely the deadlock MayBlockOnWorkerRoundTrip
    //    exists to prevent.
    AsyncPreupdate* preupdate_event = NULL;
    bool hook_preupdate = false;
    std::vector<Session*> live_sessions;
    std::vector<Blob*> live_blobs;
    int js_apply_depth = 0;

    // --- Authorizer and progress handler (Deliverable 07) ---
    //
    // Lifetime answers (the checklist items these must settle):
    //
    //  - auth_policy is owned by the Database, swapped only inside the
    //    exclusive registration handler — which by definition runs at
    //    pending == 0, when no prepare (the only context the authorizer
    //    fires in) can be executing on any thread. The old policy is
    //    freed after the sqlite3_set_authorizer swap, never under a
    //    concurrent callback. Cleared in Work_BeginClose and ~Database,
    //    both main-thread with nothing in flight.
    //  - The progress SharedArrayBuffer reference is a Napi persistent
    //    rooted on the main thread (created by the registration handler,
    //    reset in RemoveProgressHandler). The C handler dereferences
    //    progress_flag only while the sqlite hook is installed, and
    //    RemoveProgressHandler unregisters the hook before resetting the
    //    reference — at pending == 0, exclusive, so no step/prepare can
    //    be inside the handler. At environment teardown the reference is
    //    reclaimed with everything else; no JS runs.
    //  - js_progress (the callback form) is a JsFunc holder exactly like
    //    a registered function: JS-thread-only state, swept by the same
    //    exclusive removal paths, and its round trips ride the shared
    //    js_channel (see src/function.cc).
    AuthPolicy* auth_policy = NULL;
    // The ATTACH gate pre-filter state (see SetAttachGate above). Same
    // access discipline as auth_policy: JS-thread writes inside the
    // exclusive handler at pending == 0, reads from whatever thread is
    // preparing.
    bool attach_gate = false;
    std::vector<std::string> attach_allow;
    ProgressMode progress_mode = ProgressMode::None;
    int progress_period = 0;
    std::atomic<int32_t>* progress_flag = NULL;
    Napi::Reference<Napi::Value> progress_buffer;
    JsFunc* js_progress = NULL;

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
