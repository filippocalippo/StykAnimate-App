//! Effect recipes: an effect stack recorded as the passes that filter one layer, pass for
//! pass as the editor's WebGPU executor runs them (`VfxWebGPU.run`).
//!
//! A run is a list of [`Step`]s over *images*: image 0 is the layer, and every pass writes
//! a new image of its own size, which later passes read (nothing is written in place, so
//! keeping an earlier result, as `save` did, is reading its image again: no copy). Each
//! pass has its [`Uniform`] record. A run is the same for every renderer: the GPU encodes
//! it ([`super::executor`]), placing images in pooled textures for the part of the run
//! they live; the CPU rasterizer (styk-raster) runs each operation's arithmetic on its
//! own pixels. Nothing here needs a GPU.

use std::f64::consts::PI;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};
use styk_eval::doc::PaintKind;
use styk_eval::vfx::registry::{BlurMode, GlowPlacement, OutlinePlacement, Params as P, ShadowPlacement};
use styk_eval::vfx::{Color, Effect};

/// An image of a run, by position in [`Run::images`].
pub type ImageId = u16;
/// A pass's `original` or `mask` when it reads none (a blank texel).
pub const BLANK: ImageId = ImageId::MAX;
/// The layer the run filters.
pub const INPUT: ImageId = 0;

/// One pass's parameters (`Params` in the effect shaders). `texel` and `texel_other` are the
/// GPU's: one over the size of the textures the source and the original (or mask) images
/// are placed in, written when the frame's textures are known.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Uniform {
    pub dimensions: [f32; 2],
    pub origin: [f32; 2],
    pub output_size: [f32; 2],
    pub paint_type: i32,
    pub stop_count: i32,
    pub paint_angle: f32,
    pub operation: i32,
    pub target: [f32; 2],
    pub texel: [f32; 2],
    pub texel_other: [f32; 2],
    pub p: [f32; 4],
    pub q: [f32; 4],
    pub stops: [[f32; 4]; 32],
    pub stop_offsets: [f32; 32],
}

/// Where an effect's coordinates come from (`run`'s options), in layer pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    /// Effect sizes are multiplied by this (pixels per authored unit).
    pub scale: f64,
    /// Global pixel position of the layer's first texel.
    pub origin: [f64; 2],
    /// Size of the coordinate domain gradients and centres are relative to.
    pub output_size: [f64; 2],
}

/// The brush (`paint` in `run`): solid or gradient stops for the passes that use one.
#[derive(Clone, Copy)]
struct Brush {
    kind: i32,
    angle: f32,
    count: i32,
    colors: [[f32; 4]; 32],
    offsets: [f32; 32],
}

impl Default for Brush {
    fn default() -> Brush {
        Brush { kind: 0, angle: 0.0, count: 1, colors: [[0.0; 4]; 32], offsets: [0.0; 32] }
    }
}

/// A group of operations sharing one small shader: each is compiled the first time a frame
/// needs it, so nothing an effect does not use is ever compiled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    /// Per-pixel colour operations: tint, grade, noise, vignette, inversion, dissolve,
    /// threshold, light sweep and the strength mix.
    Color,
    /// Box blur passes along an axis.
    Box,
    /// Alpha dilation, along an axis or in sixteen directions.
    Dilate,
    /// Glow, shadow, outline and bloom composited over the saved artwork.
    Composite,
    /// Pixelate and the blur's downsample and upsample.
    Resample,
    /// Displacements: directional blurs, RGB split, wave, shockwave, CRT, turbulence.
    Warp,
}

impl Family {
    /// The family of an operation of `passes.wgsl`.
    pub fn of(operation: i32) -> Family {
        match operation {
            3 | 4 => Family::Box,
            5 | 6 | 14 => Family::Dilate,
            7 | 15 | 22 | 25 => Family::Composite,
            8 | 11 | 12 => Family::Resample,
            16 | 18 | 19 | 20 | 24 | 27 => Family::Warp,
            _ => Family::Color,
        }
    }
}

