#include "piv.h"

#include <zlib.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <unordered_set>

namespace styk::piv {
namespace {

struct PivError : std::runtime_error {
  using std::runtime_error::runtime_error;
};
struct PivUnsupported : PivError {
  using PivError::PivError;
};

[[noreturn]] void fail(const std::string& message) { throw PivError(message); }

std::string hex(size_t value) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "0x%zx", value);
  return buf;
}

// ---------------------------------------------------------------- zlib ----

std::vector<uint8_t> inflate_all(const uint8_t* src, size_t size) {
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
      const bool truncated = (ret == Z_BUF_ERROR && s.avail_in == 0);
      inflateEnd(&s);
      if (truncated) fail("Truncated compressed project");
      fail("Invalid zlib project");
    }
    out.insert(out.end(), chunk.data(), chunk.data() + (chunk.size() - s.avail_out));
    if (out.size() > kMaxPayloadBytes) {
      inflateEnd(&s);
      fail("Decompressed project exceeds size limit");
    }
  }
  const bool trailing = s.avail_in != 0;
  inflateEnd(&s);
  if (trailing) fail("Unexpected bytes after compressed project");
  return out;
}

// -------------------------------------------------------------- reader ----

class Reader {
 public:
  Reader(const uint8_t* data, size_t size) : data_(data), size_(size) {}

  size_t pos() const { return pos_; }
  size_t size() const { return size_; }
  void seek(size_t pos) { pos_ = pos; }

  const uint8_t* take(size_t count) {
    if (count > size_ - pos_) {
      fail("Unexpected EOF at payload offset " + hex(pos_) + ", need " +
           std::to_string(count) + " bytes");
    }
    const uint8_t* p = data_ + pos_;
    pos_ += count;
    return p;
  }

  uint8_t u8() { return *take(1); }
  uint16_t u16() { return load<uint16_t>(); }
  uint32_t u32() { return load<uint32_t>(); }
  uint64_t u64() { return load<uint64_t>(); }

  float f32() {
    const size_t offset = pos_;
    const float v = load<float>();
    if (!std::isfinite(v)) fail("Non-finite float at " + hex(offset));
    return v;
  }
  double f64() {
    const size_t offset = pos_;
    const double v = load<double>();
    if (!std::isfinite(v)) fail("Non-finite double at " + hex(offset));
    return v;
  }

  std::string string8();

 private:
  // The format is little-endian; Android targets (arm, arm64, x86) all are.
  template <class T>
  T load() {
    T v;
    std::memcpy(&v, take(sizeof(T)), sizeof(T));
    return v;
  }

  const uint8_t* data_;
  size_t size_;
  size_t pos_ = 0;
};

// Windows-1252 bytes 0x80..0x9F as Unicode code points (0xFFFD = undefined).
constexpr uint16_t kCp1252High[32] = {
    0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
    0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178};

void append_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

std::string Reader::string8() {
  const size_t n = u8();
  const uint8_t* p = take(n);
  std::string out;
  out.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    const uint8_t b = p[i];
    if (b >= 0x80 && b <= 0x9F) {
      append_utf8(out, kCp1252High[b - 0x80]);
    } else {
      append_utf8(out, b);  // ASCII and Latin-1 range map 1:1
    }
  }
  return out;
}

// --------------------------------------------------------- built-in man ----

