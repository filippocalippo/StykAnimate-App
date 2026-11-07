//! Installed fonts: the service the text tool's font picker reads, and the checks every font file passes before any
//! parser sees it.
//!
//! The limits are the contract of `desktop/font-service.cjs` and are not tunable here: a font file larger than 32 MiB,
//! a collection larger than 128 MiB or with more than 128 faces, a face with more than 256 tables or a table
//! directory that points outside the file, a name table over 1 MiB, more than 20,000 files in a scan. Faces of a
//! collection are repacked into standalone fonts. Nothing in this module calls the operating system: [`ReadAt`]
//! is the file, and `styk-platform` supplies the directory walk.

use std::cmp::Ordering;
use std::sync::Arc;

/// A font file larger than this is refused, and so is any single face.
pub const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
/// A collection (`.ttc`, `.otc`) larger than this is refused.
pub const MAX_CONTAINER_BYTES: u64 = 128 * 1024 * 1024;
/// The `name` table is read only up to this size.
pub const MAX_NAME_BYTES: u64 = 1024 * 1024;
pub const MAX_TABLES: usize = 256;
/// Faces in one collection.
pub const MAX_FACES: usize = 128;
/// Records of a `name` table that are examined.
pub const MAX_NAME_RECORDS: usize = 4096;
/// A single name string longer than this is ignored.
pub const MAX_NAME_STRING_BYTES: usize = 8192;
/// Files a scan considers, directories it enters, and how deep it goes below a root.
pub const MAX_FILES: usize = 20_000;
pub const MAX_DIRECTORIES: usize = 2048;
pub const MAX_DEPTH: usize = 8;
/// Faces a service lists.
pub const MAX_FONTS: usize = 4096;
/// Recently read fonts a service keeps, and how many bytes they may add up to.
pub const CACHE_COUNT: usize = 8;
pub const CACHE_BYTES: u64 = 64 * 1024 * 1024;
/// Reads in flight beyond which another is refused.
pub const MAX_ACTIVE_READS: usize = 8;

/// An opaque font identifier: `font_` and 32 lowercase hexadecimal digits.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FontId(String);

impl FontId {
    /// Accepts only the shape a service hands out.
    pub fn parse(text: &str) -> Option<FontId> {
        let digits = text.strip_prefix("font_")?;
        (digits.len() == 32 && digits.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then(|| FontId(text.to_string()))
    }

    /// From the first 32 hexadecimal digits of a digest.
    pub fn from_digest_hex(hex: &str) -> FontId {
        FontId(format!("font_{}", &hex[..32]))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for FontId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FontFormat {
    /// TrueType outlines (`glyf`).
    Ttf,
    /// PostScript outlines (`CFF `).
    Otf,
}

/// One face of an installed font, as the picker lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FontFace {
    pub id: FontId,
    pub family: String,
    pub style: String,
    pub full_name: String,
    pub post_script_name: String,
    pub format: FontFormat,
    /// Whether the face lives in a collection file (and is repacked when read).
    pub collection: bool,
    /// The size of the font [`FontService::read`] returns for a standalone file; for a collection face, the size the
    /// repacked directory announces.
    pub byte_length: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FontError {
    /// The caller's cancel callback answered true.
    Cancelled,
    /// Not an id this service hands out.
    InvalidId,
    /// The id is unknown, or its file is gone.
    Unavailable,
    /// The file changed since the scan, or while it was read.
    Changed,
    /// The file or the faces it holds exceed a limit.
    TooLarge,
    /// A table or name offset outside the file.
    InvalidBounds,
    /// Not a font this service reads (signature, table count, outlines).
    Unsupported,
    /// More reads in flight than [`MAX_ACTIVE_READS`].
    TooManyReads,
    Io(String),
}

impl std::fmt::Display for FontError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            FontError::Cancelled => "cancelled",
            FontError::InvalidId => "choose an installed font from the font list",
            FontError::Unavailable => "the installed font is unavailable",
            FontError::Changed => "the installed font changed",
            FontError::TooLarge => "the installed font is too large",
            FontError::InvalidBounds => "invalid installed font table bounds",
            FontError::Unsupported => "unsupported installed font",
            FontError::TooManyReads => "too many installed fonts are being loaded",
            FontError::Io(message) => return write!(f, "{message}"),
        };
        f.write_str(text)
    }
}

