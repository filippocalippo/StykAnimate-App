//! An OpenType font as opentype.js's `parse` sees it, reduced to what the text tool reads: the character map, glyph
//! outlines, advances, kerning and the names. See `docs/native/text-tool.md` for what is and is not reproduced.

use std::collections::HashMap;
use std::sync::Mutex;

use super::cff::{self, Cff};
use super::kerning::{self, Gpos};
use super::names::{self, Names};
use super::path::{scale_path, PathCmd};
use super::reader::{Data, Parser, R};
use super::truetype::Glyf;
use super::FontError;

/// `MAX_FONT_BYTES`: a font session accepts no file larger than this.
pub const MAX_FONT_BYTES: usize = 32 * 1024 * 1024;

struct TableEntry {
    tag: [u8; 4],
    offset: i64,
}

enum Outlines {
    TrueType(Glyf),
    Cff(Box<Cff>),
}

#[derive(Debug)]
struct Segment {
    start: u16,
    end: u16,
    delta: i16,
    range_offset: u16,
    /// Where this segment's `idRangeOffset` entry lies in the file.
    range_position: i64,
}

#[derive(Debug)]
enum Cmap {
    Format4(Vec<Segment>),
    /// `(first character, last character, glyph of the first)`.
    Format12(Vec<(u32, u32, u64)>),
}

struct Os2 {
    fs_selection: u16,
    code_page_range1: Option<u32>,
}

enum Kern {
    /// The font has a `GPOS` table: the type-2 lookups of its default `kern` feature (possibly none).
    Gpos(Gpos, Vec<usize>),
    /// No `GPOS` table: the `kern` table's pairs (possibly none).
    Table(HashMap<(u16, u16), i16>),
}

/// A parsed font. The bytes stay with the font; outlines are read from them on demand.
pub struct Font {
    bytes: Vec<u8>,
    pub units_per_em: u16,
    outlines: Outlines,
    cmap: Cmap,
    symbol: bool,
    advances: Vec<u16>,
    kern: Kern,
    names: Names,
    os2: Option<Os2>,
    /// `glyph.advanceWidth = width` of a CFF charstring, written when the glyph's outline is first read. opentype.js
    /// keeps it on the glyph object for the life of the font, so it shows in every later layout with that font.
    charstring_advances: Mutex<HashMap<usize, f64>>,
}

