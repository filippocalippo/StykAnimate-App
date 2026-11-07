//! CFF (`CFF `) outlines, a line-for-line port of opentype.js's `parseCFFTable` and its Type 2 charstring interpreter.
//!
//! The interpreter keeps JavaScript's behaviour on malformed input where it shows in the numbers: `stack.shift()` and
//! `stack.pop()` on an empty stack give `undefined`, which is `NaN` in arithmetic, and a byte read past the end of a
//! charstring is `undefined` as well. `endchar` does not stop interpretation. Subroutine nesting deeper than
//! [`MAX_SUBR_DEPTH`] is an error (opentype.js overflows its stack).

use std::collections::{HashMap, VecDeque};

use super::path::PathCmd;
use super::reader::{Data, Parser, R};
use super::FontError;

const MAX_SUBR_DEPTH: usize = 64;

pub(crate) struct Cff {
    glyphs: Vec<Vec<u8>>,
    gsubrs: Vec<Vec<u8>>,
    gsubrs_bias: f64,
    /// Local subroutines and the widths of the font's private dictionary (a CID font has one set per FD).
    private: Vec<Private>,
    /// Glyph index → index into `private`; every glyph is 0 in a font that is not CID-keyed.
    fd_select: Option<Vec<u8>>,
}

#[derive(Default)]
struct Private {
    subrs: Vec<Vec<u8>>,
    subrs_bias: f64,
    default_width_x: f64,
    nominal_width_x: f64,
}

impl Cff {
    pub fn glyph_count(&self) -> usize {
        self.glyphs.len()
    }

    /// The path of a glyph in font units and the advance its charstring declares (`glyph.advanceWidth = width`).
    pub fn charstring(&self, gid: usize) -> R<(Vec<PathCmd>, f64)> {
        let code = self.glyphs.get(gid).ok_or(FontError::GlyphOutOfRange(gid))?;
        let private = match &self.fd_select {
            Some(select) => {
                let fd = *select.get(gid).ok_or(FontError::Invalid("glyph without a font dict"))? as usize;
                self.private.get(fd).ok_or(FontError::Invalid("glyph without a font dict"))?
            }
            None => &self.private[0],
        };
        let mut run = Run {
            cff: self,
            private,
            path: Vec::new(),
            stack: VecDeque::new(),
            n_stems: 0,
            have_width: false,
            open: false,
            x: 0.0,
            y: 0.0,
            width: private.default_width_x,
        };
        run.parse(code, 0)?;
        Ok((run.path, run.width))
    }
}

struct Run<'a> {
    cff: &'a Cff,
    private: &'a Private,
    path: Vec<PathCmd>,
    stack: VecDeque<f64>,
    n_stems: i64,
    have_width: bool,
    open: bool,
    x: f64,
    y: f64,
    width: f64,
}

/// `JS array[index]` with a computed index: only an integer inside the array finds an element.
fn subr_at(subrs: &[Vec<u8>], index: f64) -> Option<&Vec<u8>> {
    if index >= 0.0 && index.fract() == 0.0 && index < subrs.len() as f64 {
        subrs.get(index as usize)
    } else {
        None
    }
}

