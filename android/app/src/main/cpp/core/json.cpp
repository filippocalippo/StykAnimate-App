#include "json.h"

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <unordered_map>

#include "base64.h"

namespace styk::json {

size_t Value::size() const {
  switch (type) {
    case Type::Array: return array.size();
    case Type::Object: return object.size();
    case Type::NumArray: return nums ? nums->values.size() : 0;
    case Type::String: return string.size();
    case Type::Bytes: return blob ? blob->bytes.size() : 0;
    default: return 0;
  }
}

const Value* Value::find(const std::string& key) const {
  if (type != Type::Object) return nullptr;
  for (const auto& member : object) {
    if (member.first == key) return &member.second;
  }
  return nullptr;
}

std::string Value::bytes_as_string() const {
  if (type != Type::Bytes || !blob) return std::string();
  return blob->prefix + base64_encode(blob->bytes.data(), blob->bytes.size());
}

namespace {

struct ParseError {
  std::string message;
};

class Parser {
 public:
  Parser(const char* text, size_t size, const ParseLimits& limits)
      : p_(text), end_(text + size), begin_(text), limits_(limits) {}

  Value run() {
    // UTF-8 byte order mark.
    if (end_ - p_ >= 3 && static_cast<uint8_t>(p_[0]) == 0xEF && static_cast<uint8_t>(p_[1]) == 0xBB &&
        static_cast<uint8_t>(p_[2]) == 0xBF) {
      p_ += 3;
    }
    skip_ws();
    Value v = parse_value(0);
    skip_ws();
    if (p_ != end_) fail("Unexpected data after JSON value");
    return v;
  }

 private:
  [[noreturn]] void fail(const std::string& message) const {
    throw ParseError{message + " at byte " + std::to_string(p_ - begin_)};
  }

  void skip_ws() {
    while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) ++p_;
  }

  void count_node() {
    if (++nodes_ > limits_.max_nodes) fail("JSON document has too many values");
  }

  Value parse_value(size_t depth) {
    if (depth > limits_.max_depth) fail("JSON nesting is too deep");
    if (p_ >= end_) fail("Unexpected end of JSON");
    count_node();
    switch (*p_) {
      case '{': return parse_object(depth);
      case '[': return parse_array(depth);
      case '"': {
        Value v;
        v.type = Value::Type::String;
        v.string = parse_string();
        return v;
      }
      case 't': return literal("true", true);
      case 'f': return literal("false", false);
      case 'n': {
        expect_word("null");
        return Value();
      }
      default: return parse_number();
    }
  }

  void expect_word(const char* word) {
    const size_t n = std::strlen(word);
    if (static_cast<size_t>(end_ - p_) < n || std::memcmp(p_, word, n) != 0) fail("Invalid JSON literal");
    p_ += n;
  }

  Value literal(const char* word, bool value) {
    expect_word(word);
    Value v;
    v.type = Value::Type::Bool;
    v.boolean = value;
    return v;
  }

  Value parse_number() {
    const char* start = p_;
    if (p_ < end_ && *p_ == '-') ++p_;
    if (p_ >= end_) fail("Invalid JSON number");
    if (*p_ == '0') {
      ++p_;
    } else if (*p_ >= '1' && *p_ <= '9') {
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
    } else {
      p_ = start;
      fail("Unexpected character in JSON");
    }
    bool is_float = false;
    if (p_ < end_ && *p_ == '.') {
      is_float = true;
      ++p_;
      if (p_ >= end_ || *p_ < '0' || *p_ > '9') fail("Invalid JSON number");
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
    }
    if (p_ < end_ && (*p_ == 'e' || *p_ == 'E')) {
      is_float = true;
      ++p_;
      if (p_ < end_ && (*p_ == '+' || *p_ == '-')) ++p_;
      if (p_ >= end_ || *p_ < '0' || *p_ > '9') fail("Invalid JSON number");
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
    }
    const std::string token(start, p_);
    Value v;
    if (!is_float) {
      errno = 0;
      char* stop = nullptr;
      const long long parsed = std::strtoll(token.c_str(), &stop, 10);
      if (errno == 0 && stop && *stop == '\0') {
        v.type = Value::Type::Int;
        v.integer = parsed;
        return v;
      }
    }
    errno = 0;
    const double d = std::strtod(token.c_str(), nullptr);
    if (!std::isfinite(d)) fail("JSON number out of range");
    v.type = Value::Type::Double;
    v.number = d;
    return v;
  }

  static int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }

  uint32_t parse_hex4() {
    if (end_ - p_ < 4) fail("Invalid unicode escape");
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i) {
      const int d = hex_digit(p_[i]);
      if (d < 0) fail("Invalid unicode escape");
      v = (v << 4) | static_cast<uint32_t>(d);
    }
    p_ += 4;
    return v;
  }

  static void append_utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  // Validates one UTF-8 sequence starting at p_ and copies it to out.
  void copy_utf8(std::string& out) {
    const uint8_t b0 = static_cast<uint8_t>(*p_);
    size_t len;
    uint32_t cp;
    if (b0 < 0x80) {
      out.push_back(*p_++);
      return;
    } else if (b0 >= 0xC2 && b0 <= 0xDF) {
      len = 2;
      cp = b0 & 0x1F;
    } else if (b0 >= 0xE0 && b0 <= 0xEF) {
      len = 3;
      cp = b0 & 0x0F;
    } else if (b0 >= 0xF0 && b0 <= 0xF4) {
      len = 4;
      cp = b0 & 0x07;
    } else {
      fail("Invalid UTF-8 in JSON string");
    }
    if (static_cast<size_t>(end_ - p_) < len) fail("Invalid UTF-8 in JSON string");
    for (size_t i = 1; i < len; ++i) {
      const uint8_t b = static_cast<uint8_t>(p_[i]);
      if ((b & 0xC0) != 0x80) fail("Invalid UTF-8 in JSON string");
      cp = (cp << 6) | (b & 0x3F);
    }
    const uint32_t min_cp = len == 2 ? 0x80 : len == 3 ? 0x800 : 0x10000;
    if (cp < min_cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) fail("Invalid UTF-8 in JSON string");
    out.append(p_, len);
    p_ += len;
  }

  std::string parse_string() {
    ++p_;  // opening quote
    std::string out;
    for (;;) {
      if (p_ >= end_) fail("Unterminated JSON string");
      const char c = *p_;
      if (c == '"') {
        ++p_;
        return out;
      }
      if (static_cast<uint8_t>(c) < 0x20) fail("Control character in JSON string");
      if (c != '\\') {
        copy_utf8(out);
        continue;
      }
      ++p_;
      if (p_ >= end_) fail("Unterminated JSON string");
      const char e = *p_++;
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          uint32_t cp = parse_hex4();
          if (cp >= 0xD800 && cp <= 0xDBFF) {
            if (end_ - p_ >= 6 && p_[0] == '\\' && p_[1] == 'u') {
              p_ += 2;
              const uint32_t low = parse_hex4();
              if (low < 0xDC00 || low > 0xDFFF) fail("Invalid surrogate pair");
              cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
            } else {
              fail("Unpaired surrogate");
            }
          } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            fail("Unpaired surrogate");
          }
          append_utf8(out, cp);
          break;
        }
        default: fail("Invalid escape in JSON string");
      }
    }
  }

  Value parse_array(size_t depth) {
    ++p_;
    Value v;
    v.type = Value::Type::Array;
    skip_ws();
    if (p_ < end_ && *p_ == ']') {
      ++p_;
      return v;
    }
    for (;;) {
      skip_ws();
      v.array.push_back(parse_value(depth + 1));
      skip_ws();
      if (p_ >= end_) fail("Unterminated JSON array");
      if (*p_ == ',') {
        ++p_;
        continue;
      }
      if (*p_ == ']') {
        ++p_;
        return v;
      }
      fail("Expected ',' or ']' in JSON array");
    }
  }

  Value parse_object(size_t depth) {
    ++p_;
    Value v;
    v.type = Value::Type::Object;
    skip_ws();
    if (p_ < end_ && *p_ == '}') {
      ++p_;
      return v;
    }
    std::unordered_map<std::string, size_t> index;
    for (;;) {
      skip_ws();
      if (p_ >= end_ || *p_ != '"') fail("Expected string key in JSON object");
      std::string key = parse_string();
      skip_ws();
      if (p_ >= end_ || *p_ != ':') fail("Expected ':' in JSON object");
      ++p_;
      skip_ws();
      Value member = parse_value(depth + 1);
      auto it = index.find(key);
      if (it != index.end()) {
        v.object[it->second].second = std::move(member);  // last duplicate wins
      } else {
        index.emplace(key, v.object.size());
        v.object.emplace_back(std::move(key), std::move(member));
      }
      skip_ws();
      if (p_ >= end_) fail("Unterminated JSON object");
      if (*p_ == ',') {
        ++p_;
        continue;
      }
      if (*p_ == '}') {
        ++p_;
        return v;
      }
      fail("Expected ',' or '}' in JSON object");
    }
  }

  const char* p_;
  const char* end_;
  const char* begin_;
  ParseLimits limits_;
  size_t nodes_ = 0;
};

}  // namespace

ParseResult parse(const char* text, size_t size, const ParseLimits& limits) {
  ParseResult result;
  try {
    Parser parser(text, size, limits);
    result.value = parser.run();
    result.ok = true;
  } catch (const ParseError& e) {
    result.error = e.message;
  } catch (const std::exception& e) {
    result.error = e.what();
  }
  return result;
}

}  // namespace styk::json
