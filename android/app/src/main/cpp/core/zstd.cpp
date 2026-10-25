#include "zstd.h"

#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace styk::zstd {
namespace {

struct ZstdError : std::runtime_error {
  using std::runtime_error::runtime_error;
};
[[noreturn]] void fail(const char* message) { throw ZstdError(message); }

constexpr size_t kBlockMax = 128 * 1024;

int high_bit(uint32_t v) {  // v > 0
  int n = 0;
  while (v >>= 1) ++n;
  return n;
}

// ------------------------------------------------------------ xxHash64 ----

uint64_t rotl64(uint64_t x, int r) { return (x << r) | (x >> (64 - r)); }
constexpr uint64_t P1 = 11400714785074694791ull, P2 = 14029467366897019727ull,
                   P3 = 1609587929392839161ull, P4 = 9650029242287828579ull,
                   P5 = 2870177450012600261ull;

uint64_t read64(const uint8_t* p) { uint64_t v; std::memcpy(&v, p, 8); return v; }
uint32_t read32(const uint8_t* p) { uint32_t v; std::memcpy(&v, p, 4); return v; }
uint64_t xx_round(uint64_t acc, uint64_t input) { return rotl64(acc + input * P2, 31) * P1; }
uint64_t xx_merge(uint64_t acc, uint64_t val) { return (acc ^ xx_round(0, val)) * P1 + P4; }

uint64_t xxh64(const uint8_t* p, size_t len) {
  const uint8_t* const end = p + len;
  uint64_t h;
  if (len >= 32) {
    uint64_t v1 = P1 + P2, v2 = P2, v3 = 0, v4 = 0 - P1;
    do {
      v1 = xx_round(v1, read64(p)); p += 8;
      v2 = xx_round(v2, read64(p)); p += 8;
      v3 = xx_round(v3, read64(p)); p += 8;
      v4 = xx_round(v4, read64(p)); p += 8;
    } while (p <= end - 32);
    h = rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18);
    h = xx_merge(h, v1); h = xx_merge(h, v2); h = xx_merge(h, v3); h = xx_merge(h, v4);
  } else {
    h = P5;
  }
  h += len;
  while (p + 8 <= end) { h ^= xx_round(0, read64(p)); h = rotl64(h, 27) * P1 + P4; p += 8; }
  if (p + 4 <= end) { h ^= static_cast<uint64_t>(read32(p)) * P1; h = rotl64(h, 23) * P2 + P3; p += 4; }
  while (p < end) { h ^= (*p++) * P5; h = rotl64(h, 11) * P1; }
  h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32;
  return h;
}

// ----------------------------------------------------------- bit readers ----

// Little-endian bit reader moving forward (FSE table descriptions).
class ForwardBits {
 public:
  ForwardBits(const uint8_t* p, size_t n) : p_(p), size_bits_(n * 8) {}
  uint32_t read(int n) {  // n <= 24
    if (pos_ + static_cast<size_t>(n) > size_bits_) fail("truncated FSE table description");
    uint32_t v = 0;
    for (int i = 0; i < n; ++i, ++pos_) v |= static_cast<uint32_t>((p_[pos_ >> 3] >> (pos_ & 7)) & 1) << i;
    return v;
  }
  uint32_t peek_lenient(int n) const {  // missing bits read as zero
    uint32_t v = 0;
    for (int i = 0; i < n; ++i) {
      const size_t b = pos_ + static_cast<size_t>(i);
      if (b < size_bits_) v |= static_cast<uint32_t>((p_[b >> 3] >> (b & 7)) & 1) << i;
    }
    return v;
  }
  void skip(int n) { pos_ += static_cast<size_t>(n); }
  size_t bits_used() const { return pos_; }
  size_t bits_total() const { return size_bits_; }

 private:
  const uint8_t* p_;
  size_t size_bits_;
  size_t pos_ = 0;
};

