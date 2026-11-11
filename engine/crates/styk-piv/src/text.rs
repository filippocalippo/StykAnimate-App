//! Text encodings of Pivot files: Windows-1252 names and UTF-16 text assets.

/// What the bytes 0x80..0xA0 mean in Windows-1252 (0 where Python's codec has no character).
const CP1252_HIGH: [u16; 32] = [
    0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
    0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

/// `bytes.decode('cp1252', errors='replace')`.
pub(crate) fn cp1252_decode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&byte| match byte {
            0x80..=0x9f => match CP1252_HIGH[(byte - 0x80) as usize] {
                0 => '\u{fffd}',
                code => char::from_u32(code as u32).unwrap_or('\u{fffd}'),
            },
            _ => byte as char,
        })
        .collect()
}

/// `text.encode('cp1252')`, or `None` where Python raises `UnicodeEncodeError`.
pub(crate) fn cp1252_encode(text: &str) -> Option<Vec<u8>> {
    text.chars()
        .map(|ch| {
            let code = ch as u32;
            if code < 0x80 || (0xa0..0x100).contains(&code) {
                return Some(code as u8);
            }
            CP1252_HIGH.iter().position(|&high| high != 0 && high as u32 == code).map(|at| 0x80 + at as u8)
        })
        .collect()
}

/// `bytes.decode('latin-1')`.
pub(crate) fn latin1_decode(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| byte as char).collect()
}

/// UTF-16 code units as text. An unpaired surrogate has no place in the
/// document store's strings and becomes U+FFFD (Python kept it).
pub(crate) fn utf16_decode(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied()).map(|unit| unit.unwrap_or('\u{fffd}')).collect()
}

/// `text.encode('utf-16-le')` as code units.
pub(crate) fn utf16_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_1252_round_trips_and_replaces_undefined_bytes() {
        assert_eq!(cp1252_decode(b"caf\xe9 \x80 \x81"), "caf\u{e9} \u{20ac} \u{fffd}");
        assert_eq!(cp1252_encode("caf\u{e9} \u{20ac}"), Some(b"caf\xe9 \x80".to_vec()));
        assert_eq!(cp1252_encode("\u{fffd}"), None);
        assert_eq!(cp1252_encode("\u{6f22}"), None);
    }
}
