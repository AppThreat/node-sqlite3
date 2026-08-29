// Sessions, changesets and serialize/deserialize (Deliverable 08).
// See src/session.h for the threading model and the preupdate-slot
// ownership story.

#include <cstring>
#include <string>
#include <vector>

#include <sqlite3.h>
#include <napi.h>
#include <uv.h>

#include "macros.h"
#include "convert.h"
#include "database.h"
#include "session.h"

using namespace node_sqlite3;

namespace node_sqlite3 {

// Free functions that need Database's protected state (the apply round
// trips read the integer mode and interrupt the handle), mirroring
// UserFunctionOps in src/function.cc: one auditable friendship grant.
struct SessionOps {
    static int IntegerMode(Database* db) { return db->integer_mode; }
    static sqlite3* Handle(Database* db) { return db->_handle; }
};

} // namespace node_sqlite3

namespace {

#define SESSION_BEGIN(type)                                                    \
    assert(baton);                                                             \
    assert(baton->session);                                                    \
    assert(!baton->session->locked);                                           \
    assert(!baton->session->closed);                                           \
    assert(baton->session->inited);                                            \
    assert(baton->session->_handle != NULL);                                   \
    baton->session->locked = true;                                             \
    baton->session->db->pending++;                                             \
    auto env = baton->session->Env();                                          \
    CREATE_WORK("sqlite3.Session." #type, Work_##type, Work_After##type);

// A view of a JS binary value (Buffer, typed array, DataView or
// ArrayBuffer), already offset by byteOffset. Valid only while the JS
// value stays reachable — callers copy immediately.
struct BytesView {
    const void* data = NULL;
    size_t length = 0;
};

bool GetBytesView(napi_env env, const Napi::Value& value,
        const std::string& what, BytesView* out) {
    // DataView first: napi's IsBuffer also answers true for DataViews,
    // and routing one through Napi::Buffer fails.
    if (value.IsDataView()) {
        size_t bytes = 0;
        void* data = NULL;
        napi_get_dataview_info(env, value, &bytes, &data, NULL, NULL);
        out->data = data;
        out->length = bytes;
        return true;
    }
    if (value.IsBuffer()) {
        // Node Buffers and plain Uint8Arrays.
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
    if (value.IsArrayBuffer()) {
        Napi::ArrayBuffer ab = value.As<Napi::ArrayBuffer>();
        out->data = ab.Data();
        out->length = ab.ByteLength();
        return true;
    }
    Napi::TypeError::New(env, "Cannot " + what +
        ": a Buffer, Uint8Array or ArrayBuffer is required"
    ).ThrowAsJavaScriptException();
    return false;
}

// Wraps sqlite3_malloc'd bytes in a Uint8Array over an external
// ArrayBuffer whose finalizer calls sqlite3_free — the modern-type
// sibling of the zero-copy Buffer path in CellToJS (src/convert.cc).
// Falls back to a copy when external buffers are unavailable (e.g.
// sandboxed renderers). Takes ownership of `data` on every path.
Napi::Value WrapOwnedBytes(Napi::Env env, void* data, size_t length) {
    napi_value ab = NULL;
    napi_status st = napi_create_external_arraybuffer(env, data, length,
        [](napi_env, void* external_data, void*) {
            sqlite3_free(external_data);
        },
        NULL, &ab);
    if (st == napi_ok) {
        return Napi::Uint8Array::New(env, length,
            Napi::ArrayBuffer(env, ab), 0);
    }
    Napi::ArrayBuffer copy = Napi::ArrayBuffer::New(env, length);
    if (length > 0 && data != NULL) {
        memcpy(copy.Data(), data, length);
    }
    sqlite3_free(data);
    return Napi::Uint8Array::New(env, length, copy, 0);
}

// Runs one full iteration pass over a changeset buffer to prove it is
// parseable before handing it to sqlite3changeset_invert/concat, whose
// documented contract assumes a valid input ("the results are
// undefined" otherwise).
int ValidateChangeset(int n, const void* data) {
    sqlite3_changeset_iter* iter = NULL;
    int rc = sqlite3changeset_start(&iter, n, const_cast<void*>(data));
    if (rc != SQLITE_OK) return rc;
    while ((rc = sqlite3changeset_next(iter)) == SQLITE_ROW) {
    }
    if (rc == SQLITE_DONE) rc = SQLITE_OK;
    sqlite3changeset_finalize(iter);
    return rc;
}

const char* ChangesetOpString(int op) {
    return sqlite_authorizer_string(op); // insert / update / delete
}

const char* ChangesetConflictString(int e_conflict) {
    switch (e_conflict) {
        case SQLITE_CHANGESET_DATA:        return "data";
        case SQLITE_CHANGESET_NOTFOUND:    return "notFound";
        case SQLITE_CHANGESET_CONFLICT:    return "conflict";
        case SQLITE_CHANGESET_CONSTRAINT:  return "constraint";
        case SQLITE_CHANGESET_FOREIGN_KEY: return "foreignKey";
        default:                           return "unknown";
    }
}

Napi::Value CellsToArray(Napi::Env env, std::vector<Cell>& cells,
        int integer_mode, const std::string& what) {
    Napi::Array out = Napi::Array::New(env, cells.size());
    for (size_t i = 0; i < cells.size(); i++) {
        out.Set(i, CellToJS(env, cells[i], integer_mode, what));
        if (env.IsExceptionPending()) return env.Null();
    }
    return out;
}

// --- Changeset apply round trips --------------------------------------------
//
// sqlite3changeset_apply holds the connection mutex for its whole run
// and invokes xFilter/xConflict inside it. The JS handler forms
// therefore block the applying worker on the JS thread exactly like a
// user-defined function — with one difference the Database accounts for
// through js_apply_depth: the mutex is held for the entire apply, not
// just the callback, so every main-thread sqlite call on this
// connection must defer while one is in flight.

struct ApplyBaton;

// One xFilter or xConflict invocation. Everything the JS side reads is
// materialised BEFORE the round trip (the iterator's sqlite3_value
// pointers die with the callback); the answer is written back by the JS
// thread under the condition variable.
struct ApplyRoundTrip {
    bool is_filter = false;

    int op = 0;
    int conflict = 0;
    int n_col = 0;
    std::string table;
    std::vector<char> pk;           // 1 where the column is a primary key
    std::vector<Cell> conflict_row; // DATA / CONFLICT conflicts only
    std::vector<Cell> old_row;      // UPDATE / DELETE changes only
    std::vector<Cell> new_row;      // INSERT / UPDATE changes only

    int answer = 0;
    bool errored = false;
    std::string error;

    uv_mutex_t mutex;
    uv_cond_t cond;
    bool done = false;

    void Init() {
        uv_mutex_init(&mutex);
        uv_cond_init(&cond);
    }
    void Destroy() {
        uv_mutex_destroy(&mutex);
        uv_cond_destroy(&cond);
    }
};

struct ApplyBaton : Database::Baton {
    int n = 0;
    void* data = NULL; // private copy of the changeset bytes
    int decision = SQLITE_CHANGESET_ABORT;
    Napi::FunctionReference on_conflict;
    Napi::FunctionReference on_filter;
    napi_threadsafe_function tsfn = NULL;
    ApplyRoundTrip rt;

    int status = SQLITE_OK;
    std::string message;

    ApplyBaton(Database* db_, Napi::Function cb_) : Baton(db_, cb_) {
        rt.Init();
    }
    virtual ~ApplyBaton() override {
        if (data != NULL) sqlite3_free(data);
        // The tsfn is released in Work_AfterApplyChangeset. If that never
        // ran (environment teardown) there is no sound place to release
        // it from; teardown reclaims it.
        rt.Destroy();
    }
};

// Extracts an error message from a thrown JS value, leaving no pending
// exception behind (a hostile message getter can throw; anything pending
// after the reads is cleared and ignored).
std::string ApplyJsErrorMessage(Napi::Env env) {
    napi_value pending = NULL;
    napi_get_and_clear_last_exception(env, &pending);
    if (pending == NULL) return "unknown error";
    Napi::Value err(env, pending);
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

// The tsfn call-js callback: runs the user's filter or conflict handler
// with the pre-materialised values and records the answer. No exception
// may escape into the tsfn dispatch machinery.
void ApplyCallJs(napi_env nenv, napi_value /*js_callback*/, void* /*context*/,
        void* data) {
    auto* baton = static_cast<ApplyBaton*>(data);
    Napi::Env env(nenv);
    Napi::HandleScope scope(env);
    ApplyRoundTrip& rt = baton->rt;

    Napi::Function fn = rt.is_filter
        ? baton->on_filter.Value() : baton->on_conflict.Value();
    if (rt.is_filter) {
        Napi::Value answer = fn.Call({ Napi::String::New(env, rt.table) });
        if (env.IsExceptionPending()) {
            rt.errored = true;
            rt.error = "changeset filter threw: " +
                ApplyJsErrorMessage(env);
        }
        else {
            rt.answer = answer.ToBoolean().Value() ? 1 : 0;
        }
    }
    else {
        Napi::Object info = Napi::Object::New(env);
        info.Set("op", Napi::String::New(env, ChangesetOpString(rt.op)));
        info.Set("table", Napi::String::New(env, rt.table.c_str()));
        info.Set("conflict",
            Napi::String::New(env, ChangesetConflictString(rt.conflict)));
        info.Set("columnCount", Napi::Number::New(env, rt.n_col));
        Napi::Array pk = Napi::Array::New(env, rt.pk.size());
        for (size_t i = 0; i < rt.pk.size(); i++) {
            pk.Set(i, Napi::Boolean::New(env, rt.pk[i] != 0));
        }
        info.Set("primaryKey", pk);
        const int integer_mode = SessionOps::IntegerMode(baton->db);
        if (!rt.conflict_row.empty()) {
            info.Set("conflictRow",
                CellsToArray(env, rt.conflict_row, integer_mode,
                    "a conflicting row value"));
        }
        if (!rt.old_row.empty()) {
            info.Set("oldRow", CellsToArray(env, rt.old_row, integer_mode,
                "an old row value"));
        }
        if (!rt.new_row.empty()) {
            info.Set("newRow", CellsToArray(env, rt.new_row, integer_mode,
                "a new row value"));
        }
        if (env.IsExceptionPending()) {
            rt.errored = true;
            rt.error = ApplyJsErrorMessage(env);
        }
        else {
            Napi::Value answer = fn.Call({ info });
            if (env.IsExceptionPending()) {
                rt.errored = true;
                rt.error = "changeset conflict handler threw: " +
                    ApplyJsErrorMessage(env);
            }
            else if (answer.IsNumber()) {
                int64_t v = answer.As<Napi::Number>().Int64Value();
                if (v == SQLITE_CHANGESET_OMIT
                        || v == SQLITE_CHANGESET_REPLACE
                        || v == SQLITE_CHANGESET_ABORT) {
                    rt.answer = static_cast<int>(v);
                }
                else {
                    rt.errored = true;
                    rt.error = "changeset conflict handler returned an "
                        "unknown decision; use CHANGESET_OMIT, "
                        "CHANGESET_REPLACE or CHANGESET_ABORT";
                }
            }
            else if (answer.IsString()) {
                std::string s = answer.As<Napi::String>().Utf8Value();
                if (s == "omit") rt.answer = SQLITE_CHANGESET_OMIT;
                else if (s == "replace") rt.answer = SQLITE_CHANGESET_REPLACE;
                else if (s == "abort") rt.answer = SQLITE_CHANGESET_ABORT;
                else {
                    rt.errored = true;
                    rt.error = "changeset conflict handler returned '" +
                        s + "'; use 'omit', 'replace' or 'abort'";
                }
            }
            else {
                rt.errored = true;
                rt.error = "changeset conflict handler must return "
                    "'omit', 'replace', 'abort' or a CHANGESET_* constant";
            }
        }
    }

    uv_mutex_lock(&rt.mutex);
    rt.done = true;
    uv_cond_signal(&rt.cond);
    uv_mutex_unlock(&rt.mutex);
}

bool ApplyRoundTripRun(ApplyBaton* baton) {
    napi_status st = napi_call_threadsafe_function(baton->tsfn, baton,
        napi_tsfn_blocking);
    if (st != napi_ok) {
        baton->rt.errored = true;
        baton->rt.error = "the JavaScript environment is shutting down; "
            "the changeset apply cannot continue";
        return false;
    }
    ApplyRoundTrip& rt = baton->rt;
    uv_mutex_lock(&rt.mutex);
    while (!rt.done) uv_cond_wait(&rt.cond, &rt.mutex);
    uv_mutex_unlock(&rt.mutex);
    return true;
}

void ApplyMaterialiseRows(ApplyRoundTrip& rt,
        sqlite3_changeset_iter* iter) {
    rt.conflict_row.clear();
    rt.old_row.clear();
    rt.new_row.clear();
    if (rt.conflict == SQLITE_CHANGESET_DATA
            || rt.conflict == SQLITE_CHANGESET_CONFLICT) {
        rt.conflict_row.resize(rt.n_col);
        for (int i = 0; i < rt.n_col; i++) {
            sqlite3_value* v = NULL;
            if (sqlite3changeset_conflict(iter, i, &v) == SQLITE_OK
                    && v != NULL) {
                ValueToCell(&rt.conflict_row[i], v);
            }
        }
    }
    if (rt.op == SQLITE_UPDATE || rt.op == SQLITE_DELETE) {
        rt.old_row.resize(rt.n_col);
        for (int i = 0; i < rt.n_col; i++) {
            sqlite3_value* v = NULL;
            if (sqlite3changeset_old(iter, i, &v) == SQLITE_OK
                    && v != NULL) {
                ValueToCell(&rt.old_row[i], v);
            }
        }
    }
    if (rt.op == SQLITE_INSERT || rt.op == SQLITE_UPDATE) {
        rt.new_row.resize(rt.n_col);
        for (int i = 0; i < rt.n_col; i++) {
            sqlite3_value* v = NULL;
            if (sqlite3changeset_new(iter, i, &v) == SQLITE_OK
                    && v != NULL) {
                ValueToCell(&rt.new_row[i], v);
            }
        }
    }
}

int ApplyFilterTrampoline(void* ctx, const char* z_tab) {
    auto* baton = static_cast<ApplyBaton*>(ctx);
    if (baton->tsfn == NULL || baton->on_filter.IsEmpty()) return 1;
    ApplyRoundTrip& rt = baton->rt;
    rt.is_filter = true;
    rt.errored = false;
    rt.done = false;
    rt.table = z_tab != NULL ? z_tab : "";
    ApplyRoundTripRun(baton);
    if (rt.errored) {
        // xFilter has no error channel; interrupting the connection makes
        // the apply's statements fail, which rolls back its savepoint.
        baton->status = SQLITE_INTERRUPT;
        baton->message = rt.error;
        sqlite3_interrupt(SessionOps::Handle(baton->db));
        return 0;
    }
    return rt.answer;
}

int ApplyConflictTrampoline(void* ctx, int e_conflict,
        sqlite3_changeset_iter* iter) {
    auto* baton = static_cast<ApplyBaton*>(ctx);
    if (baton->tsfn == NULL || baton->on_conflict.IsEmpty()) {
        return baton->decision;
    }
    ApplyRoundTrip& rt = baton->rt;
    rt.is_filter = false;
    rt.errored = false;
    rt.done = false;
    rt.conflict = e_conflict;
    const char* table = NULL;
    int n_col = 0, op = 0, indirect = 0;
    unsigned char* pk = NULL;
    sqlite3changeset_op(iter, &table, &n_col, &op, &indirect);
    sqlite3changeset_pk(iter, &pk, &n_col);
    rt.op = op;
    rt.n_col = n_col;
    rt.table = table != NULL ? table : "";
    rt.pk.clear();
    if (pk != NULL) {
        for (int i = 0; i < n_col; i++) {
            rt.pk.push_back(pk[i] != 0);
        }
    }
    else {
        rt.pk.resize(n_col, 0);
    }
    ApplyMaterialiseRows(rt, iter);

    ApplyRoundTripRun(baton);

    if (rt.errored) {
        baton->status = SQLITE_ABORT;
        baton->message = rt.error;
        return SQLITE_CHANGESET_ABORT;
    }
    if (rt.answer == SQLITE_CHANGESET_REPLACE
            && e_conflict != SQLITE_CHANGESET_DATA
            && e_conflict != SQLITE_CHANGESET_CONFLICT) {
        // Returning REPLACE for any other conflict is SQLITE_MISUSE from
        // sqlite; report it as the handler's mistake instead.
        baton->status = SQLITE_ABORT;
        baton->message = "changeset conflict handler returned 'replace' "
            "for a '" + std::string(ChangesetConflictString(e_conflict)) +
            "' conflict, where only 'omit' or 'abort' is legal";
        return SQLITE_CHANGESET_ABORT;
    }
    return rt.answer;
}

// --- Serialize / deserialize batons ------------------------------------------

struct SerializeBaton : Database::Baton {
    std::string database;
    sqlite3_int64 size = 0;
    void* data = NULL; // sqlite3_serialize output, sqlite3_malloc'd
    int status = SQLITE_OK;
    std::string message;
    SerializeBaton(Database* db_, Napi::Function cb_, const char* database_) :
            Baton(db_, cb_), database(database_) {}
    virtual ~SerializeBaton() override {
        if (data != NULL) sqlite3_free(data);
    }
};

struct DeserializeBaton : Database::Baton {
    int n = 0;
    void* data = NULL; // private copy handed to sqlite3_deserialize
    unsigned int flags = 0;
    int status = SQLITE_OK;
    std::string message;
    DeserializeBaton(Database* db_, Napi::Function cb_) :
            Baton(db_, cb_) {}
    virtual ~DeserializeBaton() override {
        // Nulled once ownership moved to sqlite (FREEONCLOSE frees it on
        // both the success and the failure path inside Work_Deserialize).
        // Still owned here only when the work never ran (the database
        // closed while the call was queued).
        if (data != NULL) sqlite3_free(data);
    }
};

} // namespace

// --- Session ------------------------------------------------------------------

Napi::Object Session::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);

    auto napi_default_method = static_cast<napi_property_attributes>(
        napi_writable | napi_configurable);

    auto t = DefineClass(env, "Session", {
        InstanceMethod("changeset", &Session::Changeset, napi_default_method),
        InstanceMethod("patchset", &Session::Patchset, napi_default_method),
        InstanceMethod("close", &Session::Close, napi_default_method),
        InstanceAccessor("closed", &Session::ClosedGetter, nullptr),
    });

    // Per-env (see Database::AddonData).
    env.GetInstanceData<Database::AddonData>()->session_ctor =
        Napi::Persistent(t);
    exports.Set("Session", t);
    return exports;
}

void Session::Process() {
    if ((closed || !inited) && !queue.empty()) {
        return CleanQueue();
    }

    while (inited && !locked && !closed && !queue.empty()) {
        auto call = std::unique_ptr<Call>(queue.front());
        queue.pop();

        call->callback(call->baton);
    }
}

void Session::Schedule(Work_Callback callback, Baton* baton) {
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

template <class T> void Session::Error(T* baton) {
    auto env = baton->session->Env();
    Napi::HandleScope scope(env);

    Session* session = baton->session;
    assert(session->status != 0);
    EXCEPTION(session->message, session->status, exception);

    Napi::Function cb = baton->callback.Value();

    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(session->Value(), cb, 1, argv);
    }
    else {
        Napi::Value info[] = { Napi::String::New(env, "error"), exception };
        EMIT_EVENT(session->Value(), 2, info);
    }
}

void Session::CleanQueue() {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    if (queue.empty()) return;

    // Environment teardown (worker termination): failing the queued
    // calls constructs JS on a dying environment, which is fatal. Drop
    // them instead — reference cleanup still works there, so the
    // batons are destroyed normally.
    if (Database::EnvCannotRunJs(env)) {
        while (!queue.empty()) {
            auto call = std::unique_ptr<Call>(queue.front());
            queue.pop();
            delete call->baton;
        }
        return;
    }

    // Every queued call is failed rather than dropped: a silent skip is
    // the failure mode this codebase exists to prevent. (Calls queued
    // behind a failed create see this same MISUSE — the create's real
    // error already went to its own callback.)
    EXCEPTION("Session is already closed", SQLITE_MISUSE, exception);
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

// { Database db, String dbName, String table ("" = all), Boolean indirect,
//   [Function callback] }
Session::Session(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Session>(info) {
    auto env = info.Env();
    if (!info.IsConstructCall()) {
        Napi::TypeError::New(env, "Use the new operator to create new Session objects").ThrowAsJavaScriptException();
        return;
    }

    if (info.Length() <= 0 || !Database::HasInstance(info[0])) {
        Napi::TypeError::New(env, "Database object expected").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() <= 1 || !info[1].IsString()) {
        Napi::TypeError::New(env, "Database name expected").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() <= 2 || !info[2].IsString()) {
        Napi::TypeError::New(env, "Table name expected (empty string records all tables)").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() <= 3 || !info[3].IsBoolean()) {
        Napi::TypeError::New(env, "Indirect flag expected").ThrowAsJavaScriptException();
        return;
    }
    else if (info.Length() > 4 && !info[4].IsUndefined() && !info[4].IsFunction()) {
        Napi::TypeError::New(env, "Callback expected").ThrowAsJavaScriptException();
        return;
    }

    this->db = Napi::ObjectWrap<Database>::Unwrap(info[0].As<Napi::Object>());
    this->db->Ref();

    // The preupdate-hook slot is owned exclusively: a 'preupdate'
    // listener and a session cannot coexist on one connection. Checked
    // here (JS thread) and again in Work_BeginCreate under the exclusive
    // gate, so a listener registered after construction but before the
    // create dispatched still wins loudly.
    if (this->db->hook_preupdate) {
        this->db->Unref();
        this->db = NULL;
        Napi::Error::New(env,
            "cannot create a session while a 'preupdate' listener is "
            "registered on this connection: both use SQLite's single "
            "preupdate hook, and creating the session would silently "
            "stop the listener's events. Remove the listener first"
        ).ThrowAsJavaScriptException();
        return;
    }

    auto dbName = info[1].As<Napi::String>().Utf8Value();
    auto table = info[2].As<Napi::String>().Utf8Value();
    bool indirect = info[3].As<Napi::Boolean>().Value();

    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("db", info[1]));
    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("table", info[2]));
    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value("indirect", info[3]));