impl Run<'_> {
    fn shift(&mut self) -> f64 {
        self.stack.pop_front().unwrap_or(f64::NAN)
    }
    fn pop(&mut self) -> f64 {
        self.stack.pop_back().unwrap_or(f64::NAN)
    }
    fn new_contour(&mut self, x: f64, y: f64) {
        if self.open {
            self.path.push(PathCmd::Z);
        }
        self.path.push(PathCmd::M(x, y));
        self.open = true;
    }
    fn parse_stems(&mut self) {
        let has_width_arg = self.stack.len() % 2 != 0;
        if has_width_arg && !self.have_width {
            self.width = self.shift() + self.private.nominal_width_x;
        }
        self.n_stems += (self.stack.len() >> 1) as i64;
        self.stack.clear();
        self.have_width = true;
    }
    fn curve(&mut self, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64) {
        self.path.push(PathCmd::C(c1x, c1y, c2x, c2y, x, y));
    }

    fn parse(&mut self, code: &[u8], depth: usize) -> R<()> {
        if depth > MAX_SUBR_DEPTH {
            return Err(FontError::Invalid("charstring subroutines nest too deeply"));
        }
        let at = |i: usize| code.get(i).copied();
        // `b << 24` and friends: an `undefined` byte is 0 in a bit operation, NaN in arithmetic.
        let bits = |i: usize| code.get(i).copied().unwrap_or(0) as i32;
        let mut i = 0usize;
        while i < code.len() {
            let v = code[i];
            i += 1;
            match v {
                1 | 3 | 18 | 23 => self.parse_stems(),
                4 => {
                    if self.stack.len() > 1 && !self.have_width {
                        self.width = self.shift() + self.private.nominal_width_x;
                        self.have_width = true;
                    }
                    self.y += self.pop();
                    let (x, y) = (self.x, self.y);
                    self.new_contour(x, y);
                }
                5 => {
                    while !self.stack.is_empty() {
                        self.x += self.shift();
                        self.y += self.shift();
                        self.path.push(PathCmd::L(self.x, self.y));
                    }
                }
                6 => {
                    while !self.stack.is_empty() {
                        self.x += self.shift();
                        self.path.push(PathCmd::L(self.x, self.y));
                        if self.stack.is_empty() {
                            break;
                        }
                        self.y += self.shift();
                        self.path.push(PathCmd::L(self.x, self.y));
                    }
                }
                7 => {
                    while !self.stack.is_empty() {
                        self.y += self.shift();
                        self.path.push(PathCmd::L(self.x, self.y));
                        if self.stack.is_empty() {
                            break;
                        }
                        self.x += self.shift();
                        self.path.push(PathCmd::L(self.x, self.y));
                    }
                }
                8 => {
                    while !self.stack.is_empty() {
                        let c1x = self.x + self.shift();
                        let c1y = self.y + self.shift();
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.x = c2x + self.shift();
                        self.y = c2y + self.shift();
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                    }
                }
                10 => {
                    let private = self.private;
                    let index = self.pop() + private.subrs_bias;
                    if let Some(subr) = subr_at(&private.subrs, index) {
                        self.parse(subr, depth + 1)?;
                    }
                }
                11 => return Ok(()),
                12 => {
                    let op = at(i);
                    i += 1;
                    match op {
                        Some(35) => {
                            let c1x = self.x + self.shift();
                            let c1y = self.y + self.shift();
                            let c2x = c1x + self.shift();
                            let c2y = c1y + self.shift();
                            let jpx = c2x + self.shift();
                            let jpy = c2y + self.shift();
                            let c3x = jpx + self.shift();
                            let c3y = jpy + self.shift();
                            let c4x = c3x + self.shift();
                            let c4y = c3y + self.shift();
                            self.x = c4x + self.shift();
                            self.y = c4y + self.shift();
                            self.shift();
                            self.curve(c1x, c1y, c2x, c2y, jpx, jpy);
                            self.curve(c3x, c3y, c4x, c4y, self.x, self.y);
                        }
                        Some(34) => {
                            let c1x = self.x + self.shift();
                            let c1y = self.y;
                            let c2x = c1x + self.shift();
                            let c2y = c1y + self.shift();
                            let jpx = c2x + self.shift();
                            let jpy = c2y;
                            let c3x = jpx + self.shift();
                            let c3y = c2y;
                            let c4x = c3x + self.shift();
                            let c4y = self.y;
                            self.x = c4x + self.shift();
                            self.curve(c1x, c1y, c2x, c2y, jpx, jpy);
                            self.curve(c3x, c3y, c4x, c4y, self.x, self.y);
                        }
                        Some(36) => {
                            let c1x = self.x + self.shift();
                            let c1y = self.y + self.shift();
                            let c2x = c1x + self.shift();
                            let c2y = c1y + self.shift();
                            let jpx = c2x + self.shift();
                            let jpy = c2y;
                            let c3x = jpx + self.shift();
                            let c3y = c2y;
                            let c4x = c3x + self.shift();
                            let c4y = c3y + self.shift();
                            self.x = c4x + self.shift();
                            self.curve(c1x, c1y, c2x, c2y, jpx, jpy);
                            self.curve(c3x, c3y, c4x, c4y, self.x, self.y);
                        }
                        Some(37) => {
                            let c1x = self.x + self.shift();
                            let c1y = self.y + self.shift();
                            let c2x = c1x + self.shift();
                            let c2y = c1y + self.shift();
                            let jpx = c2x + self.shift();
                            let jpy = c2y + self.shift();
                            let c3x = jpx + self.shift();
                            let c3y = jpy + self.shift();
                            let c4x = c3x + self.shift();
                            let c4y = c3y + self.shift();
                            if (c4x - self.x).abs() > (c4y - self.y).abs() {
                                self.x = c4x + self.shift();
                            } else {
                                self.y = c4y + self.shift();
                            }
                            self.curve(c1x, c1y, c2x, c2y, jpx, jpy);
                            self.curve(c3x, c3y, c4x, c4y, self.x, self.y);
                        }
                        _ => self.stack.clear(),
                    }
                }
                14 => {
                    if !self.stack.is_empty() && !self.have_width {
                        self.width = self.shift() + self.private.nominal_width_x;
                        self.have_width = true;
                    }
                    if self.open {
                        self.path.push(PathCmd::Z);
                        self.open = false;
                    }
                }
                19 | 20 => {
                    self.parse_stems();
                    i += ((self.n_stems + 7) >> 3) as usize;
                }
                21 => {
                    if self.stack.len() > 2 && !self.have_width {
                        self.width = self.shift() + self.private.nominal_width_x;
                        self.have_width = true;
                    }
                    self.y += self.pop();
                    self.x += self.pop();
                    let (x, y) = (self.x, self.y);
                    self.new_contour(x, y);
                }
                22 => {
                    if self.stack.len() > 1 && !self.have_width {
                        self.width = self.shift() + self.private.nominal_width_x;
                        self.have_width = true;
                    }
                    self.x += self.pop();
                    let (x, y) = (self.x, self.y);
                    self.new_contour(x, y);
                }
                24 => {
                    while self.stack.len() > 2 {
                        let c1x = self.x + self.shift();
                        let c1y = self.y + self.shift();
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.x = c2x + self.shift();
                        self.y = c2y + self.shift();
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                    }
                    self.x += self.shift();
                    self.y += self.shift();
                    self.path.push(PathCmd::L(self.x, self.y));
                }
                25 => {
                    while self.stack.len() > 6 {
                        self.x += self.shift();
                        self.y += self.shift();
                        self.path.push(PathCmd::L(self.x, self.y));
                    }
                    let c1x = self.x + self.shift();
                    let c1y = self.y + self.shift();
                    let c2x = c1x + self.shift();
                    let c2y = c1y + self.shift();
                    self.x = c2x + self.shift();
                    self.y = c2y + self.shift();
                    self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                }
                26 => {
                    if self.stack.len() % 2 != 0 {
                        self.x += self.shift();
                    }
                    while !self.stack.is_empty() {
                        let c1x = self.x;
                        let c1y = self.y + self.shift();
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.x = c2x;
                        self.y = c2y + self.shift();
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                    }
                }
                27 => {
                    if self.stack.len() % 2 != 0 {
                        self.y += self.shift();
                    }
                    while !self.stack.is_empty() {
                        let c1x = self.x + self.shift();
                        let c1y = self.y;
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.x = c2x + self.shift();
                        self.y = c2y;
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                    }
                }
                28 => {
                    let (b1, b2) = (bits(i), bits(i + 1));
                    self.stack.push_back((((b1 << 24) | (b2 << 16)) >> 16) as f64);
                    i += 2;
                }
                29 => {
                    let cff = self.cff;
                    let index = self.pop() + cff.gsubrs_bias;
                    if let Some(subr) = subr_at(&cff.gsubrs, index) {
                        self.parse(subr, depth + 1)?;
                    }
                }
                30 => {
                    while !self.stack.is_empty() {
                        let c1x = self.x;
                        let c1y = self.y + self.shift();
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.x = c2x + self.shift();
                        self.y = c2y + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                        if self.stack.is_empty() {
                            break;
                        }
                        let c1x = self.x + self.shift();
                        let c1y = self.y;
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.y = c2y + self.shift();
                        self.x = c2x + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                    }
                }
                31 => {
                    while !self.stack.is_empty() {
                        let c1x = self.x + self.shift();
                        let c1y = self.y;
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.y = c2y + self.shift();
                        self.x = c2x + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                        if self.stack.is_empty() {
                            break;
                        }
                        let c1x = self.x;
                        let c1y = self.y + self.shift();
                        let c2x = c1x + self.shift();
                        let c2y = c1y + self.shift();
                        self.x = c2x + self.shift();
                        self.y = c2y + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve(c1x, c1y, c2x, c2y, self.x, self.y);
                    }
                }
                0..=31 => {}
                32..=246 => self.stack.push_back(v as f64 - 139.0),
                247..=250 => {
                    let b1 = at(i).map_or(f64::NAN, |b| b as f64);
                    i += 1;
                    self.stack.push_back((v as f64 - 247.0) * 256.0 + b1 + 108.0);
                }
                251..=254 => {
                    let b1 = at(i).map_or(f64::NAN, |b| b as f64);
                    i += 1;
                    self.stack.push_back(-(v as f64 - 251.0) * 256.0 - b1 - 108.0);
                }
                255 => {
                    let (b1, b2, b3, b4) = (bits(i), bits(i + 1), bits(i + 2), bits(i + 3));
                    i += 4;
                    self.stack.push_back((((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) as f64) / 65536.0);
                }
            }
        }
        Ok(())
    }
}

