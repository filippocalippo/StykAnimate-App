//! The `name` table as opentype.js reads it: per name id, the text of each language in the order the records were first seen.

use super::names_data::{EIGHT_BIT_MAC, MAC_LANGUAGES, MAC_LANGUAGE_ENCODINGS, MAC_SCRIPT_ENCODINGS, WINDOWS_LANGUAGES};
use super::reader::{Data, Parser, R};

/// The name ids the text tool reads: family (1), subfamily (2), preferred family (16), preferred subfamily (17).
const KEPT: [u16; 4] = [1, 2, 16, 17];

#[derive(Default, Debug, Clone)]
pub struct Names {
    entries: Vec<(u16, Vec<(String, String)>)>,
}

fn lookup(table: &[(u16, &'static str)], key: u16) -> Option<&'static str> {
    table.binary_search_by_key(&key, |e| e.0).ok().map(|i| table[i].1)
}

impl Names {
    /// `localizedName(font.names[property])`: the English text, else the first text stored.
    pub fn localized(&self, name_id: u16) -> Option<&str> {
        let languages = &self.entries.iter().find(|e| e.0 == name_id)?.1;
        languages
            .iter()
            .find(|(language, _)| language == "en")
            .or_else(|| languages.first())
            .map(|(_, text)| text.as_str())
    }

    fn add(&mut self, name_id: u16, language: &str, text: String) {
        let index = match self.entries.iter().position(|e| e.0 == name_id) {
            Some(i) => i,
            None => {
                self.entries.push((name_id, Vec::new()));
                self.entries.len() - 1
            }
        };
        let languages = &mut self.entries[index].1;
        match languages.iter_mut().find(|(l, _)| l == language) {
            Some(slot) => slot.1 = text,
            None => languages.push((language.to_string(), text)),
        }
    }
}

/// `parseLtagTable`: language tags indexed by the language id of platform 0 records.
pub(crate) fn parse_ltag(data: Data, start: i64) -> R<Vec<String>> {
    let mut p = Parser::new(data, start);
    if p.u32()? != 1 {
        return Err(super::FontError::Invalid("unsupported ltag table version"));
    }
    p.skip(4);
    let count = p.u32()? as usize;
    let mut tags = Vec::new();
    for _ in 0..count {
        let offset = start + p.u16()? as i64;
        let length = p.u16()? as i64;
        let mut tag = String::new();
        for j in offset..offset + length {
            // `String.fromCharCode(data.getInt8(j))`: a signed byte, so a high byte is a code unit near 0xffff.
            let unit = data.u8(j)? as i8 as i32 as u16;
            tag.push(char::from_u32(unit as u32).unwrap_or('\u{fffd}'));
        }
        tags.push(tag);
    }
    Ok(tags)
}

fn mac_encoding(language_id: u16, encoding_id: u16) -> Option<&'static str> {
    lookup(MAC_LANGUAGE_ENCODINGS, language_id).or_else(|| lookup(MAC_SCRIPT_ENCODINGS, encoding_id))
}

fn decode_mac(data: Data, offset: i64, length: usize, encoding: &str) -> R<Option<String>> {
    let Some((_, table)) = EIGHT_BIT_MAC.iter().find(|(name, _)| *name == encoding) else { return Ok(None) };
    let mut units: Vec<u16> = Vec::with_capacity(length);
    for i in 0..length as i64 {
        let c = data.u8(offset + i)?;
        if c <= 0x7f {
            units.push(c as u16);
        } else {
            match table.get((c & 0x7f) as usize) {
                Some(&unit) => units.push(unit),
                None => units.extend("undefined".encode_utf16()),
            }
        }
    }
    Ok(Some(String::from_utf16_lossy(&units)))
}

fn decode_utf16(data: Data, offset: i64, byte_length: usize) -> R<String> {
    let units = byte_length.div_ceil(2);
    let mut out = Vec::with_capacity(units);
    for j in 0..units as i64 {
        out.push(data.u16(offset + 2 * j)?);
    }
    Ok(String::from_utf16_lossy(&out))
}

pub(crate) fn parse_name_table(data: Data, start: i64, ltag: Option<&[String]>) -> R<Names> {
    let mut p = Parser::new(data, start);
    let _format = p.u16()?;
    let count = p.u16()?;
    let string_offset = p.offset + p.u16()? as i64;
    let mut names = Names::default();
    for _ in 0..count {
        let platform = p.u16()?;
        let encoding_id = p.u16()?;
        let language_id = p.u16()?;
        let name_id = p.u16()?;
        let byte_length = p.u16()? as usize;
        let offset = p.u16()? as i64;
        let language: Option<String> = match platform {
            0 if language_id == 0xffff => Some("und".to_string()),
            0 => ltag.and_then(|tags| tags.get(language_id as usize).cloned()),
            1 => lookup(MAC_LANGUAGES, language_id).map(str::to_string),
            3 => lookup(WINDOWS_LANGUAGES, language_id).map(str::to_string),
            _ => None,
        };
        let utf16 = match platform {
            0 => Some(true),
            1 => None,
            3 if encoding_id == 1 || encoding_id == 10 => Some(true),
            _ => continue,
        };
        let Some(language) = language else { continue };
        let at = string_offset + offset;
        let text = if utf16.is_some() {
            Some(decode_utf16(data, at, byte_length)?)
        } else {
            match mac_encoding(language_id, encoding_id) {
                Some(encoding) => decode_mac(data, at, byte_length, encoding)?,
                None => continue,
            }
        };
        if let Some(text) = text {
            if !text.is_empty() && KEPT.contains(&name_id) {
                names.add(name_id, &language, text);
            }
        }
    }
    Ok(names)
}
