// Host-side tests for the native container codec and its building blocks.
// Fixtures in native_fixtures.h are produced by tools/gen_fixtures.py using
// the project's own encoder logic (backend/native_format.py).

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "base64.h"
#include "json.h"
#include "native_container.h"
#include "native_fixtures.h"
#include "sha256.h"

static int g_failures = 0;
#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);            \
      ++g_failures;                                                          \
    }                                                                        \
  } while (0)

using styk::json::Value;
using styk::native::Kind;

namespace {

std::string hex(const styk::Sha256Digest& d) {
  static const char* digits = "0123456789abcdef";
  std::string s;
  for (uint8_t b : d) {
    s.push_back(digits[b >> 4]);
    s.push_back(digits[b & 15]);
  }
  return s;
}

std::vector<uint8_t> blob(size_t n, unsigned seed) {
  std::vector<uint8_t> v(n);
  for (size_t i = 0; i < n; ++i) v[i] = static_cast<uint8_t>((i * seed + (i >> 5)) % 251);
  return v;
}

size_t length_of(const Value& v) {
  return v.type == Value::Type::Array ? v.array.size() : v.size();
}
double number_at(const Value& v, size_t i) {
  if (v.type == Value::Type::NumArray) return v.nums->values[i];
  return v.array[i].as_double();
}

// Structural equality; numeric lists compare equal to plain arrays of numbers.
bool same(const Value& a, const Value& b) {
  if (a.is_array() && b.is_array()) {
    if (length_of(a) != length_of(b)) return false;
    const bool num_a = a.type == Value::Type::NumArray, num_b = b.type == Value::Type::NumArray;
    for (size_t i = 0; i < length_of(a); ++i) {
      if (num_a || num_b) {
        const Value& other = num_a ? b : a;
        if (other.type != Value::Type::NumArray && !other.array[i].is_number()) return false;
        if (number_at(a, i) != number_at(b, i)) return false;
      } else if (!same(a.array[i], b.array[i])) {
        return false;
      }
    }
    return true;
  }
  if (a.is_number() && b.is_number()) return a.as_double() == b.as_double();
  if (a.type != b.type) return false;
  switch (a.type) {
    case Value::Type::Null: return true;
    case Value::Type::Bool: return a.boolean == b.boolean;
    case Value::Type::String: return a.string == b.string;
    case Value::Type::Object:
      if (a.object.size() != b.object.size()) return false;
      for (size_t i = 0; i < a.object.size(); ++i) {
        if (a.object[i].first != b.object[i].first || !same(a.object[i].second, b.object[i].second)) return false;
      }
      return true;
    case Value::Type::Bytes:
      return a.blob && b.blob && a.blob->prefix == b.blob->prefix && a.blob->bytes == b.blob->bytes;
    default: return false;
  }
}

Value parse_text(const unsigned char* data, size_t size) {
  styk::json::ParseResult r = styk::json::parse(reinterpret_cast<const char*>(data), size);
  if (!r.ok) std::printf("expected JSON failed to parse: %s\n", r.error.c_str());
  CHECK(r.ok);
  return std::move(r.value);
}

void without_key(Value& obj, const char* key) {
  for (size_t i = 0; i < obj.object.size(); ++i) {
    if (obj.object[i].first == key) {
      obj.object.erase(obj.object.begin() + static_cast<long>(i));
      return;
    }
  }
}

// ------------------------------------------------------------- sha/b64 ----

void test_sha256() {
  CHECK(hex(styk::sha256(nullptr, 0)) ==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  CHECK(hex(styk::sha256(reinterpret_cast<const uint8_t*>("abc"), 3)) ==
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const std::string two =
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  CHECK(hex(styk::sha256(reinterpret_cast<const uint8_t*>(two.data()), two.size())) ==
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  std::vector<uint8_t> million(1000000, 'a');
  CHECK(hex(styk::sha256(million.data(), million.size())) ==
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  styk::Sha256 chunked;  // awkward chunk sizes exercise buffering
  for (size_t i = 0; i < million.size();) {
    const size_t n = std::min<size_t>(1 + (i % 97), million.size() - i);
    chunked.update(million.data() + i, n);
    i += n;
  }
  CHECK(hex(chunked.finish()) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

void test_base64() {
  const uint8_t data[] = {0, 1, 2, 3, 250, 251, 252};
  for (size_t n = 0; n <= sizeof data; ++n) {
    const std::string enc = styk::base64_encode(data, n);
    std::vector<uint8_t> back;
    CHECK(styk::base64_decode(enc, back));
    CHECK(back.size() == n && (n == 0 || std::memcmp(back.data(), data, n) == 0));
  }
  CHECK(styk::base64_encode(reinterpret_cast<const uint8_t*>("Man"), 3) == "TWFu");
  CHECK(styk::base64_encode(reinterpret_cast<const uint8_t*>("Ma"), 2) == "TWE=");
  std::vector<uint8_t> out;
  CHECK(styk::base64_decode("QQ==", out) && out.size() == 1 && out[0] == 'A');
  CHECK(!styk::base64_decode("QR==", out));  // non-canonical trailing bits
  CHECK(!styk::base64_decode("QUE", out));   // bad length
  CHECK(!styk::base64_decode("QU!=", out));  // bad character
  CHECK(!styk::base64_decode("====", out));
  CHECK(styk::base64_decode("", out) && out.empty());
}

// ---------------------------------------------------------------- json ----

styk::json::ParseResult P(const std::string& s) { return styk::json::parse(s.data(), s.size()); }

void test_json() {
  auto r = P("{\"a\":[1,2.5,-0,1e2,true,false,null],\"b\":\"x\\n\\u00e9\\ud83d\\ude00\",\"a\":7}");
  CHECK(r.ok);
  if (r.ok) {
    CHECK(r.value.object.size() == 2);                 // duplicate key collapsed
    CHECK(r.value.find("a")->integer == 7);            // last one wins
    CHECK(r.value.find("b")->string == "x\n\xC3\xA9\xF0\x9F\x98\x80");
  }
  r = P("[1,2.5,-0,1e2,18446744073709551616,9223372036854775807]");
  CHECK(r.ok && r.value.array.size() == 6);
  if (r.ok) {
    CHECK(r.value.array[0].type == Value::Type::Int && r.value.array[0].integer == 1);
    CHECK(r.value.array[1].type == Value::Type::Double && r.value.array[1].number == 2.5);
    CHECK(r.value.array[2].type == Value::Type::Int && r.value.array[2].integer == 0);
    CHECK(r.value.array[3].type == Value::Type::Double && r.value.array[3].number == 100.0);
    CHECK(r.value.array[4].type == Value::Type::Double);  // beyond int64
    CHECK(r.value.array[5].type == Value::Type::Int && r.value.array[5].integer == 9223372036854775807LL);
  }
  const char* bad[] = {"", "{", "[1,]", "{\"a\":1,}", "01", "-", "1.", ".5", "1e", "tru", "nul",
                       "\"abc", "\"\\x\"", "\"\\ud800\"", "\"\\udc00\"", "[1] 2", "{'a':1}",
                       "\"a\x01\"", "\"\xC3\"", "\"\xC0\x80\"", "1e999", "[,1]", "{\"a\" 1}"};
  for (const char* s : bad) CHECK(!P(s).ok);
  std::string deep(300, '[');
  deep += std::string(300, ']');
  CHECK(!P(deep).ok);                        // depth limit
  CHECK(P("\xEF\xBB\xBF[1]").ok);            // BOM
  CHECK(P(" \t\r\n[ 1 , 2 ] \n").ok);
  styk::json::ParseLimits tiny;
  tiny.max_nodes = 3;
  const std::string text = "[1,2,3,4]";
  CHECK(!styk::json::parse(text.data(), text.size(), tiny).ok);
}

// ------------------------------------------------------------ container ----

void test_fixtures() {
  const Value expected_a = parse_text(kExpected_a, kExpected_a_size);
  Value expected_b = parse_text(kExpected_b, kExpected_b_size);

  {  // container v1
    auto r = styk::native::decode(kFixture_v1, kFixture_v1_size, Kind::Styk);
    if (!r.ok) std::printf("v1: %s\n", r.error.c_str());
    CHECK(r.ok && r.container_version == 1);
    CHECK(r.ok && same(r.document, expected_a));
    CHECK(r.ok && r.document.find("name")->string == "a\xC3\xA7\xC3\xA3o \xE2\x82\xAC");
    CHECK(!styk::native::decode(kFixture_v1, kFixture_v1_size, Kind::Stkz).ok);  // wrong kind
  }
  {  // container v2 with numeric arrays and payload sections
    auto r = styk::native::decode(kFixture_v2, kFixture_v2_size, Kind::Styk);
    if (!r.ok) std::printf("v2: %s\n", r.error.c_str());
    CHECK(r.ok && r.container_version == 2 && r.section_count == 2);
    if (r.ok) {
      Value doc = r.document;
      const Value* images = doc.find("images");
      CHECK(images && images->array.size() == 3);
      if (images && images->array.size() == 3) {
        const Value* a = images->array[0].find("data_base64");
        const Value* b = images->array[1].find("data_url");
        const Value* c = images->array[2].find("data_base64");
        CHECK(a && a->type == Value::Type::Bytes && a->blob->bytes == blob(60000, 3));
        CHECK(b && b->type == Value::Type::Bytes && b->blob->prefix == "data:image/png;base64," &&
              b->blob->bytes == blob(55000, 5));
        CHECK(c && a && c->blob == a->blob);  // identical payload shares one buffer
        CHECK(a && a->bytes_as_string().size() == 80000);
        CHECK(b && b->bytes_as_string().compare(0, 22, "data:image/png;base64,") == 0);
      }
      const Value* poses = doc.find("poses");
      CHECK(poses && poses->find("a") && poses->find("b") &&
            poses->find("a")->nums == poses->find("b")->nums);  // shared identity
      CHECK(poses && poses->find("a")->nums->elem == styk::json::Elem::U8);
      CHECK(doc.find("i32")->nums->elem == styk::json::Elem::I32);
      CHECK(doc.find("f32")->nums->elem == styk::json::Elem::F32);
      CHECK(doc.find("f64")->nums->elem == styk::json::Elem::F64);
      CHECK(doc.find("label")->string == "S2B:u8:0:0:1");    // escape resolved to literal
      CHECK(doc.find("escaped_e")->string == "S2E:already");
      without_key(doc, "images");
      CHECK(same(doc, expected_b));
    }
  }
  {  // .stkz container
    auto r = styk::native::decode(kFixture_v2_stkz, kFixture_v2_stkz_size, Kind::Stkz);
    CHECK(r.ok && same(r.document, expected_a));
    CHECK(!styk::native::decode(kFixture_v2_stkz, kFixture_v2_stkz_size, Kind::Styk).ok);
  }
#ifdef STYK_HAVE_ZSTD_FIXTURES
  {  // v2 containers whose skeleton and sections use zstd (what the web client writes)
    auto r = styk::native::decode(kFixture_v2_zstd, kFixture_v2_zstd_size, Kind::Styk);
    if (!r.ok) std::printf("v2 zstd: %s\n", r.error.c_str());
    CHECK(r.ok && r.container_version == 2 && r.section_count == 2);
    if (r.ok) {
      Value doc = r.document;
      const Value* images = doc.find("images");
      CHECK(images && images->array.size() == 3 &&
            images->array[0].find("data_base64")->blob->bytes == blob(60000, 3));
      without_key(doc, "images");
      CHECK(same(doc, expected_b));
    }
    auto k = styk::native::decode(kFixture_v2_stkz_zstd, kFixture_v2_stkz_zstd_size, Kind::Stkz);
    CHECK(k.ok && same(k.document, expected_a));
    // Damaged zstd data is rejected cleanly.
    for (size_t n = 0; n < kFixture_v2_zstd_size; n += 7) {
      CHECK(!styk::native::decode(kFixture_v2_zstd, n, Kind::Styk).ok);
    }
    for (size_t i = 0; i < kFixture_v2_zstd_size; i += 3) {
      std::vector<uint8_t> flipped(kFixture_v2_zstd, kFixture_v2_zstd + kFixture_v2_zstd_size);
      flipped[i] ^= 0x41;
      const auto fr = styk::native::decode(flipped.data(), flipped.size(), Kind::Styk);
      if (fr.ok) CHECK(same(fr.document, r.document));
    }
  }
#endif
  {  // plain JSON with BOM
    auto r = styk::native::decode(kFixture_plain, kFixture_plain_size, Kind::Styk);
    CHECK(r.ok && r.container_version == 0 && same(r.document, expected_a));
  }
  {  // wrapper is unwrapped, browser-only fields dropped
    auto r = styk::native::decode(kFixture_wrapped, kFixture_wrapped_size, Kind::Styk);
    Value expected = parse_text(kExpected_wrapped, kExpected_wrapped_size);
    CHECK(r.ok && same(r.document, expected));
  }
  {  // kind detection
    Kind k;
    CHECK(styk::native::detect_kind(kFixture_v1, kFixture_v1_size, k) && k == Kind::Styk);
    CHECK(styk::native::detect_kind(kFixture_v2_stkz, kFixture_v2_stkz_size, k) && k == Kind::Stkz);
    CHECK(styk::native::detect_kind(kFixture_plain, kFixture_plain_size, k) && k == Kind::Styk);
    const uint8_t stmv[] = {'S', 'T', 'M', 'V', 1};
    CHECK(styk::native::detect_kind(stmv, sizeof stmv, k) && k == Kind::Stykmov);
    const uint8_t junk[] = {1, 2, 3, 4, 5};
    CHECK(!styk::native::detect_kind(junk, sizeof junk, k));
  }
  {  // summary mentions container and fields
    auto r = styk::native::decode(kFixture_v2, kFixture_v2_size, Kind::Styk);
    const std::string s = styk::native::summarize(r);
    CHECK(s.find("container v2") != std::string::npos && s.find("fps = 30") != std::string::npos);
  }
}

void test_corruption() {
  struct Case {
    const unsigned char* data;
    size_t size;
    Kind kind;
  };
  const Case cases[] = {{kFixture_v1, kFixture_v1_size, Kind::Styk},
                        {kFixture_v2, kFixture_v2_size, Kind::Styk},
                        {kFixture_v2_stkz, kFixture_v2_stkz_size, Kind::Stkz}};
  for (const Case& c : cases) {
    for (size_t n = 0; n < c.size; ++n) CHECK(!styk::native::decode(c.data, n, c.kind).ok);
    std::vector<uint8_t> extra(c.data, c.data + c.size);
    extra.push_back(0);
    CHECK(!styk::native::decode(extra.data(), extra.size(), c.kind).ok);
    // A flipped byte must be rejected, unless it only changes how the same
    // content is deflated (the checksums then still hold and the decoded
    // document must be identical).
    const auto base = styk::native::decode(c.data, c.size, c.kind);
    CHECK(base.ok);
    size_t equivalent = 0;
    for (size_t i = 0; i < c.size; ++i) {
      std::vector<uint8_t> flipped(c.data, c.data + c.size);
      flipped[i] ^= 0x41;
      const auto r = styk::native::decode(flipped.data(), flipped.size(), c.kind);
      if (r.ok) {
        ++equivalent;
        CHECK(same(r.document, base.document));
      }
    }
    CHECK(equivalent * 50 < c.size);  // only a handful of bytes are free to change
  }
  {  // a zlib payload declared as zstd is damaged data, not a crash
    std::vector<uint8_t> f(kFixture_v2, kFixture_v2 + kFixture_v2_size);
    f[5] = 2;
    const auto r = styk::native::decode(f.data(), f.size(), Kind::Styk);
    CHECK(!r.ok);
  }
  {  // v1 files carry the text verbatim; a non-object document is rejected
    const std::string doc = "[\"S2S:0:0:1\"]";
    std::string err;
    auto file = styk::native::encode_v1(reinterpret_cast<const uint8_t*>(doc.data()), doc.size(),
                                        Kind::Styk, err);
    CHECK(!file.empty());
    auto r = styk::native::decode(file.data(), file.size(), Kind::Styk);
    CHECK(!r.ok && r.code == "invalid_document");
  }
}

void test_encode_v1() {
  const std::string doc = "{\"fps\":24,\"name\":\"ol\xC3\xA1\",\"list\":[1,2,3]}";
  std::string err;
  const std::vector<uint8_t> file = styk::native::encode_v1(
      reinterpret_cast<const uint8_t*>(doc.data()), doc.size(), Kind::Stkz, err);
  CHECK(!file.empty() && err.empty());
  CHECK(file.size() > 56 && std::memcmp(file.data(), "STKZ", 4) == 0 && file[4] == 1 && file[5] == 1);
  auto r = styk::native::decode(file.data(), file.size(), Kind::Stkz);
  Value expected = parse_text(reinterpret_cast<const unsigned char*>(doc.data()), doc.size());
  CHECK(r.ok && same(r.document, expected));
  CHECK(styk::native::encode_v1(nullptr, 0, Kind::Styk, err).empty());
  // Optional dump so tools/verify_v1.py can check the file with Python.
  if (const char* path = std::getenv("STYK_DUMP_V1")) {
    if (FILE* f = std::fopen(path, "wb")) {
      std::fwrite(file.data(), 1, file.size(), f);
      std::fclose(f);
    }
  }
}

}  // namespace

int main() {
  test_sha256();
  test_base64();
  test_json();
  test_fixtures();
  test_corruption();
  test_encode_v1();
  if (g_failures) {
    std::printf("%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("native_test: all checks passed\n");
  return 0;
}