/// One recorded step of a run.
#[derive(Clone, Copy, Debug)]
pub enum Step {
    /// A fragment pass writing image `target` (its size is the image's), reading `source`,
    /// and `original` and `mask` where the operation reads them; `uniform` indexes the run's
    /// records.
    Pass { operation: i32, source: ImageId, target: ImageId, original: ImageId, mask: ImageId, uniform: u32 },
}

impl Step {
    /// The images the step reads (`BLANK` for none).
    pub fn reads(&self) -> [ImageId; 3] {
        match *self {
            Step::Pass { source, original, mask, .. } => [source, original, mask],
        }
    }
    pub fn target(&self) -> ImageId {
        match *self {
            Step::Pass { target, .. } => target,
        }
    }
}

/// What an image's texels hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Texel {
    /// Premultiplied colour, eight bits a channel: the layer as the atlas holds it.
    Color8,
}

/// An image of a run: its size and what its texels hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Image {
    pub size: [u32; 2],
    pub texel: Texel,
}

/// A recorded run: its steps, its images (the input first) and the image holding the result
/// (the input itself when no pass ran).
#[derive(Clone, Debug, Default)]
pub struct Run {
    pub steps: Vec<Step>,
    pub images: Vec<Image>,
    pub result: ImageId,
    pub size: [u32; 2],
}

impl Run {
    /// The index of the last step reading each image (`None`: no step reads it); the result
    /// is read after the last step.
    pub fn last_reads(&self) -> Vec<Option<usize>> {
        let mut last = vec![None; self.images.len()];
        for (i, step) in self.steps.iter().enumerate() {
            for image in step.reads() {
                if image != BLANK {
                    last[image as usize] = Some(i);
                }
            }
        }
        if let Some(l) = last.get_mut(self.result as usize) {
            *l = Some(self.steps.len());
        }
        last
    }

    /// Pixels of the images alive at once at most (the input and the result included).
    pub fn peak_pixels(&self) -> u64 {
        let last = self.last_reads();
        let pixels = |id: usize| self.images[id].size[0] as u64 * self.images[id].size[1] as u64;
        let mut alive = pixels(INPUT as usize);
        let mut peak = alive;
        for (i, step) in self.steps.iter().enumerate() {
            alive += pixels(step.target() as usize);
            peak = peak.max(alive);
            let reads = step.reads();
            for (k, &image) in reads.iter().enumerate() {
                if image != BLANK && last[image as usize] == Some(i) && !reads[..k].contains(&image) {
                    alive -= pixels(image as usize);
                }
            }
            if last[step.target() as usize].is_none() {
                alive -= pixels(step.target() as usize);
            }
        }
        peak
    }
}

/// Images are placed in textures whose sides are whole multiples of this, so that a size a
/// little different reuses a texture. The sides depend on the image alone: what a pass
/// samples never depends on the frames drawn before.
pub const BUCKET: u32 = 64;

/// The size of the texture an image of `size` is placed in.
pub fn bucket(size: [u32; 2]) -> [u32; 2] {
    size.map(|n| n.max(1).div_ceil(BUCKET) * BUCKET)
}

/// Where the images of a frame's runs live: `textures` (size and texel) are created for the
/// frame, and `images[run][image]` names the texture each image is placed in. Runs are
/// encoded one after the other, so a texture serves every image that is not alive at the same
/// time as another it holds: an image takes a free texture of its bucket when its pass writes
/// it and frees it after the last pass that reads it (the result after the run).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Placement {
    pub textures: Vec<([u32; 2], Texel)>,
    pub images: Vec<Vec<u32>>,
}

