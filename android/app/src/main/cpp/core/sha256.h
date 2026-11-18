#pragma once
// SHA-256 (FIPS 180-4). Used to verify STYK/STKZ container checksums.

#include <array>
#include <cstddef>
#include <cstdint>

namespace styk {

using Sha256Digest = std::array<uint8_t, 32>;

class Sha256 {
 public:
  Sha256();
  void update(const uint8_t* data, size_t size);
  Sha256Digest finish();

 private:
  void block(const uint8_t* chunk);
  uint32_t h_[8];
  uint8_t buffer_[64];
  size_t buffered_ = 0;
  uint64_t total_ = 0;
};

Sha256Digest sha256(const uint8_t* data, size_t size);

}  // namespace styk
