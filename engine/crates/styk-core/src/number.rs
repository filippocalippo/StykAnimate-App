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

/// How a gesture on a number field began (`gesture.source` in `property-controls.mjs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    /// The field took focus: typing and the arrows inside it.
    Input,
    /// A drag of the scrub label.
    Scrub,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Gesture {
    source: Source,
    /// The value the gesture started from: what cancelling returns to.
    initial: f64,
    /// A scrub's running value before rounding.
    accumulator: f64,
    /// An arrow key is held: the gesture ends at its release.
    stepping: bool,
}

/// What ending a gesture did to the value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Settled {
    /// Nothing changed (or there was no gesture).
    Unchanged,
    /// The new value was committed: one history entry.
    Committed(f64),
    /// The gesture was cancelled and the value went back.
    Cancelled(f64),
}

/// The model of one number field: a port of `PropertyControls` in `src/property-controls.mjs`.
///
/// Focusing the field begins a gesture; typing previews valid text and marks invalid text; Enter commits and the owner
/// blurs; **leaving the field commits valid text and reverts invalid text** (`_focusOut`); Escape cancels the gesture
/// and keeps focus; a scrub accumulates every pointer movement with *its own* modifiers (a change of Shift mid-drag
/// does not rescale what was already travelled); an arrow key held is one gesture that ends at its release.
#[derive(Clone, Debug, PartialEq)]
pub struct NumberEdit {
    range: Range,
    precision: u32,
    step: f64,
    value: f64,
    gesture: Option<Gesture>,
    typed: Option<String>,
    invalid: Option<Invalid>,
}

impl NumberEdit {
    /// The step modifiers as a value.
    pub fn step_keys(shift: bool, alt: bool) -> StepKeys {
        StepKeys { shift, alt }
    }

    /// A field showing `value`, stepping by `step` per arrow press or per pixel of scrub, shown with `precision` digits.
    pub fn new(value: f64, range: Range, step: f64, precision: u32) -> NumberEdit {
        NumberEdit { range, precision, step, value, gesture: None, typed: None, invalid: None }
    }

    /// The value in the document.
    pub fn value(&self) -> f64 {
        self.value
    }

    /// Why the typed text is not a value, if it is not.
    pub fn invalid(&self) -> Option<Invalid> {
        self.invalid
    }

    /// Whether a gesture (typing, a scrub, a held key) is open.
    pub fn gesture_open(&self) -> bool {
        self.gesture.is_some()
    }

    /// The text the field shows: what is being typed, else the value.
    pub fn text(&self) -> String {
        self.typed.clone().unwrap_or_else(|| format(self.value, self.precision))
    }

    /// The document changed under the field (an undo, another selection): a new value, no gesture.
    pub fn set_value(&mut self, value: f64) {
        self.value = value;
        self.gesture = None;
        self.typed = None;
        self.invalid = None;
    }

    fn round(&self, value: f64) -> f64 {
        format(self.range.clamp(value), self.precision).parse().unwrap_or(value)
    }

    fn begin(&mut self, source: Source) -> &mut Gesture {
        let value = self.value;
        self.gesture.get_or_insert(Gesture { source, initial: value, accumulator: value, stepping: false })
    }

    /// The field took focus: a gesture begins (so Escape has something to cancel).
    pub fn focus(&mut self) {
        self.typed = None;
        self.invalid = None;
        self.begin(Source::Input);
    }

    /// The text of the input changed (the user typed or pasted).
    pub fn input(&mut self, text: String) {
        self.begin(Source::Input);
        match parse(&text, self.range) {
            Ok(value) => {
                self.value = value;
                self.invalid = None;
            }
            Err(error) => self.invalid = Some(error),
        }
        self.typed = Some(text);
    }

    fn settle(&mut self, commit: bool) -> Settled {
        let Some(gesture) = self.gesture.take() else {
            self.typed = None;
            return Settled::Unchanged;
        };
        let changed = self.value != gesture.initial;
        let outcome = if commit && changed && self.invalid.is_none() {
            Settled::Committed(self.value)
        } else if changed || self.invalid.is_some() {
            self.value = gesture.initial;
            Settled::Cancelled(gesture.initial)
        } else {
            Settled::Unchanged
        };
        self.typed = None;
        self.invalid = None;
        outcome
    }

    /// Enter in the input: the typed text is committed (the owner then takes focus away).
    pub fn enter(&mut self) -> Settled {
        self.settle(true)
    }

    /// The field lost focus: valid text is committed, invalid text reverted.
    pub fn blur(&mut self) -> Settled {
        match self.gesture.map(|g| g.source) {
            Some(Source::Input) => self.settle(true),
            Some(Source::Scrub) | None => Settled::Unchanged,
        }
    }

    /// Escape: the gesture is cancelled and the value goes back; the field keeps focus (a new gesture begins at the
    /// next edit).
    pub fn escape(&mut self) -> Settled {
        let outcome = self.settle(false);
        self.begin(Source::Input);
        outcome
    }

    /// A press on the scrub label: a scrub begins (it ends the open input gesture first, committing it).
    pub fn scrub_begin(&mut self) -> Settled {
        let settled = if self.gesture.is_some() { self.settle(true) } else { Settled::Unchanged };
        self.begin(Source::Scrub);
        settled
    }