// Bit reader that starts at the end of a stream and moves backwards. The last
// byte carries a marker bit; bits below it are the stream, read MSB first.
class BackwardBits {
 public:
  BackwardBits(const uint8_t* p, size_t n) : p_(p) {
    if (n == 0 || p[n - 1] == 0) fail("invalid bitstream end marker");
    pos_ = static_cast<int64_t>(n - 1) * 8 + high_bit(p[n - 1]);
  }
  int64_t remaining() const { return pos_; }
  bool overflowed() const { return pos_ < 0; }
  // Returns the next n bits (n <= 32) without consuming them; bits before the
  // start of the stream read as zero.
  uint32_t peek(int n) const {
    if (n == 0) return 0;
    uint32_t v = 0;
    for (int i = n - 1; i >= 0; --i) {
      const int64_t b = pos_ - n + i;  // bit index of this output bit
      const uint32_t bit = (b >= 0) ? static_cast<uint32_t>((p_[b >> 3] >> (b & 7)) & 1) : 0u;
      v |= bit << i;
    }
    return v;
  }
  void consume(int n) { pos_ -= n; }
  uint32_t read(int n) {
    const uint32_t v = peek(n);
    pos_ -= n;
    return v;
  }

 private:
  const uint8_t* p_;
  int64_t pos_ = 0;
};

// ------------------------------------------------------------------ FSE ----

struct FseEntry {
  uint16_t base;
  uint8_t symbol;
  uint8_t nbits;
};

struct FseTable {
  int accuracy_log = 0;
  std::vector<FseEntry> entries;
  bool valid = false;
};

// Reads a normalized-count description; returns the number of bytes used.
size_t read_fse_counts(const uint8_t* src, size_t size, int max_symbol, int max_accuracy,
                       std::vector<int16_t>& counts, int& accuracy_log) {
  ForwardBits br(src, size);
  accuracy_log = static_cast<int>(br.read(4)) + 5;
  if (accuracy_log > max_accuracy) fail("FSE accuracy log too large");
  int remaining = (1 << accuracy_log) + 1;
  int threshold = 1 << accuracy_log;
  int nbits = accuracy_log + 1;
  counts.assign(0, 0);
  bool previous_zero = false;
  while (remaining > 1 && static_cast<int>(counts.size()) <= max_symbol) {
    if (previous_zero) {
      int repeat;
      do {
        repeat = static_cast<int>(br.read(2));
        for (int i = 0; i < repeat; ++i) counts.push_back(0);
      } while (repeat == 3);
      if (static_cast<int>(counts.size()) > max_symbol + 1) fail("FSE symbol range too large");
      previous_zero = false;
      if (remaining <= 1 || static_cast<int>(counts.size()) > max_symbol) break;
    }
    const int max = (2 * threshold - 1) - remaining;
    int count;
    const uint32_t low = br.peek_lenient(nbits - 1) & static_cast<uint32_t>(threshold - 1);
    if (static_cast<int>(low) < max) {
      count = static_cast<int>(br.read(nbits - 1));
    } else {
      count = static_cast<int>(br.read(nbits)) & (2 * threshold - 1);
      if (count >= threshold) count -= max;
    }
    --count;  // extra accuracy: -1 means "less than one"
    remaining -= count < 0 ? -count : count;
    counts.push_back(static_cast<int16_t>(count));
    previous_zero = (count == 0);
    while (remaining < threshold) {
      --nbits;
      threshold >>= 1;
    }
  }
  if (remaining != 1) fail("invalid FSE distribution");
  if (static_cast<int>(counts.size()) > max_symbol + 1) fail("FSE symbol range too large");
  return (br.bits_used() + 7) / 8;
}

FseTable build_fse(const std::vector<int16_t>& counts, int accuracy_log) {
  FseTable t;
  t.accuracy_log = accuracy_log;
  const int size = 1 << accuracy_log;
  t.entries.assign(static_cast<size_t>(size), FseEntry{0, 0, 0});
  std::vector<uint16_t> next(counts.size(), 0);
  int high = size - 1;
  for (size_t s = 0; s < counts.size(); ++s) {
    if (counts[s] == -1) {
      t.entries[static_cast<size_t>(high--)].symbol = static_cast<uint8_t>(s);
      next[s] = 1;
    } else {
      next[s] = static_cast<uint16_t>(counts[s]);
    }
  }
  const int step = (size >> 1) + (size >> 3) + 3;
  const int mask = size - 1;
  int position = 0;
  for (size_t s = 0; s < counts.size(); ++s) {
    for (int i = 0; i < counts[s]; ++i) {
      t.entries[static_cast<size_t>(position)].symbol = static_cast<uint8_t>(s);
      position = (position + step) & mask;
      while (position > high) position = (position + step) & mask;
    }
  }
  if (position != 0) fail("invalid FSE distribution");
  for (int u = 0; u < size; ++u) {
    FseEntry& e = t.entries[static_cast<size_t>(u)];
    const int ns = next[e.symbol]++;
    e.nbits = static_cast<uint8_t>(accuracy_log - high_bit(static_cast<uint32_t>(ns)));
    e.base = static_cast<uint16_t>((ns << e.nbits) - size);
  }
  t.valid = true;
  return t;
}

