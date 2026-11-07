//! The number field's pure model: stepping, formatting, validation and the gesture baseline.
//!
//! Ports of `propertyStep`, `formatPropertyValue` and the validation of `_typed` in `src/property-controls.mjs`
//! (`tests/property-controls.test.mjs` states the first two).

/// The modifiers that scale a step.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StepKeys {
    pub shift: bool,
    pub alt: bool,
}

/// `step * (shift ? 0.1 : 1) * (alt ? 0.01 : 1)`.
pub fn step(step: f64, keys: StepKeys) -> f64 {
    step * if keys.shift { 0.1 } else { 1.0 } * if keys.alt { 0.01 } else { 1.0 }
}

/// A value as the field shows it: rounded to `precision` digits (0 to 8) with trailing zeros stripped; `-0` is `0` and a
/// value that is not finite is empty.
pub fn format(value: f64, precision: u32) -> String {
    if !value.is_finite() {
        return String::new();
    }
    let digits = precision.min(8) as usize;
    let fixed = to_fixed(value, digits);
    let trimmed = if fixed.contains('.') { fixed.trim_end_matches('0').trim_end_matches('.') } else { fixed.as_str() };
    match trimmed {
        "-0" | "" => "0".to_owned(),
        other => other.to_owned(),
    }
}

/// `Number.prototype.toFixed`: the exact decimal value rounded to `digits` places, a tie going away from zero (Rust's
/// own formatting rounds ties to even, which would show 2.5 as "2" where the app shows "3").
fn to_fixed(value: f64, digits: usize) -> String {
    let long = format!("{:.*}", digits + 40, value.abs());
    let (int, frac) = long.split_once('.').expect("a fixed format has a point");
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes()[digits] >= b'5' {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let (whole, part) = kept.split_at(split);
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    out.push_str(std::str::from_utf8(whole).expect("ascii digits"));
    if digits > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(part).expect("ascii digits"));
    }
    out
}

/// The range a field accepts (`min` and `max` attributes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range {
    pub min: f64,
    pub max: f64,
}

impl Default for Range {
    fn default() -> Range {
        Range { min: f64::NEG_INFINITY, max: f64::INFINITY }
    }
}

impl Range {
    /// Clamps a value to the range.
    pub fn clamp(self, value: f64) -> f64 {
        value.max(self.min).min(self.max)
    }
}

/// Why typed text is not a value (the strings are localized by the interface).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Invalid {
    /// The text is not a finite number (`propertyControls.enterAFiniteNumber`).
    NotANumber,
    /// The number is outside the range (`propertyControls.enterValueBetween`).
    OutOfRange(Range),
}

/// Reads typed text as a value of the field: a finite number inside the range.
pub fn parse(text: &str, range: Range) -> Result<f64, Invalid> {
    let value: f64 = text.trim().parse().map_err(|_| Invalid::NotANumber)?;
    if !value.is_finite() {
        return Err(Invalid::NotANumber);
    }
    if value < range.min || value > range.max {
        return Err(Invalid::OutOfRange(range));
    }
    Ok(value)
}

/// The gesture baseline of a number field: what Escape returns to.
///
/// It is the value before the current gesture, not the value at focus: an arrow step committed without blurring
/// moves it (`_finish` ends the gesture, the next `_begin` takes the new value).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Baseline {
    value: f64,
}

impl Baseline {
    /// A baseline taken from the value when the field is focused.
    pub fn new(value: f64) -> Baseline {
        Baseline { value }
    }

    /// A gesture committed (Enter, an arrow step released, a scrub ended) without leaving the field.
    pub fn committed(&mut self, value: f64) {
        self.value = value;
    }

    /// The value Escape rolls back to.
    pub fn rollback(&self) -> f64 {
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_modifiers_preserve_useful_fractional_units() {
        assert_eq!(step(1.0, StepKeys::default()), 1.0);
        assert_eq!(step(1.0, StepKeys { shift: true, alt: false }), 0.1);
        assert_eq!(step(1.0, StepKeys { shift: false, alt: true }), 0.01);
        assert_eq!(step(1.0, StepKeys { shift: true, alt: true }), 0.001);
    }

    #[test]
    fn values_show_rounded_without_trailing_zeros() {
        assert_eq!(format(23.10000001, 3), "23.1");
        assert_eq!(format(0.0004, 3), "0");
        assert_eq!(format(-0.0, 3), "0");
        assert_eq!(format(-0.0004, 3), "0");
        assert_eq!(format(f64::INFINITY, 2), "");
        assert_eq!(format(f64::NAN, 2), "");
        assert_eq!(format(12.0, 2), "12");
        assert_eq!(format(-1.5, 2), "-1.5");
        assert_eq!(format(1.123456789123, 20), "1.12345679", "precision is clamped to 8 digits");
        assert_eq!(format(1234.5, 0), "1235", "a tie rounds away from zero, as toFixed does");
        assert_eq!(format(2.5, 0), "3");
        assert_eq!(format(-2.5, 0), "-3");
        assert_eq!(format(0.125, 2), "0.13");
        assert_eq!(format(9.995, 2), "9.99", "9.995 is below the tie in binary, as in JavaScript");
        assert_eq!(format(99.999, 2), "100");
    }

    #[test]
    fn typed_text_is_a_finite_number_inside_the_range() {
        let range = Range { min: 0.0, max: 100.0 };
        assert_eq!(parse("42.5", range), Ok(42.5));
        assert_eq!(parse(" 7 ", range), Ok(7.0));
        assert_eq!(parse("abc", range), Err(Invalid::NotANumber));
        assert_eq!(parse("", range), Err(Invalid::NotANumber));
        assert_eq!(parse("inf", range), Err(Invalid::NotANumber));
        assert_eq!(parse("101", range), Err(Invalid::OutOfRange(range)));
        assert_eq!(parse("-1", range), Err(Invalid::OutOfRange(range)));
        assert_eq!(parse("-1e3", Range::default()), Ok(-1000.0));
        assert_eq!(range.clamp(150.0), 100.0);
    }

    #[test]
    fn escape_returns_to_the_latest_gesture_not_the_value_at_focus() {
        let mut baseline = Baseline::new(10.0);
        // An arrow step commits 11 without blurring; the user then types 50 and presses Escape.
        baseline.committed(11.0);
        assert_eq!(baseline.rollback(), 11.0);
    }
}