// ---- table parsing --------------------------------------------------------------------------------------------

fn subroutine_bias(count: usize) -> f64 {
    if count < 1240 {
        107.0
    } else if count < 33900 {
        1131.0
    } else {
        32768.0
    }
}

struct Index {
    objects: Vec<Vec<u8>>,
    end_offset: i64,
}

/// `parse.getOffset`: a big-endian offset of 1 to 4 bytes accumulated in 32-bit integer arithmetic.
fn read_offset(data: Data, offset: i64, size: u8) -> R<i32> {
    let mut v: i32 = 0;
    for i in 0..size as i64 {
        v = v.wrapping_shl(8).wrapping_add(data.u8(offset + i)? as i32);
    }
    Ok(v)
}

fn parse_index(data: Data, start: i64) -> R<Index> {
    let count = data.u16(start)? as usize;
    let mut offsets: Vec<i32> = Vec::new();
    let (object_offset, end_offset);
    if count != 0 {
        let offset_size = data.u8(start + 2)?;
        object_offset = start + (count as i64 + 1) * offset_size as i64 + 2;
        let mut pos = start + 3;
        for _ in 0..count + 1 {
            offsets.push(read_offset(data, pos, offset_size)?);
            pos += offset_size as i64;
        }
        end_offset = object_offset + offsets[count] as i64;
    } else {
        object_offset = 0;
        end_offset = start + 2;
    }
    let mut objects = Vec::with_capacity(count);
    for pair in offsets.windows(2) {
        let (from, to) = (object_offset + pair[0] as i64, object_offset + pair[1] as i64);
        let mut bytes = Vec::new();
        if to > from {
            bytes.extend_from_slice(data.slice(from, (to - from) as usize)?);
        }
        objects.push(bytes);
    }
    Ok(Index { objects, end_offset })
}

