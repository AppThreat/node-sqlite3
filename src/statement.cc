#include <cstring>
#include <napi.h>
#include <uv.h>

#include "macros.h"
#include "database.h"
#include "statement.h"

using namespace node_sqlite3;

Napi::Object Statement::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);

    // declare napi_default_method here as it is only available in Node v14.12.0+
    auto napi_default_method = static_cast<napi_property_attributes>(napi_writable | napi_configurable);

    auto t = DefineClass(env, "Statement", {
      InstanceMethod("bind", &Statement::Bind, napi_default_method),
      InstanceMethod("get", &Statement::Get, napi_default_method),
      InstanceMethod("run", &Statement::Run, napi_default_method),
      InstanceMethod("all", &Statement::All, napi_default_method),
      InstanceMethod("each", &Statement::Each, napi_default_method),
      InstanceMethod("reset", &Statement::Reset, napi_default_method),
      InstanceMethod("finalize", &Statement::Finalize_, napi_default_method),
      InstanceMethod("getSync", &Statement::GetSync, napi_default_method),
      InstanceMethod("runSync", &Statement::RunSync, napi_default_method),
      InstanceMethod("allSync", &Statement::AllSync, napi_default_method),
    });

    exports.Set("Statement", t);
    return exports;
}

// A Napi InstanceOf for Javascript Objects "Date" and "RegExp"
bool OtherInstanceOf(Napi::Object source, const char* object_type) {
    if (strncmp(object_type, "Date", 4) == 0) {
        return source.InstanceOf(source.Env().Global().Get("Date").As<Function>());
    } else if (strncmp(object_type, "RegExp", 6) == 0) {
        return source.InstanceOf(source.Env().Global().Get("RegExp").As<Function>());
    }

    return false;
}

void Statement::Process() {
    if (finalized && !queue.empty()) {
        return CleanQueue();
    }

    while (prepared && !locked && !queue.empty()) {
        auto call = std::unique_ptr<Call>(queue.front());
        queue.pop();

        call->callback(call->baton);
    }
}

void Statement::Schedule(Work_Callback callback, Baton* baton) {
    if (finalized) {
        queue.emplace(new Call(callback, baton));
        CleanQueue();
    }
    else if (!prepared || locked) {
        queue.emplace(new Call(callback, baton));
    }
    else {
        callback(baton);
    }
}

template <class T> void Statement::Error(T* baton) {
    Statement* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Fail hard on logic errors.
    assert(stmt->status != 0);
    EXCEPTION(Napi::String::New(env, stmt->message.c_str()), stmt->status, exception);

    Napi::Function cb = baton->callback.Value();

    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { exception };
        TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
    }
    else {
        Napi::Value argv[] = { Napi::String::New(env, "error"), exception };
        EMIT_EVENT(stmt->Value(), 2, argv);
    }
}

