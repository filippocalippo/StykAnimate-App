//! Effect recipes: an effect stack recorded as the passes that filter one layer (docs/engine/vfx.md, "The filter core").
//!
//! A run is a list of [`Step`]s over *images*: image 0 is the layer, and every pass writes a new image of its own size and level
//! (a halved image for a wide blur is small), which later passes read; nothing is written in place, so reading an earlier
//! result again copies nothing. Each pass has its [`Uniform`] record. A run is the same for every renderer: the GPU encodes it
//! ([`super::executor`]), placing images in pooled textures for the part of the run they live; the CPU rasterizer (styk-raster)
//! runs each operation's arithmetic on its own pixels. Nothing here needs a GPU.
//!
//! The operations (`op`) and their parameters are documented where the shaders read them (`shaders/*.wgsl`); this module says
//! which passes an effect is made of and with what numbers ([`super::kernels`] holds the arithmetic both renderers share).

use std::f64::consts::PI;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};
use styk_eval::doc::PaintKind;
use styk_eval::vfx::registry::{BlurMode, GlowPlacement, GlowSource, OutlinePlacement, Params as P, ShadowPlacement};
use styk_eval::vfx::{Color, Effect};

use super::kernels;

/// An image of a run, by position in [`Run::images`].
pub type ImageId = u16;
/// An input a pass does not read.
pub const BLANK: ImageId = ImageId::MAX;
/// The layer the run filters.
pub const INPUT: ImageId = 0;
/// Inputs of a pass at most (texture bindings of the effect shaders besides the seeds).
pub const INPUTS: usize = 4;

/// The operations, by shader family. Their parameters are documented in the shaders.
pub mod op {
    // reduce.wgsl
    pub const TENT: i32 = 1;
    pub const BOX: i32 = 2;
    pub const BRIGHT: i32 = 3;
    // convolve.wgsl
    pub const CONVOLVE: i32 = 10;
    // expand.wgsl
    pub const SPLINE: i32 = 20;
    pub const ACCUMULATE: i32 = 21;
    // light.wgsl
    pub const LIGHT: i32 = 30;
    pub const BLOOM: i32 = 31;
    // flood.wgsl
    pub const SEED: i32 = 40;
    pub const JUMP: i32 = 41;
    // spread.wgsl
    pub const SPREAD: i32 = 45;
    // outline.wgsl
    pub const OUTLINE: i32 = 50;
    // line.wgsl
    pub const LINE: i32 = 60;
    // color.wgsl
    pub const TINT: i32 = 70;
    pub const GRADE: i32 = 71;
    pub const VIGNETTE: i32 = 72;
    pub const SWEEP: i32 = 73;
    // noise.wgsl
    pub const GRAIN: i32 = 80;
    pub const CLOUDS: i32 = 81;
    // dissolve.wgsl
    pub const DISSOLVE: i32 = 85;
    // turbulence.wgsl
    pub const TURBULENCE: i32 = 88;
    // warp.wgsl
    pub const SPLIT: i32 = 90;
    pub const WAVE: i32 = 91;
    pub const SHOCK: i32 = 92;
    pub const CRT: i32 = 93;
    // cells.wgsl
    pub const CELLS: i32 = 95;
    pub const SHOW: i32 = 96;
}

/// A group of operations sharing one small shader: each is compiled the first time a frame needs it, so nothing an effect does
/// not use is ever compiled, and no shader holds long loops or many unrelated operations (on WebGL2 a pipeline is compiled on the
/// interface thread).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    Reduce,
    Convolve,
    Expand,
    Light,
    Flood,
    Spread,
    Outline,
    Line,
    Color,
    Noise,
    Dissolve,
    Turbulence,
    Warp,
    Cells,
}

impl Family {
    pub const ALL: [Family; 14] = [
        Family::Reduce,
        Family::Convolve,
        Family::Expand,
        Family::Light,
        Family::Flood,
        Family::Spread,
        Family::Outline,
        Family::Line,
        Family::Color,
        Family::Noise,
        Family::Dissolve,
        Family::Turbulence,
        Family::Warp,
        Family::Cells,
    ];

    /// The family of an operation.
    pub fn of(operation: i32) -> Family {
        match operation {
            1..=9 => Family::Reduce,
            10..=19 => Family::Convolve,
            20..=29 => Family::Expand,
            30..=39 => Family::Light,
            40..=44 => Family::Flood,
            45..=49 => Family::Spread,
            50..=59 => Family::Outline,
            60..=69 => Family::Line,
            70..=79 => Family::Color,
            80..=84 => Family::Noise,
            85..=87 => Family::Dissolve,
            88..=89 => Family::Turbulence,
            90..=94 => Family::Warp,
            _ => Family::Cells,
        }
    }
}

/// One pass's parameters (`Params` in `shaders/common.wgsl`), 1,024 bytes. Coordinates are in pixels with y down; `origin` is the
/// global position of the layer's first pixel (level 0), `output_size` the effect domain's size. For each input, `inputs[k]`
/// holds one over the size of the texture it is placed in (written by the GPU executor) and the image's own size, and `maps[k]`
/// the map from a target texel position to the input's: `input = target · maps[k].xy + maps[k].zw`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Uniform {
    pub target: [f32; 2],
    /// The target's level (0 full size; `2^level` layer pixels a texel).
    pub level: f32,
    pub operation: i32,
    pub origin: [f32; 2],
    pub output_size: [f32; 2],
    pub inputs: [[f32; 4]; INPUTS],
    pub maps: [[f32; 4]; INPUTS],
    pub p: [f32; 4],
    pub q: [f32; 4],
    pub r: [f32; 4],
    pub s: [f32; 4],
    /// A convolution's sample offsets and weights (`kernels::MAX_SAMPLES`).
    pub taps: [[f32; 4]; 4],
    pub weights: [[f32; 4]; 4],
    /// Exact integers: seeds, counts.
    pub seed: [u32; 4],
    pub paint_type: i32,
    pub stop_count: i32,
    pub paint_angle: f32,
    /// 1 when the target holds eight bits a channel: the result is dithered (written by the GPU executor).
    pub dither: f32,
    pub stops: [[f32; 4]; 32],
    pub stop_offsets: [f32; 32],
}