FigureType builtin_man() {
  struct Row {
    uint16_t parent;
    double length, angle, thickness;
    uint8_t prim, aux;
  };
  // Implicit native slot 1, dumped from Pivot 5 (values copied verbatim from
  // codecs/piv_codec.py::_builtin_man, including the last-digit differences).
  static const Row rows[12] = {
      {0, 32., -1.5707963267948968, 14., 0, 0}, {1, 32., -1.5707963267948968, 14., 0, 0},
      {2, 33., -1.5707963267948968, 14., 0, 0}, {3, 20., 1.5707963267948966, 20., 1, 1},
      {2, 38., 2.356194490192345, 14., 0, 0},   {2, 38., 0.7853981633974483, 14., 0, 0},
      {5, 40., 2.0943951023931957, 14., 0, 0},  {6, 40., 1.0471975511965979, 14., 0, 0},
      {0, 50., 1.9634954084936207, 14., 0, 0},  {0, 50., 1.1780972450961724, 14., 0, 0},
      {9, 50., 1.9634954084936207, 14., 0, 0},  {10, 50., 1.1780972450961724, 14., 0, 0},
  };
  FigureType f;
  f.id = 1;
  f.name = "Default";
  f.implicit = true;
  f.handle_ids.push_back(0);
  for (uint16_t i = 0; i < 12; ++i) {
    Segment s;
    s.segment_id = static_cast<uint16_t>(i + 1);
    s.parent_id = rows[i].parent;
    s.length = static_cast<float>(rows[i].length);
    s.angle_rad = rows[i].angle;
    s.thickness = static_cast<float>(rows[i].thickness);
    s.primitive_code = rows[i].prim;
    s.aux_code = rows[i].aux;
    s.z_raw = i;
    f.segments.push_back(s);
    f.handle_ids.push_back(s.segment_id);
  }
  return f;
}

// ---------------------------------------------------------- backgrounds ----

std::vector<Background> read_backgrounds(Reader& r, uint16_t& slots_out) {
  const uint16_t slots = r.u16();
  if (slots < 1) fail("Background slot count must include implicit white background");
  std::vector<Background> out;
  for (uint16_t i = 1; i < slots; ++i) {
    Background bg;
    bg.id = i;
    bg.kind = r.u8();
    const size_t record_start = r.pos() - 1;
    if (bg.kind == 0 || bg.kind == 1) {
      const uint64_t end = r.u64();
      if (end < r.pos() || end > r.size()) {
        fail("Invalid background image end at " + hex(record_start));
      }
      const size_t blob_len = static_cast<size_t>(end) - r.pos();
      const uint8_t* p = r.take(blob_len);
      bg.image.assign(p, p + blob_len);
    } else if (bg.kind == 2) {
      bg.color = r.u32();
    } else if (bg.kind == 3 || bg.kind == 4) {
      bg.color_a = r.u32();
      bg.color_b = r.u32();
      bg.x1 = r.f32();
      bg.y1 = r.f32();
      bg.x2 = r.f32();
      bg.y2 = r.f32();
    } else {
      fail("Unsupported background kind " + std::to_string(bg.kind) + " at " + hex(record_start));
    }
    bg.name = r.string8();
    out.push_back(std::move(bg));
  }
  slots_out = slots;
  return out;
}

// -------------------------------------------------------------- figures ----

