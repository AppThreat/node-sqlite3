#ifndef NODE_SQLITE3_SRC_SESSION_H
#define NODE_SQLITE3_SRC_SESSION_H

// Sessions, changesets and serialize/deserialize (Deliverable 08).
//
// Threading model:
//
//  - Session creation is scheduled exclusively and dispatched on the JS
//    thread at pending == 0 (the preupdate-slot ownership check below is
//    ordered against 'preupdate' listener registration that way); the
//    actual sqlite3session_create/attach pair runs on a libuv worker
//    under the connection mutex — never on the JS thread, so no
//    MayBlockOnWorkerRoundTrip deferral is needed for it.
//  - changeset()/patchset() run on a worker holding the connection mutex
//    (the session's hash tables are mutated by the preupdate hook inside
//    concurrent writes, which hold the same mutex).
//  - close() runs sqlite3session_delete on a worker; it takes the
//    connection mutex internally to unlink from the hook's session list.
//
// The preupdate-hook slot (one per connection) is shared between the
// session module and the 'preupdate' event: sqlite3session_create
// installs the session extension's own hook, displacing whatever was
// there. Registering both would silently stop whichever lost the slot —
// the D07 cancellation-token wedge shape — so ownership is exclusive and
// enforced loudly in both directions, each on the JS thread at
// pending == 0: creating a session while a 'preupdate' listener is
// installed throws, and registering the listener while a session is
// tracked fails the configure() with an 'error' event. Sessions are
// tracked on the Database from construction (before the handle exists)
// so the check cannot miss one still being created.

#include <string>
#include <queue>
#include <vector>

#include <sqlite3.h>
#include <napi.h>
#include <uv.h>

#include "convert.h"
#include "database.h"

namespace node_sqlite3 {

// One queued 'preupdate' event (Deliverable 08). The row values are
// materialised eagerly inside the sqlite hook on the writing thread —
// sqlite3_preupdate_old/new are only valid there — and converted to JS
// on the loop thread from these Cells.
struct PreupdateInfo {
    int op = 0;                 // SQLITE_INSERT / UPDATE / DELETE
    std::string database;
    std::string table;
    sqlite3_int64 key1 = 0;     // rowid being inserted/deleted/updated
    sqlite3_int64 key2 = 0;     // new rowid for a rowid-changing UPDATE
    Row old_row;                // op != INSERT
    Row new_row;                // op != DELETE
};

class Session : public Napi::ObjectWrap<Session> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    // Cross-class argument validation, against this env's constructor —
    // see Database::HasInstanceIn.
    static inline bool HasInstance(Napi::Value val) {
        return Database::HasInstanceIn(val,
            &Database::AddonData::session_ctor);
    }

    struct Baton {
        napi_async_work request = NULL;
        Session* session;
        Napi::FunctionReference callback;

        Baton(Session* session_, Napi::Function cb_) : session(session_) {
            session->Ref();
            callback.Reset(cb_, 1);
        }
        virtual ~Baton() {
            if (request) napi_delete_async_work(session->Env(), request);
            session->Unref();
            callback.Reset();
        }
    };

    struct CreateBaton : Database::Baton {
        Session* session;
        std::string dbName;
        std::string table; // "" attaches every table
        bool indirect = false;
        CreateBaton(Database* db_, Napi::Function cb_, Session* session_) :
                Baton(db_, cb_), session(session_) {
            session->Ref();
        }
        virtual ~CreateBaton() override {
            session->Unref();
            if (db->IsClosed()) {
                // The database handle was closed before the session could
                // be created.
                session->DetachFromDatabase();
            }
        }
    };

    // changeset()/patchset(): the worker fills data (sqlite3_malloc'd);
    // Work_After* moves it into the Uint8Array handed to JS.
    struct BufferBaton : Baton {
        bool patch = false;
        int n = 0;
        void* data = NULL;
        BufferBaton(Session* session_, Napi::Function cb_) :
                Baton(session_, cb_) {}
        virtual ~BufferBaton() override {
            if (data != NULL) sqlite3_free(data);
        }
    };

