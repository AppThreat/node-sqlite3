#include <cstring>
#include <napi.h>

#include "macros.h"
#include "database.h"
#include "statement.h"

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
        InstanceAccessor("open", &Database::Open, nullptr),
        InstanceAccessor("integerMode", &Database::IntegerModeGetter, nullptr),
        InstanceAccessor("state", &Database::StateGetter, nullptr),
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

    // The constructor rides per-env instance data (NAPI >= 6 only: the
    // package declares napi_versions [10]). Allocated bare: node-addon-api
    // takes ownership of instance data and deletes it at env teardown.
    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(t);
    env.SetInstanceData<Napi::FunctionReference>(constructor);

    exports.Set("Database", t);
    return exports;
}

void Database::Process() {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    if (db_state == DbState::Closed && !queue.empty()) {
        EXCEPTION("Database handle is closed", SQLITE_MISUSE, exception);
        Napi::Value argv[] = { exception };
        bool called = false;

        // Call all callbacks with the error object.
        while (!queue.empty()) {
            auto call = std::unique_ptr<Call>(queue.front());
            queue.pop();
            auto baton = std::unique_ptr<Baton>(call->baton);
            Napi::Function cb = baton->callback.Value();
            if (IS_FUNCTION(cb)) {
                TRY_CATCH_CALL(this->Value(), cb, 1, argv);
                called = true;
            }
        }

        // When we couldn't call a callback function, emit an error on the
        // Database object.
        if (!called) {
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
    }
}

void Database::Work_AfterOpen(napi_env e, napi_status status, void* data) {
    std::unique_ptr<OpenBaton> baton(static_cast<OpenBaton*>(data));

    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    Napi::Value argv[1];
    if (baton->status != SQLITE_OK) {
        EXCEPTION(baton->message, baton->status, exception);
        argv[0] = exception;
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
        db->Process();
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

    auto* db = baton->db;

    auto env = db->Env();
    Napi::HandleScope scope(env);

    db->pending--;
    // The exclusive close released the database either way.
    db->exclusiveHeld = false;

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
        db->Process();
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
    if (info[0].StrictEquals( Napi::String::New(env, "trace"))) {    
       auto* baton = new Baton(db, handle);
        db->Schedule(RegisterTraceCallback, baton);
    }
    else if (info[0].StrictEquals( Napi::String::New(env, "profile"))) {
       auto* baton = new Baton(db, handle);
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
       auto* baton = new Baton(db, handle);
        db->Schedule(RegisterUpdateCallback, baton);
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

    assert(baton->db->IsOpen());
    assert(baton->db->_handle);

    sqlite3_busy_timeout(baton->db->_handle, baton->timeout);
}

void Database::SetLimit(Baton* b) {
    std::unique_ptr<LimitBaton> baton(static_cast<LimitBaton*>(b));

    assert(baton->db->IsOpen());
    assert(baton->db->_handle);

    sqlite3_limit(baton->db->_handle, baton->id, baton->value);
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
    auto baton = std::unique_ptr<Baton>(b);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    auto* db = baton->db;

    if (db->debug_trace == NULL) {
        // Add it.
        db->debug_trace = new AsyncTrace(db, TraceCallback);
    }
    else {
        // Remove it.
        db->debug_trace->finish();
        db->debug_trace = NULL;
    }
    UpdateTraceMask(db, db->_handle);
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
    auto baton = std::unique_ptr<Baton>(b);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    auto* db = baton->db;

    if (db->debug_profile == NULL) {
        // Add it.
        db->debug_profile = new AsyncProfile(db, ProfileCallback);
    }
    else {
        // Remove it.
        db->debug_profile->finish();
        db->debug_profile = NULL;
    }
    UpdateTraceMask(db, db->_handle);
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

void Database::RegisterUpdateCallback(Baton* b) {
    auto baton = std::unique_ptr<Baton>(b);
    assert(baton->db->IsOpen());
    assert(baton->db->_handle);
    auto* db = baton->db;

    if (db->update_event == NULL) {
        // Add it.
        db->update_event = new AsyncUpdate(db, UpdateCallback);
        sqlite3_update_hook(db->_handle, UpdateCallback, db);
    }
    else {
        // Remove it.
        sqlite3_update_hook(db->_handle, NULL, NULL);
        db->update_event->finish();
        db->update_event = NULL;
    }
}

void Database::UpdateCallback(void* db, int type, const char* database,
        const char* table, sqlite3_int64 rowid) {
    // Note: This function is called in the thread pool.
    // Note: Some queries, such as "EXPLAIN" queries, are not sent through this.
    auto* info = new UpdateInfo();
    info->type = type;
    info->database = std::string(database);
    info->table = std::string(table);
    info->rowid = rowid;
    static_cast<Database*>(db)->update_event->send(info);
}

void Database::UpdateCallback(Database *db, UpdateInfo* i) {
    auto info = std::unique_ptr<UpdateInfo>(i);
    auto env = db->Env();
    Napi::HandleScope scope(env);

    Napi::Value argv[] = {
        Napi::String::New(env, "change"),
        Napi::String::New(env, sqlite_authorizer_string(info->type)),
        Napi::String::New(env, info->database.c_str()),
        Napi::String::New(env, info->table.c_str()),
        Napi::Number::New(env, info->rowid),
    };
    EMIT_EVENT(db->Value(), 5, argv);
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

    auto* db = baton->db;
    db->pending--;
    // The exclusive exec released the database.
    db->exclusiveHeld = false;

    auto env = db->Env();
    Napi::HandleScope scope(env);

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

    auto* db = baton->db;
    db->pending--;
    // The exclusive loadExtension released the database.
    db->exclusiveHeld = false;

    auto env = db->Env();
    Napi::HandleScope scope(env);

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

void Database::RemoveCallbacks() {
    if (debug_trace) {
        debug_trace->finish();
        debug_trace = NULL;
    }
    if (debug_profile) {
        debug_profile->finish();
        debug_profile = NULL;
    }
    if (update_event) {
        update_event->finish();
        update_event = NULL;
    }
}