    // Tracked from construction (before the handle exists) so the
    // 'preupdate' registration check cannot miss a session still being
    // created. Untracked by the create-failure path, close and teardown.
    this->db->live_sessions.push_back(this);

    auto* baton = new CreateBaton(this->db, info[4].As<Napi::Function>(), this);
    baton->dbName = dbName;
    baton->table = table;
    baton->indirect = indirect;

    this->db->Schedule(Work_BeginCreate, baton, true);
}

void Session::Work_BeginCreate(Database::Baton* b) {
    auto holder = std::unique_ptr<CreateBaton>(static_cast<CreateBaton*>(b));
    auto* db = holder->db;

    assert(db->exclusiveHeld);
    assert(db->IsOpen());
    assert(db->_handle);
    assert(db->pending == 0);

    if (db->hook_preupdate) {
        // A 'preupdate' listener was registered after the constructor's
        // check but before this dispatched. Fail the create loudly
        // rather than displacing the listener's hook.
        auto* session = holder->session;
        session->status = SQLITE_MISUSE;
        session->message = "cannot create a session while a 'preupdate' "
            "listener is registered on this connection";
        session->DetachFromDatabase();
        Error(holder.get());
        db->exclusiveHeld = false;
        db->Process();
        return;
    }

    // The async work (and its completion) own the baton from here;
    // CREATE_WORK reads `baton`. pending holds the exclusive window closed
    // until Work_AfterCreate releases it (Work_BeginClose's pattern).
    CreateBaton* baton = holder.release();
    db->pending++;

    auto env = db->Env();
    CREATE_WORK("sqlite3.Session.Create", Work_Create, Work_AfterCreate);
}

