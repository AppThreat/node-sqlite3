// Incremental BLOB I/O (Deliverable 08). See src/blob.h for the
// threading model and lifetime answers.

#include <cstring>
#include <string>

#include <sqlite3.h>
#include <napi.h>

#include "macros.h"
#include "database.h"
#include "blob.h"

using namespace node_sqlite3;

namespace {

#define BLOB_BEGIN(type)                                                       \
    assert(baton);                                                             \
    assert(baton->blob);                                                       \
    assert(!baton->blob->locked);                                              \
    assert(!baton->blob->closed);                                              \
    assert(baton->blob->inited);                                               \
    assert(baton->blob->_handle != NULL);                                      \
    baton->blob->locked = true;                                                \
    baton->blob->db->pending++;                                                \
    auto env = baton->blob->Env();                                             \
    CREATE_WORK("sqlite3.Blob." #type, Work_##type, Work_After##type);

// A view of a JS binary value with its base pointer and available byte
// count, honouring byteOffset.
struct TargetView {
    void* data = NULL;
    size_t length = 0;
};

bool GetMutableTarget(napi_env env, const Napi::Value& value,
        const std::string& what, TargetView* out) {
    if (value.IsDataView()) {
        size_t bytes = 0;
        void* data = NULL;
        napi_get_dataview_info(env, value, &bytes, &data, NULL, NULL);
        out->data = data;
        out->length = bytes;
        return true;
    }
    if (value.IsBuffer()) {
        Napi::Buffer<char> buf = value.As<Napi::Buffer<char>>();
        out->data = buf.Data();
        out->length = buf.Length();
        return true;
    }
    if (value.IsTypedArray()) {
        napi_typedarray_type type;
        size_t elements = 0;
        void* data = NULL;
        napi_get_typedarray_info(env, value, &type, &elements, &data,
            NULL, NULL);
        switch (type) {
            case napi_int8_array:
            case napi_uint8_array:
            case napi_uint8_clamped_array:
                out->data = data;
                out->length = elements;
                return true;
            default:
                Napi::TypeError::New(env, "Cannot " + what +
                    ": only byte-sized typed arrays are accepted"
                ).ThrowAsJavaScriptException();
                return false;
        }
    }
    Napi::TypeError::New(env, "Cannot " + what +
        ": a Buffer or Uint8Array is required"
    ).ThrowAsJavaScriptException();
    return false;
}

// The message accompanying SQLITE_ABORT from blob read/write: the row
// was written after the handle was opened, invalidating it.
std::string BlobAbortMessage() {
    return "the row this blob handle was opened on has been modified, "
        "so the handle is no longer valid; reopen it (openBlob/reopen) "
        "to continue";
}

// Carries a raw sqlite3_blob* whose wrapper is gone (~Blob).
struct BlobHandleBaton : Database::Baton {
    sqlite3_blob* handle;
    BlobHandleBaton(Database* db_, sqlite3_blob* handle_) :
            Baton(db_, Napi::Function()), handle(handle_) {}
    virtual ~BlobHandleBaton() override = default;
};

} // namespace

Napi::Object Blob::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);

    auto napi_default_method = static_cast<napi_property_attributes>(
        napi_writable | napi_configurable);

    auto t = DefineClass(env, "Blob", {
        InstanceMethod("read", &Blob::Read, napi_default_method),
        InstanceMethod("write", &Blob::Write, napi_default_method),
        InstanceMethod("reopen", &Blob::Reopen, napi_default_method),
        InstanceMethod("close", &Blob::Close, napi_default_method),
        InstanceAccessor("size", &Blob::SizeGetter, nullptr),
        InstanceAccessor("closed", &Blob::ClosedGetter, nullptr),
    });

    exports.Set("Blob", t);
    return exports;
}

void Blob::Process() {
    if ((closed || !inited) && !queue.empty()) {
        return CleanQueue();
    }

    while (inited && !locked && !closed && !queue.empty()) {
        auto call = std::unique_ptr<Call>(queue.front());
        queue.pop();

        call->callback(call->baton);
    }
}

