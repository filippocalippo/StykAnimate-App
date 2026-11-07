//! Kerning exactly as opentype.js reads it.
//!
//! `Font.getKerningValue` prefers the `GPOS` table's `kern` feature for the default script and falls back to the `kern`
//! table only when the font has **no `GPOS` table at all**: a `GPOS` table without a usable `kern` feature (an empty
//! lookup list) makes every pair 0. Only direct pair-adjustment lookups (type 2) count; extension lookups (type 9) are
//! not followed. Everything in the table is parsed up front, so a malformed table rejects the font as it does there.

use std::collections::HashMap;

use super::reader::{Data, Parser, R};
use super::FontError;

type Tag = [u8; 4];

// ---- GPOS -----------------------------------------------------------------------------------------------------

#[derive(Debug)]
enum Coverage {
    List(Vec<u16>),
    Ranges(Vec<RangeRecord>),
}

#[derive(Debug, Clone, Copy)]
struct RangeRecord {
    start: u16,
    end: u16,
    /// Coverage: the coverage index of `start`. Class definition: the class id.
    value: u16,
}

#[derive(Debug)]
enum ClassDef {
    List { start_glyph: u16, classes: Vec<u16> },
    Ranges(Vec<RangeRecord>),
}

#[derive(Debug)]
enum PairPos {
    Glyphs {
        coverage: Option<Coverage>,
        /// `pairSets[i]`: `None` for a null pointer. Each pair is the second glyph and `value1.xAdvance || 0`.
        sets: Vec<Option<Vec<(u16, i16)>>>,
    },
    Classes {
        coverage: Option<Coverage>,
        class_def1: Option<ClassDef>,
        class_def2: Option<ClassDef>,
        class1_count: usize,
        class2_count: usize,
        /// `class1Count * class2Count` values of `value1.xAdvance || 0`.
        advances: Vec<i16>,
    },
}

#[derive(Debug)]
struct Lookup {
    lookup_type: u16,
    /// `None` for a null subtable pointer, which opentype.js fails on when the lookup is searched.
    subtables: Vec<Option<PairPos>>,
}

struct LangSys {
    feature_indexes: Vec<u16>,
}

struct Script {
    default_lang_sys: Option<LangSys>,
}

struct FeatureRecord {
    tag: Tag,
    /// The feature's lookup list indexes; `None` when the feature pointer is null.
    lookups: Option<Vec<u16>>,
}

pub(crate) struct Gpos {
    scripts: Vec<(Tag, Option<Script>)>,
    features: Vec<FeatureRecord>,
    lookups: Vec<Option<Lookup>>,
}

fn value_record_size(format: u16) -> usize {
    2 * (format & 0xff).count_ones() as usize
}

/// `parseValueRecord(format)`: the `xAdvance` it holds (0 when absent) and whether the record exists (`format != 0`).
fn value_record(p: &mut Parser, format: u16) -> R<i16> {
    let mut x_advance = 0;
    if format == 0 {
        return Ok(0);
    }
    if format & 0x0001 != 0 {
        p.i16()?;
    }
    if format & 0x0002 != 0 {
        p.i16()?;
    }
    if format & 0x0004 != 0 {
        x_advance = p.i16()?;
    }
    for bit in [0x0008, 0x0010, 0x0020, 0x0040, 0x0080] {
        if format & bit != 0 {
            p.i16()?;
        }
    }
    Ok(x_advance)
}

fn parse_coverage(mut p: Parser) -> R<Coverage> {
    let format = p.u16()?;
    let count = p.u16()? as usize;
    match format {
        1 => Ok(Coverage::List(p.u16_list_of(count)?)),
        2 => {
            let mut ranges = Vec::with_capacity(count);
            for _ in 0..count {
                ranges.push(RangeRecord { start: p.u16()?, end: p.u16()?, value: p.u16()? });
            }
            Ok(Coverage::Ranges(ranges))
        }
        _ => Err(FontError::Invalid("coverage format must be 1 or 2")),
    }
}

fn parse_class_def(mut p: Parser) -> R<ClassDef> {
    match p.u16()? {
        1 => Ok(ClassDef::List { start_glyph: p.u16()?, classes: p.u16_list()? }),
        2 => {
            let count = p.u16()? as usize;
            let mut ranges = Vec::with_capacity(count);
            for _ in 0..count {
                ranges.push(RangeRecord { start: p.u16()?, end: p.u16()?, value: p.u16()? });
            }
            Ok(ClassDef::Ranges(ranges))
        }
        _ => Err(FontError::Invalid("class definition format must be 1 or 2")),
    }
}