/// A DICT operand list: one operand is unpacked to a number, as `entriesToObject` does.
type Dict = HashMap<i32, Vec<f64>>;

fn parse_float_operand(p: &mut Parser) -> R<f64> {
    let lookup = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "E", "E-", "null", "-"];
    let mut s = String::new();
    loop {
        let b = p.u8()?;
        let (n1, n2) = (b >> 4, b & 15);
        if n1 == 15 {
            break;
        }
        s.push_str(lookup[n1 as usize]);
        if n2 == 15 {
            break;
        }
        s.push_str(lookup[n2 as usize]);
    }
    Ok(js_parse_float(&s))
}

/// `parseFloat`: the longest decimal prefix, `NaN` if there is none.
fn js_parse_float(s: &str) -> f64 {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - digits_start;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        digits += j - i - 1;
        i = j;
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let exp_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > exp_start {
            i = j;
        }
    }
    s[..i].parse::<f64>().unwrap_or(f64::NAN)
}

fn parse_operand(p: &mut Parser, b0: u8) -> R<f64> {
    Ok(match b0 {
        28 => {
            let (b1, b2) = (p.u8()? as i32, p.u8()? as i32);
            (b1 << 8 | b2) as f64
        }
        29 => {
            let (b1, b2, b3, b4) = (p.u8()? as i32, p.u8()? as i32, p.u8()? as i32, p.u8()? as i32);
            (b1 << 24 | b2 << 16 | b3 << 8 | b4) as f64
        }
        30 => parse_float_operand(p)?,
        32..=246 => b0 as f64 - 139.0,
        247..=250 => {
            let b1 = p.u8()? as f64;
            (b0 as f64 - 247.0) * 256.0 + b1 + 108.0
        }
        251..=254 => {
            let b1 = p.u8()? as f64;
            -(b0 as f64 - 251.0) * 256.0 - b1 - 108.0
        }
        _ => return Err(FontError::Invalid("invalid CFF operand")),
    })
}