FigureType read_figure(Reader& r, uint16_t figure_id) {
  FigureType f;
  f.id = figure_id;
  const size_t start = r.pos();
  const uint8_t flags = r.u8();
  f.flags = flags;
  const uint16_t count = r.u16();
  const std::string where = "figure " + std::to_string(figure_id);
  if (!(count > 0 && count <= kMaxSegments)) {
    fail("Invalid segment count " + std::to_string(count) + " for " + where + " at " + hex(start));
  }
  f.segments.resize(count);
  bool needs_side_tables = false;
  for (uint16_t i = 0; i < count; ++i) {
    Segment& s = f.segments[i];
    s.parent_id = r.u16();
    s.segment_id = (flags & 32) ? static_cast<uint16_t>(i + 1) : r.u16();
    s.length = r.f32();
    s.angle_rad = r.f64();
    s.thickness = r.f32();
    s.primitive_code = (flags & 1) ? 0 : r.u8();
    s.aux_code = (flags & 2) ? 0 : r.u8();
    if (!(flags & 4)) {
      const uint8_t* c = r.take(3);
      s.rgb = {c[0], c[1], c[2]};
    }
    s.transparency = (flags & 8) ? 0 : r.u8();
    if (!(flags & 128)) {
      if (r.u8()) {
        const uint8_t* c = r.take(3);
        s.has_secondary = true;
        s.secondary_rgb = {c[0], c[1], c[2]};
        s.secondary_alpha = r.u8();
      }
    }
    if (s.primitive_code == 2 || s.primitive_code == 5) {
      s.extra_u16 = r.u16();
      s.extra_u8_a = r.u8();
      s.extra_u8_b = r.u8();
      needs_side_tables = true;
    }
    if (s.primitive_code > 6) {
      fail("Unknown primitive " + std::to_string(s.primitive_code) + " in " + where +
           ", segment " + std::to_string(i));
    }
  }

  // Segment ids: unique, non-zero; parents known; parent chains acyclic.
  std::vector<uint8_t> present(65536, 0);
  size_t distinct = 0;
  for (const Segment& s : f.segments) {
    if (s.segment_id == 0) fail("Invalid duplicate/zero segment IDs in " + where);
    if (!present[s.segment_id]) {
      present[s.segment_id] = 1;
      ++distinct;
    }
  }
  if (distinct != count) fail("Invalid duplicate/zero segment IDs in " + where);
  for (const Segment& s : f.segments) {
    if (s.parent_id != 0 && !present[s.parent_id]) fail("Unknown parent ID in " + where);
  }
  {
    std::vector<uint16_t> parent_of(65536, 0);
    for (const Segment& s : f.segments) parent_of[s.segment_id] = s.parent_id;
    std::vector<uint8_t> state(65536, 0);  // 0 new, 1 on current path, 2 verified
    std::vector<uint16_t> path;
    for (const Segment& s : f.segments) {
      path.clear();
      uint16_t cursor = s.segment_id;
      while (cursor != 0 && state[cursor] != 2) {
        if (state[cursor] == 1) fail("Cyclic segment parents in " + where);
        state[cursor] = 1;
        path.push_back(cursor);
        cursor = parent_of[cursor];
      }
      for (uint16_t id : path) state[id] = 2;
    }
  }
  f.handle_ids.push_back(0);
  for (const Segment& s : f.segments) f.handle_ids.push_back(s.segment_id);
  std::sort(f.handle_ids.begin(), f.handle_ids.end());
  auto valid_handle = [&](uint16_t id) {
    return std::binary_search(f.handle_ids.begin(), f.handle_ids.end(), id);
  };

  const uint16_t bend_count = r.u16();
  if (bend_count > count) fail("Invalid bend count in " + where);
  for (uint16_t i = 0; i < bend_count; ++i) {
    const uint16_t index = r.u16();
    if (index >= count) fail("Invalid bend index " + std::to_string(index) + " in " + where);
    f.segments[index].bend_rad = r.f64();
  }

  if (needs_side_tables) {
    throw PivUnsupported("Figure " + std::to_string(figure_id) +
                         " contains image/text tables (not supported yet)");
  }

  const uint16_t poly_count = r.u16();
  if (poly_count > 20000) {
    fail("Invalid polyfill count " + std::to_string(poly_count) + " in " + where);
  }
  f.polyfills.resize(poly_count);
  for (uint16_t pi = 0; pi < poly_count; ++pi) {
    Polyfill& p = f.polyfills[pi];
    const uint16_t sc = r.u16();
    const uint8_t* c = r.take(3);
    p.rgb = {c[0], c[1], c[2]};
    p.alpha_raw = r.u8();
    p.segment_ids.resize(sc);
    for (uint16_t k = 0; k < sc; ++k) p.segment_ids[k] = r.u16();
    for (uint16_t id : p.segment_ids) {
      if (!valid_handle(id)) {
        fail("Unknown polyfill joint in " + where + ", polygon " + std::to_string(pi));
      }
    }
  }

  const size_t total = static_cast<size_t>(count) + poly_count;
  std::vector<uint16_t> seg_z(count), poly_z(poly_count);
  if (flags & 16) {
    for (uint16_t i = 0; i < count; ++i) seg_z[i] = i;
    for (uint16_t i = 0; i < poly_count; ++i) poly_z[i] = static_cast<uint16_t>(count + i);
  } else {
    for (uint16_t i = 0; i < count; ++i) seg_z[i] = r.u16();
    for (uint16_t i = 0; i < poly_count; ++i) poly_z[i] = r.u16();
  }
  {
    std::vector<uint8_t> seen(total, 0);
    auto check = [&](uint16_t z) {
      if (z >= total || seen[z]) fail("Invalid z-order permutation for " + where);
      seen[z] = 1;
    };
    for (uint16_t z : seg_z) check(z);
    for (uint16_t z : poly_z) check(z);
  }
  for (uint16_t i = 0; i < count; ++i) f.segments[i].z_raw = seg_z[i];
  for (uint16_t i = 0; i < poly_count; ++i) f.polyfills[i].z_raw = poly_z[i];

  if (flags & 64) {
    f.style.present = true;
    f.style.u28 = r.u32();
    const uint8_t* c = r.take(3);
    f.style.rgb = {c[0], c[1], c[2]};
    f.style.u30 = r.u8();
    float t;
    std::memcpy(&t, &f.style.u28, sizeof t);
    if (!std::isfinite(t)) fail("Non-finite outline thickness in " + where);
    f.style.outline_thickness = t;
  }
  f.name = r.string8();
  return f;
}

