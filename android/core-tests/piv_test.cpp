// Host-side tests for the PIV v5 decoder (no Android needed).
// Build: see run.sh.  Files are synthesised with an independent writer so the
// tests exercise every branch of the reader without a Pivot corpus.

#include <zlib.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "piv.h"

static int g_failures = 0;
#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);            \
      ++g_failures;                                                          \
    }                                                                        \
  } while (0)

namespace {

struct W {
  std::vector<uint8_t> b;
  template <class T>
  void put(T v) {
    uint8_t tmp[sizeof(T)];
    std::memcpy(tmp, &v, sizeof(T));
    b.insert(b.end(), tmp, tmp + sizeof(T));
  }
  void u8(uint8_t v) { put(v); }
  void u16(uint16_t v) { put(v); }
  void u32(uint32_t v) { put(v); }
  void u64(uint64_t v) { put(v); }
  void f32(float v) { put(v); }
  void f64(double v) { put(v); }
  void str(const std::string& s) {
    u8(static_cast<uint8_t>(s.size()));
    b.insert(b.end(), s.begin(), s.end());
  }
};

void segment(W& w, uint16_t parent, uint16_t id, float len, double ang, uint8_t prim) {
  w.u16(parent);
  w.u16(id);
  w.f32(len);
  w.f64(ang);
  w.f32(3.f);
  w.u8(prim);  // primitive
  w.u8(0);     // aux
  w.u8(10), w.u8(20), w.u8(30);  // rgb
  w.u8(0);     // transparency
  w.u8(0);     // no secondary colour
}

// Figure 2: two segments, one bend, one polyfill, explicit z maps, name "stick".
void custom_figure(W& w, uint8_t prim2 = 1, uint16_t parent1 = 0) {
  w.u8(0);  // flags: every optional field present
  w.u16(2);
  segment(w, parent1, 1, 10.f, 0.5, 0);
  segment(w, 1, 2, 20.f, -0.25, prim2);
  w.u16(1);  // bends
  w.u16(1);
  w.f64(0.25);
  w.u16(1);  // polyfills
  w.u16(2);
  w.u8(1), w.u8(2), w.u8(3);
  w.u8(200);
  w.u16(1), w.u16(2);
  w.u16(0), w.u16(1);  // segment z
  w.u16(2);            // polyfill z
  w.str("stick");
}

std::vector<uint8_t> sample_payload() {
  W w;
  w.u8(5);
  w.u32(640), w.u32(480);
  w.u16(2);  // background slots (one real background)
  w.u8(2);   // solid colour
  w.u32(0x00FF8040);
  w.str("sky \x80");  // 0x80 is the euro sign in cp1252
  w.u16(3);  // figure slots: builtin + one custom
  custom_figure(w);
  w.u32(2);  // keyframes
  // frame 0
  w.u16(3), w.u8(0), w.u16(1);
  w.u16(2);  // objects
  w.u32(7), w.u16(2), w.f32(1.f), w.u32(0), w.u8(0);
  w.f64(0.1), w.f64(0.2);
  w.f32(100.f), w.f32(200.f);
  w.u16(0), w.u16(0), w.u8(0);
  w.u32(7), w.u16(1), w.f32(2.f), w.u32(0), w.u8(0);  // duplicate id 7, builtin man
  for (int i = 0; i < 12; ++i) w.f64(0.01 * i);
  w.f32(5.f), w.f32(6.f);
  w.u16(0), w.u16(0);
  w.u8(1), w.u16(0), w.u16(2);  // joined to object 0, handle 2
  w.u16(1), w.u16(0);           // draw order
  w.u8(1);                      // default camera
  // frame 1
  w.u16(1), w.u8(1), w.u16(1), w.u16(0);  // mix with background 0
  w.u16(1);
  w.u32(7), w.u16(2), w.f32(1.f), w.u32(0), w.u8(0);
  w.f64(1.0), w.f64(2.0);
  w.f32(1.f), w.f32(2.f);
  w.u16(1), w.f32(11.f), w.f32(21.f);
  w.u16(1), w.f64(0.5), w.f64(0.6);
  w.u8(0);
  w.u16(0);
  w.u8(0);  // custom camera
  w.f32(3.f), w.f32(4.f), w.f64(0.75), w.f32(1.5f);
  w.u32(24);  // fps
  w.u8(1);    // auto-easing disabled
  return w.b;
}

std::vector<uint8_t> deflate(const std::vector<uint8_t>& in) {
  uLongf n = compressBound(static_cast<uLong>(in.size()));
  std::vector<uint8_t> out(n);
  compress(out.data(), &n, in.data(), static_cast<uLong>(in.size()));
  out.resize(n);
  return out;
}

void test_raw_and_compressed() {
  const std::vector<uint8_t> raw = sample_payload();
  for (int mode = 0; mode < 2; ++mode) {
    const std::vector<uint8_t> file = mode ? deflate(raw) : raw;
    styk::piv::Result r = styk::piv::decode(file.data(), file.size());
    if (!r.ok) std::printf("decode error: %s\n", r.error.c_str());
    CHECK(r.ok);
    if (!r.ok) continue;
    const styk::piv::Document& d = r.doc;
    CHECK(d.compressed == (mode == 1));
    CHECK(d.version == 5);
    CHECK(d.canvas_width == 640 && d.canvas_height == 480);
    CHECK(d.fps == 24);
    CHECK(d.auto_easing_disabled_raw == 1);
    CHECK(d.trailing_bytes == 1);
    CHECK(d.backgrounds.size() == 1);
    CHECK(d.backgrounds[0].kind == 2);
    CHECK(d.backgrounds[0].color == 0x00FF8040);
    CHECK(d.backgrounds[0].name == "sky \xE2\x82\xAC");  // UTF-8 euro sign
    CHECK(d.figures.size() == 2);
    CHECK(d.figures[0].implicit && d.figures[0].segments.size() == 12);
    CHECK(d.figures[0].segments[3].primitive_code == 1);
    CHECK(d.figures[1].id == 2 && d.figures[1].name == "stick");
    CHECK(d.figures[1].segments.size() == 2);
    CHECK(std::fabs(d.figures[1].segments[0].angle_rad - 0.5) < 1e-12);
    CHECK(d.figures[1].segments[0].rgb[1] == 20);
    CHECK(std::fabs(d.figures[1].segments[1].bend_rad - 0.25) < 1e-12);
    CHECK(d.figures[1].polyfills.size() == 1);
    CHECK(d.figures[1].polyfills[0].z_raw == 2);
    CHECK(d.figures[1].polyfills[0].alpha_raw == 200);
    CHECK(d.keyframes.size() == 2);
    CHECK(d.total_output_frames == 4);  // 3 + one for the last key
    const auto& k0 = d.keyframes[0];
    CHECK(k0.duration_raw == 3 && k0.objects.size() == 2);
    CHECK(k0.camera.is_default);
    CHECK(k0.draw_order.size() == 2 && k0.draw_order[0] == 1);
    CHECK(k0.objects[0].unique_id == 7);
    CHECK(k0.objects[1].unique_id == 1);  // duplicate 7 re-assigned to first free id
    CHECK(d.identity_repairs == 1);
    CHECK(k0.objects[1].has_join && k0.objects[1].join.target_unique_id == 7);
    CHECK(k0.objects[1].angles.size() == 12);
    const auto& k1 = d.keyframes[1];
    CHECK(k1.background_mix == 1 && k1.background_id_b == 0);
    CHECK(k1.objects[0].lengths.size() == 2 && k1.objects[0].bends.size() == 2);
    CHECK(!k1.camera.is_default && std::fabs(k1.camera.angle_rad - 0.75) < 1e-12);
    CHECK(k1.camera.scale == 1.5f);
    CHECK(styk::piv::summarize(d).find("Canvas: 640 x 480") != std::string::npos);
  }
}

void test_errors() {
  using styk::piv::decode;
  // Empty and garbage input.
  CHECK(!decode(nullptr, 0).ok);
  const uint8_t junk[] = {0x78, 0x01, 0xFF, 0xFF};
  CHECK(!decode(junk, sizeof junk).ok);

  // Truncated payload at every length must fail cleanly, never crash.
  const std::vector<uint8_t> raw = sample_payload();
  for (size_t n = 1; n < raw.size() - 1; ++n) {
    styk::piv::Result r = decode(raw.data(), n);
    CHECK(!r.ok);
  }

  // Truncated compressed stream.
  const std::vector<uint8_t> z = deflate(raw);
  CHECK(!decode(z.data(), z.size() - 3).ok);
  std::vector<uint8_t> extra = z;
  extra.push_back(0);
  CHECK(!decode(extra.data(), extra.size()).ok);

  // Legacy version is reported as unsupported, not as corrupt.
  uint8_t legacy[] = {3, 0, 0, 0, 0};
  styk::piv::Result lr = decode(legacy, sizeof legacy);
  CHECK(!lr.ok && lr.unsupported);

  // Image primitive needs side tables: unsupported for now.
  {
    W w;
    w.u8(5), w.u32(10), w.u32(10), w.u16(1), w.u16(3);
    custom_figure(w, 2);
    std::vector<uint8_t> f = w.b;
    styk::piv::Result r = decode(f.data(), f.size());
    CHECK(!r.ok && r.unsupported);
  }

  // Cyclic parents: segment 1's parent is segment 2, segment 2's parent is 1.
  {
    W w;
    w.u8(5), w.u32(10), w.u32(10), w.u16(1), w.u16(3);
    custom_figure(w, 1, 2);
    styk::piv::Result r = decode(w.b.data(), w.b.size());
    CHECK(!r.ok && !r.unsupported);
    CHECK(r.error.find("Cyclic") != std::string::npos);
  }

  // Invalid fps.
  {
    std::vector<uint8_t> f = sample_payload();
    // fps is the u32 just before the final byte.
    const uint32_t zero = 0;
    std::memcpy(&f[f.size() - 5], &zero, 4);
    styk::piv::Result r = decode(f.data(), f.size());
    CHECK(!r.ok && r.error.find("fps") != std::string::npos);
  }

  // Invalid canvas.
  {
    std::vector<uint8_t> f = sample_payload();
    const uint32_t zero = 0;
    std::memcpy(&f[1], &zero, 4);
    CHECK(!decode(f.data(), f.size()).ok);
  }
}

}  // namespace

int main() {
  test_raw_and_compressed();
  test_errors();
  if (g_failures) {
    std::printf("%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("piv_test: all checks passed\n");
  return 0;
}
