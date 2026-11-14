#pragma once
// Standard base64 (RFC 4648, with padding).

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace styk {

std::string base64_encode(const uint8_t* data, size_t size);

// Strict decoder: rejects characters outside the alphabet, bad padding and
// non-zero trailing bits (i.e. only canonical encodings are accepted).
bool base64_decode(const std::string& text, std::vector<uint8_t>& out);

}  // namespace styk
