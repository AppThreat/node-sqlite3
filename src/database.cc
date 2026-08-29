#include <cctype>
#include <cstring>
#include <napi.h>

#ifdef _WIN32
#include <direct.h>
#else
#include <unistd.h>
#endif

#include "macros.h"
#include "database.h"
#include "statement.h"
#include "function.h"
#include "session.h"
#include "blob.h"

using namespace node_sqlite3;

Napi::Object Database::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);
    // declare napi_default_method here as it is only available in Node v14.12.0+
    auto napi_default_method = static_cast<napi_property_attributes>(napi_writable | napi_configurable);

    auto t = DefineClass(env, "Database", {
        InstanceMethod("close", &Database::Close, napi_default_method),
        InstanceMethod("exec", &Database::Exec, napi_default_method),
        InstanceMethod("wait", &Database::Wait, napi_default_method),
        InstanceMethod("loadExtension", &Database::LoadExtension, napi_default_method),
        InstanceMethod("serialize", &Database::Serialize, napi_default_method),
        InstanceMethod("parallelize", &Database::Parallelize, napi_default_method),
        InstanceMethod("configure", &Database::Configure, napi_default_method),
        InstanceMethod("interrupt", &Database::Interrupt, napi_default_method),
        InstanceMethod("_queueBusy", &Database::QueueBusy, napi_default_method),
        // User-defined functions (Deliverable 06): internal entry points
        // wrapped by lib/sqlite3.js, which parses options and flushes the
        // statement cache.
        InstanceMethod("_registerFunction", &Database::RegisterUserFunction, napi_default_method),
        InstanceMethod("_registerAggregate", &Database::RegisterUserAggregate, napi_default_method),
        InstanceMethod("_registerCollation", &Database::RegisterUserCollation, napi_default_method),
        InstanceMethod("_removeFunction", &Database::RemoveUserFunction, napi_default_method),
        InstanceMethod("_removeCollation", &Database::RemoveUserCollation, napi_default_method),
        // Hooks, authorizer and progress (Deliverable 07): internal entry
        // points wrapped by lib/sqlite3.js, which parses options.
        InstanceMethod("_setAuthorizer", &Database::SetAuthorizer, napi_default_method),
        // Permission-model ATTACH gate (Deliverable 11): wrapped by
        // lib/sqlite3.js, which permission-checks allowlist entries.
        InstanceMethod("_setAttachGate", &Database::SetAttachGate, napi_default_method),
        InstanceMethod("_progressFlag", &Database::SetProgressFlag, napi_default_method),
        InstanceMethod("_progressCallback", &Database::SetProgressCallback, napi_default_method),
        InstanceMethod("_checkpoint", &Database::Checkpoint, napi_default_method),
        InstanceMethod("_tableInfo", &Database::TableInfo, napi_default_method),
        InstanceMethod("_dbConfig", &Database::DbConfig, napi_default_method),
        // Sessions, changesets and serialization (Deliverable 08):
        // internal entry points wrapped by lib/sqlite3.js.
        InstanceMethod("_applyChangeset", &Database::ApplyChangeset, napi_default_method),
        InstanceMethod("_serializeToBytes", &Database::SerializeToBytes, napi_default_method),
        InstanceMethod("_deserialize", &Database::Deserialize, napi_default_method),
        InstanceAccessor("open", &Database::Open, nullptr),
        InstanceAccessor("integerMode", &Database::IntegerModeGetter, nullptr),
        InstanceAccessor("state", &Database::StateGetter, nullptr),
        InstanceAccessor("changes", &Database::ChangesGetter, nullptr),
        InstanceAccessor("totalChanges", &Database::TotalChangesGetter, nullptr),
        // Individual accessors for the statement cache's hot guard: the
        // state object is fine for diagnostics, but constructing it on
        // every cached call measured +46% on db.getSync cached (bench,
        // Deliverable 05).
        InstanceAccessor("closing", &Database::ClosingGetter, nullptr),
        InstanceAccessor("locked", &Database::LockedGetter, nullptr),
        InstanceAccessor("serialized", &Database::SerializedGetter, nullptr),
        InstanceAccessor("pending", &Database::PendingGetter, nullptr),
        InstanceAccessor("queued", &Database::QueuedGetter, nullptr)
    });

    // The constructors ride per-env instance data (NAPI >= 6 only: the
    // package declares napi_versions [10]). Allocated bare: node-addon-api
    // takes ownership of instance data and deletes it at env teardown.
    // Database::Init runs first in RegisterModule, so it allocates the
    // block the other classes then fill in.
    AddonData* data = new AddonData();
    data->database_ctor = Napi::Persistent(t);
    env.SetInstanceData<AddonData>(data);

    exports.Set("Database", t);
    return exports;
}

void Database::Process() {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    if (db_state == DbState::Closed && !queue.empty()) {
        // Work queued behind a *failed open* fails with the open's own
        // error (CANTOPEN etc.), not the generic closed message — it never
        // had a chance to run and the open failure is what explains that.
        EXCEPTION(
            open_failed ? open_error_message.c_str() : "Database handle is closed",
            open_failed ? open_error_status : SQLITE_MISUSE,
            exception);
        Napi::Value argv[] = { exception };
        bool called = false;

        // Call all callbacks with the error object. The IsEmpty() guard
        // first: Value() on a default-constructed (empty) reference is
        // undefined behaviour, and this drain now also fires for
        // callback-less internal batons (the permission-model ATTACH gate
        // install queued in the constructor) behind a failed open.
        while (!queue.empty()) {
            auto call = std::unique_ptr<Call>(queue.front());
            queue.pop();
            auto baton = std::unique_ptr<Baton>(call->baton);
            if (baton->callback.IsEmpty()) continue;
            Napi::Function cb = baton->callback.Value();
            if (IS_FUNCTION(cb)) {
                TRY_CATCH_CALL(this->Value(), cb, 1, argv);
                called = true;
            }
        }

        // When we couldn't call a callback function, emit an error on the
        // Database object — except after a failed open, whose error the
        // open path has already delivered through its callback or the
        // 'error' event; a second emit here would be an unhandled duplicate.
        if (!called && !open_failed) {
            Napi::Value info[] = { Napi::String::New(env, "error"), exception };
            EMIT_EVENT(Value(), 2, info);
        }
        return;
    }

    while (IsOpen() && (!exclusiveHeld || pending == 0) && !queue.empty()) {
        Call *c = queue.front();

        if (c->exclusive && pending > 0) {
            break;
        }

        queue.pop();
        std::unique_ptr<Call> call(c);
        exclusiveHeld = call->exclusive;
        call->callback(call->baton);

        if (exclusiveHeld) break;
    }
}

void Database::Schedule(Work_Callback callback, Baton* baton, bool exclusive) {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    if (IsClosed()) {
        EXCEPTION("Database is closed", SQLITE_MISUSE, exception);
        Napi::Function cb = baton->callback.Value();
        // We don't call the actual callback, so we have to make sure that
        // the baton gets destroyed.
        delete baton;
        if (IS_FUNCTION(cb)) {
            Napi::Value argv[] = { exception };
            TRY_CATCH_CALL(Value(), cb, 1, argv);
        }
        else {
            Napi::Value argv[] = { Napi::String::New(env, "error"), exception };
            EMIT_EVENT(Value(), 2, argv);
        }
        return;
    }

    // !queue.empty() keeps the database queue FIFO. Without it, a
    // non-exclusive call dispatches immediately whenever locked is false,
    // even while an exclusive call (exec/close/wait/loadExtension) is
    // already waiting in the queue -- letting it overtake work it is
    // supposed to run after, and run concurrently with it. Parallel
    // throughput is unaffected: the queue is only non-empty once something
    // has had to wait.
    if (!IsOpen() || !queue.empty()
            || ((exclusiveHeld || exclusive || serialize) && pending > 0)) {
        queue.emplace(new Call(callback, baton, exclusive || serialize));
    }
    else {
        exclusiveHeld = exclusive;
        callback(baton);
    }
}