fn optional<'a, T>(pointer: Option<Parser<'a>>, f: impl FnOnce(Parser<'a>) -> R<T>) -> R<Option<T>> {
    pointer.map(f).transpose()
}

/// Class-pair tables beyond this many class pairs are refused: opentype.js would build them as nested arrays.
const MAX_CLASS_PAIRS: usize = 1 << 24;

fn parse_pair_pos(mut p: Parser) -> R<PairPos> {
    let pos_format = p.u16()?;
    if pos_format != 1 && pos_format != 2 {
        return Err(FontError::Invalid("GPOS lookup type 2 format must be 1 or 2"));
    }
    let coverage = optional(p.pointer16()?, parse_coverage)?;
    let format1 = p.u16()?;
    let format2 = p.u16()?;
    if pos_format == 1 {
        let count = p.u16()? as usize;
        let mut sets = Vec::with_capacity(count);
        for _ in 0..count {
            let set = match p.pointer16()? {
                None => None,
                Some(mut q) => {
                    let n = q.u16()? as usize;
                    let mut pairs = Vec::with_capacity(n);
                    for _ in 0..n {
                        let second = q.u16()?;
                        let advance = value_record(&mut q, format1)?;
                        value_record(&mut q, format2)?;
                        pairs.push((second, advance));
                    }
                    Some(pairs)
                }
            };
            sets.push(set);
        }
        return Ok(PairPos::Glyphs { coverage, sets });
    }
    let class_def1 = optional(p.pointer16()?, parse_class_def)?;
    let class_def2 = optional(p.pointer16()?, parse_class_def)?;
    let class1_count = p.u16()? as usize;
    let class2_count = p.u16()? as usize;
    if class1_count * class2_count > MAX_CLASS_PAIRS {
        return Err(FontError::Invalid("class pair table too large"));
    }
    let mut advances = Vec::with_capacity(class1_count * class2_count);
    for _ in 0..class1_count * class2_count {
        let advance = value_record(&mut p, format1)?;
        value_record(&mut p, format2)?;
        advances.push(advance);
    }
    let _ = value_record_size;
    Ok(PairPos::Classes { coverage, class_def1, class_def2, class1_count, class2_count, advances })
}

/// `subtableParsers[1]`: parsed for its errors, then dropped; nothing here reads single adjustments.
fn check_single_pos(mut p: Parser) -> R<()> {
    let format = p.u16()?;
    match format {
        1 => {
            optional(p.pointer16()?, parse_coverage)?;
            let record_format = p.u16()?;
            value_record(&mut p, record_format)?;
        }
        2 => {
            optional(p.pointer16()?, parse_coverage)?;
            let record_format = p.u16()?;
            let count = p.u16()?;
            for _ in 0..count {
                value_record(&mut p, record_format)?;
            }
        }
        _ => return Err(FontError::Invalid("GPOS lookup type 1 format must be 1 or 2")),
    }
    Ok(())
}

fn parse_lookup(mut p: Parser) -> R<Lookup> {
    let lookup_type = p.u16()?;
    if !(1..=9).contains(&lookup_type) {
        return Err(FontError::Invalid("GPOS lookup type unknown"));
    }
    let flag = p.u16()?;
    let count = p.u16()? as usize;
    let mut subtables = Vec::with_capacity(count);
    for _ in 0..count {
        let sub = p.pointer16()?;
        subtables.push(match (lookup_type, sub) {
            (2, Some(q)) => Some(parse_pair_pos(q)?),
            (1, Some(q)) => {
                check_single_pos(q)?;
                None
            }
            _ => None,
        });
    }
    if flag & 0x10 != 0 {
        p.u16()?;
    }
    Ok(Lookup { lookup_type, subtables })
}

fn parse_lang_sys(mut p: Parser) -> R<LangSys> {
    p.u16()?;
    p.u16()?;
    Ok(LangSys { feature_indexes: p.u16_list()? })
}

fn parse_script(mut p: Parser) -> R<Script> {
    let default_lang_sys = optional(p.pointer16()?, parse_lang_sys)?;
    let count = p.u16()? as usize;
    for _ in 0..count {
        p.tag()?;
        optional(p.pointer16()?, parse_lang_sys)?;
    }
    Ok(Script { default_lang_sys })
}

