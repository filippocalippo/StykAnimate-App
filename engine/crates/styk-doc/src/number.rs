//! Number text exactly as JavaScript writes it (`Number.prototype.toString`,
//! which `JSON.stringify` uses for finite numbers).

/// Appends `value` as JavaScript would print it. Non-finite numbers are `null`,
/// as in `JSON.stringify`; negative zero is `0`.
pub fn format_number(value: f64, out: &mut Vec<u8>) {
    if !value.is_finite() {
        out.extend_from_slice(b"null");
        return;
    }
    // Small integers dominate documents (ids, colours, counts): skip the general path.
    if value == 0.0 {
        out.push(b'0');
        return;
    }
    let truncated = value as i64;
    if truncated as f64 == value && truncated.unsigned_abs() < 1_000_000_000_000_000 {
        let mut digits = [0u8; 20];
        let mut at = digits.len();
        let mut rest = truncated.unsigned_abs();
        while rest > 0 {
            at -= 1;
            digits[at] = b'0' + (rest % 10) as u8;
            rest /= 10;
        }
        if truncated < 0 {
            out.push(b'-');
        }
        out.extend_from_slice(&digits[at..]);
        return;
    }
    let mut buffer = ryu_js::Buffer::new();
    out.extend_from_slice(buffer.format_finite(value).as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: f64) -> String {
        let mut out = Vec::new();
        format_number(value, &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn matches_javascript_number_text() {
        // Expected values are what `String(x)` prints in V8.
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-17.0, "-17"),
            (255.0, "255"),
            (4294967295.0, "4294967295"),
            (0.1, "0.1"),
            (-0.5, "-0.5"),
            (2.718281828459045e-3, "0.002718281828459045"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1.2e-10, "1.2e-10"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (0.30000000000000004, "0.30000000000000004"),
            (999999999999999.0, "999999999999999"),
            (1000000000000000.0, "1000000000000000"),
            (9007199254740993.0, "9007199254740992"),
            (f64::NAN, "null"),
            (f64::INFINITY, "null"),
        ] {
            assert_eq!(text(value), expected, "{value:e}");
        }
    }
}
