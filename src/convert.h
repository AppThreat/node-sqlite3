#ifndef NODE_SQLITE3_SRC_CONVERT_H
#define NODE_SQLITE3_SRC_CONVERT_H

// Shared value marshalling (Deliverable 06, extracted from the Deliverable 02
// code in statement.cc by the plan's instruction: "Do not write a second
// converter"). Both directions of statement binding and both directions of
// user-defined function arguments/results go through these helpers, so a
// value's type behaviour cannot drift between the two surfaces.
//
//  - ConvertToField:   JS value -> Values::Field (bind / function result)
//  - ValueToCell:      sqlite3_value* -> Cell (function arguments)
//  - CellToJS:         Cell -> JS value (rows / function arguments)
//  - ConvertInt64ToJS: int64 -> JS honouring the database's integer mode
//
// The Values::Field/Cell/Row/Columns data types moved here from statement.h
// so this header has no dependency on the class.

#include <memory>
#include <string>
#include <vector>

#include <sqlite3.h>
#include <napi.h>

#include "database.h"

namespace node_sqlite3 {

namespace Values {
    struct Field {
        inline Field(unsigned short _index, unsigned short _type = SQLITE_NULL) :
            type(_type), index(_index) {}
        inline Field(const char* _name, unsigned short _type = SQLITE_NULL) :
            type(_type), index(0), name(_name) {}

        unsigned short type;
        unsigned short index;
        std::string name;
        // Set when the value came from an explicit `undefined` (as opposed
        // to `null`): used only to recognise the historical
        // "accidental undefined" call shape against statements without
        // parameters.
        bool from_undefined = false;

        virtual ~Field() = default;
    };

    struct Integer : Field {
        template <class T> inline Integer(T _name, int64_t val) :
            Field(_name, SQLITE_INTEGER), value(val) {}
        int64_t value;
        virtual ~Integer() override = default;
    };

    struct Float : Field {
        template <class T> inline Float(T _name, double val) :
            Field(_name, SQLITE_FLOAT), value(val) {}
        double value;
        virtual ~Float() override = default;
    };

    struct Text : Field {
        template <class T> inline Text(T _name, size_t len, const char* val) :
            Field(_name, SQLITE_TEXT), value(val, len) {}
        std::string value;
        virtual ~Text() override = default;
    };

    struct Blob : Field {
        template <class T> inline Blob(T _name, size_t len, const void* val) :
                Field(_name, SQLITE_BLOB), length(len) {
            value = new char[len];
            if (len > 0) {
                memcpy(value, val, len);
            }
        }
        inline virtual ~Blob() override {
            delete[] value;
        }
        size_t length;
        char* value;
    };

    typedef Field Null;
}

// A converted result cell: a flat value type instead of a per-cell heap
// object. TEXT payload and BLOB bytes live in `str` (binary-safe).
struct Cell {
    unsigned short type = SQLITE_NULL;
    int64_t integer = 0;
    double real = 0.;
    std::string str;

    Cell() = default;
    explicit Cell(unsigned short t) : type(t) {}
    Cell(const Cell&) = default;
    Cell(Cell&&) = default;
    Cell& operator=(const Cell&) = default;
    Cell& operator=(Cell&&) = default;
};

typedef std::vector<Cell> Row;
typedef std::vector<Row> Rows;
typedef std::vector<std::unique_ptr<Values::Field>> Parameters;

// Result column names captured from a prepared statement, shared by every
// row of one batch instead of being stored per cell.
//
// The shape is fixed for one execution: sqlite3_prepare_v2 may re-prepare
// transparently behind sqlite3_step() when the schema changed, but it keeps
// the original result columns. Capturing once per call therefore stays
// correct without relying on the names surviving across calls.
struct Columns {
    std::vector<std::string> names;