// ------------------------------------------------------------ keyframes ----

std::vector<Keyframe> read_keyframes(Reader& r, const std::vector<FigureType>& figures,
                                     uint16_t figure_slots, uint16_t bg_slots) {
  const uint32_t count = r.u32();
  if (count > 1000000) fail("Implausible keyframe count " + std::to_string(count));
  std::vector<const FigureType*> by_id(figure_slots, nullptr);
  for (const FigureType& f : figures) {
    if (f.id < figure_slots) by_id[f.id] = &f;
  }
  std::vector<Keyframe> frames;
  frames.reserve(count);
  for (uint32_t fi = 0; fi < count; ++fi) {
    Keyframe kf;
    const size_t start = r.pos();
    const std::string fname = "frame " + std::to_string(fi);
    kf.duration_raw = r.u16();
    kf.background_mix = r.u8();
    kf.background_id = r.u16();
    if (kf.background_mix) kf.background_id_b = r.u16();
    if (kf.background_id >= bg_slots || (kf.background_mix && kf.background_id_b >= bg_slots)) {
      fail("Unknown background in " + fname + " at " + hex(start));
    }
    const uint16_t obj_count = r.u16();
    kf.objects.resize(obj_count);
    for (uint16_t oi = 0; oi < obj_count; ++oi) {
      ObjectPose& o = kf.objects[oi];
      const size_t obj_start = r.pos();
      o.slot = oi;
      o.unique_id = r.u32();
      o.figure_type_id = r.u16();
      if (o.figure_type_id >= figure_slots || !by_id[o.figure_type_id]) {
        fail("Unknown figure type " + std::to_string(o.figure_type_id) + " in " + fname +
             ", object " + std::to_string(oi) + " at " + hex(obj_start));
      }
      const size_t sc = by_id[o.figure_type_id]->segments.size();
      o.scale = r.f32();
      o.color_override_raw = r.u32();
      o.transparency = r.u8();
      // Figures with image/text assets carry one more byte here; such figures
      // are rejected earlier until side tables are implemented.
      o.angles.resize(sc);
      for (size_t k = 0; k < sc; ++k) o.angles[k] = r.f64();
      o.root_x = r.f32();
      o.root_y = r.f32();
      if (r.u16()) {
        o.lengths.resize(sc);
        for (size_t k = 0; k < sc; ++k) o.lengths[k] = r.f32();
      }
      if (r.u16()) {
        o.bends.resize(sc);
        for (size_t k = 0; k < sc; ++k) o.bends[k] = r.f64();
      }
      if (r.u8()) {
        o.has_join = true;
        o.join.target_slot = r.u16();
        o.join.target_handle_id = r.u16();
        if (o.join.target_slot >= obj_count) {
          fail("Invalid joined object slot " + std::to_string(o.join.target_slot) + " in " + fname);
        }
      }
    }
    for (ObjectPose& o : kf.objects) {
      if (!o.has_join) continue;
      const ObjectPose& target = kf.objects[o.join.target_slot];
      const FigureType& tf = *by_id[target.figure_type_id];
      if (!std::binary_search(tf.handle_ids.begin(), tf.handle_ids.end(), o.join.target_handle_id)) {
        fail("Unknown joined target handle in " + fname);
      }
    }
    for (uint16_t oi = 0; oi < obj_count; ++oi) {
      std::vector<uint8_t> visited(obj_count, 0);
      uint16_t cursor = oi;
      while (kf.objects[cursor].has_join) {
        if (visited[cursor]) fail("Cyclic object joins in " + fname);
        visited[cursor] = 1;
        cursor = kf.objects[cursor].join.target_slot;
      }
    }
    kf.draw_order.resize(obj_count);
    {
      std::vector<uint8_t> seen(obj_count, 0);
      for (uint16_t i = 0; i < obj_count; ++i) {
        const uint16_t v = r.u16();
        if (v >= obj_count || seen[v]) {
          fail("Invalid object draw-order permutation in " + fname + " at " + hex(r.pos()));
        }
        seen[v] = 1;
        kf.draw_order[i] = v;
      }
    }
    kf.camera.is_default = r.u8() != 0;
    if (!kf.camera.is_default) {
      kf.camera.x = r.f32();
      kf.camera.y = r.f32();
      kf.camera.angle_rad = r.f64();
      kf.camera.scale = r.f32();
    }
    frames.push_back(std::move(kf));
  }
  return frames;
}

