//! A zlib-stream inflater that fails exactly where and how zlib's `inflate` fails.
//!
//! The decoder is a conventional table-driven one. What is copied from zlib is
//! the *order of checks* and the texts: a caller that feeds this the same bytes
//! Python fed `zlib.decompressobj().decompress(data, limit)` gets the same
//! output, the same "stream ended / input ended / output limit reached"
//! outcome, or the same `zlib.error` message.

use super::checksum::adler32;

/// How decoding stopped.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StreamEnd {
    /// The stream is complete (`decompressobj.eof`); it used `consumed` input
    /// bytes, and anything after them is Python's `unused_data`.
    Complete { consumed: usize },
    /// The input ended before the stream did.
    Truncated,
    /// The output reached the limit and the stream had more to give
    /// (Python's non-empty `unconsumed_tail`).
    Limit,
}

/// The inflated bytes and how decoding stopped.
#[derive(Debug)]
pub(crate) struct Inflated {
    pub data: Vec<u8>,
    pub end: StreamEnd,
}

#[derive(Clone, Copy)]
struct Entry {
    /// Bits this level of the code uses.
    bits: u8,
    /// 0 literal, `LENGTH | extra`, `END`, `BAD`, or `LINK | index bits`.
    op: u8,
    val: u16,
}

const LENGTH: u8 = 16;
const END: u8 = 32;
const BAD: u8 = 64;
const LINK: u8 = 128;
/// What zlib leaves in the unfilled slot of an incomplete code: an invalid entry one bit long.
const INVALID: Entry = Entry { bits: 1, op: BAD, val: 0 };

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// The code-length code of a dynamic block header.
    Codes,
    /// Literals and lengths.
    Lens,
    Dists,
}

const LENGTH_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/// The order code-length code lengths are stored in.
const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

#[derive(Default)]
struct Table {
    entries: Vec<Entry>,
    root: u32,
    /// Scratch: per root prefix, how many index bits its subtable needs.
    sub_bits: Vec<u8>,
}

fn reverse(code: u32, len: u32) -> u32 {
    code.reverse_bits() >> (32 - len)
}

