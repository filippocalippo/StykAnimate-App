//! Masks of lone glyphs (styk-draw `K_GLYPH`), as styk-render's `glyphs.rs` makes them: the
//! glyph's triangles filled at four samples a texel into a one-channel mask laid out by
//! `GlyphMask::layout` for the view's raster density, kept across frames by glyph and size.
//! A frame's instances sample them bilinearly; one whose mask the view does not allow (crisp
//! edges, a density above 8, a mask above 4,096 texels or the budget) draws its triangles.

use std::collections::HashMap;
use std::sync::Arc;

use styk_draw::{DrawList, GlyphMask, GlyphMaskLayout};

use crate::coverage::{Triangle, FOUR};
use crate::shade::Mask;

/// Bytes of masks kept at most (styk-render's atlas budget).
pub(crate) const BUDGET: usize = 64 << 20;
/// The largest mask side (styk-render's largest page).
const LARGEST: f64 = 4096.0;

/// A mask's identity: the glyph's triangles (an allocation every instance of one glyph and
/// tessellation level shares) and the mask's size.
type Key = (usize, u32, u32);

struct Entry {
    mask: Arc<Mask>,
    used: u64,
    /// Held so the allocation, and so the key, stays this glyph's.
    _triangles: Arc<[[f32; 2]]>,
}

#[derive(Default)]
pub(crate) struct Masks {
    entries: HashMap<Key, Entry>,
    frame: u64,
    bytes: usize,
    /// Masks filled for the last frame.
    pub filled: u32,
}

/// One instance's mask for a frame: its layout and pixels.
pub(crate) struct Placed {
    pub layout: GlyphMaskLayout,
    pub mask: Arc<Mask>,
}

impl Masks {
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn count(&self) -> usize {
        self.entries.len()
    }

    /// Each lone glyph of `list` at raster density `resolution`: its mask (filled now if no
    /// frame filled it yet), or `None` where its triangles draw.
    pub fn prepare(&mut self, list: &DrawList, resolution: f64, smooth: bool) -> Vec<Option<Placed>> {
        self.frame += 1;
        self.filled = 0;
        let frame = self.frame;
        let mut placed = Vec::with_capacity(list.glyphs.len());
        for instance in &list.glyphs {
            let layout = instance.mask.layout(resolution, GlyphMask::MAX_DIMENSION).filter(|m| smooth && (m.width as f64) <= LARGEST && (m.height as f64) <= LARGEST);
            let Some(layout) = layout else {
                placed.push(None);
                continue;
            };
            let key = (Arc::as_ptr(&instance.triangles) as *const u8 as usize, layout.width, layout.height);
            if let Some(entry) = self.entries.get_mut(&key) {
                entry.used = frame;
                placed.push(Some(Placed { layout, mask: entry.mask.clone() }));
                continue;
            }
            let size = layout.width as usize * layout.height as usize;
            if !self.make_room(size) {
                placed.push(None);
                continue;
            }
            let mask = Arc::new(fill(&instance.triangles, &layout));
            self.bytes += size;
            self.filled += 1;
            self.entries.insert(key, Entry { mask: mask.clone(), used: frame, _triangles: instance.triangles.clone() });
            placed.push(Some(Placed { layout, mask }));
        }
        placed
    }

    /// Room for `size` more bytes, emptying the least recently used masks no instance of this
    /// frame samples; `false` when there is none.
    fn make_room(&mut self, size: usize) -> bool {
        while self.bytes + size > BUDGET {
            let Some((&key, _)) = self.entries.iter().filter(|(_, e)| e.used < self.frame).min_by_key(|(_, e)| e.used) else { return false };
            let entry = self.entries.remove(&key).expect("present");
            self.bytes -= entry.mask.data.len();
        }
        true
    }
}

/// Fills glyph `triangles` (glyph space) into a mask laid out as `layout`: four samples a
/// texel, resolved to their average (0, 64, 128, 191 or 255).
fn fill(triangles: &[[f32; 2]], layout: &GlyphMaskLayout) -> Mask {
    let (w, h) = (layout.width as usize, layout.height as usize);
    let mut counts = vec![0u8; w * h];
    let [sx, sy, tx, ty] = layout.from_glyph;
    let texel = |p: [f32; 2]| [(sx * p[0] as f64 + tx) as f32, (sy * p[1] as f64 + ty) as f32];
    for t in triangles.as_chunks::<3>().0 {
        let Some(triangle) = Triangle::new([texel(t[0]), texel(t[1]), texel(t[2])]) else { continue };
        triangle.each([0, 0, w as i64, h as i64], &FOUR, |x, y, mask| {
            counts[y as usize * w + x as usize] |= mask;
        });
    }
    const LEVELS: [u8; 5] = [0, 64, 128, 191, 255];
    Mask { width: w, height: h, data: counts.into_iter().map(|m| LEVELS[m.count_ones() as usize]).collect() }
}
