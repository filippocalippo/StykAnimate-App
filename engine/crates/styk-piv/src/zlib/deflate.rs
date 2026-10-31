//! `zlib.compress(data)`: zlib 1.3.1 at its default level, bit for bit.
//!
//! This is a port of zlib's `deflate_slow` (lazy matching with the level-6
//! parameters), its sliding window and hash chains, and `trees.c` (block
//! splitting every 16383 symbols, the stored/fixed/dynamic choice, Huffman tree
//! construction with zlib's tie-breaking and length limiting). Nothing here is
//! tuned differently: every decision zlib makes depends only on the input, and
//! an exported Pivot file must be the bytes the Python codec wrote.
//!
//! Names follow zlib's so the two can be read side by side.

use super::checksum::adler32;

const MIN_MATCH: usize = 3;
const MAX_MATCH: usize = 258;
const W_BITS: usize = 15;
const W_SIZE: usize = 1 << W_BITS;
const W_MASK: usize = W_SIZE - 1;
const WINDOW_SIZE: usize = 2 * W_SIZE;
const HASH_BITS: usize = 15;
const HASH_SIZE: usize = 1 << HASH_BITS;
const HASH_MASK: u32 = (HASH_SIZE - 1) as u32;
const HASH_SHIFT: u32 = HASH_BITS.div_ceil(MIN_MATCH) as u32;
const MIN_LOOKAHEAD: usize = MAX_MATCH + MIN_MATCH + 1;
const MAX_DIST: usize = W_SIZE - MIN_LOOKAHEAD;
const WIN_INIT: usize = MAX_MATCH;
/// Matches of length 3 are discarded if their distance exceeds this.
const TOO_FAR: usize = 4096;
/// A block ends after this many literals and matches (`lit_bufsize - 1`).
const BLOCK_SYMBOLS: usize = (1 << 14) - 1;

// Level 6.
const GOOD_MATCH: usize = 8;
const MAX_LAZY: usize = 16;
const NICE_MATCH: usize = 128;
const MAX_CHAIN: usize = 128;

const LENGTH_CODES: usize = 29;
const LITERALS: usize = 256;
const L_CODES: usize = LITERALS + 1 + LENGTH_CODES;
const D_CODES: usize = 30;
const BL_CODES: usize = 19;
const HEAP_SIZE: usize = 2 * L_CODES + 1;
const MAX_BITS: usize = 15;
const MAX_BL_BITS: usize = 7;
const END_BLOCK: usize = 256;
const REP_3_6: usize = 16;
const REPZ_3_10: usize = 17;
const REPZ_11_138: usize = 18;

const EXTRA_LBITS: [u8; LENGTH_CODES] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const EXTRA_DBITS: [u8; D_CODES] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const EXTRA_BLBITS: [u8; BL_CODES] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
const BL_ORDER: [usize; BL_CODES] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/// zlib's `ct_data`: two unions, frequency-or-code and parent-or-length.
#[derive(Clone, Copy, Default)]
struct Node {
    /// `Freq` while a tree is built, `Code` afterwards.
    fc: u16,
    /// `Dad` while a tree is built, `Len` afterwards.
    dl: u16,
}

/// The tables `tr_static_init` computes.
struct Static {
    ltree: [Node; L_CODES + 2],
    dtree: [Node; D_CODES],
    dist_code: [u8; 512],
    length_code: [u8; 256],
    base_length: [u16; LENGTH_CODES],
    base_dist: [u16; D_CODES],
}

fn bi_reverse(mut code: u32, mut len: u32) -> u32 {
    let mut res = 0;
    loop {
        res |= code & 1;
        code >>= 1;
        res <<= 1;
        len -= 1;
        if len == 0 {
            break;
        }
    }
    res >> 1
}

fn gen_codes(tree: &mut [Node], max_code: i32, bl_count: &[u16; MAX_BITS + 1]) {
    let mut next_code = [0u16; MAX_BITS + 1];
    let mut code: u32 = 0;
    for bits in 1..=MAX_BITS {
        code = (code + bl_count[bits - 1] as u32) << 1;
        next_code[bits] = code as u16;
    }
    for node in tree.iter_mut().take((max_code + 1) as usize) {
        let len = node.dl as usize;
        if len == 0 {
            continue;
        }
        node.fc = bi_reverse(next_code[len] as u32, len as u32) as u16;
        next_code[len] = next_code[len].wrapping_add(1);
    }
}