impl Font {
    /// `parseTextFont`'s parse: `opentype.parse` followed by the Windows symbol mapping.
    pub fn parse(bytes: Vec<u8>) -> Result<Font, FontError> {
        if bytes.is_empty() || bytes.len() > MAX_FONT_BYTES {
            return Err(FontError::Size);
        }
        let data = Data(&bytes);
        let signature = data.slice(0, 4)?;
        let truetype = signature == [0, 1, 0, 0] || signature == *b"true" || signature == *b"typ1";
        if !truetype && signature != *b"OTTO" {
            return Err(FontError::Unsupported);
        }
        let table_count = data.u16(4)? as usize;
        let mut entries = Vec::with_capacity(table_count);
        for i in 0..table_count {
            let at = 12 + 16 * i as i64;
            let tag = data.slice(at, 4)?;
            data.u32(at + 4)?;
            let offset = data.u32(at + 8)? as i64;
            data.u32(at + 12)?;
            entries.push(TableEntry { tag: [tag[0], tag[1], tag[2], tag[3]], offset });
        }
        let last = |tag: &[u8; 4]| entries.iter().rev().find(|e| &e.tag == tag).map(|e| e.offset);

        let (mut cmap, mut head, mut maxp, mut hhea, mut os2, mut ltag) = (None, None, None, None, None, None);
        for entry in &entries {
            match &entry.tag {
                b"cmap" => cmap = Some(parse_cmap(data, entry.offset)?),
                b"head" => head = Some(parse_head(data, entry.offset)?),
                b"hhea" => hhea = Some(parse_hhea(data, entry.offset)?),
                b"maxp" => maxp = Some(parse_maxp(data, entry.offset)?),
                b"OS/2" => os2 = Some(parse_os2(data, entry.offset)?),
                b"ltag" => ltag = Some(names::parse_ltag(data, entry.offset)?),
                b"post" => parse_post(data, entry.offset)?,
                _ => {}
            }
        }
        let name_start = last(b"name").ok_or(FontError::Missing("name"))?;
        let names = names::parse_name_table(data, name_start, ltag.as_deref())?;
        let head = head.ok_or(FontError::Missing("head"))?;
        let maxp = maxp.ok_or(FontError::Missing("maxp"))?;
        let cmap = cmap.ok_or(FontError::Missing("cmap"))?;

        let outlines = if let (Some(glyf), Some(loca)) = (last(b"glyf"), last(b"loca")) {
            let mut p = Parser::new(data, loca);
            let mut offsets = Vec::with_capacity(maxp as usize + 1);
            for _ in 0..maxp as usize + 1 {
                offsets.push(if head.index_to_loc_format == 0 { p.u16()? as u32 * 2 } else { p.u32()? });
            }
            if last(b"post").is_none() {
                // addGlyphNames reads `font.glyphNames.names`, which only a post table creates, for TrueType outlines.
                return Err(FontError::Missing("post"));
            }
            Outlines::TrueType(Glyf { start: glyf, loca: offsets })
        } else if let Some(start) = last(b"CFF ") {
            Outlines::Cff(Box::new(cff::parse(data, start, maxp as usize)?))
        } else {
            return Err(FontError::Invalid("font has no TrueType or CFF outlines"));
        };
        let glyph_count = match &outlines {
            Outlines::TrueType(glyf) => glyf.glyph_count(),
            Outlines::Cff(cff) => cff.glyph_count(),
        };

        let hmtx = last(b"hmtx").ok_or(FontError::Missing("hmtx"))?;
        let metrics = hhea.unwrap_or(0) as usize;
        let mut p = Parser::new(data, hmtx);
        let mut advances = Vec::new();
        for i in 0..maxp as usize {
            if i >= glyph_count {
                // The glyph set has no glyph `i`: opentype.js fails on `glyphs.get(i)`.
                return Err(FontError::GlyphOutOfRange(i));
            }
            if i < metrics {
                advances.push(p.u16()?);
                p.i16()?;
            }
        }

        // addGlyphNames: every character the cmap maps must name a glyph of the font.
        cmap.check_glyphs(data, glyph_count)?;

        let kern = match last(b"GPOS") {
            Some(start) => {
                let gpos = kerning::parse_gpos(data, start)?;
                let lookups = gpos.kerning_lookups()?;
                Kern::Gpos(gpos, lookups)
            }
            None => Kern::Table(match last(b"kern") {
                Some(start) => kerning::parse_kern(data, start)?,
                None => HashMap::new(),
            }),
        };
        // opentype.js parses a `kern` table even when a GPOS table makes it unused.
        if let (Some(start), Kern::Gpos(..)) = (last(b"kern"), &kern) {
            kerning::parse_kern(data, start)?;
        }

        let symbol = os2.as_ref().and_then(|o| o.code_page_range1).unwrap_or(0) >> 31 != 0 || has_symbol_cmap(&bytes);
        let units_per_em = head.units_per_em;
        Ok(Font {
            bytes,
            units_per_em,
            outlines,
            cmap,
            symbol,
            advances,
            kern,
            names,
            os2,
            charstring_advances: Mutex::new(HashMap::new()),
        })
    }

    pub fn glyph_count(&self) -> usize {
        match &self.outlines {
            Outlines::TrueType(glyf) => glyf.glyph_count(),
            Outlines::Cff(cff) => cff.glyph_count(),
        }
    }

    /// `font.names.preferredFamily` else `fontFamily`, else "Custom font" (`textFontFamily`).
    pub fn family(&self) -> String {
        self.names.localized(16).or_else(|| self.names.localized(1)).unwrap_or("Custom font").to_string()
    }