impl Table {
    /// Builds the decoding table for `lens`. `false` when zlib's `inflate_table`
    /// rejects the set: over-subscribed, or incomplete unless it is a single
    /// one-bit literal/length or distance code.
    fn build(&mut self, kind: Kind, lens: &[u8], root_max: u32) -> bool {
        let mut count = [0u32; 16];
        for &len in lens {
            count[len as usize] += 1;
        }
        let Some(max) = (1..=15u32).rev().find(|&len| count[len as usize] != 0) else {
            // No symbols at all: zlib builds a table that fails on first use.
            self.entries.clear();
            self.entries.extend([INVALID, INVALID]);
            self.root = 1;
            return true;
        };
        let min = (1..=max).find(|&len| count[len as usize] != 0).unwrap_or(max);
        let mut left: i32 = 1;
        for &lengths in &count[1..=15] {
            left <<= 1;
            left -= lengths as i32;
            if left < 0 {
                return false;
            }
        }
        if left > 0 && (kind == Kind::Codes || max != 1) {
            return false;
        }
        let root = root_max.min(max).max(min);
        self.root = root;
        let mut next = [0u32; 16];
        let mut code = 0u32;
        for len in 1..=15 {
            code = (code + if len == 1 { 0 } else { count[len - 1] }) << 1;
            next[len] = code;
        }
        let root_size = 1usize << root;
        self.entries.clear();
        self.entries.resize(root_size, INVALID);
        if max > root {
            // Size each subtable by the longest code that starts with its prefix.
            self.sub_bits.clear();
            self.sub_bits.resize(root_size, 0);
            let mut probe = next;
            for &len in lens.iter() {
                let len = len as u32;
                if len == 0 {
                    continue;
                }
                let code = probe[len as usize];
                probe[len as usize] += 1;
                if len > root {
                    let prefix = (reverse(code, len) & (root_size as u32 - 1)) as usize;
                    self.sub_bits[prefix] = self.sub_bits[prefix].max((len - root) as u8);
                }
            }
            for prefix in 0..root_size {
                let bits = self.sub_bits[prefix];
                if bits != 0 {
                    let offset = self.entries.len();
                    self.entries.resize(offset + (1usize << bits), INVALID);
                    self.entries[prefix] = Entry { bits: root as u8, op: LINK | bits, val: offset as u16 };
                }
            }
        }
        for (symbol, &len) in lens.iter().enumerate() {
            let len = len as u32;
            if len == 0 {
                continue;
            }
            let code = next[len as usize];
            next[len as usize] += 1;
            let reversed = reverse(code, len) as usize;
            let (op, val) = match kind {
                Kind::Codes => (0, symbol as u16),
                Kind::Lens => match symbol {
                    0..=255 => (0, symbol as u16),
                    256 => (END, 0),
                    257..=285 => (LENGTH | LENGTH_EXTRA[symbol - 257], LENGTH_BASE[symbol - 257]),
                    _ => (BAD, 0),
                },
                Kind::Dists => match symbol {
                    0..=29 => (LENGTH | DIST_EXTRA[symbol], DIST_BASE[symbol]),
                    _ => (BAD, 0),
                },
            };
            if len <= root {
                let entry = Entry { bits: len as u8, op, val };
                let mut at = reversed;
                while at < root_size {
                    self.entries[at] = entry;
                    at += 1 << len;
                }
            } else {
                let link = self.entries[reversed & (root_size - 1)];
                let size = 1usize << (link.op & !LINK);
                let entry = Entry { bits: (len - root) as u8, op, val };
                let mut at = reversed >> root;
                while at < size {
                    self.entries[link.val as usize + at] = entry;
                    at += 1 << (len - root);
                }
            }
        }
        true
    }

    /// The entry the next bits select and the bits its code uses, or `None`
    /// when fewer than that are available.
    #[inline(always)]
    fn lookup(&self, hold: u64, available: u32) -> Option<(Entry, u32)> {
        let entry = self.entries[(hold & ((1u64 << self.root) - 1)) as usize];
        if entry.op & LINK != 0 {
            let index = (hold >> self.root) & ((1u64 << (entry.op & !LINK)) - 1);
            let entry = self.entries[entry.val as usize + index as usize];
            let used = self.root + entry.bits as u32;
            return (used <= available).then_some((entry, used));
        }
        (entry.bits as u32 <= available).then_some((entry, entry.bits as u32))
    }
}

struct Bits<'a> {
    input: &'a [u8],
    /// Next byte to load.
    pos: usize,
    hold: u64,
    /// Valid bits in `hold`.
    n: u32,
}

impl Bits<'_> {
    #[inline(always)]
    fn refill(&mut self) {
        if self.pos + 8 <= self.input.len() {
            let mut word = [0u8; 8];
            word.copy_from_slice(&self.input[self.pos..self.pos + 8]);
            // Bits above `n` are the upcoming bytes: loading them again later is harmless.
            self.hold |= u64::from_le_bytes(word) << self.n;
            self.pos += ((63 - self.n) >> 3) as usize;
            self.n |= 56;
        } else {
            while self.n <= 56 && self.pos < self.input.len() {
                self.hold |= (self.input[self.pos] as u64) << self.n;
                self.pos += 1;
                self.n += 8;
            }
        }
    }

    #[inline(always)]
    fn drop(&mut self, count: u32) {
        self.hold >>= count;
        self.n -= count;
    }

    #[inline(always)]
    fn peek(&self, count: u32) -> u32 {
        (self.hold & ((1u64 << count) - 1)) as u32
    }

    /// Makes `count` bits available, or reports that the input ended.
    #[inline(always)]
    fn need(&mut self, count: u32) -> bool {
        if self.n < count {
            self.refill();
        }
        self.n >= count
    }

    /// Discards the bits up to the next byte boundary and returns the index of
    /// the next unread byte, leaving the bit buffer empty.
    fn align(&mut self) -> usize {
        self.drop(self.n & 7);
        let at = self.pos - (self.n >> 3) as usize;
        self.pos = at;
        self.hold = 0;
        self.n = 0;
        at
    }
}

