#include <cmath>
#include <cstring>
#include <cstdint>
#include <limits>
#include <napi.h>
#include <uv.h>

#include "macros.h"
#include "convert.h"
#include "database.h"
#include "statement.h"

using namespace node_sqlite3;

// Defined below Init(): cross-realm Date/RegExp instanceof for objects.
bool OtherInstanceOf(Napi::Object source, const char* object_type);

namespace {

// "parameter 3" / "parameter $name" for bind error messages.
template <class T>
std::string DescribeBindPosition(T pos) {
    if constexpr (std::is_integral_v<T>) {
        return "parameter " + std::to_string(static_cast<long long>(pos));
    } else {
        return std::string("parameter ") + pos;
    }
}

// Takes over a pending JS exception (e.g. the RangeError thrown by an
// integer-mode conversion) and returns it as a value suitable for an
// error-callback argument.
Napi::Value TakePendingError(Napi::Env env) {
    napi_value pending = NULL;
    napi_status st = napi_get_and_clear_last_exception(env, &pending);
    if (st != napi_ok || pending == NULL) {
        return Napi::Error::New(env, "integer value out of range").Value();
    }
    return Napi::Value(env, pending);
}

// Recognises the trailing `{ rowMode: 'array' }` options bag accepted by
// the synchronous read paths (GetSync/AllSync). Only the exact key
// `rowMode` is treated as an option, and the guard must mirror the bind
// path's named-object guard (arrays and binary views bind positionally,
// Date/RegExp are values): a plain object that owns `rowMode` could never
// have been a legal bind argument — named bind keys carry a sigil
// (`:name`/`@name`/`$name`) or are positional numbers — so recognising it
// costs nothing for any call that was legal before this option existed.
//
// Returns true when the value is the options bag (the caller must then
// exclude it from the bind arguments). Throws a TypeError for a rowMode
// value that is not 'object' or 'array'. A property read can throw (a
// Proxy trap); that surfaces as a pending exception and false.
bool ParseSyncReadOptions(const Napi::Value& value, int* row_mode) {
    if (!value.IsObject() || value.IsArray() || value.IsBuffer()
            || value.IsTypedArray() || value.IsDataView()
            || value.IsArrayBuffer() || value.IsDate()
            || OtherInstanceOf(value.As<Napi::Object>(), "RegExp")) {
        return false;
    }
    auto env = value.Env();
    Napi::Value mode = value.As<Napi::Object>().Get("rowMode");
    if (env.IsExceptionPending()) return false;
    if (mode.IsUndefined()) return false;
    if (!mode.IsString()) {
        Napi::TypeError::New(env,
            "rowMode must be 'object' or 'array'")
            .ThrowAsJavaScriptException();
        return true;
    }
    std::string requested = mode.As<Napi::String>().Utf8Value();
    if (requested == "array") {
        *row_mode = Statement::SYNC_ROW_ARRAY;
    } else if (requested == "object") {
        *row_mode = Statement::SYNC_ROW_OBJECT;
    } else {
        Napi::TypeError::New(env,
            "rowMode must be 'object' or 'array'")
            .ThrowAsJavaScriptException();
    }
    return true;
}

} // namespace

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
      InstanceMethod("fetch", &Statement::Fetch, napi_default_method),
      InstanceMethod("finalize", &Statement::Finalize_, napi_default_method),
      InstanceMethod("getSync", &Statement::GetSync, napi_default_method),
      InstanceMethod("runSync", &Statement::RunSync, napi_default_method),
      InstanceMethod("allSync", &Statement::AllSync, napi_default_method),
      // Non-enumerable, like the prototype methods: enumerating the
      // prototype (sqlite3.verbose() does) must not invoke the getters
      // with the prototype as receiver.
      InstanceAccessor("lastID", &Statement::GetLastID, nullptr,
          static_cast<napi_property_attributes>(napi_configurable)),
      InstanceAccessor("lastIDBigInt", &Statement::GetLastIDBigInt, nullptr,
          static_cast<napi_property_attributes>(napi_configurable)),
      InstanceAccessor("changes", &Statement::GetChanges, nullptr,
          static_cast<napi_property_attributes>(napi_configurable)),
      InstanceAccessor("finalized", &Statement::FinalizedGetter, nullptr),
      // Introspection (Deliverable 07): snapshots taken at prepare time,
      // so the getters never race a worker.
      InstanceAccessor("readonly", &Statement::ReadonlyGetter, nullptr),
      InstanceAccessor("parameterCount", &Statement::ParameterCountGetter,
          nullptr),
      InstanceAccessor("parameterNames", &Statement::ParameterNamesGetter,
          nullptr),
      InstanceAccessor("columns", &Statement::ColumnsGetter, nullptr),
      InstanceMethod("status", &Statement::Status, napi_default_method),
    });

    // Per-env (see Database::AddonData): a worker thread is its own napi
    // env, so a file-static constructor here would be shared across
    // environments — and destroyed after the env at process exit.
    env.GetInstanceData<Database::AddonData>()->statement_ctor =
        Napi::Persistent(t);
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
    EXCEPTION(stmt->message, stmt->status, exception);
    // A user-defined function that threw during the step kept its JS error
    // on the database as the pending cause of exactly this failure.
    stmt->db->AttachPendingJsError(exception_obj);

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
        // Synchronous prepare. The idle gate mirrors IdleForInline():
        // only DbState::Open (not Opening/Closing) with nothing in
        // flight or queued.
        if (db->db_state != Database::DbState::Open || db->pending > 0
                || !db->queue.empty()) {
            Napi::Error::New(env,
                "database is busy: sync methods require a fully idle database"
            ).ThrowAsJavaScriptException();
            return;
        }
        // A JavaScript progress callback fires inside prepare and step
        // alike (sqlite invokes the handler in both), and a round trip
        // from this thread would wait for itself. Unlike functions there
        // is no per-invocation error channel, so refuse up front — the
        // same contract as collations. The SharedArrayBuffer token form
        // has no such restriction.
        if (db->js_progress != NULL) {
            Napi::Error::New(env,
                "sync methods cannot be used while a JavaScript progress "
                "callback is registered on this connection: the callback "
                "would have to run JS on the thread that is blocked inside "
                "SQLite (a deadlock). Use the asynchronous API, or a "
                "cancellation token instead"
            ).ThrowAsJavaScriptException();
            return;
        }

        sqlite3_mutex* mtx = sqlite3_db_mutex(db->_handle);
        sqlite3_mutex_enter(mtx);
        {
            // Same guard as the *Sync methods: while this thread drives
            // sqlite, user callbacks reached from it must refuse their
            // round trip instead of deadlocking on this thread.
            Database::SyncSqliteGuard sync_guard(db);
            status = sqlite3_prepare_v2(db->_handle, sql_str.c_str(),
                sql_str.size(), &_handle, NULL);
            if (status != SQLITE_OK) {
                message = std::string(sqlite3_errmsg(db->_handle));
                _handle = NULL;
            }
            else {
                // Sync prepare: this is the JS thread, so take and
                // publish in one go.
                SnapshotMetadata();
                PublishMetadata();
            }
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
    else {
        stmt->SnapshotMetadata();
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
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_OK) {
        // Who hears about a failed prepare? Normally the prepare's own
        // callback, which every callback-style entry point supplies.
        //
        // When there is none -- the promise API's iterate()/fetch() path
        // -- the error used to go to the statement's 'error' event while
        // the calls queued behind the prepare were dropped in silence, so
        // nothing ever settled their promises and the caller hung. That
        // is the abort-during-prepare hang: sqlite3_interrupt() aborts a
        // prepare just as readily as a step, so any abort landing in that
        // window wedged the connection. Fail those calls instead; they
        // are what the caller is actually waiting on.
        //
        // CleanQueue falls back to the 'error' event itself when the
        // queue turns out to be empty, so nothing goes unreported.
        Napi::Function prepare_cb = baton->callback.Value();
        if ((IS_FUNCTION(prepare_cb)) || stmt->queue.empty()) {
            Error(baton.get());
        } else {
            // Build the error before firing anything: a callback that
            // throws leaves a pending exception, and constructing an
            // Error while one is pending is a fatal napi error.
            EXCEPTION(stmt->message, stmt->status, exception);
            // Settle the queued calls first -- they are what the caller
            // awaits -- then still report the failure on the statement
            // itself, which is the documented surface for a prepare that
            // was given no callback of its own.
            stmt->FailQueue(exception, false);
            Napi::Value info[] = {
                Napi::String::New(env, "error"), exception
            };
            EMIT_EVENT(stmt->Value(), 2, info);
        }
        stmt->Finalize_();
    }
    else {
        // Publish before `prepared`: both are JS-thread state, and this
        // is the first point at which JS can observe either.
        stmt->PublishMetadata();
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
    // The full dispatch lives in ConvertToField (src/convert.cc) since
    // Deliverable 06: statement binding and user-function results share one
    // converter so their type behaviour cannot drift. Only the position
    // naming and the position itself (index vs name) are bind-specific.
    if constexpr (std::is_integral_v<T>) {
        return ConvertToField(source, DescribeBindPosition(pos),
            FieldPos{ static_cast<int>(pos), "" });
    } else {
        return ConvertToField(source, DescribeBindPosition(pos),
            FieldPos{ 0, pos });
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
    baton->bind_supplied = (start < last);

    if (start < last) {
        if (!ParseBindArguments(info, start, last, &baton->parameters)) {
            // BindParameter threw a TypeError/RangeError, or the shape was
            // malformed.
            delete baton;
            return NULL;
        }
    }

    return baton;
}

// The bind-argument shapes shared by every entry point: one array, N
// positional values, or one named-parameter object. Appends converted
// fields to `parameters` in bind order. Returns false with a pending
// TypeError/RangeError for an unsupported value or malformed shape —
// nothing is ever silently skipped or coerced.
//
// A member (not a free function) so it shares Statement::BindParameter and
// therefore the one JS->SQLite converter in src/convert.cc. The
// synchronous fast paths call this directly: they have no Baton to fill —
// a Baton exists for the async paths' queueing and cross-thread lifetimes,
// none of which a synchronous call has.
bool Statement::ParseBindArguments(const Napi::CallbackInfo& info, int start,
        int last, Parameters* parameters) {
    auto env = info.Env();

    if (info[start].IsArray()) {
        auto array = info[start].As<Napi::Array>();
        int length = array.Length();
        parameters->reserve(length);
        // Note: bind parameters start with 1.
        for (int i = 0, pos = 1; i < length; i++, pos++) {
            auto field = BindParameter((array).Get(i), i + 1);
            if (field == nullptr) {
                return false;
            }
            parameters->push_back(std::move(field));
        }
    }
    // Cheap checks first; IsDate matches across realms, and the RegExp
    // global lookup only runs once the value is known to be an object.
    // Binary views (Buffer, typed arrays, DataViews, ArrayBuffers) go
    // positional like the other non-map bind shapes.
    else if (!info[start].IsObject() || info[start].IsBuffer()
            || info[start].IsTypedArray() || info[start].IsDataView()
            || info[start].IsArrayBuffer()
            || info[start].IsDate()
            || OtherInstanceOf(info[start].As<Object>(), "RegExp")) {
        // Parameters directly in array.
        // Note: bind parameters start with 1.
        parameters->reserve(last - start);
        for (int i = start, pos = 1; i < last; i++, pos++) {
            auto field = BindParameter(info[i], pos);
            if (field == nullptr) {
                return false;
            }
            parameters->push_back(std::move(field));
        }
    }
    else if (info[start].IsObject()) {
        auto object = info[start].As<Napi::Object>();
        auto array = object.GetPropertyNames();
        if (env.IsExceptionPending()) return false;
        int length = array.Length();
        parameters->reserve(length);
        for (int i = 0; i < length; i++) {
            Napi::Value name = (array).Get(i);
            Napi::Number num = name.ToNumber();

            if (num.Int32Value() == num.DoubleValue()) {
                auto field = BindParameter((object).Get(name), num.Int32Value());
                if (field == nullptr) {
                    return false;
                }
                parameters->push_back(std::move(field));
            }
            else {
                std::string param_name = name.As<Napi::String>().Utf8Value();
                auto field = BindParameter((object).Get(name), param_name.c_str());
                if (field == nullptr) {
                    return false;
                }
                parameters->push_back(std::move(field));
            }
        }
    }
    else {
        return false;
    }

    return true;
}

bool Statement::Bind(Parameters&& parameters, bool supplied) {
    if (!supplied && parameters.empty()) {
        // A call with no bind argument re-steps the statement with its
        // previous bindings. Keep bound_payloads alive: the earlier
        // SQLITE_STATIC payloads are still referenced.
        return true;
    }

    sqlite3_reset(_handle);
    sqlite3_clear_bindings(_handle);

    // Hold the previous payloads until every parameter has been rebound.
    Parameters stale;
    stale.swap(bound_payloads);

    // Parameter count must match exactly. Too few used to silently bind
    // NULL; too many were silently ignored (or hit SQLITE_RANGE late in
    // the bind loop with an unhelpful message). Note that for ?N-style
    // SQL the count is the largest index, which is what the array form
    // supplies.
    int expected = sqlite3_bind_parameter_count(_handle);

    // Historical "accidental undefined" call shape: a parameter list made
    // up entirely of `undefined` against a statement with no parameters is
    // ignored, so generic wrappers forwarding an absent value keep working
    // (pinned by test/prepare.test.js). `undefined` against a statement
    // that does take parameters still binds NULL below.
    if (expected == 0 && !parameters.empty()) {
        bool all_undefined = true;
        for (auto& f : parameters) {
            if (!f->from_undefined) { all_undefined = false; break; }
        }
        if (all_undefined) return true;
    }

    if (static_cast<int>(parameters.size()) != expected) {
        // Bindings were cleared above, so no stale SQLITE_STATIC pointer
        // can dangle into the payloads we are about to release.
        status = SQLITE_RANGE;
        message = "supplied " + std::to_string(parameters.size()) +
            " parameter(s) but the statement takes " + std::to_string(expected);
        return false;
    }

    for (auto& field : parameters) {
        if (field == nullptr) {
            // Unreachable by construction: BindParameter either returns a
            // field or throws. Kept as a guard rather than an assert
            // because NDEBUG builds drop those.
            status = SQLITE_MISUSE;
            message = "internal error: unclassified bind parameter";
            return false;
        }

        unsigned int pos;
        if (field->index > 0) {
            pos = field->index;
        }
        else {
            pos = sqlite3_bind_parameter_index(_handle, field->name.c_str());
            if (pos == 0) {
                // The named parameter does not exist in the SQL — almost
                // always a typo'd key. Previously surfaced as a generic
                // SQLITE_RANGE from sqlite3_bind_* (or was silently
                // ignored when the value was skipped). Clear the partial
                // bindings from this call, like the bind-failure path.
                sqlite3_clear_bindings(_handle);
                bound_payloads.clear();
                status = SQLITE_RANGE;
                message = "unknown named parameter \"" + field->name + "\"";
                return false;
            }
        }

        switch (field->type) {
            case SQLITE_INTEGER: {
                status = sqlite3_bind_int64(_handle, pos,
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
                    f->value, static_cast<int>(f->length), SQLITE_STATIC);
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

bool Statement::BindArgumentsDirect(const Napi::CallbackInfo& info,
        int start, int last, bool supplied) {
    auto env = info.Env();

    if (!supplied) {
        // A call with no bind argument re-steps the statement with its
        // previous bindings, so nothing here may touch them — including
        // bound_payloads, whose SQLITE_STATIC pointers are still live.
        return true;
    }

    // Resolve the argument shape and the values it carries, without
    // converting anything yet: the arity check has to run before the first
    // bind so a mismatched call cannot half-bind the statement.
    enum Shape { POSITIONAL, ARRAY, NAMED } shape = POSITIONAL;
    Napi::Array array;
    Napi::Object object;
    Napi::Array keys;
    int count = 0;

    if (start < last && info[start].IsArray()) {
        shape = ARRAY;
        array = info[start].As<Napi::Array>();
        count = static_cast<int>(array.Length());
    }
    // Cheap checks first; IsDate matches across realms, and the RegExp
    // global lookup only runs once the value is known to be an object.
    // Binary views go positional like the other non-map bind shapes.
    else if (start < last && info[start].IsObject()
            && !info[start].IsBuffer() && !info[start].IsTypedArray()
            && !info[start].IsDataView() && !info[start].IsArrayBuffer()
            && !info[start].IsDate()
            && !OtherInstanceOf(info[start].As<Object>(), "RegExp")) {
        shape = NAMED;
        object = info[start].As<Napi::Object>();
        keys = object.GetPropertyNames();
        if (env.IsExceptionPending()) return false;
        count = static_cast<int>(keys.Length());
    }
    else {
        count = last - start;
    }

    // Order matches the Field path: the statement is reset and its
    // bindings cleared before the checks, so a rejected call leaves no
    // stale binding behind either way.
    sqlite3_reset(_handle);
    sqlite3_clear_bindings(_handle);
    bound_payloads.clear();

    const int expected = sqlite3_bind_parameter_count(_handle);

    // Historical "accidental undefined" call shape: a parameter list made
    // up entirely of `undefined` against a statement with no parameters is
    // ignored, so generic wrappers forwarding an absent value keep
    // working. Only reachable when the statement takes no parameters, so
    // the extra pass costs nothing on the hot path.
    if (expected == 0 && count > 0) {
        bool all_undefined = true;
        for (int i = 0; i < count && all_undefined; i++) {
            Napi::Value value = shape == ARRAY ? array.Get(i)
                : shape == NAMED ? object.Get(keys.Get(i))
                : info[start + i];
            if (env.IsExceptionPending()) return false;
            if (!value.IsUndefined()) all_undefined = false;
        }
        if (all_undefined) return true;
    }

    if (count != expected) {
        status = SQLITE_RANGE;
        message = "supplied " + std::to_string(count) +
            " parameter(s) but the statement takes " +
            std::to_string(expected);
        return false;
    }

    for (int i = 0; i < count; i++) {
        Napi::Value value;
        int pos = i + 1;
        // Only set for a genuinely named parameter; the subject is a
        // borrowed view either way and formats nothing unless it throws.
        std::string param_name;
        bool named = false;

        if (shape == NAMED) {
            Napi::Value name = keys.Get(i);
            if (env.IsExceptionPending()) return false;
            Napi::Number num = name.ToNumber();
            if (num.Int32Value() == num.DoubleValue()) {
                pos = num.Int32Value();
            }
            else {
                param_name = name.As<Napi::String>().Utf8Value();
                named = true;
                pos = sqlite3_bind_parameter_index(_handle,
                    param_name.c_str());
                if (pos == 0) {
                    // Almost always a typo'd key. Clear the partial
                    // bindings, like the bind-failure path below.
                    sqlite3_clear_bindings(_handle);
                    status = SQLITE_RANGE;
                    message = "unknown named parameter \"" + param_name
                        + "\"";
                    return false;
                }
            }
            value = object.Get(name);
        }
        else {
            value = shape == ARRAY ? array.Get(i) : info[start + i];
        }
        if (env.IsExceptionPending()) return false;

        int rc = SQLITE_OK;
        const BindSubject subject = named
            ? BindSubject(param_name.c_str()) : BindSubject(pos);
        if (!BindValueDirect(_handle, pos, value, subject, &rc, NULL)) {
            // BindValueDirect threw for an unsupported value.
            sqlite3_clear_bindings(_handle);
            return false;
        }
        if (rc != SQLITE_OK) {
            // Clear every binding so no partially bound statement is left
            // reachable.
            sqlite3_clear_bindings(_handle);
            status = rc;
            message = std::string(sqlite3_errmsg(db->_handle));
            return false;
        }
    }

    status = SQLITE_OK;
    return true;
}

Napi::Value Statement::Bind(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    auto baton = stmt->Bind<Baton>(info);
    if (baton == NULL) {
        // BindParameter already threw for unsupported values; the generic
        // message only covers malformed top-level argument shapes.
        if (!env.IsExceptionPending()) {
            Napi::TypeError::New(env, "Data type is not supported")
                .ThrowAsJavaScriptException();
        }
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
    stmt->Bind(std::move(baton->parameters), baton->bind_supplied);
    sqlite3_mutex_leave(mtx);
}

void Statement::Work_AfterBind(napi_env e, napi_status status, void* data) {
    std::unique_ptr<Baton> baton(static_cast<Baton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
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
        if (!env.IsExceptionPending()) {
            Napi::TypeError::New(env, "Data type is not supported")
                .ThrowAsJavaScriptException();
        }
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

    if (stmt->status != SQLITE_DONE || baton->parameters.size()
            || baton->bind_supplied) {
        STATEMENT_MUTEX(mtx);
        sqlite3_mutex_enter(mtx);

        if (stmt->Bind(std::move(baton->parameters), baton->bind_supplied)) {
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
    AFTER_WORK_TEARDOWN_GUARD(baton);
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
                Napi::Value row = stmt->RowToJS(env, &baton->row);
                if (env.IsExceptionPending()) {
                    // 'number' integer mode and an unsafe int64: deliver
                    // the RangeError to the callback instead of leaving a
                    // pending exception in the async completion.
                    Napi::Value argv[] = { TakePendingError(env) };
                    TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
                }
                else {
                    Napi::Value argv[] = { env.Null(), row };
                    TRY_CATCH_CALL(stmt->Value(), cb, 2, argv);
                }
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
        if (!env.IsExceptionPending()) {
            Napi::TypeError::New(env, "Data type is not supported")
                .ThrowAsJavaScriptException();
        }
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
    if (!baton->parameters.size() && !baton->bind_supplied) {
        sqlite3_reset(stmt->_handle);
    }

    if (stmt->Bind(std::move(baton->parameters), baton->bind_supplied)) {
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
    AFTER_WORK_TEARDOWN_GUARD(baton);
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
        // Fire callbacks. lastID/changes are exposed through accessors
        // reading the stored members, so `this.lastID` inside the
        // callback applies the database's integer mode.
        stmt->RecordRunResult(baton->inserted_id, baton->changes);

        Napi::Function cb = baton->callback.Value();
        if (IS_FUNCTION(cb)) {
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
        if (!env.IsExceptionPending()) {
            Napi::TypeError::New(env, "Data type is not supported")
                .ThrowAsJavaScriptException();
        }
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
    if (!baton->parameters.size() && !baton->bind_supplied) {
        sqlite3_reset(stmt->_handle);
    }

    if (stmt->Bind(std::move(baton->parameters), baton->bind_supplied)) {
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
    AFTER_WORK_TEARDOWN_GUARD(baton);
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
            Napi::Array result;
            const bool failed = !stmt->CellRowsToJS(env, baton->rows,
                baton->columns, &result);

            if (failed) {
                Napi::Value argv[] = { TakePendingError(env) };
                TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
            }
            else {
                Napi::Value argv[] = { env.Null(), result };
                TRY_CATCH_CALL(stmt->Value(), cb, 2, argv);
            }
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
        if (!env.IsExceptionPending()) {
            Napi::TypeError::New(env, "Data type is not supported")
                .ThrowAsJavaScriptException();
        }
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
    if (!baton->parameters.size() && !baton->bind_supplied) {
        sqlite3_reset(stmt->_handle);
    }

    sqlite3_mutex_enter(mtx);
    bool bound = stmt->Bind(std::move(baton->parameters), baton->bind_supplied);
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
            std::vector<napi_value> keys;
            for (auto& row : rows) {
                // A scope per row, not per batch: each row is handed to the
                // callback and then unreachable, so the handles must not
                // accumulate for the length of the result set. The keys are
                // resolved inside it for the same reason CellRowsToJS
                // re-resolves per batch — handles die with their scope.
                Napi::HandleScope row_scope(env);
                async->stmt->ResolveColumnKeys(&keys);

                napi_value converted = NULL;
                if (!async->stmt->ConvertCellRow(env, &row, keys,
                        &converted)) {
                    // 'number' integer mode and an unsafe int64: hand the
                    // RangeError to the item callback in place of the row.
                    argv[0] = TakePendingError(env);
                    TRY_CATCH_CALL(async->stmt->Value(), cb, 1, argv);
                    argv[0] = env.Null();
                    continue;
                }
                argv[1] = Napi::Value(env, converted);
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
    AFTER_WORK_TEARDOWN_GUARD(baton);
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
    AFTER_WORK_TEARDOWN_GUARD(baton);
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

// fetch(count, [params], [callback]): steps up to `count` rows and hands
// them back as one batch. Unlike all() the statement is deliberately NOT
// reset between calls, so successive fetches continue one cursor — this is
// the native half of the pull-based async iterator.
Napi::Value Statement::Fetch(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    REQUIRE_ARGUMENT_INTEGER(0, count);
    if (count < 1) {
        Napi::TypeError::New(env, "fetch count must be a positive integer")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    FetchBaton* baton = stmt->Bind<FetchBaton>(info, 1);
    if (baton == NULL) {
        if (!env.IsExceptionPending()) {
            Napi::TypeError::New(env, "Data type is not supported")
                .ThrowAsJavaScriptException();
        }
        return env.Null();
    }
    else {
        baton->count = count;
        stmt->Schedule(Work_BeginFetch, baton);
        return info.This();
    }
}

void Statement::Work_BeginFetch(Baton* baton) {
    STATEMENT_BEGIN(Fetch);
}

void Statement::Work_Fetch(napi_env e, void* data) {
    STATEMENT_INIT(FetchBaton);

    // Mirrors Work_Get's guard: a cursor that already returned SQLITE_DONE
    // must not be stepped again, unless this call rebinds (which resets).
    if (stmt->status != SQLITE_DONE || baton->parameters.size()
            || baton->bind_supplied) {
        STATEMENT_MUTEX(mtx);
        sqlite3_mutex_enter(mtx);

        if (stmt->Bind(std::move(baton->parameters), baton->bind_supplied)) {
            int n = 0;
            while (n < baton->count
                    && (stmt->status = sqlite3_step(stmt->_handle)) == SQLITE_ROW) {
                baton->rows.emplace_back();
                GetRow(&baton->rows.back(), stmt->_handle, &baton->columns);
                n++;
            }
            if (stmt->status != SQLITE_ROW && stmt->status != SQLITE_DONE) {
                stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
            }
        }

        sqlite3_mutex_leave(mtx);
    }

    baton->done = (stmt->status == SQLITE_DONE);
}

void Statement::Work_AfterFetch(napi_env e, napi_status status, void* data) {
    std::unique_ptr<FetchBaton> baton(static_cast<FetchBaton*>(data));
    AFTER_WORK_TEARDOWN_GUARD(baton);
    auto* stmt = baton->stmt;

    auto env = stmt->Env();
    Napi::HandleScope scope(env);

    // Runs the end-of-call bookkeeping on every exit path, including
    // TRY_CATCH_CALL's early return when a JS callback throws.
    STATEMENT_END();

    if (stmt->status != SQLITE_ROW && stmt->status != SQLITE_DONE) {
        Error(baton.get());
        return;
    }

    // Fire callbacks: (err, rows, done). `done` is true when the cursor is
    // exhausted, so the JS iterator can stop pulling without another round
    // trip. Row conversion is a single synchronous pass, like Work_AfterAll.
    Napi::Function cb = baton->callback.Value();

    if (IS_FUNCTION(cb)) {
        if (baton->rows.size()) {
            Napi::Array result;
            const bool failed = !stmt->CellRowsToJS(env, baton->rows,
                baton->columns, &result);

            if (failed) {
                Napi::Value argv[] = { TakePendingError(env) };
                TRY_CATCH_CALL(stmt->Value(), cb, 1, argv);
            }
            else {
                Napi::Value argv[] = {
                    env.Null(),
                    result,
                    Napi::Boolean::New(env, baton->done)
                };
                TRY_CATCH_CALL(stmt->Value(), cb, 3, argv);
            }
        }
        else {
            Napi::Value argv[] = {
                env.Null(),
                Napi::Array::New(env, 0),
                Napi::Boolean::New(env, baton->done)
            };
            TRY_CATCH_CALL(stmt->Value(), cb, 3, argv);
        }
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
    // pending == 0 plus an empty queue is the actual "nothing running or
    // deferred" condition. exclusiveHeld is not consulted: it says the
    // last dispatched call was exclusive, not that anything is still
    // running (pending and the queue say that).
    return prepared && !locked && !finalized && queue.empty()
        && db->db_state == Database::DbState::Open
        && db->pending == 0 && db->queue.empty();
}

void Statement::ThrowStatementError(Napi::Env env) {
    EXCEPTION(message, status, exception);
    db->AttachPendingJsError(exception_obj);
    exception.As<Napi::Error>().ThrowAsJavaScriptException();
}

bool Statement::SyncGate(Napi::Env env) {
    if (finalized) {
        Napi::Error::New(env, "Statement is already finalized")
            .ThrowAsJavaScriptException();
        return false;
    }
    if (!IdleForInline()) {
        Napi::Error::New(env,
            "database is busy: sync methods require a fully idle database"
        ).ThrowAsJavaScriptException();
        return false;
    }
    // A JavaScript collation cannot run on this thread: the comparison
    // would need the JS thread, which is the one about to block inside
    // SQLite — and unlike functions, a collation callback has no way to
    // report an error, so refusing up front is the only sound answer.
    // (Functions are handled per-invocation, with a precise error.) The
    // JS progress callback is refused for the same reason — it fires
    // during step (and prepare) and has no error channel. The
    // SharedArrayBuffer token form works fine from the sync methods.
    if (!db->js_collations.empty() || db->js_progress != NULL) {
        Napi::Error::New(env,
            "sync methods cannot be used while a JavaScript collation or "
            "progress callback is registered on this connection: a "
            "comparison or progress check would have to run JS on the "
            "thread that is blocked inside SQLite (a deadlock), and "
            "SQLite provides no way to fail a single one. "
            "removeCollation()/db.progress() first, or use the "
            "asynchronous API"
        ).ThrowAsJavaScriptException();
        return false;
    }
    return true;
}

void Statement::SyncColumnKeysLive(Napi::Env env) {
    // The rooted keys describe a captured shape; they stay valid while the
    // statement's own shape counters say the live statement still has that
    // shape. sqlite3_stmt_status(SQLITE_STMTSTATUS_REPREPARE) is the same
    // integer node:sqlite compares — a transparent re-prepare (schema
    // change, including a column rename that changes the result labels)
    // moves it and forces a re-read of the live names. The counter belongs
    // to the sqlite3_stmt and a Statement prepares exactly once, so a
    // fresh prepare can never resurrect a stale cache.
    const int reprepares =
        sqlite3_stmt_status(_handle, SQLITE_STMTSTATUS_REPREPARE, 0);
    const int cols = sqlite3_column_count(_handle);
    if (sync_keys_valid && reprepares == sync_keys_reprepares
            && cols == sync_keys_cols) {
        return;
    }

    sync_columns.names.clear();
    sync_columns.names.reserve(cols);
    for (int i = 0; i < cols; i++) {
        const char* name = sqlite3_column_name(_handle, i);
        sync_columns.names.emplace_back(name != NULL ? name : "");
    }
    SyncColumnKeys(env, sync_columns);
    sync_keys_valid = true;
    sync_keys_reprepares = reprepares;
    sync_keys_cols = cols;
}

Napi::Value Statement::GetSync(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    int row_mode = SYNC_ROW_OBJECT;
    int end = info.Length();
    if (end > 0 && ParseSyncReadOptions(info[end - 1], &row_mode)) end--;
    if (env.IsExceptionPending()) return env.Null();
    if (!SyncGate(env)) return env.Null();
    if (end > 0 && info[end - 1].IsFunction()) {
        Napi::TypeError::New(env, "Sync methods do not take a callback")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    const bool bind_supplied = (end > 0);

    // While this thread is inside sqlite, a user-defined function invoked
    // by the statement must refuse to make its round trip (it would wait
    // for this very thread) — the guard is what its refusal tests.
    Database::SyncSqliteGuard sync_guard(stmt->db);

    // Mirrors Work_Get: step unless the cursor is already exhausted and
    // no new parameters were supplied.
    if (stmt->status != SQLITE_DONE || bind_supplied) {
        if (!stmt->BindArgumentsDirect(info, 0, end, bind_supplied)) {
            if (env.IsExceptionPending()) return env.Null();
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
        // Straight from the live statement: no Row, no per-cell string
        // copy. The async path still materialises a Row because it reads
        // on a worker thread; here the row is converted on the thread that
        // stepped it, so the intermediate was pure cost.
        stmt->SyncColumnKeysLive(env);
        if (row_mode == SYNC_ROW_ARRAY) {
            // The array shape carries no keys; only the names (for the
            // integer-mode RangeError) and their cache stay valid.
            return stmt->CurrentRowToJS(env, {}, row_mode);
        }
        std::vector<napi_value> keys;
        stmt->ResolveColumnKeys(&keys);
        // A RangeError from the integer mode propagates to the caller
        // with the pending exception.
        return stmt->CurrentRowToJS(env, keys, row_mode);
    }
    return env.Undefined();
}

Napi::Value Statement::RunSync(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    int end = info.Length();
    if (!SyncGate(env)) return env.Null();
    if (end > 0 && info[end - 1].IsFunction()) {
        Napi::TypeError::New(env, "Sync methods do not take a callback")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    const bool bind_supplied = (end > 0);

    Database::SyncSqliteGuard sync_guard(stmt->db);

    // Mirrors Work_Run, including the explicit reset for parameterless
    // re-execution.
    if (!bind_supplied) {
        sqlite3_reset(stmt->_handle);
    }

    if (!stmt->BindArgumentsDirect(info, 0, end, bind_supplied)) {
        if (env.IsExceptionPending()) return env.Null();
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

    stmt->RecordRunResult(inserted_id, changes);

    return info.This();
}

Napi::Value Statement::AllSync(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    int row_mode = SYNC_ROW_OBJECT;
    int end = info.Length();
    if (end > 0 && ParseSyncReadOptions(info[end - 1], &row_mode)) end--;
    if (env.IsExceptionPending()) return env.Null();
    if (!SyncGate(env)) return env.Null();
    if (end > 0 && info[end - 1].IsFunction()) {
        Napi::TypeError::New(env, "Sync methods do not take a callback")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    const bool bind_supplied = (end > 0);

    Database::SyncSqliteGuard sync_guard(stmt->db);

    if (!bind_supplied) {
        sqlite3_reset(stmt->_handle);
    }

    if (!stmt->BindArgumentsDirect(info, 0, end, bind_supplied)) {
        if (env.IsExceptionPending()) return env.Null();
        stmt->ThrowStatementError(env);
        return env.Null();
    }

    // One pass: step and convert together, instead of materialising the
    // whole result set as Rows and walking it again. The old shape copied
    // every text and blob twice and allocated a Row plus a Cell per column
    // per row, none of which the caller ever saw.
    //
    // Rows are converted straight into `result` under batched handle
    // scopes — one HandleScope per kRowsPerScope rows instead of an
    // escapable scope per row. A stored value is rooted by the result
    // array itself, so closing a batch's scope cannot collect anything the
    // caller still needs; the batch only bounds how many dead handles a
    // large read holds at once.
    static constexpr int kRowsPerScope = 256;

    Napi::Array result(Napi::Array::New(env));
    std::vector<napi_value> keys;
    bool keys_ready = false;
    bool failed = false;
    uint32_t count = 0;
    int cols = 0;

    bool exhausted = false;
    while (!exhausted) {
        Napi::HandleScope batch(env);
        // Handles live only in the scope that created them: the resolved
        // key strings must be re-resolved once per batch, not once per
        // call — napi_get_reference_value per 256 rows is noise. The very
        // first batch resolves them on its first row instead, after the
        // keys have been built for this execution's shape.
        if (keys_ready && row_mode == SYNC_ROW_OBJECT) {
            stmt->ResolveColumnKeys(&keys);
        }
        for (int i = 0; i < kRowsPerScope; i++) {
            stmt->status = sqlite3_step(stmt->_handle);
            if (stmt->status != SQLITE_ROW) {
                exhausted = true;
                break;
            }
            if (!keys_ready) {
                // The result shape cannot change between the rows of one
                // execution, so the names and their keys are settled on
                // the first row and reused for every row after it.
                stmt->SyncColumnKeysLive(env);
                cols = static_cast<int>(sync_columns.names.size());
                keys_ready = true;
                if (row_mode == SYNC_ROW_OBJECT) {
                    stmt->ResolveColumnKeys(&keys);
                }
            }
            napi_value row = NULL;
            // A RangeError from the integer mode leaves a pending exception
            // and reports false; the offending value may be in any row, not
            // only the first.
            if (!stmt->ConvertCurrentRow(env, keys, row_mode, cols, &row)) {
                failed = true;
                exhausted = true;
                break;
            }
            napi_set_element(env, result, count++, row);
        }
    }
    if (failed) {
        return env.Null();
    }
    if (stmt->status != SQLITE_DONE) {
        stmt->message = std::string(sqlite3_errmsg(stmt->db->_handle));
        stmt->ThrowStatementError(env);
        return env.Null();
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
    // The compiled row factories bake in the old names and arity, so they
    // die with the keys. This is the only place the shape changes, so it is
    // the only place they can go stale.
    ResetRowFactories(env);
    column_keys.clear();
    column_keys.reserve(columns.names.size());
    for (const auto& name : columns.names) {
        column_keys.emplace_back(Napi::Persistent(Napi::String::New(env, name)));
    }
    column_keys_source = columns.names;
}

Napi::Value Statement::Int64ToJS(Napi::Env env, sqlite3_int64 value,
        const std::string& what) {
    return ConvertInt64ToJS(env, value, db->integer_mode, what);
}

void Statement::RecordRunResult(sqlite3_int64 id, int changes) {
    last_insert_id = id;
    last_changes = changes;
    has_run_result = true;
}

Napi::Value Statement::GetLastID(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (!has_run_result) return env.Undefined();
    return Int64ToJS(env, last_insert_id, "lastID");
}

Napi::Value Statement::GetLastIDBigInt(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (!has_run_result) return env.Undefined();
    return Napi::BigInt::New(env, static_cast<int64_t>(last_insert_id));
}

Napi::Value Statement::GetChanges(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (!has_run_result) return env.Undefined();
    return Napi::Number::New(env, last_changes);
}

Napi::Value Statement::FinalizedGetter(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), finalized);
}

// --- Introspection (Deliverable 07) ---------------------------------------

// Must be called on the thread that prepared, with the connection mutex
// held (both prepare paths already satisfy this). Reads only metadata
// that is fixed for the lifetime of the sqlite3_stmt, and writes only
// pending_meta — never the accessor-visible fields, which belong to the
// JS thread. PublishMetadata() hands it over.
void Statement::SnapshotMetadata() {
    Metadata snapshot;
    snapshot.readonly = sqlite3_stmt_readonly(_handle) != 0;

    snapshot.param_count = sqlite3_bind_parameter_count(_handle);
    snapshot.param_names.reserve(snapshot.param_count);
    for (int i = 1; i <= snapshot.param_count; i++) {
        const char* name = sqlite3_bind_parameter_name(_handle, i);
        snapshot.param_names.emplace_back(name != NULL ? name : "");
    }

    int cols = sqlite3_column_count(_handle);
    snapshot.columns.reserve(cols);
    for (int i = 0; i < cols; i++) {
        ColumnMeta meta;
        const char* name = sqlite3_column_name(_handle, i);
        meta.name = name != NULL ? name : "";
        const char* decl = sqlite3_column_decltype(_handle, i);
        if (decl != NULL) meta.decltype_ = decl;
        // The origin family requires SQLITE_ENABLE_COLUMN_METADATA
        // (enabled in deps/sqlite3.gyp since Deliverable 07).
#ifdef SQLITE_ENABLE_COLUMN_METADATA
        const char* db_name = sqlite3_column_database_name(_handle, i);
        if (db_name != NULL) meta.database = db_name;
        const char* table = sqlite3_column_table_name(_handle, i);
        if (table != NULL) meta.table = table;
        const char* origin = sqlite3_column_origin_name(_handle, i);
        if (origin != NULL) meta.origin = origin;
#endif
        snapshot.columns.push_back(std::move(meta));
    }

    pending_meta = std::move(snapshot);
}

// JS thread only. Making the snapshot visible is a single flag flip
// after the move, so an accessor either sees no snapshot or sees a
// complete one; there is no window in which meta_valid is set while the
// vectors are still being filled.
void Statement::PublishMetadata() {
    meta = std::move(pending_meta);
    meta_valid = true;
}

Napi::Value Statement::ReadonlyGetter(const Napi::CallbackInfo& info) {
    if (!meta_valid) return info.Env().Undefined();
    return Napi::Boolean::New(info.Env(), meta.readonly);
}

Napi::Value Statement::ParameterCountGetter(const Napi::CallbackInfo& info) {
    if (!meta_valid) return info.Env().Undefined();
    return Napi::Number::New(info.Env(), meta.param_count);
}

Napi::Value Statement::ParameterNamesGetter(const Napi::CallbackInfo& info) {
    if (!meta_valid) return info.Env().Undefined();
    auto env = info.Env();
    Napi::Array result = Napi::Array::New(env, meta.param_names.size());
    for (size_t i = 0; i < meta.param_names.size(); i++) {
        // Positional `?` parameters have no name: null keeps the index
        // mapping honest instead of shifting the array.
        result.Set(i, meta.param_names[i].empty()
            ? env.Null().As<Napi::Value>()
            : Napi::String::New(env, meta.param_names[i]).As<Napi::Value>());
    }
    return result;
}

Napi::Value Statement::ColumnsGetter(const Napi::CallbackInfo& info) {
    if (!meta_valid) return info.Env().Undefined();
    auto env = info.Env();
    Napi::Array result = Napi::Array::New(env, meta.columns.size());
    size_t i = 0;
    for (const auto& column : meta.columns) {
        Napi::Object col = Napi::Object::New(env);
        col.Set("name", Napi::String::New(env, column.name.c_str()));
        // Fields sqlite reports as NULL are omitted rather than nulled:
        // an absent declaredType says "the column has none", a null one
        // would read as "unknown".
        if (!column.decltype_.empty()) {
            col.Set("declaredType",
                Napi::String::New(env, column.decltype_.c_str()));
        }
        if (!column.database.empty()) {
            col.Set("database",
                Napi::String::New(env, column.database.c_str()));
        }
        if (!column.table.empty()) {
            col.Set("table", Napi::String::New(env, column.table.c_str()));
        }
        if (!column.origin.empty()) {
            col.Set("origin", Napi::String::New(env, column.origin.c_str()));
        }
        result.Set(i++, col);
    }
    return result;
}

// status(op, reset?): live sqlite3_stmt_status counters. Takes the
// connection mutex for the read; refuses while a JS round trip could be
// holding it (the mutex would be waiting on this very thread).
Napi::Value Statement::Status(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Statement* stmt = this;

    REQUIRE_ARGUMENT_INTEGER(0, op);
    bool reset = false;
    if (info.Length() > 1 && !info[1].IsUndefined()) {
        if (!info[1].IsBoolean()) {
            Napi::TypeError::New(env, "reset flag must be a boolean")
                .ThrowAsJavaScriptException();
            return env.Null();
        }
        reset = info[1].As<Napi::Boolean>().Value();
    }

    if (finalized) {
        Napi::Error::New(env, "Statement is already finalized")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    if (!prepared) {
        Napi::Error::New(env,
            "Statement is not prepared yet").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (db->MayBlockOnWorkerRoundTrip()) {
        Napi::Error::New(env,
            "statement.status() cannot run while a JavaScript function, "
            "collation or progress callback is mid-call on this "
            "connection; call it after the query completes"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }

    if (db->_handle == NULL) {
        Napi::Error::New(env, "Database handle is closed")
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    sqlite3_mutex* mtx = sqlite3_db_mutex(db->_handle);
    sqlite3_mutex_enter(mtx);
    int value = sqlite3_stmt_status(stmt->_handle, op, reset ? 1 : 0);
    sqlite3_mutex_leave(mtx);

    return Napi::Number::New(env, value);
}

bool Statement::ConvertCellRow(Napi::Env env, Row* row,
        const std::vector<napi_value>& keys, napi_value* out) {
    const int mode = db->integer_mode;
    const size_t key_count = keys.size();

    // Same one-call-per-row build as the synchronous path; see
    // ConvertCurrentRow for why the store loop below is the slow shape.
    napi_value factory = RowFactoryForShape(env, SYNC_ROW_OBJECT);
    if (factory != NULL && row->size() == column_keys_source.size()) {
        const int cols = static_cast<int>(row->size());
        std::vector<napi_value> cells(row->size());
        for (int i = 0; i < cols; i++) {
            bool raised = false;
            cells[i] = CellToJS(env, (*row)[i], mode,
                ValueOrigin(&column_keys_source, static_cast<size_t>(i)),
                true, &raised);
            if (raised) return false;
        }
        return CallRowFactory(env, factory, cells, cols, out);
    }

    napi_value result;
    napi_create_object(env, &result);

    size_t i = 0;
    for (auto& cell : *row) {
        // The column description is passed by reference to the cached
        // names, not built here: it is only formatted if the conversion
        // raises the 'number'-mode RangeError. Building it eagerly was a
        // heap allocation per cell on every successful read.
        bool raised = false;
        Napi::Value value = CellToJS(env, cell, mode,
            ValueOrigin(&column_keys_source, i), true, &raised);
        if (raised) return false;

        // The keys always cover the row: both are derived from the same
        // sqlite3_column_count, and a mid-stream re-prepare refreshes them
        // together. The bound is kept so a shape change that slipped through
        // can never index out of range.
        if (i < key_count) {
            // Raw napi on already-resolved handles: the key references are
            // dereferenced once per batch by the caller, not once per cell.
            napi_set_property(env, result, keys[i], value);
        }
        i++;
    }

    *out = result;
    return true;
}

Napi::Value Statement::RowToJS(Napi::Env env, Row* row) {
    Napi::EscapableHandleScope scope(env);

    std::vector<napi_value> keys;
    ResolveColumnKeys(&keys);

    napi_value result = NULL;
    if (!ConvertCellRow(env, row, keys, &result)) {
        return scope.Escape(env.Null());
    }
    return scope.Escape(Napi::Value(env, result));
}

bool Statement::CellRowsToJS(Napi::Env env, Rows& rows,
        const Columns& columns, Napi::Array* out) {
    SyncColumnKeys(env, columns);

    Napi::Array result(Napi::Array::New(env, rows.size()));
    *out = result;

    // One scope per batch rather than one per row. The handles a scope
    // creates die with it, so the resolved keys are re-resolved inside each
    // batch; the converted rows are safe because they are stored into
    // `result` — a rooted array in the caller's scope — before the batch
    // scope closes.
    const size_t kBatch = 256;
    std::vector<napi_value> keys;

    for (size_t start = 0; start < rows.size(); start += kBatch) {
        Napi::HandleScope batch(env);
        ResolveColumnKeys(&keys);

        const size_t end = std::min(start + kBatch, rows.size());
        for (size_t i = start; i < end; i++) {
            napi_value row = NULL;
            if (!ConvertCellRow(env, &rows[i], keys, &row)) {
                // 'number' integer mode and an unsafe int64: the RangeError
                // is pending for the caller to deliver.
                return false;
            }
            napi_set_element(env, result, static_cast<uint32_t>(i), row);
        }
    }

    return true;
}

void Statement::ResetRowFactories(Napi::Env env) {
    for (int i = 0; i < 2; i++) {
        if (row_factory_[i] != NULL) {
            napi_delete_reference(env, row_factory_[i]);
            row_factory_[i] = NULL;
        }
    }
}

napi_value Statement::RowFactoryForShape(Napi::Env env, int row_mode) {
    const int slot = (row_mode == SYNC_ROW_ARRAY) ? 1 : 0;

    if (row_factory_[slot] != NULL) {
        napi_value cached = NULL;
        if (napi_get_reference_value(env, row_factory_[slot], &cached)
                == napi_ok && cached != NULL) {
            return cached;
        }
    }

    auto* addon = env.GetInstanceData<Database::AddonData>();
    if (addon == NULL || addon->row_factory_generator == NULL
            || addon->row_factory_unavailable) {
        return NULL;
    }

    // Compiling means calling JS, which is refused while an exception is
    // pending. Bail out without diagnosing anything: the caller's store
    // loop stays correct, and a pending exception here says nothing about
    // whether this realm can generate code.
    if (env.IsExceptionPending()) return NULL;

    const size_t cols = column_keys_source.size();
    if (cols == 0 || cols > static_cast<size_t>(kMaxFactoryColumns)) {
        return NULL;
    }

    napi_value generator = NULL;
    if (napi_get_reference_value(env, addon->row_factory_generator, &generator)
            != napi_ok || generator == NULL) {
        return NULL;
    }

    // The names go over as a JS array so the generated source is escaped by
    // JSON.stringify rather than by an escaper of our own.
    napi_value names = NULL;
    napi_create_array_with_length(env, cols, &names);
    for (size_t i = 0; i < cols; i++) {
        napi_value name = NULL;
        if (napi_create_string_utf8(env, column_keys_source[i].data(),
                column_keys_source[i].size(), &name) != napi_ok) {
            return NULL;
        }
        napi_set_element(env, names, static_cast<uint32_t>(i), name);
    }

    napi_value want_array = NULL;
    napi_get_boolean(env, row_mode == SYNC_ROW_ARRAY, &want_array);
    napi_value argv[] = { names, want_array };
    napi_value undef = NULL;
    napi_get_undefined(env, &undef);

    napi_value factory = NULL;
    const napi_status st = napi_call_function(env, undef, generator, 2, argv,
        &factory);
    if (st != napi_ok || factory == NULL) {
        // A realm that forbids code generation from strings (a CSP'd
        // renderer, --disallow-code-generation-from-strings) throws here.
        // That is a permanent property of the environment, so remember it
        // and never pay for the attempt again; the store loop stays
        // correct, only slower.
        if (env.IsExceptionPending()) {
            napi_value ignored = NULL;
            napi_get_and_clear_last_exception(env, &ignored);
        }
        addon->row_factory_unavailable = true;
        return NULL;
    }

    napi_valuetype type = napi_undefined;
    napi_typeof(env, factory, &type);
    if (type != napi_function) return NULL;

    napi_create_reference(env, factory, 1, &row_factory_[slot]);
    return factory;
}

bool Statement::CallRowFactory(Napi::Env env, napi_value factory,
        const std::vector<napi_value>& cells, int cols, napi_value* out) {
    napi_value undef = NULL;
    napi_get_undefined(env, &undef);
    return napi_call_function(env, undef, factory,
        static_cast<size_t>(cols), cells.data(), out) == napi_ok;
}

void Statement::ResolveColumnKeys(std::vector<napi_value>* out) {
    out->clear();
    out->reserve(column_keys.size());
    for (auto& key : column_keys) {
        out->push_back(key.Value());
    }
}

bool Statement::ConvertCurrentRow(Napi::Env env,
        const std::vector<napi_value>& keys, int row_mode, int cols,
        napi_value* out) {
    const int mode = db->integer_mode;
    const size_t key_count = keys.size();

    // The fast shape: convert the cells into a plain argument vector and
    // let a generated monomorphic function build the row in one call.
    // Profiling showed the per-column store loops below spend two thirds of
    // a read inside V8's generic property/element paths — a LookupIterator
    // and a map or elements-kind transition per column, which for objects
    // also reallocates the backing property array as it grows. One call
    // hands V8 the whole row at once, so it allocates the final shape
    // directly. See docs/performance.md.
    napi_value factory = RowFactoryForShape(env, row_mode);
    if (factory != NULL) {
        std::vector<napi_value> cells(static_cast<size_t>(cols));
        for (int i = 0; i < cols; i++) {
            bool raised = false;
            cells[i] = ColumnToJS(env, _handle, i, mode,
                ValueOrigin(&column_keys_source, static_cast<size_t>(i)),
                &raised);
            if (raised) return false;
        }
        return CallRowFactory(env, factory, cells, cols, out);
    }

    if (row_mode == SYNC_ROW_ARRAY) {
        // The bulk-reader shape: one pre-sized array per row, values in
        // result-column order. No property stores and no shape to
        // transition — duplicate column names keep every value instead of
        // collapsing, which is the point of the shape.
        napi_value row;
        napi_create_array_with_length(env,
            static_cast<size_t>(cols), &row);
        for (int i = 0; i < cols; i++) {
            bool raised = false;
            Napi::Value value = ColumnToJS(env, _handle, i, mode,
                ValueOrigin(&column_keys_source, static_cast<size_t>(i)),
                &raised);
            if (raised) return false;
            napi_set_element(env, row, static_cast<uint32_t>(i), value);
        }
        *out = row;
        return true;
    }

    napi_value result;
    napi_create_object(env, &result);

    for (int i = 0; i < cols; i++) {
        bool raised = false;
        Napi::Value value = ColumnToJS(env, _handle, i, mode,
            ValueOrigin(&column_keys_source, static_cast<size_t>(i)),
            &raised);
        if (raised) return false;
        // Same bound as RowToJS: keys and columns both derive from
        // sqlite3_column_count, so this cannot be exceeded in practice.
        if (static_cast<size_t>(i) < key_count) {
            // Raw napi on already-resolved handles: the key references are
            // dereferenced once per call by the caller, not once per cell.
            napi_set_property(env, result, keys[i], value);
        }
    }

    *out = result;
    return true;
}

Napi::Value Statement::CurrentRowToJS(Napi::Env env,
        const std::vector<napi_value>& keys, int row_mode) {
    Napi::EscapableHandleScope scope(env);

    napi_value row = NULL;
    if (!ConvertCurrentRow(env, keys, row_mode,
            sqlite3_column_count(_handle), &row)) {
        return scope.Escape(env.Null());
    }
    return scope.Escape(Napi::Value(env, row));
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

// Finalize-on-GC safety net: a collected statement that was never
// finalized is torn down here so a forgotten one degrades to "cleaned up
// at the next GC" instead of blocking close() forever. This runs in the
// ObjectWrap finalizer, so each step has to be safe there:
//
// - A statement with queued calls cannot reach this destructor: every
//   queued Baton holds a Ref on it. CleanQueue therefore sees an empty
//   queue and can never fire a JS callback from this context.
// - sqlite3_finalize is pure C API and takes the connection mutex
//   internally, so concurrent work on *other* statements of the same
//   database is safe; a collected statement has no work of its own in
//   flight.
// - The Database cannot outlive this call: this statement holds a Ref on
//   it, and its own handle cannot have been closed (sqlite3_close fails
//   with SQLITE_BUSY while this statement was outstanding).
// - db->Unref() is a reference-count operation, not a call into JS —
//   the same class of work node-addon-api itself does in finalizers.
//
// db is NULL only when the constructor threw before validation finished;
// then there is no handle, no Ref and nothing to release.
Statement::~Statement() {
    // The compiled row factories are strong references; drop them before
    // the env goes away. Safe on a torn-down env: napi_delete_reference
    // does not run JS.
    ResetRowFactories(Env());
    if (!finalized) {
        finalized = true;
        CleanQueue();
        // The guard: finalize can invoke an aggregate's xFinal (sqlite
        // calls it for incomplete aggregates), and this is the JS thread —
        // a blocking round trip from xFinal here would wait for itself.
        // MayBlockOnWorkerRoundTrip covers the second hazard: the mutex
        // itself, held by a worker waiting on a round trip this thread
        // must service.
        if (db && db->MayBlockOnWorkerRoundTrip() && _handle != NULL) {
            db->Schedule(Database::Work_DeferredHandleFinalize,
                new HandleFinalizeBaton(db, _handle), true);
            _handle = NULL;
        }
        else if (db) {
            Database::SyncSqliteGuard sync_guard(db);
            sqlite3_finalize(_handle);
            _handle = NULL;
        }
        else {
            sqlite3_finalize(_handle);
            _handle = NULL;
        }
        bound_payloads.clear();
        if (db) db->Unref();
    }
}

// Runs the finalize work of an original finalize baton (directly, or via
// the deferred wrapper below).
void Statement::FinishFinalizeBaton(Baton* baton) {
    std::unique_ptr<Statement::Baton> holder(baton);
    auto env = baton->stmt->Env();
    Napi::HandleScope scope(env);

    baton->stmt->Finalize_();

    // Fire callback in case there was one.
    Napi::Function cb = baton->callback.Value();
    if (IS_FUNCTION(cb)) {
        TRY_CATCH_CALL(baton->stmt->Value(), cb, 0, NULL);
    }
}

// Exclusive: dispatched only when pending == 0, so the connection mutex
// is free and the finalize cannot meet a worker blocked mid-round-trip.
void Database::Work_DeferredStatementFinalize(Baton* b) {
    auto baton = std::unique_ptr<Statement::DeferredFinalizeBaton>(
        static_cast<Statement::DeferredFinalizeBaton*>(b));
    auto* db = baton->db;

    Statement::Baton* inner = baton->inner;
    baton->inner = NULL; // ownership moves to FinishFinalizeBaton

    Statement::FinishFinalizeBaton(inner);

    db->exclusiveHeld = false;
    db->Process();
}

void Database::Work_DeferredHandleFinalize(Baton* b) {
    auto baton = std::unique_ptr<Statement::HandleFinalizeBaton>(
        static_cast<Statement::HandleFinalizeBaton*>(b));
    auto* db = baton->db;

    sqlite3_finalize(baton->handle);

    db->exclusiveHeld = false;
    db->Process();
}

void Statement::Finalize_(Baton* b) {
    Statement* stmt = b->stmt;
    // Finalizing on this thread takes the connection mutex inside
    // sqlite3_finalize. A worker blocked in a JS round trip holds that
    // mutex while waiting for this thread — finalizing now would deadlock
    // the two. Hand the work to the exclusive queue instead.
    if (stmt->db->MayBlockOnWorkerRoundTrip()) {
        auto* deferral = new DeferredFinalizeBaton(stmt->db, b);
        stmt->db->Schedule(Database::Work_DeferredStatementFinalize,
            deferral, true);
        return;
    }
    FinishFinalizeBaton(b);
}

void Statement::Finalize_() {
    assert(!finalized);
    finalized = true;
    CleanQueue();
    // Finalize returns the status code of the last operation. We already fired
    // error events in case those failed. The guard covers the xFinal an
    // incomplete aggregate fires from here — this runs on the JS thread,
    // where a blocking round trip would deadlock (see ~Statement).
    if (db->MayBlockOnWorkerRoundTrip() && _handle != NULL) {
        // Same hazard as Finalize_(Baton*): the mutex a round-tripping
        // worker holds. The handle is finalized from the exclusive queue;
        // the statement's own teardown proceeds (nothing else touches the
        // handle once finalized is set and _handle is cleared).
        db->Schedule(Database::Work_DeferredHandleFinalize,
            new HandleFinalizeBaton(db, _handle), true);
        _handle = NULL;
    }
    else {
        Database::SyncSqliteGuard sync_guard(db);
        sqlite3_finalize(_handle);
        _handle = NULL;
    }
    bound_payloads.clear();
    db->Unref();
}

// Hands `error` to every call still queued on this statement, settling
// each through whichever callback that kind of call settles through (see
// Baton::Fail). Emits an 'error' event when nothing took it, unless the
// caller reports the failure on the statement itself anyway.
//
// Callable from ~Statement: a queued Baton holds a Ref on the statement,
// so a collected statement provably has an empty queue and nothing is
// invoked from the finalizer.
void Statement::FailQueue(Napi::Value error, bool emit_if_unhandled) {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    bool called = false;

    // Clear out the queue so that this object can get GC'ed.
    while (!queue.empty()) {
        auto call = std::unique_ptr<Call>(queue.front());
        queue.pop();

        auto baton = std::unique_ptr<Baton>(call->baton);
        if (baton->Fail(error)) called = true;
    }

    // When we couldn't call a callback function, emit an error on the
    // Statement object.
    if (!called && emit_if_unhandled) {
        Napi::Value info[] = { Napi::String::New(env, "error"), error };
        EMIT_EVENT(Value(), 2, info);
    }

}

void Statement::CleanQueue() {
    auto env = this->Env();
    Napi::HandleScope scope(env);

    // Environment teardown (worker termination): the error delivery
    // below constructs JS on a dying environment, which is fatal. Drop
    // the queued calls instead — reference cleanup still works there,
    // so the batons are destroyed normally.
    if (Database::EnvCannotRunJs(env)) {
        while (!queue.empty()) {
            auto call = std::unique_ptr<Call>(queue.front());
            queue.pop();
            delete call->baton;
        }
        return;
    }

    if (prepared && !queue.empty()) {
        // This statement has already been prepared and is now finalized.
        // Fire error for all remaining items in the queue.
        EXCEPTION("Statement is already finalized", SQLITE_MISUSE, exception);
        FailQueue(exception, true);
    }
    else while (!queue.empty()) {
        // Just delete all items in the queue; whatever is left here has
        // already been reported -- either by the prepare's own callback,
        // or by Work_AfterPrepare when there was none.
        auto call = std::unique_ptr<Call>(queue.front());
        queue.pop();
        // We don't call the actual callback, so we have to make sure that
        // the baton gets destroyed.
        delete call->baton;
    }
}