// { Database db, String sql, [Function callback], [Boolean sync] }
// The trailing boolean is used by Database#prepareSync: it prepares the
// statement inline instead of through the worker pool. The database must
// be fully idle for that to be safe.
Statement::Statement(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Statement>(info) {
    auto env = info.Env();
    int length = info.Length();

    if (length <= 0 || !Database::HasInstance(info[0])) {
        Napi::TypeError::New(env, "Database object expected").ThrowAsJavaScriptException();
        return;
    }
    else if (length <= 1 || !info[1].IsString()) {
        Napi::TypeError::New(env, "SQL query expected").ThrowAsJavaScriptException();
        return;
    }
    else if (length > 2 && !info[2].IsUndefined() && !info[2].IsFunction()) {
        Napi::TypeError::New(env, "Callback expected").ThrowAsJavaScriptException();
        return;
    }

    this->db = Napi::ObjectWrap<Database>::Unwrap(info[0].As<Napi::Object>());
    this->db->Ref();

    auto sql = info[1].As<Napi::String>();

    info.This().As<Napi::Object>().DefineProperty(Napi::PropertyDescriptor::Value("sql", sql, napi_default));

    std::string sql_str = sql.Utf8Value();
    // Preserve the historical NUL-truncation semantics of c_str().
    sql_str.resize(std::strlen(sql_str.c_str()));

    Statement* stmt = this;

    if (length > 3 && info[3].IsBoolean() && info[3].As<Napi::Boolean>().Value()) {
        // Synchronous prepare. The idle gate mirrors IdleForInline()
        // (db->locked is sticky history, not an in-flight marker).
        if (!db->IsOpen() || db->closing || db->pending > 0
                || !db->queue.empty()) {
            Napi::Error::New(env,
                "database is busy: sync methods require a fully idle database"
            ).ThrowAsJavaScriptException();
            return;
        }

        sqlite3_mutex* mtx = sqlite3_db_mutex(db->_handle);
        sqlite3_mutex_enter(mtx);
        status = sqlite3_prepare_v2(db->_handle, sql_str.c_str(),
            sql_str.size(), &_handle, NULL);
        if (status != SQLITE_OK) {
            message = std::string(sqlite3_errmsg(db->_handle));
            _handle = NULL;
        }
        sqlite3_mutex_leave(mtx);

        if (status != SQLITE_OK) {
            ThrowStatementError(env);
            return;
        }
        prepared = true;
        locked = false; // no STATEMENT_END will run for this path
        return;
    }

    auto* baton = new PrepareBaton(this->db, info[2].As<Napi::Function>(), stmt);
    baton->sql = std::move(sql_str);
    this->db->Schedule(Work_BeginPrepare, baton);
}

void Statement::Work_BeginPrepare(Database::Baton* baton) {
    assert(baton->db->open);
    baton->db->pending++;

    auto env = baton->db->Env();
    CREATE_WORK("sqlite3.Statement.Prepare", Work_Prepare, Work_AfterPrepare);
}

void Statement::Work_Prepare(napi_env e, void* data) {
    STATEMENT_INIT(PrepareBaton);

    // In case preparing fails, we use a mutex to make sure we get the associated
    // error message.
    STATEMENT_MUTEX(mtx);
    sqlite3_mutex_enter(mtx);

    stmt->status = sqlite3_prepare_v2(
        baton->db->_handle,
        baton->sql.c_str(),
        baton->sql.size(),
        &stmt->_handle,
        NULL
    );

    if (stmt->status != SQLITE_OK) {
        stmt->message = std::string(sqlite3_errmsg(baton->db->_handle));
        stmt->_handle = NULL;
    }

    sqlite3_mutex_leave(mtx);
}

void Statement::EndCall() {
    assert(locked);
    assert(db->pending);
    locked = false;
    db->pending--;
    Process();
    db->Process();
}

void Statement::Work_AfterPrepare(napi_env e, napi_status status, void* data) {
    std::unique_ptr<PrepareBaton> baton(static_cast<PrepareBaton*>(data));
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_OK) {
        Error(baton.get());
        stmt->Finalize_();
    }
    else {
        stmt->prepared = true;
        if (!baton->callback.IsEmpty() && baton->callback.Value().IsFunction()) {
            Napi::Function cb = baton->callback.Value();
            Napi::Value argv[] = { env.Null() };
            TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
        }
    }
}

template <class T> std::unique_ptr<Values::Field>
                   Statement::BindParameter(const Napi::Value source, T pos) {
    // Order matters: cheap primitive checks run before the object checks
    // (InstanceOf lookups hit the global object).
    if (source.IsString()) {
        std::string val = source.As<Napi::String>().Utf8Value();
        return std::make_unique<Values::Text>(pos, val.length(), val.c_str());
    }
    else if (source.IsNumber()) {
        if (OtherIsInt(source.As<Napi::Number>())) {
            return std::make_unique<Values::Integer>(pos, source.As<Napi::Number>().Int32Value());
        } else {
            return std::make_unique<Values::Float>(pos, source.As<Napi::Number>().DoubleValue());
        }
    }
    else if (source.IsBoolean()) {
        return std::make_unique<Values::Integer>(pos, source.As<Napi::Boolean>().Value() ? 1 : 0);
    }
    else if (source.IsNull()) {
        return std::make_unique<Values::Null>(pos);
    }
    else if (source.IsBuffer()) {
        Napi::Buffer<char> buffer = source.As<Napi::Buffer<char>>();
        return std::make_unique<Values::Blob>(pos, buffer.Length(), buffer.Data());
    }
    else if (source.IsDate()) {
        return std::make_unique<Values::Float>(pos, source.As<Napi::Date>().ValueOf());
    }
    else if (source.IsObject()) {
        if (OtherInstanceOf(source.As<Object>(), "RegExp")) {
            std::string val = source.ToString().Utf8Value();
            return std::make_unique<Values::Text>(pos, val.length(), val.c_str());
        }
        auto napiVal = Napi::String::New(source.Env(), "[object Object]");
        // Check whether toString returned a value that is not undefined.
        if(napiVal.Type() == 0) {
            return NULL;
        }

        std::string val = napiVal.Utf8Value();
        return std::make_unique<Values::Text>(pos, val.length(), val.c_str());
    }
    else {
        return NULL;
    }
}