void Blob::Schedule(Work_Callback callback, Baton* baton) {
    if (closed) {
        queue.emplace(new Call(callback, baton));
        CleanQueue();
    }
    else if (!inited || locked || !queue.empty()) {
        queue.emplace(new Call(callback, baton));
    }
    else {
        callback(baton);
    }
}

template <class T> void Blob::Error(T* baton) {
    auto env = baton->blob->Env();
    Napi::HandleScope scope(env);

    Blob* blob = baton->blob;
    assert(blob->status != 0);
    EXCEPTION(blob->message, blob->status, exception);

    Napi::Function cb = baton->callback.Value();

    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(blob->Value(), cb, 1, argv);
    }
    else {
        Napi::Value info[] = { Napi::String::New(env, "error"), exception };
        EMIT_EVENT(blob->Value(), 2, info);
    }
}

void Blob::CleanQueue() {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    if (queue.empty()) return;

    EXCEPTION("Blob is already closed", SQLITE_MISUSE, exception);
    Napi::Value argv[] = { exception };
    bool called = false;

    while (!queue.empty()) {
        auto call = std::unique_ptr<Call>(queue.front());
        queue.pop();

        std::unique_ptr<Baton> baton(call->baton);
        Napi::Function cb = baton->callback.Value();
        if (IS_FUNCTION(cb)) {
            TRY_CATCH_CALL(Value(), cb, 1, argv);
            called = true;
        }
    }

    if (!called) {
        Napi::Value info[] = { Napi::String::New(env, "error"), exception };
        EMIT_EVENT(Value(), 2, info);
    }
}

// { Database db, String dbName, String table, String column,
//   Number rowid, Boolean readOnly, [Function callback] }
Blob::Blob(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Blob>(info) {
    auto env = info.Env();
    if (!info.IsConstructCall()) {
        Napi::TypeError::New(env, "Use the new operator to create new Blob objects").ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() <= 0 || !Database::HasInstance(info[0])) {
        Napi::TypeError::New(env, "Database object expected").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() <= 1 || !info[1].IsString()
            || info.Length() <= 2 || !info[2].IsString()
            || info.Length() <= 3 || !info[3].IsString()) {
        Napi::TypeError::New(env, "Database, table and column names expected").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() <= 4 || !info[4].IsNumber()) {
        Napi::TypeError::New(env, "Rowid expected").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() <= 5 || !info[5].IsBoolean()) {
        Napi::TypeError::New(env, "Read-only flag expected").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() > 6 && !info[6].IsUndefined() && !info[6].IsFunction()) {
        Napi::TypeError::New(env, "Callback expected").ThrowAsJavaScriptException();
        return;
    }

    this->db = Napi::ObjectWrap<Database>::Unwrap(info[0].As<Napi::Object>());
    this->db->Ref();

    auto dbName = info[1].As<Napi::String>().Utf8Value();
    auto table = info[2].As<Napi::String>().Utf8Value();
    auto column = info[3].As<Napi::String>().Utf8Value();
    sqlite3_int64 rowid = info[4].As<Napi::Number>().Int64Value();
    bool readOnly = info[5].As<Napi::Boolean>().Value();

    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("db", info[1]));
    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("table", info[2]));
    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("column", info[3]));
    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("rowid", info[4]));
    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("readOnly", info[5]));

    // Tracked from construction so CloseLiveBlobs cannot miss a blob
    // whose open is still queued or in flight.
    this->db->live_blobs.push_back(this);

    auto* baton = new OpenBaton(this->db, info[6].As<Napi::Function>(), this);
    baton->dbName = dbName;
    baton->table = table;
    baton->column = column;
    baton->rowid = rowid;
    baton->readOnly = readOnly;

    this->db->Schedule(Work_BeginOpen, baton);
}

