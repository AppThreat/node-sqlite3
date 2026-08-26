#ifndef NODE_SQLITE3_SRC_STATEMENT_H
#define NODE_SQLITE3_SRC_STATEMENT_H

#include <cstdlib>
#include <cstring>
#include <string>
#include <queue>
#include <vector>
#include <sqlite3.h>
#include <napi.h>
#include <uv.h>

#include "convert.h"
#include "database.h"
#include "threading.h"

using namespace Napi;

namespace node_sqlite3 {



class Statement : public Napi::ObjectWrap<Statement> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Value New(const Napi::CallbackInfo& info);

    friend class Database;

    // Runs the finalize work of an original finalize baton (directly, or
    // via the deferred wrappers below).
    struct Baton;
    static void FinishFinalizeBaton(Baton* baton);

    struct Baton {
        napi_async_work request = NULL;
        Statement* stmt;
        Napi::FunctionReference callback;
        Parameters parameters;
        // True when the call site passed a bind argument at all (possibly
        // an empty array/object). False means "re-step with the previous
        // bindings", which must skip the parameter-count check.
        bool bind_supplied = false;

        Baton(Statement* stmt_, Napi::Function cb_) : stmt(stmt_) {
            stmt->Ref();
            callback.Reset(cb_, 1);
        }

        // Delivers `error` to whichever callback settles this call, used
        // by CleanQueue when the statement is torn down with work still
        // queued. Returns false when the call has no callback to settle,
        // so the caller can fall back to an 'error' event. For most calls
        // that callback is `callback`; each() overrides this, because
        // there `callback` is the per-row callback and firing it would
        // hand the caller a phantom row.
        virtual bool Fail(Napi::Value error) {
            Napi::Function cb = callback.Value();
            if (cb.IsEmpty() || !cb.IsFunction()) return false;
            Napi::Value argv[] = { error };
            // A throwing callback still counts as settled: it ran.
            TRY_CATCH_CALL(stmt->Value(), cb, 1, argv, true);
            return true;
        }

        virtual ~Baton() {
            parameters.clear();
            if (request) napi_delete_async_work(stmt->Env(), request);
            stmt->Unref();
            callback.Reset();
        }
    };

    struct RowBaton : Baton {
        RowBaton(Statement* stmt_, Napi::Function cb_) :
            Baton(stmt_, cb_) {}
        Row row;
        Columns columns;
        virtual ~RowBaton() override = default;
    };

    struct RunBaton : Baton {
        RunBaton(Statement* stmt_, Napi::Function cb_) :
            Baton(stmt_, cb_), inserted_id(0), changes(0) {}
        sqlite3_int64 inserted_id;
        int changes;
        virtual ~RunBaton() override = default;
    };

    struct RowsBaton : Baton {
        RowsBaton(Statement* stmt_, Napi::Function cb_) :
            Baton(stmt_, cb_) {}
        Rows rows;
        Columns columns;
        virtual ~RowsBaton() override = default;
    };

    // fetch(count, ...): like all(), but steps at most `count` rows so a
    // pull-based iterator can apply backpressure. The statement is not
    // reset between fetches; the cursor keeps its position.
    struct FetchBaton : RowsBaton {
        FetchBaton(Statement* stmt_, Napi::Function cb_) :
            RowsBaton(stmt_, cb_), count(1), done(false) {}
        int count;
        // True when sqlite3_step returned SQLITE_DONE: the cursor is
        // exhausted and only a rebind can produce more rows.
        bool done;
        virtual ~FetchBaton() override = default;
    };

    struct Async;

    struct EachBaton : Baton {
        Napi::FunctionReference completed;
        Async* async; // Isn't deleted when the baton is deleted.

        EachBaton(Statement* stmt_, Napi::Function cb_) :
            Baton(stmt_, cb_) {}

        // When each() was given a completion handler that handler settles
        // the call, and takes (err, rowCount). Without one the per-row
        // callback is the only thing the caller passed, so the error goes
        // there instead — never to both, and never a row-shaped call with
        // no error.
        virtual bool Fail(Napi::Value error) override {
            Napi::Function done = completed.Value();
            if (!done.IsEmpty() && done.IsFunction()) {
                Napi::Value argv[] = {
                    error, Napi::Number::New(error.Env(), 0)
                };
                TRY_CATCH_CALL(stmt->Value(), done, 2, argv, true);
                return true;
            }
            return Baton::Fail(error);
        }

