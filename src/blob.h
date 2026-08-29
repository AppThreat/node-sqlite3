#ifndef NODE_SQLITE3_SRC_BLOB_H
#define NODE_SQLITE3_SRC_BLOB_H

// Incremental BLOB I/O (Deliverable 08). A Blob wraps an sqlite3_blob*
// the way Backup wraps an sqlite3_backup*: opened through the database
// queue, then driven through its own internal call queue, each op
// incrementing db->pending and releasing it through CallGuard (the D05
// discipline — never a trailing macro that a throwing JS callback can
// skip).
//
// read()/write() pin the caller's target buffer with a Napi reference
// for the duration of the op: the backing store of a Buffer or typed
// array is stable while the object is reachable, so the worker can copy
// into/out of it directly. The values are materialised once, on the JS
// thread, before the work is queued.
//
// Any write to the row a blob handle was opened on invalidates the
// handle (SQLITE_ABORT); the error path names that cause explicitly
// instead of surfacing a bare sqlite message.
//
// Lifetime answers (the checklist items):
//  - Dispose twice: close() on a closed blob is a benign no-op (the
//    handle is NULL the second time; the callback still fires).
//  - Dispose after the database closed: CloseLiveBlobs (Work_BeginClose,
//    ~Database — main thread, pending == 0) already closed the handle
//    and untracked the wrapper; close() is the same benign no-op.
//  - Dispose after something else took its place: blob handles do not
//    share a slot — several can be open on one table at once — so this
//    hazard does not exist for them (unlike the progress handler and
//    the preupdate hook).

#include <string>
#include <queue>

#include <sqlite3.h>
#include <napi.h>

#include "database.h"

namespace node_sqlite3 {

class Blob : public Napi::ObjectWrap<Blob> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    // Cross-class argument validation, against this env's constructor —
    // see Database::HasInstanceIn.
    static inline bool HasInstance(Napi::Value val) {
        return Database::HasInstanceIn(val,
            &Database::AddonData::blob_ctor);
    }

    struct Baton {
        napi_async_work request = NULL;
        Blob* blob;
        Napi::FunctionReference callback;
        // Payload for reopen().
        sqlite3_int64 rowid = 0;

        Baton(Blob* blob_, Napi::Function cb_) : blob(blob_) {
            blob->Ref();
            callback.Reset(cb_, 1);
        }
        virtual ~Baton() {
            if (request) napi_delete_async_work(blob->Env(), request);
            blob->Unref();
            callback.Reset();
        }
    };

    struct OpenBaton : Database::Baton {
        Blob* blob;
        std::string dbName;
        std::string table;
        std::string column;
        sqlite3_int64 rowid = 0;
        bool readOnly = false;
        OpenBaton(Database* db_, Napi::Function cb_, Blob* blob_) :
                Baton(db_, cb_), blob(blob_) {
            blob->Ref();
        }
        virtual ~OpenBaton() override {
            blob->Unref();
            if (db->IsClosed()) {
                // The database handle was closed before the blob could be
                // opened.
                blob->DetachFromDatabase();
            }
        }
    };

    // read()/write(): the pinned target buffer plus the blob offset.
    struct IoBaton : Baton {
        Napi::Reference<Napi::Value> target;
        void* data = NULL; // target's base pointer (already offset)
        size_t length = 0; // bytes available from `data`
        sqlite3_int64 offset = 0; // offset within the blob
        int status = SQLITE_OK;
        std::string message;
        IoBaton(Blob* blob_, Napi::Function cb_) : Baton(blob_, cb_) {}
        virtual ~IoBaton() override = default;
    };

    typedef void (*Work_Callback)(Baton* baton);

    struct Call {
        Call(Work_Callback cb_, Baton* baton_) : callback(cb_), baton(baton_) {}
        Work_Callback callback;
        Baton* baton;
    };

    Blob(const Napi::CallbackInfo& info);

    // GC safety net for a collected blob that was never closed; runs in
    // the ObjectWrap finalizer where no JS may be fired (the queue is
    // provably empty: every queued Baton holds a Ref).
    ~Blob();

    // End-of-call bookkeeping, run on every exit path via CallGuard.
    void EndCall();
    struct CallGuard {
        Blob* blob;
        explicit CallGuard(Blob* b) : blob(b) {}
        ~CallGuard() { blob->EndCall(); }
        CallGuard(const CallGuard&) = delete;
        CallGuard& operator=(const CallGuard&) = delete;
    };

    // JS thread, nothing in flight (Work_BeginClose / ~Database) or at a
    // completion point where the handle is already gone: closes the
    // native handle, untracks from the Database and marks the wrapper
    // inert. Idempotent.
    void DetachFromDatabase(bool owner_dying = false);

protected:
    void Schedule(Work_Callback callback, Baton* baton);
    void Process();
    void CleanQueue();
    void UntrackFromDatabase();
    template <class T> static void Error(T* baton);

    static void Work_BeginOpen(Database::Baton* baton);
    static void Work_Open(napi_env env, void* data);
    static void Work_AfterOpen(napi_env env, napi_status status, void* data);

    Napi::Value Read(const Napi::CallbackInfo& info);
    static void Work_BeginRead(Baton* baton);
    static void Work_Read(napi_env env, void* data);
    static void Work_AfterRead(napi_env env, napi_status status, void* data);

    Napi::Value Write(const Napi::CallbackInfo& info);
    static void Work_BeginWrite(Baton* baton);
    static void Work_Write(napi_env env, void* data);
    static void Work_AfterWrite(napi_env env, napi_status status, void* data);

    Napi::Value Reopen(const Napi::CallbackInfo& info);
    static void Work_BeginReopen(Baton* baton);
    static void Work_Reopen(napi_env env, void* data);
    static void Work_AfterReopen(napi_env env, napi_status status, void* data);

    Napi::Value Close(const Napi::CallbackInfo& info);
    static void Work_BeginClose(Baton* baton);
    static void Work_Close(napi_env env, void* data);
    static void Work_AfterClose(napi_env env, napi_status status, void* data);

    Napi::Value SizeGetter(const Napi::CallbackInfo& info);
    Napi::Value ClosedGetter(const Napi::CallbackInfo& info);

    // Deferred close of a collected blob's native handle: runs the
    // sqlite3_blob_close through the exclusive queue when a worker could
    // be mid-round-trip holding the connection mutex (see ~Blob). The
    // baton type is local to src/blob.cc.
    static void Work_DeferredBlobClose(Database::Baton* baton);

    Database* db = NULL;
    sqlite3_blob* _handle = NULL;

    bool inited = false;
    bool locked = false;
    bool closed = false;
    int status = SQLITE_OK;
    std::string message;
    std::queue<Call*> queue;
};

} // namespace node_sqlite3

#endif