/// What a pipeline is fixed to (`shaders/common.wgsl`): the operation and the options its shader branches on, read from the
/// pass's record. Passes that agree share a pipeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Variant {
    pub op: i32,
    pub gradient: bool,
    pub smooth: bool,
    pub artwork: bool,
    pub placement: i32,
    pub mode: i32,
}

impl Variant {
    /// The variant of a pass of `op` with record `u`.
    pub fn of(op: i32, u: &Uniform) -> Variant {
        let light = op == op::LIGHT;
        Variant {
            op,
            gradient: u.paint_type != 0,
            smooth: matches!(op, op::LIGHT | op::BLOOM) && u.maps[0][0] < 1.0,
            artwork: light && u.q[2] > 0.0,
            placement: if light { u.p[2] as i32 } else { 0 },
            mode: match op {
                op::LIGHT => u.p[3] as i32,
                op::TINT => u.p[1] as i32,
                op::GRAIN | op::CLOUDS => u.seed[3] as i32,
                _ => 0,
            },
        }
    }

    /// The WGSL constants that fix a shader to the variant, put before its prelude.
    pub fn constants(&self) -> String {
        format!(
            "const OP: i32 = {};\nconst GRADIENT: bool = {};\nconst SMOOTH: bool = {};\nconst ARTWORK: bool = {};\nconst PLACEMENT: i32 = {};\nconst MODE: i32 = {};\n",
            self.op, self.gradient, self.smooth, self.artwork, self.placement, self.mode
        )
    }
}

/// Bytes of a [`Uniform`].
pub const UNIFORM_BYTES: usize = 1024;
const _: () = assert!(std::mem::size_of::<Uniform>() == UNIFORM_BYTES);

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

/// The brush: solid or gradient stops for the passes that use one.
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

/// What an image's texels hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Texel {
    /// Premultiplied colour, eight bits a channel: the layer as the atlas holds it, and a run's result.
    Color8,
    /// Premultiplied colour (or a mask) between passes: half floats where the device renders and filters them, else eight bits
    /// dithered (the GPU executor decides; the CPU keeps floats).
    Work,
    /// Points on the artwork's edge and their strength (16-bit integers: eighths of a pixel): the jump flood's seeds.
    Seeds,
}

/// An image of a run: its size, what its texels hold and its level (0 full size; texel `j` of level `k` covers layer pixels
/// `[j·2^k − a_k, (j+1)·2^k − a_k)`, `kernels::level_offset`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Image {
    pub size: [u32; 2],
    pub texel: Texel,
    pub level: u32,
}

/// One recorded pass: operation `op` writing image `target`, reading `inputs` (`BLANK` where it reads none; the seeds, when it
/// reads any, are always its first input); `uniform` indexes the run's records.
#[derive(Clone, Copy, Debug)]
pub struct Step {
    pub op: i32,
    pub inputs: [ImageId; INPUTS],
    pub target: ImageId,
    pub uniform: u32,
}

impl Step {
    /// The images the step reads (`BLANK` for none).
    pub fn reads(&self) -> [ImageId; INPUTS] {
        self.inputs
    }
    pub fn target(&self) -> ImageId {
        self.target
    }
}

/// A recorded run: its steps, its images (the input first) and the image holding the result (the input itself when no pass ran).
#[derive(Clone, Debug, Default)]
pub struct Run {
    pub steps: Vec<Step>,
    pub images: Vec<Image>,
    pub result: ImageId,
    pub size: [u32; 2],
}

impl Run {
    /// The index of the last step reading each image (`None`: no step reads it); the result is read after the last step.
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

/// Images are placed in textures whose sides are whole multiples of this, so that a size a little different reuses a texture.
/// The sides depend on the image alone: what a pass samples never depends on the frames drawn before.
pub const BUCKET: u32 = 32;

/// The size of the texture an image of `size` is placed in.
pub fn bucket(size: [u32; 2]) -> [u32; 2] {
    size.map(|n| n.max(1).div_ceil(BUCKET) * BUCKET)
}

/// Where the images of a frame's runs live: `textures` (size and texel) are created for the frame, and `images[run][image]` names
/// the texture each image is placed in. Runs are encoded one after the other, so a texture serves every image that is not alive
/// at the same time as another it holds: an image takes a free texture of its bucket when its pass writes it and frees it after
/// the last pass that reads it (the result after the run).
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

    /// Bytes of the textures (`work` bytes a Work texel: 8 for half floats, 4 for eight bits).
    pub fn bytes(&self, work: u64) -> u64 {
        self.textures.iter().map(|(size, texel)| size[0] as u64 * size[1] as u64 * texel_bytes(*texel, work)).sum()
    }
}

