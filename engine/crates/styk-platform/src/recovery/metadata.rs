//! The two-string JSON object written by desktop/recovery.cjs (less than 4 KiB).
//! No general JSON dependency is needed for this fixed sidecar schema.
use std::fmt::Write;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn encode(name: &str, time: &str) -> Vec<u8> {
    fn quoted(text: &str) -> String {
        let mut out = String::from("\"");
        for c in text.chars() { match c {
            '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"),
            c if c < ' ' => { let _ = write!(out, "\\u{:04x}", c as u32); }
            c => out.push(c),
        } }
        out.push('"'); out
    }
    format!("{{\"name\":{},\"savedAt\":{}}}", quoted(name), quoted(time)).into_bytes()
}

pub(super) fn decode(bytes: &[u8]) -> Option<(String, String)> {
    fn ws(text: &mut &str) { *text = text.trim_start_matches([' ', '\t', '\r', '\n']); }
    fn take(text: &mut &str, value: char) -> Option<()> { ws(text); *text = text.strip_prefix(value)?; Some(()) }
    fn unit(text: &mut &str) -> Option<u16> {
        let digits = text.get(..4)?; let value = u16::from_str_radix(digits, 16).ok()?; *text = &text[4..]; Some(value)
    }
    fn string(text: &mut &str) -> Option<String> {
        take(text, '"')?; let mut out = String::new();
        loop {
            let c = text.chars().next()?; *text = &text[c.len_utf8()..];
            match c {
                '"' => return Some(out),
                c if c < ' ' => return None,
                '\\' => {
                    let c = text.chars().next()?; *text = &text[c.len_utf8()..];
                    out.push(match c {
                        '"' | '\\' | '/' => c, 'b' => '\u{8}', 'f' => '\u{c}', 'n' => '\n', 'r' => '\r', 't' => '\t',
                        'u' => {
                            let a = unit(text)?;
                            if (0xd800..=0xdbff).contains(&a) {
                                *text = text.strip_prefix("\\u")?; let b = unit(text)?;
                                if !(0xdc00..=0xdfff).contains(&b) { return None; }
                                char::from_u32(0x10000 + ((u32::from(a) - 0xd800) << 10) + u32::from(b) - 0xdc00)?
                            } else { char::from_u32(u32::from(a))? }
                        }
                        _ => return None,
                    });
                }
                c => out.push(c),
            }
        }
    }
    let mut text = std::str::from_utf8(bytes).ok()?; take(&mut text, '{')?;
    let (mut name, mut time) = (String::new(), String::new());
    ws(&mut text);
    if !text.starts_with('}') { loop {
        let key = string(&mut text)?; take(&mut text, ':')?; let value = string(&mut text)?;
        match key.as_str() { "name" => name = value, "savedAt" => time = value, _ => {} }
        ws(&mut text); if !text.starts_with(',') { break; } take(&mut text, ',')?;
    } }
    take(&mut text, '}')?; ws(&mut text); text.is_empty().then_some((name, time))
}

pub(super) fn file_time(ticks: u64) -> String { iso(ticks.saturating_sub(116_444_736_000_000_000) / 10_000) }
pub(super) fn now() -> String { iso(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64) }
fn iso(milliseconds: u64) -> String {
    // Gregorian civil date from days since 1970; all supported FILETIME dates fit these integers.
    let seconds = milliseconds / 1000; let days = (seconds / 86400) as i64 + 719468;
    let era = days.div_euclid(146097); let day = days - era * 146097;
    let year_of_era = (day - day / 1460 + day / 36524 - day / 146096) / 365;
    let day_of_year = day - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let date = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{date:02}T{:02}:{:02}:{:02}.{:03}Z", seconds / 3600 % 24, seconds / 60 % 60, seconds % 60, milliseconds % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_sidecars_round_trip_unicode_escapes_and_dates() {
        assert_eq!(decode(br#"{"name":"A\uD83D\uDE00\"\\","savedAt":"2026-01-02T03:04:05.006Z"}"#), Some(("A😀\"\\".into(), "2026-01-02T03:04:05.006Z".into())));
        assert_eq!(decode(&encode("Name 日本", "date")), Some(("Name 日本".into(), "date".into())));
        assert_eq!(decode(b"broken"), None);
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_709_164_800_123), "2024-02-29T00:00:00.123Z");
    }
}