fn static_tables() -> &'static Static {
    static TABLES: std::sync::OnceLock<Static> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        let mut tables = Static {
            ltree: [Node::default(); L_CODES + 2],
            dtree: [Node::default(); D_CODES],
            dist_code: [0; 512],
            length_code: [0; 256],
            base_length: [0; LENGTH_CODES],
            base_dist: [0; D_CODES],
        };
        let mut length = 0usize;
        for (code, &extra) in EXTRA_LBITS.iter().enumerate().take(LENGTH_CODES - 1) {
            tables.base_length[code] = length as u16;
            for _ in 0..(1usize << extra) {
                tables.length_code[length] = code as u8;
                length += 1;
            }
        }
        // Length 258 gets its own code instead of code 284 with five extra bits.
        tables.length_code[length - 1] = (LENGTH_CODES - 1) as u8;
        let mut dist = 0usize;
        for (code, &extra) in EXTRA_DBITS.iter().enumerate().take(16) {
            tables.base_dist[code] = dist as u16;
            for _ in 0..(1usize << extra) {
                tables.dist_code[dist] = code as u8;
                dist += 1;
            }
        }
        dist >>= 7;
        for (code, &extra) in EXTRA_DBITS.iter().enumerate().take(D_CODES).skip(16) {
            tables.base_dist[code] = (dist << 7) as u16;
            for _ in 0..(1usize << (extra - 7)) {
                tables.dist_code[256 + dist] = code as u8;
                dist += 1;
            }
        }
        let mut bl_count = [0u16; MAX_BITS + 1];
        for (n, node) in tables.ltree.iter_mut().enumerate() {
            let len = match n {
                0..=143 => 8,
                144..=255 => 9,
                256..=279 => 7,
                _ => 8,
            };
            node.dl = len;
            bl_count[len as usize] += 1;
        }
        gen_codes(&mut tables.ltree, (L_CODES + 1) as i32, &bl_count);
        for (n, node) in tables.dtree.iter_mut().enumerate() {
            node.dl = 5;
            node.fc = bi_reverse(n as u32, 5) as u16;
        }
        tables
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Tree {
    Literal,
    Distance,
    BitLength,
}

struct Deflater<'a> {
    input: &'a [u8],
    next_in: usize,
    out: Vec<u8>,
    bi_buf: u64,
    bi_valid: u32,

    window: Vec<u8>,
    prev: Vec<u16>,
    head: Vec<u16>,
    ins_h: u32,
    block_start: isize,
    match_length: usize,
    prev_match: usize,
    match_available: bool,
    strstart: usize,
    match_start: usize,
    lookahead: usize,
    prev_length: usize,
    insert: usize,
    high_water: usize,

    dyn_ltree: [Node; HEAP_SIZE],
    dyn_dtree: [Node; 2 * D_CODES + 1],
    bl_tree: [Node; 2 * BL_CODES + 1],
    l_max_code: i32,
    d_max_code: i32,
    bl_count: [u16; MAX_BITS + 1],
    heap: [i32; HEAP_SIZE],
    heap_len: usize,
    heap_max: usize,
    depth: [u8; HEAP_SIZE],
    /// `(distance, length - 3)` for a match, `(0, byte)` for a literal.
    symbols: Vec<(u16, u8)>,
    opt_len: u64,
    static_len: u64,
    tables: &'static Static,
}