/// Bytes of one texel (`work` for a Work texel).
pub fn texel_bytes(texel: Texel, work: u64) -> u64 {
    match texel {
        Texel::Color8 => 4,
        Texel::Work => work,
        Texel::Seeds => 8,
    }
}

/// Records `stack` on a `size` layer (image 0), appending its pass uniforms to `records` (a pass's `uniform` is its index there).
/// `time` is what the effects' speeds advance by: each effect's own clock (`Params::time`).
pub fn record(records: &mut Vec<Uniform>, stack: &[Arc<Effect>], frame: Frame, size: [u32; 2]) -> Run {
    let mut r = Recorder { records, steps: Vec::new(), images: vec![Image { size, texel: Texel::Color8, level: 0 }], current: INPUT, brush: Brush::default(), frame, size };
    for effect in stack.iter().filter(|e| styk_eval::vfx::is_active(e)) {
        r.effect(effect);
    }
    let result = r.current;
    if result != INPUT {
        r.images[result as usize].texel = Texel::Color8;
    }
    Run { steps: r.steps, images: r.images, result, size }
}

/// An input of a pass: an image and the map from target texel positions to its own.
#[derive(Clone, Copy)]
struct In {
    image: ImageId,
    map: [f64; 4],
}

impl In {
    const NONE: In = In { image: BLANK, map: [1.0, 1.0, 0.0, 0.0] };
    /// An image of the target's own grid.
    fn same(image: ImageId) -> In {
        In { image, map: [1.0, 1.0, 0.0, 0.0] }
    }
}

/// The numbers a pass is given besides its inputs.
#[derive(Clone, Copy, Default)]
struct Numbers {
    p: [f64; 4],
    q: [f64; 4],
    r: [f64; 4],
    s: [f64; 4],
    taps: [f64; 16],
    weights: [f64; 16],
    seed: [u32; 4],
}

/// `run`'s local state while recording one stack.
struct Recorder<'a> {
    records: &'a mut Vec<Uniform>,
    steps: Vec<Step>,
    images: Vec<Image>,
    current: ImageId,
    brush: Brush,
    frame: Frame,
    /// The layer's size.
    size: [u32; 2],
}

/// Pixels a jump flood reaches beyond the widest distance it is asked for (antialiasing and sub-pixel edges).
const FLOOD_MARGIN: f64 = 2.0;

