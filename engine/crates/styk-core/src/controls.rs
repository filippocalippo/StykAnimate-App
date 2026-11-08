//! Keyboard behaviour of the controls that are not text (`docs/native/text-input.md` section 4): sliders and selects.
//!
//! Pure models: the interface turns a key into one of these keys, applies the result, and publishes the new value. The
//! models act only on keys the control receives while it holds focus; a control under the pointer takes none.

use crate::number::{StepKeys, step};

/// The keys a slider answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SliderKey {
    Decrease,
    Increase,
    PageDown,
    PageUp,
    Home,
    End,
}

/// The slider's value after `key`: one `step` (scaled by Shift and Alt as the number fields are) for the arrows, ten for
/// the page keys, the ends for Home and End. Always inside `[min, max]`, and on the step grid from `min`.
pub fn slider_value(value: f64, min: f64, max: f64, base_step: f64, key: SliderKey, keys: StepKeys) -> f64 {
    let one = step(base_step, keys);
    let moved = match key {
        SliderKey::Decrease => value - one,
        SliderKey::Increase => value + one,
        SliderKey::PageDown => value - one * 10.0,
        SliderKey::PageUp => value + one * 10.0,
        SliderKey::Home => min,
        SliderKey::End => max,
    };
    settle(moved, min, max)
}

/// A value kept inside `[min, max]` with the floating-point dust of repeated tenths snapped away.
fn settle(value: f64, min: f64, max: f64) -> f64 {
    (value.clamp(min, max) * 1e9).round() / 1e9
}

/// Where `value` sits along the track, 0 at `min` and 1 at `max` (a track of no length reads 0).
pub fn slider_fraction(value: f64, min: f64, max: f64) -> f64 {
    if max > min { ((value - min) / (max - min)).clamp(0.0, 1.0) } else { 0.0 }
}

/// The value a position along the track asks for (`fraction`, 0 at `min` and 1 at `max`, out of range clamped): the nearest
/// point of the step grid from `min`, inside the range. A drag reports positions; this is the one place they become values.
pub fn slider_at(fraction: f64, min: f64, max: f64, base_step: f64) -> f64 {
    let raw = min + fraction.clamp(0.0, 1.0) * (max - min);
    let on_grid = if base_step > 0.0 { min + ((raw - min) / base_step).round() * base_step } else { raw };
    settle(on_grid, min, max)
}

/// The value after one wheel notch of `notch` (up raises it, down lowers it), inside the range.
pub fn slider_wheel(value: f64, min: f64, max: f64, notch: f64, up: bool) -> f64 {
    settle(if up { value + notch } else { value - notch }, min, max)
}

/// The keys a select answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectKey {
    /// Space, Enter or Alt+Down.
    Activate,
    Up,
    Down,
    Home,
    End,
    Escape,
}

/// What a key did to a select.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectOutcome {
    /// Nothing changed.
    None,
    /// The list opened.
    Opened,
    /// The list closed without choosing; focus stays on the select.
    Closed,
    /// The highlighted option moved (the list is open) or the value moved (closed: arrows change the value).
    Moved(usize),
    /// An option was chosen and the list closed.
    Chosen(usize),
}

/// A select's keyboard state: whether its list is open and which option is highlighted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Select {
    pub open: bool,
    pub index: usize,
}

impl Select {
    /// A closed select showing option `index`.
    pub fn new(index: usize) -> Select {
        Select { open: false, index }
    }