    /// The style name: preferred subfamily, else subfamily, else "Regular".
    pub fn style(&self) -> String {
        self.names.localized(17).or_else(|| self.names.localized(2)).unwrap_or("Regular").to_string()
    }

    pub fn bold(&self) -> bool {
        self.os2.as_ref().map_or(0, |o| o.fs_selection) & 32 != 0
    }

    pub fn italic(&self) -> bool {
        self.os2.as_ref().map_or(0, |o| o.fs_selection) & 1 != 0
    }

    /// `font.charToGlyphIndex(char)` then `glyphs.get(index)`: the glyph index of a character, 0 for `.notdef`.
    pub fn glyph_index(&self, unit: u16) -> R<usize> {
        let data = Data(&self.bytes);
        let code = unit as u32;
        let mut index = self.cmap.get(data, code);
        if self.symbol && (0x20..=0xff).contains(&code) && index == 0 {
            let symbol = self.cmap.get(data, 0xf000 + code);
            if symbol != 0 {
                index = symbol;
            }
        }
        if index as usize >= self.glyph_count() {
            return Err(FontError::GlyphOutOfRange(index as usize));
        }
        Ok(index as usize)
    }

    /// `glyph.advanceWidth`, `None` where opentype.js has `undefined`. A CFF glyph whose outline was read answers with
    /// the width its charstring declares, not the `hmtx` entry.
    pub fn advance_width(&self, gid: usize) -> Option<f64> {
        if let Some(width) = self.charstring_advances.lock().expect("advance cache").get(&gid) {
            return Some(*width);
        }
        self.advances.get(gid).or_else(|| self.advances.last()).map(|&a| a as f64)
    }

    /// `glyph.getPath(0, 0, fontSize)`: the outline in pixels as opentype.js computes it.
    pub fn scaled_path(&self, gid: usize, font_size: f64) -> R<Vec<PathCmd>> {
        let data = Data(&self.bytes);
        let units = match &self.outlines {
            Outlines::TrueType(glyf) => glyf.path(data, gid)?,
            Outlines::Cff(cff) => {
                let (path, width) = cff.charstring(gid)?;
                self.charstring_advances.lock().expect("advance cache").insert(gid, width);
                path
            }
        };
        Ok(scale_path(&units, self.units_per_em as f64, font_size))
    }

    /// `font.getKerningValue(left, right)` in font units.
    pub fn kerning(&self, left: usize, right: usize) -> R<f64> {
        match &self.kern {
            Kern::Gpos(gpos, lookups) => gpos.kerning_value(lookups, left, right),
            Kern::Table(pairs) => {
                // Glyph 0 is passed as the glyph object itself in opentype.js and never matches a pair.
                if left == 0 || right == 0 || left > u16::MAX as usize || right > u16::MAX as usize {
                    return Ok(0.0);
                }
                Ok(pairs.get(&(left as u16, right as u16)).copied().unwrap_or(0) as f64)
            }
        }
    }
}

// ---- tables ----------------------------------------------------------------------------------------------------

impl Cmap {
    /// `glyphIndexMap[code] || 0`: the last segment or group that covers the character wins, as in the map opentype.js
    /// fills in order.
    fn get(&self, data: Data, code: u32) -> u32 {
        match self {
            Cmap::Format4(segments) => {
                let mut found = 0;
                for s in segments {
                    if code >= s.start as u32 && code <= s.end as u32 {
                        found = Self::segment_glyph(data, s, code).unwrap_or(0);
                    }
                }
                found
            }
            Cmap::Format12(groups) => {
                let mut found = 0u64;
                for &(start, end, glyph) in groups {
                    if code >= start && code <= end {
                        found = glyph + (code - start) as u64;
                    }
                }
                found.min(u32::MAX as u64) as u32
            }
        }
    }