impl std::error::Error for FontError {}

/// The installed fonts of the machine. Both calls may take a while and run on a worker; `cancel` is asked often and
/// answers true to stop (the call then returns [`FontError::Cancelled`] and has changed nothing).
pub trait FontService: Send + Sync {
    /// Every readable face, sorted by family, style and id.
    fn list(&self, cancel: &dyn Fn() -> bool) -> Result<Arc<[FontFace]>, FontError>;
    /// The standalone font file of a listed face.
    fn read(&self, id: &FontId, cancel: &dyn Fn() -> bool) -> Result<Arc<[u8]>, FontError>;
}

/// A fixed set of faces and their bytes, for tests.
#[derive(Default)]
pub struct FakeFontService {
    faces: Vec<(FontFace, Arc<[u8]>)>,
}

impl FakeFontService {
    pub fn new(faces: Vec<(FontFace, Vec<u8>)>) -> FakeFontService {
        FakeFontService { faces: faces.into_iter().map(|(face, bytes)| (face, Arc::from(bytes.into_boxed_slice()))).collect() }
    }
}

impl FontService for FakeFontService {
    fn list(&self, cancel: &dyn Fn() -> bool) -> Result<Arc<[FontFace]>, FontError> {
        if cancel() {
            return Err(FontError::Cancelled);
        }
        Ok(self.faces.iter().map(|(face, _)| face.clone()).collect())
    }
    fn read(&self, id: &FontId, cancel: &dyn Fn() -> bool) -> Result<Arc<[u8]>, FontError> {
        if cancel() {
            return Err(FontError::Cancelled);
        }
        self.faces.iter().find(|(face, _)| &face.id == id).map(|(_, bytes)| bytes.clone()).ok_or(FontError::Unavailable)
    }
}