impl<'a> Deflater<'a> {
    fn new(input: &'a [u8]) -> Deflater<'a> {
        let mut deflater = Deflater {
            input,
            next_in: 0,
            out: Vec::with_capacity(input.len() / 2 + 64),
            bi_buf: 0,
            bi_valid: 0,
            window: vec![0; WINDOW_SIZE],
            prev: vec![0; W_SIZE],
            head: vec![0; HASH_SIZE],
            ins_h: 0,
            block_start: 0,
            match_length: MIN_MATCH - 1,
            prev_match: 0,
            match_available: false,
            strstart: 0,
            match_start: 0,
            lookahead: 0,
            prev_length: MIN_MATCH - 1,
            insert: 0,
            high_water: 0,
            dyn_ltree: [Node::default(); HEAP_SIZE],
            dyn_dtree: [Node::default(); 2 * D_CODES + 1],
            bl_tree: [Node::default(); 2 * BL_CODES + 1],
            l_max_code: 0,
            d_max_code: 0,
            bl_count: [0; MAX_BITS + 1],
            heap: [0; HEAP_SIZE],
            heap_len: 0,
            heap_max: 0,
            depth: [0; HEAP_SIZE],
            symbols: Vec::with_capacity(BLOCK_SYMBOLS + 1),
            opt_len: 0,
            static_len: 0,
            tables: static_tables(),
        };
        deflater.init_block();
        deflater
    }

    // ---- bit output -------------------------------------------------------

    #[inline(always)]
    fn send_bits(&mut self, value: u32, length: u32) {
        self.bi_buf |= (value as u64) << self.bi_valid;
        self.bi_valid += length;
        while self.bi_valid >= 8 {
            self.out.push(self.bi_buf as u8);
            self.bi_buf >>= 8;
            self.bi_valid -= 8;
        }
    }

    fn bi_windup(&mut self) {
        if self.bi_valid > 0 {
            self.out.push(self.bi_buf as u8);
        }
        self.bi_buf = 0;
        self.bi_valid = 0;
    }

    // ---- window and hash chains --------------------------------------------

    #[inline(always)]
    fn update_hash(&mut self, byte: u8) {
        self.ins_h = ((self.ins_h << HASH_SHIFT) ^ byte as u32) & HASH_MASK;
    }

    #[inline(always)]
    fn insert_string(&mut self, at: usize) -> usize {
        self.update_hash(self.window[at + MIN_MATCH - 1]);
        let hash = self.ins_h as usize;
        let hash_head = self.head[hash];
        self.prev[at & W_MASK] = hash_head;
        self.head[hash] = at as u16;
        hash_head as usize
    }

    fn slide_hash(&mut self) {
        for slot in self.head.iter_mut().chain(self.prev.iter_mut()) {
            *slot = if *slot as usize >= W_SIZE { *slot - W_SIZE as u16 } else { 0 };
        }
    }

    fn read_buf(&mut self, at: usize, size: usize) -> usize {
        let len = size.min(self.input.len() - self.next_in);
        self.window[at..at + len].copy_from_slice(&self.input[self.next_in..self.next_in + len]);
        self.next_in += len;
        len
    }

    fn fill_window(&mut self) {
        loop {
            let mut more = WINDOW_SIZE - self.lookahead - self.strstart;
            if self.strstart >= W_SIZE + MAX_DIST {
                self.window.copy_within(W_SIZE..W_SIZE + (W_SIZE - more), 0);
                self.match_start = self.match_start.wrapping_sub(W_SIZE);
                self.strstart -= W_SIZE;
                self.block_start -= W_SIZE as isize;
                if self.insert > self.strstart {
                    self.insert = self.strstart;
                }
                self.slide_hash();
                more += W_SIZE;
            }
            if self.next_in == self.input.len() {
                break;
            }
            let n = self.read_buf(self.strstart + self.lookahead, more);
            self.lookahead += n;
            if self.lookahead + self.insert >= MIN_MATCH {
                let mut at = self.strstart - self.insert;
                self.ins_h = self.window[at] as u32;
                self.update_hash(self.window[at + 1]);
                while self.insert != 0 {
                    self.update_hash(self.window[at + MIN_MATCH - 1]);
                    self.prev[at & W_MASK] = self.head[self.ins_h as usize];
                    self.head[self.ins_h as usize] = at as u16;
                    at += 1;
                    self.insert -= 1;
                    if self.lookahead + self.insert < MIN_MATCH {
                        break;
                    }
                }
            }
            if !(self.lookahead < MIN_LOOKAHEAD && self.next_in != self.input.len()) {
                break;
            }
        }
        // Zero the bytes after the data that `longest_match` may read.
        if self.high_water < WINDOW_SIZE {
            let curr = self.strstart + self.lookahead;
            if self.high_water < curr {
                let init = (WINDOW_SIZE - curr).min(WIN_INIT);
                self.window[curr..curr + init].fill(0);
                self.high_water = curr + init;
            } else if self.high_water < curr + WIN_INIT {
                let init = (curr + WIN_INIT - self.high_water).min(WINDOW_SIZE - self.high_water);
                self.window[self.high_water..self.high_water + init].fill(0);
                self.high_water += init;
            }
        }
    }

    fn longest_match(&mut self, mut cur_match: usize) -> usize {
        let mut chain_length = MAX_CHAIN;
        let scan = self.strstart;
        let mut best_len = self.prev_length;
        let mut nice_match = NICE_MATCH;
        let limit = self.strstart.saturating_sub(MAX_DIST);
        if self.prev_length >= GOOD_MATCH {
            chain_length >>= 2;
        }
        if nice_match > self.lookahead {
            nice_match = self.lookahead;
        }
        let window = &self.window[..];
        let mut scan_end1 = window[scan + best_len - 1];
        let mut scan_end = window[scan + best_len];
        loop {
            let candidate = cur_match;
            if window[candidate + best_len] == scan_end
                && window[candidate + best_len - 1] == scan_end1
                && window[candidate] == window[scan]
                && window[candidate + 1] == window[scan + 1]
            {
                // Bytes 0..=2 are equal (equal hash); compare from 3 up to the limit.
                let mut len = 3;
                while len < MAX_MATCH && window[scan + len] == window[candidate + len] {
                    len += 1;
                }
                if len > best_len {
                    self.match_start = cur_match;
                    best_len = len;
                    if len >= nice_match {
                        break;
                    }
                    scan_end1 = window[scan + best_len - 1];
                    scan_end = window[scan + best_len];
                }
            }
            cur_match = self.prev[cur_match & W_MASK] as usize;
            if cur_match <= limit {
                break;
            }
            chain_length -= 1;
            if chain_length == 0 {
                break;
            }
        }
        best_len.min(self.lookahead)
    }

    // ---- trees --------------------------------------------------------------

    fn init_block(&mut self) {
        for node in self.dyn_ltree.iter_mut().take(L_CODES) {
            node.fc = 0;
        }
        for node in self.dyn_dtree.iter_mut().take(D_CODES) {
            node.fc = 0;
        }
        for node in self.bl_tree.iter_mut().take(BL_CODES) {
            node.fc = 0;
        }
        self.dyn_ltree[END_BLOCK].fc = 1;
        self.opt_len = 0;
        self.static_len = 0;
        self.symbols.clear();
    }

    #[inline(always)]
    fn d_code(&self, dist: usize) -> usize {
        if dist < 256 { self.tables.dist_code[dist] as usize } else { self.tables.dist_code[256 + (dist >> 7)] as usize }
    }

    /// `_tr_tally_lit`: whether the block is full.
    #[inline(always)]
    fn tally_lit(&mut self, byte: u8) -> bool {
        self.symbols.push((0, byte));
        self.dyn_ltree[byte as usize].fc += 1;
        self.symbols.len() == BLOCK_SYMBOLS
    }

    /// `_tr_tally_dist`: `distance` is the match distance, `length` is the match length minus 3.
    #[inline(always)]
    fn tally_dist(&mut self, distance: usize, length: usize) -> bool {
        self.symbols.push((distance as u16, length as u8));
        let dist = distance - 1;
        self.dyn_ltree[self.tables.length_code[length] as usize + LITERALS + 1].fc += 1;
        let code = self.d_code(dist);
        self.dyn_dtree[code].fc += 1;
        self.symbols.len() == BLOCK_SYMBOLS
    }

    fn tree(&mut self, which: Tree) -> &mut [Node] {
        match which {
            Tree::Literal => &mut self.dyn_ltree,
            Tree::Distance => &mut self.dyn_dtree,
            Tree::BitLength => &mut self.bl_tree,
        }
    }

    fn smaller(&self, tree: &[Node], n: i32, m: i32) -> bool {
        let (n, m) = (n as usize, m as usize);
        tree[n].fc < tree[m].fc || (tree[n].fc == tree[m].fc && self.depth[n] <= self.depth[m])
    }

    fn pqdownheap(&mut self, which: Tree, mut k: usize) {
        let tree: &[Node] = match which {
            Tree::Literal => &self.dyn_ltree,
            Tree::Distance => &self.dyn_dtree,
            Tree::BitLength => &self.bl_tree,
        };
        let v = self.heap[k];
        let mut j = k << 1;
        while j <= self.heap_len {
            if j < self.heap_len && self.smaller(tree, self.heap[j + 1], self.heap[j]) {
                j += 1;
            }
            if self.smaller(tree, v, self.heap[j]) {
                break;
            }
            self.heap[k] = self.heap[j];
            k = j;
            j <<= 1;
        }
        self.heap[k] = v;
    }

    fn gen_bitlen(&mut self, which: Tree, max_code: i32) {
        let tables = self.tables;
        let (stree, extra, base, max_length): (Option<&[Node]>, &[u8], usize, usize) = match which {
            Tree::Literal => (Some(&tables.ltree), &EXTRA_LBITS, LITERALS + 1, MAX_BITS),
            Tree::Distance => (Some(&tables.dtree), &EXTRA_DBITS, 0, MAX_BITS),
            Tree::BitLength => (None, &EXTRA_BLBITS, 0, MAX_BL_BITS),
        };
        self.bl_count = [0; MAX_BITS + 1];
        let heap_max = self.heap_max;
        let root = self.heap[heap_max] as usize;
        self.tree(which)[root].dl = 0;
        let mut overflow = 0i32;
        let mut h = heap_max + 1;
        while h < HEAP_SIZE {
            let n = self.heap[h] as usize;
            let dad = self.tree(which)[n].dl as usize;
            let mut bits = self.tree(which)[dad].dl as usize + 1;
            if bits > max_length {
                bits = max_length;
                overflow += 1;
            }
            self.tree(which)[n].dl = bits as u16;
            h += 1;
            if n as i32 > max_code {
                continue;
            }
            self.bl_count[bits] += 1;
            let xbits = if n >= base { extra[n - base] as usize } else { 0 };
            let f = self.tree(which)[n].fc as u64;
            self.opt_len = self.opt_len.wrapping_add(f * (bits + xbits) as u64);
            if let Some(stree) = stree {
                self.static_len = self.static_len.wrapping_add(f * (stree[n].dl as usize + xbits) as u64);
            }
        }
        if overflow == 0 {
            return;
        }
        loop {
            let mut bits = max_length - 1;
            while self.bl_count[bits] == 0 {
                bits -= 1;
            }
            self.bl_count[bits] -= 1;
            self.bl_count[bits + 1] += 2;
            self.bl_count[max_length] -= 1;
            overflow -= 2;
            if overflow <= 0 {
                break;
            }
        }
        let mut h = HEAP_SIZE;
        for bits in (1..=max_length).rev() {
            let mut n = self.bl_count[bits];
            while n != 0 {
                h -= 1;
                let m = self.heap[h] as usize;
                if m as i32 > max_code {
                    continue;
                }
                let node = self.tree(which)[m];
                if node.dl as usize != bits {
                    let delta = (bits as u64).wrapping_sub(node.dl as u64).wrapping_mul(node.fc as u64);
                    self.opt_len = self.opt_len.wrapping_add(delta);
                    self.tree(which)[m].dl = bits as u16;
                }
                n -= 1;
            }
        }
    }

    /// `build_tree`: returns the largest code with a non-zero frequency.
    fn build_tree(&mut self, which: Tree) -> i32 {
        let tables = self.tables;
        let (stree, elems): (Option<&[Node]>, usize) = match which {
            Tree::Literal => (Some(&tables.ltree), L_CODES),
            Tree::Distance => (Some(&tables.dtree), D_CODES),
            Tree::BitLength => (None, BL_CODES),
        };
        let mut max_code: i32 = -1;
        self.heap_len = 0;
        self.heap_max = HEAP_SIZE;
        for n in 0..elems {
            if self.tree(which)[n].fc != 0 {
                self.heap_len += 1;
                self.heap[self.heap_len] = n as i32;
                max_code = n as i32;
                self.depth[n] = 0;
            } else {
                self.tree(which)[n].dl = 0;
            }
        }
        while self.heap_len < 2 {
            let node = if max_code < 2 {
                max_code += 1;
                max_code
            } else {
                0
            };
            self.heap_len += 1;
            self.heap[self.heap_len] = node;
            self.tree(which)[node as usize].fc = 1;
            self.depth[node as usize] = 0;
            self.opt_len = self.opt_len.wrapping_sub(1);
            if let Some(stree) = stree {
                self.static_len = self.static_len.wrapping_sub(stree[node as usize].dl as u64);
            }
        }
        for n in (1..=self.heap_len / 2).rev() {
            self.pqdownheap(which, n);
        }
        let mut node = elems;
        loop {
            // pqremove
            let n = self.heap[1] as usize;
            self.heap[1] = self.heap[self.heap_len];
            self.heap_len -= 1;
            self.pqdownheap(which, 1);
            let m = self.heap[1] as usize;

            self.heap_max -= 1;
            self.heap[self.heap_max] = n as i32;
            self.heap_max -= 1;
            self.heap[self.heap_max] = m as i32;

            let frequency = self.tree(which)[n].fc.wrapping_add(self.tree(which)[m].fc);
            self.tree(which)[node].fc = frequency;
            self.depth[node] = self.depth[n].max(self.depth[m]) + 1;
            self.tree(which)[n].dl = node as u16;
            self.tree(which)[m].dl = node as u16;
            self.heap[1] = node as i32;
            node += 1;
            self.pqdownheap(which, 1);
            if self.heap_len < 2 {
                break;
            }
        }
        self.heap_max -= 1;
        self.heap[self.heap_max] = self.heap[1];
        self.gen_bitlen(which, max_code);
        let bl_count = self.bl_count;
        gen_codes(self.tree(which), max_code, &bl_count);
        max_code
    }

    fn scan_tree(&mut self, which: Tree, max_code: i32) {
        let mut prevlen: i32 = -1;
        let mut nextlen = self.tree(which)[0].dl as i32;
        let mut count = 0;
        let (mut max_count, mut min_count) = if nextlen == 0 { (138, 3) } else { (7, 4) };
        self.tree(which)[(max_code + 1) as usize].dl = 0xffff;
        for n in 0..=max_code as usize {
            let curlen = nextlen;
            nextlen = self.tree(which)[n + 1].dl as i32;
            count += 1;
            if count < max_count && curlen == nextlen {
                continue;
            } else if count < min_count {
                self.bl_tree[curlen as usize].fc += count as u16;
            } else if curlen != 0 {
                if curlen != prevlen {
                    self.bl_tree[curlen as usize].fc += 1;
                }
                self.bl_tree[REP_3_6].fc += 1;
            } else if count <= 10 {
                self.bl_tree[REPZ_3_10].fc += 1;
            } else {
                self.bl_tree[REPZ_11_138].fc += 1;
            }
            count = 0;
            prevlen = curlen;
            (max_count, min_count) = if nextlen == 0 {
                (138, 3)
            } else if curlen == nextlen {
                (6, 3)
            } else {
                (7, 4)
            };
        }
    }

    #[inline(always)]
    fn send_code(&mut self, node: Node) {
        self.send_bits(node.fc as u32, node.dl as u32);
    }

    fn send_tree(&mut self, which: Tree, max_code: i32) {
        let mut prevlen: i32 = -1;
        let mut nextlen = self.tree(which)[0].dl as i32;
        let mut count: i32 = 0;
        let (mut max_count, mut min_count) = if nextlen == 0 { (138, 3) } else { (7, 4) };
        for n in 0..=max_code as usize {
            let curlen = nextlen;
            nextlen = self.tree(which)[n + 1].dl as i32;
            count += 1;
            if count < max_count && curlen == nextlen {
                continue;
            } else if count < min_count {
                let code = self.bl_tree[curlen as usize];
                for _ in 0..count {
                    self.send_code(code);
                }
            } else if curlen != 0 {
                if curlen != prevlen {
                    let code = self.bl_tree[curlen as usize];
                    self.send_code(code);
                    count -= 1;
                }
                let code = self.bl_tree[REP_3_6];
                self.send_code(code);
                self.send_bits((count - 3) as u32, 2);
            } else if count <= 10 {
                let code = self.bl_tree[REPZ_3_10];
                self.send_code(code);
                self.send_bits((count - 3) as u32, 3);
            } else {
                let code = self.bl_tree[REPZ_11_138];
                self.send_code(code);
                self.send_bits((count - 11) as u32, 7);
            }
            count = 0;
            prevlen = curlen;
            (max_count, min_count) = if nextlen == 0 {
                (138, 3)
            } else if curlen == nextlen {
                (6, 3)
            } else {
                (7, 4)
            };
        }
    }

    fn build_bl_tree(&mut self) -> usize {
        self.scan_tree(Tree::Literal, self.l_max_code);
        self.scan_tree(Tree::Distance, self.d_max_code);
        self.build_tree(Tree::BitLength);
        let mut max_blindex = BL_CODES - 1;
        while max_blindex >= 3 {
            if self.bl_tree[BL_ORDER[max_blindex]].dl != 0 {
                break;
            }
            max_blindex -= 1;
        }
        self.opt_len = self.opt_len.wrapping_add(3 * (max_blindex as u64 + 1) + 5 + 5 + 4);
        max_blindex
    }

    fn send_all_trees(&mut self, lcodes: usize, dcodes: usize, blcodes: usize) {
        self.send_bits((lcodes - 257) as u32, 5);
        self.send_bits((dcodes - 1) as u32, 5);
        self.send_bits((blcodes - 4) as u32, 4);
        for &rank in BL_ORDER.iter().take(blcodes) {
            self.send_bits(self.bl_tree[rank].dl as u32, 3);
        }
        self.send_tree(Tree::Literal, lcodes as i32 - 1);
        self.send_tree(Tree::Distance, dcodes as i32 - 1);
    }

    fn compress_block(&mut self, fixed: bool) {
        let tables = self.tables;
        let symbols = std::mem::take(&mut self.symbols);
        for &(distance, lc) in &symbols {
            if distance == 0 {
                let code = if fixed { tables.ltree[lc as usize] } else { self.dyn_ltree[lc as usize] };
                self.send_code(code);
                continue;
            }
            let code = tables.length_code[lc as usize] as usize;
            let node = if fixed { tables.ltree[code + LITERALS + 1] } else { self.dyn_ltree[code + LITERALS + 1] };
            self.send_code(node);
            let extra = EXTRA_LBITS[code] as u32;
            if extra != 0 {
                self.send_bits(lc as u32 - tables.base_length[code] as u32, extra);
            }
            let dist = distance as usize - 1;
            let code = self.d_code(dist);
            let node = if fixed { tables.dtree[code] } else { self.dyn_dtree[code] };
            self.send_code(node);
            let extra = EXTRA_DBITS[code] as u32;
            if extra != 0 {
                self.send_bits((dist - tables.base_dist[code] as usize) as u32, extra);
            }
        }
        let end = if fixed { tables.ltree[END_BLOCK] } else { self.dyn_ltree[END_BLOCK] };
        self.send_code(end);
        self.symbols = symbols;
    }

    /// `_tr_flush_block` over the window bytes since `block_start`.
    fn flush_block(&mut self, last: bool) {
        let stored_len = (self.strstart as isize - self.block_start) as usize;
        // The block's bytes are still in the window unless it slid past them.
        let buf = (self.block_start >= 0).then_some(self.block_start as usize);
        self.l_max_code = self.build_tree(Tree::Literal);
        self.d_max_code = self.build_tree(Tree::Distance);
        let max_blindex = self.build_bl_tree();
        let mut opt_lenb = self.opt_len.wrapping_add(3 + 7) >> 3;
        let static_lenb = self.static_len.wrapping_add(3 + 7) >> 3;
        if static_lenb <= opt_lenb {
            opt_lenb = static_lenb;
        }
        match buf {
            Some(start) if stored_len as u64 + 4 <= opt_lenb => {
                self.send_bits(last as u32, 3);
                self.bi_windup();
                self.out.extend_from_slice(&(stored_len as u16).to_le_bytes());
                self.out.extend_from_slice(&(!(stored_len as u16)).to_le_bytes());
                self.out.extend_from_slice(&self.window[start..start + stored_len]);
            }
            _ if static_lenb == opt_lenb => {
                self.send_bits((1 << 1) + last as u32, 3);
                self.compress_block(true);
            }
            _ => {
                self.send_bits((2 << 1) + last as u32, 3);
                self.send_all_trees((self.l_max_code + 1) as usize, (self.d_max_code + 1) as usize, max_blindex + 1);
                self.compress_block(false);
            }
        }
        self.init_block();
        if last {
            self.bi_windup();
        }
        self.block_start = self.strstart as isize;
    }

    // ---- deflate_slow --------------------------------------------------------

    fn run(&mut self) {
        loop {
            if self.lookahead < MIN_LOOKAHEAD {
                self.fill_window();
                if self.lookahead == 0 {
                    break;
                }
            }
            let mut hash_head = 0;
            if self.lookahead >= MIN_MATCH {
                hash_head = self.insert_string(self.strstart);
            }
            self.prev_length = self.match_length;
            self.prev_match = self.match_start;
            self.match_length = MIN_MATCH - 1;
            if hash_head != 0 && self.prev_length < MAX_LAZY && self.strstart - hash_head <= MAX_DIST {
                self.match_length = self.longest_match(hash_head);
                if self.match_length <= 5 && self.match_length == MIN_MATCH && self.strstart.wrapping_sub(self.match_start) > TOO_FAR {
                    self.match_length = MIN_MATCH - 1;
                }
            }
            if self.prev_length >= MIN_MATCH && self.match_length <= self.prev_length {
                let max_insert = self.strstart + self.lookahead - MIN_MATCH;
                let flush = self.tally_dist(self.strstart - 1 - self.prev_match, self.prev_length - MIN_MATCH);
                self.lookahead -= self.prev_length - 1;
                self.prev_length -= 2;
                loop {
                    self.strstart += 1;
                    if self.strstart <= max_insert {
                        self.insert_string(self.strstart);
                    }
                    self.prev_length -= 1;
                    if self.prev_length == 0 {
                        break;
                    }
                }
                self.match_available = false;
                self.match_length = MIN_MATCH - 1;
                self.strstart += 1;
                if flush {
                    self.flush_block(false);
                }
            } else if self.match_available {
                let flush = self.tally_lit(self.window[self.strstart - 1]);
                if flush {
                    self.flush_block(false);
                }
                self.strstart += 1;
                self.lookahead -= 1;
            } else {
                self.match_available = true;
                self.strstart += 1;
                self.lookahead -= 1;
            }
        }
        if self.match_available {
            self.tally_lit(self.window[self.strstart - 1]);
            self.match_available = false;
        }
        self.flush_block(true);
    }
}

/// The bytes of `zlib.compress(data)`.
pub(crate) fn compress(data: &[u8]) -> Vec<u8> {
    let mut deflater = Deflater::new(data);
    // Header: deflate, 32K window, default level, no dictionary.
    deflater.out.extend_from_slice(&[0x78, 0x9c]);
    deflater.run();
    let mut out = std::mem::take(&mut deflater.out);
    out.extend_from_slice(&adler32(1, data).to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::super::inflate::{StreamEnd, inflate};
    use super::*;

    #[test]
    fn known_streams_match_zlib() {
        // `zlib.compress(x).hex()` in CPython 3.12 with zlib 1.3.1.
        assert_eq!(compress(b""), [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
        assert_eq!(compress(b"a"), [0x78, 0x9c, 0x4b, 0x04, 0x00, 0x00, 0x62, 0x00, 0x62]);
        assert_eq!(compress(b"hello hello hello hello"), [0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0xc8, 0x40, 0x27, 0x01, 0x68, 0x03, 0x08, 0xb1]);
    }

    #[test]
    fn output_round_trips_through_the_inflater() {
        let mut data = Vec::new();
        let mut state = 12345u32;
        for i in 0..300_000u32 {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            data.push(if i % 7 < 4 { (state >> 24) as u8 } else { (i % 251) as u8 });
        }
        let packed = compress(&data);
        let unpacked = inflate(&packed, data.len() + 1).unwrap();
        assert_eq!(unpacked.end, StreamEnd::Complete { consumed: packed.len() });
        assert_eq!(unpacked.data, data);
    }
}
