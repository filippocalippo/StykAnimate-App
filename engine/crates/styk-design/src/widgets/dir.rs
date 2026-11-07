//! Layout direction (`docs/native/text-input.md` section 7).
//!
//! iced rows, paddings and alignments are physical. A [`Dir`] is passed down to the widgets that need it (never a
//! global), and mirrors them at build time: children reversed, paddings swapped, directional icons flipped. What
//! stays left to right by contract (numeric fields, shortcut badges, the timeline, graphs, canvases) simply does not
//! take the direction.

use crate::icons;
use iced::widget::Row;
use iced::{Element, Padding, alignment};

/// The layout direction of the interface.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Dir {
    /// Left to right.
    #[default]
    Ltr,
    /// Right to left (`ar`, `he`, the pseudo-locale `rtl`).
    Rtl,
}

impl Dir {
    /// From the locale's direction (`Localization.direction == "rtl"`).
    pub const fn from_rtl(rtl: bool) -> Dir {
        if rtl { Dir::Rtl } else { Dir::Ltr }
    }

    /// Whether this is right to left.
    pub const fn is_rtl(self) -> bool {
        matches!(self, Dir::Rtl)
    }

    /// A row whose children run in reading order: reversed for right to left.
    pub fn row<'a, Message: 'a>(self, children: impl IntoIterator<Item = Element<'a, Message>>) -> Row<Element<'a, Message>> {
        let mut children: Vec<_> = children.into_iter().collect();
        if self.is_rtl() {
            children.reverse();
        }
        Row::with_children(children)
    }

    /// A padding from the start side and the end side (`padding-inline-start`, `padding-inline-end`).
    pub fn pad(self, top: f32, start: f32, bottom: f32, end: f32) -> Padding {
        let (left, right) = if self.is_rtl() { (end, start) } else { (start, end) };
        Padding { top, right, bottom, left }
    }

    /// The horizontal alignment of the start side.
    pub fn align_start(self) -> alignment::Horizontal {
        if self.is_rtl() { alignment::Horizontal::Right } else { alignment::Horizontal::Left }
    }

    /// The horizontal alignment of the end side.
    pub fn align_end(self) -> alignment::Horizontal {
        if self.is_rtl() { alignment::Horizontal::Left } else { alignment::Horizontal::Right }
    }

    /// The icon to draw for a directional icon name: its mirror in right to left, when the set has one
    /// (`chevron-right` and `chevron-left`, `arrow-right` and `arrow-left`). Other names are unchanged.
    pub fn icon<'n>(self, name: &'n str) -> &'n str {
        if !self.is_rtl() {
            return name;
        }
        const PAIRS: &[(&str, &str)] = &[
            ("chevron-right", "chevron-left"),
            ("chevrons-right", "chevrons-left"),
            ("arrow-right", "arrow-left"),
            ("arrow-big-right", "arrow-big-left"),
            ("corner-down-right", "corner-down-left"),
            ("skip-forward", "skip-back"),
        ];
        for (a, b) in PAIRS {
            if name == *a && icons::lookup(b).is_some() {
                return b;
            }
            if name == *b && icons::lookup(a).is_some() {
                return a;
            }
        }
        name
    }

    /// Where a widget at `x` of width `width` in a page of `page_width` sits mirrored (for layout tests).
    pub fn mirrored_x(x: f32, width: f32, page_width: f32) -> f32 {
        page_width - x - width
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padding_swaps_sides_in_rtl() {
        let p = Dir::Rtl.pad(1.0, 10.0, 2.0, 4.0);
        assert_eq!((p.left, p.right), (4.0, 10.0));
        let p = Dir::Ltr.pad(1.0, 10.0, 2.0, 4.0);
        assert_eq!((p.left, p.right), (10.0, 4.0));
    }

    #[test]
    fn alignment_follows_the_direction() {
        assert_eq!(Dir::Ltr.align_start(), alignment::Horizontal::Left);
        assert_eq!(Dir::Rtl.align_start(), alignment::Horizontal::Right);
        assert_eq!(Dir::Rtl.align_end(), alignment::Horizontal::Left);
    }

    #[test]
    fn directional_icons_flip_only_in_rtl() {
        assert_eq!(Dir::Ltr.icon("chevron-right"), "chevron-right");
        assert_eq!(Dir::Rtl.icon("chevron-right"), "chevron-left");
        assert_eq!(Dir::Rtl.icon("chevron-left"), "chevron-right");
        assert_eq!(Dir::Rtl.icon("play"), "play");
    }

    #[test]
    fn mirroring_is_the_page_reflection() {
        assert_eq!(Dir::mirrored_x(10.0, 30.0, 100.0), 60.0);
    }
}
