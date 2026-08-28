#include <cmath>
#include <cstring>
#include <limits>

#include <napi.h>

#include "convert.h"

namespace node_sqlite3 {

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

void ThrowUnsupportedBindType(const Napi::Value& source,
        const std::string& subject) {
    auto env = source.Env();
    std::string msg = "Cannot bind " + subject +
        ": unsupported type " + BindTypeName(source) +
        ". Serialize it explicitly (e.g. JSON.stringify) before binding.";
    Napi::TypeError::New(env, msg).ThrowAsJavaScriptException();
}

// Range of doubles that convert to int64 without undefined behaviour.
// The upper bound is inclusive: JS cannot express 2^63-1, so the double
// 2^63 is the rounded form of it and clamps to INT64_MAX.
const double kInt64MinAsDouble = -9223372036854775808.0;   // -(2^63)
const double kInt64MaxAsDouble = 9223372036854775808.0;    //   2^63

// True for a plain-object instance of the named global constructor
// ("Date", "RegExp"), matching JS instanceof across realms.
bool OtherInstanceOf(Napi::Object source, const char* object_type) {
    if (strncmp(object_type, "Date", 4) == 0) {
        return source.InstanceOf(source.Env().Global().Get("Date").As<Napi::Function>());
    } else if (strncmp(object_type, "RegExp", 6) == 0) {
        return source.InstanceOf(source.Env().Global().Get("RegExp").As<Napi::Function>());
    }

    return false;
}

} // namespace