pub(crate) fn parse_gpos(data: Data, start: i64) -> R<Gpos> {
    let mut p = Parser::new(data, start);
    let version = p.version(1.0)?;
    if version != 1.0 && version != 1.1 {
        return Err(FontError::Invalid("unsupported GPOS table version"));
    }
    let mut scripts = Vec::new();
    if let Some(mut q) = p.pointer16()? {
        let count = q.u16()? as usize;
        for _ in 0..count {
            let tag = q.tag()?;
            scripts.push((tag, optional(q.pointer16()?, parse_script)?));
        }
    }
    let mut features = Vec::new();
    if let Some(mut q) = p.pointer16()? {
        let count = q.u16()? as usize;
        for _ in 0..count {
            let tag = q.tag()?;
            let lookups = match q.pointer16()? {
                None => None,
                Some(mut f) => {
                    f.u16()?;
                    Some(f.u16_list()?)
                }
            };
            features.push(FeatureRecord { tag, lookups });
        }
    }
    let mut lookups = Vec::new();
    if let Some(mut q) = p.pointer16()? {
        let count = q.u16()? as usize;
        for _ in 0..count {
            lookups.push(optional(q.pointer16()?, parse_lookup)?);
        }
    }
    if version == 1.1 {
        if let Some(mut q) = p.pointer32()? {
            let major = q.u16()?;
            let minor = q.u16()?;
            if major != 1 || minor >= 1 {
                return Err(FontError::Invalid("GPOS feature variations table unknown"));
            }
            let count = q.u32()? as i64;
            data.slice(q.at(), (count as usize).checked_mul(8).ok_or(FontError::Range)?)?;
        }
    }
    Ok(Gpos { scripts, features, lookups })
}

/// `Layout.searchTag`'s binary search over records sorted by tag.
fn search_tag<T>(records: &[(Tag, T)], tag: &Tag) -> Option<usize> {
    let (mut min, mut max) = (0i64, records.len() as i64 - 1);
    while min <= max {
        let mid = ((min + max) as u64 >> 1) as i64;
        match records[mid as usize].0.cmp(tag) {
            std::cmp::Ordering::Equal => return Some(mid as usize),
            std::cmp::Ordering::Less => min = mid + 1,
            std::cmp::Ordering::Greater => max = mid - 1,
        }
    }
    None
}

impl Gpos {
    /// `getDefaultScriptName()` then `getKerningTables(script)`: the type-2 lookups of the default language system's
    /// first `kern` feature, as indexes into `lookups`. An empty result is still a `GPOS` answer ("no kerning").
    pub fn kerning_lookups(&self) -> R<Vec<usize>> {
        let mut has_latn = false;
        let mut script_name: Option<&[u8; 4]> = None;
        for (tag, _) in &self.scripts {
            if tag == b"DFLT" {
                script_name = Some(tag);
                break;
            }
            if tag == b"latn" {
                has_latn = true;
            }
        }
        if script_name.is_none() && has_latn {
            script_name = Some(b"latn");
        }
        let wanted: Tag = script_name.copied().unwrap_or(*b"DFLT");
        let Some(position) = search_tag(&self.scripts, &wanted) else { return Ok(Vec::new()) };
        let Some(script) = &self.scripts[position].1 else { return Ok(Vec::new()) };
        let Some(lang_sys) = &script.default_lang_sys else { return Ok(Vec::new()) };
        let mut feature_lookups = None;
        for &index in &lang_sys.feature_indexes {
            let record = self.features.get(index as usize).ok_or(FontError::Invalid("feature index out of range"))?;
            if &record.tag == b"kern" {
                feature_lookups = Some(record.lookups.as_ref());
                break;
            }
        }
        let Some(Some(indexes)) = feature_lookups else { return Ok(Vec::new()) };
        let mut found = Vec::new();
        for &index in indexes {
            let lookup = self
                .lookups
                .get(index as usize)
                .and_then(|l| l.as_ref())
                .ok_or(FontError::Invalid("lookup index out of range"))?;
            if lookup.lookup_type == 2 {
                found.push(index as usize);
            }
        }
        Ok(found)
    }

