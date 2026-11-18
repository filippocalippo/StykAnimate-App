#include "native_container.h"

#include <zlib.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <unordered_map>

#include "sha256.h"
#include "zstd.h"

namespace styk::native {
namespace {

struct NativeError : std::runtime_error {
  NativeError(const std::string& message, std::string code_ = std::string())
      : std::runtime_error(message), code(std::move(code_)) {}
  std::string code;
};

[[noreturn]] void fail(const std::string& message, const std::string& code = std::string()) {
  throw NativeError(message, code);
}

const char* magic_for(Kind kind) {
  switch (kind) {
    case Kind::Styk: return "STYK";
    case Kind::Stkz: return "STKZ";
    case Kind::Stykmov: return "STMV";
  }
  return "";
}

uint16_t rd16(const uint8_t* p) { uint16_t v; std::memcpy(&v, p, 2); return v; }
uint32_t rd32(const uint8_t* p) { uint32_t v; std::memcpy(&v, p, 4); return v; }
uint64_t rd64(const uint8_t* p) { uint64_t v; std::memcpy(&v, p, 8); return v; }

// ------------------------------------------------------------- codecs ----

std::vector<uint8_t> inflate_exact(const uint8_t* src, size_t size, size_t raw_length) {
  z_stream s{};
  if (inflateInit(&s) != Z_OK) fail("Could not initialise zlib");
  s.next_in = const_cast<Bytef*>(src);
  s.avail_in = static_cast<uInt>(size);
  std::vector<uint8_t> out;
  std::vector<uint8_t> chunk(1u << 16);
  int ret = Z_OK;
  while (ret != Z_STREAM_END) {
    s.next_out = chunk.data();
    s.avail_out = static_cast<uInt>(chunk.size());
    ret = inflate(&s, Z_NO_FLUSH);
    if (ret != Z_OK && ret != Z_STREAM_END) {
      inflateEnd(&s);
      fail("The StykAnimate file is damaged (invalid compressed data).");
    }
    const size_t produced = chunk.size() - s.avail_out;
    if (produced > raw_length - std::min(raw_length, out.size())) {
      inflateEnd(&s);
      fail("The StykAnimate file is damaged (invalid payload length).");
    }
    out.insert(out.end(), chunk.data(), chunk.data() + produced);
  }
  const bool leftover = s.avail_in != 0;
  inflateEnd(&s);
  if (leftover || out.size() != raw_length) fail("The StykAnimate file is damaged (invalid payload length).");
  return out;
}

std::vector<uint8_t> unpack(int codec, const uint8_t* data, size_t stored, size_t raw_length) {
  if (codec == 0) {
    if (stored != raw_length) fail("The StykAnimate file is damaged (invalid payload length).");
    return std::vector<uint8_t>(data, data + stored);
  }
  if (codec == 1) return inflate_exact(data, stored, raw_length);
  if (codec == 2) {
    std::vector<uint8_t> out;
    std::string error;
    if (!zstd::decompress(data, stored, raw_length, out, error)) {
      fail("The StykAnimate file is damaged (invalid zstd data: " + error + ").");
    }
    return out;
  }
  fail("Unsupported StykAnimate file version. Update the app to open this file.");
}

bool digest_equals(const Sha256Digest& a, const uint8_t* b) { return std::memcmp(a.data(), b, 32) == 0; }

// ------------------------------------------------------ v2 materialise ----

struct Section {
  int kind;
  std::vector<uint8_t> bytes;
};

struct Marker {
  enum class Type { None, Array, Base64, Data, Escape, Malformed } type = Type::None;
  json::Elem elem = json::Elem::F64;
  size_t section = 0, offset = 0, count = 0;
  std::string prefix;
};

bool parse_uint(const std::string& s, size_t& pos, size_t& out) {
  size_t start = pos;
  uint64_t v = 0;
  while (pos < s.size() && s[pos] >= '0' && s[pos] <= '9') {
    v = v * 10 + static_cast<uint64_t>(s[pos] - '0');
    if (v > (1ull << 53)) return false;
    ++pos;
  }
  if (pos == start) return false;
  out = static_cast<size_t>(v);
  return true;
}

Marker parse_marker(const std::string& s) {
  Marker m;
  if (s.size() < 4 || s[0] != 'S' || s[1] != '2' || s[3] != ':') return m;
  const char tag = s[2];
  if (tag == 'E') {
    m.type = Marker::Type::Escape;
    m.prefix = s.substr(4);
    return m;
  }
  if (tag != 'B' && tag != 'S' && tag != 'D') return m;
  m.type = Marker::Type::Malformed;
  size_t pos = 4;
  if (tag == 'B') {
    static const struct { const char* name; json::Elem elem; } kTypes[] = {
        {"u8", json::Elem::U8},   {"u16", json::Elem::U16}, {"u32", json::Elem::U32},
        {"i32", json::Elem::I32}, {"f32", json::Elem::F32}, {"f64", json::Elem::F64}};
    bool found = false;
    for (const auto& t : kTypes) {
      const size_t n = std::strlen(t.name);
      if (s.compare(pos, n, t.name) == 0 && pos + n < s.size() && s[pos + n] == ':') {
        m.elem = t.elem;
        pos += n + 1;
        found = true;
        break;
      }
    }
    if (!found) return m;
  }
  if (!parse_uint(s, pos, m.section)) return m;
  if (pos >= s.size() || s[pos++] != ':') return m;
  if (!parse_uint(s, pos, m.offset)) return m;
  if (tag == 'B' || tag == 'D' || tag == 'S') {
    if (pos >= s.size() || s[pos++] != ':') return m;
  }
  if (!parse_uint(s, pos, m.count)) return m;
  if (tag == 'B' || tag == 'S') {
    if (pos != s.size()) return m;
    m.type = tag == 'B' ? Marker::Type::Array : Marker::Type::Base64;
    return m;
  }
  // S2D:<s>:<o>:<n>:<prefix>
  if (pos >= s.size() || s[pos++] != ':') return m;
  m.prefix = s.substr(pos);
  m.type = Marker::Type::Data;
  return m;
}

size_t elem_width(json::Elem e) {
  switch (e) {
    case json::Elem::U8: return 1;
    case json::Elem::U16: return 2;
    case json::Elem::U32:
    case json::Elem::I32:
    case json::Elem::F32: return 4;
    case json::Elem::F64: return 8;
  }
  return 8;
}

class Materializer {
 public:
  Materializer(std::vector<Section>& sections, size_t budget) : sections_(sections), budget_(budget) {}

