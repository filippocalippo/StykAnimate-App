//! Reading the flat JSON lines of the Video for Windows helper (`native/VFW.md`): no nested values of the keys we read.

/// The string value of `"key":"..."`.
pub fn json_text(line: &str, key: &str) -> Option<String> {
    let start = line.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = line[start..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                other => out.push(other),
            },
            other => out.push(other),
        }
    }
    None
}

/// The unsigned integer value of `"key":123`.
pub fn json_number(line: &str, key: &str) -> Option<u64> {
    let start = line.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = line[start..].trim_start().strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// The value of `"key":true|false`.
pub fn json_bool(line: &str, key: &str) -> Option<bool> {
    let start = line.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = line[start..].trim_start().strip_prefix(':')?.trim_start();
    if rest.starts_with("true") {
        Some(true)
    } else if rest.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_lines_are_read() {
        let line = r#"{"type":"frame","index":12,"bytesWritten":4096,"ok":true,"message":"a \"b\"\nc"}"#;
        assert_eq!(json_text(line, "type").as_deref(), Some("frame"));
        assert_eq!(json_number(line, "index"), Some(12));
        assert_eq!(json_number(line, "bytesWritten"), Some(4096));
        assert_eq!(json_bool(line, "ok"), Some(true));
        assert_eq!(json_text(line, "message").as_deref(), Some("a \"b\"\nc"));
        assert_eq!(json_number(line, "missing"), None);
    }
}