    fn segment_glyph(data: Data, s: &Segment, code: u32) -> R<u32> {
        if s.range_offset != 0 {
            let at = s.range_position + s.range_offset as i64 + (code - s.start as u32) as i64 * 2;
            let glyph = data.u16(at)?;
            Ok(if glyph != 0 { ((glyph as i32 + s.delta as i32) & 0xffff) as u32 } else { 0 })
        } else {
            Ok(((code as i32 + s.delta as i32) & 0xffff) as u32)
        }
    }

    /// Reads every mapping once, as opentype.js's eager `glyphIndexMap` does, so a bad glyph array is an error up front,
    /// and checks that each mapped glyph exists.
    fn check_glyphs(&self, data: Data, glyph_count: usize) -> R<()> {
        // Segments may overlap in a malformed font; opentype.js would walk each character of each one.
        let mut budget = 4_000_000usize;
        match self {
            Cmap::Format4(segments) => {
                for s in segments {
                    if s.start > s.end {
                        continue;
                    }
                    let characters = (s.end - s.start) as usize + 1;
                    budget = budget.checked_sub(characters).ok_or(FontError::Invalid("cmap segments overlap too much"))?;
                    for c in s.start as u32..=s.end as u32 {
                        let glyph = Self::segment_glyph(data, s, c)?;
                        if glyph as usize >= glyph_count {
                            return Err(FontError::GlyphOutOfRange(glyph as usize));
                        }
                    }
                }
            }
            Cmap::Format12(groups) => {
                for &(start, end, glyph) in groups {
                    if start <= end && glyph + (end - start) as u64 >= glyph_count as u64 {
                        return Err(FontError::GlyphOutOfRange((glyph + (end - start) as u64) as usize));
                    }
                }
            }
        }
        Ok(())
    }
}

fn parse_cmap(data: Data, start: i64) -> R<Cmap> {
    let version = data.u16(start)?;
    if version != 0 {
        return Err(FontError::Invalid("cmap table version should be 0"));
    }
    let tables = data.u16(start + 2)? as i64;
    let mut offset = -1i64;
    for i in (0..tables).rev() {
        let platform = data.u16(start + 4 + i * 8)?;
        let encoding = data.u16(start + 4 + i * 8 + 2)?;
        if (platform == 3 && matches!(encoding, 0 | 1 | 10)) || (platform == 0 && encoding <= 4) {
            offset = data.u32(start + 4 + i * 8 + 4)? as i64;
            break;
        }
    }
    if offset == -1 {
        return Err(FontError::Invalid("no valid cmap sub-tables found"));
    }
    let mut p = Parser::new(data, start + offset);
    match p.u16()? {
        12 => {
            p.u16()?;
            p.u32()?;
            p.u32()?;
            let count = p.u32()? as usize;
            let bytes = count.checked_mul(12).ok_or(FontError::Range)?;
            data.slice(p.at(), bytes)?;
            let mut groups = Vec::with_capacity(count);
            for _ in 0..count {
                groups.push((p.u32()?, p.u32()?, p.u32()? as u64));
            }
            Ok(Cmap::Format12(groups))
        }
        4 => {
            p.u16()?;
            p.u16()?;
            let seg_count = (p.u16()? >> 1) as i64;
            let base = start + offset;
            let mut segments = Vec::new();
            for i in 0..seg_count - 1 {
                let end = data.u16(base + 14 + i * 2)?;
                let first = data.u16(base + 16 + seg_count * 2 + i * 2)?;
                let delta = data.i16(base + 16 + seg_count * 4 + i * 2)?;
                let range_position = base + 16 + seg_count * 6 + i * 2;
                let range_offset = data.u16(range_position)?;
                segments.push(Segment { start: first, end, delta, range_offset, range_position });
            }
            Ok(Cmap::Format4(segments))
        }
        _ => Err(FontError::Invalid("only format 4 and 12 cmap tables are supported")),
    }
}

struct Head {
    units_per_em: u16,
    index_to_loc_format: i16,
}