  void walk(json::Value& v) {
    switch (v.type) {
      case json::Value::Type::String: resolve(v); break;
      case json::Value::Type::Array:
        for (json::Value& item : v.array) walk(item);
        break;
      case json::Value::Type::Object:
        for (auto& member : v.object) walk(member.second);
        break;
      default: break;
    }
  }

 private:
  void charge(size_t bytes) {
    if (bytes > budget_ - used_) fail("The native document exceeds the uncompressed size limit.");
    used_ += bytes;
  }

  const Section& section_for(const Marker& m, int kind, const char* what) {
    if (m.section >= sections_.size() || sections_[m.section].kind != kind) {
      fail(std::string("The StykAnimate file is damaged (invalid ") + what + " section reference).");
    }
    return sections_[m.section];
  }

  void resolve(json::Value& v) {
    if (v.string.size() < 4 || v.string[0] != 'S' || v.string[1] != '2') return;
    const Marker m = parse_marker(v.string);
    switch (m.type) {
      case Marker::Type::None: return;
      case Marker::Type::Malformed:
        fail("The StykAnimate file is damaged (malformed section marker).");
      case Marker::Type::Escape: {
        std::string literal = m.prefix;
        v.string = std::move(literal);
        return;
      }
      case Marker::Type::Array: {
        auto hit = arrays_.find(v.string);
        if (hit == arrays_.end()) {
          hit = arrays_.emplace(v.string, build_array(m)).first;
        }
        v.type = json::Value::Type::NumArray;
        v.nums = hit->second;
        v.string.clear();
        return;
      }
      case Marker::Type::Base64:
      case Marker::Type::Data: {
        auto hit = blobs_.find(v.string);
        if (hit == blobs_.end()) {
          hit = blobs_.emplace(v.string, build_blob(m)).first;
        }
        v.type = json::Value::Type::Bytes;
        v.blob = hit->second;
        v.string.clear();
        return;
      }
    }
  }