/// `localeCompare` for the picker's order, approximated without a collation library: case-insensitive first, then exact.
pub fn compare_text(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// The list order: family, style, id.
pub fn compare_faces(a: &FontFace, b: &FontFace) -> Ordering {
    compare_text(&a.family, &b.family).then_with(|| compare_text(&a.style, &b.style)).then_with(|| a.id.cmp(&b.id))
}

// ---- reading a file ------------------------------------------------------------------------------------------------

/// A file, read at offsets.
pub trait ReadAt {
    fn len(&self) -> u64;
    /// Fills `buffer` from `offset`; an error when the file is shorter or unreadable.
    fn read_exact_at(&mut self, offset: u64, buffer: &mut [u8]) -> Result<(), FontError>;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl ReadAt for &[u8] {
    fn len(&self) -> u64 {
        <[u8]>::len(self) as u64
    }
    fn read_exact_at(&mut self, offset: u64, buffer: &mut [u8]) -> Result<(), FontError> {
        let end = offset.checked_add(buffer.len() as u64).ok_or(FontError::InvalidBounds)?;
        if end > <[u8]>::len(self) as u64 {
            return Err(FontError::Changed);
        }
        buffer.copy_from_slice(&self[offset as usize..end as usize]);
        Ok(())
    }
}

/// `readRange`: a bounded read. `length` must be within `max`, and the range within the file.
fn read_range(source: &mut dyn ReadAt, offset: u64, length: u64, max: u64) -> Result<Vec<u8>, FontError> {
    let size = source.len();
    if length > max || offset > size || size - offset < length {
        return Err(FontError::InvalidBounds);
    }
    let mut buffer = vec![0u8; length as usize];
    source.read_exact_at(offset, &mut buffer)?;
    Ok(buffer)
}

fn align4(n: u64) -> u64 {
    n.div_ceil(4) * 4
}

#[derive(Clone, Debug)]
struct TableRecord {
    tag: [u8; 4],
    offset: u64,
    length: u64,
}

/// A validated face directory (`faceDirectory`).
#[derive(Clone, Debug)]
pub struct FaceDirectory {
    signature: [u8; 4],
    tables: Vec<TableRecord>,
    /// The size of the face as a standalone file, DSIG included.
    output_size: u64,
    pub format: FontFormat,
}

fn face_directory(source: &mut dyn ReadAt, offset: u64) -> Result<FaceDirectory, FontError> {
    let size = source.len();
    let header = read_range(source, offset, 12, MAX_FONT_BYTES)?;
    let signature = [header[0], header[1], header[2], header[3]];
    let version = u32::from_be_bytes(signature);
    if version != 0x10000 && !matches!(&signature, b"OTTO" | b"true" | b"typ1") {
        return Err(FontError::Unsupported);
    }
    let count = u16::from_be_bytes([header[4], header[5]]) as usize;
    if count == 0 || count > MAX_TABLES {
        return Err(FontError::Unsupported);
    }
    let records = read_range(source, offset + 12, count as u64 * 16, MAX_FONT_BYTES)?;
    let mut tables: Vec<TableRecord> = Vec::with_capacity(count);
    let mut output_size = 12 + count as u64 * 16;
    for chunk in records.chunks_exact(16) {
        let tag = [chunk[0], chunk[1], chunk[2], chunk[3]];
        let table = TableRecord {
            tag,
            offset: u32::from_be_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]) as u64,
            length: u32::from_be_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]) as u64,
        };
        let printable = tag.iter().all(|b| (0x20..=0x7e).contains(b));
        if tables.iter().any(|t| t.tag == tag) || table.offset + table.length > size || table.length > MAX_FONT_BYTES || !printable {
            return Err(FontError::InvalidBounds);
        }
        output_size += align4(table.length);
        tables.push(table);
    }
    let has = |tag: &[u8; 4]| tables.iter().any(|t| &t.tag == tag);
    // opentype.js supports TrueType outlines and CFF1, not bitmap-only or CFF2 fonts.
    if !has(b"cmap") || !has(b"head") || !((has(b"glyf") && has(b"loca")) || has(b"CFF ")) {
        return Err(FontError::Unsupported);
    }
    if output_size > MAX_FONT_BYTES {
        return Err(FontError::TooLarge);
    }
    let format = if has(b"CFF ") { FontFormat::Otf } else { FontFormat::Ttf };
    Ok(FaceDirectory { signature, tables, output_size, format })
}

// ---- names ---------------------------------------------------------------------------------------------------------

/// The upper half of Mac Roman, as the `macintosh` text decoder maps it.
pub const MAC_ROMAN: [u16; 128] = [
    0xc4, 0xc5, 0xc7, 0xc9, 0xd1, 0xd6, 0xdc, 0xe1, 0xe0, 0xe2, 0xe4, 0xe3, 0xe5, 0xe7, 0xe9, 0xe8, 0xea, 0xeb, 0xed, 0xec, 0xee, 0xef, 0xf1,
    0xf3, 0xf2, 0xf4, 0xf6, 0xf5, 0xfa, 0xf9, 0xfb, 0xfc, 0x2020, 0xb0, 0xa2, 0xa3, 0xa7, 0x2022, 0xb6, 0xdf, 0xae, 0xa9, 0x2122, 0xb4, 0xa8,
    0x2260, 0xc6, 0xd8, 0x221e, 0xb1, 0x2264, 0x2265, 0xa5, 0xb5, 0x2202, 0x2211, 0x220f, 0x3c0, 0x222b, 0xaa, 0xba, 0x3a9, 0xe6, 0xf8, 0xbf,
    0xa1, 0xac, 0x221a, 0x192, 0x2248, 0x2206, 0xab, 0xbb, 0x2026, 0xa0, 0xc0, 0xc3, 0xd5, 0x152, 0x153, 0x2013, 0x2014, 0x201c, 0x201d,
    0x2018, 0x2019, 0xf7, 0x25ca, 0xff, 0x178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02, 0x2021, 0xb7, 0x201a, 0x201e, 0x2030, 0xc2,
    0xca, 0xc1, 0xcb, 0xc8, 0xcd, 0xce, 0xcf, 0xcc, 0xd3, 0xd4, 0xf8ff, 0xd2, 0xda, 0xdb, 0xd9, 0x131, 0x2c6, 0x2dc, 0xaf, 0x2d8, 0x2d9,
    0x2da, 0xb8, 0x2dd, 0x2db, 0x2c7,
];