template <class T> T* Statement::Bind(const Napi::CallbackInfo& info, int start, int last) {
    auto env = info.Env();
    Napi::HandleScope scope(env);

    if (last < 0) last = info.Length();
    Napi::Function callback;
    if (last > start && info[last - 1].IsFunction()) {
        callback = info[last - 1].As<Napi::Function>();
        last--;
    }

    auto *baton = new T(this, callback);

    if (start < last) {
        if (info[start].IsArray()) {
            auto array = info[start].As<Napi::Array>();
            int length = array.Length();
            baton->parameters.reserve(length);
            // Note: bind parameters start with 1.
            for (int i = 0, pos = 1; i < length; i++, pos++) {
                baton->parameters.emplace_back(BindParameter((array).Get(i), i + 1));
            }
        }
        // Cheap checks first; IsDate matches across realms, and the RegExp
        // global lookup only runs once the value is known to be an object.
        else if (!info[start].IsObject() || info[start].IsBuffer()
                || info[start].IsDate()
                || OtherInstanceOf(info[start].As<Object>(), "RegExp")) {
            // Parameters directly in array.
            // Note: bind parameters start with 1.
            baton->parameters.reserve(last - start);
            for (int i = start, pos = 1; i < last; i++, pos++) {
                baton->parameters.emplace_back(BindParameter(info[i], pos));
            }
        }
        else if (info[start].IsObject()) {
            auto object = info[start].As<Napi::Object>();
            auto array = object.GetPropertyNames();
            int length = array.Length();
            baton->parameters.reserve(length);
            for (int i = 0; i < length; i++) {
                Napi::Value name = (array).Get(i);
                Napi::Number num = name.ToNumber();

                if (num.Int32Value() == num.DoubleValue()) {
                    baton->parameters.emplace_back(
                        BindParameter((object).Get(name), num.Int32Value()));
                }
                else {
                    baton->parameters.emplace_back(BindParameter((object).Get(name),
                        name.As<Napi::String>().Utf8Value().c_str()));
                }
            }
        }
        else {
            return NULL;
        }
    }

    return baton;
}

bool Statement::Bind(Parameters&& parameters) {
    if (parameters.empty()) {
        // Keep bound_payloads alive: the previous SQLITE_STATIC bindings are
        // still referenced if the statement is stepped again without a rebind.
        return true;
    }

    sqlite3_reset(_handle);
    sqlite3_clear_bindings(_handle);

    // Hold the previous payloads until every parameter has been rebound.
    Parameters stale;
    stale.swap(bound_payloads);

    for (auto& field : parameters) {
        if (field == NULL)
            continue;

        unsigned int pos;
        if (field->index > 0) {
            pos = field->index;
        }
        else {
            pos = sqlite3_bind_parameter_index(_handle, field->name.c_str());
        }

        switch (field->type) {
            case SQLITE_INTEGER: {
                status = sqlite3_bind_int(_handle, pos,
                    (static_cast<Values::Integer*>(field.get()))->value);
            } break;
            case SQLITE_FLOAT: {
                status = sqlite3_bind_double(_handle, pos,
                    (static_cast<Values::Float*>(field.get()))->value);
            } break;
            case SQLITE_TEXT: {
                // SQLITE_STATIC is safe: the payload is moved into
                // bound_payloads below and stays alive until rebind/finalize.
                auto* f = static_cast<Values::Text*>(field.get());
                status = sqlite3_bind_text(_handle, pos,
                    f->value.c_str(), f->value.size(), SQLITE_STATIC);
                if (status == SQLITE_OK) bound_payloads.emplace_back(std::move(field));
            } break;
            case SQLITE_BLOB: {
                auto* f = static_cast<Values::Blob*>(field.get());
                status = sqlite3_bind_blob(_handle, pos,
                    f->value, f->length, SQLITE_STATIC);
                if (status == SQLITE_OK) bound_payloads.emplace_back(std::move(field));
            } break;
            case SQLITE_NULL: {
                status = sqlite3_bind_null(_handle, pos);
            } break;
        }

            if (status != SQLITE_OK) {
                // Clear every binding so no stale SQLITE_STATIC pointer can
                // dangle into the payloads we are about to release.
                sqlite3_clear_bindings(_handle);
                bound_payloads.clear();
                message = std::string(sqlite3_errmsg(db->_handle));
                return false;
            }
        }

    return true;
}

Napi::Value Statement::Bind(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    auto baton = stmt->Bind<Baton>(info);
    if (baton == NULL) {
        Napi::TypeError::New(env, "Data type is not supported").ThrowAsJavaScriptException();
        return env.Null();
    }
    else {
        stmt->Schedule(Work_BeginBind, baton);
        return info.This();
    }
}

void Statement::Work_BeginBind(Baton* baton) {
    STATEMENT_BEGIN(Bind);
}

void Statement::Work_Bind(napi_env e, void* data) {
    STATEMENT_INIT(Baton);

    STATEMENT_MUTEX(mtx);
    sqlite3_mutex_enter(mtx);
    stmt->Bind(std::move(baton->parameters));
    sqlite3_mutex_leave(mtx);
}

void Statement::Work_AfterBind(napi_env e, napi_status status, void* data) {
    std::unique_ptr<Baton> baton(static_cast<Baton*>(data));
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_OK) {
        Error(baton.get());
    }
    else {
        // Fire callbacks.
        Napi::Function cb = baton->callback.Value();
        if (IS_FUNCTION(cb)) {
            Napi::Value argv[] = { env.Null() };
            TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
        }
    }
}