    // Populates the names on first use. Called on the thread that steps the
    // statement, once per execution.
    inline void EnsureLoaded(sqlite3_stmt* stmt) {
        if (!names.empty()) return;
        int cols = sqlite3_column_count(stmt);
        names.reserve(cols);
        for (int i = 0; i < cols; i++) {
            const char* name = sqlite3_column_name(stmt, i);
            names.emplace_back(name != NULL ? name : "");
        }
    }
};

// --- JS -> SQLite direction (bind parameters, function return values) ------

// Where a converted field will be bound: a 1-based parameter index for
// positional binds, or a name for named ones. Function return values use
// the default (neither) — they are never bound to a parameter.
struct FieldPos {
    int index = 0;
    const char* name = "";
};

// Converts one JS value into a field for binding. `subject` names the value
// in error messages, e.g. "parameter 3", "parameter $name" or "the return
// value of function 'foo'". Returns nullptr only with a TypeError or
// RangeError pending — no value is ever silently skipped or coerced.
std::unique_ptr<Values::Field> ConvertToField(const Napi::Value source,
    const std::string& subject, const FieldPos& pos = FieldPos());

// --- SQLite -> JS direction (result columns, function arguments) -----------

// Reads one sqlite3_value into a Cell. Pure C: safe on any thread, which is
// where user-function arguments arrive.
void ValueToCell(Cell* cell, sqlite3_value* value);

// Names the value a conversion error is about, *without* building the
// name unless the error actually happens.
//
// The phrase is used by exactly one message: the 'number'-mode RangeError
// for an out-of-range integer. Building it eagerly cost a heap allocation
// and a concatenation for every cell of every row — on a 20,000 x 4 read,
// 80,000 allocations to describe an error that is not occurring. Callers
// that already hold a finished phrase (function arguments, changeset
// fields) pass a string and are converted implicitly; the row path passes
// the statement's cached column names plus an index, and pays nothing
// until Describe() is called.
struct ValueOrigin {
    // A ready-made phrase, e.g. "argument 0". Borrowed, not owned; one of
    // the two spellings callers already use.
    const std::string* literal = nullptr;
    const char* literal_cstr = nullptr;
    // Or: a position in a statement's cached column names. Borrowed.
    const std::vector<std::string>* column_names = nullptr;
    size_t index = 0;

    // Both conversions are implicit by design, so every existing call site
    // keeps compiling — including the ones passing a string literal, which
    // cannot reach a std::string parameter through a second user-defined
    // conversion. Safe against temporaries: every use is inside the call
    // expression that creates it.
    ValueOrigin(const std::string& phrase)   // NOLINT(runtime/explicit)
        : literal(&phrase) {}
    ValueOrigin(const char* phrase)          // NOLINT(runtime/explicit)
        : literal_cstr(phrase) {}
    ValueOrigin(const std::vector<std::string>* names, size_t i)
        : column_names(names), index(i) {}

    // "column 'x'" when the name is known, "result column N" otherwise.
    std::string Describe() const;
};

// Converts an int64 according to the database's integer mode (see
// Database::IntegerMode). Throws a RangeError in 'number' mode for unsafe
// values; callers must check env.IsExceptionPending() afterwards.
Napi::Value ConvertInt64ToJS(Napi::Env env, sqlite3_int64 value,
    int integer_mode, const ValueOrigin& origin);

// Converts a Cell into a JS value: number/BigInt by integer mode, string,
// Buffer for blobs. `origin` names the value in the 'number'-mode
// RangeError, and is only formatted if that error is raised.
// `move_payload` enables the zero-copy external Buffer for blobs >= 4096
// bytes, moving the payload out of the cell (the row-conversion path, whose
// Cells are discarded afterwards); function arguments must pass false —
// their Cells outlive the conversion, so those blobs are copied.
// Throws (leaves a pending exception) only on the RangeError path.
// `raised` is the same per-cell failure channel as ColumnToJS's: it lets a
// row loop read a plain bool instead of calling napi_is_exception_pending
// per cell. Pass nullptr when the caller checks the env afterwards anyway.
Napi::Value CellToJS(Napi::Env env, Cell& cell, int integer_mode,
    const ValueOrigin& origin, bool move_payload = false,
    bool* raised = nullptr);

// Converts one live result column straight into a JS value, skipping the
// intermediate Cell entirely.
//
// The Cell exists for the *async* paths, where rows are read on a worker
// thread and converted later on the JS thread — there the copy is what
// makes the hand-off possible. The synchronous paths have no hand-off:
// they were paying for a full materialisation of the result set (a Row
// per row, a std::string per text/blob cell) and then converting it, so
// every string was copied twice and every row allocated twice.
//
// Semantics match CellToJS exactly, including an empty string/Buffer for a
// zero-length or NULL-pointer payload. Blobs are copied rather than
// adopted: the bytes belong to SQLite only until the next step, so there
// is nothing to move — which still leaves one copy, where the Cell route
// took two for blobs under 4096 bytes.
//
// The returned value borrows nothing from the statement; it is safe to
// step again immediately afterwards.
//
// `raised` is the per-cell failure channel: the row loop reads a plain
// bool instead of calling napi_is_exception_pending per cell (measured:
// inside run-to-run noise on its own, but it keeps the hot loop free of
// an avoidable ABI call). The only failure this conversion can produce
// is the 'number'-mode RangeError on an unsafe integer, so the flag is
// set exactly there; pass nullptr when the caller checks the env
// afterwards anyway.
Napi::Value ColumnToJS(Napi::Env env, sqlite3_stmt* stmt, int column,
    int integer_mode, const ValueOrigin& origin, bool* raised = nullptr);

}

#endif