FseTable rle_table(uint8_t symbol) {
  FseTable t;
  t.accuracy_log = 0;
  t.entries.assign(1, FseEntry{0, symbol, 0});
  t.valid = true;
  return t;
}

// ------------------------------------------------------------- Huffman ----

struct HufTable {
  int max_bits = 0;
  std::vector<uint8_t> symbol;  // indexed by max_bits-wide prefix
  std::vector<uint8_t> nbits;
  bool valid = false;
};

HufTable build_huffman(const std::vector<uint8_t>& weights_in) {
  // weights_in holds weights of symbols 0..n-1; the last symbol's weight is implied.
  std::vector<uint8_t> w = weights_in;
  uint32_t total = 0;
  for (uint8_t x : w) {
    if (x > 12) fail("invalid Huffman weight");
    if (x) total += 1u << (x - 1);
  }
  if (total == 0) fail("empty Huffman tree");
  const int max_bits = high_bit(total) + 1;
  if (max_bits > 12) fail("Huffman tree too deep");
  const uint32_t rest = (1u << max_bits) - total;
  if (rest == 0 || (rest & (rest - 1))) fail("invalid Huffman tree");
  w.push_back(static_cast<uint8_t>(high_bit(rest) + 1));
  if (w.size() > 256) fail("too many Huffman symbols");

  HufTable t;
  t.max_bits = max_bits;
  t.symbol.assign(static_cast<size_t>(1) << max_bits, 0);
  t.nbits.assign(static_cast<size_t>(1) << max_bits, 0);
  uint32_t rank_start[14] = {0};
  uint32_t next = 0;
  for (int weight = 1; weight <= max_bits; ++weight) {
    rank_start[weight] = next;
    uint32_t count = 0;
    for (uint8_t x : w) count += (x == weight);
    next += count << (weight - 1);
  }
  for (size_t s = 0; s < w.size(); ++s) {
    const int weight = w[s];
    if (!weight) continue;
    const uint32_t len = 1u << (weight - 1);
    const uint32_t start = rank_start[weight];
    rank_start[weight] += len;
    for (uint32_t i = 0; i < len; ++i) {
      t.symbol[start + i] = static_cast<uint8_t>(s);
      t.nbits[start + i] = static_cast<uint8_t>(max_bits + 1 - weight);
    }
  }
  t.valid = true;
  return t;
}

// Reads a Huffman tree description at src; returns bytes consumed.
size_t read_huffman_tree(const uint8_t* src, size_t size, HufTable& table) {
  if (size < 1) fail("truncated Huffman tree");
  const int header = src[0];
  std::vector<uint8_t> weights;
  size_t used;
  if (header >= 128) {
    const size_t n = static_cast<size_t>(header - 127);
    used = 1 + (n + 1) / 2;
    if (used > size) fail("truncated Huffman tree");
    weights.resize(n);
    for (size_t i = 0; i < n; ++i) {
      const uint8_t b = src[1 + i / 2];
      weights[i] = (i % 2 == 0) ? (b >> 4) : (b & 15);
    }
  } else {
    used = 1 + static_cast<size_t>(header);
    if (header == 0 || used > size) fail("truncated Huffman tree");
    std::vector<int16_t> counts;
    int al = 0;
    const size_t desc = read_fse_counts(src + 1, used - 1, 255, 6, counts, al);
    if (desc > used - 1) fail("invalid Huffman weight table");
    const FseTable fse = build_fse(counts, al);
    BackwardBits bits(src + 1 + desc, used - 1 - desc);
    uint32_t s1 = bits.read(al), s2 = bits.read(al);
    if (bits.overflowed()) fail("truncated Huffman weights");
    for (;;) {
      if (weights.size() >= 255) fail("too many Huffman weights");
      weights.push_back(fse.entries[s1].symbol);
      {
        const FseEntry& e = fse.entries[s1];
        s1 = e.base + bits.read(e.nbits);
      }
      if (bits.overflowed()) {
        weights.push_back(fse.entries[s2].symbol);
        break;
      }
      if (weights.size() >= 255) fail("too many Huffman weights");
      weights.push_back(fse.entries[s2].symbol);
      {
        const FseEntry& e = fse.entries[s2];
        s2 = e.base + bits.read(e.nbits);
      }
      if (bits.overflowed()) {
        weights.push_back(fse.entries[s1].symbol);
        break;
      }
    }
  }
  if (weights.size() > 255) fail("too many Huffman weights");
  table = build_huffman(weights);
  return used;
}