Napi::Value Statement::Get(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    Baton* baton = stmt->Bind<RowBaton>(info);
    if (baton == NULL) {
        Napi::Error::New(env, "Data type is not supported").ThrowAsJavaScriptException();
        return env.Null();
    }
    else {
        stmt->Schedule(Work_BeginGet, baton);
        return info.This();
    }
}

void Statement::Work_BeginGet(Baton* baton) {
    STATEMENT_BEGIN(Get);
}

void Statement::Work_Get(napi_env e, void* data) {
    STATEMENT_INIT(RowBaton);

    if (stmt->status != SQLITE_DONE || baton->parameters.size()) {
        STATEMENT_MUTEX(mtx);
        sqlite3_mutex_enter(mtx);

        if (stmt->Bind(std::move(baton->parameters))) {
            stmt->status = sqlite3_step(stmt->_handle);

            if (!(stmt->status == SQLITE_ROW || stmt->status == SQLITE_DONE)) {
                stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
            }
        }

        sqlite3_mutex_leave(mtx);

        if (stmt->status == SQLITE_ROW) {
            // Acquire one result row before returning.
            GetRow(&baton->row, stmt->_handle, &baton->columns);
        }
    }
}

void Statement::Work_AfterGet(napi_env e, napi_status status, void* data) {
    std::unique_ptr<RowBaton> baton(static_cast<RowBaton*>(data));
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_ROW && stmt->status != SQLITE_DONE) {
        Error(baton.get());
    }
    else {
        // Fire callbacks.
        Napi::Function cb = baton->callback.Value();
        if (IS_FUNCTION(cb)) {
            if (stmt->status == SQLITE_ROW) {
                // Create the result array from the data we acquired.
                stmt->SyncColumnKeys(env, baton->columns);
                Napi::Value argv[] = { env.Null(), stmt->RowToJS(env, &baton->row) };
                TRY_CATCH_CALL(stmt->Value(), cb, 2, argv);
            }
            else {
                Napi::Value argv[] = { env.Null() };
                TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
            }
        }
    }
}

Napi::Value Statement::Run(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    Baton* baton = stmt->Bind<RunBaton>(info);
    if (baton == NULL) {
        Napi::Error::New(env, "Data type is not supported").ThrowAsJavaScriptException();
        return env.Null();
    }
    else {
        stmt->Schedule(Work_BeginRun, baton);
        return info.This();
    }
}

void Statement::Work_BeginRun(Baton* baton) {
    STATEMENT_BEGIN(Run);
}

void Statement::Work_Run(napi_env e, void* data) {
    STATEMENT_INIT(RunBaton);

    STATEMENT_MUTEX(mtx);
    sqlite3_mutex_enter(mtx);

    // Make sure that we also reset when there are no parameters.
    if (!baton->parameters.size()) {
        sqlite3_reset(stmt->_handle);
    }

    if (stmt->Bind(std::move(baton->parameters))) {
        stmt->status = sqlite3_step(stmt->_handle);

        if (!(stmt->status == SQLITE_ROW || stmt->status == SQLITE_DONE)) {
            stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
        }
        else {
            baton->inserted_id = sqlite3_last_insert_rowid(stmt->db->_handle);
            baton->changes = sqlite3_changes(stmt->db->_handle);
        }
    }

    sqlite3_mutex_leave(mtx);
}

void Statement::Work_AfterRun(napi_env e, napi_status status, void* data) {
    std::unique_ptr<RunBaton> baton(static_cast<RunBaton*>(data));
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_ROW && stmt->status != SQLITE_DONE) {
        Error(baton.get());
    }
    else {
        // Fire callbacks.
        Napi::Function cb = baton->callback.Value();
        if (IS_FUNCTION(cb)) {
            if (stmt->key_last_id.IsEmpty()) {
                stmt->key_last_id = Napi::Persistent(Napi::String::New(env, "lastID"));
                stmt->key_changes = Napi::Persistent(Napi::String::New(env, "changes"));
            }
            (stmt->Value()).Set(stmt->key_last_id.Value(), Napi::Number::New(env, baton->inserted_id));
            (stmt->Value()).Set(stmt->key_changes.Value(), Napi::Number::New(env, baton->changes));

            Napi::Value argv[] = { env.Null() };
            TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
        }
    }
}

Napi::Value Statement::All(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    Baton* baton = stmt->Bind<RowsBaton>(info);
    if (baton == NULL) {
        Napi::Error::New(env, "Data type is not supported").ThrowAsJavaScriptException();
        return env.Null();
    }
    else {
        stmt->Schedule(Work_BeginAll, baton);
        return info.This();
    }
}

void Statement::Work_BeginAll(Baton* baton) {
    STATEMENT_BEGIN(All);
}

