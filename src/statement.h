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

#include "database.h"
#include "threading.h"

using namespace Napi;

namespace node_sqlite3 {

namespace Values {
    struct Field {
        inline Field(unsigned short _index, unsigned short _type = SQLITE_NULL) :
            type(_type), index(_index) {}
        inline Field(const char* _name, unsigned short _type = SQLITE_NULL) :
            type(_type), index(0), name(_name) {}

        unsigned short type;
        unsigned short index;
        std::string name;

        virtual ~Field() = default;
    };

    struct Integer : Field {
        template <class T> inline Integer(T _name, int64_t val) :
            Field(_name, SQLITE_INTEGER), value(val) {}
        int64_t value;
        virtual ~Integer() override = default;
    };

    struct Float : Field {
        template <class T> inline Float(T _name, double val) :
            Field(_name, SQLITE_FLOAT), value(val) {}
        double value;
        virtual ~Float() override = default;
    };

    struct Text : Field {
        template <class T> inline Text(T _name, size_t len, const char* val) :
            Field(_name, SQLITE_TEXT), value(val, len) {}
        std::string value;
        virtual ~Text() override = default;
    };

    struct Blob : Field {
        template <class T> inline Blob(T _name, size_t len, const void* val) :
                Field(_name, SQLITE_BLOB), length(len) {
            value = new char[len];
            assert(value != nullptr);
            memcpy(value, val, len);
        }
        inline virtual ~Blob() override {
            delete[] value;
        }
        int length;
        char* value;
    };

    typedef Field Null;
}

// A converted result cell: a flat value type instead of a per-cell heap
// object. TEXT payload and BLOB bytes live in `str` (binary-safe).
struct Cell {
    unsigned short type = SQLITE_NULL;
    int64_t integer = 0;
    double real = 0.;
    std::string str;

    Cell() = default;
    explicit Cell(unsigned short t) : type(t) {}
    Cell(const Cell&) = default;
    Cell(Cell&&) = default;
    Cell& operator=(const Cell&) = default;
    Cell& operator=(Cell&&) = default;
};

typedef std::vector<Cell> Row;
typedef std::vector<Row> Rows;
typedef std::vector<std::unique_ptr<Values::Field>> Parameters;

// Result column names captured from a prepared statement, shared by every
// row of one batch instead of being stored per cell.
//
// The shape is fixed for one execution: sqlite3_prepare_v2 may re-prepare
// transparently behind sqlite3_step() when the schema changed, but it keeps
// the original result columns. Capturing once per call therefore stays
// correct without relying on the names surviving across calls.
struct Columns {
    std::vector<std::string> names;

    // Populates the names on first use. Called on the thread that steps the
    // statement, once per execution.
    inline void EnsureLoaded(sqlite3_stmt* stmt) {
        if (!names.empty()) return;
        int cols = sqlite3_column_count(stmt);
        names.reserve(cols);
        for (int i = 0; i < cols; i++) {
            const char* name = sqlite3_column_name(stmt, i);
            names.emplace_back(name != NULL ? name : "");
        }
    }
};



class Statement : public Napi::ObjectWrap<Statement> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::Value New(const Napi::CallbackInfo& info);

    struct Baton {
        napi_async_work request = NULL;
        Statement* stmt;
        Napi::FunctionReference callback;
        Parameters parameters;

        Baton(Statement* stmt_, Napi::Function cb_) : stmt(stmt_) {
            stmt->Ref();
            callback.Reset(cb_, 1);
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

    struct Async;

    struct EachBaton : Baton {
        Napi::FunctionReference completed;
        Async* async; // Isn't deleted when the baton is deleted.

        EachBaton(Statement* stmt_, Napi::Function cb_) :
            Baton(stmt_, cb_) {}
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
            if (!db->IsOpen() && db->IsLocked()) {
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

    ~Statement() {
        if (!finalized) Finalize_();
    }

    WORK_DEFINITION(Bind)
    WORK_DEFINITION(Get)
    WORK_DEFINITION(Run)
    WORK_DEFINITION(All)
    WORK_DEFINITION(Each)
    WORK_DEFINITION(Reset)

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
    bool Bind(Parameters&& parameters);

    static void GetRow(Row* row, sqlite3_stmt* stmt, Columns* columns);
    // Rebuilds the rooted JS key strings if `columns` differs from the set
    // they were built from. Call once per batch, before RowToJS.
    void SyncColumnKeys(Napi::Env env, const Columns& columns);
    Napi::Value RowToJS(Napi::Env env, Row* row);
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

protected:
    Database* db;

    sqlite3_stmt* _handle = NULL;
    int status = SQLITE_OK;
    bool prepared = false;
    bool locked = true;
    bool finalized = false;

    // Lazily-created persistent keys for the run() result properties.
    Napi::Reference<Napi::String> key_last_id;
    Napi::Reference<Napi::String> key_changes;

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