void huffman_decode_stream(const HufTable& t, const uint8_t* src, size_t size, uint8_t* dst, size_t count) {
  BackwardBits bits(src, size);
  for (size_t i = 0; i < count; ++i) {
    const uint32_t idx = bits.peek(t.max_bits);
    dst[i] = t.symbol[idx];
    bits.consume(t.nbits[idx]);
    if (bits.overflowed()) fail("Huffman stream overrun");
  }
  if (bits.remaining() != 0) fail("Huffman stream not fully consumed");
}

// ----------------------------------------------------------- sequences ----

constexpr int16_t kLlDefault[36] = {4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2,
                                    2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1};
constexpr int16_t kMlDefault[53] = {1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
                                    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1};
constexpr int16_t kOfDefault[29] = {1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1,
                                    1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1};

constexpr uint32_t kLlBase[36] = {0,  1,  2,  3,  4,  5,  6,  7,  8,   9,   10,   11,   12,   13,    14,    15,    16,    18,
                                  20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512,  1024, 2048, 4096,  8192,  16384, 32768, 65536};
constexpr uint8_t kLlBits[36] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
                                 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
constexpr uint32_t kMlBase[53] = {3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14, 15, 16,  17,  18,   19,   20,
                                  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,  35,  37,   39,   41,
                                  43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539};
constexpr uint8_t kMlBits[53] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};

struct FrameState {
  HufTable huf;
  FseTable ll, of, ml;
  uint32_t rep[3] = {1, 4, 8};
};

FseTable read_sequence_table(int mode, const uint8_t*& p, const uint8_t* end, int max_symbol,
                             int max_accuracy, const int16_t* defaults, size_t default_count,
                             int default_accuracy, const FseTable& previous) {
  switch (mode) {
    case 0: {
      std::vector<int16_t> counts(defaults, defaults + default_count);
      return build_fse(counts, default_accuracy);
    }
    case 1: {
      if (p >= end) fail("truncated sequence table");
      const uint8_t symbol = *p++;
      if (symbol > max_symbol) fail("invalid RLE sequence symbol");
      return rle_table(symbol);
    }
    case 2: {
      std::vector<int16_t> counts;
      int al = 0;
      const size_t used = read_fse_counts(p, static_cast<size_t>(end - p), max_symbol, max_accuracy, counts, al);
      p += used;
      return build_fse(counts, al);
    }
    default:
      if (!previous.valid) fail("repeat sequence table without a previous table");
      return previous;
  }
}

