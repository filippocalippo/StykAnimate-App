#pragma once
// StykAnimate native container (.styk / .stkz / .stykmov), C++ port of
// backend/native_format.py and src/native-container.mjs.
//
// Supported: container v1 and v2 (codecs 0 = stored and 1 = zlib), plain-JSON
// .styk files and the {"format":"stykanimate"} wrapper. Codec 2 (zstd) is
// reported as code "codec_unavailable" until a zstd decoder is added.

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "json.h"

namespace styk::native {

enum class Kind { Styk, Stkz, Stykmov };

constexpr size_t kHeaderSize = 56;
constexpr size_t kSectionSize = 64;
constexpr size_t kMaxBytes = 256u * 1024u * 1024u;
constexpr size_t kMaxSkeletonBytes = 384u * 1024u * 1024u;
constexpr size_t kMaxSections = 64;

struct DecodeResult {
  bool ok = false;
  std::string error;
  std::string code;  // "", "codec_unavailable", "invalid_document", ...
  json::Value document;
  int container_version = 0;  // 0 plain JSON, 1, 2
  size_t skeleton_bytes = 0;
  size_t section_count = 0;
};

// Reads a file image of the given kind.
DecodeResult decode(const uint8_t* data, size_t size, Kind kind);

// Picks the kind from the file's magic bytes (plain JSON counts as Styk).
bool detect_kind(const uint8_t* data, size_t size, Kind& kind);

// Wraps a UTF-8 JSON document in a container v1 (zlib level 3, SHA-256).
// Returns an empty vector and sets `error` on failure.
std::vector<uint8_t> encode_v1(const uint8_t* json_text, size_t size, Kind kind, std::string& error);

// Short multi-line description of a decoded document.
std::string summarize(const DecodeResult& result);

}  // namespace styk::native