void Session::Work_Create(napi_env e, void* data) {
    auto* baton = static_cast<CreateBaton*>(data);
    Session* session = baton->session;

    sqlite3_mutex* mtx = sqlite3_db_mutex(baton->db->_handle);
    sqlite3_mutex_enter(mtx);

    int rc = sqlite3session_create(baton->db->_handle,
        baton->dbName.c_str(), &session->_handle);
    if (rc == SQLITE_OK) {
        if (baton->indirect) {
            sqlite3session_indirect(session->_handle, 1);
        }
        // A NULL table name records changes for every table with a
        // primary key (tables attach lazily on first change).
        rc = sqlite3session_attach(session->_handle,
            baton->table.empty() ? NULL : baton->table.c_str());
    }
    if (rc != SQLITE_OK) {
        session->message = std::string(sqlite3_errmsg(baton->db->_handle));
        if (session->_handle != NULL) {
            sqlite3session_delete(session->_handle);
            session->_handle = NULL;
        }
    }

    sqlite3_mutex_leave(mtx);

    session->status = rc;
}

void Session::Work_AfterCreate(napi_env e, napi_status status, void* data) {
    std::unique_ptr<CreateBaton> baton(static_cast<CreateBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* session = baton->session;
    auto* db = baton->db;

    auto env = session->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    // The exclusive create released the database either way.
    db->exclusiveHeld = false;

    if (session->status != SQLITE_OK) {
        session->DetachFromDatabase();
        Error(baton.get());
    }
    else {
        session->inited = true;
        Napi::Function cb = baton->callback.Value();
        if (IS_FUNCTION(cb)) {
            Napi::Value argv[] = { env.Null() };
            TRY_CATCH_CALL(session->Value(), cb, 1, argv);
        }
    }

    db->Process();
    session->Process();
}

void Session::EndCall() {
    assert(locked);
    assert(db->pending);
    locked = false;
    db->pending--;
    Process();
    db->Process();
}

Session::~Session() {
    // GC safety net, mirroring ~Statement: every queued Baton holds a Ref
    // on the session, so the queue is provably empty and CleanQueue
    // cannot fire JS from this finalizer. sqlite3session_delete takes the
    // connection mutex internally; the deferred path is required when a
    // worker could be mid-round-trip holding that mutex while waiting for
    // this very thread.
    CleanQueue();
    if (_handle != NULL) {
        if (db != NULL && db->MayBlockOnWorkerRoundTrip()) {
            db->Schedule(Database::Work_DeferredSessionDelete,
                new SessionHandleBaton(db, _handle), true);
            _handle = NULL;
        }
        else {
            sqlite3session_delete(_handle);
            _handle = NULL;
        }
    }
    // Detached sessions have already released the database (and nulled
    // the pointer); this covers the never-detached case only.
    if (db != NULL) {
        UntrackFromDatabase();
        db->Unref();
    }
}

void Session::UntrackFromDatabase() {
    if (db == NULL) return;
    auto& v = db->live_sessions;
    for (auto it = v.begin(); it != v.end(); ++it) {
        if (*it == this) {
            v.erase(it);
            return;
        }
    }
}

// JS thread, nothing in flight (Work_BeginClose / ~Database) or at a
// completion point where the handle is already gone. Idempotent.
// See Blob::DetachFromDatabase for why the back-pointer is nulled here
// and why owner_dying skips the Unref: at environment teardown ~Session
// can run after ~Database, and UntrackFromDatabase would then walk a
// destroyed std::vector.
void Session::DetachFromDatabase(bool owner_dying) {
    if (db == NULL) return;
    if (_handle != NULL) {
        sqlite3session_delete(_handle);
        _handle = NULL;
    }
    UntrackFromDatabase();
    closed = true;
    // See Blob::DetachFromDatabase for why this is confined to the
    // owner-dying path.
    if (owner_dying) db = NULL;
}

void Database::Work_DeferredSessionDelete(Baton* b) {
    auto baton = std::unique_ptr<SessionHandleBaton>(
        static_cast<SessionHandleBaton*>(b));
    auto* db = baton->db;

    sqlite3session_delete(baton->handle);

    db->exclusiveHeld = false;
    db->Process();
}

// --- changeset / patchset ------------------------------------------------------

Napi::Value Session::Changeset(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Session* session = this;

    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    auto* baton = new BufferBaton(session, callback);
    baton->patch = false;
    session->Schedule(Work_BeginChangeset, baton);

    return info.This();
}

Napi::Value Session::Patchset(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Session* session = this;

    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    auto* baton = new BufferBaton(session, callback);
    baton->patch = true;
    session->Schedule(Work_BeginChangeset, baton);

    return info.This();
}

void Session::Work_BeginChangeset(Baton* baton) {
    SESSION_BEGIN(Changeset);
}

void Session::Work_Changeset(napi_env e, void* data) {
    auto* baton = static_cast<BufferBaton*>(data);
    Session* session = baton->session;

    // Serialize against concurrent writes recording changes through the
    // preupdate hook, which run under the same connection mutex.
    sqlite3_mutex* mtx = sqlite3_db_mutex(session->db->_handle);
    sqlite3_mutex_enter(mtx);

    int rc = baton->patch
        ? sqlite3session_patchset(session->_handle, &baton->n, &baton->data)
        : sqlite3session_changeset(session->_handle, &baton->n, &baton->data);

    sqlite3_mutex_leave(mtx);

    session->status = rc;
    if (rc != SQLITE_OK) {
        session->message =
            std::string(sqlite3_errmsg(session->db->_handle));
    }
}

void Session::Work_AfterChangeset(napi_env e, napi_status status, void* data) {
    std::unique_ptr<BufferBaton> baton(static_cast<BufferBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* session = baton->session;

    auto env = session->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    Session::CallGuard session_call_guard__(session);

    if (session->status != SQLITE_OK) {
        Error(baton.get());
        return;
    }

    Napi::Function cb = baton->callback.Value();
    if (!IS_FUNCTION(cb)) {
        // Nobody to hand the buffer to; the baton destructor frees it.
        return;
    }
    // Ownership of the sqlite3_malloc'd buffer moves into the Uint8Array
    // finalizer; the baton destructor must not also free it.
    void* buffer = baton->data;
    baton->data = NULL;
    Napi::Value result = WrapOwnedBytes(env, buffer,
        static_cast<size_t>(baton->n));
    Napi::Value argv[] = { env.Null(), result };
    TRY_CATCH_CALL(session->Value(), cb, 2, argv);
}

// --- close ----------------------------------------------------------------------

Napi::Value Session::Close(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Session* session = this;

    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    if (session->closed) {
        // Dispose contract: a second close is a benign no-op, and one
        // after the database closed finds the handle already gone.
        if (IS_FUNCTION(callback)) {
            Napi::Value argv[] = { env.Null() };
            TRY_CATCH_CALL(session->Value(), callback, 1, argv, info.This());
        }
        return info.This();
    }

    auto* baton = new Baton(session, callback);
    session->Schedule(Work_BeginClose, baton);

    return info.This();
}

void Session::Work_BeginClose(Baton* baton) {
    SESSION_BEGIN(Close);
}

void Session::Work_Close(napi_env e, void* data) {
    auto* baton = static_cast<Baton*>(data);
    Session* session = baton->session;

    // Unlinks from the connection's session list (under the connection
    // mutex, taken internally) and frees the recorded changes.
    sqlite3session_delete(session->_handle);
    session->_handle = NULL;
}

void Session::Work_AfterClose(napi_env e, napi_status status, void* data) {
    std::unique_ptr<Baton> baton(static_cast<Baton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* session = baton->session;

    auto env = session->Env();
    Napi::HandleScope scope(env);

    Session::CallGuard session_call_guard__(session);

    session->DetachFromDatabase();

    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { env.Null() };
        TRY_CATCH_CALL(session->Value(), cb, 1, argv);
    }
}

Napi::Value Session::ClosedGetter(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), closed);
}

