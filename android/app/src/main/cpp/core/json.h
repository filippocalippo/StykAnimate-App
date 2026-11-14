#pragma once
// Small JSON document model used for the StykAnimate native format.
//
// Beyond plain JSON, a Value can hold two compact forms produced when a v2
// container is materialised: NumArray (a numeric array backed by one shared
// buffer) and Bytes (a decoded binary payload plus an optional literal
// prefix, i.e. what the file stores as a base64 string).

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace styk::json {

enum class Elem : uint8_t { U8, U16, U32, I32, F32, F64 };

struct NumData {
  Elem elem = Elem::F64;
  std::vector<double> values;  // every supported element type is exact in a double
};

struct BytesData {
  std::string prefix;  // literal text before the base64 part (e.g. "data:image/png;base64,")
  std::vector<uint8_t> bytes;
};

class Value {
 public:
  enum class Type : uint8_t { Null, Bool, Int, Double, String, Array, Object, NumArray, Bytes };

  Type type = Type::Null;
  bool boolean = false;
  int64_t integer = 0;
  double number = 0;
  std::string string;
  std::vector<Value> array;
  std::vector<std::pair<std::string, Value>> object;
  std::shared_ptr<const NumData> nums;
  std::shared_ptr<const BytesData> blob;

  bool is_object() const { return type == Type::Object; }
  bool is_array() const { return type == Type::Array || type == Type::NumArray; }
  bool is_number() const { return type == Type::Int || type == Type::Double; }

  // Element/member count of arrays and objects; string length for strings.
  size_t size() const;

  // Object member lookup (linear); nullptr when absent or not an object.
  const Value* find(const std::string& key) const;

  // Numeric value of Int/Double.
  double as_double() const { return type == Type::Int ? static_cast<double>(integer) : number; }

  // The JSON string a Bytes value stands for (prefix + base64).
  std::string bytes_as_string() const;
};

struct ParseResult {
  bool ok = false;
  std::string error;
  Value value;
};

struct ParseLimits {
  size_t max_depth = 200;
  size_t max_nodes = 4u * 1024u * 1024u;
};

// Strict RFC 8259 parser over UTF-8 text (a leading BOM is skipped).
ParseResult parse(const char* text, size_t size, const ParseLimits& limits = {});

}  // namespace styk::json