void Statement::Work_All(napi_env e, void* data) {
    STATEMENT_INIT(RowsBaton);

    STATEMENT_MUTEX(mtx);
    sqlite3_mutex_enter(mtx);

    // Make sure that we also reset when there are no parameters.
    if (!baton->parameters.size()) {
        sqlite3_reset(stmt->_handle);
    }

    if (stmt->Bind(std::move(baton->parameters))) {
        while ((stmt->status = sqlite3_step(stmt->_handle)) == SQLITE_ROW) {
            baton->rows.emplace_back();
            GetRow(&baton->rows.back(), stmt->_handle, &baton->columns);
        }
        if (stmt->status != SQLITE_DONE) {
            stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
        }
    }

    sqlite3_mutex_leave(mtx);
}

void Statement::Work_AfterAll(napi_env e, napi_status status, void* data) {
    std::unique_ptr<RowsBaton> baton(static_cast<RowsBaton*>(data));
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_DONE) {
        Error(baton.get());
        return;
    }

    // Fire callbacks.
    //
    // Note: conversion is deliberately a single synchronous pass. Spreading
    // it over several event-loop turns would release the statement lock
    // early and let later-queued operations report before this one, which
    // breaks the FIFO callback ordering that serialize() depends on.
    Napi::Function cb = baton->callback.Value();

    if (IS_FUNCTION(cb)) {
        if (baton->rows.size()) {
            // Create the result array from the data we acquired.
            stmt->SyncColumnKeys(env, baton->columns);
            Napi::Array result(Napi::Array::New(env, baton->rows.size()));
            for (size_t i = 0; i < baton->rows.size(); i++) {
                (result).Set(i, stmt->RowToJS(env, &baton->rows[i]));
            }

            Napi::Value argv[] = { env.Null(), result };
            TRY_CATCH_CALL(stmt->Value(), cb, 2, argv);
        }
        else {
            // There were no result rows.
            Napi::Value argv[] = {
                env.Null(),
                Napi::Array::New(env, 0)
            };
            TRY_CATCH_CALL(stmt->Value(), cb, 2, argv);
        }
    }
}

Napi::Value Statement::Each(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    int last = info.Length();

    Napi::Function completed;
    if (last >= 2 && info[last - 1].IsFunction() && info[last - 2].IsFunction()) {
        completed = info[--last].As<Napi::Function>();
    }

    auto baton = stmt->Bind<EachBaton>(info, 0, last);
    if (baton == NULL) {
        Napi::Error::New(env, "Data type is not supported").ThrowAsJavaScriptException();
        return env.Null();
    }
    else {
        baton->completed.Reset(completed, 1);
        stmt->Schedule(Work_BeginEach, baton);
        return info.This();
    }
}

void Statement::Work_BeginEach(Baton* baton) {
    // Only create the Async object when we're actually going into
    // the event loop. This prevents dangling events.
    auto* each_baton = static_cast<EachBaton*>(baton);
    each_baton->async = new Async(each_baton->stmt, reinterpret_cast<uv_async_cb>(AsyncEach));
    each_baton->async->item_cb.Reset(each_baton->callback.Value(), 1);
    each_baton->async->completed_cb.Reset(each_baton->completed.Value(), 1);

    STATEMENT_BEGIN(Each);
}

void Statement::Work_Each(napi_env e, void* data) {
    STATEMENT_INIT(EachBaton);

    auto* async = baton->async;

    STATEMENT_MUTEX(mtx);

    // Make sure that we also reset when there are no parameters.
    if (!baton->parameters.size()) {
        sqlite3_reset(stmt->_handle);
    }

    sqlite3_mutex_enter(mtx);
    bool bound = stmt->Bind(std::move(baton->parameters));
    sqlite3_mutex_leave(mtx);

    if (bound) {
        while (true) {
            // Reacquire per row rather than holding the connection mutex for
            // the whole result set: other statements on this database must
            // still make progress while a long each() streams.
            //
            // GetRow stays inside the lock, since sqlite3_column_* reads the
            // statement's own state and is not safe to run concurrently with
            // another thread using the same connection.
            sqlite3_mutex_enter(mtx);
            stmt->status = sqlite3_step(stmt->_handle);
            if (stmt->status != SQLITE_ROW) {
                if (stmt->status != SQLITE_DONE) {
                    stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
                }
                sqlite3_mutex_leave(mtx);
                break;
            }

            NODE_SQLITE3_MUTEX_LOCK(&async->mutex)
            async->data.emplace_back();
            GetRow(&async->data.back(), stmt->_handle, &async->columns);
            NODE_SQLITE3_MUTEX_UNLOCK(&async->mutex)
            sqlite3_mutex_leave(mtx);

            // uv_async_send already coalesces: it is a cheap atomic test when
            // a wakeup is pending, so signalling per row costs almost nothing
            // and keeps each() streaming instead of batching to the end.
            uv_async_send(&async->watcher);
        }
    }

    async->completed = true;
    uv_async_send(&async->watcher);
}

void Statement::CloseCallback(uv_handle_t* handle) {
    assert(handle != NULL);
    assert(handle->data != NULL);
    auto* async = static_cast<Async*>(handle->data);
    delete async;
}

