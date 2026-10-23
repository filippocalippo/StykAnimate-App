#include "base64.h"

namespace styk {
namespace {
constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
}

std::string base64_encode(const uint8_t* data, size_t size) {
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 3 <= size; i += 3) {
    const uint32_t v = (uint32_t(data[i]) << 16) | (uint32_t(data[i + 1]) << 8) | data[i + 2];
    out.push_back(kAlphabet[v >> 18]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
    out.push_back(kAlphabet[v & 63]);
  }
  if (size - i == 1) {
    const uint32_t v = uint32_t(data[i]) << 16;
    out.push_back(kAlphabet[v >> 18]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out += "==";
  } else if (size - i == 2) {
    const uint32_t v = (uint32_t(data[i]) << 16) | (uint32_t(data[i + 1]) << 8);
    out.push_back(kAlphabet[v >> 18]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
    out.push_back('=');
  }
  return out;
}

bool base64_decode(const std::string& text, std::vector<uint8_t>& out) {
  out.clear();
  const size_t n = text.size();
  if (n % 4) return false;
  auto value = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  size_t padding = 0;
  if (n && text[n - 1] == '=') padding = (n >= 2 && text[n - 2] == '=') ? 2 : 1;
  const size_t end = n - padding;
  out.reserve(n / 4 * 3);
  uint32_t acc = 0;
  int bits = 0;
  int last = 0;
  for (size_t i = 0; i < end; ++i) {
    last = value(text[i]);
    if (last < 0) {
      out.clear();
      return false;
    }
    acc = (acc << 6) | static_cast<uint32_t>(last);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>(acc >> bits));
      acc &= (1u << bits) - 1;
    }
  }
  // Canonical form: unused low bits of the last symbol must be zero.
  if ((padding == 2 && (last & 15)) || (padding == 1 && (last & 3))) {
    out.clear();
    return false;
  }
  return true;
}

}  // namespace styk