void decode_literals(FrameState& st, const uint8_t*& p, const uint8_t* end, std::vector<uint8_t>& literals) {
  if (p >= end) fail("truncated literals section");
  const int type = p[0] & 3;
  const int size_format = (p[0] >> 2) & 3;
  literals.clear();
  if (type <= 1) {
    size_t header_len, regen;
    if (size_format == 0 || size_format == 2) {
      header_len = 1;
      regen = p[0] >> 3;
    } else if (size_format == 1) {
      if (end - p < 2) fail("truncated literals header");
      header_len = 2;
      regen = (static_cast<size_t>(p[0]) >> 4) | (static_cast<size_t>(p[1]) << 4);
    } else {
      if (end - p < 3) fail("truncated literals header");
      header_len = 3;
      regen = (static_cast<size_t>(p[0]) >> 4) | (static_cast<size_t>(p[1]) << 4) | (static_cast<size_t>(p[2]) << 12);
    }
    if (regen > kBlockMax) fail("literals section too large");
    p += header_len;
    if (type == 0) {
      if (static_cast<size_t>(end - p) < regen) fail("truncated raw literals");
      literals.assign(p, p + regen);
      p += regen;
    } else {
      if (p >= end) fail("truncated RLE literals");
      literals.assign(regen, *p);
      ++p;
    }
    return;
  }
  size_t header_len, regen, comp;
  int streams = 4;
  if (size_format <= 1) {
    if (end - p < 3) fail("truncated literals header");
    const uint32_t h = p[0] | (p[1] << 8) | (p[2] << 16);
    header_len = 3;
    regen = (h >> 4) & 0x3FF;
    comp = (h >> 14) & 0x3FF;
    streams = size_format == 0 ? 1 : 4;
  } else if (size_format == 2) {
    if (end - p < 4) fail("truncated literals header");
    const uint32_t h = p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24);
    header_len = 4;
    regen = (h >> 4) & 0x3FFF;
    comp = (h >> 18) & 0x3FFF;
  } else {
    if (end - p < 5) fail("truncated literals header");
    const uint64_t h = static_cast<uint64_t>(p[0]) | (static_cast<uint64_t>(p[1]) << 8) |
                       (static_cast<uint64_t>(p[2]) << 16) | (static_cast<uint64_t>(p[3]) << 24) |
                       (static_cast<uint64_t>(p[4]) << 32);
    header_len = 5;
    regen = static_cast<size_t>((h >> 4) & 0x3FFFF);
    comp = static_cast<size_t>((h >> 22) & 0x3FFFF);
  }
  if (regen > kBlockMax) fail("literals section too large");
  p += header_len;
  if (static_cast<size_t>(end - p) < comp) fail("truncated compressed literals");
  const uint8_t* data = p;
  size_t data_size = comp;
  if (type == 2) {
    const size_t tree = read_huffman_tree(data, data_size, st.huf);
    data += tree;
    data_size -= tree;
  } else if (!st.huf.valid) {
    fail("treeless literals without a previous Huffman table");
  }
  literals.resize(regen);
  if (streams == 1) {
    huffman_decode_stream(st.huf, data, data_size, literals.data(), regen);
  } else {
    if (data_size < 6) fail("truncated Huffman jump table");
    const size_t s1 = data[0] | (data[1] << 8), s2 = data[2] | (data[3] << 8), s3 = data[4] | (data[5] << 8);
    if (s1 + s2 + s3 + 6 > data_size) fail("invalid Huffman stream sizes");
    const size_t s4 = data_size - 6 - s1 - s2 - s3;
    const size_t seg = (regen + 3) / 4;
    if (seg * 3 > regen) fail("invalid literal stream sizes");
    const uint8_t* q = data + 6;
    huffman_decode_stream(st.huf, q, s1, literals.data(), seg);
    q += s1;
    huffman_decode_stream(st.huf, q, s2, literals.data() + seg, seg);
    q += s2;
    huffman_decode_stream(st.huf, q, s3, literals.data() + 2 * seg, seg);
    q += s3;
    huffman_decode_stream(st.huf, q, s4, literals.data() + 3 * seg, regen - 3 * seg);
  }
  p += comp;
}