// Gives every object a unique id inside its keyframe (extra occurrences get
// fresh ids) and refreshes join targets. Returns the number of repairs.
size_t recover_object_ids(std::vector<Keyframe>& frames) {
  std::unordered_set<uint32_t> reserved;
  struct Dup {
    size_t frame, object;
  };
  std::vector<Dup> duplicates;
  for (size_t fi = 0; fi < frames.size(); ++fi) {
    std::unordered_set<uint32_t> seen;
    for (size_t oi = 0; oi < frames[fi].objects.size(); ++oi) {
      const uint32_t uid = frames[fi].objects[oi].unique_id;
      if (!seen.insert(uid).second) duplicates.push_back({fi, oi});
    }
    reserved.insert(seen.begin(), seen.end());
  }
  uint64_t candidate = 1;
  for (const Dup& d : duplicates) {
    while (reserved.count(static_cast<uint32_t>(candidate)) && candidate <= 0xFFFFFFFFull) ++candidate;
    if (candidate > 0xFFFFFFFFull) fail("No unused object identity remains for PIV recovery");
    frames[d.frame].objects[d.object].unique_id = static_cast<uint32_t>(candidate);
    reserved.insert(static_cast<uint32_t>(candidate));
  }
  for (Keyframe& kf : frames) {
    for (ObjectPose& o : kf.objects) {
      if (o.has_join) o.join.target_unique_id = kf.objects[o.join.target_slot].unique_id;
    }
  }
  return duplicates.size();
}