void Blob::Work_BeginOpen(Database::Baton* baton) {
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Blob.Open", Work_Open, Work_AfterOpen);
}

void Blob::Work_Open(napi_env e, void* data) {
    auto* baton = static_cast<OpenBaton*>(data);
    Blob* blob = baton->blob;

    // sqlite3_blob_open takes the connection mutex internally (and a
    // read/write lock on the row); running here on the worker pool is
    // what serializes it against other work.
    blob->_handle = NULL;
    int rc = sqlite3_blob_open(baton->db->_handle,
        baton->dbName.c_str(), baton->table.c_str(),
        baton->column.c_str(), baton->rowid,
        baton->readOnly ? 0 : 1, &blob->_handle);
    blob->status = rc;
    if (rc != SQLITE_OK) {
        blob->message = std::string(sqlite3_errmsg(baton->db->_handle));
    }
}

void Blob::Work_AfterOpen(napi_env e, napi_status status, void* data) {
    std::unique_ptr<OpenBaton> baton(static_cast<OpenBaton*>(data));
    auto* blob = baton->blob;
    auto* db = baton->db;

    auto env = blob->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    db->Process();

    if (blob->status != SQLITE_OK) {
        blob->DetachFromDatabase();
        Error(baton.get());
    }
    else {
        blob->inited = true;
        Napi::Function cb = baton->callback.Value();
        if (IS_FUNCTION(cb)) {
            Napi::Value argv[] = { env.Null() };
            TRY_CATCH_CALL(blob->Value(), cb, 1, argv);
        }
    }

    blob->Process();
}

void Blob::EndCall() {
    assert(locked);
    assert(db->pending);
    locked = false;
    db->pending--;
    Process();
    db->Process();
}

Blob::~Blob() {
    // GC safety net, mirroring ~Statement: every queued Baton holds a Ref
    // on the blob, so the queue is provably empty and CleanQueue cannot
    // fire JS from this finalizer. sqlite3_blob_close takes the
    // connection mutex internally; defer through the exclusive queue when
    // a worker could be mid-round-trip holding that mutex while waiting
    // for this very thread.
    CleanQueue();
    if (_handle != NULL) {
        if (db != NULL && db->MayBlockOnWorkerRoundTrip()) {
            db->Schedule(Work_DeferredBlobClose,
                new BlobHandleBaton(db, _handle), true);
            _handle = NULL;
        }
        else {
            sqlite3_blob_close(_handle);
            _handle = NULL;
        }
    }
    // Detached blobs have already released the database (and nulled the
    // pointer); this covers the never-detached case only.
    if (db != NULL) {
        UntrackFromDatabase();
        db->Unref();
    }
}

void Blob::Work_DeferredBlobClose(Database::Baton* b) {
    auto baton = std::unique_ptr<BlobHandleBaton>(
        static_cast<BlobHandleBaton*>(b));
    auto* db = baton->db;

    sqlite3_blob_close(baton->handle);

    db->exclusiveHeld = false;
    db->Process();
}

void Blob::UntrackFromDatabase() {
    if (db == NULL) return;
    auto& v = db->live_blobs;
    for (auto it = v.begin(); it != v.end(); ++it) {
        if (*it == this) {
            v.erase(it);
            return;
        }
    }
}