void decode_compressed_block(FrameState& st, const uint8_t* src, size_t size, std::vector<uint8_t>& out,
                             size_t limit) {
  const uint8_t* p = src;
  const uint8_t* const end = src + size;
  std::vector<uint8_t> literals;
  decode_literals(st, p, end, literals);

  if (p >= end) fail("truncated sequences section");
  size_t nseq;
  if (p[0] < 128) {
    nseq = p[0];
    p += 1;
  } else if (p[0] < 255) {
    if (end - p < 2) fail("truncated sequences header");
    nseq = (static_cast<size_t>(p[0] - 128) << 8) + p[1];
    p += 2;
  } else {
    if (end - p < 3) fail("truncated sequences header");
    nseq = static_cast<size_t>(p[1]) + (static_cast<size_t>(p[2]) << 8) + 0x7F00;
    p += 3;
  }
  const size_t block_start = out.size();
  if (nseq == 0) {
    if (p != end) fail("unexpected data after literals-only block");
    if (out.size() + literals.size() > limit) fail("block exceeds the declared size");
    out.insert(out.end(), literals.begin(), literals.end());
    return;
  }
  if (p >= end) fail("truncated sequences section");
  const int modes = *p++;
  if (modes & 3) fail("reserved sequence mode bits set");
  FseTable ll = read_sequence_table((modes >> 6) & 3, p, end, 35, 9, kLlDefault, 36, 6, st.ll);
  FseTable of = read_sequence_table((modes >> 4) & 3, p, end, 31, 8, kOfDefault, 29, 5, st.of);
  FseTable ml = read_sequence_table((modes >> 2) & 3, p, end, 52, 9, kMlDefault, 53, 6, st.ml);
  if (ll.entries.empty() || of.entries.empty() || ml.entries.empty()) fail("empty sequence table");
  for (const FseEntry& e : ll.entries) if (e.symbol > 35) fail("invalid literal-length code");
  for (const FseEntry& e : ml.entries) if (e.symbol > 52) fail("invalid match-length code");
  for (const FseEntry& e : of.entries) if (e.symbol > 31) fail("invalid offset code");

  BackwardBits bits(p, static_cast<size_t>(end - p));
  uint32_t s_ll = bits.read(ll.accuracy_log);
  uint32_t s_of = bits.read(of.accuracy_log);
  uint32_t s_ml = bits.read(ml.accuracy_log);
  if (bits.overflowed()) fail("truncated sequence bitstream");

  size_t lit_pos = 0;
  for (size_t i = 0; i < nseq; ++i) {
    const FseEntry& e_of = of.entries[s_of];
    const FseEntry& e_ml = ml.entries[s_ml];
    const FseEntry& e_ll = ll.entries[s_ll];
    const int of_code = e_of.symbol;
    const uint32_t offset_value = (1u << of_code) + bits.read(of_code);
    const uint32_t match_len = kMlBase[e_ml.symbol] + bits.read(kMlBits[e_ml.symbol]);
    const uint32_t lit_len = kLlBase[e_ll.symbol] + bits.read(kLlBits[e_ll.symbol]);
    if (i + 1 < nseq) {
      s_ll = e_ll.base + bits.read(e_ll.nbits);
      s_ml = e_ml.base + bits.read(e_ml.nbits);
      s_of = e_of.base + bits.read(e_of.nbits);
    }
    if (bits.overflowed()) fail("sequence bitstream overrun");

    uint32_t offset;
    if (offset_value > 3) {
      offset = offset_value - 3;
      st.rep[2] = st.rep[1];
      st.rep[1] = st.rep[0];
      st.rep[0] = offset;
    } else {
      const int idx = static_cast<int>(offset_value) - 1 + (lit_len == 0 ? 1 : 0);
      if (idx == 0) {
        offset = st.rep[0];
      } else {
        offset = (idx == 3) ? st.rep[0] - 1 : st.rep[idx];
        if (offset == 0) fail("invalid zero offset");
        if (idx >= 2) st.rep[2] = st.rep[1];
        st.rep[1] = st.rep[0];
        st.rep[0] = offset;
      }
    }
    if (lit_len > literals.size() - lit_pos) fail("literal length exceeds literals section");
    if (out.size() + lit_len + match_len > limit) fail("block exceeds the declared size");
    out.insert(out.end(), literals.begin() + static_cast<long>(lit_pos),
               literals.begin() + static_cast<long>(lit_pos + lit_len));
    lit_pos += lit_len;
    if (offset > out.size()) fail("match offset beyond the start of the data");
    const size_t start = out.size();
    out.resize(start + match_len);
    uint8_t* d = out.data() + start;
    const uint8_t* s = d - offset;
    for (uint32_t k = 0; k < match_len; ++k) d[k] = s[k];
  }
  if (bits.remaining() != 0) fail("sequence bitstream not fully consumed");
  const size_t rest = literals.size() - lit_pos;
  if (out.size() + rest > limit) fail("block exceeds the declared size");
  out.insert(out.end(), literals.begin() + static_cast<long>(lit_pos), literals.end());
  if (out.size() - block_start > kBlockMax) fail("block larger than 128 KiB");
  st.ll = std::move(ll);
  st.of = std::move(of);
  st.ml = std::move(ml);
}