void Statement::AsyncEach(uv_async_t* handle) {
    auto* async = static_cast<Async*>(handle->data);

    auto env = async->stmt->Env();
    Napi::HandleScope scope(env);

    while (true) {
        // Get the contents out of the data cache for us to process in the JS callback.
        Rows rows;
        Columns columns;
        NODE_SQLITE3_MUTEX_LOCK(&async->mutex)
        rows.swap(async->data);
        columns = async->columns;
        NODE_SQLITE3_MUTEX_UNLOCK(&async->mutex)

        if (rows.empty()) {
            break;
        }

        Napi::Function cb = async->item_cb.Value();
        if (IS_FUNCTION(cb)) {
            Napi::Value argv[2];
            argv[0] = env.Null();

            async->stmt->SyncColumnKeys(env, columns);
            for (auto& row : rows) {
                argv[1] = async->stmt->RowToJS(env, &row);
                async->retrieved++;
                TRY_CATCH_CALL(async->stmt->Value(), cb, 2, argv);
            }
        }
    }

    Napi::Function cb = async->completed_cb.Value();
    if (async->completed) {
        if (!cb.IsEmpty() &&
                cb.IsFunction()) {
            Napi::Value argv[] = {
                env.Null(),
                Napi::Number::New(env, async->retrieved)
            };
            TRY_CATCH_CALL(async->stmt->Value(), cb, 2, argv);
        }
        uv_close(reinterpret_cast<uv_handle_t*>(handle), CloseCallback);
    }
}

void Statement::Work_AfterEach(napi_env e, napi_status status, void* data) {
    std::unique_ptr<EachBaton> baton(static_cast<EachBaton*>(data));
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_DONE) {
        Error(baton.get());
    }
}

Napi::Value Statement::Reset(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    auto* baton = new Baton(stmt, callback);
    stmt->Schedule(Work_BeginReset, baton);

    return info.This();
}

void Statement::Work_BeginReset(Baton* baton) {
    STATEMENT_BEGIN(Reset);
}

void Statement::Work_Reset(napi_env e, void* data) {
    STATEMENT_INIT(Baton);

    sqlite3_reset(stmt->_handle);
    stmt->status = SQLITE_OK;
}

void Statement::Work_AfterReset(napi_env e, napi_status status, void* data) {
    std::unique_ptr<Baton> baton(static_cast<Baton*>(data));
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    // Fire callbacks.
    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        Napi::Value argv[] = { env.Null() };
        TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
    }
}

// --- Synchronous fast path ---------------------------------------------
//
// The gate is the whole safety story: JS is single-threaded, pending and
// locked/db-queue state only mutate on the main thread, and the gate
// requires every queue to be empty and no worker in flight. Between the
// check and the sqlite calls nothing else can therefore touch this
// connection, and no queued operation can be overtaken (FIFO intact).

bool Statement::IdleForInline() {
    // db->locked is deliberately not consulted: it is sticky history of
    // the last dispatched call's exclusivity, not an in-flight marker.
    // pending == 0 plus an empty queue is the actual "nothing running or
    // deferred" condition.
    return prepared && !locked && !finalized && queue.empty()
        && db->IsOpen() && !db->closing
        && db->pending == 0 && db->queue.empty();
}

void Statement::ThrowStatementError(Napi::Env env) {
    EXCEPTION(Napi::String::New(env, message.c_str()), status, exception);
    exception.As<Napi::Error>().ThrowAsJavaScriptException();
}

template <class T> T* Statement::BindSync(const Napi::CallbackInfo& info) {
    auto env = info.Env();

    if (finalized) {
        Napi::Error::New(env, "Statement is already finalized")
            .ThrowAsJavaScriptException();
        return NULL;
    }
    if (!IdleForInline()) {
        Napi::Error::New(env,
            "database is busy: sync methods require a fully idle database"
        ).ThrowAsJavaScriptException();
        return NULL;
    }

    T* baton = Bind<T>(info);
    if (baton == NULL) {
        Napi::TypeError::New(env, "Data type is not supported")
            .ThrowAsJavaScriptException();
        return NULL;
    }
    if (IS_FUNCTION(baton->callback.Value())) {
        delete baton;
        Napi::TypeError::New(env, "Sync methods do not take a callback")
            .ThrowAsJavaScriptException();
        return NULL;
    }
    return baton;
}

Napi::Value Statement::GetSync(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    RowBaton* baton = BindSync<RowBaton>(info);
    if (baton == NULL) return env.Null();
    std::unique_ptr<RowBaton> holder(baton);

    // Mirrors Work_Get: step unless the cursor is already exhausted and
    // no new parameters were supplied.
    if (stmt->status != SQLITE_DONE || holder->parameters.size()) {
        if (!stmt->Bind(std::move(holder->parameters))) {
            stmt->ThrowStatementError(env);
            return env.Null();
        }
        stmt->status = sqlite3_step(stmt->_handle);
        if (!(stmt->status == SQLITE_ROW || stmt->status == SQLITE_DONE)) {
            stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
            stmt->ThrowStatementError(env);
            return env.Null();
        }
    }

    if (stmt->status == SQLITE_ROW) {
        Row row;
        Columns columns;
        GetRow(&row, stmt->_handle, &columns);
        stmt->SyncColumnKeys(env, columns);
        return stmt->RowToJS(env, &row);
    }
    return env.Undefined();
}