Database::Database(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Database>(info) {
    auto env = info.Env();

    if (info.Length() <= 0 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
        return;
    }
    auto filename = info[0].As<Napi::String>().Utf8Value();

    unsigned int pos = 1;

    int mode;
    if (info.Length() >= pos && info[pos].IsNumber() && OtherIsInt(info[pos].As<Napi::Number>())) {
        mode = info[pos++].As<Napi::Number>().Int32Value();
    }
    else {
        mode = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;
    }

    Napi::Function callback;
    if (info.Length() >= pos && info[pos].IsFunction()) {
        callback = info[pos++].As<Napi::Function>();
    }

    info.This().As<Napi::Object>().DefineProperty(Napi::PropertyDescriptor::Value("filename", info[0].As<Napi::String>(), napi_default));
    info.This().As<Napi::Object>().DefineProperty(Napi::PropertyDescriptor::Value("mode", Napi::Number::New(env, mode), napi_default));

    // Start opening the database.
    auto* baton = new OpenBaton(this, callback, filename.c_str(), mode);
    Work_BeginOpen(baton);
}

void Database::Work_BeginOpen(Baton* baton) {
    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.Open", Work_Open, Work_AfterOpen);
}

void Database::Work_Open(napi_env e, void* data) {
    auto* baton = static_cast<OpenBaton*>(data);
    auto* db = baton->db;

    // Kept for the ATTACH gate: whether URI filenames mean anything on
    // this connection is decided here, by this flag, and nowhere else.
    db->open_mode = baton->mode;

    baton->status = sqlite3_open_v2(
        baton->filename.c_str(),
        &db->_handle,
        baton->mode,
        NULL
    );

    if (baton->status != SQLITE_OK) {
        baton->message = std::string(sqlite3_errmsg(db->_handle));
        sqlite3_close(db->_handle);
        db->_handle = NULL;
    }
    else {
        // Set default database handle values.
        sqlite3_busy_timeout(db->_handle, 1000);
        // Extended result codes: step failures report e.g.
        // SQLITE_CONSTRAINT_UNIQUE instead of bare SQLITE_CONSTRAINT. The
        // JS error gains err.code (extended name), err.errno (extended
        // int) and err.primaryCode (primary name).
        sqlite3_extended_result_codes(db->_handle, 1);
        // Belt-and-braces: the C-API extension gate is explicitly off from
        // the start. Observed on the vendored 3.53.4 (probed, not cited):
        // SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION reads false on a fresh
        // open and maps to the C-API flag only — the SQL load_extension()
        // function is gated by a second flag (SQLITE_LoadExtFunc) that
        // only sqlite3_enable_load_extension() sets, so the SQL function
        // is unreachable here even after setting this DBCONFIG to 1.
        // Setting 0 anyway makes the C-API state deterministic for source
        // builds that compile with SQLITE_ENABLE_LOAD_EXTENSION, which
        // turns the C-API flag on by default. loadExtension() re-enables
        // the C API for the duration of its call and disables it after.
        sqlite3_db_config(db->_handle, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
            0, NULL);
    }
}

void Database::Work_AfterOpen(napi_env e, napi_status status, void* data) {
    std::unique_ptr<OpenBaton> baton(static_cast<OpenBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);

    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    // Drains the queue even when the completion callback below throws
    // (TRY_CATCH_CALL's early return). After a *failed* open the
    // connection is Closed by the failure branch below, so this same
    // drain fails everything queued behind the open with the open's own
    // error. The 'open' event still fires before the drain, as before.
    ProcessGuard process_on_exit(db);

    Napi::Value argv[1];
    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        argv[0] = exception;
        // A failed open is terminal: the connection will never become
        // usable, so it lands in Closed — and work already queued behind
        // the open (scheduled while it was still Opening) is failed by the
        // ProcessGuard drain below with this same error instead of
        // stranding in a queue Process() never dispatches from.
        db->open_failed = true;
        db->open_error_message = baton->message;
        db->open_error_status = baton->status;
        db->db_state = DbState::Closed;
    }
    else {
        db->db_state = DbState::Open;
        argv[0] = env.Null();
    }

    Napi::Function cb = baton->callback.Value();

    if (IS_FUNCTION(cb)) {
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
    }
    else if (db->db_state != DbState::Open) {
        Napi::Value info[] = { Napi::String::New(env, "error"), argv[0] };
        EMIT_EVENT(db->Value(), 2, info);
    }

    if (db->db_state == DbState::Open) {
        Napi::Value info[] = { Napi::String::New(env, "open") };
        EMIT_EVENT(db->Value(), 1, info);
    }
}

Napi::Value Database::Open(const Napi::CallbackInfo& info) {
    auto env = this->Env();
    auto* db = this;
    return Napi::Boolean::New(env, db->IsOpen());
}

Napi::Value Database::IntegerModeGetter(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    switch (integer_mode) {
        case INTEGER_BIGINT: return Napi::String::New(env, "bigint");
        case INTEGER_MIXED:  return Napi::String::New(env, "mixed");
        default:             return Napi::String::New(env, "number");
    }
}

Napi::Value Database::StateGetter(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Napi::Object snapshot = Napi::Object::New(env);
    snapshot.Set("open", Napi::Boolean::New(env, IsOpen()));
    snapshot.Set("closing", Napi::Boolean::New(env, db_state == DbState::Closing));
    snapshot.Set("locked", Napi::Boolean::New(env, exclusiveHeld));
    snapshot.Set("serialized", Napi::Boolean::New(env, serialize));
    snapshot.Set("pending", Napi::Number::New(env, pending));
    snapshot.Set("queued", Napi::Number::New(env, static_cast<double>(queue.size())));
    snapshot.Freeze();
    return snapshot;
}

Napi::Value Database::ClosingGetter(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), db_state == DbState::Closing);
}

Napi::Value Database::LockedGetter(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), exclusiveHeld);
}

Napi::Value Database::SerializedGetter(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), serialize);
}

Napi::Value Database::PendingGetter(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), pending);
}

Napi::Value Database::QueuedGetter(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(queue.size()));
}

Napi::Value Database::QueueBusy(const Napi::CallbackInfo& info) {
    // A cached statement operation bypasses Database::Schedule entirely, so
    // it would otherwise run straight past anything waiting here.
    bool busy = db_state == DbState::Closing || !queue.empty()
        || (exclusiveHeld && pending > 0);
    return Napi::Boolean::New(info.Env(), busy);
}

Napi::Value Database::Close(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;
    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

   auto* baton = new Baton(db, callback);
    db->Schedule(Work_BeginClose, baton, true);

    return info.This();
}

void Database::Work_BeginClose(Baton* baton) {
    assert(baton->db->exclusiveHeld);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(baton->db->pending == 0);

    baton->db->pending++;
    baton->db->RemoveCallbacks();
    // Registered JS functions must not survive to sqlite3_close: they
    // capture this Database and fire from whatever thread touches the
    // handle. Main-thread here, with nothing in flight — the same
    // conditions RemoveCallbacks relies on for the hooks. The authorizer
    // and progress handler are unregistered for the same reason (both can
    // fire from the implicit work close performs). Sessions and blob
    // handles are torn down for the same lifetime reason: both hold
    // native objects sqlite3_close would leave dangling.
    baton->db->RemoveUserFunctions();
    baton->db->RemoveAuthorizer();
    baton->db->RemoveProgressHandler();
    baton->db->RemovePreupdateHook();
    baton->db->CloseLiveSessions();
    baton->db->CloseLiveBlobs();
    baton->db->ReleaseJsChannelIfIdle();
    baton->db->db_state = DbState::Closing;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.Close", Work_Close, Work_AfterClose);
}

void Database::Work_Close(napi_env e, void* data) {
    auto* baton = static_cast<Baton*>(data);
    auto* db = baton->db;

    baton->status = sqlite3_close(db->_handle);

    if (baton->status != SQLITE_OK) {
        baton->message = std::string(sqlite3_errmsg(db->_handle));
    }
    else {
        db->_handle = NULL;
    }
}

void Database::Work_AfterClose(napi_env e, napi_status status, void* data) {
    std::unique_ptr<Baton> baton(static_cast<Baton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);

    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    // The exclusive close released the database either way.
    db->exclusiveHeld = false;

    // Drains the queue even when the completion callback below throws
    // (TRY_CATCH_CALL's early return), and on the failed-close path —
    // work queued behind the close used to sit undispatched forever
    // there too. The 'close' event still fires before the drain.
    ProcessGuard process_on_exit(db);

    Napi::Value argv[1];
    if (baton->status != SQLITE_OK) {
        // The close failed (e.g. SQLITE_BUSY from outstanding
        // statements): the connection is still open and usable.
        db->db_state = DbState::Open;
        EXCEPTION(baton->message, baton->status, exception);
        argv[0] = exception;
    }
    else {
        db->db_state = DbState::Closed;
        argv[0] = env.Null();
    }

    Napi::Function cb = baton->callback.Value();

    // Fire callbacks.
    if (IS_FUNCTION(cb)) {
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
    }
    else if (db->IsOpen()) {
        Napi::Value info[] = { Napi::String::New(env, "error"), argv[0] };
        EMIT_EVENT(db->Value(), 2, info);
    }

    if (!db->IsOpen()) {
        Napi::Value info[] = { Napi::String::New(env, "close") };
        EMIT_EVENT(db->Value(), 1, info);
    }
}

Napi::Value Database::Serialize(const Napi::CallbackInfo& info) {
    auto env = this->Env();
    auto* db = this;
    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    bool before = db->serialize;
    db->serialize = true;

    if (!callback.IsEmpty() && callback.IsFunction()) {
        TRY_CATCH_CALL(info.This(), callback, 0, NULL, info.This());
        db->serialize = before;
    }

    db->Process();

    return info.This();
}

Napi::Value Database::Parallelize(const Napi::CallbackInfo& info) {
    auto env = this->Env();
    auto* db = this;
    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    auto before = db->serialize;
    db->serialize = false;

    if (!callback.IsEmpty() && callback.IsFunction()) {
        TRY_CATCH_CALL(info.This(), callback, 0, NULL, info.This());
        db->serialize = before;
    }

    db->Process();

    return info.This();
}