Document decode_document(const uint8_t* data, size_t size) {
  if (size == 0) fail("Empty project");
  if (size > kMaxPayloadBytes) fail("Project exceeds size limit");
  Document doc;
  doc.source_size = size;

  std::vector<uint8_t> inflated;
  const uint8_t* payload = data;
  size_t payload_size = size;
  if (data[0] >= 1 && data[0] <= 5) {  // legacy raw files start with a version byte
    doc.compressed = false;
  } else {
    inflated = inflate_all(data, size);
    payload = inflated.data();
    payload_size = inflated.size();
    doc.compressed = true;
  }
  doc.payload_size = payload_size;

  Reader r(payload, payload_size);
  doc.version = r.u8();
  if (doc.version != 5) {
    throw PivUnsupported("Legacy PIV version " + std::to_string(doc.version) +
                         " is not supported yet");
  }
  doc.canvas_width = r.u32();
  doc.canvas_height = r.u32();
  if (!(doc.canvas_width > 0 && doc.canvas_width <= 100000 && doc.canvas_height > 0 &&
        doc.canvas_height <= 100000)) {
    fail("Invalid canvas dimensions");
  }
  doc.backgrounds = read_backgrounds(r, doc.background_slots);
  doc.figure_slots = r.u16();
  if (doc.figure_slots < 2) fail("Figure table must include reserved and implicit slots");
  doc.figures.push_back(builtin_man());
  for (uint16_t tid = 2; tid < doc.figure_slots; ++tid) doc.figures.push_back(read_figure(r, tid));
  doc.keyframes = read_keyframes(r, doc.figures, doc.figure_slots, doc.background_slots);
  doc.identity_repairs = recover_object_ids(doc.keyframes);

  doc.fps = r.u32();
  if (!(doc.fps >= 1 && doc.fps <= 1000)) fail("Invalid fps " + std::to_string(doc.fps));
  const size_t trailer_start = r.pos();
  if (r.pos() < payload_size) {
    const uint8_t ease = r.u8();
    if (ease != 0 && ease != 1) {
      fail("Invalid auto-easing mode " + std::to_string(ease) + " at " + hex(trailer_start));
    }
    doc.auto_easing_disabled_raw = ease;
  }
  doc.trailing_bytes = payload_size - trailer_start;

  uint64_t total = 0;
  for (size_t i = 0; i + 1 < doc.keyframes.size(); ++i) total += doc.keyframes[i].duration_raw;
  if (!doc.keyframes.empty() && doc.keyframes.back().duration_raw > 0) total += 1;
  doc.total_output_frames = total;
  return doc;
}

}  // namespace

Result decode(const uint8_t* data, size_t size) {
  Result result;
  try {
    result.doc = decode_document(data, size);
    result.ok = true;
  } catch (const PivUnsupported& e) {
    result.unsupported = true;
    result.error = e.what();
  } catch (const std::exception& e) {
    result.error = e.what();
  }
  return result;
}

std::string summarize(const Document& d) {
  size_t objects = 0, segments = 0;
  for (const Keyframe& kf : d.keyframes) objects += kf.objects.size();
  for (const FigureType& f : d.figures) segments += f.segments.size();
  const double seconds = d.fps ? static_cast<double>(d.total_output_frames) / d.fps : 0.0;
  char line[160];
  std::string out;
  auto add = [&](const char* fmt, auto... args) {
    std::snprintf(line, sizeof line, fmt, args...);
    out += line;
    out += '\n';
  };
  add("PIV v%u (%s)", static_cast<unsigned>(d.version), d.compressed ? "zlib" : "raw");
  add("Canvas: %u x %u", d.canvas_width, d.canvas_height);
  add("FPS: %u", d.fps);
  add("Frames: %llu (%.2f s)", static_cast<unsigned long long>(d.total_output_frames), seconds);
  add("Keyframes: %zu", d.keyframes.size());
  add("Backgrounds: %zu", d.backgrounds.size());
  add("Figure types: %zu (custom %zu, segments %zu)", d.figures.size(), d.figures.size() - 1, segments);
  add("Object poses: %zu", objects);
  if (d.auto_easing_disabled_raw < 0) {
    out += "Auto-easing: default\n";
  } else {
    add("Auto-easing: %s", d.auto_easing_disabled_raw ? "off" : "on");
  }
  if (d.identity_repairs) add("Duplicate object IDs recovered: %zu", d.identity_repairs);
  return out;
}

}  // namespace styk::piv