/// `cleanName`: control characters removed, trimmed, at most 240 UTF-16 units.
fn clean_name(value: &str) -> String {
    let stripped: String = value.chars().filter(|c| !matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}')).collect();
    let units: Vec<u16> = js_trim(&stripped).encode_utf16().take(240).collect();
    String::from_utf16_lossy(&units)
}

/// `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
                | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaceNames {
    pub family: String,
    pub style: String,
    pub full_name: String,
    pub post_script_name: String,
}

/// `nameMetadata(buffer, fallback)`: bounded name records, English preferred.
pub fn name_metadata(buffer: &[u8], fallback: &str) -> FaceNames {
    let plain = |family: &str| FaceNames { family: family.to_string(), style: "Regular".to_string(), full_name: family.to_string(), post_script_name: String::new() };
    if buffer.len() < 6 {
        return plain(fallback);
    }
    let u16_at = |at: usize| u16::from_be_bytes([buffer[at], buffer[at + 1]]) as usize;
    let count = u16_at(2);
    let strings = u16_at(4);
    if count > MAX_NAME_RECORDS || 6 + count * 12 > buffer.len() || strings > buffer.len() {
        return plain(fallback);
    }
    let mut names: Vec<(usize, String, u32)> = Vec::new();
    let mut decoded_bytes = 0u64;
    for index in 0..count {
        let at = 6 + index * 12;
        let (platform, encoding, language, name) = (u16_at(at), u16_at(at + 2), u16_at(at + 4), u16_at(at + 6));
        let length = u16_at(at + 8);
        let offset = strings + u16_at(at + 10);
        if ![1, 2, 4, 6, 16, 17].contains(&name) || length > MAX_NAME_STRING_BYTES || offset > buffer.len().saturating_sub(length) || offset + length > buffer.len() || ![0, 1, 3].contains(&platform) {
            continue;
        }
        decoded_bytes += length as u64;
        if decoded_bytes > MAX_NAME_BYTES {
            break;
        }
        let bytes = &buffer[offset..offset + length];
        let text = if platform == 0 || (platform == 3 && [0, 1, 10].contains(&encoding)) {
            // A fatal UTF-16BE decode: an odd length or a lone surrogate drops the record.
            if bytes.len() % 2 != 0 {
                continue;
            }
            let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            match String::from_utf16(&units) {
                Ok(text) => text,
                Err(_) => continue,
            }
        } else if platform == 1 && encoding == 0 {
            let units: Vec<u16> = bytes.iter().map(|&b| if b < 0x80 { b as u16 } else { MAC_ROMAN[(b - 0x80) as usize] }).collect();
            String::from_utf16_lossy(&units)
        } else {
            continue;
        };
        let text = clean_name(&text);
        if text.is_empty() {
            continue;
        }
        let score = (if platform == 3 { 4 } else if platform == 0 { 3 } else { 1 }) + (if language == 0x409 { 8 } else if language == 0 { 2 } else { 0 });
        match names.iter_mut().find(|(n, _, _)| *n == name) {
            Some(existing) if existing.2 < score => *existing = (name, text, score),
            Some(_) => {}
            None => names.push((name, text, score)),
        }
    }
    let get = |id: usize| names.iter().find(|(n, _, _)| *n == id).map(|(_, t, _)| t.as_str());
    let family = get(16).or_else(|| get(1)).unwrap_or(fallback).to_string();
    let style = get(17).or_else(|| get(2)).unwrap_or("Regular").to_string();
    let full_name = match get(4) {
        Some(full) => full.to_string(),
        None => format!("{family}{}", if style == "Regular" { String::new() } else { format!(" {style}") }),
    };
    FaceNames { family, style, full_name, post_script_name: get(6).unwrap_or("").to_string() }
}

