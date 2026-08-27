#ifndef NODE_SQLITE3_SRC_MACROS_H
#define NODE_SQLITE3_SRC_MACROS_H

#include <string>

std::string sqlite_code_string(int code);
const char* sqlite_authorizer_string(int type);
#include <vector>

#include <napi.h>

// A Napi substitute IsInt32()
inline bool OtherIsInt(Napi::Number source) {
    double orig_val = source.DoubleValue();
    double int_val = static_cast<double>(source.Int32Value());
    if (orig_val == int_val) {
        return true;
    } else {
        return false;
    }
}

#define IS_FUNCTION(cb) \
    !cb.IsUndefined() && cb.IsFunction()

#define REQUIRE_ARGUMENTS(n)                                                   \
    if (info.Length() < (n)) {                                                 \
        Napi::TypeError::New(env, "Expected " #n "arguments").ThrowAsJavaScriptException(); \
        return env.Null(); \
    }


#define REQUIRE_ARGUMENT_EXTERNAL(i, var)                                      \
    if (info.Length() <= (i) || !info[i].IsExternal()) {                       \
        Napi::TypeError::New(env, "Argument " #i " invalid").ThrowAsJavaScriptException(); \
        return env.Null(); \
    }                                                                          \
    Napi::External var = info[i].As<Napi::External>();


#define REQUIRE_ARGUMENT_FUNCTION(i, var)                                      \
    if (info.Length() <= (i) || !info[i].IsFunction()) {                        \
        Napi::TypeError::New(env, "Argument " #i " must be a function").ThrowAsJavaScriptException(); \
        return env.Null(); \
    }                                                                          \
    Napi::Function var = info[i].As<Napi::Function>();


#define REQUIRE_ARGUMENT_STRING(i, var)                                        \
    if (info.Length() <= (i) || !info[i].IsString()) {                         \
        Napi::TypeError::New(env, "Argument " #i " must be a string").ThrowAsJavaScriptException(); \
        return env.Null(); \
    }                                                                          \
    std::string var = info[i].As<Napi::String>();

#define REQUIRE_ARGUMENT_INTEGER(i, var)                                        \
    if (info.Length() <= (i) || !info[i].IsNumber()) {                        \
        Napi::TypeError::New(env, "Argument " #i " must be an integer").ThrowAsJavaScriptException(); \
        return env.Null();        \
    }                                                                          \
    int var(info[i].As<Napi::Number>().Int32Value());

#define OPTIONAL_ARGUMENT_FUNCTION(i, var)                                     \
    Napi::Function var;                                                        \
    if (info.Length() > i && !info[i].IsUndefined()) {                         \
        if (!info[i].IsFunction()) {                                           \
            Napi::TypeError::New(env, "Argument " #i " must be a function").ThrowAsJavaScriptException(); \
            return env.Null(); \
        }                                                                      \
        var = info[i].As<Napi::Function>();                                    \
    }


#define OPTIONAL_ARGUMENT_INTEGER(i, var, default)                             \
    int var;                                                                   \
    if (info.Length() <= (i)) {                                                \
        var = (default);                                                       \
    }                                                                          \
    else if (info[i].IsNumber()) {                                             \
        if (OtherIsInt(info[i].As<Number>())) {                                \
            var = info[i].As<Napi::Number>().Int32Value();                     \
        }                                                                      \
    }                                                                          \
    else {                                                                     \
        Napi::TypeError::New(env, "Argument " #i " must be an integer").ThrowAsJavaScriptException(); \
        return env.Null(); \
    }


#define DEFINE_CONSTANT_INTEGER(target, constant, name)                        \
    Napi::PropertyDescriptor::Value(#name, Napi::Number::New(env, constant),   \
        static_cast<napi_property_attributes>(napi_enumerable | napi_configurable)),

#define DEFINE_CONSTANT_STRING(target, constant, name)                         \
    Napi::PropertyDescriptor::Value(#name, Napi::String::New(env, constant),   \
        static_cast<napi_property_attributes>(napi_enumerable | napi_configurable)),

// Builds the SqliteError value. `msg` is a UTF-8 const char*/std::string:
// composing the message in C++ avoids the old three-pass UTF-8
// round-trip through Napi::String (encode-decode-decode-encode) that
// StringConcat used to force on every error construction.
#define EXCEPTION(msg, errno, name)                                            \
    Napi::Value name = Napi::Error::New(env,                                   \
        std::string(sqlite_code_string(errno)) + ": " + (msg)).Value();        \
    Napi::Object name ##_obj = name.As<Napi::Object>();                        \
    (name ##_obj).Set( Napi::String::New(env, "errno"), Napi::Number::New(env, errno)); \
    (name ##_obj).Set( Napi::String::New(env, "code"),                         \
        Napi::String::New(env, sqlite_code_string(errno)));                    \
    (name ##_obj).Set( Napi::String::New(env, "primaryCode"),                  \
        Napi::String::New(env, sqlite_code_string((errno) & 0xff)));


#define EMIT_EVENT(obj, argc, argv)                                            \
    TRY_CATCH_CALL((obj),                                                      \
        (obj).Get("emit").As<Napi::Function>(),\
        argc, argv                                                             \
    );

// argc is a literal at every call site, so the argument buffer is a plain
// fixed-size stack array (no heap allocation); the static_assert enforces
// that assumption. Napi::Value converts implicitly to napi_value.
#define TRY_CATCH_CALL_MAX_ARGS 8
#define TRY_CATCH_CALL(context, callback, argc, argv, ...)                     \
    static_assert((argc) >= 0 && (argc) <= TRY_CATCH_CALL_MAX_ARGS,            \
        "TRY_CATCH_CALL argc must be a literal in [0, 8]");                    \
    napi_value TRY_CATCH_CALL_args[TRY_CATCH_CALL_MAX_ARGS];                   \
    /* via a pointer so that argc == 0 may pass a NULL argv */                 \
    const Napi::Value* TRY_CATCH_CALL_src = (argv);                            \
    for (int TRY_CATCH_CALL_i = 0; TRY_CATCH_CALL_i < (argc);                  \
         TRY_CATCH_CALL_i++) {                                                 \
        TRY_CATCH_CALL_args[TRY_CATCH_CALL_i] =                                \
            TRY_CATCH_CALL_src[TRY_CATCH_CALL_i];                              \
    }                                                                          \
    Napi::Value res = (callback).Call(Napi::Value(context),                    \
        static_cast<size_t>(argc), TRY_CATCH_CALL_args);                       \
    if (res.IsEmpty()) return __VA_ARGS__;

#define WORK_DEFINITION(name)                                                  \
    Napi::Value name(const Napi::CallbackInfo& info);                          \
    static void Work_Begin##name(Baton* baton);                                \
    static void Work_##name(napi_env env, void* data);                         \
    static void Work_After##name(napi_env env, napi_status status, void* data);

#ifdef DEBUG
    #define ASSERT_STATUS() assert(status == 0);
#else
    #define ASSERT_STATUS() (void)status;
#endif

#define CREATE_WORK(name, workerFn, afterFn)                                    \
    int status = napi_create_async_work(env, NULL, Napi::String::New(env, name),\
                             workerFn, afterFn, baton, &baton->request);        \
                                                                                \
    ASSERT_STATUS();                                                            \
    napi_queue_async_work(env, baton->request);

#define STATEMENT_BEGIN(type)                                                  \
    assert(baton);                                                             \
    assert(baton->stmt);                                                       \
    assert(!baton->stmt->locked);                                              \
    assert(!baton->stmt->finalized);                                           \
    assert(baton->stmt->prepared);                                             \
    baton->stmt->locked = true;                                                \
    baton->stmt->db->pending++;                                                \
    auto env = baton->stmt->Env();                                             \
    CREATE_WORK("sqlite3.Statement."#type, Work_##type, Work_After##type);

#define STATEMENT_INIT(type)                                                   \
    type* baton = static_cast<type*>(data);                                    \
    Statement* stmt = baton->stmt;

#define STATEMENT_MUTEX(name) \
    if (!stmt->db->_handle) { \
        stmt->status = SQLITE_MISUSE; \
        stmt->message = "Database handle is closed"; \
        return; \
    } \
    sqlite3_mutex* name = sqlite3_db_mutex(stmt->db->_handle);

// Declares the guard that performs the end-of-call bookkeeping on every
// exit path from a Work_After* handler, including TRY_CATCH_CALL's early
// return when a JS callback throws. See Statement::CallGuard.
#define STATEMENT_END()                                                        \
    Statement::CallGuard statement_call_guard__(stmt);

#define BACKUP_BEGIN(type)                                                     \
    assert(baton);                                                             \
    assert(baton->backup);                                                     \
    assert(!baton->backup->locked);                                            \
    assert(!baton->backup->finished);                                          \
    assert(baton->backup->inited);                                             \
    baton->backup->locked = true;                                              \
    baton->backup->db->pending++;                                              \
    auto env = baton->backup->Env();                                           \
    CREATE_WORK("sqlite3.Backup."#type, Work_##type, Work_After##type);

#define BACKUP_INIT(type)                                                      \
    type* baton = static_cast<type*>(data);                                    \
    Backup* backup = baton->backup;

// Declares the guard that performs the end-of-call bookkeeping on every
// exit path from a Work_After* handler, including TRY_CATCH_CALL's early
// return when a JS callback throws. See Backup::CallGuard. Declared at
// the top of the handler, like STATEMENT_END().
#define BACKUP_END()                                                           \
    Backup::CallGuard backup_call_guard__(backup);

// Async-completion teardown guard (Deliverable 09). A terminated worker
// has its remaining async-work completions delivered while the isolate
// unwinds; there every JS-entering napi call — including
// node-addon-api's checked error path — is fatal. Reference management
// (delete/unref) still succeeds, so the baton is destroyed normally by
// the unique_ptr this macro returns through; only the JS delivery is
// skipped. `false` because an async completion enters with no exception
// pending on a healthy env, so a refused probe here means the isolate is
// terminating (see Database::EnvCannotRunJs). Placed after the baton's
// unique_ptr so the early return still frees it.
//
// This is an entry check, so it does not cover a termination that lands
// *inside* a handler — a completion already converting rows can still
// take the process down. Measured, five runs each way: one query in
// flight at terminate() aborts with 134 without this guard and exits 0
// with it; several queued completions still abort, exactly as they did
// before the guard existed. Closing that residue needs status-checked
// napi calls throughout the handlers rather than node-addon-api's
// checked helpers, whose failure path is itself a JS call — which is why
// the failure escalates to FATAL instead of raising an exception.
#define AFTER_WORK_TEARDOWN_GUARD(baton)                                       \
    if (Database::EnvCannotRunJs(e, false)) {                                  \
        return;                                                                \
    }

#endif