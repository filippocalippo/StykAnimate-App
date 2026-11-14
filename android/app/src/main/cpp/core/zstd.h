#pragma once
// Zstandard (RFC 8878) decoder for one complete frame, without dictionaries.
// Used for container codec 2 (files saved by the web and desktop apps).

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace styk::zstd {

// Decompresses `src`, which must be exactly one zstd frame, into `out`.
// The frame must produce exactly `expected_size` bytes; its declared content
// size and checksum (when present) are verified. Returns false and sets
// `error` for corrupt, truncated or unsupported (dictionary) input.
bool decompress(const uint8_t* src, size_t size, size_t expected_size, std::vector<uint8_t>& out,
                std::string& error);

}  // namespace styk::zstd