        virtual ~EachBaton() override {
            completed.Reset();
        }
    };

    struct PrepareBaton : Database::Baton {
        Statement* stmt;
        std::string sql;
        PrepareBaton(Database* db_, Napi::Function cb_, Statement* stmt_) :
            Baton(db_, cb_), stmt(stmt_) {
            stmt->Ref();
        }
        virtual ~PrepareBaton() override {
            stmt->Unref();
            if (db->IsClosed()) {
                // The database handle was closed before the statement could be
                // prepared.
                stmt->Finalize_();
            }
        }
    };

    typedef void (*Work_Callback)(Baton* baton);

    struct Call {
        Call(Work_Callback cb_, Baton* baton_) : callback(cb_), baton(baton_) {};
        Work_Callback callback;
        Baton* baton;
    };

    // Deferral wrappers for the main-thread finalize paths (see
    // Database::MayBlockOnWorkerRoundTrip): they carry the original work
    // through the database's exclusive queue so the sqlite3_finalize runs
    // on this thread only once no worker can hold the connection mutex.
    struct DeferredFinalizeBaton : Database::Baton {
        Statement::Baton* inner;
        DeferredFinalizeBaton(Database* db_, Statement::Baton* inner_) :
                Baton(db_, Napi::Function()), inner(inner_) {}
        virtual ~DeferredFinalizeBaton() override {
            delete inner;
        }
    };

    struct HandleFinalizeBaton : Database::Baton {
        sqlite3_stmt* handle;
        HandleFinalizeBaton(Database* db_, sqlite3_stmt* handle_) :
                Baton(db_, Napi::Function()), handle(handle_) {}
        virtual ~HandleFinalizeBaton() override = default;
    };

    struct Async {
        uv_async_t watcher;
        Statement* stmt;
        Rows data;
        // Column names for the rows currently in `data`. Written by the
        // worker thread and read by the main thread, both under the mutex
        // below, so a mid-stream re-prepare cannot be missed.
        Columns columns;
        NODE_SQLITE3_MUTEX_t;
        bool completed;
        int retrieved;

        // Store the callbacks here because we don't have
        // access to the baton in the async callback.
        Napi::FunctionReference item_cb;
        Napi::FunctionReference completed_cb;

        Async(Statement* st, uv_async_cb async_cb) :
                stmt(st), completed(false), retrieved(0) {
            watcher.data = this;
            NODE_SQLITE3_MUTEX_INIT
            stmt->Ref();
            uv_loop_t *loop;
            napi_get_uv_event_loop(stmt->Env(), &loop);
            uv_async_init(loop, &watcher, async_cb);
        }

        ~Async() {
            stmt->Unref();
            item_cb.Reset();
            completed_cb.Reset();
            NODE_SQLITE3_MUTEX_DESTROY
        }
    };

    Statement(const Napi::CallbackInfo& info);

    // Finalize-on-GC safety net: tears down a collected statement that
    // was never finalized. Runs in the ObjectWrap finalizer, so it must
    // not call into JS; see the definition in statement.cc for why each
    // step is safe there.
    ~Statement();

    WORK_DEFINITION(Bind)
    WORK_DEFINITION(Get)
    WORK_DEFINITION(Run)
    WORK_DEFINITION(All)
    WORK_DEFINITION(Each)
    WORK_DEFINITION(Reset)
    WORK_DEFINITION(Fetch)

    Napi::Value Finalize_(const Napi::CallbackInfo& info);

    // End-of-call bookkeeping for an asynchronous statement operation.
    void EndCall();

    // Runs EndCall() on every exit path from a Work_After* handler. This
    // matters because TRY_CATCH_CALL returns early when a JS callback
    // throws: doing the bookkeeping inline would then be skipped, leaving
    // `locked` set and db->pending elevated forever. The statement's queue
    // would never drain again and the sync fast path's idle gate could
    // never pass, so one throwing callback would permanently disable
    // getSync/runSync/allSync on that connection.
    struct CallGuard {
        Statement* stmt;
        explicit CallGuard(Statement* s) : stmt(s) {}
        ~CallGuard() { stmt->EndCall(); }
        CallGuard(const CallGuard&) = delete;
        CallGuard& operator=(const CallGuard&) = delete;
    };

