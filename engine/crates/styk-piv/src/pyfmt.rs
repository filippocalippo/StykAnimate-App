//! Number text exactly as Python prints it.
//!
//! Document fingerprints hash Python's JSON text, and SVG paths in decoded text
//! assets were built with `format(x, '.9g')`, so both spellings are part of the
//! contract.

/// Up to 17 significant digits, without heap allocation.
#[derive(Clone, Copy)]
struct Digits {
    bytes: [u8; 24],
    len: usize,
}

impl Digits {
    fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

/// The shortest digits that round-trip `value` (which must be finite and not
/// zero), and the position of the decimal point: `0.DIGITS x 10^point`.
fn shortest_digits(value: f64) -> (Digits, i32) {
    let mut buffer = ryu_js::Buffer::new();
    let text = buffer.format_finite(value.abs()).as_bytes();
    let (mantissa, exponent) = match text.iter().position(|&b| b == b'e') {
        Some(at) => {
            let (sign, magnitude) = match text[at + 1] {
                b'-' => (-1, &text[at + 2..]),
                b'+' => (1, &text[at + 2..]),
                _ => (1, &text[at + 1..]),
            };
            (&text[..at], sign * magnitude.iter().fold(0i32, |n, &d| n * 10 + (d - b'0') as i32))
        }
        None => (text, 0),
    };
    let dot = mantissa.iter().position(|&b| b == b'.').unwrap_or(mantissa.len());
    let mut digits = Digits { bytes: [0; 24], len: 0 };
    let mut point = dot as i32 + exponent;
    let mut leading = true;
    for &byte in mantissa {
        if byte == b'.' {
            continue;
        }
        if leading && byte == b'0' {
            // A leading zero moves the decimal point instead of counting as a digit.
            point -= 1;
            continue;
        }
        leading = false;
        if digits.len < digits.bytes.len() {
            digits.bytes[digits.len] = byte;
            digits.len += 1;
        }
    }
    while digits.len > 1 && digits.bytes[digits.len - 1] == b'0' {
        digits.len -= 1;
    }
    if digits.len == 0 {
        digits.bytes[0] = b'0';
        digits.len = 1;
    }
    (digits, point)
}

fn push_exponent(out: &mut Vec<u8>, exponent: i32) {
    out.push(b'e');
    out.push(if exponent < 0 { b'-' } else { b'+' });
    let magnitude = exponent.unsigned_abs();
    if magnitude < 10 {
        out.push(b'0');
    }
    out.extend_from_slice(magnitude.to_string().as_bytes());
}

/// `repr(float)`: `1.0`, `0.1`, `1e-05`, `1e+16`, `-0.0`.
pub(crate) fn float_repr_into(value: f64, out: &mut Vec<u8>) {
    if value.is_nan() {
        out.extend_from_slice(b"nan");
        return;
    }
    if value.is_sign_negative() {
        out.push(b'-');
    }
    if value.is_infinite() {
        out.extend_from_slice(b"inf");
        return;
    }
    if value == 0.0 {
        out.extend_from_slice(b"0.0");
        return;
    }
    let (digits, point) = shortest_digits(value);
    let digits = digits.as_slice();
    let count = digits.len() as i32;
    if point <= -4 || point > 16 {
        out.push(digits[0]);
        if count > 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..]);
        }
        push_exponent(out, point - 1);
    } else if point <= 0 {
        out.extend_from_slice(b"0.");
        out.extend(std::iter::repeat_n(b'0', (-point) as usize));
        out.extend_from_slice(digits);
    } else if point >= count {
        out.extend_from_slice(digits);
        out.extend(std::iter::repeat_n(b'0', (point - count) as usize));
        out.extend_from_slice(b".0");
    } else {
        out.extend_from_slice(&digits[..point as usize]);
        out.push(b'.');
        out.extend_from_slice(&digits[point as usize..]);
    }
}

pub(crate) fn float_repr(value: f64) -> String {
    let mut out = Vec::new();
    float_repr_into(value, &mut out);
    String::from_utf8(out).unwrap_or_default()
}

