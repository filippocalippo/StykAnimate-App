//! A render target with the GPU's samples: four a pixel for smooth edges (one for crisp
//! edges), each premultiplied RGBA8, blended one by one and averaged when resolved, as a
//! multisampled `Rgba8Unorm` target is.
//!
//! Most pixels hold the same colour in every sample (shapes covered by distance write all
//! of them; the inside of a triangle covers all of them), so a pixel keeps one colour until
//! a write covers only some of its samples: then it holds four, and it goes back to one when
//! a write leaves them equal again (`Target::blend`).

/// A premultiplied RGBA8 colour.
pub(crate) type Px = [u8; 4];

pub(crate) struct Target {
    pub width: usize,
    pub height: usize,
    /// Samples a pixel: 4 (smooth edges) or 1 (crisp edges).
    pub samples: usize,
    pixels: Vec<Px>,
    /// 0 for a pixel whose samples are all `pixels[i]`; `n` for one whose samples are `split[n - 1]`.
    index: Vec<u32>,
    split: Vec<[Px; 4]>,
    /// Entries of `split` no pixel uses.
    free: Vec<u32>,
    /// Only the root target has the host's explicit per-paint Canvas clip.
    canvas_clip: Option<styk_render::paint::CanvasClip>,
}

/// A colour component `v` (0–1) as the target stores it: to the nearest level, halves to
/// even (adding and taking away 1.5 × 2²³ rounds a small `f32` so, without a library call).
#[inline]
pub(crate) fn quantize(v: f32) -> u8 {
    const MAGIC: f32 = 12_582_912.0;
    ((v.clamp(0.0, 1.0) * 255.0 + MAGIC) - MAGIC) as u8
}

/// `src` (premultiplied, 0–1) blended over `dst`, or added to it: the blend states of
/// styk-render's pipeline (`One, OneMinusSrcAlpha` and `One, One`).
#[inline]
fn blend(dst: Px, src: [f32; 4], add: bool) -> Px {
    const K: f32 = 1.0 / 255.0;
    let keep = if add { 1.0 } else { 1.0 - src[3] };
    [quantize(src[0] + dst[0] as f32 * K * keep), quantize(src[1] + dst[1] as f32 * K * keep), quantize(src[2] + dst[2] as f32 * K * keep), quantize(src[3] + dst[3] as f32 * K * keep)]
}

/// Canvas paints use packed premultiplied byte arithmetic. Isolated child
/// targets keep the ordinary native blend policy; their composite is clipped
/// once, when it is painted into the root.
#[inline]
fn canvas_blend(dst: Px, src: [f32; 4], add: bool) -> Px {
    let src = src.map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u32);
    let keep = if add { 256 } else { 256 - src[3] };
    std::array::from_fn(|c| (src[c] + ((dst[c] as u32 * keep) >> 8)).min(255) as u8)
}

impl Target {
    pub fn new(width: usize, height: usize, samples: usize, clear: Px) -> Target {
        Target { width, height, samples, pixels: vec![clear; width * height], index: vec![0; width * height], split: Vec::new(), free: Vec::new(), canvas_clip: None }
    }

    pub fn set_canvas_clip(&mut self, clip: styk_render::paint::CanvasClip) { self.canvas_clip = Some(clip); }

    /// The background's fillRect coverage and the clip are independent masks,
    /// combined before masking the paint, as Canvas's clip blitter does.
    pub fn blend_paint(&mut self, i: usize, coverage: u8, src: [f32; 4]) {
        self.blend_inner(i, self.full(), src, false, Some(coverage));
    }

    /// The mask of every sample of a pixel.
    #[inline]
    pub fn full(&self) -> u8 {
        if self.samples == 4 { 15 } else { 1 }
    }

    /// Blends `src` (premultiplied) into the samples `mask` names of pixel `i` (bit `k`: sample `k`).
    #[inline]
    pub fn blend(&mut self, i: usize, mask: u8, src: [f32; 4], add: bool) {
        self.blend_inner(i, mask, src, add, None);
    }

