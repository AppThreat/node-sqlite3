#include <cmath>
#include <cstring>
#include <cstdint>
#include <limits>
#include <napi.h>
#include <uv.h>

#include "macros.h"
#include "database.h"
#include "statement.h"

using namespace node_sqlite3;

namespace {

// Element size in bytes for each typed-array kind.
inline size_t TypedArrayElementSize(napi_typedarray_type type) {
    switch (type) {
        case napi_int8_array:
        case napi_uint8_array:
        case napi_uint8_clamped_array:      return 1;
        case napi_int16_array:
        case napi_uint16_array:             return 2;
        case napi_int32_array:
        case napi_uint32_array:
        case napi_float32_array:            return 4;
        case napi_float64_array:
        case napi_bigint64_array:
        case napi_biguint64_array:          return 8;
        default:                            return 0;
    }
}

// Human-readable type name for "unsupported type" errors. Never throws;
// falls back to a generic name when the constructor is inaccessible
// (e.g. a Proxy whose get trap throws).
std::string BindTypeName(const Napi::Value& source) {
    auto env = source.Env();
    switch (source.Type()) {
        case napi_symbol:   return "Symbol";
        case napi_function: return "Function";
        case napi_external: return "External";
        default: break;
    }
    if (source.IsObject()) {
        Napi::Object obj = source.As<Napi::Object>();
        Napi::Value ctor = obj.Get("constructor");
        if (!env.IsExceptionPending() && ctor.IsObject()) {
            Napi::Value name = ctor.As<Napi::Object>().Get("name");
            if (!env.IsExceptionPending() && name.IsString()) {
                std::string s = name.As<Napi::String>().Utf8Value();
                if (!s.empty()) return s;
            }
        }
        return "Object";
    }
    return "value";
}

// "parameter 3" / "parameter $name" for bind error messages.
template <class T>
std::string DescribeBindPosition(T pos) {
    if constexpr (std::is_integral_v<T>) {
        return "parameter " + std::to_string(static_cast<long long>(pos));
    } else {
        return std::string("parameter ") + pos;
    }
}

template <class T>
void ThrowUnsupportedBindType(const Napi::Value& source, T pos) {
    auto env = source.Env();
    std::string msg = "Cannot bind " + DescribeBindPosition(pos) +
        ": unsupported type " + BindTypeName(source) +
        ". Serialize it explicitly (e.g. JSON.stringify) before binding.";
    Napi::TypeError::New(env, msg).ThrowAsJavaScriptException();
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

// Range of doubles that convert to int64 without undefined behaviour.
// The upper bound is inclusive: JS cannot express 2^63-1, so the double
// 2^63 is the rounded form of it and clamps to INT64_MAX.
const double kInt64MinAsDouble = -9223372036854775808.0;   // -(2^63)
const double kInt64MaxAsDouble = 9223372036854775808.0;    //   2^63

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
    EXCEPTION(stmt->message, stmt->status, exception);

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
    // Exhaustive dispatch. Order matters for the hot path: cheap primitive
    // checks run before the object checks (InstanceOf lookups hit the
    // global object). Every JS type either maps to a field or throws —
    // returning nullptr therefore always implies a pending exception, so
    // nothing can silently skip a parameter.
    if (source.IsNumber()) {
        double val = source.As<Napi::Number>().DoubleValue();
        // Number.isInteger within the int64 range binds as INTEGER (64-bit,
        // not the old Int32 round-trip). NaN and ±Infinity fail the
        // trunc/finiteness test and bind as REAL (NaN becomes NULL, per
        // sqlite's bind_double semantics).
        if (std::isfinite(val) && val == std::trunc(val)
                && val >= kInt64MinAsDouble && val < kInt64MaxAsDouble) {
            return std::make_unique<Values::Integer>(pos,
                static_cast<int64_t>(val));
        }
        if (val == kInt64MaxAsDouble) {
            // 2^63 as a double is the rounded form of 2^63-1: clamp so the
            // top of the int64 range stays reachable from JS numbers.
            return std::make_unique<Values::Integer>(pos, INT64_MAX);
        }
        return std::make_unique<Values::Float>(pos, val);
    }
    else if (source.IsString()) {
        std::string val = source.As<Napi::String>().Utf8Value();
        return std::make_unique<Values::Text>(pos, val.length(), val.c_str());
    }
    else if (source.IsBoolean()) {
        return std::make_unique<Values::Integer>(pos, source.As<Napi::Boolean>().Value() ? 1 : 0);
    }
    else if (source.IsNull()) {
        return std::make_unique<Values::Null>(pos);
    }
    else if (source.IsUndefined()) {
        // Binds as NULL, matching null: object shorthand
        // { $x: obj.maybeMissing } is a common call shape. Typo'd property
        // names are caught by the named-parameter and arity checks in
        // Bind(Parameters&&, bool), not by rejecting undefined.
        auto field = std::make_unique<Values::Null>(pos);
        field->from_undefined = true;
        return field;
    }
    else if (source.IsBigInt()) {
        bool lossless = false;
        int64_t val = source.As<Napi::BigInt>().Int64Value(&lossless);
        if (!lossless) {
            std::string digits = source.ToString().Utf8Value();
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + DescribeBindPosition(pos) + ": BigInt " +
                digits + " is outside the signed 64-bit integer range"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return std::make_unique<Values::Integer>(pos, val);
    }
    else if (source.IsDataView()) {
        // Must be tested before IsBuffer(): napi_is_buffer() also answers
        // true for DataViews, and routing one through Napi::Buffer fails
        // ("Invalid argument"). data arrives already offset by
        // byte_offset, like the typed-array call.
        size_t bytes = 0;
        void* data = NULL;
        napi_get_dataview_info(source.Env(), source, &bytes, &data,
            NULL, NULL);
        if (bytes > static_cast<size_t>(std::numeric_limits<int>::max())) {
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + DescribeBindPosition(pos) + ": DataView of " +
                std::to_string(bytes) + " bytes exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return std::make_unique<Values::Blob>(pos, bytes, data);
    }
    else if (source.IsBuffer()) {
        // Node Buffers and plain Uint8Arrays: Data() and Length() honour
        // byteOffset for both.
        Napi::Buffer<char> buffer = source.As<Napi::Buffer<char>>();
        if (buffer.Length() > static_cast<size_t>(std::numeric_limits<int>::max())) {
            // Buffers can exceed 2 GB on 64-bit Node; sqlite3_bind_blob takes
            // an int, so without this the length narrows to a negative number.
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + DescribeBindPosition(pos) + ": Buffer of " +
                std::to_string(buffer.Length()) + " bytes exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return std::make_unique<Values::Blob>(pos, buffer.Length(), buffer.Data());
    }
    else if (source.IsTypedArray()) {
        // Any other typed array (Uint16Array, Float64Array, ...): raw
        // element count times the element size, with the data pointer
        // already offset by byteOffset per napi_get_typedarray_info.
        napi_typedarray_type type;
        size_t elements = 0;
        void* data = NULL;
        napi_get_typedarray_info(source.Env(), source, &type,
            &elements, &data, NULL, NULL);
        size_t bytes = elements * TypedArrayElementSize(type);
        if (bytes > static_cast<size_t>(std::numeric_limits<int>::max())) {
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + DescribeBindPosition(pos) + ": typed array of " +
                std::to_string(bytes) + " bytes exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return std::make_unique<Values::Blob>(pos, bytes, data);
    }
    else if (source.IsArrayBuffer()) {
        Napi::ArrayBuffer buffer = source.As<Napi::ArrayBuffer>();
        if (buffer.ByteLength() > static_cast<size_t>(std::numeric_limits<int>::max())) {
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + DescribeBindPosition(pos) + ": ArrayBuffer exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return std::make_unique<Values::Blob>(pos, buffer.ByteLength(), buffer.Data());
    }
    else if (source.IsDate()) {
        // Documented v8/v9 behaviour: epoch milliseconds as REAL. Opt-in
        // TEXT binding is deliberately out of scope for D02.
        return std::make_unique<Values::Float>(pos, source.As<Napi::Date>().ValueOf());
    }
    else if (source.IsObject()) {
        if (OtherInstanceOf(source.As<Object>(), "RegExp")) {
            std::string val = source.ToString().Utf8Value();
            return std::make_unique<Values::Text>(pos, val.length(), val.c_str());
        }
        // Plain objects, arrays, Maps, class instances: refused. The old
        // behaviour bound the literal string "[object Object]".
        ThrowUnsupportedBindType(source, pos);
        return nullptr;
    }
    // Symbols, functions, anything else.
    ThrowUnsupportedBindType(source, pos);
    return nullptr;
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
        if (info[start].IsArray()) {
            auto array = info[start].As<Napi::Array>();
            int length = array.Length();
            baton->parameters.reserve(length);
            // Note: bind parameters start with 1.
            for (int i = 0, pos = 1; i < length; i++, pos++) {
                auto field = BindParameter((array).Get(i), i + 1);
                if (field == nullptr) {
                    // BindParameter threw a TypeError/RangeError.
                    delete baton;
                    return NULL;
                }
                baton->parameters.push_back(std::move(field));
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
            baton->parameters.reserve(last - start);
            for (int i = start, pos = 1; i < last; i++, pos++) {
                auto field = BindParameter(info[i], pos);
                if (field == nullptr) {
                    delete baton;
                    return NULL;
                }
                baton->parameters.push_back(std::move(field));
            }
        }
        else if (info[start].IsObject()) {
            auto object = info[start].As<Napi::Object>();
            auto array = object.GetPropertyNames();
            if (env.IsExceptionPending()) {
                delete baton;
                return NULL;
            }
            int length = array.Length();
            baton->parameters.reserve(length);
            for (int i = 0; i < length; i++) {
                Napi::Value name = (array).Get(i);
                Napi::Number num = name.ToNumber();

                if (num.Int32Value() == num.DoubleValue()) {
                    auto field = BindParameter((object).Get(name), num.Int32Value());
                    if (field == nullptr) {
                        delete baton;
                        return NULL;
                    }
                    baton->parameters.push_back(std::move(field));
                }
                else {
                    std::string param_name = name.As<Napi::String>().Utf8Value();
                    auto field = BindParameter((object).Get(name), param_name.c_str());
                    if (field == nullptr) {
                        delete baton;
                        return NULL;
                    }
                    baton->parameters.push_back(std::move(field));
                }
            }
        }
        else {
            delete baton;
            return NULL;
        }
    }

    return baton;
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
            bool failed = false;
            for (size_t i = 0; i < baton->rows.size(); i++) {
                (result).Set(i, stmt->RowToJS(env, &baton->rows[i]));
                if (env.IsExceptionPending()) {
                    // 'number' integer mode and an unsafe int64: deliver
                    // the RangeError to the callback.
                    failed = true;
                    break;
                }
            }

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
            for (auto& row : rows) {
                argv[1] = async->stmt->RowToJS(env, &row);
                if (env.IsExceptionPending()) {
                    // 'number' integer mode and an unsafe int64: hand the
                    // RangeError to the item callback in place of the row.
                    argv[0] = TakePendingError(env);
                    TRY_CATCH_CALL(async->stmt->Value(), cb, 1, argv);
                    argv[0] = env.Null();
                    continue;
                }
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
            stmt->SyncColumnKeys(env, baton->columns);
            Napi::Array result(Napi::Array::New(env, baton->rows.size()));
            bool failed = false;
            for (size_t i = 0; i < baton->rows.size(); i++) {
                (result).Set(i, stmt->RowToJS(env, &baton->rows[i]));
                if (env.IsExceptionPending()) {
                    // 'number' integer mode and an unsafe int64: deliver
                    // the RangeError to the callback.
                    failed = true;
                    break;
                }
            }

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
        if (!env.IsExceptionPending()) {
            Napi::TypeError::New(env, "Data type is not supported")
                .ThrowAsJavaScriptException();
        }
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
    if (stmt->status != SQLITE_DONE || holder->parameters.size()
            || holder->bind_supplied) {
        if (!stmt->Bind(std::move(holder->parameters), holder->bind_supplied)) {
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
        // A RangeError from the integer mode propagates to the caller
        // with the pending exception.
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
    if (!holder->parameters.size() && !holder->bind_supplied) {
        sqlite3_reset(stmt->_handle);
    }

    if (!stmt->Bind(std::move(holder->parameters), holder->bind_supplied)) {
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

    RowsBaton* baton = BindSync<RowsBaton>(info);
    if (baton == NULL) return env.Null();
    std::unique_ptr<RowsBaton> holder(baton);

    if (!holder->parameters.size() && !holder->bind_supplied) {
        sqlite3_reset(stmt->_handle);
    }

    if (!stmt->Bind(std::move(holder->parameters), holder->bind_supplied)) {
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
        // A RangeError from the integer mode propagates to the caller
        // with the pending exception.
        (result).Set(i, stmt->RowToJS(env, &rows[i]));
        if (env.IsExceptionPending()) {
            return env.Null();
        }
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

Napi::Value Statement::Int64ToJS(Napi::Env env, sqlite3_int64 value,
        const std::string& what) {
    // A single range compare on the int64 — deliberately not a call into
    // JS: this runs per integer cell.
    const bool safe = value >= -(1LL << 53) + 1 && value < (1LL << 53);
    switch (db->integer_mode) {
        case Database::INTEGER_BIGINT:
            return Napi::BigInt::New(env, static_cast<int64_t>(value));
        case Database::INTEGER_MIXED:
            if (!safe)
                return Napi::BigInt::New(env, static_cast<int64_t>(value));
            return Napi::Number::New(env, static_cast<double>(value));
        default:
            if (safe) return Napi::Number::New(env, static_cast<double>(value));
            // The default throws instead of truncating: a silent double
            // conversion is exactly the corruption this mode guards
            // against. The callback-free sync paths surface this directly;
            // async completions deliver it to the user callback.
            Napi::RangeError::New(env,
                "Integer " + std::to_string(value) + " in " + what +
                " is outside the safe integer range (-(2^53-1) .. 2^53-1); "
                "configure('integerMode', 'bigint' | 'mixed') to read it "
                "exactly"
            ).ThrowAsJavaScriptException();
            return env.Null();
    }
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

Napi::Value Statement::RowToJS(Napi::Env env, Row* row) {
    Napi::EscapableHandleScope scope(env);

    auto result = Napi::Object::New(env);

    size_t i = 0;
    for (auto& cell : *row) {
        Napi::Value value;

        switch (cell.type) {
            case SQLITE_INTEGER: {
                const std::string what = (i < column_keys_source.size())
                    ? "column '" + column_keys_source[i] + "'"
                    : std::string("result column ") + std::to_string(i);
                value = Int64ToJS(env, cell.integer, what);
                if (env.IsExceptionPending()) {
                    return scope.Escape(env.Null());
                }
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
    if (!finalized) {
        finalized = true;
        CleanQueue();
        sqlite3_finalize(_handle);
        _handle = NULL;
        bound_payloads.clear();
        if (db) db->Unref();
    }
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