// JS thread, nothing in flight (Work_BeginClose / ~Database) or at a
// completion point where the handle is already gone. Idempotent.
// Severs the link to the Database, and is the single place the blob's
// reference on it is released. Nulling `db` is the point: at environment
// teardown napi finalizes wrappers in an unspecified order, so ~Blob can
// run after ~Database, and a back-pointer left dangling there means
// UntrackFromDatabase walks a destroyed std::vector. (That is a
// segfault, not a stale read — it was reproducible on musl.)
//
// owner_dying is set when ~Database is the caller: the Database is
// already being destroyed, so its refcount is moot and calling Unref on
// a half-destroyed wrapper is exactly the dereference being avoided.
void Blob::DetachFromDatabase(bool owner_dying) {
    if (db == NULL) return;
    if (_handle != NULL) {
        sqlite3_blob_close(_handle);
        _handle = NULL;
    }
    UntrackFromDatabase();
    closed = true;
    if (owner_dying) {
        // ~Database is running. napi finalizes wrappers in an
        // unspecified order at environment teardown, so ~Blob can run
        // afterwards — and UntrackFromDatabase would then walk a
        // destroyed std::vector, which faults rather than reading stale
        // data (reproducible on musl). Drop the back-pointer so the
        // destructor skips it. The reference is deliberately not
        // released: the Database is already being destroyed, and
        // Unref'ing a half-destroyed wrapper is the same dereference.
        //
        // Only on this path: the ordinary close still needs `db` for
        // the in-flight bookkeeping that runs after this returns
        // (Work_AfterClose's CallGuard decrements db->pending).
        db = NULL;
    }
}

void Database::CloseLiveBlobs(bool owner_dying) {
    // Main thread, nothing in flight (Work_BeginClose / ~Database).
    std::vector<Blob*> blobs = live_blobs;
    live_blobs.clear();
    for (Blob* blob : blobs) {
        blob->DetachFromDatabase(owner_dying);
    }
}

// --- read ---------------------------------------------------------------------

// read(target[, offset[, callback]]): copies target.length bytes of the
// blob, starting at `offset` within the blob, into the target. The
// callback may sit in the offset's slot (the promise layer appends it
// there when no offset was given), so each slot accepts either its own
// type or the trailing function.
Napi::Value Blob::Read(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Blob* blob = this;

    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected at least 1 argument").ThrowAsJavaScriptException();
        return env.Null();
    }
    TargetView target;
    if (!GetMutableTarget(env, info[0], "read into a blob target", &target)) {
        return env.Null();
    }

    sqlite3_int64 offset = 0;
    Napi::Function callback;
    if (info.Length() > 1 && info[1].IsNumber()) {
        offset = info[1].As<Napi::Number>().Int64Value();
        if (offset < 0) {
            Napi::RangeError::New(env, "blob offset must be a non-negative integer").ThrowAsJavaScriptException();
            return env.Null();
        }
        if (info.Length() > 2 && !info[2].IsUndefined()) {
            if (!info[2].IsFunction()) {
                Napi::TypeError::New(env, "Argument 2 must be a function").ThrowAsJavaScriptException();
                return env.Null();
            }
            callback = info[2].As<Napi::Function>();
        }
    }
    else if (info.Length() > 1 && info[1].IsFunction()) {
        callback = info[1].As<Napi::Function>();
    }
    else if (info.Length() > 1 && !info[1].IsUndefined()) {
        Napi::TypeError::New(env, "blob offset must be a non-negative integer").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* baton = new IoBaton(blob, callback);
    baton->target = Napi::Persistent(info[0]);
    baton->data = target.data;
    baton->length = target.length;
    baton->offset = offset;
    blob->Schedule(Work_BeginRead, baton);

    return info.This();
}

void Blob::Work_BeginRead(Baton* baton) {
    BLOB_BEGIN(Read);
}

void Blob::Work_Read(napi_env e, void* data) {
    auto* baton = static_cast<IoBaton*>(data);
    Blob* blob = baton->blob;

    int rc = sqlite3_blob_read(blob->_handle, baton->data,
        static_cast<int>(baton->length), static_cast<int>(baton->offset));
    blob->status = rc;
    if (rc == SQLITE_ABORT) {
        blob->message = BlobAbortMessage();
    }
    else if (rc != SQLITE_OK) {
        blob->message = std::string(sqlite3_errmsg(blob->db->_handle));
    }
}

