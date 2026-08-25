
#ifndef NODE_SQLITE3_SRC_DATABASE_H
#define NODE_SQLITE3_SRC_DATABASE_H


#include <assert.h>
#include <string>
#include <queue>

#include <sqlite3.h>
#include <napi.h>

#include "async.h"

using namespace Napi;

namespace node_sqlite3 {

class Database;


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

    Database(const Napi::CallbackInfo& info);

    ~Database() {
        RemoveCallbacks();
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
};

}

#endif