Napi::Value Statement::RunSync(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    RunBaton* baton = BindSync<RunBaton>(info);
    if (baton == NULL) return env.Null();
    std::unique_ptr<RunBaton> holder(baton);

    // Mirrors Work_Run, including the explicit reset for parameterless
    // re-execution.
    if (!holder->parameters.size()) {
        sqlite3_reset(stmt->_handle);
    }

    if (!stmt->Bind(std::move(holder->parameters))) {
        stmt->ThrowStatementError(env);
        return env.Null();
    }
    stmt->status = sqlite3_step(stmt->_handle);

    if (!(stmt->status == SQLITE_ROW || stmt->status == SQLITE_DONE)) {
        stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
        stmt->ThrowStatementError(env);
        return env.Null();
    }

    sqlite3_int64 inserted_id = sqlite3_last_insert_rowid(stmt->db->_handle);
    int changes = sqlite3_changes(stmt->db->_handle);

    if (stmt->key_last_id.IsEmpty()) {
        stmt->key_last_id = Napi::Persistent(Napi::String::New(env, "lastID"));
        stmt->key_changes = Napi::Persistent(Napi::String::New(env, "changes"));
    }
    (stmt->Value()).Set(stmt->key_last_id.Value(), Napi::Number::New(env, inserted_id));
    (stmt->Value()).Set(stmt->key_changes.Value(), Napi::Number::New(env, changes));

    return info.This();
}

Napi::Value Statement::AllSync(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    RowsBaton* baton = BindSync<RowsBaton>(info);
    if (baton == NULL) return env.Null();
    std::unique_ptr<RowsBaton> holder(baton);

    if (!holder->parameters.size()) {
        sqlite3_reset(stmt->_handle);
    }

    if (!stmt->Bind(std::move(holder->parameters))) {
        stmt->ThrowStatementError(env);
        return env.Null();
    }

    Rows rows;
    Columns columns;
    while ((stmt->status = sqlite3_step(stmt->_handle)) == SQLITE_ROW) {
        rows.emplace_back();
        GetRow(&rows.back(), stmt->_handle, &columns);
    }
    if (stmt->status != SQLITE_DONE) {
        stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
        stmt->ThrowStatementError(env);
        return env.Null();
    }

    stmt->SyncColumnKeys(env, columns);
    Napi::Array result(Napi::Array::New(env, rows.size()));
    for (size_t i = 0; i < rows.size(); i++) {
        (result).Set(i, stmt->RowToJS(env, &rows[i]));
    }
    return result;
}

void Statement::SyncColumnKeys(Napi::Env env, const Columns& columns) {
    // Root one JS string per column and reuse it for every row of the batch
    // instead of re-creating a key per cell. Rebuilt only when the statement
    // was re-prepared with a different result shape.
    if (column_keys_source == columns.names) {
        return;
    }
    column_keys.clear();
    column_keys.reserve(columns.names.size());
    for (const auto& name : columns.names) {
        column_keys.emplace_back(Napi::Persistent(Napi::String::New(env, name)));
    }
    column_keys_source = columns.names;
}

Napi::Value Statement::RowToJS(Napi::Env env, Row* row) {
    Napi::EscapableHandleScope scope(env);

    auto result = Napi::Object::New(env);

    size_t i = 0;
    for (auto& cell : *row) {
        Napi::Value value;

        switch (cell.type) {
            case SQLITE_INTEGER: {
                value = Napi::Number::New(env, cell.integer);
            } break;
            case SQLITE_FLOAT: {
                value = Napi::Number::New(env, cell.real);
            } break;
            case SQLITE_TEXT: {
                value = Napi::String::New(env, cell.str.data(), cell.str.size());
            } break;
            case SQLITE_BLOB: {
                // Zero-copy for large blobs: transfer ownership of the bytes
                // to the Buffer finalizer. Small blobs are cheaper to copy
                // (external-buffer bookkeeping outweighs the memcpy), and the
                // copy fallback also covers environments without external
                // buffer support (e.g. sandboxed renderers).
                if (cell.str.size() >= 4096) {
                    auto* payload = new std::string(std::move(cell.str));
                    napi_value buf = NULL;
                    napi_status st = napi_create_external_buffer(env,
                        payload->size(), &(*payload)[0],
                        [](napi_env, void*, void* hint) {
                            delete static_cast<std::string*>(hint);
                        },
                        payload, &buf);
                    if (st == napi_ok) {
                        value = Napi::Buffer<char>(env, buf);
                    }
                    else {
                        value = Napi::Buffer<char>::Copy(env,
                            payload->data(), payload->size());
                        delete payload;
                    }
                }
                else {
                    value = Napi::Buffer<char>::Copy(env,
                        cell.str.data(), cell.str.size());
                }
            } break;
            case SQLITE_NULL: {
                value = env.Null();
            } break;
            default:
                value = env.Null();
        }

        // The keys always cover the row: both are derived from the same
        // sqlite3_column_count, and a mid-stream re-prepare refreshes them
        // together. The bound is kept so a shape change that slipped through
        // can never index out of range.
        if (i < column_keys.size()) {
            result.Set(column_keys[i].Value(), value);
        }
        i++;
    }

    return scope.Escape(result);
}