/// Whether a number is what Python held as an `int` once the document went
/// through a JavaScript client: any finite value without a fraction.
#[inline]
pub(crate) fn is_integral(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

/// A document number as Python's JSON writer prints it once integral floats are
/// integers: every digit of an integer (`1e+22` is `10000000000000000000000`),
/// `repr` for the rest. Negative zero is `0`.
pub(crate) fn py_number_into(value: f64, out: &mut Vec<u8>) {
    if !is_integral(value) {
        float_repr_into(value, out);
        return;
    }
    if value == 0.0 {
        out.push(b'0');
        return;
    }
    if value.abs() < 9.0e15 {
        let mut digits = [0u8; 20];
        let mut at = digits.len();
        let mut rest = value.abs() as u64;
        while rest > 0 {
            at -= 1;
            digits[at] = b'0' + (rest % 10) as u8;
            rest /= 10;
        }
        if value < 0.0 {
            out.push(b'-');
        }
        out.extend_from_slice(&digits[at..]);
        return;
    }
    // Rust prints the exact decimal expansion of a double.
    out.extend_from_slice(format!("{value:.0}").as_bytes());
}

pub(crate) fn py_number(value: f64) -> String {
    let mut out = Vec::new();
    py_number_into(value, &mut out);
    String::from_utf8(out).unwrap_or_default()
}

/// Nine significant digits of `value` (finite, not zero), correctly rounded,
/// and the decimal exponent of the first one.
fn nine_digits(value: f64) -> (Vec<u8>, i32) {
    let exact = || {
        // Rust prints the correctly rounded digits of the exact binary value.
        let text = format!("{:.8e}", value.abs());
        let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
        let mut exact: Vec<u8> = mantissa.bytes().filter(|b| b.is_ascii_digit()).collect();
        while exact.len() > 1 && exact.last() == Some(&b'0') {
            exact.pop();
        }
        (exact, exponent.parse().unwrap_or(0))
    };
    if value.abs() < f64::MIN_POSITIVE {
        // A subnormal has fewer than nine digits of precision: its shortest digits say nothing.
        return exact();
    }
    let (shortest, point) = shortest_digits(value);
    if shortest.len <= 9 {
        return (shortest.as_slice().to_vec(), point - 1);
    }
    // Rounding the shortest round-trip digits gives the correctly rounded result
    // unless they end exactly on a tie, which the exact conversion settles.
    let rest = &shortest.as_slice()[9..];
    if rest == b"5" {
        return exact();
    }
    let up = rest[0] > b'5' || (rest[0] == b'5' && rest.len() > 1);
    let mut digits = shortest.as_slice()[..9].to_vec();
    let mut exponent = point - 1;
    if up {
        let mut at = 9;
        loop {
            if at == 0 {
                digits.insert(0, b'1');
                digits.pop();
                exponent += 1;
                break;
            }
            at -= 1;
            if digits[at] == b'9' {
                digits[at] = b'0';
            } else {
                digits[at] += 1;
                break;
            }
        }
    }
    while digits.len() > 1 && digits.last() == Some(&b'0') {
        digits.pop();
    }
    (digits, exponent)
}

/// `format(value, '.9g')`.
pub(crate) fn g9_into(value: f64, out: &mut Vec<u8>) {
    if value.is_nan() {
        out.extend_from_slice(b"nan");
        return;
    }
    if value.is_sign_negative() {
        out.push(b'-');
    }
    if value.is_infinite() {
        out.extend_from_slice(b"inf");
        return;
    }
    if value == 0.0 {
        out.push(b'0');
        return;
    }
    let (digits, exponent) = nine_digits(value);
    if !(-4..9).contains(&exponent) {
        out.push(digits[0]);
        if digits.len() > 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..]);
        }
        push_exponent(out, exponent);
    } else if exponent < 0 {
        out.extend_from_slice(b"0.");
        out.extend(std::iter::repeat_n(b'0', (-exponent - 1) as usize));
        out.extend_from_slice(&digits);
    } else {
        let whole = exponent as usize + 1;
        if digits.len() <= whole {
            out.extend_from_slice(&digits);
            out.extend(std::iter::repeat_n(b'0', whole - digits.len()));
        } else {
            out.extend_from_slice(&digits[..whole]);
            out.push(b'.');
            out.extend_from_slice(&digits[whole..]);
        }
    }
}

/// Python's `round(x)`: to the nearest integer, ties to even.
pub(crate) fn py_round(value: f64) -> f64 {
    value.round_ties_even()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g9(value: f64) -> String {
        let mut out = Vec::new();
        g9_into(value, &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn float_repr_matches_python() {
        // Expected values are `repr(x)` in CPython 3.12.
        for (value, expected) in [
            (1.0, "1.0"),
            (-0.0, "-0.0"),
            (0.1, "0.1"),
            (1e-5, "1e-05"),
            (0.0001, "0.0001"),
            (1.5e-7, "1.5e-07"),
            (1e16, "1e+16"),
            (9999999999999998.0, "9999999999999998.0"),
            (1.2345678901234568e17, "1.2345678901234568e+17"),
            (14.0, "14.0"),
            (0.10000000149011612, "0.10000000149011612"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (123.456, "123.456"),
            (-1.5707963267948968, "-1.5707963267948968"),
            (1e22, "1e+22"),
            (0.001, "0.001"),
        ] {
            assert_eq!(float_repr(value), expected);
        }
    }

    #[test]
    fn document_numbers_print_as_python_integers_when_integral() {
        for (value, expected) in [
            (1.0, "1"),
            (-0.0, "0"),
            (-17.0, "-17"),
            (1e22, "10000000000000000000000"),
            (1e23, "99999999999999991611392"),
            (9007199254740992.0, "9007199254740992"),
            (1.25, "1.25"),
            (1e-7, "1e-07"),
        ] {
            assert_eq!(py_number(value), expected);
        }
    }

    #[test]
    fn nine_significant_digits_match_python_format() {
        // Expected values are `format(x, '.9g')` in CPython 3.12.
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "-0"),
            (1.0, "1"),
            (0.5, "0.5"),
            (123456789.0, "123456789"),
            (1234567890.0, "1.23456789e+09"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (-32768.25, "-32768.25"),
            (1.0 / 3.0, "0.333333333"),
            (100.0, "100"),
            (2.5e-10, "2.5e-10"),
            (999999999.5, "1e+09"),
            (12.300000190734863, "12.3000002"),
            (0.1234567885, "0.123456788"),
            (0.1234567895, "0.123456789"),
            (2.5000000005, "2.5"),
            (99999.99995, "99999.9999"),
            (1234567.125, "1234567.12"),
            (32768.0000005, "32768"),
        ] {
            assert_eq!(g9(value), expected, "{value}");
        }
    }
}