std::unique_ptr<Values::Field> ConvertToField(const Napi::Value source,
        const std::string& subject, const FieldPos& pos) {
    // Exhaustive dispatch. Order matters for the hot path: cheap primitive
    // checks run before the object checks (InstanceOf lookups hit the
    // global object). Every JS type either maps to a field or throws —
    // returning nullptr therefore always implies a pending exception, so
    // nothing can silently skip a value. The constructors carry the bind
    // position (index or name) through to Bind(Parameters&&, bool).
#define MAKE_FIELD(kind, ...)     (pos.index > 0         ? std::make_unique<Values::kind>(pos.index, __VA_ARGS__)         : std::make_unique<Values::kind>(pos.name, __VA_ARGS__))
    if (source.IsNumber()) {
        double val = source.As<Napi::Number>().DoubleValue();
        // Number.isInteger within the int64 range binds as INTEGER (64-bit,
        // not the old Int32 round-trip). NaN and ±Infinity fail the
        // trunc/finiteness test and bind as REAL (NaN becomes NULL, per
        // sqlite's bind_double semantics).
        if (std::isfinite(val) && val == std::trunc(val)
                && val >= kInt64MinAsDouble && val < kInt64MaxAsDouble) {
            return MAKE_FIELD(Integer, static_cast<int64_t>(val));
        }
        if (val == kInt64MaxAsDouble) {
            // 2^63 as a double is the rounded form of 2^63-1: clamp so the
            // top of the int64 range stays reachable from JS numbers.
            return MAKE_FIELD(Integer, INT64_MAX);
        }
        return MAKE_FIELD(Float, val);
    }
    else if (source.IsString()) {
        std::string val = source.As<Napi::String>().Utf8Value();
        return MAKE_FIELD(Text, val.length(), val.c_str());
    }
    else if (source.IsBoolean()) {
        return MAKE_FIELD(Integer, source.As<Napi::Boolean>().Value() ? 1 : 0);
    }
    else if (source.IsNull()) {
        return pos.index > 0
            ? std::make_unique<Values::Null>(pos.index)
            : std::make_unique<Values::Null>(pos.name);
    }
    else if (source.IsUndefined()) {
        // Binds as NULL, matching null: object shorthand
        // { $x: obj.maybeMissing } is a common call shape. Typo'd property
        // names are caught by the named-parameter and arity checks in
        // Bind(Parameters&&, bool), not by rejecting undefined.
        auto field = pos.index > 0
            ? std::make_unique<Values::Null>(pos.index)
            : std::make_unique<Values::Null>(pos.name);
        field->from_undefined = true;
        return field;
    }
    else if (source.IsBigInt()) {
        bool lossless = false;
        int64_t val = source.As<Napi::BigInt>().Int64Value(&lossless);
        if (!lossless) {
            std::string digits = source.ToString().Utf8Value();
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + subject + ": BigInt " +
                digits + " is outside the signed 64-bit integer range"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return MAKE_FIELD(Integer, val);
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
                "Cannot bind " + subject + ": DataView of " +
                std::to_string(bytes) + " bytes exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return MAKE_FIELD(Blob, bytes, data);
    }
    else if (source.IsBuffer()) {
        // Node Buffers and plain Uint8Arrays: Data() and Length() honour
        // byteOffset for both.
        Napi::Buffer<char> buffer = source.As<Napi::Buffer<char>>();
        if (buffer.Length() > static_cast<size_t>(std::numeric_limits<int>::max())) {
            // Buffers can exceed 2 GB on 64-bit Node; sqlite3_bind_blob takes
            // an int, so without this the length narrows to a negative number.
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + subject + ": Buffer of " +
                std::to_string(buffer.Length()) + " bytes exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return MAKE_FIELD(Blob, buffer.Length(), buffer.Data());
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
                "Cannot bind " + subject + ": typed array of " +
                std::to_string(bytes) + " bytes exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return MAKE_FIELD(Blob, bytes, data);
    }
    else if (source.IsArrayBuffer()) {
        Napi::ArrayBuffer buffer = source.As<Napi::ArrayBuffer>();
        if (buffer.ByteLength() > static_cast<size_t>(std::numeric_limits<int>::max())) {
            Napi::RangeError::New(source.Env(),
                "Cannot bind " + subject + ": ArrayBuffer exceeds the bind size limit"
            ).ThrowAsJavaScriptException();
            return nullptr;
        }
        return MAKE_FIELD(Blob, buffer.ByteLength(), buffer.Data());
    }
    else if (source.IsDate()) {
        // Documented v8/v9 behaviour: epoch milliseconds as REAL. Opt-in
        // TEXT binding is deliberately out of scope for D02.
        return MAKE_FIELD(Float, source.As<Napi::Date>().ValueOf());
    }
    else if (source.IsObject()) {
        if (OtherInstanceOf(source.As<Napi::Object>(), "RegExp")) {
            std::string val = source.ToString().Utf8Value();
            return MAKE_FIELD(Text, val.length(), val.c_str());
        }
        // Plain objects, arrays, Maps, class instances: refused. The old
        // behaviour bound the literal string "[object Object]".
        ThrowUnsupportedBindType(source, subject);
        return nullptr;
    }
    // Symbols, functions, anything else.
    ThrowUnsupportedBindType(source, subject);
    return nullptr;
#undef MAKE_FIELD
}

void ValueToCell(Cell* cell, sqlite3_value* value) {
    cell->str.clear();
    cell->integer = 0;
    cell->real = 0.;
    switch (sqlite3_value_type(value)) {
        case SQLITE_INTEGER: {
            cell->type = SQLITE_INTEGER;
            cell->integer = sqlite3_value_int64(value);
        }   break;
        case SQLITE_FLOAT: {
            cell->type = SQLITE_FLOAT;
            cell->real = sqlite3_value_double(value);
        }   break;
        case SQLITE_TEXT: {
            cell->type = SQLITE_TEXT;
            // sqlite3_value_text first, then sqlite3_value_bytes: the docs
            // require that order so the UTF-8 conversion happens before the
            // length is read.
            const char* text =
                reinterpret_cast<const char*>(sqlite3_value_text(value));
            int length = sqlite3_value_bytes(value);
            if (length > 0 && text != NULL) {
                cell->str.assign(text, length);
            }
        } break;
        case SQLITE_BLOB: {
            cell->type = SQLITE_BLOB;
            const void* blob = sqlite3_value_blob(value);
            int length = sqlite3_value_bytes(value);
            if (length > 0 && blob != NULL) {
                cell->str.assign(static_cast<const char*>(blob), length);
            }
        } break;
        default: {
            cell->type = SQLITE_NULL;
        }
    }
}

std::string ValueOrigin::Describe() const {
    if (literal != nullptr) return *literal;
    if (literal_cstr != nullptr) return std::string(literal_cstr);
    if (column_names != nullptr && index < column_names->size()) {
        return "column '" + (*column_names)[index] + "'";
    }
    return "result column " + std::to_string(index);
}

Napi::Value ConvertInt64ToJS(Napi::Env env, sqlite3_int64 value,
        int integer_mode, const ValueOrigin& origin) {
    // A single range compare on the int64 — deliberately not a call into
    // JS: this runs per integer cell.
    const bool safe = value >= -(1LL << 53) + 1 && value < (1LL << 53);
    switch (integer_mode) {
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
                "Integer " + std::to_string(value) + " in " +
                    origin.Describe() +
                " is outside the safe integer range (-(2^53-1) .. 2^53-1); "
                "configure('integerMode', 'bigint' | 'mixed') to read it "
                "exactly"
            ).ThrowAsJavaScriptException();
            return env.Null();
    }
}

Napi::Value ColumnToJS(Napi::Env env, sqlite3_stmt* stmt, int column,
        int integer_mode, const ValueOrigin& origin, bool* raised) {
    switch (sqlite3_column_type(stmt, column)) {
        case SQLITE_INTEGER: {
            // The one branch that can raise (the 'number'-mode RangeError
            // for an unsafe int64): report it through `raised` so the row
            // loop stays free of napi_is_exception_pending calls.
            const sqlite3_int64 value = sqlite3_column_int64(stmt, column);
            const bool safe = value >= -(1LL << 53) + 1 && value < (1LL << 53);
            if (integer_mode == Database::INTEGER_NUMBER && !safe) {
                if (raised != NULL) *raised = true;
            }
            return ConvertInt64ToJS(env, value, integer_mode, origin);
        }
        case SQLITE_FLOAT: {
            return Napi::Number::New(env,
                sqlite3_column_double(stmt, column));
        }
        case SQLITE_TEXT: {
            const char* text = reinterpret_cast<const char*>(
                sqlite3_column_text(stmt, column));
            const int length = sqlite3_column_bytes(stmt, column);
            if (text == NULL || length <= 0) {
                return Napi::String::New(env, "", 0);
            }
            return Napi::String::New(env, text, static_cast<size_t>(length));
        }
        case SQLITE_BLOB: {
            const char* blob = reinterpret_cast<const char*>(
                sqlite3_column_blob(stmt, column));
            const int length = sqlite3_column_bytes(stmt, column);
            if (blob == NULL || length <= 0) {
                return Napi::Buffer<char>::Copy(env, "", 0);
            }
            return Napi::Buffer<char>::Copy(env, blob,
                static_cast<size_t>(length));
        }
        default: {
            // SQLITE_NULL, and anything unexpected, as the Cell path does.
            return env.Null();
        }
    }
}

Napi::Value CellToJS(Napi::Env env, Cell& cell, int integer_mode,
        const ValueOrigin& origin, bool move_payload, bool* raised) {
    switch (cell.type) {
        case SQLITE_INTEGER: {
            // The one branch that can raise; see ColumnToJS for why the
            // failure travels in a bool rather than through the env.
            const bool safe = cell.integer >= -(1LL << 53) + 1
                && cell.integer < (1LL << 53);
            if (integer_mode == Database::INTEGER_NUMBER && !safe) {
                if (raised != NULL) *raised = true;
            }
            return ConvertInt64ToJS(env, cell.integer, integer_mode, origin);
        }
        case SQLITE_FLOAT: {
            return Napi::Number::New(env, cell.real);
        }
        case SQLITE_TEXT: {
            return Napi::String::New(env, cell.str.data(), cell.str.size());
        }
        case SQLITE_BLOB: {
            // Zero-copy for large blobs: transfer ownership of the bytes
            // to the Buffer finalizer. Small blobs are cheaper to copy
            // (external-buffer bookkeeping outweighs the memcpy), and the
            // copy fallback also covers environments without external
            // buffer support (e.g. sandboxed renderers).
            if (move_payload && cell.str.size() >= 4096) {
                auto* payload = new std::string(std::move(cell.str));
                napi_value buf = NULL;
                napi_status st = napi_create_external_buffer(env,
                    payload->size(), &(*payload)[0],
                    [](napi_env, void*, void* hint) {
                        delete static_cast<std::string*>(hint);
                    },
                    payload, &buf);
                if (st == napi_ok) {
                    return Napi::Buffer<char>(env, buf);
                }
                // No external-buffer support (e.g. sandboxed renderers):
                // fall back to a copy from the payload we still hold.
                Napi::Buffer<char> copy = Napi::Buffer<char>::Copy(env,
                    payload->data(), payload->size());
                delete payload;
                return copy;
            }
            return Napi::Buffer<char>::Copy(env,
                cell.str.data(), cell.str.size());
        }
        case SQLITE_NULL: {
            return env.Null();
        }
        default:
            return env.Null();
    }
}

} // namespace node_sqlite3