impl Placement {
    pub fn of(runs: &[&Run]) -> Placement {
        let mut placement = Placement::default();
        let mut free: Vec<u32> = Vec::new();
        for run in runs {
            let last = run.last_reads();
            let mut place = vec![u32::MAX; run.images.len()];
            let take = |placement: &mut Placement, free: &mut Vec<u32>, image: Image| -> u32 {
                let want = (bucket(image.size), image.texel);
                match free.iter().position(|&t| placement.textures[t as usize] == want) {
                    Some(at) => free.swap_remove(at),
                    None => {
                        placement.textures.push(want);
                        placement.textures.len() as u32 - 1
                    }
                }
            };
            place[INPUT as usize] = take(&mut placement, &mut free, run.images[INPUT as usize]);
            for (i, step) in run.steps.iter().enumerate() {
                let target = step.target();
                place[target as usize] = take(&mut placement, &mut free, run.images[target as usize]);
                // After its last reader (at once for an image nothing reads), an image's texture is free.
                for image in step.reads().into_iter().chain([target]) {
                    let texture = if image == BLANK { u32::MAX } else { place[image as usize] };
                    if texture != u32::MAX && last[image as usize].is_none_or(|l| l == i) && !free.contains(&texture) {
                        free.push(texture);
                    }
                }
            }
            // The result, read after the run, and the input when nothing read it.
            for &texture in &place {
                if texture != u32::MAX && !free.contains(&texture) {
                    free.push(texture);
                }
            }
            placement.images.push(place);
        }
        placement
    }

    /// Bytes of the textures.
    pub fn bytes(&self) -> u64 {
        self.textures.iter().map(|(size, texel)| size[0] as u64 * size[1] as u64 * texel_bytes(*texel)).sum()
    }
}

/// Bytes of one texel.
pub fn texel_bytes(texel: Texel) -> u64 {
    match texel {
        Texel::Color8 => 4,
    }
}

fn round(x: f64) -> f64 {
    styk_eval::vfx::paint::js_round(x)
}

/// Records `stack` on a `size` layer (image 0), appending its pass uniforms to `records` (a
/// pass's `uniform` is its index there). Mirrors `VfxWebGPU.run`.
pub fn record(records: &mut Vec<Uniform>, stack: &[Arc<Effect>], frame: Frame, size: [u32; 2]) -> Run {
    let mut r = Recorder { records, steps: Vec::new(), images: vec![Image { size, texel: Texel::Color8 }], current: INPUT, brush: Brush::default(), frame, size };
    for effect in stack.iter().filter(|e| styk_eval::vfx::is_active(e)) {
        r.effect(effect);
    }
    Run { steps: r.steps, images: r.images, result: r.current, size }
}

/// `run`'s local state while recording one stack.
struct Recorder<'a> {
    records: &'a mut Vec<Uniform>,
    steps: Vec<Step>,
    images: Vec<Image>,
    current: ImageId,
    brush: Brush,
    frame: Frame,
    /// The layer's size (`W`, `H`).
    size: [u32; 2],
}