fn parse_head(data: Data, start: i64) -> R<Head> {
    let mut p = Parser::new(data, start);
    p.skip(4); // version
    p.skip(4); // fontRevision
    p.skip(4); // checkSumAdjustment
    if p.u32()? != 0x5F0F3CF5 {
        return Err(FontError::Invalid("font header has wrong magic number"));
    }
    p.skip(2); // flags
    let units_per_em = p.u16()?;
    p.skip(16); // created, modified
    p.skip(8); // xMin, yMin, xMax, yMax
    p.skip(2); // macStyle
    p.skip(2); // lowestRecPPEM
    p.skip(2); // fontDirectionHint
    // opentype.js reads every field; the bounds of the whole table must hold.
    data.slice(start, 54)?;
    let index_to_loc_format = data.i16(start + 50)?;
    Ok(Head { units_per_em, index_to_loc_format })
}

fn parse_hhea(data: Data, start: i64) -> R<u16> {
    data.slice(start, 36)?;
    data.u16(start + 34)
}

fn parse_maxp(data: Data, start: i64) -> R<u16> {
    let mut p = Parser::new(data, start);
    let version = p.version(4096.0)?;
    let num_glyphs = p.u16()?;
    if version == 1.0 {
        data.slice(p.at(), 26)?;
    }
    Ok(num_glyphs)
}

fn parse_os2(data: Data, start: i64) -> R<Os2> {
    let version = data.u16(start)?;
    data.slice(start, 78)?;
    let fs_selection = data.u16(start + 62)?;
    let mut code_page_range1 = None;
    if version >= 1 {
        data.slice(start + 78, 8)?;
        code_page_range1 = Some(data.u32(start + 78)?);
    }
    if version >= 2 {
        data.slice(start + 86, 10)?;
    }
    Ok(Os2 { fs_selection, code_page_range1 })
}

/// `parsePostTable` and `new GlyphNames`: read for the errors they raise; glyph names are not used.
fn parse_post(data: Data, start: i64) -> R<()> {
    let mut p = Parser::new(data, start);
    let version = p.version(4096.0)?;
    data.slice(p.at(), 28)?;
    p.skip(28);
    if version == 2.0 {
        let count = p.u16()? as usize;
        let indexes = p.u16_list_of(count)?;
        for index in indexes {
            if index >= 258 {
                let length = p.i8()? as i64;
                if length > 0 {
                    data.slice(p.at(), length as usize)?;
                }
                p.skip(length);
            }
        }
    } else if version == 2.5 {
        let count = p.u16()? as usize;
        data.slice(p.at(), count)?;
        if count > 0 {
            // `new GlyphNames` reads `glyphNameIndex`, which a version 2.5 table does not have.
            return Err(FontError::Invalid("post table version 2.5 names"));
        }
    }
    Ok(())
}

/// `hasSymbolCmap(buffer)` of `text-font-compat.mjs`: any cmap subtable of platform 3, encoding 0 (Windows symbol).
fn has_symbol_cmap(bytes: &[u8]) -> bool {
    let size = bytes.len();
    if size < 12 {
        return false;
    }
    let u16_at = |at: usize| u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize;
    let u32_at = |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
    let signature = u32_at(0);
    if ![0x0001_0000, 0x4f54_544f, 0x7472_7565].contains(&signature) {
        return false;
    }
    let count = u16_at(4);
    if 12 + count * 16 > size {
        return false;
    }
    for i in 0..count {
        let record = 12 + i * 16;
        if u32_at(record) != 0x636d_6170 {
            continue;
        }
        let offset = u32_at(record + 8);
        let length = u32_at(record + 12);
        if length < 4 || offset + length > size {
            return false;
        }
        let entries = u16_at(offset + 2);
        if 4 + entries * 8 > length {
            return false;
        }
        for j in 0..entries {
            let entry = offset + 4 + j * 8;
            if u16_at(entry) == 3 && u16_at(entry + 2) == 0 {
                return true;
            }
        }
    }
    false
}
