//! Pure floating-box geometry, ported from `src/ui/anchor-position.mjs`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}
impl Side {
    fn opposite(self) -> Self {
        match self {
            Self::Top => Self::Bottom,
            Self::Bottom => Self::Top,
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
}
impl Align {
    fn opposite(self) -> Self {
        match self {
            Self::Start => Self::End,
            Self::End => Self::Start,
            Self::Center => Self::Center,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub side: Side,
    pub align: Align,
    pub offset: f64,
    pub margin: f64,
    pub top_inset: f64,
    pub flip: bool,
    pub shift: bool,
    pub fit: bool,
    pub overlap: bool,
    pub min_size: f64,
}
impl Default for Placement {
    fn default() -> Self {
        Self {
            side: Side::Bottom,
            align: Align::Start,
            offset: 6.,
            margin: 8.,
            top_inset: 0.,
            flip: true,
            shift: true,
            fit: true,
            overlap: false,
            min_size: 48.,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Positioned {
    pub rect: Rect,
    pub max_width: Option<f64>,
    pub max_height: Option<f64>,
    pub side: Side,
    pub align: Align,
}
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if hi < lo { lo } else { v.max(lo).min(hi) }
}
pub fn compute(anchor: Rect, size: Size, viewport: Size, p: Placement) -> Positioned {
    let left = p.margin;
    let right = p.margin.max(viewport.width - p.margin);
    let bottom = p.margin.max(viewport.height - p.margin);
    let top = p.margin.max(p.top_inset).min(bottom);
    let mut side = p.side;
    let mut align = p.align;
    let vertical = matches!(side, Side::Top | Side::Bottom);
    let main = if vertical { size.height } else { size.width };
    let room = |s| match s {
        Side::Bottom => bottom - anchor.y - anchor.height - p.offset,
        Side::Top => anchor.y - p.offset - top,
        Side::Right => right - anchor.x - anchor.width - p.offset,
        Side::Left => anchor.x - p.offset - left,
    };
    if p.flip && main > room(side) && room(side.opposite()) > room(side) {
        side = side.opposite();
    }
    let extent = if vertical { bottom - top } else { right - left };
    let cross_extent = if vertical { right - left } else { bottom - top };
    let (mut width, mut height) = (size.width, size.height);
    let (mut max_width, mut max_height) = (None, None);
    if p.fit {
        let limit = extent.min(room(side).max(p.min_size.min(extent)));
        if main > limit {
            if vertical {
                height = limit;
                max_height = Some(limit);
            } else {
                width = limit;
                max_width = Some(limit);
            }
        }
        if (if vertical { width } else { height }) > cross_extent {
            if vertical {
                width = cross_extent;
                max_width = Some(width);
            } else {
                height = cross_extent;
                max_height = Some(height);
            }
        }
    }
    let mut main_pos = match side {
        Side::Bottom => anchor.y + anchor.height + p.offset,
        Side::Top => anchor.y - p.offset - height,
        Side::Right => anchor.x + anchor.width + p.offset,
        Side::Left => anchor.x - p.offset - width,
    };
    if p.overlap {
        main_pos = if vertical {
            clamp(main_pos, top, bottom - height)
        } else {
            clamp(main_pos, left, right - width)
        };
    }
    let (start, end, length, low, high) = if vertical {
        (anchor.x, anchor.x + anchor.width, width, left, right)
    } else {
        (anchor.y, anchor.y + anchor.height, height, top, bottom)
    };
    let aligned = |a| match a {
        Align::Start => start,
        Align::End => end - length,
        Align::Center => (start + end - length) / 2.,
    };
    let overflow = |a| (low - aligned(a)).max(0.) + (aligned(a) + length - high).max(0.);
    if p.flip
        && align != Align::Center
        && overflow(align) > 0.
        && overflow(align.opposite()) < overflow(align)
    {
        align = align.opposite();
    }
    let cross = if p.shift {
        clamp(aligned(align), low, high - length)
    } else {
        aligned(align)
    };
    let (x, y) = if vertical {
        (cross, main_pos)
    } else {
        (main_pos, cross)
    };
    Positioned {
        rect: Rect {
            x,
            y,
            width,
            height,
        },
        max_width,
        max_height,
        side,
        align,
    }
}