    /// `Position.getKerningValue(kerningLookups, left, right)` in font units.
    pub fn kerning_value(&self, lookups: &[usize], left: usize, right: usize) -> R<f64> {
        let (left, right) = (left as u32, right as u32);
        for &index in lookups {
            let lookup = self.lookups[index].as_ref().expect("checked by kerning_lookups");
            for subtable in &lookup.subtables {
                let subtable = subtable.as_ref().ok_or(FontError::Invalid("missing GPOS subtable"))?;
                match subtable {
                    PairPos::Glyphs { coverage, sets } => {
                        let coverage = coverage.as_ref().ok_or(FontError::Invalid("missing GPOS coverage"))?;
                        let Some(cov) = coverage_index(coverage, left) else { continue };
                        let set = sets
                            .get(cov)
                            .and_then(|s| s.as_ref())
                            .ok_or(FontError::Invalid("missing GPOS pair set"))?;
                        for &(second, advance) in set {
                            if second as u32 == right {
                                return Ok(advance as f64);
                            }
                        }
                    }
                    PairPos::Classes { coverage, class_def1, class_def2, class1_count, class2_count, advances } => {
                        let coverage = coverage.as_ref().ok_or(FontError::Invalid("missing GPOS coverage"))?;
                        if coverage_index(coverage, left).is_none() {
                            continue;
                        }
                        let c1 = glyph_class(class_def1.as_ref().ok_or(FontError::Invalid("missing class definition"))?, left);
                        let c2 = glyph_class(class_def2.as_ref().ok_or(FontError::Invalid("missing class definition"))?, right);
                        if c1 >= *class1_count || c2 >= *class2_count {
                            return Err(FontError::Invalid("GPOS class out of range"));
                        }
                        return Ok(advances[c1 * class2_count + c2] as f64);
                    }
                }
            }
        }
        Ok(0.0)
    }
}

/// `Layout.getCoverageIndex`: `None` for -1.
fn coverage_index(coverage: &Coverage, glyph: u32) -> Option<usize> {
    match coverage {
        Coverage::List(glyphs) => {
            let (mut min, mut max) = (0i64, glyphs.len() as i64 - 1);
            while min <= max {
                let mid = ((min + max) as u64 >> 1) as usize;
                let value = glyphs[mid] as u32;
                if value == glyph {
                    return Some(mid);
                } else if value < glyph {
                    min = mid as i64 + 1;
                } else {
                    max = mid as i64 - 1;
                }
            }
            None
        }
        Coverage::Ranges(ranges) => {
            let range = search_range(ranges, glyph)?;
            let index = range.value as i64 + glyph as i64 - range.start as i64;
            usize::try_from(index).ok()
        }
    }
}

/// `Layout.getGlyphClass`.
fn glyph_class(def: &ClassDef, glyph: u32) -> usize {
    match def {
        ClassDef::List { start_glyph, classes } => {
            let start = *start_glyph as u32;
            if start <= glyph && (glyph as usize) < start as usize + classes.len() {
                classes[(glyph - start) as usize] as usize
            } else {
                0
            }
        }
        ClassDef::Ranges(ranges) => search_range(ranges, glyph).map_or(0, |r| r.value as usize),
    }
}

/// `searchRange`: binary search by range start, then the range before the insertion point if it still covers the value.
fn search_range(ranges: &[RangeRecord], value: u32) -> Option<&RangeRecord> {
    let (mut min, mut max) = (0i64, ranges.len() as i64 - 1);
    while min <= max {
        let mid = ((min + max) as u64 >> 1) as usize;
        let start = ranges[mid].start as u32;
        if start == value {
            return Some(&ranges[mid]);
        } else if start < value {
            min = mid as i64 + 1;
        } else {
            max = mid as i64 - 1;
        }
    }
    if min > 0 {
        let range = &ranges[min as usize - 1];
        if value > range.end as u32 {
            return None;
        }
        return Some(range);
    }
    None
}

// ---- kern -----------------------------------------------------------------------------------------------------

/// The `kern` table's pairs; a later duplicate replaces an earlier one.
pub(crate) fn parse_kern(data: Data, start: i64) -> R<HashMap<(u16, u16), i16>> {
    let mut p = Parser::new(data, start);
    let version = p.u16()?;
    let mut pairs = HashMap::new();
    let read_pairs = |p: &mut Parser, pairs: &mut HashMap<(u16, u16), i16>| -> R<()> {
        let count = p.u16()? as usize;
        p.skip(6);
        for _ in 0..count {
            let left = p.u16()?;
            let right = p.u16()?;
            pairs.insert((left, right), p.i16()?);
        }
        Ok(())
    };
    match version {
        0 => {
            p.skip(2);
            if p.u16()? != 0 {
                return Err(FontError::Invalid("unsupported kern sub-table version"));
            }
            p.skip(4);
            read_pairs(&mut p, &mut pairs)?;
        }
        1 => {
            p.skip(2);
            p.u32()?;
            p.skip(4);
            let coverage = p.u16()?;
            p.skip(2);
            if coverage & 0xff == 0 {
                read_pairs(&mut p, &mut pairs)?;
            }
        }
        _ => return Err(FontError::Invalid("unsupported kern table version")),
    }
    Ok(pairs)
}