    /// The pointer moved `dx` pixels since the last move, with these modifiers.
    pub fn scrub_move(&mut self, dx: f64, keys: StepKeys) {
        let step = self.step;
        let range = self.range;
        let Some(gesture) = self.gesture.as_mut().filter(|g| g.source == Source::Scrub) else {
            return;
        };
        gesture.accumulator = range.clamp(gesture.accumulator + dx * crate::number::step(step, keys));
        let accumulator = gesture.accumulator;
        self.value = self.round(accumulator);
        self.typed = None;
    }

    /// The pointer was released: the scrub is committed.
    pub fn scrub_end(&mut self) -> Settled {
        match self.gesture.map(|g| g.source) {
            Some(Source::Scrub) => self.settle(true),
            _ => Settled::Unchanged,
        }
    }

    /// The scrub was abandoned (Escape, the window lost focus, capture lost, the label removed or disabled): the value
    /// goes back.
    pub fn scrub_cancel(&mut self) -> Settled {
        match self.gesture.map(|g| g.source) {
            Some(Source::Scrub) => self.settle(false),
            _ => Settled::Unchanged,
        }
    }

    /// An arrow key (`direction` +1 up, -1 down): one step; holding it is one gesture.
    pub fn key_step(&mut self, direction: i32, keys: StepKeys) {
        if self.gesture.is_some_and(|g| g.source == Source::Scrub) {
            return;
        }
        self.begin(Source::Input).stepping = true;
        self.value = self.round(self.value + f64::from(direction) * crate::number::step(self.step, keys));
        self.typed = None;
        self.invalid = None;
    }

    /// An arrow key was released: the gesture it made is committed.
    pub fn key_release(&mut self) -> Settled {
        if self.gesture.is_some_and(|g| g.stepping) { self.settle(true) } else { Settled::Unchanged }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: StepKeys = StepKeys { shift: false, alt: false };
    const SHIFT: StepKeys = StepKeys { shift: true, alt: false };

    fn edit() -> NumberEdit {
        NumberEdit::new(10.0, Range { min: 0.0, max: 100.0 }, 0.1, 2)
    }

    #[test]
    fn leaving_the_field_commits_valid_text_and_reverts_invalid_text() {
        let mut field = edit();
        field.focus();
        field.input("12.5".into());
        assert_eq!(field.value(), 12.5, "a valid text previews");
        assert_eq!(field.blur(), Settled::Committed(12.5));
        assert_eq!(field.text(), "12.5");
        field.focus();
        field.input("abc".into());
        assert_eq!(field.invalid(), Some(Invalid::NotANumber));
        assert_eq!(field.blur(), Settled::Cancelled(12.5));
        assert_eq!(field.text(), "12.5", "the invalid text is gone");
        field.focus();
        assert_eq!(field.blur(), Settled::Unchanged, "focusing and leaving changes nothing");
    }

    #[test]
    fn escape_cancels_the_gesture_and_the_field_stays_editable() {
        let mut field = edit();
        field.focus();
        field.input("50".into());
        assert_eq!(field.escape(), Settled::Cancelled(10.0));
        assert_eq!(field.value(), 10.0);
        assert_eq!(field.text(), "10");
        field.input("60".into());
        assert_eq!(field.enter(), Settled::Committed(60.0));
    }

    #[test]
    fn escape_returns_to_the_latest_commit_not_the_value_at_focus() {
        let mut field = edit();
        field.focus();
        field.key_step(1, NumberEdit::step_keys(false, false));
        assert_eq!(field.key_release(), Settled::Committed(10.1));
        field.input("50".into());
        assert_eq!(field.escape(), Settled::Cancelled(10.1));
    }

    #[test]
    fn a_scrub_accumulates_every_movement_with_its_own_modifiers() {
        let mut field = edit();
        field.scrub_begin();
        field.scrub_move(10.0, PLAIN);
        assert_eq!(field.value(), 11.0);
        field.scrub_move(1.0, SHIFT);
        assert_eq!(field.value(), 11.01, "one more pixel with Shift adds a hundredth, it does not rescale the 10 before");
        assert_eq!(field.scrub_end(), Settled::Committed(11.01));
    }

    #[test]
    fn a_scrub_stays_inside_the_range_and_remembers_the_overshoot_as_today_does() {
        let mut field = edit();
        field.scrub_begin();
        field.scrub_move(10_000.0, PLAIN);
        assert_eq!(field.value(), 100.0);
        field.scrub_move(-5.0, PLAIN);
        assert_eq!(field.value(), 99.5, "the accumulator was clamped, so the way back starts at the limit");
    }

    #[test]
    fn a_scrub_has_exactly_one_terminal_result() {
        let mut field = edit();
        field.scrub_begin();
        field.scrub_move(20.0, PLAIN);
        assert_eq!(field.scrub_cancel(), Settled::Cancelled(10.0));
        assert_eq!(field.value(), 10.0);
        assert_eq!(field.scrub_cancel(), Settled::Unchanged, "a second cancel (the label was removed, then capture lost)");
        assert_eq!(field.scrub_end(), Settled::Unchanged, "and a release after it");
    }

    #[test]
    fn a_held_arrow_is_one_gesture_that_ends_at_its_release() {
        let mut field = edit();
        field.focus();
        for _ in 0..3 {
            field.key_step(1, PLAIN);
        }
        assert_eq!(field.value(), 10.3);
        assert_eq!(field.key_release(), Settled::Committed(10.3));
        assert_eq!(field.key_release(), Settled::Unchanged);
    }

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