fn data_error(message: &str) -> String {
    format!("Error -3 while decompressing data: {message}")
}

fn fixed_tables() -> (Table, Table) {
    let mut lens = [0u8; 288];
    for (symbol, len) in lens.iter_mut().enumerate() {
        *len = match symbol {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    let (mut lit, mut dist) = (Table::default(), Table::default());
    lit.build(Kind::Lens, &lens, 9);
    dist.build(Kind::Dists, &[5u8; 32], 5);
    (lit, dist)
}

/// The longest match a length code stands for.
const LONGEST_MATCH: usize = 258;

/// Decodes symbols from `bits` into `out` for as long as every one is a literal or a match that is plainly good and both the input
/// and the room under `limit` are far enough from their ends that neither can matter, and stops at the first symbol that is anything
/// else (the end of the block, a code that stands for nothing, a distance too far back, the edge of the input or of the limit) before
/// taking it. What it leaves is exactly what decoding the same symbols one at a time leaves, so the symbol it stopped at is decoded by
/// the careful loop, which is where every error and every edge case is decided.
fn fast_symbols(bits: &mut Bits, out: &mut Vec<u8>, lit: &Table, dist: &Table, limit: usize) {
    let input = bits.input;
    let (mut hold, mut n, mut pos) = (bits.hold, bits.n, bits.pos);
    let (lit_root, dist_root) = (lit.root, dist.root);
    let (lit_mask, dist_mask) = ((1u64 << lit_root) - 1, (1u64 << dist_root) - 1);
    loop {
        // A refill reads eight bytes; a symbol of either kind takes at most 48 bits of the 56 it leaves.
        if pos + 8 > input.len() || out.len() + LONGEST_MATCH > limit {
            break;
        }
        if out.capacity() - out.len() < LONGEST_MATCH {
            out.reserve(LONGEST_MATCH.max(out.len()));
        }
        hold |= u64::from_le_bytes(input[pos..pos + 8].try_into().unwrap()) << n;
        pos += ((63 - n) >> 3) as usize;
        n |= 56;
        let mut entry = lit.entries[(hold & lit_mask) as usize];
        let mut used = entry.bits as u32;
        if entry.op & LINK != 0 {
            entry = lit.entries[entry.val as usize + ((hold >> lit_root) & ((1u64 << (entry.op & !LINK)) - 1)) as usize];
            used = lit_root + entry.bits as u32;
        }
        if entry.op == 0 {
            hold >>= used;
            n -= used;
            out.push(entry.val as u8);
            continue;
        }
        if entry.op & (END | BAD) != 0 {
            break;
        }
        let mut length = entry.val as usize;
        let mut rest = hold >> used;
        let extra = (entry.op & 15) as u32;
        length += (rest & ((1u64 << extra) - 1)) as usize;
        rest >>= extra;
        let mut d = dist.entries[(rest & dist_mask) as usize];
        let mut dist_used = d.bits as u32;
        if d.op & LINK != 0 {
            d = dist.entries[d.val as usize + ((rest >> dist_root) & ((1u64 << (d.op & !LINK)) - 1)) as usize];
            dist_used = dist_root + d.bits as u32;
        }
        if d.op & BAD != 0 {
            break;
        }
        rest >>= dist_used;
        let dist_extra = (d.op & 15) as u32;
        let distance = d.val as usize + (rest & ((1u64 << dist_extra) - 1)) as usize;
        rest >>= dist_extra;
        if distance > out.len() {
            break;
        }
        n -= used + extra + dist_used + dist_extra;
        hold = rest;
        let start = out.len() - distance;
        if distance >= length {
            out.extend_from_within(start..start + length);
        } else if distance == 1 {
            let byte = out[start];
            out.resize(out.len() + length, byte);
        } else {
            for offset in 0..length {
                let byte = out[start + offset];
                out.push(byte);
            }
        }
    }
    (bits.hold, bits.n, bits.pos) = (hold, n, pos);
}

/// Inflates a zlib stream, producing at most `limit` bytes.
///
/// `Err` carries the text of the `zlib.error` Python raises for the same input.
pub(crate) fn inflate(input: &[u8], limit: usize) -> Result<Inflated, String> {
    inflate_with(input, limit, true)
}

/// [`inflate`], with or without the fast path through the plain symbols (the tests compare the two).
fn inflate_with(input: &[u8], limit: usize, fast: bool) -> Result<Inflated, String> {
    let mut out: Vec<u8> = Vec::with_capacity(limit.min((input.len().saturating_mul(3)).max(1024)));
    let truncated = |data: Vec<u8>| Ok(Inflated { data, end: StreamEnd::Truncated });
    if input.len() < 2 {
        return truncated(out);
    }
    let (cmf, flg) = (input[0] as u32, input[1] as u32);
    if ((cmf << 8) | flg) % 31 != 0 {
        return Err(data_error("incorrect header check"));
    }
    if cmf & 15 != 8 {
        return Err(data_error("unknown compression method"));
    }
    if (cmf >> 4) + 8 > 15 {
        return Err(data_error("invalid window size"));
    }
    if flg & 0x20 != 0 {
        // A preset dictionary: zlib asks for one once its four-byte identifier arrived.
        if input.len() < 6 {
            return truncated(out);
        }
        return Err("Error 2 while decompressing data".to_string());
    }
    let mut bits = Bits { input, pos: 2, hold: 0, n: 0 };
    let (mut lit, mut dist) = (Table::default(), Table::default());
    let mut codes = Table::default();
    let mut fixed: Option<(Table, Table)> = None;
    let mut lens = [0u8; 320];
    loop {
        if !bits.need(3) {
            return truncated(out);
        }
        let last = bits.peek(1) != 0;
        let block = bits.peek(3) >> 1;
        bits.drop(3);
        match block {
            0 => {
                let at = bits.align();
                if input.len() - at < 4 {
                    return truncated(out);
                }
                let len = u16::from_le_bytes([input[at], input[at + 1]]);
                let complement = u16::from_le_bytes([input[at + 2], input[at + 3]]);
                if len != !complement {
                    return Err(data_error("invalid stored block lengths"));
                }
                let (start, len) = (at + 4, len as usize);
                let available = len.min(input.len() - start);
                let room = limit - out.len();
                if available > room {
                    out.extend_from_slice(&input[start..start + room]);
                    return Ok(Inflated { data: out, end: StreamEnd::Limit });
                }
                out.extend_from_slice(&input[start..start + available]);
                bits.pos = start + available;
                if available < len {
                    return truncated(out);
                }
            }
            3 => return Err(data_error("invalid block type")),
            _ => {
                let (lit_table, dist_table) = if block == 1 {
                    let tables = fixed.get_or_insert_with(fixed_tables);
                    (&tables.0, &tables.1)
                } else {
                    if !bits.need(14) {
                        return truncated(out);
                    }
                    let nlen = bits.peek(5) as usize + 257;
                    bits.drop(5);
                    let ndist = bits.peek(5) as usize + 1;
                    bits.drop(5);
                    let ncode = bits.peek(4) as usize + 4;
                    bits.drop(4);
                    if nlen > 286 || ndist > 30 {
                        return Err(data_error("too many length or distance symbols"));
                    }
                    let mut code_lens = [0u8; 19];
                    for &symbol in ORDER.iter().take(ncode) {
                        if !bits.need(3) {
                            return truncated(out);
                        }
                        code_lens[symbol] = bits.peek(3) as u8;
                        bits.drop(3);
                    }
                    if !codes.build(Kind::Codes, &code_lens, 7) {
                        return Err(data_error("invalid code lengths set"));
                    }
                    let total = nlen + ndist;
                    let mut have = 0;
                    while have < total {
                        bits.refill();
                        let Some((entry, used)) = codes.lookup(bits.hold, bits.n) else {
                            return truncated(out);
                        };
                        if entry.val < 16 {
                            bits.drop(used);
                            lens[have] = entry.val as u8;
                            have += 1;
                            continue;
                        }
                        let (extra, base) = match entry.val {
                            16 => (2, 3),
                            17 => (3, 3),
                            _ => (7, 11),
                        };
                        if bits.n < used + extra {
                            return truncated(out);
                        }
                        bits.drop(used);
                        let value = if entry.val == 16 {
                            if have == 0 {
                                return Err(data_error("invalid bit length repeat"));
                            }
                            lens[have - 1]
                        } else {
                            0
                        };
                        let copy = base + bits.peek(extra) as usize;
                        bits.drop(extra);
                        if have + copy > total {
                            return Err(data_error("invalid bit length repeat"));
                        }
                        lens[have..have + copy].fill(value);
                        have += copy;
                    }
                    if lens[256] == 0 {
                        return Err(data_error("invalid code -- missing end-of-block"));
                    }
                    if !lit.build(Kind::Lens, &lens[..nlen], 10) {
                        return Err(data_error("invalid literal/lengths set"));
                    }
                    if !dist.build(Kind::Dists, &lens[nlen..total], 8) {
                        return Err(data_error("invalid distances set"));
                    }
                    (&lit, &dist)
                };
                loop {
                    if fast {
                        fast_symbols(&mut bits, &mut out, lit_table, dist_table, limit);
                    }
                    bits.refill();
                    let Some((entry, used)) = lit_table.lookup(bits.hold, bits.n) else {
                        return truncated(out);
                    };
                    if entry.op == 0 {
                        if out.len() >= limit {
                            return Ok(Inflated { data: out, end: StreamEnd::Limit });
                        }
                        bits.drop(used);
                        out.push(entry.val as u8);
                        continue;
                    }
                    bits.drop(used);
                    if entry.op & END != 0 {
                        break;
                    }
                    if entry.op & BAD != 0 {
                        return Err(data_error("invalid literal/length code"));
                    }
                    let mut length = entry.val as usize;
                    let extra = (entry.op & 15) as u32;
                    if extra != 0 {
                        if bits.n < extra {
                            return truncated(out);
                        }
                        length += bits.peek(extra) as usize;
                        bits.drop(extra);
                    }
                    if bits.n < 32 {
                        bits.refill();
                    }
                    let Some((entry, used)) = dist_table.lookup(bits.hold, bits.n) else {
                        return truncated(out);
                    };
                    bits.drop(used);
                    if entry.op & BAD != 0 {
                        return Err(data_error("invalid distance code"));
                    }
                    let mut distance = entry.val as usize;
                    let extra = (entry.op & 15) as u32;
                    if extra != 0 {
                        if bits.n < extra {
                            return truncated(out);
                        }
                        distance += bits.peek(extra) as usize;
                        bits.drop(extra);
                    }
                    if out.len() >= limit {
                        return Ok(Inflated { data: out, end: StreamEnd::Limit });
                    }
                    if distance > out.len() {
                        return Err(data_error("invalid distance too far back"));
                    }
                    if length > limit - out.len() {
                        return Ok(Inflated { data: out, end: StreamEnd::Limit });
                    }
                    let start = out.len() - distance;
                    if distance >= length {
                        out.extend_from_within(start..start + length);
                    } else {
                        out.reserve(length);
                        for offset in 0..length {
                            let byte = out[start + offset];
                            out.push(byte);
                        }
                    }
                }
            }
        }
        if last {
            break;
        }
    }
    let at = bits.align();
    if input.len() - at < 4 {
        return truncated(out);
    }
    let stored = u32::from_be_bytes([input[at], input[at + 1], input[at + 2], input[at + 3]]);
    if stored != adler32(1, &out) {
        return Err(data_error("incorrect data check"));
    }
    Ok(Inflated { data: out, end: StreamEnd::Complete { consumed: at + 4 } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zlib::compress;

    struct Random(u64);

    impl Random {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 24
        }
    }

    /// What a read of a stream comes to, as something comparable.
    fn outcome(input: &[u8], limit: usize, fast: bool) -> Result<(Vec<u8>, StreamEnd), String> {
        inflate_with(input, limit, fast).map(|inflated| (inflated.data, inflated.end))
    }

    /// Data of the kinds files hold: poses (repeating doubles), runs, text, and noise.
    fn samples() -> Vec<Vec<u8>> {
        let mut random = Random(7);
        let poses: Vec<u8> = (0..60_000u32).flat_map(|i| (((i % 97) as f64) * 0.125 + (i / 4000) as f64).to_le_bytes()).collect();
        let runs: Vec<u8> = (0..50_000u32).map(|i| if (i / 300) % 2 == 0 { 0 } else { (i / 300) as u8 }).collect();
        let text: Vec<u8> = "the quick brown fox jumps over the lazy dog; ".repeat(2000).into_bytes();
        let noise: Vec<u8> = (0..30_000).map(|_| random.next() as u8).collect();
        let mixed: Vec<u8> = [&poses[..20_000], &noise[..5000], &runs[..9000], &text[..7000], &noise[5000..9000], &poses[20_000..]].concat();
        vec![Vec::new(), vec![7], poses, runs, text, noise, mixed]
    }

    #[test]
    fn the_fast_path_reads_every_stream_as_the_careful_loop_reads_it() {
        let mut random = Random(99);
        let mut compared = 0usize;
        for data in samples() {
            let stream = compress(&data);
            assert_eq!(outcome(&stream, usize::MAX, true), outcome(&stream, usize::MAX, false), "a good stream");
            assert_eq!(outcome(&stream, usize::MAX, true).unwrap().0, data);
            // Limits that cut the output at, before and after the end, and streams cut short or damaged anywhere.
            for limit in [0, 1, 257, 258, 259, 1000, data.len().saturating_sub(1), data.len(), data.len() + 1] {
                assert_eq!(outcome(&stream, limit, true), outcome(&stream, limit, false), "limit {limit}");
                compared += 1;
            }
            for _ in 0..60 {
                let cut = random.next() as usize % (stream.len() + 1);
                assert_eq!(outcome(&stream[..cut], usize::MAX, true), outcome(&stream[..cut], usize::MAX, false), "cut at {cut} of {}", stream.len());
                let mut damaged = stream.clone();
                for _ in 0..1 + random.next() % 3 {
                    let at = random.next() as usize % damaged.len();
                    damaged[at] ^= 1 << (random.next() % 8);
                }
                assert_eq!(outcome(&damaged, usize::MAX, true), outcome(&damaged, usize::MAX, false), "damaged");
                compared += 2;
            }
        }
        assert!(compared > 700);
    }

    #[test]
    fn a_distance_past_the_start_is_the_careful_loops_error() {
        // A fixed-Huffman block whose first symbol is a match at distance 1 with nothing before it.
        let stream = [0x78, 0x9c, 0x03, 0x02, 0x00, 0x00, 0x00, 0xff, 0xff];
        assert_eq!(outcome(&stream, usize::MAX, true), outcome(&stream, usize::MAX, false));
    }
}