// --- Database-side: live-session teardown and changeset apply ------------------

void Database::CloseLiveSessions(bool owner_dying) {
    // Main thread, nothing in flight (Work_BeginClose / ~Database).
    // DetachFromDatabase deletes the handle (taking the connection mutex
    // internally — fine here) and untracks; iterating over a copy because
    // it mutates the vector.
    std::vector<Session*> sessions = live_sessions;
    live_sessions.clear();
    for (Session* session : sessions) {
        session->DetachFromDatabase(owner_dying);
    }
}

// _applyChangeset(data, decision, onConflict|null, onFilter|null,
//                 [callback]). decision is one of the CHANGESET_* return
// constants used when no JS conflict handler is given; onConflict /
// onFilter, when non-null, make the blocking round trip from inside
// sqlite3changeset_apply.
Napi::Value Database::ApplyChangeset(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected at least 1 argument").ThrowAsJavaScriptException();
        return env.Null();
    }
    BytesView view;
    if (!GetBytesView(env, info[0], "apply a changeset", &view)) {
        return env.Null();
    }
    if (info.Length() < 2 || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Argument 1 must be a CHANGESET_* decision constant").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* baton = new ApplyBaton(db, Napi::Function());
    int64_t decision = info[1].As<Napi::Number>().Int64Value();
    if (decision != SQLITE_CHANGESET_OMIT
            && decision != SQLITE_CHANGESET_REPLACE
            && decision != SQLITE_CHANGESET_ABORT) {
        delete baton;
        Napi::TypeError::New(env,
            "conflict decision must be CHANGESET_ABORT, CHANGESET_OMIT or CHANGESET_REPLACE"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    baton->decision = static_cast<int>(decision);

    auto read_handler = [&](size_t index, bool is_conflict) -> bool {
        if (info.Length() <= index || info[index].IsNull()
                || info[index].IsUndefined()) {
            return true;
        }
        if (!info[index].IsFunction()) {
            Napi::TypeError::New(env,
                "changeset handlers must be functions or null"
            ).ThrowAsJavaScriptException();
            return false;
        }
        if (is_conflict) {
            baton->on_conflict.Reset(info[index].As<Napi::Function>(), 1);
        }
        else {
            baton->on_filter.Reset(info[index].As<Napi::Function>(), 1);
        }
        return true;
    };
    if (!read_handler(2, true) || !read_handler(3, false)) {
        delete baton;
        return env.Null();
    }

    Napi::Function callback;
    if (info.Length() > 4 && !info[4].IsUndefined()) {
        if (!info[4].IsFunction()) {
            delete baton;
            Napi::TypeError::New(env, "Argument 4 must be a function").ThrowAsJavaScriptException();
            return env.Null();
        }
        callback = info[4].As<Napi::Function>();
    }

    // The changeset is applied from a private copy: the apply runs later
    // on a worker, and a JS-side mutation of the source buffer mid-apply
    // would otherwise be undefined behaviour inside sqlite's parser.
    baton->n = static_cast<int>(view.length);
    baton->data = sqlite3_malloc64(view.length);
    if (baton->data == NULL && view.length > 0) {
        delete baton;
        Napi::Error::New(env, "out of memory").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (view.length > 0) {
        memcpy(baton->data, view.data, view.length);
    }
    baton->callback.Reset(callback, 1);

    if (!baton->on_conflict.IsEmpty() || !baton->on_filter.IsEmpty()) {
        // The round-trip channel for the JS conflict/filter forms. Unref'd
        // so it never keeps the event loop alive; released once the apply
        // completes. While it exists, js_apply_depth keeps
        // MayBlockOnWorkerRoundTrip truthful (the apply holds the
        // connection mutex for its whole run).
        Napi::Function noop = Napi::Function::New(env,
            [](const Napi::CallbackInfo& info) {
                return info.Env().Undefined();
            });
        napi_value resource_name = Napi::String::New(env,
            "sqlite3.Database.ApplyChangeset");
        napi_threadsafe_function tsfn = NULL;
        napi_status st = napi_create_threadsafe_function(env, noop, NULL,
            resource_name, 0, 1, NULL, NULL, NULL, ApplyCallJs, &tsfn);
        if (st != napi_ok || tsfn == NULL) {
            delete baton;
            Napi::Error::New(env,
                "cannot create the changeset round-trip channel"
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
        napi_unref_threadsafe_function(env, tsfn);
        baton->tsfn = tsfn;
        db->js_apply_depth++;
    }

    db->Schedule(Work_BeginApplyChangeset, baton);

    return info.This();
}

void Database::Work_BeginApplyChangeset(Baton* baton) {
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.ApplyChangeset", Work_ApplyChangeset,
        Work_AfterApplyChangeset);
}

void Database::Work_ApplyChangeset(napi_env e, void* data) {
    auto* baton = static_cast<ApplyBaton*>(data);

    int rc = sqlite3changeset_apply(
        baton->db->_handle,
        baton->n,
        baton->data,
        ApplyFilterTrampoline,
        ApplyConflictTrampoline,
        baton);

    // A handler error overrides the raw sqlite code as the reported
    // cause of the (rolled-back) apply.
    if (baton->status != SQLITE_OK) {
        rc = baton->status;
    }
    else if (rc != SQLITE_OK) {
        baton->message = std::string(sqlite3_errmsg(baton->db->_handle));
    }
    baton->status = rc;
}

void Database::Work_AfterApplyChangeset(napi_env e, napi_status status, void* data) {
    std::unique_ptr<ApplyBaton> baton(static_cast<ApplyBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    if (baton->tsfn != NULL) {
        napi_release_threadsafe_function(baton->tsfn, napi_tsfn_release);
        baton->tsfn = NULL;
        assert(db->js_apply_depth > 0);
        db->js_apply_depth--;
    }

    db->pending--;
    db->Process();

    Napi::Function cb = baton->callback.Value();
    if (!IS_FUNCTION(cb)) {
        if (baton->status != SQLITE_OK) {
            EXCEPTION(baton->message, baton->status, exception);
            Napi::Value info[] = { Napi::String::New(env, "error"), exception };
            EMIT_EVENT(db->Value(), 2, info);
        }
        return;
    }

    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
        return;
    }
    Napi::Value argv[] = { env.Null() };
    TRY_CATCH_CALL(db->Value(), cb, 1, argv);
}

// --- serialize / deserialize -----------------------------------------------------

// _serializeToBytes(dbName, [callback]). Exclusive: the snapshot must not
// interleave with other work on the connection.
Napi::Value Database::SerializeToBytes(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, database);
    OPTIONAL_ARGUMENT_FUNCTION(1, callback);

    auto* baton = new SerializeBaton(db, callback, database.c_str());
    db->Schedule(Work_BeginSerializeToBytes, baton, true);

    return info.This();
}

void Database::Work_BeginSerializeToBytes(Baton* baton) {
    assert(baton->db->exclusiveHeld);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(baton->db->pending == 0);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.SerializeToBytes", Work_SerializeToBytes,
        Work_AfterSerializeToBytes);
}

void Database::Work_SerializeToBytes(napi_env e, void* data) {
    auto* baton = static_cast<SerializeBaton*>(data);

    sqlite3_int64 size = 0;
    unsigned char* bytes = sqlite3_serialize(baton->db->_handle,
        baton->database.c_str(), &size, 0);
    if (bytes == NULL && size > 0) {
        baton->status = SQLITE_NOMEM;
        baton->message = "out of memory serializing the database";
    }
    else if (bytes == NULL) {
        baton->status = SQLITE_ERROR;
        baton->message = std::string(sqlite3_errmsg(baton->db->_handle));
    }
    else {
        baton->data = bytes;
        baton->size = size;
    }
}

void Database::Work_AfterSerializeToBytes(napi_env e, napi_status status, void* data) {
    std::unique_ptr<SerializeBaton> baton(static_cast<SerializeBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    // The exclusive serialize released the database.
    db->exclusiveHeld = false;

    // Never call Value() on a default-constructed (empty)
    // FunctionReference: undefined behaviour that fatals in practice on
    // the raw no-callback form (see Work_AfterCheckpoint in
    // src/database.cc). IsEmpty() is a plain member check.
    if (baton->callback.IsEmpty()) {
        if (baton->status != SQLITE_OK) {
            EXCEPTION(baton->message, baton->status, exception);
            Napi::Value info[] = { Napi::String::New(env, "error"), exception };
            EMIT_EVENT(db->Value(), 2, info);
        }
        db->Process();
        return;
    }
    Napi::Function cb = baton->callback.Value();
    if (!IS_FUNCTION(cb)) {
        if (baton->status != SQLITE_OK) {
            EXCEPTION(baton->message, baton->status, exception);
            Napi::Value info[] = { Napi::String::New(env, "error"), exception };
            EMIT_EVENT(db->Value(), 2, info);
        }
        db->Process();
        return;
    }

    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
    }
    else {
        void* buffer = baton->data;
        baton->data = NULL; // ownership moves into the Uint8Array
        Napi::Value result = WrapOwnedBytes(env, buffer,
            static_cast<size_t>(baton->size));
        Napi::Value argv[] = { env.Null(), result };
        TRY_CATCH_CALL(db->Value(), cb, 2, argv);
    }

    db->Process();
}

// _deserialize(bytes, flags, [callback]). Exclusive, pending == 0: the
// schema image is replaced outright, so no work may be in flight. `flags`
// carries SQLITE_DESERIALIZE_RESIZEABLE / READONLY (FREEONCLOSE is always
// set — the copy is ours). The bytes are copied into sqlite3_malloc'd
// memory first: a JS-owned buffer cannot be handed over (the GC may move
// or collect it), and detaching it would trade that for a
// use-after-free. The copy is documented API behaviour.
Napi::Value Database::Deserialize(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected at least 1 argument").ThrowAsJavaScriptException();
        return env.Null();
    }
    BytesView view;
    if (!GetBytesView(env, info[0], "deserialize a database", &view)) {
        return env.Null();
    }
    if (info.Length() < 2 || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Argument 1 must be a deserialize flag word").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Function callback;
    if (info.Length() > 2 && !info[2].IsUndefined()) {
        if (!info[2].IsFunction()) {
            Napi::TypeError::New(env, "Argument 2 must be a function").ThrowAsJavaScriptException();
            return env.Null();
        }
        callback = info[2].As<Napi::Function>();
    }

    auto* baton = new DeserializeBaton(db, callback);
    baton->n = static_cast<int>(view.length);
    baton->flags = static_cast<unsigned int>(
        info[1].As<Napi::Number>().Uint32Value())
        & (SQLITE_DESERIALIZE_RESIZEABLE | SQLITE_DESERIALIZE_READONLY);
    baton->data = sqlite3_malloc64(view.length);
    if (baton->data == NULL && view.length > 0) {
        delete baton;
        Napi::Error::New(env, "out of memory").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (view.length > 0) {
        memcpy(baton->data, view.data, view.length);
    }

    db->Schedule(Work_BeginDeserialize, baton, true);

    return info.This();
}

void Database::Work_BeginDeserialize(Baton* baton) {
    assert(baton->db->exclusiveHeld);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(baton->db->pending == 0);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.Deserialize", Work_Deserialize,
        Work_AfterDeserialize);
}

void Database::Work_Deserialize(napi_env e, void* data) {
    auto* baton = static_cast<DeserializeBaton*>(data);
    auto* db = baton->db;

    int rc = sqlite3_deserialize(db->_handle, "main",
        static_cast<unsigned char*>(baton->data), baton->n, baton->n,
        SQLITE_DESERIALIZE_FREEONCLOSE | baton->flags);
    // On failure with FREEONCLOSE sqlite frees the buffer itself; either
    // way ownership left the baton.
    baton->data = NULL;

    if (rc != SQLITE_OK) {
        baton->status = rc;
        baton->message = std::string(sqlite3_errmsg(db->_handle));
        return;
    }

    // sqlite3_deserialize accepts any bytes; corruption surfaces at first
    // use. Probe the schema now so a corrupt input reports
    // SQLITE_NOTADB from the deserialize call itself instead of from an
    // unrelated later query.
    sqlite3_stmt* stmt = NULL;
    rc = sqlite3_prepare_v2(db->_handle,
        "SELECT count(*) FROM sqlite_schema", -1, &stmt, NULL);
    if (rc == SQLITE_OK) {
        rc = sqlite3_step(stmt);
        if (rc == SQLITE_ROW) rc = SQLITE_OK;
        sqlite3_finalize(stmt);
    }
    if (rc != SQLITE_OK) {
        baton->status = rc;
        baton->message = std::string(sqlite3_errmsg(db->_handle));
    }
}

void Database::Work_AfterDeserialize(napi_env e, napi_status status, void* data) {
    std::unique_ptr<DeserializeBaton> baton(static_cast<DeserializeBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    // The exclusive deserialize released the database.
    db->exclusiveHeld = false;

    Napi::Function cb = baton->callback.Value();

    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        if (IS_FUNCTION(cb)) {
            Napi::Value argv[] = { exception };
            TRY_CATCH_CALL(db->Value(), cb, 1, argv);
        }
        else {
            Napi::Value info[] = { Napi::String::New(env, "error"), exception };
            EMIT_EVENT(db->Value(), 2, info);
        }
    }
    else if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { env.Null() };
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
    }

    db->Process();
}

namespace node_sqlite3 {

// --- Module-level changeset helpers ----------------------------------------------

Napi::Value InvertChangeset(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected 1 argument").ThrowAsJavaScriptException();
        return env.Null();
    }
    BytesView view;
    if (!GetBytesView(env, info[0], "invert a changeset", &view)) {
        return env.Null();
    }
    // sqlite3changeset_invert documents its input as assumed-valid; prove
    // parseability first so garbage is an error, not undefined behaviour.
    int rc = ValidateChangeset(static_cast<int>(view.length), view.data);
    if (rc != SQLITE_OK) {
        EXCEPTION("the changeset is not parseable", rc, exception);
        exception.As<Napi::Error>().ThrowAsJavaScriptException();
        return env.Null();
    }
    int n_out = 0;
    void* p_out = NULL;
    rc = sqlite3changeset_invert(static_cast<int>(view.length),
        const_cast<void*>(view.data), &n_out, &p_out);
    if (rc != SQLITE_OK) {
        EXCEPTION("cannot invert the changeset", rc, exception);
        exception.As<Napi::Error>().ThrowAsJavaScriptException();
        return env.Null();
    }
    return WrapOwnedBytes(env, p_out, static_cast<size_t>(n_out));
}

Napi::Value ConcatChangeset(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected 2 arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    BytesView a, b;
    if (!GetBytesView(env, info[0], "concatenate a changeset", &a)) {
        return env.Null();
    }
    if (!GetBytesView(env, info[1], "concatenate a changeset", &b)) {
        return env.Null();
    }
    int rc = ValidateChangeset(static_cast<int>(a.length), a.data);
    if (rc == SQLITE_OK) {
        rc = ValidateChangeset(static_cast<int>(b.length), b.data);
    }
    if (rc != SQLITE_OK) {
        EXCEPTION("one of the changesets is not parseable", rc, exception);
        exception.As<Napi::Error>().ThrowAsJavaScriptException();
        return env.Null();
    }
    int n_out = 0;
    void* p_out = NULL;
    rc = sqlite3changeset_concat(
        static_cast<int>(a.length), const_cast<void*>(a.data),
        static_cast<int>(b.length), const_cast<void*>(b.data),
        &n_out, &p_out);
    if (rc != SQLITE_OK) {
        EXCEPTION("cannot concatenate the changesets", rc, exception);
        exception.As<Napi::Error>().ThrowAsJavaScriptException();
        return env.Null();
    }
    return WrapOwnedBytes(env, p_out, static_cast<size_t>(n_out));
}

// --- ChangesetIter ----------------------------------------------------------------

namespace {
// The lazily created constructor for the iterator class; instances are
// not part of the public surface (the type is declared as an iterable in
// lib/native.d.ts).
} // namespace

Napi::Object ChangesetIter::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);
    auto napi_default_method = static_cast<napi_property_attributes>(
        napi_writable | napi_configurable);
    Napi::Function t = DefineClass(env, "ChangesetIter", {
        InstanceMethod("next", &ChangesetIter::Next, napi_default_method),
    });
    // [Symbol.iterator] is defined per instance (in the constructor):
    // DefineClass properties must be ClassPropertyDescriptor values,
    // which have no symbol-keyed form in node-addon-api.
    env.GetInstanceData<Database::AddonData>()->changeset_iter_ctor =
        Napi::Persistent(t);
    return exports;
}

