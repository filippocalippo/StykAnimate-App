// Checks the zstd decoder against frames made by libzstd (see
// tools/gen_zstd_cases.py), then fuzzes it with damaged copies of them.
// Usage: zstd_test <a.zst> <a.raw> [<b.zst> <b.raw> ...]

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "zstd.h"

static std::vector<uint8_t> slurp(const char* path) {
  std::ifstream f(path, std::ios::binary);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(f), {});
}

int main(int argc, char** argv) {
  int failures = 0;
  size_t cases = 0;
  unsigned long long fuzzed = 0;
  std::srand(1);
  for (int i = 1; i + 1 < argc; i += 2) {
    const std::vector<uint8_t> z = slurp(argv[i]);
    const std::vector<uint8_t> raw = slurp(argv[i + 1]);
    std::vector<uint8_t> out;
    std::string error;
    ++cases;
    if (!styk::zstd::decompress(z.data(), z.size(), raw.size(), out, error) || out != raw) {
      std::printf("FAIL %s: %s\n", argv[i], error.empty() ? "output differs" : error.c_str());
      ++failures;
      continue;
    }
    // A wrong expected size must be rejected.
    if (styk::zstd::decompress(z.data(), z.size(), raw.size() + 1, out, error)) {
      std::printf("FAIL %s: accepted a wrong size\n", argv[i]);
      ++failures;
    }
    if (z.size() > 60000 || z.size() < 8) continue;
    for (int r = 0; r < 40; ++r) {  // damaged copies must never crash
      std::vector<uint8_t> m = z;
      const int edits = 1 + std::rand() % 3;
      for (int e = 0; e < edits; ++e) m[std::rand() % m.size()] ^= static_cast<uint8_t>(1 + std::rand() % 255);
      if (r % 7 == 0) m.resize(1 + std::rand() % m.size());
      styk::zstd::decompress(m.data(), m.size(), raw.size(), out, error);
      ++fuzzed;
    }
  }
  std::printf("zstd_test: %zu frames, %llu damaged inputs, %d failures\n", cases, fuzzed, failures);
  return failures ? 1 : 0;
}