void Blob::Work_AfterRead(napi_env e, napi_status status, void* data) {
    std::unique_ptr<IoBaton> baton(static_cast<IoBaton*>(data));
    auto* blob = baton->blob;

    auto env = blob->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    Blob::CallGuard blob_call_guard__(blob);

    if (blob->status != SQLITE_OK) {
        Error(baton.get());
        return;
    }

    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        // The number of bytes actually copied is the full target length:
        // sqlite3_blob_read fails (rather than short-reading) when
        // offset+length exceeds the blob size.
        Napi::Value argv[] = { env.Null(),
            Napi::Number::New(env, baton->length) };
        TRY_CATCH_CALL(blob->Value(), cb, 2, argv);
    }
}

// --- write --------------------------------------------------------------------

// write(source[, offset[, callback]]): copies source.length bytes into
// the blob starting at `offset` within the blob. The callback may sit in
// the offset's slot; see Read.
Napi::Value Blob::Write(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Blob* blob = this;

    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected at least 1 argument").ThrowAsJavaScriptException();
        return env.Null();
    }
    TargetView target;
    if (!GetMutableTarget(env, info[0], "write from a blob source", &target)) {
        return env.Null();
    }

    sqlite3_int64 offset = 0;
    Napi::Function callback;
    if (info.Length() > 1 && info[1].IsNumber()) {
        offset = info[1].As<Napi::Number>().Int64Value();
        if (offset < 0) {
            Napi::RangeError::New(env, "blob offset must be a non-negative integer").ThrowAsJavaScriptException();
            return env.Null();
        }
        if (info.Length() > 2 && !info[2].IsUndefined()) {
            if (!info[2].IsFunction()) {
                Napi::TypeError::New(env, "Argument 2 must be a function").ThrowAsJavaScriptException();
                return env.Null();
            }
            callback = info[2].As<Napi::Function>();
        }
    }
    else if (info.Length() > 1 && info[1].IsFunction()) {
        callback = info[1].As<Napi::Function>();
    }
    else if (info.Length() > 1 && !info[1].IsUndefined()) {
        Napi::TypeError::New(env, "blob offset must be a non-negative integer").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* baton = new IoBaton(blob, callback);
    baton->target = Napi::Persistent(info[0]);
    baton->data = target.data;
    baton->length = target.length;
    baton->offset = offset;
    blob->Schedule(Work_BeginWrite, baton);

    return info.This();
}

void Blob::Work_BeginWrite(Baton* baton) {
    BLOB_BEGIN(Write);
}

void Blob::Work_Write(napi_env e, void* data) {
    auto* baton = static_cast<IoBaton*>(data);
    Blob* blob = baton->blob;

    int rc = sqlite3_blob_write(blob->_handle, baton->data,
        static_cast<int>(baton->length), static_cast<int>(baton->offset));
    blob->status = rc;
    if (rc == SQLITE_ABORT) {
        blob->message = BlobAbortMessage();
    }
    else if (rc != SQLITE_OK) {
        blob->message = std::string(sqlite3_errmsg(blob->db->_handle));
    }
}

void Blob::Work_AfterWrite(napi_env e, napi_status status, void* data) {
    std::unique_ptr<IoBaton> baton(static_cast<IoBaton*>(data));
    auto* blob = baton->blob;

    auto env = blob->Env();
    Napi::HandleScope scope(env);

    Blob::CallGuard blob_call_guard__(blob);

    if (blob->status != SQLITE_OK) {
        Error(baton.get());
        return;
    }

    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { env.Null(),
            Napi::Number::New(env, baton->length) };
        TRY_CATCH_CALL(blob->Value(), cb, 2, argv);
    }
}

// --- reopen --------------------------------------------------------------------

Napi::Value Blob::Reopen(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Blob* blob = this;

    REQUIRE_ARGUMENT_INTEGER(0, rowid);
    OPTIONAL_ARGUMENT_FUNCTION(1, callback);

    auto* baton = new Baton(blob, callback);
    baton->rowid = rowid;
    blob->Schedule(Work_BeginReopen, baton);

    return info.This();
}

void Blob::Work_BeginReopen(Baton* baton) {
    BLOB_BEGIN(Reopen);
}