  std::shared_ptr<const json::NumData> build_array(const Marker& m) {
    const Section& section = section_for(m, 1, "array");
    const size_t width = elem_width(m.elem);
    if (m.offset % width || m.offset > section.bytes.size() ||
        m.count > (section.bytes.size() - m.offset) / width) {
      fail("The StykAnimate file is damaged (invalid array section reference).");
    }
    charge(m.count * sizeof(double));
    auto data = std::make_shared<json::NumData>();
    data->elem = m.elem;
    data->values.resize(m.count);
    const uint8_t* p = section.bytes.data() + m.offset;
    for (size_t i = 0; i < m.count; ++i, p += width) {
      double d = 0;
      switch (m.elem) {
        case json::Elem::U8: d = *p; break;
        case json::Elem::U16: d = rd16(p); break;
        case json::Elem::U32: d = rd32(p); break;
        case json::Elem::I32: { int32_t x; std::memcpy(&x, p, 4); d = x; break; }
        case json::Elem::F32: { float x; std::memcpy(&x, p, 4); d = x; break; }
        case json::Elem::F64: std::memcpy(&d, p, 8); break;
      }
      if (!std::isfinite(d)) fail("The StykAnimate document contains non-finite numbers.");
      data->values[i] = d;
    }
    return data;
  }

  std::shared_ptr<const json::BytesData> build_blob(const Marker& m) {
    const Section& section = section_for(m, 2, "payload");
    if (m.offset > section.bytes.size() || m.count > section.bytes.size() - m.offset) {
      fail("The StykAnimate file is damaged (invalid payload section reference).");
    }
    charge(m.count);
    auto data = std::make_shared<json::BytesData>();
    if (m.type == Marker::Type::Data) data->prefix = m.prefix;
    data->bytes.assign(section.bytes.begin() + m.offset, section.bytes.begin() + m.offset + m.count);
    return data;
  }