    #[inline]
    fn blend_inner(&mut self, i: usize, mask: u8, mut src: [f32; 4], add: bool, paint: Option<u8>) {
        let blend = if let Some(clip) = self.canvas_clip {
            let alpha = clip.alpha([i % self.width, i / self.width]);
            let alpha = paint.map_or(alpha, |paint| ((paint as u32 * alpha as u32 + 127) / 255) as u8);
            src = styk_render::paint::mask_premultiplied(src, alpha);
            canvas_blend
        } else {
            blend
        };
        if mask == 0 || (src[3] <= 0.0 && src[0] <= 0.0 && src[1] <= 0.0 && src[2] <= 0.0) {
            return;
        }
        let at = self.index[i];
        if mask == self.full() && !add && src[3] >= 1.0 {
            // Opaque over every sample: what was there does not show.
            self.pixels[i] = [quantize(src[0]), quantize(src[1]), quantize(src[2]), 255];
            if at != 0 {
                self.index[i] = 0;
                self.free.push(at - 1);
            }
            return;
        }
        if at == 0 {
            if mask == self.full() {
                self.pixels[i] = blend(self.pixels[i], src, add);
                return;
            }
            // Some samples only: the pixel keeps four colours from now on.
            let p = self.pixels[i];
            let mut samples = [p; 4];
            for (k, s) in samples.iter_mut().enumerate() {
                if mask >> k & 1 != 0 {
                    *s = blend(p, src, add);
                }
            }
            let slot = match self.free.pop() {
                Some(slot) => {
                    self.split[slot as usize] = samples;
                    slot
                }
                None => {
                    self.split.push(samples);
                    self.split.len() as u32 - 1
                }
            };
            self.index[i] = slot + 1;
            return;
        }
        let slot = at as usize - 1;
        let samples = &mut self.split[slot];
        for (k, s) in samples.iter_mut().enumerate() {
            if mask >> k & 1 != 0 {
                *s = blend(*s, src, add);
            }
        }
        if samples[1..].iter().all(|s| *s == samples[0]) {
            self.pixels[i] = samples[0];
            self.index[i] = 0;
            self.free.push(slot as u32);
        }
    }

    /// Every sample of pixel `i` set to the opaque colour `px` (as stored): an opaque write
    /// over the whole pixel, which `blend` would give too.
    #[inline]
    pub fn set_opaque(&mut self, i: usize, px: Px) {
        if self.canvas_clip.is_some() {
            self.blend(i, self.full(), px.map(|v|v as f32 / 255.0), false);
            return;
        }
        self.pixels[i] = px;
        let at = self.index[i];
        if at != 0 {
            self.index[i] = 0;
            self.free.push(at - 1);
        }
    }

    /// Bytes this target holds.
    pub fn bytes(&self) -> usize {
        self.pixels.len() * 8 + self.split.len() * 16
    }

    /// The resolved pixels: each the average of its samples, rounded.
    pub fn resolve(self) -> Vec<Px> {
        let Target { mut pixels, index, split, .. } = self;
        for (p, &at) in pixels.iter_mut().zip(&index) {
            if at != 0 {
                let s = &split[at as usize - 1];
                *p = [0, 1, 2, 3].map(|c| ((s[0][c] as u32 + s[1][c] as u32 + s[2][c] as u32 + s[3][c] as u32 + 2) / 4) as u8);
            }
        }
        pixels
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canvas_clip_is_per_paint_and_only_on_root_composite() {
        let clip = styk_render::paint::CanvasClip::new([0.305555555555554,0.0,1.0,1.0]);
        let mut direct = Target::new(1,1,4,[0;4]); direct.set_canvas_clip(clip);
        for _ in 0..2 { direct.blend(0,15,[0.0,0.0,0.0,127.0/255.0],false); }
        assert_eq!(direct.resolve()[0][3],145,"each independent translucent paint is clipped");
        let mut child = Target::new(1,1,4,[0;4]);
        for _ in 0..2 { child.blend(0,15,[0.0,0.0,0.0,127.0/255.0],false); }
        let px = child.resolve()[0];
        let mut root = Target::new(1,1,4,[0;4]); root.set_canvas_clip(clip);
        root.blend(0,15,px.map(|v|v as f32/255.0),false);
        assert_eq!(root.resolve()[0][3],132,"the completed native child is clipped once");
    }
    #[test]
    fn canvas_fill_combines_independent_paint_and_clip_masks() {
        let mut root = Target::new(1,1,4,[0;4]);
        root.set_canvas_clip(styk_render::paint::CanvasClip::new([0.44444444444444,0.0,1.0,1.0]));
        root.blend_paint(0,142,[1.0;4]);
        assert_eq!(root.resolve()[0],[79;4]);
    }

    #[test]
    fn complementary_samples_leave_no_seam() {
        // Two opaque colours covering complementary samples of a pixel: the pixel is their
        // average, with nothing of the background showing (a coverage blend would let it through).
        let mut t = Target::new(1, 1, 4, [0, 0, 0, 0]);
        t.blend(0, 0b0011, [1.0, 0.0, 0.0, 1.0], false);
        t.blend(0, 0b1100, [0.0, 0.0, 1.0, 1.0], false);
        assert_eq!(t.resolve()[0], [128, 0, 128, 255]);
    }

    #[test]
    fn a_pixel_goes_back_to_one_colour() {
        let mut t = Target::new(1, 1, 4, [255, 255, 255, 255]);
        t.blend(0, 0b0001, [0.0, 0.0, 0.0, 1.0], false);
        assert_eq!(t.split.len(), 1);
        t.blend(0, 0b1111, [0.0, 0.5, 0.0, 1.0], false);
        assert_eq!(t.index[0], 0, "an opaque write over every sample leaves one colour");
        assert_eq!(t.free.len(), 1);
        assert_eq!(t.resolve()[0], [0, 128, 0, 255]);
    }
}
