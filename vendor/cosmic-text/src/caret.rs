// SPDX-License-Identifier: MIT OR Apache-2.0

//! Caret geometry in lines that mix directions and contain ligatures (StykAnimate patch, see `VENDOR.md`).
//!
//! A line is described as the visual list of *grapheme boxes*: each glyph's cluster is divided among its graphemes in
//! the glyph's own direction (the first grapheme of a right-to-left ligature is its right part). The caret's x, a click
//! and a selection rectangle all come from the same division, so they agree with each other.
//!
//! Caret *motion* is not here: Chromium on Windows moves the caret logically in the paragraph's direction (measured, see
//! `docs/native/text-input.md`), which is what `Buffer::cursor_motion` already does.

use alloc::vec::Vec;

use unicode_segmentation::UnicodeSegmentation;

use crate::{Affinity, LayoutGlyph};

/// One grapheme of a laid out line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraphemeBox {
    /// Byte index of the grapheme in the line's text.
    pub start: usize,
    /// Byte index after the grapheme.
    pub end: usize,
    /// Left edge.
    pub x: f32,
    /// Width.
    pub w: f32,
    /// Whether the grapheme belongs to a right-to-left run.
    pub rtl: bool,
}

impl GraphemeBox {
    /// The x where the grapheme is entered when reading it.
    const fn leading_x(&self) -> f32 {
        if self.rtl { self.x + self.w } else { self.x }
    }

    /// The x where the grapheme is left when reading it.
    const fn trailing_x(&self) -> f32 {
        if self.rtl { self.x } else { self.x + self.w }
    }
}

/// The grapheme boxes of `glyphs` (a laid out line of `text`) in visual order.
pub fn grapheme_boxes(text: &str, glyphs: &[LayoutGlyph]) -> Vec<GraphemeBox> {
    let mut boxes = Vec::new();
    for glyph in glyphs {
        let Some(cluster) = text.get(glyph.start..glyph.end) else {
            continue;
        };
        let count = cluster.graphemes(true).count().max(1);
        let width = glyph.w / count as f32;
        let rtl = glyph.level.is_rtl();
        for (k, (i, grapheme)) in cluster.grapheme_indices(true).enumerate() {
            let x = if rtl {
                glyph.x + glyph.w - (k as f32 + 1.0) * width
            } else {
                glyph.x + k as f32 * width
            };
            boxes.push(GraphemeBox { start: glyph.start + i, end: glyph.start + i + grapheme.len(), x, w: width, rtl });
        }
    }
    boxes.sort_by(|a, b| a.x.total_cmp(&b.x));
    boxes
}

/// The x of the caret at byte `index` with `affinity`: the trailing edge of the grapheme ending there for
/// [`Affinity::Before`], the leading edge of the one starting there for [`Affinity::After`], the other when there is
/// none. A boundary between runs of different direction therefore has two carets.
pub fn caret_x(boxes: &[GraphemeBox], index: usize, affinity: Affinity) -> Option<f32> {
    let trailing = boxes.iter().find(|b| b.end == index).map(GraphemeBox::trailing_x);
    let leading = boxes.iter().find(|b| b.start == index).map(GraphemeBox::leading_x);
    match affinity {
        Affinity::Before => trailing.or(leading),
        Affinity::After => leading.or(trailing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph(start: usize, end: usize, x: f32, w: f32, rtl: bool) -> LayoutGlyph {
        let mut glyph = crate::LayoutGlyph {
            start,
            end,
            font_size: 10.0,
            font_weight: fontdb::Weight::NORMAL,
            line_height_opt: None,
            font_id: fontdb::ID::dummy(),
            glyph_id: 0,
            x,
            y: 0.0,
            w,
            ascender: 0.0,
            descender: 0.0,
            level: unicode_bidi::Level::ltr(),
            x_offset: 0.0,
            y_offset: 0.0,
            color_opt: None,
            metadata: 0,
            cache_key_flags: crate::CacheKeyFlags::empty(),
        };
        if rtl {
            glyph.level = unicode_bidi::Level::rtl();
        }
        glyph
    }

    /// "ab123" in a right-to-left paragraph: the letters are a right-to-left run, the digits a left-to-right run
    /// inside it. Drawn left to right: 1 2 3 b a.
    fn mixed() -> (&'static str, Vec<LayoutGlyph>) {
        let glyphs = vec![
            glyph(2, 3, 0.0, 10.0, false),
            glyph(3, 4, 10.0, 10.0, false),
            glyph(4, 5, 20.0, 10.0, false),
            glyph(1, 2, 30.0, 10.0, true),
            glyph(0, 1, 40.0, 10.0, true),
        ];
        ("ab123", glyphs)
    }

    #[test]
    fn the_caret_of_every_position_is_on_the_right_side_of_its_run() {
        let (text, glyphs) = mixed();
        let boxes = grapheme_boxes(text, &glyphs);
        // Start of the paragraph: the right edge, where 'a' is entered.
        assert_eq!(caret_x(&boxes, 0, Affinity::After), Some(50.0));
        // After 'a' and after 'b': to the left of each, in the right-to-left run.
        assert_eq!(caret_x(&boxes, 1, Affinity::Before), Some(40.0));
        assert_eq!(caret_x(&boxes, 2, Affinity::Before), Some(30.0));
        // Inside the digits, which read left to right.
        assert_eq!(caret_x(&boxes, 3, Affinity::Before), Some(10.0));
        assert_eq!(caret_x(&boxes, 4, Affinity::Before), Some(20.0));
        assert_eq!(caret_x(&boxes, 5, Affinity::Before), Some(30.0));
    }

    #[test]
    fn the_run_boundary_has_two_carets_with_the_same_logical_index() {
        let (text, glyphs) = mixed();
        let boxes = grapheme_boxes(text, &glyphs);
        // Index 2 is both the end of "ab" (its left edge, x 30) and the start of "123" (its left edge, x 0).
        assert_eq!(caret_x(&boxes, 2, Affinity::Before), Some(30.0));
        assert_eq!(caret_x(&boxes, 2, Affinity::After), Some(0.0));
    }

    #[test]
    fn a_right_to_left_ligature_is_divided_from_its_right_part() {
        // Text "لا" (two scalars, one glyph) drawn right to left in x 0..10.
        let text = "لا";
        let boxes = grapheme_boxes(text, &[glyph(0, 4, 0.0, 10.0, true)]);
        assert_eq!(boxes.len(), 2);
        // Visual order: the second grapheme is on the left.
        assert_eq!((boxes[0].start, boxes[0].x, boxes[0].w), (2, 0.0, 5.0));
        assert_eq!((boxes[1].start, boxes[1].x, boxes[1].w), (0, 5.0, 5.0));
        // The caret between the two graphemes is in the middle of the glyph.
        assert_eq!(caret_x(&boxes, 2, Affinity::Before), Some(5.0));
        assert_eq!(caret_x(&boxes, 0, Affinity::After), Some(10.0));
        assert_eq!(caret_x(&boxes, 4, Affinity::Before), Some(0.0));
    }
}
