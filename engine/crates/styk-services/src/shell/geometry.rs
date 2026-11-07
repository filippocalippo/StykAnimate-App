//! Rectangles in physical pixels.

/// A rectangle: left and top edge, width and height, in physical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    /// Left edge.
    pub x: i32,
    /// Top edge.
    pub y: i32,
    /// Width, never negative.
    pub w: i32,
    /// Height, never negative.
    pub h: i32,
}

impl Rect {
    /// A rectangle; a negative size is zero.
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w: if w < 0 { 0 } else { w }, h: if h < 0 { 0 } else { h } }
    }

    /// The edge past the last column.
    pub const fn right(&self) -> i32 {
        self.x.saturating_add(self.w)
    }

    /// The edge past the last row.
    pub const fn bottom(&self) -> i32 {
        self.y.saturating_add(self.h)
    }

    /// Whether the point lies inside (left and top inclusive, right and bottom exclusive).
    pub const fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }

    /// The part both rectangles cover, or an empty rectangle.
    pub fn intersect(&self, other: &Rect) -> Rect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        Rect::new(x, y, self.right().min(other.right()).saturating_sub(x), self.bottom().min(other.bottom()).saturating_sub(y))
    }

    /// Whether it covers no pixel.
    pub const fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// The same size moved by an offset.
    pub const fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect { x: self.x.saturating_add(dx), y: self.y.saturating_add(dy), w: self.w, h: self.h }
    }

    /// The area, wide enough not to overflow.
    pub fn area(&self) -> i64 {
        i64::from(self.w) * i64::from(self.h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_are_half_open() {
        let r = Rect::new(10, 20, 30, 40);
        assert!(r.contains(10, 20) && r.contains(39, 59));
        assert!(!r.contains(40, 20) && !r.contains(10, 60) && !r.contains(9, 20));
    }

    #[test]
    fn intersection_of_apart_rectangles_is_empty() {
        assert!(Rect::new(0, 0, 10, 10).intersect(&Rect::new(20, 20, 5, 5)).is_empty());
        assert_eq!(Rect::new(0, 0, 10, 10).intersect(&Rect::new(5, 5, 10, 10)), Rect::new(5, 5, 5, 5));
    }

    #[test]
    fn a_negative_size_is_empty() {
        assert!(Rect::new(0, 0, -5, 10).is_empty());
    }
}