fn parse_dict(data: Data, start: i64, size: i64) -> R<Dict> {
    let mut p = Parser::new(data, start);
    let mut dict: Dict = HashMap::new();
    let mut operands: Vec<f64> = Vec::new();
    while p.rel < size {
        let mut op = p.u8()? as i32;
        if op <= 21 {
            if op == 12 {
                op = 1200 + p.u8()? as i32;
            }
            // `entriesToObject` throws on a repeated key whose earlier value is a number.
            if let Some(old) = dict.get(&op) {
                let numeric_old = match old.len() {
                    1 => !old[0].is_nan(),
                    0 => true,
                    _ => false,
                };
                if numeric_old {
                    return Err(FontError::Invalid("repeated CFF dict key"));
                }
            }
            dict.insert(op, std::mem::take(&mut operands));
        } else {
            operands.push(parse_operand(&mut p, op as u8)?);
        }
    }
    Ok(dict)
}

/// A single-operand entry as a number, the default when absent; a list of several operands is not a number.
fn number(dict: &Dict, op: i32, default: f64) -> R<f64> {
    match dict.get(&op) {
        None => Ok(default),
        Some(v) if v.len() == 1 => Ok(v[0]),
        Some(_) => Err(FontError::Invalid("CFF dict entry is not a number")),
    }
}

/// `[size, offset]` of the private dictionary.
fn private_pair(dict: &Dict) -> R<(f64, f64)> {
    match dict.get(&18) {
        None => Ok((0.0, 0.0)),
        Some(v) => Ok((v.first().copied().unwrap_or(f64::NAN), v.get(1).copied().unwrap_or(f64::NAN))),
    }
}

fn to_i64(v: f64) -> R<i64> {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.0e15 {
        Ok(v as i64)
    } else {
        Err(FontError::Invalid("CFF offset is not an integer"))
    }
}

fn parse_private(data: Data, start: i64, size: i64) -> R<(Private, Dict)> {
    let dict = parse_dict(data, start, size)?;
    let default_width_x = number(&dict, 20, 0.0)?;
    let nominal_width_x = number(&dict, 21, 0.0)?;
    let subrs_offset = number(&dict, 19, 0.0)?;
    let mut private = Private { subrs: Vec::new(), subrs_bias: 0.0, default_width_x, nominal_width_x };
    if subrs_offset != 0.0 {
        let index = parse_index(data, start + to_i64(subrs_offset)?)?;
        private.subrs_bias = subroutine_bias(index.objects.len());
        private.subrs = index.objects;
    }
    Ok((private, dict))
}

/// `gatherCFFTopDicts` for one dictionary.
fn gather(data: Data, cff_start: i64, bytes: &[u8]) -> R<(Dict, Private)> {
    let dict = parse_dict(Data(bytes), 0, bytes.len() as i64)?;
    let (size, offset) = private_pair(&dict)?;
    let mut private = Private::default();
    if size != 0.0 && offset != 0.0 {
        let (parsed, _) = parse_private(data, to_i64(offset)? + cff_start, to_i64(size)?)?;
        private = parsed;
    }
    Ok((dict, private))
}

/// A string id that `getCFFString` resolves: a standard string below 391, else an entry of the string index.
fn sid_defined(sid: f64, strings: usize) -> bool {
    if sid.fract() != 0.0 || sid.is_nan() {
        return false;
    }
    if sid <= 390.0 {
        sid >= 0.0
    } else {
        sid - 391.0 < strings as f64
    }
}