  std::vector<Section>& sections_;
  size_t budget_;
  size_t used_ = 0;
  std::unordered_map<std::string, std::shared_ptr<const json::NumData>> arrays_;
  std::unordered_map<std::string, std::shared_ptr<const json::BytesData>> blobs_;
};

// ------------------------------------------------------------ document ----

json::Value parse_json(const uint8_t* data, size_t size) {
  json::ParseResult parsed = json::parse(reinterpret_cast<const char*>(data), size);
  if (!parsed.ok) fail("The StykAnimate document is not valid JSON: " + parsed.error, "invalid_document");
  return std::move(parsed.value);
}

void erase_key(json::Value& object, const char* key) {
  auto& members = object.object;
  members.erase(std::remove_if(members.begin(), members.end(),
                               [&](const auto& m) { return m.first == key; }),
                members.end());
}

// Port of normalizeDecodedDocument (minus native-figure shape validation).
json::Value normalize(json::Value document, Kind kind) {
  if (kind == Kind::Styk && document.is_object()) {
    const json::Value* format = document.find("format");
    if (format && format->type == json::Value::Type::String && format->string == "stykanimate") {
      const json::Value* version = document.find("version");
      const json::Value* inner = document.find("document");
      if (!version || version->type != json::Value::Type::Int || version->integer != 1 || !inner ||
          !inner->is_object()) {
        fail("Unsupported StykAnimate project version.", "invalid_native_version");
      }
      json::Value copy = *inner;
      document = std::move(copy);
    }
  }
  if (!document.is_object()) fail("Project data must be a JSON object.", "invalid_document");
  erase_key(document, "editable_paths");
  erase_key(document, "_codec");
  erase_key(document, "_stykWeb");
  return document;
}

DecodeResult decode_checked(const uint8_t* data, size_t size, Kind kind) {
  DecodeResult out;
  if (size > kMaxBytes) fail("The native file exceeds the compressed size limit.");

  if (kind == Kind::Styk) {
    size_t i = 0;
    while (i < size && (data[i] == 0xEF || data[i] == 0xBB || data[i] == 0xBF || data[i] == ' ' ||
                        data[i] == '\t' || data[i] == '\r' || data[i] == '\n')) {
      ++i;
    }
    if (i < size && data[i] == '{') {
      out.document = normalize(parse_json(data, size), kind);
      out.container_version = 0;
      out.skeleton_bytes = size;
      out.ok = true;
      return out;
    }
  }

  if (size < kHeaderSize) fail("The StykAnimate file is truncated or has an invalid header.");
  if (std::memcmp(data, magic_for(kind), 4) != 0) {
    fail("The StykAnimate file type does not match its extension.");
  }
  const int version = data[4];
  const int codec = data[5];
  const uint16_t flags = rd16(data + 6);
  const uint64_t raw64 = rd64(data + 8);
  const uint64_t stored64 = rd64(data + 16);
  const uint8_t* digest = data + 24;
  if ((version != 1 && version != 2) || codec > 2 || flags != 0 || (version == 1 && codec != 1)) {
    fail("Unsupported StykAnimate file version. Update the app to open this file.");
  }
  if (raw64 == 0 || raw64 > (version == 2 ? kMaxSkeletonBytes : kMaxBytes) || stored64 > kMaxBytes) {
    fail("The native document exceeds the uncompressed size limit.");
  }
  const size_t raw = static_cast<size_t>(raw64);
  const size_t stored = static_cast<size_t>(stored64);
  out.container_version = version;

  if (version == 1) {
    if (kHeaderSize + stored != size) fail("The StykAnimate file is truncated or has trailing data.");
    std::vector<uint8_t> payload = unpack(codec, data + kHeaderSize, stored, raw);
    if (!digest_equals(sha256(payload.data(), payload.size()), digest)) {
      fail("The StykAnimate file is damaged (checksum mismatch).");
    }
    out.skeleton_bytes = payload.size();
    out.document = normalize(parse_json(payload.data(), payload.size()), kind);
    out.ok = true;
    return out;
  }

  // Version 2: header | count u32 | skeleton | count x 64B records | payloads.
  if (size < kHeaderSize + 4) fail("The StykAnimate file is truncated or has an invalid header.");
  const size_t count = rd32(data + kHeaderSize);
  const size_t skeleton_end = kHeaderSize + 4 + stored;
  if (count > kMaxSections || skeleton_end > size || count * kSectionSize > size - skeleton_end) {
    fail("The StykAnimate file is truncated or has an invalid header.");
  }
  struct Record {
    int kind, codec;
    size_t raw, stored, offset;
    const uint8_t* digest;
  };
  std::vector<Record> records;
  size_t pos = skeleton_end + count * kSectionSize;
  uint64_t expected = raw;
  for (size_t i = 0; i < count; ++i) {
    const uint8_t* rec = data + skeleton_end + i * kSectionSize;
    Record r;
    r.kind = rec[0];
    r.codec = rec[1];
    if (r.kind != 1 && r.kind != 2) fail("The StykAnimate file has an unknown section kind.");
    bool pad_zero = true;
    for (int k = 56; k < 64; ++k) pad_zero = pad_zero && rec[k] == 0;
    if (r.codec > 2 || rd16(rec + 2) != 0 || rd32(rec + 4) != 0 || !pad_zero) {
      fail("Unsupported StykAnimate file version. Update the app to open this file.");
    }
    const uint64_t sraw = rd64(rec + 8), sstored = rd64(rec + 16);
    if (sraw > kMaxBytes || sstored > size - pos || (r.codec == 0 && sraw != sstored)) {
      fail("The StykAnimate file is truncated or has an invalid section table.");
    }
    r.raw = static_cast<size_t>(sraw);
    r.stored = static_cast<size_t>(sstored);
    r.offset = pos;
    r.digest = rec + 24;
    expected += sraw * 3;
    records.push_back(r);
    pos += r.stored;
  }
  if (pos != size) fail("The StykAnimate file is truncated or has trailing data.");
  if (expected > static_cast<uint64_t>(kMaxBytes) * 4) {
    fail("The native document exceeds the uncompressed size limit.");
  }

  std::vector<uint8_t> skeleton = unpack(codec, data + kHeaderSize + 4, stored, raw);
  if (!digest_equals(sha256(skeleton.data(), skeleton.size()), digest)) {
    fail("The StykAnimate file is damaged (checksum mismatch).");
  }
  std::vector<Section> sections;
  sections.reserve(count);
  for (const Record& r : records) {
    std::vector<uint8_t> bytes = unpack(r.codec, data + r.offset, r.stored, r.raw);
    if (!digest_equals(sha256(bytes.data(), bytes.size()), r.digest)) {
      fail("The StykAnimate file is damaged (checksum mismatch).");
    }
    sections.push_back(Section{r.kind, std::move(bytes)});
  }
  json::Value document = parse_json(skeleton.data(), skeleton.size());
  Materializer materializer(sections, kMaxBytes * 2);
  materializer.walk(document);
  out.skeleton_bytes = skeleton.size();
  out.section_count = count;
  out.document = normalize(std::move(document), kind);
  out.ok = true;
  return out;
}

}  // namespace

bool detect_kind(const uint8_t* data, size_t size, Kind& kind) {
  if (size >= 4) {
    if (std::memcmp(data, "STYK", 4) == 0) { kind = Kind::Styk; return true; }
    if (std::memcmp(data, "STKZ", 4) == 0) { kind = Kind::Stkz; return true; }
    if (std::memcmp(data, "STMV", 4) == 0) { kind = Kind::Stykmov; return true; }
  }
  size_t i = 0;
  while (i < size && (data[i] == 0xEF || data[i] == 0xBB || data[i] == 0xBF || data[i] == ' ' ||
                      data[i] == '\t' || data[i] == '\r' || data[i] == '\n')) {
    ++i;
  }
  if (i < size && data[i] == '{') {
    kind = Kind::Styk;
    return true;
  }
  return false;
}

DecodeResult decode(const uint8_t* data, size_t size, Kind kind) {
  DecodeResult result;
  try {
    result = decode_checked(data, size, kind);
  } catch (const NativeError& e) {
    result = DecodeResult();
    result.error = e.what();
    result.code = e.code;
  } catch (const std::exception& e) {
    result = DecodeResult();
    result.error = e.what();
  }
  return result;
}

std::vector<uint8_t> encode_v1(const uint8_t* json_text, size_t size, Kind kind, std::string& error) {
  if (size == 0 || size > kMaxBytes) {
    error = "The native document exceeds the uncompressed size limit.";
    return {};
  }
  uLongf bound = compressBound(static_cast<uLong>(size));
  std::vector<uint8_t> out(kHeaderSize + bound);
  uLongf packed = bound;
  if (compress2(out.data() + kHeaderSize, &packed, json_text, static_cast<uLong>(size), 3) != Z_OK) {
    error = "Compression failed.";
    return {};
  }
  if (kHeaderSize + packed > kMaxBytes) {
    error = "The native file exceeds the compressed size limit.";
    return {};
  }
  out.resize(kHeaderSize + packed);
  std::memcpy(out.data(), magic_for(kind), 4);
  out[4] = 1;
  out[5] = 1;
  out[6] = 0;
  out[7] = 0;
  const uint64_t raw = size, stored = packed;
  std::memcpy(out.data() + 8, &raw, 8);
  std::memcpy(out.data() + 16, &stored, 8);
  const Sha256Digest digest = sha256(json_text, size);
  std::memcpy(out.data() + 24, digest.data(), 32);
  return out;
}

namespace {

const char* type_name(const json::Value& v) {
  switch (v.type) {
    case json::Value::Type::Null: return "null";
    case json::Value::Type::Bool: return "bool";
    case json::Value::Type::Int: return "int";
    case json::Value::Type::Double: return "float";
    case json::Value::Type::String: return "text";
    case json::Value::Type::Array: return "list";
    case json::Value::Type::Object: return "object";
    case json::Value::Type::NumArray: return "numeric list";
    case json::Value::Type::Bytes: return "binary";
  }
  return "?";
}

}  // namespace

std::string summarize(const DecodeResult& r) {
  std::string out;
  char line[200];
  auto add = [&](const char* fmt, auto... args) {
    std::snprintf(line, sizeof line, fmt, args...);
    out += line;
    out += '\n';
  };
  const char* container = r.container_version == 0 ? "plain JSON"
                          : r.container_version == 1 ? "container v1" : "container v2";
  add("Native project (%s)", container);
  if (r.container_version == 2) add("Sections: %zu, skeleton: %zu bytes", r.section_count, r.skeleton_bytes);
  else add("JSON: %zu bytes", r.skeleton_bytes);
  const json::Value& d = r.document;
  add("Top-level fields: %zu", d.object.size());
  size_t shown = 0;
  for (const auto& member : d.object) {
    if (shown++ >= 24) {
      out += "...\n";
      break;
    }
    const json::Value& v = member.second;
    if (v.type == json::Value::Type::Array || v.type == json::Value::Type::Object ||
        v.type == json::Value::Type::NumArray || v.type == json::Value::Type::Bytes) {
      add("  %.60s: %s (%zu)", member.first.c_str(), type_name(v), v.size());
    } else if (v.type == json::Value::Type::String) {
      add("  %.60s: text (%zu chars)", member.first.c_str(), v.string.size());
    } else if (v.type == json::Value::Type::Int) {
      add("  %.60s = %lld", member.first.c_str(), static_cast<long long>(v.integer));
    } else if (v.type == json::Value::Type::Double) {
      add("  %.60s = %g", member.first.c_str(), v.number);
    } else if (v.type == json::Value::Type::Bool) {
      add("  %.60s = %s", member.first.c_str(), v.boolean ? "true" : "false");
    } else {
      add("  %.60s = null", member.first.c_str());
    }
  }
  return out;
}

}  // namespace styk::native