impl Recorder<'_> {
    /// `pass(operation, p, q, original, width, height, mask)`: a new image of `size`.
    fn pass_with(&mut self, operation: i32, p: [f64; 4], q: [f64; 4], original: ImageId, size: [u32; 2], mask: ImageId) {
        let source_size = self.images[self.current as usize].size;
        let f = |v: [f64; 4]| [v[0] as f32, v[1] as f32, v[2] as f32, v[3] as f32];
        let record = Uniform {
            dimensions: [source_size[0] as f32, source_size[1] as f32],
            origin: [self.frame.origin[0] as f32, self.frame.origin[1] as f32],
            output_size: [self.frame.output_size[0] as f32, self.frame.output_size[1] as f32],
            paint_type: self.brush.kind,
            stop_count: self.brush.count,
            paint_angle: self.brush.angle,
            operation,
            target: [size[0] as f32, size[1] as f32],
            texel: [0.0; 2],
            texel_other: [0.0; 2],
            p: f(p),
            q: f(q),
            stops: self.brush.colors,
            stop_offsets: self.brush.offsets,
        };
        let uniform = self.records.len() as u32;
        self.records.push(record);
        let target = self.images.len() as ImageId;
        self.images.push(Image { size, texel: Texel::Color8 });
        self.steps.push(Step::Pass { operation, source: self.current, target, original, mask, uniform });
        self.current = target;
    }

    fn pass(&mut self, operation: i32, p: [f64; 4], q: [f64; 4]) {
        let (current, size) = (self.current, self.size);
        self.pass_with(operation, p, q, current, size, BLANK);
    }

    fn pass_from(&mut self, operation: i32, p: [f64; 4], original: ImageId) {
        let size = self.size;
        self.pass_with(operation, p, [0.0; 4], original, size, BLANK);
    }

    /// `save(index)`: the current layer, kept: its image, read again later.
    fn save(&self) -> ImageId {
        self.current
    }

    /// `blur(radius)`: three box passes per axis, downsampled on a stable grid past 20 pixels.
    fn blur(&mut self, radius: f64) {
        if radius <= 0.0 {
            return;
        }
        let [w, h] = [self.size[0] as f64, self.size[1] as f64];
        let factor = (radius / 20.0).ceil().max(1.0);
        let modulo = |v: f64| ((v % factor) + factor) % factor;
        let (ox, oy) = if factor > 1.0 { (modulo(self.frame.origin[0]), modulo(self.frame.origin[1])) } else { (0.0, 0.0) };
        let bw = ((w + ox) / factor).ceil().max(1.0);
        let bh = ((h + oy) / factor).ceil().max(1.0);
        let small = [bw as u32, bh as u32];
        let current = self.current;
        if factor > 1.0 {
            self.pass_with(11, [factor, ox, oy, bh], [0.0; 4], current, small, BLANK);
        }
        let r = round(radius / factor * 0.57735).clamp(1.0, 128.0);
        for _ in 0..3 {
            let c = self.current;
            self.pass_with(3, [r, 0.0, 0.0, 0.0], [0.0; 4], c, small, BLANK);
            let c = self.current;
            self.pass_with(4, [r, 0.0, 0.0, 0.0], [0.0; 4], c, small, BLANK);
        }
        if factor > 1.0 {
            self.pass(12, [factor, ox, oy, h], [0.0; 4]);
        }
    }

    /// `morph(radius, rounded)`: alpha dilation (rounded in 16 directions, doubling).
    fn morph(&mut self, radius: f64, rounded: bool) {
        let mut radius = radius.ceil();
        let mut step = 1.0f64;
        while radius > 0.0 {
            let amount = (if rounded { step } else { 128.0 }).min(radius);
            if rounded {
                self.pass(14, [amount, 0.0, 0.0, 0.0], [0.0; 4]);
            } else {
                self.pass(5, [amount, 0.0, 0.0, 0.0], [0.0; 4]);
                self.pass(6, [amount, 0.0, 0.0, 0.0], [0.0; 4]);
            }
            radius -= amount;
            step *= 2.0;
        }
    }

    /// `paint(value)`: the brush of the passes that follow.
    fn paint(&mut self, color: &Color) {
        let b = &mut self.brush;
        match color {
            Color::Rgb(rgb) => {
                b.kind = 0;
                b.angle = 0.0;
                b.count = 1;
                b.colors[0] = [(rgb >> 16 & 255) as f32 / 255.0, (rgb >> 8 & 255) as f32 / 255.0, (rgb & 255) as f32 / 255.0, 1.0];
                b.offsets[0] = 0.0;
            }
            Color::Paint(paint) => {
                b.kind = match paint.kind {
                    PaintKind::Solid => 0,
                    PaintKind::Linear => 1,
                    PaintKind::Radial => 2,
                    PaintKind::Angular => 3,
                    PaintKind::Diamond => 4,
                };
                b.angle = (paint.angle * PI / 180.0) as f32;
                b.count = paint.stops.len() as i32;
                for (i, s) in paint.stops.iter().take(32).enumerate() {
                    b.colors[i] = [s.rgb[0] as f32 / 255.0, s.rgb[1] as f32 / 255.0, s.rgb[2] as f32 / 255.0, s.opacity as f32];
                    b.offsets[i] = s.offset as f32;
                }
            }
        }
    }

    fn effect(&mut self, effect: &Effect) {
        let params = &effect.params;
        let scale = self.frame.scale;
        let strength = params.effect_strength();
        let source = (strength < 1.0).then(|| self.save());
        let radians = |deg: f64| deg * PI / 180.0;
        match params {
            P::Tint(p) => {
                self.paint(&p.color);
                self.pass(1, [p.mix, 0.0, 0.0, 0.0], [0.0; 4]);
            }
            P::Grade(p) => self.pass(2, [p.exposure, p.contrast, p.saturation, p.temperature], [p.tint, p.shadows, p.highlights, p.gamma]),
            P::Blur(p) => {
                if p.mode == BlurMode::Gaussian {
                    self.blur(p.radius * scale);
                } else {
                    self.pass(16, [p.radius * scale, p.mode.index() as f64, radians(p.angle), 0.0], [p.center_x, p.center_y, 0.0, 0.0]);
                }
            }
            P::Glow(p) => {
                self.paint(&p.color);
                if p.core_mix != 0.0 {
                    self.paint(&p.core_color);
                    self.pass(1, [p.core_mix, 0.0, 0.0, 0.0], [0.0; 4]);
                    self.paint(&p.color);
                }
                let modes: &[bool] = match p.mode {
                    GlowPlacement::Both => &[true, false],
                    GlowPlacement::Inner => &[true],
                    GlowPlacement::Outer => &[false],
                };
                for &inner in modes {
                    let saved = self.save();
                    if inner {
                        self.pass(13, [0.0; 4], [0.0; 4]);
                    }
                    self.morph(p.spread * scale, true);
                    self.blur(p.radius * scale);
                    let size = self.size;
                    self.pass_with(7, [p.intensity, p.falloff, inner as u8 as f64, p.blend.index() as f64], [0.0; 4], saved, size, BLANK);
                }
            }
            P::Shadow(p) => {
                self.paint(&p.color);
                for &inner in if p.mode == ShadowPlacement::Inner { &[true][..] } else { &[false][..] } {
                    let saved = self.save();
                    if inner {
                        self.pass(13, [0.0; 4], [0.0; 4]);
                    }
                    self.morph(p.spread * scale, true);
                    self.blur(p.radius * scale);
                    let size = self.size;
                    self.pass_with(7, [p.opacity, 1.0, inner as u8 as f64, 0.0], [p.offset_x * scale, p.offset_y * scale, 0.0, 0.0], saved, size, BLANK);
                }
            }
            P::Outline(p) => {
                self.paint(&p.color);
                let saved = self.save();
                let center = p.mode == OutlinePlacement::Center;
                let width = p.width * scale * if center { 0.5 } else { 1.0 };
                if center {
                    self.pass(13, [0.0; 4], [0.0; 4]);
                    self.morph(width, p.rounded);
                    self.pass_from(15, [p.opacity, 1.0, 1.0, 0.0], saved);
                    let inner = self.save();
                    self.current = saved;
                    self.morph(width, p.rounded);
                    let size = self.size;
                    self.pass_with(25, [p.opacity, p.only as u8 as f64, 0.0, 0.0], [0.0; 4], saved, size, inner);
                } else {
                    let inside = p.mode == OutlinePlacement::Inside;
                    if inside {
                        self.pass(13, [0.0; 4], [0.0; 4]);
                    }
                    self.morph(width, p.rounded);
                    self.pass_from(15, [p.opacity, inside as u8 as f64, p.only as u8 as f64, 0.0], saved);
                }
            }
            P::Pixelate(p) => {
                let y = if p.linked { p.size } else { p.size_y };
                self.pass(8, [(p.size * scale).max(1.0), (y * scale).max(1.0), 0.0, 0.0], [p.offset_x * scale, p.offset_y * scale, 0.0, 0.0]);
            }
            P::Noise(p) => self.pass(
                9,
                [p.amount, (p.size * scale).max(1.0), p.seed as f64, (p.phase * 1024.0).floor()],
                [p.colored as u8 as f64, p.contrast, p.softness, p.pattern.index() as f64],
            ),
            P::Vignette(p) => {
                self.paint(&p.color);
                self.pass(10, [p.amount, p.softness, p.radius, 0.0], [p.center_x, p.center_y, p.aspect, p.roundness]);
            }
            P::Dissolve(p) => {
                self.paint(&p.color);
                self.pass(17, [p.progress, p.size * scale, p.softness, p.seed as f64], [p.edge, 0.0, 0.0, 0.0]);
            }
            P::RgbSplit(p) => self.pass(18, [p.amount * scale, radians(p.angle), 0.0, 0.0], [p.red, p.green, p.blue, 0.0]),
            P::Turbulence(p) => self.pass(27, [p.amount * scale, p.size * scale, p.evolution, p.seed as f64], [p.detail as f64, 0.0, 0.0, 0.0]),
            P::Wave(p) => self.pass(19, [p.strength * scale, p.wavelength * scale, radians(p.angle), radians(p.phase)], [0.0; 4]),
            P::Shockwave(p) => self.pass(20, [p.radius * scale, p.thickness * scale, p.strength * scale, p.falloff], [p.center_x, p.center_y, 0.0, 0.0]),
            P::Bloom(p) => {
                self.paint(&p.color);
                let saved = self.save();
                self.pass(21, [p.threshold, p.softness, 0.0, 0.0], [0.0; 4]);
                self.blur(p.radius * scale);
                self.pass_from(22, [p.intensity, 0.0, 0.0, 0.0], saved);
            }
            P::LightSweep(p) => {
                self.paint(&p.color);
                self.pass(23, [p.position, radians(p.angle), p.width, p.softness], [p.intensity, 0.0, 0.0, 0.0]);
            }
            P::Crt(p) => {
                self.paint(&p.color);
                self.pass(24, [p.amount, p.spacing * scale, p.curvature, p.chromatic * scale], [p.phase * scale, 0.0, 0.0, 0.0]);
            }
            // Generated effects draw artwork of their own; they never reach a filter stack.
            P::Particles(_) | P::Aura(_) | P::Beam(_) | P::Smoke(_) | P::Explosion(_) => {}
        }
        if let Some(source) = source {
            self.pass_from(26, [strength, 0.0, 0.0, 0.0], source);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passes(run: &Run) -> Vec<i32> {
        run.steps.iter().map(|s| match s { Step::Pass { operation, .. } => *operation }).collect()
    }

    /// A glow at half strength with a blur past 20 pixels, recorded pass for
    /// pass as `VfxWebGPU.run` records it.
    #[test]
    fn records_like_the_editor() {
        let glow = Effect { id: Arc::from("g"), enabled: true, params: P::Glow(styk_eval::vfx::registry::Glow { radius: 30.0, effect_strength: 0.5, ..Default::default() }) };
        let mut records = Vec::new();
        let run = record(&mut records, &[Arc::new(glow)], Frame { scale: 1.0, origin: [-7.0, 3.0], output_size: [100.0, 80.0] }, [120, 90]);
        // downsample, three box passes per axis, upsample, composite over the saved artwork, strength mix
        assert_eq!(passes(&run), vec![11, 3, 4, 3, 4, 3, 4, 12, 7, 26]);
        assert_eq!(records.len(), 10);
        // The saved artwork and the strength source are the layer itself, read again: nothing is copied.
        let Some(Step::Pass { original, .. }) = run.steps.iter().find(|s| matches!(s, Step::Pass { operation: 7, .. })) else { unreachable!() };
        assert_eq!(*original, INPUT);
        let Some(Step::Pass { original, .. }) = run.steps.last() else { unreachable!() };
        assert_eq!(*original, INPUT);
        // The downsampled grid is anchored to the global origin: (120 + (-7 mod 2)) / 2.
        let Some(Step::Pass { target, .. }) = run.steps.iter().find(|s| matches!(s, Step::Pass { operation: 11, .. })) else { unreachable!() };
        assert_eq!(run.images[*target as usize].size, [61, 46]);
        assert_eq!(run.size, [120, 90]);
        assert_eq!(run.images[run.result as usize].size, [120, 90]);
        // At most the layer, two working images at full size and two downsampled ones live at once.
        assert!(run.peak_pixels() <= 3 * 120 * 90 + 2 * 61 * 46, "{}", run.peak_pixels());
    }

    /// Images share a texture when they are not alive together; runs share them one after the other.
    #[test]
    fn images_share_textures_they_do_not_need_at_once() {
        let glow = Effect { id: Arc::from("g"), enabled: true, params: P::Glow(styk_eval::vfx::registry::Glow { radius: 30.0, ..Default::default() }) };
        let blur = Effect { id: Arc::from("b"), enabled: true, params: P::Blur(styk_eval::vfx::registry::Blur { radius: 4.0, ..Default::default() }) };
        let mut records = Vec::new();
        let frame = Frame { scale: 1.0, origin: [0.0; 2], output_size: [100.0, 80.0] };
        let a = record(&mut records, &[Arc::new(glow)], frame, [120, 90]);
        let b = record(&mut records, &[Arc::new(blur)], frame, [120, 90]);
        let placement = Placement::of(&[&a, &b]);
        // The glow: the layer (kept for the composite), the downsample ping-pong (two), the upsample and
        // the composite's own image: never more than five textures alive, two of them small.
        assert!(placement.textures.len() <= 5, "{:?}", placement.textures);
        assert_eq!(placement.textures.iter().filter(|(size, _)| *size == [64, 64]).count(), 2, "the downsampled blur takes small textures");
        // The blur's run reuses the glow's textures: nothing new is created for it.
        let before = Placement::of(&[&a]).textures.len();
        assert_eq!(placement.textures.len(), before);
        for (run, place) in [&a, &b].iter().zip(&placement.images) {
            for step in &run.steps {
                assert!(!step.reads().iter().any(|&r| r != BLANK && place[r as usize] == place[step.target() as usize]), "a pass never writes a texture it reads");
            }
        }
    }

    /// Inactive effects record nothing; a centred outline keeps its inner ring as a mask.
    #[test]
    fn centred_outline_uses_a_mask() {
        let outline = Effect { id: Arc::from("o"), enabled: true, params: P::Outline(styk_eval::vfx::registry::Outline { width: 4.0, mode: OutlinePlacement::Center, ..Default::default() }) };
        let off = Effect { id: Arc::from("x"), enabled: false, params: P::Tint(Default::default()) };
        let mut records = Vec::new();
        let run = record(&mut records, &[Arc::new(off), Arc::new(outline)], Frame { scale: 2.0, origin: [0.0; 2], output_size: [10.0; 2] }, [40, 40]);
        let ops = passes(&run);
        assert_eq!(ops.first(), Some(&13));
        assert_eq!(ops.last(), Some(&25));
        let Some(Step::Pass { mask, original, .. }) = run.steps.last() else { unreachable!() };
        assert_eq!(*original, INPUT);
        let ring = run.steps.iter().find(|s| matches!(s, Step::Pass { operation: 15, .. })).map(|s| s.target());
        assert_eq!(Some(*mask), ring, "the inner ring is the image the first composite wrote");
    }
}
