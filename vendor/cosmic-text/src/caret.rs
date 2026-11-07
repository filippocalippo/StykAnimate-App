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
pub fn grapheme_boxes<'g>(text: &str, glyphs: impl IntoIterator<Item = &'g LayoutGlyph>) -> Vec<GraphemeBox> {
    // A cluster can be drawn by several glyphs (a base and its marks): they are one extent, divided among the cluster's
    // graphemes, not one division per glyph.
    let mut clusters: Vec<(usize, usize, bool, f32, f32)> = Vec::new();
    for glyph in glyphs {
        let rtl = glyph.level.is_rtl();
        let (left, right) = (glyph.x, glyph.x + glyph.w);
        // The glyphs of one cluster are adjacent, so only the last cluster can be the one (a search of all of them is
        // quadratic in the glyphs of a long line).
        match clusters.last_mut().filter(|c| c.0 == glyph.start && c.1 == glyph.end && c.2 == rtl) {
            Some(cluster) => {
                cluster.3 = cluster.3.min(left);
                cluster.4 = cluster.4.max(right);
            }
            None => clusters.push((glyph.start, glyph.end, rtl, left, right)),
        }
    }
    let mut boxes = Vec::new();
    for (start, end, rtl, left, right) in clusters {
        let Some(cluster) = text.get(start..end) else {
            continue;
        };
        let count = cluster.graphemes(true).count().max(1);
        let extent = right - left;
        let width = extent / count as f32;
        for (k, (i, grapheme)) in cluster.grapheme_indices(true).enumerate() {
            let x = if rtl { right - (k as f32 + 1.0) * width } else { left + k as f32 * width };
            boxes.push(GraphemeBox { start: start + i, end: start + i + grapheme.len(), x, w: width, rtl });
        }
    }
    boxes.sort_by(|a, b| a.x.total_cmp(&b.x));
    boxes
}

/// The x of the caret at byte `index` with `affinity`, from the glyphs of its line: only the clusters that touch `index`
/// are divided, so the cost is one pass over the glyphs however long the line is.
pub fn caret_x_at(text: &str, glyphs: &[LayoutGlyph], index: usize, affinity: Affinity) -> Option<f32> {
    caret_x(&grapheme_boxes(text, glyphs.iter().filter(|glyph| glyph.start <= index && index <= glyph.end)), index, affinity)
}

/// The right end of the glyphs of a line (the x where the text stops), or `None` for a line without glyphs.
pub fn extent_end(glyphs: &[LayoutGlyph]) -> Option<f32> {
    glyphs.iter().map(|glyph| glyph.x + glyph.w).fold(None, |end: Option<f32>, x| Some(end.map_or(x, |e| e.max(x))))
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
            font_optical_size: crate::OpticalSize::DEFAULT,
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
    fn the_caret_of_a_long_line_costs_one_pass_not_a_pass_per_glyph() {
        // 20,000 glyphs, one per byte: the previous search over the clusters made this quadratic.
        let text = "x".repeat(20_000);
        let glyphs: Vec<LayoutGlyph> = (0..20_000).map(|i| glyph(i, i + 1, i as f32 * 5.0, 5.0, false)).collect();
        let started = std::time::Instant::now();
        assert_eq!(caret_x_at(&text, &glyphs, 12_345, Affinity::Before), Some(12_345.0 * 5.0));
        assert_eq!(caret_x_at(&text, &glyphs, 0, Affinity::After), Some(0.0));
        assert_eq!(caret_x_at(&text, &glyphs, 20_000, Affinity::Before), Some(100_000.0));
        assert!(started.elapsed() < std::time::Duration::from_millis(10), "{:?}", started.elapsed());
        assert_eq!(grapheme_boxes(&text, &glyphs).len(), 20_000);
    }

    #[test]
    fn several_glyphs_of_one_cluster_are_one_extent_not_one_division_each() {
        // One grapheme drawn by two left-to-right glyphs (a base at 0..5 and its mark at 5..10): the caret after it is at 10.
        let glyphs = [glyph(0, 3, 0.0, 5.0, false), glyph(0, 3, 5.0, 5.0, false)];
        let boxes = grapheme_boxes("á", &glyphs);
        assert_eq!(boxes.len(), 1);
        assert_eq!((boxes[0].x, boxes[0].w), (0.0, 10.0));
        assert_eq!(caret_x(&boxes, 3, Affinity::Before), Some(10.0));
        assert_eq!(caret_x(&boxes, 0, Affinity::After), Some(0.0));
    }

    #[test]
    fn a_cluster_of_two_graphemes_drawn_by_two_glyphs_each_is_divided_once() {
        // Right to left: "لا" drawn as a ligature by one glyph at 10..20 and a second glyph of the same cluster at 0..10.
        let glyphs = [glyph(0, 4, 10.0, 10.0, true), glyph(0, 4, 0.0, 10.0, true)];
        let boxes = grapheme_boxes("لا", &glyphs);
        assert_eq!(boxes.len(), 2);
        assert_eq!((boxes[0].start, boxes[0].x, boxes[0].w), (2, 0.0, 10.0));
        assert_eq!((boxes[1].start, boxes[1].x, boxes[1].w), (0, 10.0, 10.0));
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