Napi::Value Database::Configure(const Napi::CallbackInfo& info) {
    auto env = this->Env();
    auto* db = this;

    REQUIRE_ARGUMENTS(2);

    Napi::Function handle;
    // The JS layer calls configure(type, true) for every addListener and
    // (type, false) when the last listener is gone, so the register
    // handlers SET the hook state rather than toggling it (toggling
    // uninstalled the hook on the second listener — a pre-v9 latent bug
    // the multi-listener tests pin).
    auto hook_enable = [&]() -> bool {
        if (info[1].IsBoolean()) return info[1].As<Napi::Boolean>().Value();
        return true;
    };
    if (info[0].StrictEquals( Napi::String::New(env, "trace"))) {
        auto* baton = new HookBaton(db, handle, hook_enable());
        db->Schedule(RegisterTraceCallback, baton);
    }
    else if (info[0].StrictEquals( Napi::String::New(env, "profile"))) {
        auto* baton = new HookBaton(db, handle, hook_enable());
        db->Schedule(RegisterProfileCallback, baton);
    }
    else if (info[0].StrictEquals( Napi::String::New(env, "busyTimeout"))) {
        if (!info[1].IsNumber()) {
            Napi::TypeError::New(env, "Value must be an integer").ThrowAsJavaScriptException();
            return env.Null();
        }
       auto* baton = new Baton(db, handle);
        baton->timeout = info[1].As<Napi::Number>().Int32Value();
        db->Schedule(SetBusyTimeout, baton);
    }
    else if (info[0].StrictEquals( Napi::String::New(env, "limit"))) {
        REQUIRE_ARGUMENTS(3);
        if (!info[1].IsNumber()) {
            Napi::TypeError::New(env, "limit id must be an integer").ThrowAsJavaScriptException();
            return env.Null();
        }
        if (!info[2].IsNumber()) {
            Napi::TypeError::New(env, "limit value must be an integer").ThrowAsJavaScriptException();
            return env.Null();
        }
        int id = info[1].As<Napi::Number>().Int32Value();
        int value = info[2].As<Napi::Number>().Int32Value();
        Baton* baton = new LimitBaton(db, handle, id, value);
        db->Schedule(SetLimit, baton);
    }
    else if (info[0].StrictEquals(Napi::String::New(env, "integerMode"))) {
        // Pure JS-side marshalling state: applied immediately, no sqlite
        // handle access, so unlike the other options it needs no baton.
        if (!info[1].IsString()) {
            Napi::TypeError::New(env,
                "integerMode must be one of 'number', 'bigint', 'mixed'"
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
        std::string mode = info[1].As<Napi::String>().Utf8Value();
        if (mode == "number") {
            integer_mode = INTEGER_NUMBER;
        }
        else if (mode == "bigint") {
            integer_mode = INTEGER_BIGINT;
        }
        else if (mode == "mixed") {
            integer_mode = INTEGER_MIXED;
        }
        else {
            Napi::TypeError::New(env,
                "integerMode must be one of 'number', 'bigint', 'mixed'"
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
    }
    else if (info[0].StrictEquals(Napi::String::New(env, "change"))) {
        auto* baton = new HookBaton(db, handle, hook_enable());
        db->Schedule(RegisterUpdateCallback, baton);
    }
    else if (info[0].StrictEquals(Napi::String::New(env, "commit"))) {
        auto* baton = new HookBaton(db, handle, hook_enable());
        db->Schedule(RegisterCommitCallback, baton);
    }
    else if (info[0].StrictEquals(Napi::String::New(env, "rollback"))) {
        auto* baton = new HookBaton(db, handle, hook_enable());
        db->Schedule(RegisterRollbackCallback, baton);
    }
    else if (info[0].StrictEquals(Napi::String::New(env, "wal"))) {
        auto* baton = new HookBaton(db, handle, hook_enable());
        db->Schedule(RegisterWalCallback, baton);
    }
    else if (info[0].StrictEquals(Napi::String::New(env, "preupdate"))) {
        auto* baton = new HookBaton(db, handle, hook_enable());
        db->Schedule(RegisterPreupdateCallback, baton);
    }
    else {
        Napi::TypeError::New(env,
            info[0].As<Napi::String>().Utf8Value() +
            " is not a valid configuration option"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }

    db->Process();

    return info.This();
}

Napi::Value Database::Interrupt(const Napi::CallbackInfo& info) {
    auto env = this->Env();
    auto* db = this;

    if (!db->IsOpen()) {
        Napi::Error::New(env, "Database is not open").ThrowAsJavaScriptException();
        return env.Null();
    }

    if (db->db_state == DbState::Closing) {
        Napi::Error::New(env, "Database is closing").ThrowAsJavaScriptException();
        return env.Null();
    }

    sqlite3_interrupt(db->_handle);
    return info.This();
}

void Database::SetBusyTimeout(Baton* b) {
    auto baton = std::unique_ptr<Baton>(b);

    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(SetBusyTimeout, baton.release(), true);
        return;
    }

    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    // Nothing in flight: the deferral above guarantees it, and the sqlite
    // call below would otherwise race a worker for the connection mutex.
    assert(!baton->db->MayBlockOnWorkerRoundTrip());

    sqlite3_busy_timeout(baton->db->_handle, baton->timeout);

    // Exclusive when deferred: hand the database back.
    baton->db->exclusiveHeld = false;
    baton->db->Process();
}

void Database::SetLimit(Baton* b) {
    std::unique_ptr<LimitBaton> baton(static_cast<LimitBaton*>(b));

    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(SetLimit, baton.release(), true);
        return;
    }

    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(!baton->db->MayBlockOnWorkerRoundTrip());

    sqlite3_limit(baton->db->_handle, baton->id, baton->value);

    baton->db->exclusiveHeld = false;
    baton->db->Process();
}

// Recompute the sqlite3_trace_v2 mask from the registered JS hooks and
// (un)install the single native callback accordingly.
void Database::UpdateTraceMask(Database* db, sqlite3* handle) {
    unsigned int mask = 0;
    if (db->debug_trace != NULL)   mask |= SQLITE_TRACE_STMT;
    if (db->debug_profile != NULL) mask |= SQLITE_TRACE_PROFILE;
    if (mask != 0) {
        sqlite3_trace_v2(handle, mask, Database::TraceV2Callback, db);
    }
    else {
        sqlite3_trace_v2(handle, 0, NULL, NULL);
    }
}

void Database::RegisterTraceCallback(Baton* b) {
    auto baton = std::unique_ptr<HookBaton>(static_cast<HookBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(RegisterTraceCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    // Nothing in flight: the deferral above guarantees it, and the sqlite
    // call below would otherwise race a worker for the connection mutex.
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->enable && db->debug_trace == NULL) {
        db->debug_trace = new AsyncTrace(db, TraceCallback);
    }
    else if (!baton->enable && db->debug_trace != NULL) {
        db->debug_trace->finish();
        db->debug_trace = NULL;
    }
    UpdateTraceMask(db, db->_handle);

    // Only now: Process() dispatches queued statement work, and the moment
    // it does a worker may be inside a round trip holding the connection
    // mutex that sqlite3_trace_v2 above needs. Releasing first would put
    // this thread back in exactly the deadlock the deferral above exists
    // to avoid.
    db->exclusiveHeld = false;
    db->Process();
}

// Note: This function is called in the sqlite worker thread.
int Database::TraceV2Callback(unsigned int type, void* ctx, void* p, void* x) {
    auto* db = static_cast<Database*>(ctx);

    if (type == SQLITE_TRACE_STMT && db->debug_trace != NULL) {
        char* sql = sqlite3_expanded_sql(static_cast<sqlite3_stmt*>(p));
        if (sql != NULL) {
            db->debug_trace->send(new std::string(sql));
            sqlite3_free(sql);
        }
    }
    else if (type == SQLITE_TRACE_PROFILE && db->debug_profile != NULL) {
        auto* info = new ProfileInfo();
        char* sql = sqlite3_expanded_sql(static_cast<sqlite3_stmt*>(p));
        info->sql = sql != NULL ? std::string(sql) : std::string();
        if (sql != NULL) sqlite3_free(sql);
        info->nsecs = *static_cast<sqlite3_int64*>(x);
        db->debug_profile->send(info);
    }

    return SQLITE_OK;
}

void Database::TraceCallback(Database* db, std::string* s) {
    std::unique_ptr<std::string> sql(s);
    // Note: This function is called in the main V8 thread.
    auto env = db->Env();
    Napi::HandleScope scope(env);

    Napi::Value argv[] = {
        Napi::String::New(env, "trace"),
        Napi::String::New(env, sql->c_str())
    };
    EMIT_EVENT(db->Value(), 2, argv);
}

void Database::RegisterProfileCallback(Baton* b) {
    auto baton = std::unique_ptr<HookBaton>(static_cast<HookBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(RegisterProfileCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    // Nothing in flight: the deferral above guarantees it, and the sqlite
    // call below would otherwise race a worker for the connection mutex.
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->enable && db->debug_profile == NULL) {
        db->debug_profile = new AsyncProfile(db, ProfileCallback);
    }
    else if (!baton->enable && db->debug_profile != NULL) {
        db->debug_profile->finish();
        db->debug_profile = NULL;
    }
    UpdateTraceMask(db, db->_handle);

    // Release only after the sqlite call; see RegisterTraceCallback.
    db->exclusiveHeld = false;
    db->Process();
}

void Database::ProfileCallback(Database *db, ProfileInfo* i) {
    auto info = std::unique_ptr<ProfileInfo>(i);
    auto env = db->Env();
    Napi::HandleScope scope(env);

    Napi::Value argv[] = {
        Napi::String::New(env, "profile"),
        Napi::String::New(env, info->sql.c_str()),
        Napi::Number::New(env, (double)info->nsecs / 1000000.0)
    };
    EMIT_EVENT(db->Value(), 3, argv);
}

void Database::EnsureTxnChannel(Database* db) {
    if (db->txn_event == NULL) {
        db->txn_event = new AsyncUpdate(db, TxnCallback);
    }
}

void Database::MaybeDropTxnChannel(Database* db) {
    if (db->txn_event != NULL && !db->hook_change && !db->hook_commit
            && !db->hook_rollback) {
        db->txn_event->finish();
        db->txn_event = NULL;
    }
}

void Database::RegisterUpdateCallback(Baton* b) {
    auto baton = std::unique_ptr<HookBaton>(static_cast<HookBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(RegisterUpdateCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    // Nothing in flight: the deferral above guarantees it, and the sqlite
    // call below would otherwise race a worker for the connection mutex.
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->enable != db->hook_change) {
        db->hook_change = baton->enable;
        if (baton->enable) {
            EnsureTxnChannel(db);
            sqlite3_update_hook(db->_handle, UpdateCallback, db);
        }
        else {
            sqlite3_update_hook(db->_handle, NULL, NULL);
            MaybeDropTxnChannel(db);
        }
    }

    // Release only after the sqlite call; see RegisterTraceCallback.
    db->exclusiveHeld = false;
    db->Process();
}

void Database::RegisterCommitCallback(Baton* b) {
    auto baton = std::unique_ptr<HookBaton>(static_cast<HookBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(RegisterCommitCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->enable != db->hook_commit) {
        db->hook_commit = baton->enable;
        if (baton->enable) {
            EnsureTxnChannel(db);
            sqlite3_commit_hook(db->_handle, CommitHook, db);
        }
        else {
            sqlite3_commit_hook(db->_handle, NULL, NULL);
            MaybeDropTxnChannel(db);
        }
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::RegisterRollbackCallback(Baton* b) {
    auto baton = std::unique_ptr<HookBaton>(static_cast<HookBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(RegisterRollbackCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->enable != db->hook_rollback) {
        db->hook_rollback = baton->enable;
        if (baton->enable) {
            EnsureTxnChannel(db);
            sqlite3_rollback_hook(db->_handle, RollbackHook, db);
        }
        else {
            sqlite3_rollback_hook(db->_handle, NULL, NULL);
            MaybeDropTxnChannel(db);
        }
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::RegisterWalCallback(Baton* b) {
    auto baton = std::unique_ptr<HookBaton>(static_cast<HookBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(RegisterWalCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->enable && db->wal_event == NULL) {
        db->wal_event = new AsyncWal(db, WalCallback);
        sqlite3_wal_hook(db->_handle, WalHook, db);
    }
    else if (!baton->enable && db->wal_event != NULL) {
        sqlite3_wal_hook(db->_handle, NULL, NULL);
        db->wal_event->finish();
        db->wal_event = NULL;
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::UpdateCallback(void* db, int type, const char* database,
        const char* table, sqlite3_int64 rowid) {
    // Note: This function is called in the thread pool.
    // Note: Some queries, such as "EXPLAIN" queries, are not sent through this.
    auto* handle = static_cast<Database*>(db);
    if (handle->txn_event == NULL) return; // removed / closing
    auto* info = new UpdateInfo();
    info->kind = UpdateInfo::kChange;
    info->type = type;
    info->database = std::string(database);
    info->table = std::string(table);
    info->rowid = rowid;
    handle->txn_event->send(info);
}

// Runs on the thread executing the COMMIT. The commit itself has already
// happened when sqlite calls this; the return value is advisory-only by
// design (see database.h) — always "proceed".
int Database::CommitHook(void* ctx) {
    auto* db = static_cast<Database*>(ctx);
    if (db->txn_event == NULL) return SQLITE_OK;
    auto* info = new UpdateInfo();
    info->kind = UpdateInfo::kCommit;
    db->txn_event->send(info);
    return SQLITE_OK;
}

// Runs on the thread executing the ROLLBACK (including the implicit
// rollback of a close, and of a rolled-back savepoint release).
void Database::RollbackHook(void* ctx) {
    auto* db = static_cast<Database*>(ctx);
    if (db->txn_event == NULL) return;
    auto* info = new UpdateInfo();
    info->kind = UpdateInfo::kRollback;
    db->txn_event->send(info);
}

// Runs on the thread committing a write into the WAL. Returning nonzero
// would prevent the automatic checkpoint; the event is observational, so
// the checkpoint always proceeds.
int Database::WalHook(void* ctx, sqlite3* /*handle*/, const char* database,
        int pages) {
    auto* db = static_cast<Database*>(ctx);
    if (db->wal_event == NULL) return SQLITE_OK;
    auto* info = new WalInfo();
    info->database = std::string(database != NULL ? database : "");
    info->pages = pages;
    db->wal_event->send(info);
    return SQLITE_OK;
}

void Database::TxnCallback(Database* db, UpdateInfo* i) {
    auto info = std::unique_ptr<UpdateInfo>(i);
    // Note: This function is called in the main V8 thread.
    auto env = db->Env();
    Napi::HandleScope scope(env);

    if (info->kind == UpdateInfo::kCommit) {
        Napi::Value argv[] = { Napi::String::New(env, "commit") };
        EMIT_EVENT(db->Value(), 1, argv);
        return;
    }
    if (info->kind == UpdateInfo::kRollback) {
        Napi::Value argv[] = { Napi::String::New(env, "rollback") };
        EMIT_EVENT(db->Value(), 1, argv);
        return;
    }
    Napi::Value argv[] = {
        Napi::String::New(env, "change"),
        Napi::String::New(env, sqlite_authorizer_string(info->type)),
        Napi::String::New(env, info->database.c_str()),
        Napi::String::New(env, info->table.c_str()),
        Napi::Number::New(env, info->rowid),
    };
    EMIT_EVENT(db->Value(), 5, argv);
}

void Database::WalCallback(Database* db, WalInfo* i) {
    auto info = std::unique_ptr<WalInfo>(i);
    auto env = db->Env();
    Napi::HandleScope scope(env);

    Napi::Value argv[] = {
        Napi::String::New(env, "wal"),
        Napi::String::New(env, info->database.c_str()),
        Napi::Number::New(env, info->pages)
    };
    EMIT_EVENT(db->Value(), 3, argv);
}

// --- Preupdate event (Deliverable 08) ----------------------------------------

void Database::RegisterPreupdateCallback(Baton* b) {
    auto baton = std::unique_ptr<HookBaton>(static_cast<HookBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(RegisterPreupdateCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    // Nothing in flight: the deferral above guarantees it, and the sqlite
    // call below would otherwise race a worker for the connection mutex.
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->enable != db->hook_preupdate) {
        if (baton->enable) {
            // The preupdate hook slot is shared with the session
            // extension (see src/session.h): refuse loudly while a
            // session is tracked rather than letting sqlite3session_*
            // silently displace our hook — or ours displace theirs.
            if (!db->live_sessions.empty()) {
                Napi::Env env = db->Env();
                Napi::HandleScope scope(env);
                EXCEPTION("cannot register a 'preupdate' listener while a "
                    "session is open on this connection: both use "
                    "SQLite's single preupdate hook, and one would "
                    "silently stop the other. Close the session first",
                    SQLITE_MISUSE, exception);
                Napi::Value info[] = {
                    Napi::String::New(env, "error"), exception
                };
                EMIT_EVENT(db->Value(), 2, info);
            }
            else {
                db->preupdate_event = new AsyncPreupdate(db,
                    PreupdateCallback);
                sqlite3_preupdate_hook(db->_handle, PreupdateTrampoline, db);
                db->hook_preupdate = true;
            }
        }
        else {
            // Unregister before finishing the channel so no event can be
            // in flight for it.
            sqlite3_preupdate_hook(db->_handle, NULL, NULL);
            db->preupdate_event->finish();
            db->preupdate_event = NULL;
            db->hook_preupdate = false;
        }
    }

    // Release only after the sqlite call; see RegisterTraceCallback.
    db->exclusiveHeld = false;
    db->Process();
}

// Note: called in the thread performing the write — the libuv worker for
// asynchronous statements, or the JS thread inside the *Sync methods.
void Database::PreupdateTrampoline(void* ctx, sqlite3* handle, int op,
        const char* database, const char* table, sqlite3_int64 key1,
        sqlite3_int64 key2) {
    auto* db = static_cast<Database*>(ctx);
    if (db->preupdate_event == NULL) return; // removed / closing

    // sqlite3_preupdate_old/new are only valid inside this callback, so
    // the row values are materialised eagerly here — the Async bridge
    // defers the JS event to the loop thread, and a half-filled container
    // must never be what JS observes. Both row vectors are fully sized
    // before any element is converted.
    auto* info = new PreupdateInfo();
    info->op = op;
    info->database = database != NULL ? database : "";
    info->table = table != NULL ? table : "";
    info->key1 = key1;
    info->key2 = key2;

    int n_col = sqlite3_preupdate_count(handle);
    if (op != SQLITE_INSERT) {
        info->old_row.resize(n_col);
        for (int i = 0; i < n_col; i++) {
            sqlite3_value* v = NULL;
            if (sqlite3_preupdate_old(handle, i, &v) == SQLITE_OK
                    && v != NULL) {
                ValueToCell(&info->old_row[i], v);
            }
        }
    }
    if (op != SQLITE_DELETE) {
        info->new_row.resize(n_col);
        for (int i = 0; i < n_col; i++) {
            sqlite3_value* v = NULL;
            if (sqlite3_preupdate_new(handle, i, &v) == SQLITE_OK
                    && v != NULL) {
                ValueToCell(&info->new_row[i], v);
            }
        }
    }

    db->preupdate_event->send(info);
}

void Database::PreupdateCallback(Database* db, PreupdateInfo* i) {
    auto info = std::unique_ptr<PreupdateInfo>(i);
    // Note: called in the main V8 thread.
    auto env = db->Env();
    Napi::HandleScope scope(env);

    Napi::Object payload = Napi::Object::New(env);
    payload.Set("op",
        Napi::String::New(env, sqlite_authorizer_string(info->op)));
    payload.Set("database",
        Napi::String::New(env, info->database.c_str()));
    payload.Set("table", Napi::String::New(env, info->table.c_str()));
    // key1 is the rowid being inserted/deleted/updated; key2 carries the
    // new rowid only for a rowid-changing UPDATE. INSERT therefore has no
    // old rowid to report.
    payload.Set("oldRowid", info->op == SQLITE_INSERT
        ? env.Null()
        : ConvertInt64ToJS(env, info->key1, db->integer_mode,
            "the preupdate oldRowid"));
    payload.Set("rowid", ConvertInt64ToJS(env,
        info->op == SQLITE_UPDATE ? info->key2 : info->key1,
        db->integer_mode, "the preupdate rowid"));

    // A blob write fires the hook as SQLITE_DELETE (the new values are
    // not yet available); old/new stay op-gated so JS sees the same
    // INSERT=new-only / DELETE=old-only / UPDATE=both shape regardless.
    const int mode = db->integer_mode;
    auto row_to_array = [&](Row& cells, const char* what) -> Napi::Value {
        Napi::Array out = Napi::Array::New(env, cells.size());
        for (size_t idx = 0; idx < cells.size(); idx++) {
            out.Set(idx, CellToJS(env, cells[idx], mode, what));
            if (env.IsExceptionPending()) return env.Null();
        }
        return out;
    };
    if (info->op != SQLITE_INSERT) {
        payload.Set("oldRow",
            row_to_array(info->old_row, "a preupdate old row value"));
    }
    else {
        payload.Set("oldRow", env.Null());
    }
    if (info->op != SQLITE_DELETE) {
        payload.Set("newRow",
            row_to_array(info->new_row, "a preupdate new row value"));
    }
    else {
        payload.Set("newRow", env.Null());
    }

    Napi::Value argv[] = {
        Napi::String::New(env, "preupdate"),
        payload
    };
    EMIT_EVENT(db->Value(), 2, argv);
}

void Database::RemovePreupdateHook() {
    // Main-thread, nothing in flight (Work_BeginClose / ~Database). The
    // sqlite hook is uninstalled before the channel is finished; sqlite
    // itself may still fire the hook during the implicit rollback of
    // sqlite3_close, by which point the channel is gone and the
    // trampoline drops the event — the update hook's contract.
    if (_handle != NULL && hook_preupdate) {
        sqlite3_preupdate_hook(_handle, NULL, NULL);
    }
    hook_preupdate = false;
    if (preupdate_event != NULL) {
        preupdate_event->finish();
        preupdate_event = NULL;
    }
}


// --- Authorizer ------------------------------------------------------------

namespace {

bool ValidAuthDecision(int v) {
    return v == SQLITE_OK || v == SQLITE_DENY || v == SQLITE_IGNORE;
}

// Reads one optional string field of a rule row: null/undefined/omitted
// become the match-anything flag; a string (including the empty string)
// is matched exactly.
bool ReadRuleString(const Napi::Value& value, std::string* out, bool* any) {
    if (value.IsNull() || value.IsUndefined()) {
        out->clear();
        *any = true;
        return true;
    }
    if (!value.IsString()) return false;
    *out = value.As<Napi::String>().Utf8Value();
    *any = false;
    return true;
}

// Element access with an explicit index type: a literal 0 in Get(0) is
// also a null-pointer constant and makes the const char* overload
// ambiguous.
inline Napi::Value At(const Napi::Array& a, uint32_t i) {
    return a.Get(i);
}

} // namespace

// _setAuthorizer(defaultDecision, rules) installs a policy;
// _setAuthorizer() / _setAuthorizer(null) removes it. rules is an array
// of [action, verdict, arg1, arg2, database, trigger] rows (action -1
// and null fields are wildcards; an explicitly-passed empty string
// matches only an empty argument); the JS layer orders deny rules
// before allow rules so a deny can never be overridden.
Napi::Value Database::SetAuthorizer(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    auto* baton = new AuthBaton(db, Napi::Function());
    if (info.Length() == 0 || info[0].IsNull() || info[0].IsUndefined()) {
        baton->remove = true;
    }
    else {
        if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArray()) {
            delete baton;
            Napi::TypeError::New(env,
                "authorizer policy must be a decision constant and a rule array"
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
        auto* policy = new AuthPolicy();
        policy->default_decision = info[0].As<Napi::Number>().Int32Value();
        if (!ValidAuthDecision(policy->default_decision)) {
            delete baton;
            delete policy;
            Napi::TypeError::New(env,
                "default decision must be sqlite3.OK, sqlite3.DENY or sqlite3.IGNORE"
            ).ThrowAsJavaScriptException();
            return env.Null();
        }
        Napi::Array rules = info[1].As<Napi::Array>();
        uint32_t count = rules.Length();
        policy->rules.reserve(count);
        for (uint32_t i = 0; i < count; i++) {
            Napi::Value row = rules.Get(i);
            if (!row.IsArray() || row.As<Napi::Array>().Length() != 6) {
                delete baton;
                delete policy;
                Napi::TypeError::New(env,
                    "authorizer rule " + std::to_string(i) +
                    " must be [action, verdict, arg1, arg2, database, trigger]"
                ).ThrowAsJavaScriptException();
                return env.Null();
            }
            Napi::Array parts = row.As<Napi::Array>();
            if (!At(parts, 0).IsNumber() || !At(parts, 1).IsNumber()) {
                delete baton;
                delete policy;
                Napi::TypeError::New(env,
                    "authorizer rule " + std::to_string(i) +
                    ": action and verdict must be numbers"
                ).ThrowAsJavaScriptException();
                return env.Null();
            }
            AuthRule rule;
            rule.action = At(parts, 0).As<Napi::Number>().Int32Value();
            rule.verdict = At(parts, 1).As<Napi::Number>().Int32Value();
            bool ok = ValidAuthDecision(rule.verdict)
                && ReadRuleString(At(parts, 2), &rule.arg1, &rule.arg1_any)
                && ReadRuleString(At(parts, 3), &rule.arg2, &rule.arg2_any)
                && ReadRuleString(At(parts, 4), &rule.database,
                    &rule.database_any)
                && ReadRuleString(At(parts, 5), &rule.trigger,
                    &rule.trigger_any);
            if (!ok) {
                delete baton;
                delete policy;
                Napi::TypeError::New(env,
                    "authorizer rule " + std::to_string(i) +
                    " has an invalid verdict (OK/DENY/IGNORE) or a non-string match field"
                ).ThrowAsJavaScriptException();
                return env.Null();
            }
            policy->rules.push_back(std::move(rule));
        }
        baton->policy = policy;
    }

    db->Schedule(Work_SetAuthorizer, baton, true);
    db->Process();

    return info.This();
}

void Database::Work_SetAuthorizer(Baton* b) {
    auto baton = std::unique_ptr<AuthBaton>(static_cast<AuthBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(Work_SetAuthorizer, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    // Nothing in flight: the deferral above guarantees it, and the sqlite
    // call below would otherwise race a worker for the connection mutex.
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    // The swap happens at pending == 0, so no prepare (the only context
    // the authorizer fires in) can be reading the old policy.
    AuthPolicy* old = db->auth_policy;
    if (baton->remove) {
        db->auth_policy = NULL;
        // The ATTACH gate shares this single sqlite authorizer slot: the
        // callback stays installed while the gate is armed, so removing a
        // declarative policy does not silently re-open ATTACH.
        if (!db->attach_gate) {
            sqlite3_set_authorizer(db->_handle, NULL, NULL);
        }
    }
    else {
        db->auth_policy = baton->policy;
        baton->policy = NULL; // ownership moved to the database
        sqlite3_set_authorizer(db->_handle, AuthorizerCallback, db);
    }
    delete old;

    db->exclusiveHeld = false;
    db->Process();
}

int Database::AuthorizerCallback(void* ctx, int action, const char* arg1,
        const char* arg2, const char* database, const char* trigger) {
    // Runs on whatever thread is inside sqlite3_prepare (or a step's
    // transparent re-prepare). Pure C matching — no JS, no round trip:
    // the policy is evaluated here precisely because a JS callback could
    // not return a value synchronously from this context.
    auto* db = static_cast<Database*>(ctx);

    // ATTACH gate pre-filter: SQLITE_ATTACH is also what VACUUM INTO
    // fires for its output file, so this one check closes both SQL-level
    // paths to the filesystem. Falls through to the declarative policy
    // when the target is allowed (a user policy may still deny it).
    if (db->attach_gate && action == SQLITE_ATTACH
            && !AttachTargetAllowed(db, arg1)) {
        return SQLITE_DENY;
    }

    const AuthPolicy* policy = db->auth_policy;
    if (policy == NULL) return SQLITE_OK;

    for (const auto& rule : policy->rules) {
        if (rule.action >= 0 && rule.action != action) continue;
        if (!rule.arg1_any && (arg1 == NULL || rule.arg1 != arg1)) continue;
        if (!rule.arg2_any && (arg2 == NULL || rule.arg2 != arg2)) continue;
        if (!rule.database_any
                && (database == NULL || rule.database != database)) continue;
        if (!rule.trigger_any
                && (trigger == NULL || rule.trigger != trigger)) continue;
        return rule.verdict;
    }
    return policy->default_decision;
}

void Database::RemoveAuthorizer() {
    // Main-thread, nothing in flight (Work_BeginClose / ~Database).
    if (_handle != NULL && (auth_policy != NULL || attach_gate)) {
        sqlite3_set_authorizer(_handle, NULL, NULL);
    }
    delete auth_policy;
    auth_policy = NULL;
    attach_gate = false;
    attach_allow.clear();
}

// --- ATTACH gate -------------------------------------------------------------

namespace {

// Lexical path comparison helpers for the gate: no syscalls, no symlink
// resolution — a differently-spelled target does not match (fail-closed).
bool PathEquals(const std::string& allowed, const char* arg1) {
    if (allowed == arg1) return true;
#ifndef _WIN32
    // POSIX only: '\' is an ordinary filename character, so normalising it
    // would *widen* the allowlist — an entry for "dir/x.db" would admit an
    // ATTACH of the distinct, never-permission-checked file "dir\x.db"
    // (verified: the backslash-spelled file was created and attached).
    // Exact match is the whole rule here.
    return false;
#else
    // Windows: a target may arrive with either separator while the
    // allowlist entry (a JS string) uses the other.
    if (allowed.find('\\') == std::string::npos
            && strchr(arg1, '\\') == NULL) {
        return false;
    }
    size_t n = allowed.size();
    if (strlen(arg1) != n) return false;
    for (size_t i = 0; i < n; i++) {
        char a = allowed[i];
        char b = arg1[i];
        if (a == '\\') a = '/';
        if (b == '\\') b = '/';
        if (a != b) return false;
    }
    return true;
#endif
}

// The process cwd, for making a relative ATTACH target comparable against
// absolute allowlist entries. Empty when unavailable, in which case
// relative targets simply do not match (fail-closed).
std::string CurrentWorkingDir() {
    char buf[4096];
#ifdef _WIN32
    const char* got = _getcwd(buf, sizeof(buf));
#else
    const char* got = getcwd(buf, sizeof(buf));
#endif
    return got != NULL ? std::string(got) : std::string();
}

} // namespace

// _setAttachGate(enabled, allowPaths) arms/disarms the gate. The JS layer
// has already permission-checked every allowlist entry against Node's
// permission model; here the entries are only matched. Exclusive, with the
// same MayBlockOnWorkerRoundTrip deferral as the authorizer: it takes the
// connection mutex to install/remove the sqlite authorizer.
Napi::Value Database::SetAttachGate(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    auto* baton = new AttachGateBaton(db, Napi::Function());
    if (info.Length() >= 1 && (info[0].IsBoolean() || info[0].IsNumber())) {
        bool enable = info[0].IsBoolean()
            ? info[0].As<Napi::Boolean>().Value()
            : info[0].As<Napi::Number>().Int32Value() != 0;
        baton->enable = enable;
        if (enable) {
            if (info.Length() < 2 || !info[1].IsArray()) {
                delete baton;
                Napi::TypeError::New(env,
                    "attach gate requires an array of allowed paths"
                ).ThrowAsJavaScriptException();
                return env.Null();
            }
            Napi::Array allow = info[1].As<Napi::Array>();
            uint32_t count = allow.Length();
            baton->allow.reserve(count);
            for (uint32_t i = 0; i < count; i++) {
                Napi::Value entry = allow.Get(i);
                if (!entry.IsString()) {
                    delete baton;
                    Napi::TypeError::New(env,
                        "allowed attach path " + std::to_string(i) +
                        " must be a string"
                    ).ThrowAsJavaScriptException();
                    return env.Null();
                }
                baton->allow.push_back(entry.As<Napi::String>().Utf8Value());
            }
        }
    }
    else {
        delete baton;
        Napi::TypeError::New(env,
            "attach gate expects (enabled, allowedPaths)"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }

    db->Schedule(Work_SetAttachGate, baton, true);
    db->Process();

    return info.This();
}

void Database::Work_SetAttachGate(Baton* b) {
    auto baton = std::unique_ptr<AttachGateBaton>(
        static_cast<AttachGateBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(Work_SetAttachGate, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    // Nothing in flight: the deferral above guarantees it, and the sqlite
    // call below would otherwise race a worker for the connection mutex.
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    db->attach_gate = baton->enable;
    db->attach_allow = std::move(baton->allow);

    // One sqlite authorizer slot: install the shared callback when the
    // gate arms (unless a declarative policy already installed it), and
    // remove it when the gate disarms and no policy remains.
    if (db->attach_gate && db->auth_policy == NULL) {
        sqlite3_set_authorizer(db->_handle, AuthorizerCallback, db);
    }
    else if (!db->attach_gate && db->auth_policy == NULL) {
        sqlite3_set_authorizer(db->_handle, NULL, NULL);
    }

    db->exclusiveHeld = false;
    db->Process();
}

// Matches an ATTACH target (SQLITE_ATTACH arg1, the filename as written in
// the SQL or bound to it) against the allowlist: exact string, separator-
// normalised, or lexically joined with the process cwd for relative
// targets. No filesystem access, no realpath: matching is lexical on
// purpose, so the caller must ATTACH using a spelling the allowlist
// recognises.
bool Database::AttachTargetAllowed(const Database* db, const char* arg1) {
    if (arg1 == NULL) return false;
    // ':memory:' is the only spelling that touches no filesystem and so
    // cannot be an fs-permission bypass. ('' is NOT one: SQLite creates a
    // private temporary database backed by real files under the temp
    // directory, so it stays denied — fail-closed.)
    //
    if (strcmp(arg1, ":memory:") == 0) {
        return true;
    }
    // The URI memory forms are in-memory only on a connection opened with
    // SQLITE_OPEN_URI, which is opt-in per open (sqlite3.OPEN_URI) and is
    // not the default. Without it SQLite treats 'file:…' as an ordinary
    // filename, so accepting these unconditionally opened a hole instead
    // of closing one: verified — ATTACH 'file::memory:' on a default
    // connection created a real file of that literal name in the process
    // cwd, outside the allowlist, while the gate reported it as
    // in-memory. On a non-URI connection such a target falls through to
    // the allowlist match below, like any other filename.
    if ((db->open_mode & SQLITE_OPEN_URI) != 0
            && (sqlite3_strnicmp(arg1, "file::memory:", 13) == 0
                || (sqlite3_strnicmp(arg1, "file:", 5) == 0
                    && strstr(arg1, "mode=memory") != NULL))) {
        return true;
    }
    if (db->attach_allow.empty()) return false;
    for (const auto& allowed : db->attach_allow) {
        if (PathEquals(allowed, arg1)) return true;
    }
    // A relative target is compared against the cwd-joined spelling of
    // each absolute allowlist entry.
    if (arg1[0] == '/' || arg1[0] == '\\'
            || (isalpha(static_cast<unsigned char>(arg1[0])) && arg1[1] == ':')) {
        return false;
    }
    std::string cwd = CurrentWorkingDir();
    if (cwd.empty()) return false;
    std::string joined = cwd;
    if (joined.back() != '/' && joined.back() != '\\') joined += '/';
    joined += arg1;
    for (const auto& allowed : db->attach_allow) {
        if (PathEquals(allowed, joined.c_str())) return true;
    }
    return false;
}

// --- Progress handler / cancellation token ----------------------------------

static_assert(std::atomic<int32_t>::is_always_lock_free,
    "the cancellation token relies on lock-free cross-thread flag reads");

// _progressFlag(int32Array, period) installs the token form; the array is
// an Int32Array view over a SharedArrayBuffer (the stable napi surface
// has no SharedArrayBuffer accessors; the typed-array info call returns
// the shared backing pointer, and rooting the view roots the buffer).
// _progressFlag() removes whatever progress handler is installed.
Napi::Value Database::SetProgressFlag(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    if (info.Length() == 0 || info[0].IsNull() || info[0].IsUndefined()) {
        auto* baton = new ProgressFlagBaton(db, Napi::Function(), 0);
        db->Schedule(Work_SetProgressFlag, baton, true);
        db->Process();
        return info.This();
    }

    void* data = NULL;
    if (!info[0].IsTypedArray()) {
        Napi::TypeError::New(env,
            "cancellation token must be an Int32Array over a SharedArrayBuffer"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    napi_typedarray_type type;
    size_t length = 0, byte_offset = 0;
    napi_value backing = NULL;
    napi_status st = napi_get_typedarray_info(env, info[0],
        &type, &length, &data, &backing, &byte_offset);
    if (st != napi_ok || type != napi_int32_array || length < 1
            || data == NULL || backing == NULL) {
        Napi::TypeError::New(env,
            "cancellation token must be an Int32Array with at least one element"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    // The JS layer requires a SharedArrayBuffer backing store (it can
    // check; the stable napi surface cannot): that is what makes the flag
    // visible when it is set from a worker thread.
    if (info.Length() < 2 || !info[1].IsNumber()
            || info[1].As<Napi::Number>().Int32Value() < 1) {
        Napi::TypeError::New(env,
            "progress period must be a positive integer (VM instructions)"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* baton = new ProgressFlagBaton(db, Napi::Function(),
        info[1].As<Napi::Number>().Int32Value());
    baton->buffer = Napi::Persistent(info[0]);
    baton->flag = static_cast<std::atomic<int32_t>*>(data);
    db->Schedule(Work_SetProgressFlag, baton, true);
    db->Process();

    return info.This();
}

// _progressCallback(period, fn) installs the JS-callback form;
// _progressCallback() removes whatever progress handler is installed.
Napi::Value Database::SetProgressCallback(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    if (info.Length() == 0 || info[0].IsNull() || info[0].IsUndefined()
            || info[1].IsNull() || info[1].IsUndefined()) {
        auto* baton = new FunctionBaton(db, Napi::Function(), "", 0, 0);
        baton->nArg = -1; // sentinel: remove
        db->Schedule(Work_SetProgressCallback, baton, true);
        db->Process();
        return info.This();
    }

    if (!info[0].IsNumber() || info[0].As<Napi::Number>().Int32Value() < 1) {
        Napi::TypeError::New(env,
            "progress period must be a positive integer (VM instructions)"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    if (!info[1].IsFunction()) {
        Napi::TypeError::New(env,
            "progress callback must be a function"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }

    auto* baton = new FunctionBaton(db, Napi::Function(), "progress",
        info[0].As<Napi::Number>().Int32Value(), 0);
    baton->fn.Reset(info[1].As<Napi::Function>(), 1);
    db->Schedule(Work_SetProgressCallback, baton, true);
    db->Process();

    return info.This();
}

// Installs/updates the sqlite hook from the current state. Exclusive
// context: the handler's flag pointer and buffer reference are published
// only while nothing can be inside the handler.
void Database::ApplyProgressHandler(Database* db) {
    if (db->progress_mode == Database::ProgressMode::None) {
        sqlite3_progress_handler(db->_handle, 0, NULL, NULL);
    }
    else {
        sqlite3_progress_handler(db->_handle, db->progress_period,
            Database::ProgressHandler, db);
    }
}

void Database::Work_SetProgressFlag(Baton* b) {
    auto baton = std::unique_ptr<ProgressFlagBaton>(
        static_cast<ProgressFlagBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(Work_SetProgressFlag, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->buffer.IsEmpty()) {
        // Remove: unregister first, then drop the published state.
        db->progress_mode = ProgressMode::None;
        db->progress_flag = NULL;
        db->progress_buffer.Reset();
        ApplyProgressHandler(db);
    }
    else {
        // The flag form replaces the callback form (one sqlite slot).
        if (db->js_progress != NULL) {
            db->DropJsProgressHolder();
            db->ReleaseJsChannelIfIdle();
        }
        db->progress_flag = baton->flag;
        db->progress_buffer = std::move(baton->buffer);
        db->progress_mode = ProgressMode::Flag;
        db->progress_period = baton->period;
        ApplyProgressHandler(db);
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::Work_SetProgressCallback(Baton* b) {
    auto baton = std::unique_ptr<FunctionBaton>(static_cast<FunctionBaton*>(b));
    if (baton->db->MayBlockOnWorkerRoundTrip()) {
        baton->db->Schedule(Work_SetProgressCallback, baton.release(), true);
        return;
    }
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(!baton->db->MayBlockOnWorkerRoundTrip());
    auto* db = baton->db;

    if (baton->nArg == -1) {
        db->progress_mode = ProgressMode::None;
        db->progress_flag = NULL;
        db->progress_buffer.Reset();
        db->DropJsProgressHolder();
        ApplyProgressHandler(db);
        db->ReleaseJsChannelIfIdle();
    }
    else {
        if (!db->EnsureJsChannel()) {
            db->ReportRegistrationFailure(SQLITE_NOMEM);
        }
        else {
            JsFunc* old = db->js_progress;
            db->js_progress = new JsFunc(db, "progress", 0);
            db->js_progress->fn.Reset(baton->fn.Value(), 1);
            delete old;
            // The callback form replaces the flag form (one sqlite slot).
            db->progress_flag = NULL;
            db->progress_buffer.Reset();
            db->progress_mode = ProgressMode::Callback;
            db->progress_period = baton->nArg;
            ApplyProgressHandler(db);
        }
    }

    db->exclusiveHeld = false;
    db->Process();
}

void Database::DropJsProgressHolder() {
    if (js_progress != NULL) {
        JsFunc* fn = js_progress;
        js_progress = NULL;
        if (!fn->dead) {
            fn->dead = true;
            fn->fn.Reset();
            fn->db->Unref();
        }
        delete fn;
    }
}

void Database::RemoveProgressHandler() {
    // Main-thread, nothing in flight (Work_BeginClose / ~Database).
    if (_handle != NULL && progress_mode != ProgressMode::None) {
        sqlite3_progress_handler(_handle, 0, NULL, NULL);
    }
    progress_mode = ProgressMode::None;
    progress_period = 0;
    progress_flag = NULL;
    progress_buffer.Reset();
    DropJsProgressHolder();
}

// --- WAL checkpoints --------------------------------------------------------

// _checkpoint(dbName, mode, callback). Non-exclusive: concurrent statement
// work is serialized by the connection mutex inside sqlite, and a
// checkpoint racing readers is exactly what the busy flag reports.
Napi::Value Database::Checkpoint(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, database);
    REQUIRE_ARGUMENT_INTEGER(1, mode);
    OPTIONAL_ARGUMENT_FUNCTION(2, callback);

    auto* baton = new CheckpointBaton(db, callback, database.c_str(), mode);
    db->Schedule(Work_BeginCheckpoint, baton);

    return info.This();
}

void Database::Work_BeginCheckpoint(Baton* baton) {
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.Checkpoint", Work_Checkpoint, Work_AfterCheckpoint);
}

void Database::Work_Checkpoint(napi_env e, void* data) {
    auto* baton = static_cast<CheckpointBaton*>(data);

    baton->status = sqlite3_wal_checkpoint_v2(
        baton->db->_handle,
        baton->database.c_str(),
        baton->mode,
        &baton->log_frames,
        &baton->ckpt_frames
    );

    if (baton->status != SQLITE_OK && baton->status != SQLITE_BUSY) {
        baton->message = std::string(sqlite3_errmsg(baton->db->_handle));
    }
}

void Database::Work_AfterCheckpoint(napi_env e, napi_status status, void* data) {
    std::unique_ptr<CheckpointBaton> baton(static_cast<CheckpointBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    db->Process();

    // Calling Value() on a default-constructed (empty) FunctionReference
    // is undefined behaviour and fatals in practice. The dual-mode JS
    // wrappers always append a callback, so the raw no-callback form of
    // these internal entry points was never exercised until the untrusted
    // open path queued _dbConfig without one. IsEmpty() is a plain member
    // check — the same guard shape Statement::CleanQueue uses.
    if (baton->callback.IsEmpty()) return;
    Napi::Function cb = baton->callback.Value();
    if (!IS_FUNCTION(cb)) return;

    if (baton->status != SQLITE_OK && baton->status != SQLITE_BUSY) {
        EXCEPTION(baton->message, baton->status, exception);
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
        return;
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("busy", Napi::Boolean::New(env, baton->status == SQLITE_BUSY));
    result.Set("logFrames", Napi::Number::New(env, baton->log_frames));
    result.Set("checkpointedFrames",
        Napi::Number::New(env, baton->ckpt_frames));
    Napi::Value argv[] = { env.Null(), result };
    TRY_CATCH_CALL(db->Value(), cb, 2, argv);
}

// --- Table metadata ---------------------------------------------------------

// _tableInfo(dbName, table, callback): PRAGMA <db>.table_info(<table>) for
// the column order, cid and defaults, enriched per column with
// sqlite3_table_column_metadata (declared type, collation, autoincrement).
// The PRAGMA is subject to the installed authorizer — a deny-by-default
// policy must allow SQLITE_PRAGMA (and the SELECT family is not involved).
Napi::Value Database::TableInfo(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, database);
    REQUIRE_ARGUMENT_STRING(1, table);
    OPTIONAL_ARGUMENT_FUNCTION(2, callback);

    auto* baton = new TableInfoBaton(db, callback, database.c_str(), table.c_str());
    db->Schedule(Work_BeginTableInfo, baton);

    return info.This();
}

void Database::Work_BeginTableInfo(Baton* baton) {
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.TableInfo", Work_TableInfo, Work_AfterTableInfo);
}

void Database::Work_TableInfo(napi_env e, void* data) {
    auto* baton = static_cast<TableInfoBaton*>(data);
    auto* db = baton->db;

    // %Q quotes and escapes the identifier path; the schema name is
    // validated by the JS layer to the plain identifiers sqlite accepts.
    char* sql = sqlite3_mprintf("PRAGMA %s.table_info(%Q)",
        baton->database.c_str(), baton->table.c_str());
    if (sql == NULL) {
        baton->status = SQLITE_NOMEM;
        baton->message = "out of memory";
        return;
    }

    sqlite3_stmt* stmt = NULL;
    int rc = sqlite3_prepare_v2(db->_handle, sql, -1, &stmt, NULL);
    sqlite3_free(sql);
    if (rc != SQLITE_OK) {
        baton->status = rc;
        baton->message = std::string(sqlite3_errmsg(db->_handle));
        return;
    }

    baton->status = SQLITE_OK;
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        TableInfoBaton::Column col{};
        col.cid = sqlite3_column_int(stmt, 0);
        const char* name = (const char*)sqlite3_column_text(stmt, 1);
        col.name = name != NULL ? name : "";
        const char* type = (const char*)sqlite3_column_text(stmt, 2);
        col.type = type != NULL ? type : "";
        col.not_null = sqlite3_column_int(stmt, 3) != 0;
        const char* dflt = (const char*)sqlite3_column_text(stmt, 4);
        col.dflt = dflt != NULL ? dflt : "";
        col.pk = sqlite3_column_int(stmt, 5);

        // Enrich with the metadata API; failure here keeps the PRAGMA row
        // (e.g. a view, where there is no table metadata to read).
        const char* decl = NULL;
        const char* collate = NULL;
        int not_null = 0, pk = 0, autoinc = 0;
        int mrc = sqlite3_table_column_metadata(db->_handle,
            baton->database.c_str(), baton->table.c_str(), col.name.c_str(),
            &decl, &collate, &not_null, &pk, &autoinc);
        if (mrc == SQLITE_OK) {
            if (decl != NULL) col.type = decl;
            if (collate != NULL) col.collate = collate;
            col.not_null = not_null != 0;
            col.pk = pk;
            col.autoinc = autoinc != 0;
        }
        baton->columns.push_back(std::move(col));
    }
    if (rc != SQLITE_DONE) {
        baton->status = rc;
        baton->message = std::string(sqlite3_errmsg(db->_handle));
    }
    sqlite3_finalize(stmt);
}

void Database::Work_AfterTableInfo(napi_env e, napi_status status, void* data) {
    std::unique_ptr<TableInfoBaton> baton(static_cast<TableInfoBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    db->Process();

    // See Work_AfterCheckpoint: never call Value() on an empty reference.
    if (baton->callback.IsEmpty()) return;
    Napi::Function cb = baton->callback.Value();
    if (!IS_FUNCTION(cb)) return;

    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
        return;
    }

    Napi::Array result = Napi::Array::New(env, baton->columns.size());
    size_t i = 0;
    for (const auto& col : baton->columns) {
        Napi::Object row = Napi::Object::New(env);
        row.Set("cid", Napi::Number::New(env, col.cid));
        row.Set("name", Napi::String::New(env, col.name.c_str()));
        row.Set("type", Napi::String::New(env, col.type.c_str()));
        row.Set("notNull", Napi::Boolean::New(env, col.not_null));
        // The PRAGMA reports the default's literal SQL text or nothing;
        // an absent field (not a null one) says "no DEFAULT clause".
        if (!col.dflt.empty()) {
            row.Set("defaultValue", Napi::String::New(env, col.dflt.c_str()));
        }
        row.Set("primaryKey", Napi::Number::New(env, col.pk));
        row.Set("collate", Napi::String::New(env, col.collate.c_str()));
        row.Set("autoIncrement", Napi::Boolean::New(env, col.autoinc));
        result.Set(i++, row);
    }
    Napi::Value argv[] = { env.Null(), result };
    TRY_CATCH_CALL(db->Value(), cb, 2, argv);
}

// --- db_config subset ---------------------------------------------------------

// _dbConfig(op, value, callback). value 0/1 sets; -1 queries without
// changing. The callback receives the previous value. Exclusive: unlike
// a read, a set followed by a query must not be reordered by the
// parallel worker pool.
Napi::Value Database::DbConfig(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    REQUIRE_ARGUMENT_INTEGER(0, op);
    REQUIRE_ARGUMENT_INTEGER(1, value);
    OPTIONAL_ARGUMENT_FUNCTION(2, callback);

    auto* baton = new DbConfigBaton(db, callback, op, value);
    db->Schedule(Work_BeginDbConfig, baton, true);

    return info.This();
}

void Database::Work_BeginDbConfig(Baton* baton) {
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.DbConfig", Work_DbConfig, Work_AfterDbConfig);
}

void Database::Work_DbConfig(napi_env e, void* data) {
    auto* baton = static_cast<DbConfigBaton*>(data);

    // sqlite3_db_config's out pointer receives the value AFTER the new
    // one is applied (see the aFlagOp handling in the amalgamation), not
    // the prior value its docs describe. Query first so the callback
    // really sees the previous state, then apply.
    int applied = 0;
    baton->status = sqlite3_db_config(baton->db->_handle, baton->op,
        -1, &baton->previous);
    if (baton->status == SQLITE_OK && baton->value >= 0) {
        baton->status = sqlite3_db_config(baton->db->_handle, baton->op,
            baton->value, &applied);
    }
    if (baton->status != SQLITE_OK) {
        baton->message = std::string(sqlite3_errmsg(baton->db->_handle));
    }
}

void Database::Work_AfterDbConfig(napi_env e, napi_status status, void* data) {
    std::unique_ptr<DbConfigBaton> baton(static_cast<DbConfigBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    db->Process();

    // See Work_AfterCheckpoint: never call Value() on an empty reference.
    if (baton->callback.IsEmpty()) return;
    Napi::Function cb = baton->callback.Value();
    if (!IS_FUNCTION(cb)) return;

    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(db->Value(), cb, 1, argv);
        return;
    }
    Napi::Value argv[] = {
        env.Null(), Napi::Boolean::New(env, baton->previous != 0)
    };
    TRY_CATCH_CALL(db->Value(), cb, 2, argv);
}

// --- Change counters ----------------------------------------------------------

Napi::Value Database::ChangesGetter(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (!IsOpen() || _handle == NULL) {
        Napi::Error::New(env, "Database is not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    // A worker blocked mid-round-trip holds the connection mutex while
    // waiting for this very thread; reading the counter now would
    // deadlock. Everything else merely serializes on the mutex inside
    // sqlite, which is the ordinary main-thread sqlite cost.
    if (MayBlockOnWorkerRoundTrip()) {
        Napi::Error::New(env,
            "db.changes cannot be read while a JavaScript function, "
            "collation or progress callback is mid-call on this "
            "connection; read it from a callback or after the query"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    return ConvertInt64ToJS(env, sqlite3_changes64(_handle),
        integer_mode, "db.changes");
}

Napi::Value Database::TotalChangesGetter(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (!IsOpen() || _handle == NULL) {
        Napi::Error::New(env, "Database is not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (MayBlockOnWorkerRoundTrip()) {
        Napi::Error::New(env,
            "db.totalChanges cannot be read while a JavaScript function, "
            "collation or progress callback is mid-call on this "
            "connection; read it from a callback or after the query"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    return ConvertInt64ToJS(env, sqlite3_total_changes64(_handle),
        integer_mode, "db.totalChanges");
}

Napi::Value Database::Exec(const Napi::CallbackInfo& info) {
    auto env = this->Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, sql);
    OPTIONAL_ARGUMENT_FUNCTION(1, callback);

    Baton* baton = new ExecBaton(db, callback, sql.c_str());
    db->Schedule(Work_BeginExec, baton, true);

    return info.This();
}

void Database::Work_BeginExec(Baton* baton) {
    assert(baton->db->exclusiveHeld);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(baton->db->pending == 0);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.Exec", Work_Exec, Work_AfterExec);
}

void Database::Work_Exec(napi_env e, void* data) {
    auto* baton = static_cast<ExecBaton*>(data);

    char* message = NULL;
    baton->status = sqlite3_exec(
        baton->db->_handle,
        baton->sql.c_str(),
        NULL,
        NULL,
        &message
    );

    if (baton->status != SQLITE_OK && message != NULL) {
        baton->message = std::string(message);
        sqlite3_free(message);
    }
}

void Database::Work_AfterExec(napi_env e, napi_status status, void* data) {
    std::unique_ptr<ExecBaton> baton(static_cast<ExecBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);

    auto* db = baton->db;
    db->pending--;
    // The exclusive exec released the database.
    db->exclusiveHeld = false;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    // Drains the queue even when the completion callback below throws
    // (TRY_CATCH_CALL's early return).
    ProcessGuard process_on_exit(db);

    Napi::Function cb = baton->callback.Value();

    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        db->AttachPendingJsError(exception_obj);

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
}

Napi::Value Database::Wait(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto* db = this;

    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

   auto* baton = new Baton(db, callback);
    db->Schedule(Work_Wait, baton, true);

    return info.This();
}

void Database::Work_Wait(Baton* b) {
    auto baton = std::unique_ptr<Baton>(b);

    auto env = baton->db->Env();
    Napi::HandleScope scope(env);

    assert(baton->db->exclusiveHeld);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(baton->db->pending == 0);

    // The exclusive wait releases the database; Process sets it again
    // when it dispatches the next exclusive call, if any.
    baton->db->exclusiveHeld = false;

    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { env.Null() };
        TRY_CATCH_CALL(baton->db->Value(), cb, 1, argv);
    }

    baton->db->Process();
}

Napi::Value Database::LoadExtension(const Napi::CallbackInfo& info) {
    auto env = this->Env();
    auto* db = this;

    REQUIRE_ARGUMENT_STRING(0, filename);
    OPTIONAL_ARGUMENT_FUNCTION(1, callback);

    Baton* baton = new LoadExtensionBaton(db, callback, filename.c_str());
    db->Schedule(Work_BeginLoadExtension, baton, true);

    return info.This();
}

void Database::Work_BeginLoadExtension(Baton* baton) {
    assert(baton->db->exclusiveHeld);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    assert(baton->db->pending == 0);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Database.LoadExtension", Work_LoadExtension, Work_AfterLoadExtension);
}

void Database::Work_LoadExtension(napi_env e, void* data) {
    auto* baton = static_cast<LoadExtensionBaton*>(data);

    sqlite3_enable_load_extension(baton->db->_handle, 1);

    char* message = NULL;
    baton->status = sqlite3_load_extension(
        baton->db->_handle,
        baton->filename.c_str(),
        0,
        &message
    );

    sqlite3_enable_load_extension(baton->db->_handle, 0);

    if (baton->status != SQLITE_OK && message != NULL) {
        baton->message = std::string(message);
        sqlite3_free(message);
    }
}

void Database::Work_AfterLoadExtension(napi_env e, napi_status status, void* data) {
    std::unique_ptr<LoadExtensionBaton> baton(static_cast<LoadExtensionBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);

    auto* db = baton->db;
    db->pending--;
    // The exclusive loadExtension released the database.
    db->exclusiveHeld = false;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    // Drains the queue even when the completion callback below throws
    // (TRY_CATCH_CALL's early return).
    ProcessGuard process_on_exit(db);

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
}

void Database::RemoveCallbacks() {
    if (debug_trace) {
        debug_trace->finish();
        debug_trace = NULL;
    }
    if (debug_profile) {
        debug_profile->finish();
        debug_profile = NULL;
    }
    if (txn_event) {
        txn_event->finish();
        txn_event = NULL;
    }
    hook_change = hook_commit = hook_rollback = false;
    if (wal_event) {
        wal_event->finish();
        wal_event = NULL;
    }
}