void decompress_frame(const uint8_t* src, size_t size, size_t expected, std::vector<uint8_t>& out) {
  if (size < 6 || read32(src) != 0xFD2FB528u) fail("not a zstd frame");
  size_t pos = 4;
  const uint8_t fhd = src[pos++];
  const int fcs_flag = fhd >> 6;
  const bool single_segment = (fhd >> 5) & 1;
  if (fhd & 0x08) fail("reserved zstd frame bit set");
  const bool has_checksum = (fhd >> 2) & 1;
  const int dict_flag = fhd & 3;
  if (!single_segment) {
    if (pos >= size) fail("truncated zstd frame header");
    ++pos;  // window descriptor: not needed, the whole output stays in memory
  }
  const size_t dict_bytes = dict_flag == 0 ? 0 : dict_flag == 1 ? 1 : dict_flag == 2 ? 2 : 4;
  if (pos + dict_bytes > size) fail("truncated zstd frame header");
  uint32_t dict_id = 0;
  for (size_t i = 0; i < dict_bytes; ++i) dict_id |= static_cast<uint32_t>(src[pos + i]) << (8 * i);
  if (dict_id != 0) fail("zstd dictionaries are not supported");
  pos += dict_bytes;
  size_t fcs_bytes = fcs_flag == 0 ? (single_segment ? 1 : 0) : fcs_flag == 1 ? 2 : fcs_flag == 2 ? 4 : 8;
  bool has_content_size = fcs_bytes != 0;
  uint64_t content_size = 0;
  if (pos + fcs_bytes > size) fail("truncated zstd frame header");
  for (size_t i = 0; i < fcs_bytes; ++i) content_size |= static_cast<uint64_t>(src[pos + i]) << (8 * i);
  if (fcs_flag == 1) content_size += 256;
  pos += fcs_bytes;
  if (has_content_size && content_size != expected) fail("zstd content size does not match the container");

  FrameState st;
  out.clear();
  out.reserve(std::min<size_t>(expected, 1u << 24));
  for (;;) {
    if (pos + 3 > size) fail("truncated zstd block header");
    const uint32_t bh = src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16);
    pos += 3;
    const bool last = bh & 1;
    const int type = (bh >> 1) & 3;
    const size_t bsize = bh >> 3;
    if (type == 3) fail("reserved zstd block type");
    if (type == 0) {
      if (bsize > kBlockMax || pos + bsize > size) fail("truncated zstd raw block");
      if (out.size() + bsize > expected) fail("zstd frame is larger than declared");
      out.insert(out.end(), src + pos, src + pos + bsize);
      pos += bsize;
    } else if (type == 1) {
      if (bsize > kBlockMax || pos + 1 > size) fail("truncated zstd RLE block");
      if (out.size() + bsize > expected) fail("zstd frame is larger than declared");
      out.insert(out.end(), bsize, src[pos]);
      pos += 1;
    } else {
      if (bsize > kBlockMax || pos + bsize > size) fail("truncated zstd compressed block");
      decode_compressed_block(st, src + pos, bsize, out, expected);
      pos += bsize;
    }
    if (last) break;
  }
  if (has_checksum) {
    if (pos + 4 > size) fail("truncated zstd checksum");
    const uint32_t stored = read32(src + pos);
    pos += 4;
    if (static_cast<uint32_t>(xxh64(out.data(), out.size())) != stored) fail("zstd checksum mismatch");
  }
  if (pos != size) fail("unexpected data after the zstd frame");
  if (out.size() != expected) fail("zstd frame is smaller than declared");
}

}  // namespace

bool decompress(const uint8_t* src, size_t size, size_t expected_size, std::vector<uint8_t>& out,
                std::string& error) {
  try {
    decompress_frame(src, size, expected_size, out);
    return true;
  } catch (const std::exception& e) {
    error = e.what();
    out.clear();
    return false;
  }
}

}  // namespace styk::zstd