pub(crate) fn parse(data: Data, start: i64, num_glyphs: usize) -> R<Cff> {
    let header_end = start + 4;
    let name_index = parse_index(data, header_end)?;
    let top_index = parse_index(data, name_index.end_offset)?;
    let string_index = parse_index(data, top_index.end_offset)?;
    let global_subrs = parse_index(data, string_index.end_offset)?;
    let gsubrs_bias = subroutine_bias(global_subrs.objects.len());

    if top_index.objects.len() != 1 {
        return Err(FontError::Invalid("CFF table has too many fonts"));
    }
    let (top, top_private) = gather(data, start, &top_index.objects[0])?;
    let strings = string_index.objects.len();
    let is_cid = match top.get(&1230) {
        Some(ros) => ros.len() >= 2 && sid_defined(ros[0], strings) && sid_defined(ros[1], strings),
        None => false,
    };

    let mut private = vec![top_private];
    let mut fd_select = None;
    if is_cid {
        let fd_array_offset = number(&top, 1236, 0.0)?;
        let fd_select_offset = number(&top, 1237, 0.0)?;
        if fd_array_offset == 0.0 || fd_select_offset == 0.0 {
            return Err(FontError::Invalid("CID font without FDArray or FDSelect"));
        }
        let fd_index = parse_index(data, start + to_i64(fd_array_offset)?)?;
        private.clear();
        for bytes in &fd_index.objects {
            private.push(gather(data, start, bytes)?.1);
        }
        fd_select = Some(parse_fd_select(data, start + to_i64(fd_select_offset)?, num_glyphs, private.len())?);
    }

    // The private dictionary is read again from the top dictionary, as opentype.js does, for its errors.
    let (size, offset) = private_pair(&top)?;
    parse_private(data, start + to_i64(offset)?, to_i64(size)?)?;

    let char_strings = to_i64(number(&top, 17, 0.0)?)?;
    let glyphs = parse_index(data, start + char_strings)?.objects;
    let charset = to_i64(number(&top, 15, 0.0)?)?;
    check_charset(data, start + charset, glyphs.len())?;
    let encoding = number(&top, 16, 0.0)?;
    if encoding != 0.0 && encoding != 1.0 {
        check_encoding(data, start + to_i64(encoding)?)?;
    }

    Ok(Cff { glyphs, gsubrs: global_subrs.objects, gsubrs_bias, private, fd_select })
}

fn parse_fd_select(data: Data, start: i64, n_glyphs: usize, fd_count: usize) -> R<Vec<u8>> {
    let mut p = Parser::new(data, start);
    let mut select = Vec::new();
    match p.u8()? {
        0 => {
            for _ in 0..n_glyphs {
                let fd = p.u8()?;
                if fd as usize >= fd_count {
                    return Err(FontError::Invalid("bad FD index"));
                }
                select.push(fd);
            }
        }
        3 => {
            let ranges = p.u16()?;
            let mut first = p.u16()? as usize;
            if first != 0 {
                return Err(FontError::Invalid("bad FDSelect range"));
            }
            let mut next = 0usize;
            for _ in 0..ranges {
                let fd = p.u8()?;
                next = p.u16()? as usize;
                if fd as usize >= fd_count || next > n_glyphs {
                    return Err(FontError::Invalid("bad FDSelect range"));
                }
                while first < next {
                    select.push(fd);
                    first += 1;
                }
                first = next;
            }
            if next != n_glyphs {
                return Err(FontError::Invalid("bad final FDSelect GID"));
            }
        }
        _ => return Err(FontError::Invalid("unsupported FDSelect format")),
    }
    Ok(select)
}

/// `parseCFFCharset`, read for its errors only: glyph names are not used by the text tool.
fn check_charset(data: Data, start: i64, n_glyphs: usize) -> R<()> {
    let mut p = Parser::new(data, start);
    let remaining = n_glyphs.saturating_sub(1);
    let mut have = 1usize;
    match p.u8()? {
        0 => {
            for _ in 0..remaining {
                p.u16()?;
            }
        }
        1 => {
            while have <= remaining {
                p.u16()?;
                have += p.u8()? as usize + 1;
            }
        }
        2 => {
            while have <= remaining {
                p.u16()?;
                have += p.u16()? as usize + 1;
            }
        }
        _ => return Err(FontError::Invalid("unknown charset format")),
    }
    Ok(())
}

/// `parseCFFEncoding`, read for its errors only: the cmap decides which glyph a character has.
fn check_encoding(data: Data, start: i64) -> R<()> {
    let mut p = Parser::new(data, start);
    match p.u8()? {
        0 => {
            let n = p.u8()?;
            for _ in 0..n {
                p.u8()?;
            }
        }
        1 => {
            let n = p.u8()?;
            for _ in 0..n {
                p.u8()?;
                p.u8()?;
            }
        }
        _ => return Err(FontError::Invalid("unknown encoding format")),
    }
    Ok(())
}