impl Recorder<'_> {
    fn image(&self, id: ImageId) -> Image {
        self.images[id as usize]
    }

    /// A pass of `op` writing a new image `target`, reading `inputs`.
    fn pass(&mut self, op: i32, target: Image, inputs: [In; INPUTS], n: Numbers) -> ImageId {
        let f = |v: [f64; 4]| v.map(|x| x as f32);
        let mut taps = [[0f32; 4]; 4];
        let mut weights = [[0f32; 4]; 4];
        for i in 0..16 {
            taps[i / 4][i % 4] = n.taps[i] as f32;
            weights[i / 4][i % 4] = n.weights[i] as f32;
        }
        let input = |k: usize| match inputs[k].image {
            BLANK => [0.0; 4],
            id => {
                let size = self.images[id as usize].size;
                [0.0, 0.0, size[0] as f32, size[1] as f32]
            }
        };
        let record = Uniform {
            target: [target.size[0] as f32, target.size[1] as f32],
            level: target.level as f32,
            operation: op,
            origin: [self.frame.origin[0] as f32, self.frame.origin[1] as f32],
            output_size: [self.frame.output_size[0] as f32, self.frame.output_size[1] as f32],
            inputs: [input(0), input(1), input(2), input(3)],
            maps: inputs.map(|i| f(i.map)),
            p: f(n.p),
            q: f(n.q),
            r: f(n.r),
            s: f(n.s),
            taps,
            weights,
            seed: n.seed,
            paint_type: self.brush.kind,
            stop_count: self.brush.count,
            paint_angle: self.brush.angle,
            dither: 0.0,
            stops: self.brush.colors,
            stop_offsets: self.brush.offsets,
        };
        let uniform = self.records.len() as u32;
        self.records.push(record);
        let id = self.images.len() as ImageId;
        self.images.push(target);
        self.steps.push(Step { op, inputs: inputs.map(|i| i.image), target: id, uniform });
        id
    }

    /// A full-size image of `texel`.
    fn full(&self, texel: Texel) -> Image {
        Image { size: self.size, texel, level: 0 }
    }

    /// `image` (at its level `k`) halved to level `k + 1` on the global grid: a tent (`op::TENT`), a box (`op::BOX`), or the
    /// bloom's bright-pass tent (`op::BRIGHT`, with `n`).
    fn reduce(&mut self, image: ImageId, op: i32, n: Numbers) -> ImageId {
        let from = self.image(image);
        let k = from.level;
        let a = kernels::level_offset(self.frame.origin, k);
        let a1 = kernels::level_offset(self.frame.origin, k + 1);
        let step = (1u64 << k) as f64;
        let b = [(a1[0] - a[0]) / step, (a1[1] - a[1]) / step];
        let size = kernels::level_size(self.size, self.frame.origin, k + 1);
        self.pass(op, Image { size, texel: Texel::Work, level: k + 1 }, [In { image, map: [2.0, 2.0, -b[0], -b[1]] }, In::NONE, In::NONE, In::NONE], n)
    }

    /// The Gaussian of `sigma` (level-0 pixels) along both axes of `image` at its level, by the discrete Gaussian kernel. With
    /// `finish`, the second pass is the effect's result (full size): mixed with `base` by `strength`.
    fn convolve(&mut self, image: ImageId, sigma: f64, finish: Option<(ImageId, f64)>) -> ImageId {
        let w = kernels::discrete_gaussian(sigma);
        let samples = kernels::bilinear_samples(&w);
        let mut n = Numbers::default();
        for (i, (offset, weight)) in samples.iter().enumerate().take(kernels::MAX_SAMPLES) {
            n.taps[i] = *offset;
            n.weights[i] = *weight;
        }
        n.seed[0] = samples.len().min(kernels::MAX_SAMPLES) as u32;
        let target = Image { texel: Texel::Work, ..self.image(image) };
        // p.xy: the axis; p.z: 1 when the pass is the effect's result, mixed with its base (input 1) by the strength (s.w).
        n.p = [1.0, 0.0, 0.0, 0.0];
        let across = self.pass(op::CONVOLVE, target, [In::same(image), In::NONE, In::NONE, In::NONE], n);
        n.p = [0.0, 1.0, 0.0, 0.0];
        let base = match finish {
            Some((base, strength)) => {
                n.p[2] = 1.0;
                n.s[3] = strength;
                In::same(base)
            }
            None => In::NONE,
        };
        self.pass(op::CONVOLVE, target, [In::same(across), base, In::NONE, In::NONE], n)
    }

    /// `image` (level 0) blurred by the Gaussian of `sigma` (level-0 pixels), at the level its plan halves it to: read at full size
    /// with the cubic B-spline when that level is above 0 (`kernels::gaussian`).
    fn gaussian(&mut self, image: ImageId, sigma: f64) -> ImageId {
        let plan = kernels::gaussian(sigma);
        let mut at = image;
        for _ in 0..plan.level {
            at = self.reduce(at, op::TENT, Numbers::default());
        }
        if plan.residual > 0.0 {
            at = self.convolve(at, plan.residual, None);
        }
        at
    }

    /// An input reading level-`k` image `image` from a level-0 target (texel `x` of the target is at `(x + a_k) / 2^k` there).
    fn from_level(&self, image: ImageId) -> In {
        let k = self.image(image).level;
        let a = kernels::level_offset(self.frame.origin, k);
        let step = (1u64 << k) as f64;
        In { image, map: [1.0 / step, 1.0 / step, a[0] / step, a[1] / step] }
    }

    /// The jump flood of `image`'s edge: seeds holding, at each pixel within `reach` pixels of the edge, the nearest point on the
    /// edge (sub-pixel, from the edge's coverage), by straight distance or (`square`) by the larger of the two axes.
    fn flood(&mut self, image: ImageId, reach: f64, square: bool) -> ImageId {
        let seeds = self.full(Texel::Seeds);
        let metric = if square { 1.0 } else { 0.0 };
        let mut n = Numbers { p: [0.0, metric, 0.0, 0.0], ..Default::default() };
        let mut at = self.pass(op::SEED, seeds, [In::NONE, In::same(image), In::NONE, In::NONE], n);
        // A seed travels at most 2k − 1 pixels over steps k, k/2, …, 1; one step of 1 first makes the flood's choices better
        // (1 + JFA).
        let reach = (reach + FLOOD_MARGIN).max(1.0);
        let first = ((reach + 1.0) / 2.0).ceil().max(1.0) as u64;
        let first = first.next_power_of_two();
        let mut steps = vec![1u64];
        let mut k = first;
        while k >= 1 {
            steps.push(k);
            k /= 2;
        }
        for step in steps {
            n.p[0] = step as f64;
            at = self.pass(op::JUMP, seeds, [In::same(at), In::NONE, In::NONE, In::NONE], n);
        }
        at
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
                b.count = paint.stops.len().min(32) as i32;
                for (i, s) in paint.stops.iter().take(32).enumerate() {
                    b.colors[i] = [s.rgb[0] as f32 / 255.0, s.rgb[1] as f32 / 255.0, s.rgb[2] as f32 / 255.0, s.opacity as f32];
                    b.offsets[i] = s.offset as f32;
                }
            }
        }
    }

    /// A one-pass operation of the current image at full size, its result mixed with `base` by `strength` (every shader reads
    /// the strength from `s.w`).
    fn simple(&mut self, op: i32, base: ImageId, strength: f64, mut n: Numbers) -> ImageId {
        n.s[3] = strength;
        let current = self.current;
        let target = self.full(Texel::Work);
        self.pass(op, target, [In::same(current), In::same(base), In::NONE, In::NONE], n)
    }

    fn effect(&mut self, effect: &Effect) {
        let params = &effect.params;
        let scale = self.frame.scale;
        let strength = params.effect_strength();
        let time = params.time();
        let base = self.current;
        let radians = |deg: f64| deg * PI / 180.0;
        self.current = match params {
            P::Tint(p) => {
                self.paint(&p.color);
                self.simple(op::TINT, base, strength, Numbers { p: [p.mix, p.blend.index() as f64, 0.0, 0.0], ..Default::default() })
            }
            P::Grade(p) => {
                let hue = radians(p.hue);
                self.simple(op::GRADE, base, strength, Numbers { p: [p.exposure, p.contrast, p.saturation, p.temperature], q: [p.tint, p.shadows, p.highlights, p.gamma], r: [hue.cos(), hue.sin(), 0.0, 0.0], ..Default::default() })
            }
            P::Blur(p) => {
                let radius = p.radius * scale;
                if p.mode == BlurMode::Gaussian {
                    self.blur(base, kernels::sigma_of_radius(radius), strength)
                } else {
                    self.line(base, p.mode, radius, radians(p.angle), [p.center_x, p.center_y], strength)
                }
            }
            P::Glow(p) => {
                self.paint(&p.color);
                let front = if p.core_mix != 0.0 {
                    self.paint(&p.core_color);
                    let tinted = self.simple(op::TINT, base, 1.0, Numbers { p: [p.core_mix, 0.0, 0.0, 0.0], ..Default::default() });
                    self.paint(&p.color);
                    tinted
                } else {
                    base
                };
                let (inner, outer) = match p.mode {
                    GlowPlacement::Both => (true, true),
                    GlowPlacement::Inner => (true, false),
                    GlowPlacement::Outer => (false, true),
                };
                let artwork = p.source == GlowSource::Artwork;
                let blend = p.blend.index() as f64;
                self.light(front, base, Light { radius: p.radius * scale, spread: p.spread * scale, offset: [0.0; 2], intensity: p.intensity, falloff: p.falloff, inner, outer, blend, artwork, strength })
            }
            P::Shadow(p) => {
                self.paint(&p.color);
                let inner = p.mode == ShadowPlacement::Inner;
                self.light(base, base, Light { radius: p.radius * scale, spread: p.spread * scale, offset: [p.offset_x * scale, p.offset_y * scale], intensity: p.opacity, falloff: 1.0, inner, outer: !inner, blend: 0.0, artwork: false, strength })
            }
            P::Outline(p) => {
                self.paint(&p.color);
                let width = p.width * scale;
                let (outside, inside) = match p.mode {
                    OutlinePlacement::Outside => (width, 0.0),
                    OutlinePlacement::Inside => (0.0, width),
                    OutlinePlacement::Center => (width / 2.0, width / 2.0),
                };
                // The feather: a ramp of `feather` pixels (at least one, the antialiasing) centred on each edge of the outline.
                let feather = (p.softness * width).max(1.0);
                let seeds = self.flood(base, outside.max(inside) + feather, !p.rounded);
                let target = self.full(Texel::Work);
                let n = Numbers { p: [outside, inside, feather, p.opacity], q: [p.only as u8 as f64, if p.rounded { 0.0 } else { 1.0 }, 0.0, 0.0], s: [0.0, 0.0, 0.0, strength], ..Default::default() };
                self.pass(op::OUTLINE, target, [In::same(seeds), In::same(base), In::NONE, In::NONE], n)
            }
            P::Pixelate(p) => {
                let y = if p.linked { p.size } else { p.size_y };
                self.pixelate(base, [(p.size * scale).max(1.0), (y * scale).max(1.0)], [p.offset_x * scale, p.offset_y * scale], strength)
            }
            P::Noise(p) => {
                // A grain re-rolls with each 1/1024 of its phase (as saved), and `speed` times a frame on its own.
                let roll = (p.phase * 1024.0).floor() as u64 + (p.speed * time).floor().max(0.0) as u64;
                let seed = (p.seed as u64).wrapping_add(roll) as u32;
                let size = (p.size * scale).max(1.0);
                let n = Numbers { p: [p.amount, size, p.contrast, p.softness], q: [p.colored as u8 as f64, p.phase + p.speed * time * CLOUDS_RATE, 0.0, 0.0], seed: [seed, p.seed, CLOUD_OCTAVES, if p.colored { 3 } else { 1 }], ..Default::default() };
                let op = if p.pattern == styk_eval::vfx::registry::NoisePattern::Clouds { op::CLOUDS } else { op::GRAIN };
                self.simple(op, base, strength, n)
            }
            P::Vignette(p) => {
                self.paint(&p.color);
                self.simple(op::VIGNETTE, base, strength, Numbers { p: [p.amount, p.softness, p.radius, 0.0], q: [p.center_x, p.center_y, p.aspect, p.roundness], ..Default::default() })
            }
            P::Dissolve(p) => {
                self.paint(&p.color);
                let angle = radians(p.angle);
                let n = Numbers { p: [p.progress, p.size * scale, p.softness, p.edge], q: [p.directional, angle.cos(), angle.sin(), 0.0], seed: [p.seed, 0, 0, 0], ..Default::default() };
                self.simple(op::DISSOLVE, base, strength, n)
            }
            P::RgbSplit(p) => self.simple(op::SPLIT, base, strength, Numbers { p: [p.amount * scale, radians(p.angle), 0.0, 0.0], q: [p.red, p.green, p.blue, 0.0], ..Default::default() }),
            P::Turbulence(p) => {
                let evolution = p.evolution + p.speed * time;
                self.simple(op::TURBULENCE, base, strength, Numbers { p: [p.amount * scale, p.size * scale, evolution, p.detail as f64], seed: [p.seed, 0, 0, 0], ..Default::default() })
            }
            P::Wave(p) => {
                let phase = radians(p.phase + p.speed * time);
                self.simple(op::WAVE, base, strength, Numbers { p: [p.strength * scale, p.wavelength * scale, radians(p.angle), phase], ..Default::default() })
            }
            P::Shockwave(p) => self.simple(op::SHOCK, base, strength, Numbers { p: [p.radius * scale, p.thickness * scale, p.strength * scale, p.falloff], q: [p.center_x, p.center_y, 0.0, 0.0], ..Default::default() }),
            P::Bloom(p) => {
                self.paint(&p.color);
                self.bloom(base, p.threshold, p.softness, kernels::sigma_of_radius(p.radius * scale), p.intensity, strength)
            }
            P::LightSweep(p) => {
                self.paint(&p.color);
                let angle = radians(p.angle);
                let position = sweep_position(p.position, p.speed * time, angle, p.width, p.looped);
                self.simple(op::SWEEP, base, strength, Numbers { p: [position, angle, p.width, p.softness], q: [p.intensity, 0.0, 0.0, 0.0], ..Default::default() })
            }
            P::Crt(p) => {
                self.paint(&p.color);
                let phase = (p.phase + p.roll * time) * scale;
                self.simple(op::CRT, base, strength, Numbers { p: [p.amount, p.spacing * scale, p.curvature, p.chromatic * scale], q: [phase, 0.0, 0.0, 0.0], ..Default::default() })
            }
            // Generated effects draw artwork of their own; they never reach a filter stack.
            P::Particles(_) | P::Aura(_) | P::Beam(_) | P::Smoke(_) | P::Explosion(_) => base,
        };
    }

    /// A Gaussian blur of `sigma` (level-0 pixels) of `base`, the effect's result.
    fn blur(&mut self, base: ImageId, sigma: f64, strength: f64) -> ImageId {
        let plan = kernels::gaussian(sigma);
        if plan.level == 0 {
            return self.convolve(base, plan.residual, Some((base, strength)));
        }
        let blurred = self.gaussian(base, sigma);
        let target = self.full(Texel::Work);
        let n = Numbers { s: [0.0, 0.0, 0.0, strength], ..Default::default() };
        let from = self.from_level(blurred);
        self.pass(op::SPLINE, target, [from, In::same(base), In::NONE, In::NONE], n)
    }

    /// A directional, zoom or radial blur of `base`: `radius` (pixels) is how far a pixel at the domain's edge is carried each way.
    fn line(&mut self, base: ImageId, mode: BlurMode, radius: f64, angle: f64, center: [f64; 2], strength: f64) -> ImageId {
        let domain = self.frame.output_size;
        let c = [center[0] * domain[0], center[1] * domain[1]];
        // The distance from the centre to the domain's farthest corner: where `radius` is the blur's length.
        let reach = [[0.0, 0.0], [domain[0], 0.0], [0.0, domain[1]], domain].iter().map(|k| (k[0] - c[0]).hypot(k[1] - c[1])).fold(1.0, f64::max);
        let (family, extent, length) = match mode {
            BlurMode::Zoom => {
                let extent = (1.0 + radius / reach).ln();
                (2.0, extent, reach * (extent.exp() - (-extent).exp()))
            }
            BlurMode::Radial => {
                let extent = (radius / reach).min(PI);
                (3.0, extent, 2.0 * reach * extent)
            }
            _ => (1.0, radius, 2.0 * radius),
        };
        let plan = kernels::line(extent, length);
        let mut at = base;
        for pass in 0..plan.passes {
            let spacing = plan.step * (plan.taps as f64).powi(pass as i32);
            let last = pass + 1 == plan.passes;
            let n = Numbers { p: [family, plan.taps as f64, spacing, last as u8 as f64], q: [c[0], c[1], angle.cos(), angle.sin()], s: [0.0, 0.0, 0.0, strength], ..Default::default() };
            let target = self.full(Texel::Work);
            at = self.pass(op::LINE, target, [In::same(at), if last { In::same(base) } else { In::NONE }, In::NONE, In::NONE], n);
        }
        at
    }

    /// Glow and shadow: the artwork's mask (spread by a distance from its edge where `spread` is set), blurred, composited under
    /// (outer) or inside (inner) `front`, the result mixed with `base`.
    fn light(&mut self, front: ImageId, base: ImageId, l: Light) -> ImageId {
        // The mask: alpha (outer) and the inverted, eroded alpha (inner) of the spread, or the artwork itself.
        let mask = if l.spread > 0.0 {
            let seeds = self.flood(base, l.spread, false);
            let target = self.full(Texel::Work);
            self.pass(op::SPREAD, target, [In::same(seeds), In::same(base), In::NONE, In::NONE], Numbers { p: [l.spread, 0.0, 0.0, 0.0], ..Default::default() })
        } else {
            base
        };
        let sigma = kernels::sigma_of_radius(l.radius);
        let blurred = if sigma > 0.0 { self.gaussian(mask, sigma) } else { mask };
        // The artwork's own colours: its blur (the mask's, when the mask is the artwork).
        let colour = match (l.artwork, l.spread > 0.0) {
            (false, _) => BLANK,
            (true, false) => blurred,
            (true, true) => {
                if sigma > 0.0 {
                    self.gaussian(base, sigma)
                } else {
                    base
                }
            }
        };
        let target = self.full(Texel::Work);
        let modes = (l.inner as u8 as f64) + 2.0 * (l.outer as u8 as f64);
        // q.w: the mask's inner channel is its red (a spread) or one less its alpha.
        let n = Numbers {
            p: [l.intensity, l.falloff, modes, l.blend],
            q: [l.offset[0], l.offset[1], l.artwork as u8 as f64, (l.spread > 0.0) as u8 as f64],
            s: [0.0, 0.0, 0.0, l.strength],
            ..Default::default()
        };
        let mask_in = self.from_level(blurred);
        let colour_in = if colour == BLANK { In::NONE } else { self.from_level(colour) };
        self.pass(op::LIGHT, target, [mask_in, In::same(front), In::same(base), colour_in], n)
    }

    /// Pixelate: each cell of `cell` pixels (on the global grid moved by `offset`) shows the average of what it covers.
    fn pixelate(&mut self, base: ImageId, cell: [f64; 2], offset: [f64; 2], strength: f64) -> ImageId {
        // Halved (boxes) until a cell spans two to four texels, so a cell's average reads at most 5 × 5 texels.
        let level = ((cell[0].min(cell[1]) / 2.0).log2().floor().max(0.0) as u32).min(kernels::MAX_LEVEL);
        let mut at = base;
        for _ in 0..level {
            at = self.reduce(at, op::BOX, Numbers::default());
        }
        // The cells covering the layer.
        let origin = self.frame.origin;
        let first = [0, 1].map(|k| ((origin[k] - offset[k]) / cell[k]).floor());
        let last = [0, 1].map(|k| ((origin[k] + self.size[k] as f64 - offset[k]) / cell[k]).floor());
        let count = [0, 1].map(|k| (last[k] - first[k] + 1.0).max(1.0) as u32);
        let a = kernels::level_offset(origin, level);
        let step = (1u64 << level) as f64;
        let n = Numbers { p: [cell[0], cell[1], offset[0], offset[1]], q: [first[0], first[1], a[0], a[1]], r: [step, 0.0, 0.0, 0.0], ..Default::default() };
        let cells = self.pass(op::CELLS, Image { size: count, texel: Texel::Work, level: 0 }, [In { image: at, map: [1.0, 1.0, 0.0, 0.0] }, In::NONE, In::NONE, In::NONE], n);
        let target = self.full(Texel::Work);
        let n = Numbers { p: [cell[0], cell[1], offset[0], offset[1]], q: [first[0], first[1], 0.0, 0.0], s: [0.0, 0.0, 0.0, strength], ..Default::default() };
        self.pass(op::SHOW, target, [In { image: cells, map: [1.0, 1.0, 0.0, 0.0] }, In::same(base), In::NONE, In::NONE], n)
    }

    /// Bloom: what is brighter than `threshold` (a soft knee of `softness`), halved level after level, each level enlarged into
    /// the one below and added to it, so near levels give a bright core and far ones a wide falloff; `sigma` (the radius) says how
    /// many levels, the farthest one faded in by the fraction of its level, so the spread grows continuously. A level weighs its
    /// own width over `sigma` (at most 1, `bloom_weight`): on a thin stroke every level is about as bright, the farthest is the
    /// old single blur's halo at full weight, and the weights change continuously with the radius.
    fn bloom(&mut self, base: ImageId, threshold: f64, softness: f64, sigma: f64, intensity: f64, strength: f64) -> ImageId {
        let levels = (sigma / BLOOM_SIGMA).max(1.0).log2() + 1.0;
        let top = (levels.ceil() as u32).clamp(1, kernels::MAX_LEVEL);
        let fraction = (levels - (top as f64 - 1.0)).clamp(0.0, 1.0);
        let mut chain = vec![self.reduce(base, op::BRIGHT, Numbers { p: [threshold, softness, 0.0, 0.0], ..Default::default() })];
        for _ in 1..top {
            let last = *chain.last().expect("a level");
            chain.push(self.reduce(last, op::TENT, Numbers::default()));
        }
        // From the farthest level down to level 1: each enlarged into the next and added to it.
        let mut sum = *chain.last().expect("a level");
        let mut weight = bloom_weight(top, sigma) * fraction;
        for &image in chain.iter().rev().skip(1) {
            let target = Image { texel: Texel::Work, ..self.image(image) };
            let k = target.level;
            let a = kernels::level_offset(self.frame.origin, k);
            let a1 = kernels::level_offset(self.frame.origin, k + 1);
            let step = (1u64 << k) as f64;
            let b = [(a1[0] - a[0]) / step, (a1[1] - a[1]) / step];
            let coarser = In { image: sum, map: [0.5, 0.5, b[0] / 2.0, b[1] / 2.0] };
            sum = self.pass(op::ACCUMULATE, target, [coarser, In::same(image), In::NONE, In::NONE], Numbers { p: [weight, bloom_weight(k, sigma), 0.0, 0.0], ..Default::default() });
            weight = 1.0;
        }
        // A lone level is its own sum (its fraction is one then).
        let scale = if top == 1 { bloom_weight(1, sigma) } else { 1.0 };
        let target = self.full(Texel::Work);
        let n = Numbers { p: [intensity, scale, 0.0, 0.0], s: [0.0, 0.0, 0.0, strength], ..Default::default() };
        let from = self.from_level(sum);
        self.pass(op::BLOOM, target, [from, In::same(base), In::NONE, In::NONE], n)
    }
}