    // Opt-in synchronous fast path. Only legal when the database is fully
    // idle (no worker in flight, nothing queued); otherwise throws.
    Napi::Value GetSync(const Napi::CallbackInfo& info);
    Napi::Value RunSync(const Napi::CallbackInfo& info);
    Napi::Value AllSync(const Napi::CallbackInfo& info);

    // Mode-aware accessors for the result of the last run(). lastID throws
    // a RangeError in 'number' mode when the rowid is not a safe integer;
    // lastIDBigInt is exact in every mode. changes is always a safe number.
    Napi::Value GetLastID(const Napi::CallbackInfo& info);
    Napi::Value GetLastIDBigInt(const Napi::CallbackInfo& info);
    Napi::Value GetChanges(const Napi::CallbackInfo& info);

    // True once the statement has been finalized: explicitly, after a
    // failed prepare, or by the GC safety net. Operations on a finalized
    // statement fail with SQLITE_MISUSE.
    Napi::Value FinalizedGetter(const Napi::CallbackInfo& info);

protected:
    static void Work_BeginPrepare(Database::Baton* baton);
    static void Work_Prepare(napi_env env, void* data);
    static void Work_AfterPrepare(napi_env env, napi_status status, void* data);

    static void AsyncEach(uv_async_t* handle);
    static void CloseCallback(uv_handle_t* handle);

    static void Finalize_(Baton* baton);
    void Finalize_();

    template <class T> inline std::unique_ptr<Values::Field> BindParameter(const Napi::Value source, T pos);
    template <class T> T* Bind(const Napi::CallbackInfo& info, int start = 0, int end = -1);
    bool Bind(Parameters&& parameters, bool supplied);

    static void GetRow(Row* row, sqlite3_stmt* stmt, Columns* columns);
    // Rebuilds the rooted JS key strings if `columns` differs from the set
    // they were built from. Call once per batch, before RowToJS.
    void SyncColumnKeys(Napi::Env env, const Columns& columns);
    Napi::Value RowToJS(Napi::Env env, Row* row);
    // Converts an int64 cell/rowid according to the database's integer
    // mode. Throws a RangeError in 'number' mode for unsafe values;
    // callers must check env.IsExceptionPending() afterwards.
    Napi::Value Int64ToJS(Napi::Env env, sqlite3_int64 value, const std::string& what);
    // Stores the result of a completed run() for the lastID/lastIDBigInt/
    // changes accessors.
    void RecordRunResult(sqlite3_int64 id, int changes);
    void Schedule(Work_Callback callback, Baton* baton);
    void Process();
    void CleanQueue();
    template <class T> static void Error(T* baton);

    // True when nothing anywhere on this database is in flight or queued,
    // so sqlite can be driven from the main thread without racing the
    // worker pool or breaking FIFO ordering.
    bool IdleForInline();
    // Throws the pending status/message as a JS error with errno/code.
    void ThrowStatementError(Napi::Env env);
    // Shared gate + argument extraction for the sync methods. Returns a
    // prepared baton or NULL after throwing.
    template <class T> T* BindSync(const Napi::CallbackInfo& info);

    void FailQueue(Napi::Value error, bool emit_if_unhandled = true);


protected:
    // NULL when the constructor threw before validation completed; every
    // destructor path gates on it.
    Database* db = NULL;

    sqlite3_stmt* _handle = NULL;
    int status = SQLITE_OK;
    bool prepared = false;
    bool locked = true;
    bool finalized = false;

    // Result of the most recent run(), exposed through the lastID,
    // lastIDBigInt and changes accessors.
    sqlite3_int64 last_insert_id = 0;
    int last_changes = 0;
    bool has_run_result = false;

    // Payloads of the currently SQLITE_STATIC-bound text/blob parameters.
    // Owned until the next rebind or finalize so sqlite never sees a
    // dangling pointer when a statement is stepped again without rebinding.
    Parameters bound_payloads;

    // Rooted JS key strings used for row conversion, plus the column names
    // they were built from so a schema change can invalidate them.
    std::vector<std::string> column_keys_source;
    std::vector<Napi::Reference<Napi::String>> column_keys;

    std::queue<Call*> queue;
    std::string message;
};

}

#endif