// ---- inspecting a file ---------------------------------------------------------------------------------------------

/// One face found in a file.
#[derive(Clone, Debug)]
pub struct InspectedFace {
    pub index: u32,
    pub directory: FaceDirectory,
    pub names: FaceNames,
    /// What [`FontFace::byte_length`] reports.
    pub byte_length: u64,
}

/// The faces of one font file (`_inspect`): validates the container and every face's table directory, and reads the
/// names, before any font parser sees a byte. A face that fails is skipped (and counted in `skipped`); the file
/// failing as a whole is an error. `remaining` is how many more faces the caller can still list.
pub fn inspect_file(
    source: &mut dyn ReadAt,
    display_name: &str,
    remaining: usize,
    cancel: &dyn Fn() -> bool,
    skipped: &mut usize,
) -> Result<(bool, Vec<InspectedFace>), FontError> {
    let size = source.len();
    if size < 12 || size > MAX_CONTAINER_BYTES {
        return Err(FontError::TooLarge);
    }
    let header = read_range(source, 0, 12, MAX_FONT_BYTES)?;
    let collection = &header[0..4] == b"ttcf";
    let mut offsets = vec![0u64];
    if collection {
        let version = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let count = u32::from_be_bytes([header[8], header[9], header[10], header[11]]) as usize;
        if ![0x10000, 0x20000].contains(&version) || count == 0 || count > MAX_FACES {
            return Err(FontError::Unsupported);
        }
        let table = read_range(source, 12, count as u64 * 4, MAX_FONT_BYTES)?;
        offsets = table.chunks_exact(4).map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]) as u64).collect();
    } else if size > MAX_FONT_BYTES {
        return Err(FontError::TooLarge);
    }
    let stem = display_name.rsplit_once('.').map_or(display_name, |(stem, _)| stem);
    let fallback = clean_name(stem);
    let mut faces = Vec::new();
    for (index, &offset) in offsets.iter().enumerate() {
        if faces.len() >= remaining {
            break;
        }
        if cancel() {
            return Err(FontError::Cancelled);
        }
        let face = (|| -> Result<InspectedFace, FontError> {
            let directory = face_directory(source, offset)?;
            let mut names = FaceNames { family: fallback.clone(), style: "Regular".to_string(), full_name: fallback.clone(), post_script_name: String::new() };
            if let Some(table) = directory.tables.iter().find(|t| &t.tag == b"name") {
                if table.length <= MAX_NAME_BYTES {
                    let data = read_range(source, table.offset, table.length, MAX_NAME_BYTES)?;
                    names = name_metadata(&data, &fallback);
                }
            }
            let byte_length = if collection { directory.output_size } else { size };
            Ok(InspectedFace { index: index as u32, directory, names, byte_length })
        })();
        match face {
            Ok(face) => faces.push(face),
            Err(FontError::Cancelled) => return Err(FontError::Cancelled),
            Err(_) => *skipped += 1,
        }
    }
    Ok((collection, faces))
}

fn checksum(bytes: &[u8]) -> u32 {
    let mut sum = 0u32;
    for chunk in bytes.chunks(4) {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
    }
    sum
}

