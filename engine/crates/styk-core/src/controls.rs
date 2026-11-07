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
    let clamped = moved.clamp(min, max);
    // Snap away floating-point dust from repeated 0.1 steps.
    (clamped * 1e9).round() / 1e9
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
