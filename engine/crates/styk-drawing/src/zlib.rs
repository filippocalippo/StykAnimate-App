//! Synchronous zlib for drawing tiles (`zlib-sync.mjs`): `deflate` writes the same bytes
//! as the JavaScript (greedy LZ77 over a 32 KiB window with chain-limited hash lookups
//! and one dynamic-Huffman block with length-limited codes), so published tiles are
//! byte-identical whichever engine encodes them; `inflate` reads stored, fixed and dynamic
//! blocks, checks Adler-32 and never grows past its limit.

use crate::error::{fail, Result};

const LENGTH_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

fn reverse(mut code: u32, bits: u32) -> u32 {
    let mut r = 0;
    for _ in 0..bits {
        r = (r << 1) | (code & 1);
        code >>= 1;
    }
    r
}

fn length_symbol(length: usize) -> usize {
    if length >= 258 {
        return 28;
    }
    let mut s = 0;
    while s + 1 < 29 && LENGTH_BASE[s + 1] as usize <= length {
        s += 1;
    }
    s
}

fn dist_symbol(d: u32) -> usize {
    let (mut lo, mut hi) = (0usize, 29usize);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if DIST_BASE[mid] as u32 <= d {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

/// Adler-32.
pub fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in bytes.chunks(5552) {
        for &v in chunk {
            a += v as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

/// Huffman code lengths for `freq`, limited to `limit` bits; at least two symbols get
/// codes. Halving the weights until the tree fits, as the JavaScript does.
fn code_lengths(freq: &[u32], limit: u8) -> Vec<u8> {
    let n = freq.len();
    let mut lengths = vec![0u8; n];
    let mut weights: Vec<u32> = freq.to_vec();
    let mut used = weights.iter().filter(|&&w| w != 0).count();
    let mut s = 0;
    while used < 2 && s < n {
        if weights[s] == 0 {
            weights[s] = 1;
            used += 1;
        }
        s += 1;
    }
    loop {
        let mut leaves: Vec<usize> = (0..n).filter(|&s| weights[s] != 0).collect();
        leaves.sort_by(|&a, &b| weights[a].cmp(&weights[b]).then(a.cmp(&b)));
        let count = leaves.len();
        let mut parent = vec![0i32; 2 * count];
        let mut weight = vec![0f64; 2 * count];
        for i in 0..count {
            weight[i] = weights[leaves[i]] as f64;
        }
        let (mut li, mut ii, mut next) = (0usize, count, count);
        while next + 1 < 2 * count {
            let mut take = |weight: &Vec<f64>, next: usize| {
                if li < count && (ii >= next || weight[li] <= weight[ii]) {
                    li += 1;
                    li - 1
                } else {
                    ii += 1;
                    ii - 1
                }
            };
            let a = take(&weight, next);
            let b = take(&weight, next);
            weight[next] = weight[a] + weight[b];
            parent[a] = next as i32;
            parent[b] = next as i32;
            next += 1;
        }
        let mut depth = vec![0u8; 2 * count];
        let mut max = 0u8;
        if count >= 2 {
            for i in (0..=2 * count - 3).rev() {
                depth[i] = depth[parent[i] as usize] + 1;
            }
        }
        for i in 0..count {
            lengths[leaves[i]] = depth[i];
            max = max.max(depth[i]);
        }
        if max <= limit {
            return lengths;
        }
        lengths.iter_mut().for_each(|l| *l = 0);
        for w in weights.iter_mut() {
            if *w != 0 {
                *w = (*w >> 1).max(1);
            }
        }
    }
}

/// Canonical codes for lengths, bit-reversed for an LSB-first writer.
fn canonical(lengths: &[u8]) -> Vec<u16> {
    let mut counts = [0u16; 16];
    let mut next = [0u16; 16];
    let mut codes = vec![0u16; lengths.len()];
    for &l in lengths {
        if l != 0 {
            counts[l as usize] += 1;
        }
    }
    let mut code = 0u32;
    for l in 1..16 {
        code = (code + counts[l - 1] as u32) << 1;
        next[l] = code as u16;
    }
    for (s, &l) in lengths.iter().enumerate() {
        if l != 0 {
            codes[s] = reverse(next[l as usize] as u32, l as u32) as u16;
            next[l as usize] = next[l as usize].wrapping_add(1);
        }
    }
    codes
}

struct BitWriter {
    buf: Vec<u8>,
    bits: u32,
    count: u32,
}

impl BitWriter {
    fn put(&mut self, value: u32, bits: u32) {
        self.bits |= value << self.count;
        self.count += bits;
        while self.count >= 8 {
            self.buf.push((self.bits & 255) as u8);
            self.bits >>= 8;
            self.count -= 8;
        }
    }
}

/// `deflateZlib(input)`: a zlib stream, byte for byte as the JavaScript writes it.
pub fn deflate(input: &[u8]) -> Vec<u8> {
    let n = input.len();
    let mut lit_len: Vec<u16> = Vec::with_capacity(n / 2 + 1);
    let mut dists: Vec<u16> = Vec::with_capacity(n / 2 + 1);
    let mut lit_freq = [0u32; 286];
    let mut dist_freq = [0u32; 30];
    const HASH: usize = 1 << 15;
    const MASK: u32 = HASH as u32 - 1;
    let mut head = vec![-1i32; HASH];
    let mut prev = vec![0i32; n.max(1)];
    let hash = |i: usize| (((input[i] as u32) << 10) ^ ((input[i + 1] as u32) << 5) ^ input[i + 2] as u32) & MASK;
    let mut i = 0usize;
    while i < n {
        // Longest match at i within the window (chain-limited).
        let (mut best, mut best_dist) = (0usize, 0u32);
        if i + 2 < n {
            let h = hash(i);
            let mut candidate = head[h as usize];
            let mut chain = 24;
            let max = if n - i < 258 { n - i } else { 258 };
            while candidate >= 0 && i - candidate as usize <= 32768 && chain > 0 {
                chain -= 1;
                let c = candidate as usize;
                if input[c + best] == input[i + best] && input[c] == input[i] {
                    let mut l = 1;
                    while l < max && input[c + l] == input[i + l] {
                        l += 1;
                    }
                    if l > best {
                        best = l;
                        best_dist = (i - c) as u32;
                        if l >= max || l >= 128 {
                            break;
                        }
                    }
                }
                candidate = prev[c];
            }
        }
        if i + 2 < n {
            let h = hash(i);
            prev[i] = head[h as usize];
            head[h as usize] = i as i32;
        }
        if best >= 3 {
            lit_len.push((256 + best) as u16);
            dists.push(best_dist as u16);
            lit_freq[257 + length_symbol(best)] += 1;
            dist_freq[dist_symbol(best_dist)] += 1;
            // Index the start of long matches only.
            let stop = (i + best).min(i + 16);
            for k in i + 1..stop {
                if k + 2 < n {
                    let h = hash(k);
                    prev[k] = head[h as usize];
                    head[h as usize] = k as i32;
                }
            }
            i += best;
        } else {
            lit_len.push(input[i] as u16);
            dists.push(0);
            lit_freq[input[i] as usize] += 1;
            i += 1;
        }
    }
    lit_freq[256] = 1;
    let l_len = code_lengths(&lit_freq, 15);
    let d_len = code_lengths(&dist_freq, 15);
    let l_code = canonical(&l_len);
    let d_code = canonical(&d_len);
    let mut hlit = 286;
    while hlit > 257 && l_len[hlit - 1] == 0 {
        hlit -= 1;
    }
    let mut hdist = 30;
    while hdist > 1 && d_len[hdist - 1] == 0 {
        hdist -= 1;
    }
    let all: Vec<u8> = l_len[..hlit].iter().chain(d_len[..hdist].iter()).copied().collect();
    let mut rle: Vec<(usize, u32)> = Vec::new();
    let mut cl_freq = [0u32; 19];
    let mut i = 0;
    while i < all.len() {
        let v = all[i];
        let mut run = 1;
        while i + run < all.len() && all[i + run] == v {
            run += 1;
        }
        if v == 0 && run >= 3 {
            let r = run.min(138);
            if r >= 11 {
                rle.push((18, (r - 11) as u32));
                cl_freq[18] += 1;
            } else {
                rle.push((17, (r - 3) as u32));
                cl_freq[17] += 1;
            }
            i += r;
            continue;
        }
        rle.push((v as usize, 0));
        cl_freq[v as usize] += 1;
        i += 1;
        run -= 1;
        while run >= 3 {
            let r = run.min(6);
            rle.push((16, (r - 3) as u32));
            cl_freq[16] += 1;
            i += r;
            run -= r;
        }
    }
    let c_len = code_lengths(&cl_freq, 7);
    let c_code = canonical(&c_len);
    let mut hclen = 19;
    while hclen > 4 && c_len[CL_ORDER[hclen - 1]] == 0 {
        hclen -= 1;
    }
    let mut w = BitWriter { buf: Vec::with_capacity((n >> 1) + 1024), bits: 0, count: 0 };
    w.buf.push(0x78);
    w.buf.push(0x01);
    w.put(1, 1);
    w.put(2, 2);
    w.put((hlit - 257) as u32, 5);
    w.put((hdist - 1) as u32, 5);
    w.put((hclen - 4) as u32, 4);
    for &k in &CL_ORDER[..hclen] {
        w.put(c_len[k] as u32, 3);
    }
    for &(sym, extra) in &rle {
        w.put(c_code[sym] as u32, c_len[sym] as u32);
        match sym {
            16 => w.put(extra, 2),
            17 => w.put(extra, 3),
            18 => w.put(extra, 7),
            _ => {}
        }
    }
    for t in 0..lit_len.len() {
        let v = lit_len[t] as usize;
        if v < 256 {
            w.put(l_code[v] as u32, l_len[v] as u32);
            continue;
        }
        let len = v - 256;
        let s = length_symbol(len);
        w.put(l_code[257 + s] as u32, l_len[257 + s] as u32);
        if LENGTH_EXTRA[s] != 0 {
            w.put((len - LENGTH_BASE[s] as usize) as u32, LENGTH_EXTRA[s] as u32);
        }
        let dist = dists[t] as u32;
        let d = dist_symbol(dist);
        w.put(d_code[d] as u32, d_len[d] as u32);
        if DIST_EXTRA[d] != 0 {
            w.put(dist - DIST_BASE[d] as u32, DIST_EXTRA[d] as u32);
        }
    }
    w.put(l_code[256] as u32, l_len[256] as u32);
    if w.count > 0 {
        let pad = 8 - w.count;
        w.put(0, pad);
    }
    let sum = adler32(input);
    w.buf.extend_from_slice(&sum.to_be_bytes());
    w.buf
}

const FAST: u32 = 9;

struct Huffman {
    counts: [u16; 16],
    symbols: Vec<u16>,
    fast: Vec<i32>,
}

fn huffman(lengths: &[u8]) -> Result<Huffman> {
    let mut counts = [0u16; 16];
    let mut offsets = [0u16; 16];
    let mut symbols = vec![0u16; lengths.len()];
    for &l in lengths {
        counts[l as usize] += 1;
    }
    counts[0] = 0;
    let mut left: i32 = 1;
    for &count in counts.iter().skip(1) {
        left <<= 1;
        left -= count as i32;
        if left < 0 {
            return fail("errors.zlibSync.invalidDeflateHuffmanTable");
        }
    }
    for l in 1..15 {
        offsets[l + 1] = offsets[l] + counts[l];
    }
    for (s, &l) in lengths.iter().enumerate() {
        if l != 0 {
            symbols[offsets[l as usize] as usize] = s as u16;
            offsets[l as usize] += 1;
        }
    }
    let mut fast = vec![-1i32; 1 << FAST];
    let mut next = [0u32; 16];
    let mut code = 0u32;
    for l in 1..16 {
        code = (code + counts[l - 1] as u32) << 1;
        next[l] = code;
    }
    for (s, &l) in lengths.iter().enumerate() {
        if l == 0 {
            continue;
        }
        let c = next[l as usize];
        next[l as usize] += 1;
        if l as u32 > FAST {
            continue;
        }
        let mut j = reverse(c, l as u32);
        while j < 1 << FAST {
            fast[j as usize] = ((s as i32) << 4) | l as i32;
            j += 1 << l;
        }
    }
    Ok(Huffman { counts, symbols, fast })
}

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bits: u32,
    count: u32,
}

impl BitReader<'_> {
    fn need(&mut self, n: u32) -> Result<()> {
        while self.count < n {
            if self.pos >= self.data.len() {
                return fail("errors.zlibSync.truncatedDeflateStream");
            }
            self.bits |= (self.data[self.pos] as u32) << self.count;
            self.pos += 1;
            self.count += 8;
        }
        Ok(())
    }
    fn bits(&mut self, n: u32) -> Result<u32> {
        if n == 0 {
            return Ok(0);
        }
        self.need(n)?;
        let v = self.bits & ((1u32 << n) - 1);
        self.bits = if n == 32 { 0 } else { self.bits >> n };
        self.count -= n;
        Ok(v)
    }
    fn fill(&mut self) {
        while self.count <= 24 {
            let byte = if self.pos < self.data.len() { self.data[self.pos] } else { 0 };
            self.bits |= (byte as u32) << self.count;
            self.pos += 1;
            self.count += 8;
        }
    }
    fn decode(&mut self, table: &Huffman) -> Result<u16> {
        if self.count < FAST {
            self.fill();
        }
        let hit = table.fast[(self.bits & ((1 << FAST) - 1)) as usize];
        if hit >= 0 {
            let l = (hit & 15) as u32;
            self.bits >>= l;
            self.count -= l;
            if self.pos as i64 - (self.count >> 3) as i64 > self.data.len() as i64 {
                return fail("errors.zlibSync.truncatedDeflateStream");
            }
            return Ok((hit >> 4) as u16);
        }
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for l in 1..16 {
            code |= self.bits(1)? as i32;
            let count = table.counts[l] as i32;
            if code - count < first {
                return Ok(table.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        fail("errors.zlibSync.invalidDeflateCode")
    }
    /// Hands whole prefetched bytes back before byte-aligned reads.
    fn align(&mut self) {
        self.pos -= (self.count >> 3) as usize;
        self.bits = 0;
        self.count = 0;
    }
}

/// `inflateZlib(data, {expected, limit})`.
pub fn inflate(data: &[u8], expected: Option<usize>, limit: usize) -> Result<Vec<u8>> {
    if data.len() < 6 || (data[0] & 15) != 8 || (((data[0] as u32) << 8) | data[1] as u32) % 31 != 0 || data[1] & 32 != 0 {
        return fail("errors.zlibSync.invalidZlibHeader");
    }
    let mut out: Vec<u8> = Vec::with_capacity(expected.unwrap_or_else(|| limit.min(1024.max(data.len() * 4))));
    let cap = |out: &Vec<u8>, n: usize| -> Result<()> {
        let len = out.len();
        match expected {
            Some(e) if len + n > e => fail("errors.zlibSync.deflateStreamExpandsBeyondItsBound"),
            None if len + n > limit => fail("errors.zlibSync.deflateStreamExpandsBeyondItsBound"),
            _ => Ok(()),
        }
    };
    let mut r = BitReader { data, pos: 2, bits: 0, count: 0 };
    let fixed_lit = huffman(&(0..288).map(|v| if v < 144 { 8 } else if v < 256 { 9 } else if v < 280 { 7 } else { 8 }).collect::<Vec<u8>>())?;
    let fixed_dist = huffman(&[5u8; 30])?;
    loop {
        let last = r.bits(1)?;
        let kind = r.bits(2)?;
        if kind == 0 {
            r.align();
            if r.pos + 4 > data.len() {
                return fail("errors.zlibSync.truncatedStoredBlock");
            }
            let n = data[r.pos] as usize | (data[r.pos + 1] as usize) << 8;
            let nn = data[r.pos + 2] as usize | (data[r.pos + 3] as usize) << 8;
            r.pos += 4;
            if (n ^ 0xffff) != nn {
                return fail("errors.zlibSync.invalidStoredBlockLength");
            }
            if r.pos + n > data.len() {
                return fail("errors.zlibSync.truncatedStoredBlock");
            }
            cap(&out, n)?;
            out.extend_from_slice(&data[r.pos..r.pos + n]);
            r.pos += n;
        } else {
            let dynamic;
            let (lit, dist) = match kind {
                1 => (&fixed_lit, &fixed_dist),
                2 => {
                    let hlit = r.bits(5)? as usize + 257;
                    let hdist = r.bits(5)? as usize + 1;
                    let hclen = r.bits(4)? as usize + 4;
                    let mut cl = [0u8; 19];
                    for &k in &CL_ORDER[..hclen] {
                        cl[k] = r.bits(3)? as u8;
                    }
                    let cl_table = huffman(&cl)?;
                    let mut lengths: Vec<u8> = Vec::new();
                    while lengths.len() < hlit + hdist {
                        let sym = r.decode(&cl_table)?;
                        if sym < 16 {
                            lengths.push(sym as u8);
                        } else if sym == 16 {
                            let Some(&v) = lengths.last() else { return fail("errors.zlibSync.invalidDeflateRepeat") };
                            let count = 3 + r.bits(2)?;
                            for _ in 0..count {
                                lengths.push(v);
                            }
                        } else {
                            let count = if sym == 17 { 3 + r.bits(3)? } else { 11 + r.bits(7)? };
                            for _ in 0..count {
                                lengths.push(0);
                            }
                        }
                    }
                    if lengths.len() > hlit + hdist {
                        return fail("errors.zlibSync.invalidDeflateCodeLengths");
                    }
                    dynamic = (huffman(&lengths[..hlit])?, huffman(&lengths[hlit..])?);
                    (&dynamic.0, &dynamic.1)
                }
                _ => return fail("errors.zlibSync.invalidDeflateBlockType"),
            };
            loop {
                let sym = r.decode(lit)? as usize;
                if sym < 256 {
                    cap(&out, 1)?;
                    out.push(sym as u8);
                    continue;
                }
                if sym == 256 {
                    break;
                }
                let s = sym - 257;
                if s >= 29 {
                    return fail("errors.zlibSync.invalidDeflateLength");
                }
                let length = LENGTH_BASE[s] as usize + r.bits(LENGTH_EXTRA[s] as u32)? as usize;
                let d = r.decode(dist)? as usize;
                if d >= 30 {
                    return fail("errors.zlibSync.invalidDeflateDistance");
                }
                let distance = DIST_BASE[d] as usize + r.bits(DIST_EXTRA[d] as u32)? as usize;
                if distance > out.len() {
                    return fail("errors.zlibSync.deflateDistanceExceedsOutput");
                }
                cap(&out, length)?;
                let start = out.len() - distance;
                for k in 0..length {
                    let v = out[start + k];
                    out.push(v);
                }
            }
        }
        if last == 1 {
            break;
        }
    }
    r.align();
    if r.pos + 4 > data.len() {
        return fail("errors.zlibSync.missingZlibChecksum");
    }
    let sum = u32::from_be_bytes([data[r.pos], data[r.pos + 1], data[r.pos + 2], data[r.pos + 3]]);
    if adler32(&out) != sum {
        return fail("errors.zlibSync.zlibChecksumMismatch");
    }
    if expected.is_some_and(|e| out.len() != e) {
        return fail("errors.zlibSync.deflateStreamSizeMismatch");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deflate_round_trips() {
        let mut data = Vec::new();
        for i in 0..20000u32 {
            data.push(((i * 7) % 13) as u8);
            if i % 100 < 30 {
                data.push(0);
            }
        }
        let packed = deflate(&data);
        assert_eq!(inflate(&packed, Some(data.len()), usize::MAX).unwrap(), data);
        assert_eq!(inflate(&deflate(&[]), None, 1 << 20).unwrap(), Vec::<u8>::new());
        assert_eq!(inflate(&deflate(&[5]), None, 1 << 20).unwrap(), vec![5]);
    }
}