void Statement::GetRow(Row* row, sqlite3_stmt* stmt, Columns* columns) {
    int cols = sqlite3_column_count(stmt);

    // Captured once per execution; the result shape cannot change between
    // the rows of a single statement execution.
    columns->EnsureLoaded(stmt);

    row->clear();
    row->reserve(cols);

    for (int i = 0; i < cols; i++) {
        int type = sqlite3_column_type(stmt, i);

        switch (type) {
            case SQLITE_INTEGER: {
                Cell cell(SQLITE_INTEGER);
                cell.integer = sqlite3_column_int64(stmt, i);
                row->emplace_back(std::move(cell));
            }   break;
            case SQLITE_FLOAT: {
                Cell cell(SQLITE_FLOAT);
                cell.real = sqlite3_column_double(stmt, i);
                row->emplace_back(std::move(cell));
            }   break;
            case SQLITE_TEXT: {
                Cell cell(SQLITE_TEXT);
                const char* text = (const char*)sqlite3_column_text(stmt, i);
                int length = sqlite3_column_bytes(stmt, i);
                if (length > 0 && text != NULL) {
                    cell.str.assign(text, length);
                }
                row->emplace_back(std::move(cell));
            } break;
            case SQLITE_BLOB: {
                Cell cell(SQLITE_BLOB);
                const char* blob = (const char*)sqlite3_column_blob(stmt, i);
                int length = sqlite3_column_bytes(stmt, i);
                if (length > 0 && blob != NULL) {
                    cell.str.assign(blob, length);
                }
                row->emplace_back(std::move(cell));
            }   break;
            case SQLITE_NULL: {
                row->emplace_back(Cell(SQLITE_NULL));
            }   break;
            default:
                row->emplace_back(Cell(SQLITE_NULL));
        }
    }
}

Napi::Value Statement::Finalize_(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;
    OPTIONAL_ARGUMENT_FUNCTION(0, callback);

    auto *baton = new Baton(stmt, callback);
    stmt->Schedule(Finalize_, baton);

    return stmt->db->Value();
}

void Statement::Finalize_(Baton* b) {
    auto baton = std::unique_ptr<Baton>(b);
    auto env = baton->stmt->Env();
    Napi::HandleScope scope(env);

    baton->stmt->Finalize_();

    // Fire callback in case there was one.
    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        TRY_CATCH_CALL(baton->stmt->Value(), cb, 0, NULL);
    }
}

void Statement::Finalize_() {
    assert(!finalized);
    finalized = true;
    CleanQueue();
    // Finalize returns the status code of the last operation. We already fired
    // error events in case those failed.
    sqlite3_finalize(_handle);
    _handle = NULL;
    bound_payloads.clear();
    db->Unref();
}

void Statement::CleanQueue() {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    if (prepared && !queue.empty()) {
        // This statement has already been prepared and is now finalized.
        // Fire error for all remaining items in the queue.
        EXCEPTION(Napi::String::New(env, "Statement is already finalized"), SQLITE_MISUSE, exception);
        Napi::Value argv[] = { exception };
        bool called = false;

        // Clear out the queue so that this object can get GC'ed.
        while (!queue.empty()) {
            auto call = std::unique_ptr<Call>(queue.front());
            queue.pop();

            auto baton = std::unique_ptr<Baton>(call->baton);
            Napi::Function cb = baton->callback.Value();

            if (prepared && !cb.IsEmpty() &&
                cb.IsFunction()) {
                TRY_CATCH_CALL(Value(), cb, 1, argv);
                called = true;
            }
        }

        // When we couldn't call a callback function, emit an error on the
        // Statement object.
        if (!called) {
            Napi::Value info[] = { Napi::String::New(env, "error"), exception };
            EMIT_EVENT(Value(), 2, info);
        }
    }
    else while (!queue.empty()) {
        // Just delete all items in the queue; we already fired an event when
        // preparing the statement failed.
        auto call = std::unique_ptr<Call>(queue.front());
        queue.pop();
        // We don't call the actual callback, so we have to make sure that
        // the baton gets destroyed.
        delete call->baton;
    }
}