/// `standaloneFace`: one face of a collection as an ordinary font file. Tables sorted by tag, `DSIG` dropped, the head
/// checksum adjustment recomputed.
pub fn standalone_face(source: &mut dyn ReadAt, face: &InspectedFace, cancel: &dyn Fn() -> bool) -> Result<Vec<u8>, FontError> {
    let directory = &face.directory;
    let mut tables: Vec<&TableRecord> = directory.tables.iter().filter(|t| &t.tag != b"DSIG").collect();
    tables.sort_by(|a, b| a.tag.cmp(&b.tag));
    let length = 12 + tables.len() as u64 * 16 + tables.iter().map(|t| align4(t.length)).sum::<u64>();
    if length > MAX_FONT_BYTES {
        return Err(FontError::TooLarge);
    }
    let mut output = vec![0u8; length as usize];
    let n = tables.len();
    let power = 1usize << (usize::BITS - 1 - n.leading_zeros());
    output[0..4].copy_from_slice(&directory.signature);
    output[4..6].copy_from_slice(&(n as u16).to_be_bytes());
    output[6..8].copy_from_slice(&((power * 16) as u16).to_be_bytes());
    output[8..10].copy_from_slice(&(power.trailing_zeros() as u16).to_be_bytes());
    output[10..12].copy_from_slice(&((n * 16 - power * 16) as u16).to_be_bytes());
    let mut offset = 12 + n * 16;
    let mut head_offset = None;
    for (index, table) in tables.iter().enumerate() {
        if cancel() {
            return Err(FontError::Cancelled);
        }
        let mut data = read_range(source, table.offset, table.length, MAX_FONT_BYTES)?;
        let record = 12 + index * 16;
        if &table.tag == b"head" {
            if data.len() < 12 {
                return Err(FontError::Unsupported);
            }
            data[8..12].copy_from_slice(&[0, 0, 0, 0]);
            head_offset = Some(offset);
        }
        output[record..record + 4].copy_from_slice(&table.tag);
        output[record + 4..record + 8].copy_from_slice(&checksum(&data).to_be_bytes());
        output[record + 8..record + 12].copy_from_slice(&(offset as u32).to_be_bytes());
        output[record + 12..record + 16].copy_from_slice(&(data.len() as u32).to_be_bytes());
        output[offset..offset + data.len()].copy_from_slice(&data);
        offset += align4(data.len() as u64) as usize;
    }
    if let Some(at) = head_offset {
        let adjustment = 0xb1b0afbau32.wrapping_sub(checksum(&output));
        output[at + 8..at + 12].copy_from_slice(&adjustment.to_be_bytes());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_one_shape() {
        assert!(FontId::parse("font_0123456789abcdef0123456789abcdef").is_some());
        for bad in ["font_0123", "font_0123456789ABCDEF0123456789abcdef", "x_0123456789abcdef0123456789abcdef", "font_0123456789abcdef0123456789abcdeg"] {
            assert!(FontId::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_fake_service_answers_and_honours_cancel() {
        let face = FontFace {
            id: FontId::parse("font_0123456789abcdef0123456789abcdef").unwrap(),
            family: "A".into(),
            style: "Regular".into(),
            full_name: "A".into(),
            post_script_name: "A".into(),
            format: FontFormat::Ttf,
            collection: false,
            byte_length: 3,
        };
        let service = FakeFontService::new(vec![(face.clone(), vec![1, 2, 3])]);
        assert_eq!(service.list(&|| false).unwrap().len(), 1);
        assert_eq!(&*service.read(&face.id, &|| false).unwrap(), &[1, 2, 3]);
        assert_eq!(service.list(&|| true), Err(FontError::Cancelled));
        assert_eq!(service.read(&FontId::parse("font_ffffffffffffffffffffffffffffffff").unwrap(), &|| false), Err(FontError::Unavailable));
    }
}