void Blob::Work_Reopen(napi_env e, void* data) {
    auto* baton = static_cast<Baton*>(data);
    Blob* blob = baton->blob;

    int rc = sqlite3_blob_reopen(blob->_handle, baton->rowid);
    blob->status = rc;
    if (rc != SQLITE_OK) {
        blob->message = std::string(sqlite3_errmsg(blob->db->_handle));
    }
}

void Blob::Work_AfterReopen(napi_env e, napi_status status, void* data) {
    std::unique_ptr<Baton> baton(static_cast<Baton*>(data));
    auto* blob = baton->blob;

    auto env = blob->Env();
    Napi::HandleScope scope(env);

    Blob::CallGuard blob_call_guard__(blob);

    if (blob->status != SQLITE_OK) {
        Error(baton.get());
        return;
    }

    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { env.Null() };
        TRY_CATCH_CALL(blob->Value(), cb, 1, argv);
    }
}

// --- close ----------------------------------------------------------------------

Napi::Value Blob::Close(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Blob* blob = this;

    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    if (blob->closed) {
        // Dispose contract: a second close is a benign no-op, and one
        // after the database closed finds the handle already gone.
        if (IS_FUNCTION(callback)) {
            Napi::Value argv[] = { env.Null() };
            TRY_CATCH_CALL(blob->Value(), callback, 1, argv, info.This());
        }
        return info.This();
    }

    auto* baton = new Baton(blob, callback);
    blob->Schedule(Work_BeginClose, baton);

    return info.This();
}

void Blob::Work_BeginClose(Baton* baton) {
    BLOB_BEGIN(Close);
}

void Blob::Work_Close(napi_env e, void* data) {
    auto* baton = static_cast<Baton*>(data);
    Blob* blob = baton->blob;

    sqlite3_blob_close(blob->_handle);
    blob->_handle = NULL;
}

void Blob::Work_AfterClose(napi_env e, napi_status status, void* data) {
    std::unique_ptr<Baton> baton(static_cast<Baton*>(data));
    auto* blob = baton->blob;

    auto env = blob->Env();
    Napi::HandleScope scope(env);

    Blob::CallGuard blob_call_guard__(blob);

    blob->DetachFromDatabase();

    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { env.Null() };
        TRY_CATCH_CALL(blob->Value(), cb, 1, argv);
    }
}

// --- accessors -------------------------------------------------------------------

Napi::Value Blob::SizeGetter(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Blob* blob = this;

    // read()/write() queue behind the open, but a synchronous getter
    // cannot; say which of the two states the caller is actually in,
    // because "not open" reads as "closed" when it usually means "not
    // open yet".
    // Order matters: _handle is NULL before the open completes as well as
    // after a close, so the not-yet-open case has to be tested first.
    if (!blob->inited && !blob->closed) {
        Napi::Error::New(env,
            "blob.size is not available until the handle has finished "
            "opening; read it from the openBlob() callback, or after an "
            "awaited read/write (those queue behind the open)"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    if (blob->closed || blob->_handle == NULL) {
        Napi::Error::New(env, "Blob is already closed")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    if (blob->locked) {
        // An op is in flight on this handle; reading the size now could
        // observe a torn state.
        Napi::Error::New(env,
            "cannot read blob.size while an operation on this blob is "
            "in flight; read it from a callback or after the operation"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    // The handle's own queue is idle (locked == false). Same gate as the
    // other main-thread sqlite reads: refuse while a worker could be
    // blocked mid-round-trip on this thread holding the connection mutex.
    if (blob->db->MayBlockOnWorkerRoundTrip()) {
        Napi::Error::New(env,
            "cannot read blob.size while a JavaScript function, "
            "collation or progress callback is mid-call on this "
            "connection; read it from a callback or after the query"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    return Napi::Number::New(env,
        static_cast<double>(sqlite3_blob_bytes(blob->_handle)));
}

Napi::Value Blob::ClosedGetter(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), closed);
}