    typedef void (*Work_Callback)(Baton* baton);

    struct Call {
        Call(Work_Callback cb_, Baton* baton_) : callback(cb_), baton(baton_) {}
        Work_Callback callback;
        Baton* baton;
    };

    Session(const Napi::CallbackInfo& info);

    // GC safety net for a collected session that was never closed; runs
    // in the ObjectWrap finalizer where no JS may be fired (the queue is
    // provably empty: every queued Baton holds a Ref).
    ~Session();

    // End-of-call bookkeeping, run on every exit path via CallGuard.
    void EndCall();
    struct CallGuard {
        Session* session;
        explicit CallGuard(Session* s) : session(s) {}
        ~CallGuard() { session->EndCall(); }
        CallGuard(const CallGuard&) = delete;
        CallGuard& operator=(const CallGuard&) = delete;
    };

    // JS thread, nothing in flight (Work_BeginClose / ~Database) or at a
    // completion point where the handle is already gone: deletes the
    // native handle, untracks from the Database and marks the wrapper
    // inert. Idempotent.
    void DetachFromDatabase(bool owner_dying = false);

protected:
    void Schedule(Work_Callback callback, Baton* baton);
    void Process();
    void CleanQueue();
    void UntrackFromDatabase();
    template <class T> static void Error(T* baton);

    static void Work_BeginCreate(Database::Baton* baton);
    static void Work_Create(napi_env env, void* data);
    static void Work_AfterCreate(napi_env env, napi_status status, void* data);

    Napi::Value Changeset(const Napi::CallbackInfo& info);
    Napi::Value Patchset(const Napi::CallbackInfo& info);
    static void Work_BeginChangeset(Baton* baton);
    static void Work_Changeset(napi_env env, void* data);
    static void Work_AfterChangeset(napi_env env, napi_status status, void* data);

    Napi::Value Close(const Napi::CallbackInfo& info);
    static void Work_BeginClose(Baton* baton);
    static void Work_Close(napi_env env, void* data);
    static void Work_AfterClose(napi_env env, napi_status status, void* data);

    Napi::Value ClosedGetter(const Napi::CallbackInfo& info);

    Database* db = NULL;
    sqlite3_session* _handle = NULL;

    bool inited = false;
    bool locked = false;
    bool closed = false;
    int status = SQLITE_OK;
    std::string message;
    std::queue<Call*> queue;
};

// Carries a raw sqlite3_session* whose wrapper is gone: the GC safety
// net hands the delete to the exclusive queue when a worker could be
// mid-round-trip holding the connection mutex (see ~Session).
struct SessionHandleBaton : Database::Baton {
    sqlite3_session* handle;
    SessionHandleBaton(Database* db_, sqlite3_session* handle_) :
            Baton(db_, Napi::Function()), handle(handle_) {}
    virtual ~SessionHandleBaton() override = default;
};

// Synchronous changeset iterator over a private copy of the bytes.
// sqlite3changeset_* here involve no database connection, so this is
// pure CPU on the JS thread — safe to drive with for..of.
class ChangesetIter : public Napi::ObjectWrap<ChangesetIter> {
public:
    // Builds and caches the class constructor. The class itself is not
    // part of the public surface; iterateChangeset() hands out
    // instances, typed in lib/native.d.ts as an iterable.
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    ChangesetIter(const Napi::CallbackInfo& info);
    ~ChangesetIter() {
        if (_iter != NULL) sqlite3changeset_finalize(_iter);
    }

protected:
    Napi::Value Next(const Napi::CallbackInfo& info);

    sqlite3_changeset_iter* _iter = NULL;
    std::string bytes; // owns the copy the iterator walks
};

// Module-level changeset helpers, registered in src/node_sqlite3.cc.
// Pure functions over memory — no connection, no mutex, no worker.
Napi::Value InvertChangeset(const Napi::CallbackInfo& info);
Napi::Value ConcatChangeset(const Napi::CallbackInfo& info);
Napi::Value IterateChangeset(const Napi::CallbackInfo& info);

} // namespace node_sqlite3

#endif