    /// Applies a key. `count` options, `skip(i)` marks disabled ones.
    pub fn key(&mut self, key: SelectKey, count: usize, skip: impl Fn(usize) -> bool) -> SelectOutcome {
        if count == 0 {
            return SelectOutcome::None;
        }
        let find = |from: isize, step: isize| -> Option<usize> {
            let mut i = from;
            while i >= 0 && (i as usize) < count {
                if !skip(i as usize) {
                    return Some(i as usize);
                }
                i += step;
            }
            None
        };
        let moved = |this: &mut Select, target: Option<usize>| match target {
            Some(i) if i != this.index => {
                this.index = i;
                SelectOutcome::Moved(i)
            }
            _ => SelectOutcome::None,
        };
        match key {
            SelectKey::Activate if self.open => {
                self.open = false;
                SelectOutcome::Chosen(self.index)
            }
            SelectKey::Activate => {
                self.open = true;
                SelectOutcome::Opened
            }
            SelectKey::Escape if self.open => {
                self.open = false;
                SelectOutcome::Closed
            }
            SelectKey::Escape => SelectOutcome::None,
            SelectKey::Up => moved(self, find(self.index as isize - 1, -1)),
            SelectKey::Down => moved(self, find(self.index as isize + 1, 1)),
            SelectKey::Home => moved(self, find(0, 1)),
            SelectKey::End => moved(self, find(count as isize - 1, -1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: StepKeys = StepKeys { shift: false, alt: false };

    #[test]
    fn slider_arrows_step_and_modifiers_scale() {
        assert_eq!(slider_value(5.0, 0.0, 10.0, 1.0, SliderKey::Increase, PLAIN), 6.0);
        assert_eq!(slider_value(5.0, 0.0, 10.0, 1.0, SliderKey::Decrease, StepKeys { shift: true, alt: false }), 4.9);
        assert_eq!(slider_value(5.0, 0.0, 10.0, 1.0, SliderKey::Increase, StepKeys { shift: false, alt: true }), 5.01);
        assert_eq!(slider_value(5.0, 0.0, 100.0, 1.0, SliderKey::PageUp, PLAIN), 15.0);
    }

    #[test]
    fn slider_stays_inside_its_range_and_home_end_jump() {
        assert_eq!(slider_value(9.5, 0.0, 10.0, 1.0, SliderKey::Increase, PLAIN), 10.0);
        assert_eq!(slider_value(0.5, 0.0, 10.0, 1.0, SliderKey::Decrease, PLAIN), 0.0);
        assert_eq!(slider_value(4.0, 2.0, 8.0, 1.0, SliderKey::Home, PLAIN), 2.0);
        assert_eq!(slider_value(4.0, 2.0, 8.0, 1.0, SliderKey::End, PLAIN), 8.0);
    }

    #[test]
    fn a_position_along_the_track_is_the_nearest_step_inside_the_range() {
        assert_eq!(slider_at(0.5, 0.0, 100.0, 1.0), 50.0);
        assert_eq!(slider_at(0.123, 0.0, 100.0, 5.0), 10.0);
        assert_eq!(slider_at(0.13, 0.0, 100.0, 5.0), 15.0);
        assert_eq!(slider_at(-3.0, 0.0, 100.0, 5.0), 0.0, "left of the track is the minimum");
        assert_eq!(slider_at(9.0, 2.0, 8.0, 1.0), 8.0, "right of it the maximum");
        assert_eq!(slider_at(0.5, 2.0, 7.0, 2.0), 4.0, "the grid starts at the minimum, not at zero");
        assert_eq!(slider_at(0.333, 0.0, 1.0, 0.0), 0.333, "a slider with no step is continuous");
    }

    #[test]
    fn the_wheel_steps_toward_the_ends_and_stops_there() {
        assert_eq!(slider_wheel(50.0, 0.0, 100.0, 5.0, true), 55.0);
        assert_eq!(slider_wheel(50.0, 0.0, 100.0, 5.0, false), 45.0);
        assert_eq!(slider_wheel(98.0, 0.0, 100.0, 5.0, true), 100.0);
        assert_eq!(slider_wheel(0.1 + 0.2, 0.0, 1.0, 0.1, true), 0.4, "no floating-point dust");
        assert_eq!(slider_fraction(25.0, 0.0, 100.0), 0.25);
        assert_eq!(slider_fraction(5.0, 5.0, 5.0), 0.0);
    }

    #[test]
    fn repeated_tenths_do_not_drift() {
        let mut v = 0.0;
        for _ in 0..30 {
            v = slider_value(v, 0.0, 10.0, 1.0, SliderKey::Increase, StepKeys { shift: true, alt: false });
        }
        assert_eq!(v, 3.0);
    }

    #[test]
    fn a_select_opens_moves_chooses_and_closes() {
        let mut s = Select::new(0);
        let none = |_: usize| false;
        assert_eq!(s.key(SelectKey::Activate, 4, none), SelectOutcome::Opened);
        assert_eq!(s.key(SelectKey::Down, 4, none), SelectOutcome::Moved(1));
        assert_eq!(s.key(SelectKey::End, 4, none), SelectOutcome::Moved(3));
        assert_eq!(s.key(SelectKey::Down, 4, none), SelectOutcome::None, "no wrap past the end");
        assert_eq!(s.key(SelectKey::Activate, 4, none), SelectOutcome::Chosen(3));
        assert!(!s.open);
        assert_eq!(s.key(SelectKey::Activate, 4, none), SelectOutcome::Opened);
        assert_eq!(s.key(SelectKey::Escape, 4, none), SelectOutcome::Closed);
        assert_eq!(s.index, 3, "Escape keeps the value");
        assert_eq!(s.key(SelectKey::Escape, 4, none), SelectOutcome::None);
    }

    #[test]
    fn disabled_options_are_skipped() {
        let mut s = Select::new(0);
        let skip = |i: usize| i == 1 || i == 2;
        assert_eq!(s.key(SelectKey::Down, 4, skip), SelectOutcome::Moved(3));
        assert_eq!(s.key(SelectKey::Up, 4, skip), SelectOutcome::Moved(0));
        assert_eq!(s.key(SelectKey::Up, 4, skip), SelectOutcome::None);
    }
}
