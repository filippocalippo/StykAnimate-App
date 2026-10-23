#pragma once
// Pivot (.piv) version 5 decoder.
//
// Port of the V5 reader in codecs/piv_codec.py. Platform independent: no JNI,
// no Android headers. Image/text figure side tables, legacy versions (1-4) and
// the STYK/STKZ container are added in later steps of phase 1.

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace styk::piv {

constexpr size_t kMaxPayloadBytes = 256u * 1024u * 1024u;
constexpr uint16_t kMaxSegments = 30000;

struct Background {
  uint32_t id = 0;
  uint8_t kind = 0;  // 0,1 embedded image; 2 solid; 3,4 gradient
  std::vector<uint8_t> image;  // kinds 0 and 1
  uint32_t color = 0;          // kind 2
  uint32_t color_a = 0;        // kinds 3,4
  uint32_t color_b = 0;
  float x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  std::string name;  // UTF-8 (stored as cp1252 in the file)
};

struct Segment {
  uint16_t segment_id = 0;
  uint16_t parent_id = 0;
  float length = 0;
  double angle_rad = 0;
  float thickness = 0;
  uint8_t primitive_code = 0;  // 0 line,1 circle,2 image,3 circleFill,4 circleClear,5 text,6 squareLine
  uint8_t aux_code = 0;        // bit 0 = static
  std::array<uint8_t, 3> rgb{0, 0, 0};
  uint8_t transparency = 0;
  bool has_secondary = false;
  std::array<uint8_t, 3> secondary_rgb{0, 0, 0};
  uint8_t secondary_alpha = 0;
  uint16_t extra_u16 = 0;  // image/text primitives only
  uint8_t extra_u8_a = 0;
  uint8_t extra_u8_b = 0;
  double bend_rad = 0;
  uint16_t z_raw = 0;
};

struct Polyfill {
  std::vector<uint16_t> segment_ids;  // joint tip ids
  std::array<uint8_t, 3> rgb{0, 0, 0};
  uint8_t alpha_raw = 0;
  uint16_t z_raw = 0;
};

struct GlobalStyle {
  bool present = false;
  uint32_t u28 = 0;
  std::array<uint8_t, 3> rgb{0, 0, 0};
  uint8_t u30 = 0;
  float outline_thickness = 0;
};

struct FigureType {
  uint16_t id = 0;
  std::string name;
  uint8_t flags = 0;
  bool implicit = false;  // the built-in native "man" in slot 1
  std::vector<Segment> segments;
  std::vector<Polyfill> polyfills;
  GlobalStyle style;
  std::vector<uint16_t> handle_ids;  // sorted; includes 0 (origin)
};

struct Join {
  uint16_t target_slot = 0;
  uint16_t target_handle_id = 0;
  uint32_t target_unique_id = 0;
};

struct ObjectPose {
  uint16_t slot = 0;
  uint32_t unique_id = 0;
  uint16_t figure_type_id = 0;
  float scale = 1;
  uint32_t color_override_raw = 0;
  uint8_t transparency = 0;  // "field28"
  std::vector<double> angles;
  float root_x = 0, root_y = 0;
  std::vector<float> lengths;  // empty when the length flag is 0
  std::vector<double> bends;   // empty when the bend flag is 0
  bool has_join = false;
  Join join;
};

struct Camera {
  bool is_default = true;
  float x = 0, y = 0;
  double angle_rad = 0;
  float scale = 1;
};

struct Keyframe {
  uint16_t duration_raw = 0;
  uint8_t background_mix = 0;
  uint16_t background_id = 0;
  uint16_t background_id_b = 0;  // only meaningful when background_mix != 0
  std::vector<ObjectPose> objects;
  std::vector<uint16_t> draw_order;  // object slots, back to front
  Camera camera;
};

struct Document {
  uint8_t version = 0;
  bool compressed = false;
  size_t source_size = 0;
  size_t payload_size = 0;
  uint32_t canvas_width = 0;
  uint32_t canvas_height = 0;
  std::vector<Background> backgrounds;  // ids 1..slots-1 (slot 0 is implicit white)
  uint16_t background_slots = 0;
  uint16_t figure_slots = 0;
  std::vector<FigureType> figures;  // figures[0] is the implicit native man (id 1)
  std::vector<Keyframe> keyframes;
  uint32_t fps = 0;
  int auto_easing_disabled_raw = -1;  // -1 when the file omits the byte
  size_t trailing_bytes = 0;
  uint64_t total_output_frames = 0;
  size_t identity_repairs = 0;  // duplicate object ids that were re-assigned
};

struct Result {
  bool ok = false;
  bool unsupported = false;  // valid file using a feature not implemented yet
  std::string error;
  Document doc;
};

// Decodes a .piv file image (raw legacy or zlib-compressed).
Result decode(const uint8_t* data, size_t size);

// Short multi-line description of a decoded document.
std::string summarize(const Document& doc);

}  // namespace styk::piv
