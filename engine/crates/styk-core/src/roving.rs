//! Roving focus: the key model of a toolbar, rail, tab list or menu bar that is one Tab stop with arrow keys inside.
//!
//! A line-for-line port of `nextRovingIndex` in `src/ui/roving-focus.mjs`; the interface keeps which child is active and
//! this decides where a key moves it.

/// The keys a roving group answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavKey {
    Home,
    End,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ArrowDown,
}

/// Which arrows a group answers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Orientation {
    #[default]
    Horizontal,
    Vertical,
    Both,
}

impl Orientation {
    /// The step (+1 forward, -1 back) this orientation gives a key, or `None` when it is not one of its keys.
    pub fn step(self, key: NavKey) -> Option<isize> {
        use NavKey::*;
        match (self, key) {
            (Orientation::Horizontal, ArrowRight) | (Orientation::Vertical, ArrowDown) => Some(1),
            (Orientation::Horizontal, ArrowLeft) | (Orientation::Vertical, ArrowUp) => Some(-1),
            (Orientation::Both, ArrowRight | ArrowDown) => Some(1),
            (Orientation::Both, ArrowLeft | ArrowUp) => Some(-1),
            _ => None,
        }
    }
}

/// The index a key moves to, or `None` when the key is not a navigation key for this orientation.
///
/// `index` is the current item (`None` for none yet), `skip(i)` excludes items (hidden or disabled), `wrap` wraps at the
/// ends. Returns the current index when nothing else is reachable and it is itself available.
pub fn next_index(
    key: NavKey,
    index: Option<usize>,
    count: usize,
    orientation: Orientation,
    wrap: bool,
    skip: impl Fn(usize) -> bool,
) -> Option<usize> {
    if count == 0 {
        return None;
    }
    let available = |i: isize| i >= 0 && (i as usize) < count && !skip(i as usize);
    let scan = |from: isize, step: isize| -> Option<usize> {
        let mut i = from;
        for _ in 0..count {
            if wrap {
                i = i.rem_euclid(count as isize);
            } else if i < 0 || i >= count as isize {
                return None;
            }
            if available(i) {
                return Some(i as usize);
            }
            i += step;
        }
        None
    };
    match key {
        NavKey::Home => scan(0, 1),
        NavKey::End => scan(count as isize - 1, -1),
        _ => {
            let step = orientation.step(key)?;
            let start = match index {
                None => {
                    if step > 0 {
                        0
                    } else {
                        count as isize - 1
                    }
                }
                Some(i) => i as isize + step,
            };
            scan(start, step).or_else(|| index.filter(|&i| available(i as isize)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use NavKey::*;

    fn none(_: usize) -> bool {
        false
    }

    #[test]
    fn arrows_follow_the_orientation_and_wrap() {
        let h = Orientation::Horizontal;
        assert_eq!(next_index(ArrowRight, Some(0), 3, h, true, none), Some(1));
        assert_eq!(next_index(ArrowRight, Some(2), 3, h, true, none), Some(0));
        assert_eq!(next_index(ArrowLeft, Some(0), 3, h, true, none), Some(2));
        assert_eq!(next_index(ArrowDown, Some(0), 3, h, true, none), None, "vertical keys are not a horizontal group's");
        assert_eq!(next_index(ArrowDown, Some(0), 3, Orientation::Vertical, true, none), Some(1));
        assert_eq!(next_index(ArrowUp, Some(1), 3, Orientation::Both, true, none), Some(0));
    }

    #[test]
    fn without_wrapping_the_ends_stay_put() {
        let h = Orientation::Horizontal;
        assert_eq!(next_index(ArrowRight, Some(2), 3, h, false, none), Some(2));
        assert_eq!(next_index(ArrowLeft, Some(0), 3, h, false, none), Some(0));
    }

    #[test]
    fn home_and_end_skip_unavailable_items() {
        let h = Orientation::Horizontal;
        let skip = |i: usize| i == 0 || i == 4;
        assert_eq!(next_index(Home, Some(2), 5, h, true, skip), Some(1));
        assert_eq!(next_index(End, Some(2), 5, h, true, skip), Some(3));
    }

    #[test]
    fn disabled_items_are_stepped_over_and_a_lone_item_stays() {
        let h = Orientation::Horizontal;
        assert_eq!(next_index(ArrowRight, Some(0), 4, h, true, |i| i == 1 || i == 2), Some(3));
        assert_eq!(next_index(ArrowRight, Some(1), 3, h, true, |i| i != 1), Some(1));
        assert_eq!(next_index(ArrowRight, Some(0), 3, h, true, |_| true), None);
    }

    #[test]
    fn no_current_item_starts_at_the_matching_end() {
        let h = Orientation::Horizontal;
        assert_eq!(next_index(ArrowRight, None, 3, h, true, none), Some(0));
        assert_eq!(next_index(ArrowLeft, None, 3, h, true, none), Some(2));
        assert_eq!(next_index(ArrowRight, Some(0), 0, h, true, none), None);
    }
}