/// How a glow or shadow is made (`Recorder::light`).
#[derive(Clone, Copy)]
struct Light {
    radius: f64,
    spread: f64,
    offset: [f64; 2],
    intensity: f64,
    falloff: f64,
    inner: bool,
    outer: bool,
    blend: f64,
    artwork: bool,
    strength: f64,
}

/// The blur of the first bloom level (level-0 pixels): the bloom's narrowest scale.
const BLOOM_SIGMA: f64 = 1.5;

/// The weight of bloom level `level` (1 the first) for a bloom of `sigma`: the level's width over the bloom's, at most one.
pub fn bloom_weight(level: u32, sigma: f64) -> f64 {
    (BLOOM_SIGMA * 2f64.powi(level as i32 - 1) / sigma.max(1e-9)).min(1.0)
}
/// Octaves of the clouds.
const CLOUD_OCTAVES: u32 = 4;
/// How far the clouds evolve a frame at speed 1 (lattice steps of their third dimension).
pub const CLOUDS_RATE: f64 = 0.25;

/// The light sweep's position after it moved by `moved` (positions a frame times frames): with `looped`, it comes back in on the
/// other side once its band has left the domain along `angle` (radians), so it repeats; without, it goes on and leaves.
pub fn sweep_position(position: f64, moved: f64, angle: f64, width: f64, looped: bool) -> f64 {
    let at = position + moved;
    if !looped || moved == 0.0 {
        return at;
    }
    // Positions along the sweep run over the domain's projection on its direction, centred on 0.5.
    let half = (angle.cos().abs() + angle.sin().abs()) / 2.0;
    let (lo, hi) = (0.5 - half - width / 2.0, 0.5 + half + width / 2.0);
    lo + (at - lo).rem_euclid(hi - lo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_eval::vfx::registry::{Blur, Glow, Outline};

    fn ops(run: &Run) -> Vec<i32> {
        run.steps.iter().map(|s| s.op).collect()
    }

    fn frame() -> Frame {
        Frame { scale: 1.0, origin: [-7.0, 3.0], output_size: [100.0, 80.0] }
    }

    /// A wide glow at half strength: halvings, a small kernel there, then one composite at full size that takes the strength
    /// itself, reading the layer again (nothing copied).
    #[test]
    fn a_wide_glow_is_halvings_a_small_kernel_and_one_composite() {
        let glow = Effect { id: Arc::from("g"), enabled: true, params: P::Glow(Glow { radius: 30.0, effect_strength: 0.5, ..Default::default() }) };
        let mut records = Vec::new();
        let run = record(&mut records, &[Arc::new(glow)], frame(), [120, 90]);
        let plan = kernels::gaussian(kernels::sigma_of_radius(30.0));
        let mut expected = vec![op::TENT; plan.level as usize];
        expected.extend([op::CONVOLVE, op::CONVOLVE, op::LIGHT]);
        assert_eq!(ops(&run), expected);
        let last = run.steps.last().unwrap();
        assert_eq!(last.inputs[1], INPUT, "the composite reads the layer as its front");
        assert_eq!(records[last.uniform as usize].s[3], 0.5, "and takes the strength itself");
        assert_eq!(run.images[run.result as usize].texel, Texel::Color8, "the run's result is the atlas's eight bits");
        // The halved images lie on the global grid: level 2 of a layer whose first pixel is at -7.
        let level2 = run.images.iter().find(|i| i.level == 2).unwrap();
        assert_eq!(level2.size, kernels::level_size([120, 90], [-7.0, 3.0], 2));
        assert!(run.peak_pixels() < 3 * 120 * 90, "{}", run.peak_pixels());
    }

    /// An outline is a jump flood of the edge and one composite; a square outline floods by the larger axis.
    #[test]
    fn an_outline_floods_the_edge_once() {
        let outline = Effect { id: Arc::from("o"), enabled: true, params: P::Outline(Outline { width: 4.0, mode: OutlinePlacement::Center, rounded: false, ..Default::default() }) };
        let off = Effect { id: Arc::from("x"), enabled: false, params: P::Tint(Default::default()) };
        let mut records = Vec::new();
        let run = record(&mut records, &[Arc::new(off), Arc::new(outline)], frame(), [40, 40]);
        let o = ops(&run);
        assert_eq!(o[0], op::SEED);
        assert!(o[1..o.len() - 1].iter().all(|&p| p == op::JUMP));
        assert_eq!(*o.last().unwrap(), op::OUTLINE);
        assert_eq!(records[run.steps[0].uniform as usize].p[1], 1.0, "square: by the larger axis");
        assert!(run.images.iter().any(|i| i.texel == Texel::Seeds));
    }

    /// Images share a texture when they are not alive together; runs share them one after the other.
    #[test]
    fn images_share_textures_they_do_not_need_at_once() {
        let glow = Effect { id: Arc::from("g"), enabled: true, params: P::Glow(Glow { radius: 30.0, ..Default::default() }) };
        let blur = Effect { id: Arc::from("b"), enabled: true, params: P::Blur(Blur { radius: 4.0, ..Default::default() }) };
        let mut records = Vec::new();
        let a = record(&mut records, &[Arc::new(glow)], frame(), [120, 90]);
        let b = record(&mut records, &[Arc::new(blur)], frame(), [120, 90]);
        let placement = Placement::of(&[&a, &b]);
        let one = Placement::of(&[&a]);
        assert!(placement.textures.len() <= one.textures.len() + 1, "the blur reuses the glow's textures: {:?}", placement.textures);
        for (run, place) in [&a, &b].iter().zip(&placement.images) {
            for step in &run.steps {
                assert!(!step.reads().iter().any(|&r| r != BLANK && place[r as usize] == place[step.target() as usize]), "a pass never writes a texture it reads");
            }
        }
    }

    #[test]
    fn a_looping_sweep_comes_back() {
        let width = 0.2;
        assert_eq!(sweep_position(0.5, 0.0, 0.0, width, true), 0.5, "a still sweep stays where it is put");
        let leaves = 0.5 + 0.5 + width / 2.0;
        let back = sweep_position(0.5, leaves - 0.5 + 0.01, 0.0, width, true);
        assert!(back < 0.0, "once out on the right it comes back on the left: {back}");
        assert!((sweep_position(0.5, 3.0, 0.0, width, false) - 3.5).abs() < 1e-12);
    }
}