// { Uint8Array data }
ChangesetIter::ChangesetIter(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<ChangesetIter>(info) {
    auto env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected 1 argument").ThrowAsJavaScriptException();
        return;
    }
    BytesView view;
    if (!GetBytesView(env, info[0], "iterate a changeset", &view)) {
        // GetBytesView already threw; keep the object inert.
        return;
    }
    // The iterator parses lazily, so it walks a private copy: a JS-side
    // mutation of the source buffer mid-iteration would otherwise be
    // undefined behaviour.
    bytes.assign(static_cast<const char*>(view.data), view.length);
    int rc = sqlite3changeset_start(&_iter,
        static_cast<int>(bytes.size()), bytes.data());
    if (rc != SQLITE_OK) {
        _iter = NULL;
        Napi::Error::New(env, "the changeset is not parseable")
            .ThrowAsJavaScriptException();
        return;
    }
    // for..of drives [Symbol.iterator]() first; the iterator is its own
    // iterable.
    info.This().As<Napi::Object>().DefineProperty(
        Napi::PropertyDescriptor::Value(
            Napi::Symbol::WellKnown(env, "iterator"),
            Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
                return info.This();
            }), napi_default));
}

Napi::Value ChangesetIter::Next(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (_iter == NULL) {
        Napi::Object done = Napi::Object::New(env);
        done.Set("done", Napi::Boolean::New(env, true));
        done.Set("value", env.Null());
        return done;
    }
    int rc = sqlite3changeset_next(_iter);
    if (rc == SQLITE_DONE) {
        sqlite3changeset_finalize(_iter);
        _iter = NULL;
        Napi::Object done = Napi::Object::New(env);
        done.Set("done", Napi::Boolean::New(env, true));
        done.Set("value", env.Null());
        return done;
    }
    if (rc != SQLITE_ROW) {
        sqlite3changeset_finalize(_iter);
        _iter = NULL;
        EXCEPTION("the changeset is corrupt",
            rc == SQLITE_OK ? SQLITE_CORRUPT : rc, exception);
        exception.As<Napi::Error>().ThrowAsJavaScriptException();
        return env.Null();
    }

    const char* table = NULL;
    int n_col = 0, op = 0, indirect = 0;
    unsigned char* pk = NULL;
    sqlite3changeset_op(_iter, &table, &n_col, &op, &indirect);
    sqlite3changeset_pk(_iter, &pk, &n_col);

    // No database is involved, so there is no integer mode to honour;
    // mixed keeps every value exact (number when safe, BigInt otherwise).
    const int mixed = Database::INTEGER_MIXED;

    Napi::Object value = Napi::Object::New(env);
    value.Set("op", Napi::String::New(env, ChangesetOpString(op)));
    value.Set("table", Napi::String::New(env, table != NULL ? table : ""));
    value.Set("indirect", Napi::Boolean::New(env, indirect != 0));
    Napi::Array pk_arr = Napi::Array::New(env, n_col);
    for (int i = 0; i < n_col; i++) {
        pk_arr.Set(i, Napi::Boolean::New(env,
            pk != NULL && pk[i] != 0));
    }
    value.Set("primaryKey", pk_arr);

    // UPDATE changesets carry old.* only for primary-key and modified
    // columns; the untouched positions stay null in the array, which is
    // exactly how sqlite encodes them.
    auto fill = [&](const char* name, bool old) -> bool {
        std::vector<Cell> cells;
        cells.resize(n_col);
        int filled = 0;
        for (int i = 0; i < n_col; i++) {
            sqlite3_value* v = NULL;
            int grc = old
                ? sqlite3changeset_old(_iter, i, &v)
                : sqlite3changeset_new(_iter, i, &v);
            if (grc == SQLITE_OK && v != NULL) {
                ValueToCell(&cells[i], v);
                filled++;
            }
        }
        if (filled == 0) return true;
        value.Set(name, CellsToArray(env, cells, mixed,
            std::string("a changeset ") + name + " value"));
        return !env.IsExceptionPending();
    };

    if (op == SQLITE_UPDATE || op == SQLITE_DELETE) {
        if (!fill("oldRow", true)) return env.Null();
    }
    if (op == SQLITE_INSERT || op == SQLITE_UPDATE) {
        if (!fill("newRow", false)) return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("done", Napi::Boolean::New(env, false));
    result.Set("value", value);
    return result;
}

Napi::Value IterateChangeset(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected 1 argument").ThrowAsJavaScriptException();
        return env.Null();
    }
    Napi::Function ctor = env.GetInstanceData<Database::AddonData>()
        ->changeset_iter_ctor.Value();
    // The constructor throws (a pending TypeError/Error) on a bad input;
    // propagate it.
    Napi::Object iter = ctor.New({ info[0] });
    if (env.IsExceptionPending()) return env.Null();
    return iter;
}

} // namespace node_sqlite3
