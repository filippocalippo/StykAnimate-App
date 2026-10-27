//! One frame, drawn as styk-render draws it (`frame.rs`, `prim.wgsl`): every group in the
//! space styk-render's plan gives it for the view (`effects::plan`, `effects::record`), into a
//! target of its own with the GPU's samples; each record covered and shaded by the shader's
//! rules; filtered layers run their effect recipes; each layer composited into its parent
//! at its place in painter order, sampled as the GPU samples it.

use styk_draw::*;
use styk_eval::assets::PAGE;
use styk_render::effects::{self, plan, recipe, Slot};
use styk_render::ViewParams;

use crate::coverage::{positions, quad, spans, Triangle};
use crate::glyphs::Placed;
use crate::shade::*;
use crate::target::{quantize, Px, Target};
use crate::Images;

/// The largest texture side the plan may use, as a WebGPU device's default limit.
pub(crate) const MAX_TEXTURE: u32 = 8192;

/// Where a group is drawn this frame: its pixels and how they map to the world and its parent.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Layer {
    pub drawn: bool,
    /// World → this layer's pixels (single precision, as the vertex shader maps them).
    pub m32: [f32; 6],
    /// This layer's pixels → world.
    pub inv: Affine,
    /// World units a pixel (`aa` in prim.wgsl).
    pub aa: f32,
    pub size: [usize; 2],
    /// This layer's pixels → its parent's (composites), and the part of it shown.
    pub p: Affine,
    pub show: [f64; 4],
    pub filter: Option<plan::Filter>,
    /// The editor paints this layer with Canvas 2D (`plan::Placement::canvas`).
    pub canvas: bool,
}

/// What a frame costs: its layers, effect passes and the most bytes its targets held at once.
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub layers: u32,
    pub effect_layers: u32,
    pub effect_passes: u32,
    pub peak_bytes: usize,
    pub glyph_masks: u32,
    pub glyph_masks_filled: u32,
    pub glyph_bytes: usize,
}

pub(crate) struct Frame<'a> {
    pub list: &'a DrawList,
    pub images: &'a Images,
    pub crisp: bool,
    pub samples: usize,
    pub layers: Vec<Layer>,
    /// Each group's prims: one run of the list.
    pub runs: Vec<(usize, usize)>,
    /// Each lone glyph's mask this frame, or `None` where its triangles draw.
    pub glyphs: Vec<Option<Placed>>,
    pub view: &'a ViewParams,
    pub stats: Stats,
    /// Bytes the targets being drawn hold now.
    pub held: usize,
    paint_context: styk_render::paint::PaintContext,
}

impl<'a> Frame<'a> {
    pub fn new(list: &'a DrawList, images: &'a Images, view: &'a ViewParams, size: [u32; 2], crisp: bool, glyphs: Vec<Option<Placed>>, drawing_grid: crate::DrawingGrid, paint_context: styk_render::paint::PaintContext) -> Frame<'a> {
        let n = list.groups.len().max(1);
        let planned = plan::plan_with_grid(
            list,
            &plan::View { matrix: view.matrix, size, zoom: view.zoom, pan: view.pan, orient: plan::IDENTITY, stretch: view.stretch, camera_view: view.camera_view, camera_limit: view.camera_limit, max_texture: MAX_TEXTURE },
            drawing_grid,
        );
        let det = view.matrix[0] * view.matrix[3] - view.matrix[1] * view.matrix[2];
        let root = Layer {
            drawn: true,
            m32: single(view.matrix),
            inv: invert(view.matrix),
            aa: 1.0 / (det.abs().sqrt() as f32).max(1e-12),
            size: [size[0] as usize, size[1] as usize],
            p: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            show: [0.0, 0.0, size[0] as f64, size[1] as f64],
            filter: None,
            // Direct Canvas monitor paints use the same high-quality cel sampler
            // as isolated Canvas layers. Ordinary GPU/Prepared roots stay native.
            canvas: matches!(paint_context, styk_render::paint::PaintContext::CanvasDirect { .. } | styk_render::paint::PaintContext::CanvasForeground { .. }),
        };
        let mut layers = vec![root; n];
        let mut matrices: Vec<Affine> = vec![view.matrix; n];
        for g in 1..list.groups.len() {
            let placement = &planned[g];
            // Each layer is a target of its own: its first pixel at the origin.
            let (r, m) = effects::record(placement, matrices[list.groups[g].parent as usize], Some(Slot { page: 0, offset: [0.0, 0.0], scale: 1.0 }));
            matrices[g] = m;
            let f = |k: usize| r[k] as f64;
            let size = placement.size();
            layers[g] = Layer {
                drawn: r[6] >= 0.0 && placement.drawn() && size[0] > 0 && size[1] > 0,
                m32: single(m),
                inv: invert(m),
                aa: r[7],
                size: [size[0] as usize, size[1] as usize],
                p: [f(12), f(13), f(14), f(15), f(16), f(17)],
                show: [f(20), f(21), f(22), f(23)],
                filter: placement.filter,
                canvas: placement.canvas,
            };
        }
        let mut runs = vec![(usize::MAX, 0usize); n];
        for (i, p) in list.prims.iter().enumerate() {
            if let Some(run) = runs.get_mut(p.group as usize) {
                run.0 = run.0.min(i);
                run.1 = i + 1;
            }
        }
        for run in &mut runs {
            if run.0 == usize::MAX {
                *run = (0, 0);
            }
        }
        Frame { list, images, crisp, samples: if crisp { 1 } else { 4 }, layers, runs, glyphs, view, stats: Stats::default(), held: 0, paint_context }
    }

    /// Draws the frame: group 0 into a target of the view's size cleared to `clear`.
    pub fn draw(&mut self) -> Vec<Px> {
        let [w, h] = self.layers[0].size;
        let c = self.view.clear;
        let clear = [quantize(c[0] as f32), quantize(c[1] as f32), quantize(c[2] as f32), quantize(c[3] as f32)];
        let mut target = Target::new(w, h, self.samples, clear);
        if matches!(self.paint_context, styk_render::paint::PaintContext::CanvasDirect { .. } | styk_render::paint::PaintContext::CanvasForeground { .. }) {
            target.set_canvas_clip(styk_render::paint::CanvasClip::new(self.view.artboard));
        }
        self.hold(target.bytes() as isize);
        self.group(0, &mut target);
        let bytes = target.bytes();
        let pixels = target.resolve();
        self.hold(-(bytes as isize));
        pixels
    }

    fn hold(&mut self, bytes: isize) {
        self.held = (self.held as isize + bytes).max(0) as usize;
        self.stats.peak_bytes = self.stats.peak_bytes.max(self.held);
    }

    /// Draws group `g`'s prims into `target` (its layer's pixels) in painter order.
    fn group(&mut self, g: usize, target: &mut Target) {
        let (start, end) = self.runs[g];
        let layer = self.layers[g];
        let full = [0, 0, target.width as i64, target.height as i64];
        // The frame's figures are clipped to the artboard (the GPU's scissor); its background is not.
        let background = if g == 0 { self.list.background_prims as usize } else { 0 };
        let scissor = if g == 0 && self.view.clip_to_artboard {
            let a = self.view.artboard;
            let (w, h) = (target.width as f64, target.height as f64);
            [a[0].clamp(0.0, w).floor() as i64, a[1].clamp(0.0, h).floor() as i64, a[2].clamp(0.0, w).ceil() as i64, a[3].clamp(0.0, h).ceil() as i64]
        } else {
            full
        };
        let mut i = start + if g == 0 && matches!(self.paint_context, styk_render::paint::PaintContext::CanvasForeground { .. }) { background.min(end-start) } else { 0 };
        while i < end {
            let p = self.list.prims[i];
            let clip = if i - start < background { full } else { scissor };
            if clip[2] <= clip[0] || clip[3] <= clip[1] {
                i += 1;
                continue;
            }
            match p.kind & 255 {
                K_DEPTH_RESET => {
                    let faces = self.list.prims[i + 1..end].iter().take_while(|q| q.kind & 255 == K_TRI && q.kind & F_DEPTH != 0).count();
                    self.depth_run(target, &layer, clip, &p, i + 1..i + 1 + faces);
                    i += 1 + faces;
                    continue;
                }
                K_CAPSULE | K_BOX | K_ARC | K_DISC | K_RING => self.analytic(target, &layer, clip, &p),
                K_POLYLINE => self.polyline(target, &layer, clip, &p),
                K_TRI => self.triangle(target, &layer, clip, &p),
                K_IMAGE => self.image(target, &layer, clip, &p),
                K_GLYPH => self.glyph(target, &layer, clip, &p),
                K_COMPOSITE => self.composite(target, clip, &p),
                K_FILL_VIEW | K_BG_IMAGE => self.fill(target, g, &layer, clip, &p),
                K_PARTICLE | K_BEAM => crate::generators::draw(self.list, &p, target, &layer, clip, positions(self.samples)),
                _ => {}
            }
            i += 1;
        }
    }

    /// The straight colour of `p` at world point `w`: its paint there, or its colour.
    #[inline]
    fn base(&self, p: &Prim, w: [f32; 2]) -> [f32; 4] {
        if p.paint != NO_PAINT { sample_paint(&self.list.paints, p.paint, w) } else { unpack(p.color) }
    }

    /// Strokes and filled circles, covered by distance at each pixel's centre over the quad
    /// the vertex shader draws (every sample of a pixel the quad covers there).
    fn analytic(&self, target: &mut Target, layer: &Layer, clip: [i64; 4], p: &Prim) {
        let kind = p.kind & 255;
        let aa = layer.aa;
        let margin = aa * 1.5;
        let crisp = self.crisp;
        let corners: [[f32; 2]; 4] = match kind {
            K_CAPSULE | K_BOX => {
                let (p0, p1) = ([p.a[0], p.a[1]], [p.a[2], p.a[3]]);
                let hw = p.b[0].max(aa * 0.5);
                let mut d = [p1[0] - p0[0], p1[1] - p0[1]];
                let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
                d = if len > 1e-12 { [d[0] / len, d[1] / len] } else { [1.0, 0.0] };
                let n = [-d[1], d[0]];
                let e = hw + margin;
                let at = |along: f32, across: f32| [p0[0] + d[0] * along + n[0] * across, p0[1] + d[1] * along + n[1] * across];
                [at(-e, -e), at(len + e, -e), at(len + e, e), at(-e, e)]
            }
            K_ARC => {
                let (center, r, hw) = ([p.a[0], p.a[1]], p.a[2], p.a[3].max(aa * 0.5));
                let (start, sweep) = (p.b[0], p.b[1]);
                let at = |a: f32| [center[0] + r * a.cos(), center[1] + r * a.sin()];
                let (mut lo, mut hi) = (at(start), at(start));
                let mut extend = |q: [f32; 2]| {
                    lo = [lo[0].min(q[0]), lo[1].min(q[1])];
                    hi = [hi[0].max(q[0]), hi[1].max(q[1])];
                };
                extend(at(start + sweep));
                for k in 0..4 {
                    let a = k as f32 * PI * 0.5;
                    if in_sweep(a, start, sweep) {
                        extend(at(a));
                    }
                }
                let e = hw + margin;
                rect([lo[0] - e, lo[1] - e, hi[0] + e, hi[1] + e])
            }
            K_DISC => {
                let e = p.a[2] + margin;
                rect([p.a[0] - e, p.a[1] - e, p.a[0] + e, p.a[1] + e])
            }
            _ => {
                let e = p.a[2] + p.a[3].max(aa * 0.5) + margin;
                rect([p.a[0] - e, p.a[1] - e, p.a[0] + e, p.a[1] + e])
            }
        };
        let quad_px = corners.map(|c| apply32(&layer.m32, c));
        let width = target.width;
        let full = target.full();
        let inv = layer.inv;
        // Hairlines keep a one-pixel footprint and fade with their width (crisp: solid).
        let raw = match kind {
            K_ARC | K_RING => p.a[3],
            _ => p.b[0],
        };
        let (hw, fade) = if raw < aa * 0.5 {
            (aa * 0.5, if crisp { if raw > 0.0 { 1.0 } else { 0.0 } } else { raw.max(0.0) * 2.0 / aa })
        } else {
            (raw, 1.0)
        };
        let solid = (p.paint == NO_PAINT).then(|| premul(unpack(p.color)));
        let fill = (kind == K_RING && p.kind & F_RING_FILL != 0).then(|| premul(unpack(p.b[0].to_bits())));
        let length = |x: f32, y: f32| (x * x + y * y).sqrt();
        // A stroke's squared distances beyond which a pixel takes nothing, and within which all of it.
        let (reach, core) = if crisp { (hw, hw) } else { (hw + aa * 0.5, (hw - aa * 0.5).max(0.0)) };
        let (outside, inside) = (reach * reach * (1.0 + 1e-5), if core > 0.0 { core * core * (1.0 - 1e-5) } else { -1.0 });
        spans(&quad_px, clip, |y, x0, x1| {
            let cy = y as f64 + 0.5;
            // The world at each pixel's centre, a step along the row at a time.
            let (mut wx, mut wy) = (inv[0] * (x0 as f64 + 0.5) + inv[2] * cy + inv[4], inv[1] * (x0 as f64 + 0.5) + inv[3] * cy + inv[5]);
            for x in x0..x1 {
                let w = [wx as f32, wy as f32];
                wx += inv[0];
                wy += inv[1];
                if kind == K_CAPSULE {
                    // Most pixels of a stroke are wholly outside or inside it: decided by the
                    // squared distance, without the square root (the coverage rule's ends).
                    let squared = segment_distance_squared(w, [p.a[0], p.a[1]], [p.a[2], p.a[3]]);
                    if squared >= outside {
                        continue;
                    }
                    if squared <= inside && solid.is_some_and(|c| c[3] >= 1.0) && fade >= 1.0 {
                        target.blend(y as usize * width + x as usize, full, solid.unwrap_or_default(), false);
                        continue;
                    }
                }
                let cov = match kind {
                    K_DISC => coverage(length(w[0] - p.a[0], w[1] - p.a[1]) - p.a[2], aa, crisp),
                    K_RING => coverage((length(w[0] - p.a[0], w[1] - p.a[1]) - p.a[2]).abs() - hw, aa, crisp) * fade,
                    K_CAPSULE => coverage(sd_segment(w, [p.a[0], p.a[1]], [p.a[2], p.a[3]]) - hw, aa, crisp) * fade,
                    K_BOX => coverage(sd_box(w, [p.a[0], p.a[1]], [p.a[2], p.a[3]], hw), aa, crisp) * fade,
                    _ => coverage(sd_arc(w, [p.a[0], p.a[1]], p.a[2], p.b[0], p.b[1]) - hw, aa, crisp) * fade,
                };
                let mut src = if cov > 0.0 { scale(solid.unwrap_or_else(|| premul(self.base(p, w))), cov) } else { [0.0; 4] };
                if let Some(fill) = fill {
                    // A ring's interior under it (prim.wgsl: the ring over its fill).
                    let inside = coverage(length(w[0] - p.a[0], w[1] - p.a[1]) - p.a[2], aa, crisp);
                    src = [0, 1, 2, 3].map(|k| src[k] + fill[k] * inside * (1.0 - src[3]));
                }
                if src[3] <= 0.0 {
                    continue;
                }
                target.blend(y as usize * width + x as usize, full, src, false);
            }
        });
    }

    /// A whole polyline, shaded once a pixel by its nearest segment (no joint overlap).
    fn polyline(&self, target: &mut Target, layer: &Layer, clip: [i64; 4], p: &Prim) {
        let aa = layer.aa;
        let (raw, first, count) = (p.b[0], p.b[1].to_bits() as usize, p.b[2].to_bits() as usize);
        let points = self.list.points.get(first..first + count).unwrap_or(&[]);
        if points.is_empty() {
            return;
        }
        let (hw, fade) = if raw < aa * 0.5 {
            (aa * 0.5, if self.crisp { if raw > 0.0 { 1.0 } else { 0.0 } } else { raw.max(0.0) * 2.0 / aa })
        } else {
            (raw, 1.0)
        };
        let e = raw.max(aa * 0.5) + aa * 1.5;
        // The polyline's quad (its bounds grown by `e`), in pixels: where `best` is kept.
        let quad_px = rect([p.a[0] - e, p.a[1] - e, p.a[2] + e, p.a[3] + e]).map(|c| apply32(&layer.m32, c));
        let x0 = (quad_px.iter().map(|c| c[0]).fold(f32::INFINITY, f32::min).floor() as i64).max(clip[0]);
        let y0 = (quad_px.iter().map(|c| c[1]).fold(f32::INFINITY, f32::min).floor() as i64).max(clip[1]);
        let x1 = (quad_px.iter().map(|c| c[0]).fold(f32::NEG_INFINITY, f32::max).ceil() as i64).min(clip[2]);
        let y1 = (quad_px.iter().map(|c| c[1]).fold(f32::NEG_INFINITY, f32::max).ceil() as i64).min(clip[3]);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let (bw, bh) = ((x1 - x0) as usize, (y1 - y0) as usize);
        let mut best = vec![f32::INFINITY; bw * bh];
        let inv = layer.inv;
        let closed = p.kind & F_CLOSED != 0 && count > 2;
        let segments = (0..count.saturating_sub(1)).map(|k| (points[k], points[k + 1])).chain(closed.then(|| (points[count - 1], points[0])));
        let reach = hw + aa * 1.5;
        for (a, b) in segments {
            // Only pixels within reach of this segment can take it as their nearest with any coverage.
            let corners = capsule_quad(a, b, reach).map(|c| apply32(&layer.m32, c));
            spans(&corners, [x0, y0, x1, y1], |y, sx0, sx1| {
                let cy = y as f64 + 0.5;
                for x in sx0..sx1 {
                    let cx = x as f64 + 0.5;
                    let w = [(inv[0] * cx + inv[2] * cy + inv[4]) as f32, (inv[1] * cx + inv[3] * cy + inv[5]) as f32];
                    let at = (y - y0) as usize * bw + (x - x0) as usize;
                    best[at] = best[at].min(sd_segment(w, a, b));
                }
            });
        }
        let width = target.width;
        let full = target.full();
        for y in y0..y1 {
            let cy = y as f64 + 0.5;
            for x in x0..x1 {
                let d = best[(y - y0) as usize * bw + (x - x0) as usize];
                if !d.is_finite() {
                    continue;
                }
                let cov = coverage(d - hw, aa, self.crisp) * fade;
                if cov <= 0.0 {
                    continue;
                }
                let cx = x as f64 + 0.5;
                let w = [(inv[0] * cx + inv[2] * cy + inv[4]) as f32, (inv[1] * cx + inv[3] * cy + inv[5]) as f32];
                target.blend(y as usize * width + x as usize, full, scale(premul(self.base(p, w)), cov), false);
            }
        }
    }

    /// A filled triangle, covered by the GPU's samples, in its colour or paint.
    fn triangle(&self, target: &mut Target, layer: &Layer, clip: [i64; 4], p: &Prim) {
        // A lone glyph's own triangles draw only where the view gives it no mask.
        if p.kind & F_GLYPH_VECTOR != 0 && self.glyphs.get(p.b[2].to_bits() as usize).is_some_and(Option::is_some) {
            return;
        }
        let v = [[p.a[0], p.a[1]], [p.a[2], p.a[3]], [p.b[0], p.b[1]]].map(|c| apply32(&layer.m32, c));
        let Some(t) = Triangle::new(v) else { return };
        let width = target.width;
        let inv = layer.inv;
        let solid = (p.paint == NO_PAINT).then(|| premul(unpack(p.color)));
        t.each(clip, positions(self.samples), |x, y, mask| {
            let src = solid.unwrap_or_else(|| {
                let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
                premul(self.base(p, [(inv[0] * cx + inv[2] * cy + inv[4]) as f32, (inv[1] * cx + inv[3] * cy + inv[5]) as f32]))
            });
            target.blend(y as usize * width + x as usize, mask, src, false);
        });
    }

    /// A depth run (styk-draw `K_DEPTH_RESET`): the depth buffer reset to far over the run's
    /// rectangle, then each face, sample by sample, drawn over what is there when it is not
    /// behind what the run drew there before (24-bit depths, an equal depth passing), as the
    /// GPU's `less-equal` depth test does.
    fn depth_run(&self, target: &mut Target, layer: &Layer, clip: [i64; 4], reset: &Prim, faces: std::ops::Range<usize>) {
        const ONE: u32 = (1 << 24) - 1;
        let n = self.samples;
        let positions = positions(n);
        let margin = layer.aa * 1.5;
        let corners = rect([reset.a[0] - margin, reset.a[1] - margin, reset.a[2] + margin, reset.a[3] + margin]).map(|c| apply32(&layer.m32, c));
        let x0 = (corners.iter().map(|c| c[0]).fold(f32::INFINITY, f32::min).floor() as i64).max(clip[0]);
        let y0 = (corners.iter().map(|c| c[1]).fold(f32::INFINITY, f32::min).floor() as i64).max(clip[1]);
        let x1 = (corners.iter().map(|c| c[0]).fold(f32::NEG_INFINITY, f32::max).ceil() as i64).min(clip[2]);
        let y1 = (corners.iter().map(|c| c[1]).fold(f32::NEG_INFINITY, f32::max).ceil() as i64).min(clip[3]);
        if x1 <= x0 || y1 <= y0 || faces.is_empty() {
            return;
        }
        let bounds = [x0, y0, x1, y1];
        let (bw, bh) = ((x1 - x0) as usize, (y1 - y0) as usize);
        debug_assert!(bw * bh > 0);
        // Samples outside the reset's quad keep the cleared depth, 1.
        let mut depth = vec![ONE; bw * bh * n];
        let far = (DEPTH_FAR as f64 * ONE as f64).round() as u32;
        quad([corners[0], corners[1], corners[3], corners[2]], bounds, positions, |x, y, mask| {
            let at = ((y - y0) as usize * bw + (x - x0) as usize) * n;
            for k in 0..n {
                if mask >> k & 1 != 0 {
                    depth[at + k] = far;
                }
            }
        });
        let width = target.width;
        let inv = layer.inv;
        for face in &self.list.prims[faces] {
            let v = [[face.a[0], face.a[1]], [face.a[2], face.a[3]], [face.b[0], face.b[1]]].map(|c| apply32(&layer.m32, c));
            let Some(t) = Triangle::new(v) else { continue };
            // Each corner's window depth, as the vertex shader computes it.
            let z = [face.b[2], face.b[3], face.c[0]].map(|d| window_depth(d, face.c[1], face.c[2]) as f64);
            // In the triangle's own vertex order (it swaps two vertices to orient itself).
            let z = t.order.map(|k| z[k]);
            let area = t.area as f64;
            let solid = (face.paint == NO_PAINT).then(|| premul(unpack(face.color)));
            let samples = t.samples(positions);
            // A sample's depth is linear in its edge values: the pixel corner's, plus each sample's offset.
            let dz: [f64; 4] = std::array::from_fn(|k| if k < n { (0..3).map(|e| samples.offsets[e][k] as f64 * z[e]).sum::<f64>() / area } else { 0.0 });
            t.scan(bounds, &samples, |x, y, cover, v| {
                let at = ((y - y0) as usize * bw + (x - x0) as usize) * n;
                let corner = (v[0] as f64 * z[0] + v[1] as f64 * z[1] + v[2] as f64 * z[2]) / area;
                let mut mask = 0u8;
                for k in 0..n {
                    if cover >> k & 1 == 0 {
                        continue;
                    }
                    let value = ((corner + dz[k]).clamp(0.0, 1.0) * ONE as f64).round() as u32;
                    if value <= depth[at + k] {
                        depth[at + k] = value;
                        mask |= 1 << k;
                    }
                }
                if mask != 0 {
                    let src = solid.unwrap_or_else(|| {
                        let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
                        premul(self.base(face, [(inv[0] * cx + inv[2] * cy + inv[4]) as f32, (inv[1] * cx + inv[3] * cy + inv[5]) as f32]))
                    });
                    target.blend(y as usize * width + x as usize, mask, src, false);
                }
            });
        }
    }

    /// A sprite or a drawing cel tile over its world quad.
    fn image(&self, target: &mut Target, layer: &Layer, clip: [i64; 4], p: &Prim) {
        let (o, u, v) = ([p.a[0], p.a[1]], [p.a[2], p.a[3]], [p.b[0], p.b[1]]);
        let drawing = p.kind & F_DRAWING != 0;
        // Canvas sampling, as prim.wgsl: positive blends its parent, negative uses Mitchell.
        let mut sampling = 0.0f32;
        if drawing {
            // A tile of display level b.w: the view shows one level per cel (docs/engine/drawing.md).
            let level = p.b[3];
            let tile_pixels = (u[0] * u[0] + u[1] * u[1]).sqrt() / (64.0 * layer.aa);
            // Equivalent to floor(-log2(base pixels)), without GPU rounding at exact
            // powers of two selecting the preceding level (prim.wgsl).
            let shown = (level == 0.0 || tile_pixels <= 1.0) && (level == 8.0 || tile_pixels > 0.5);
            if !shown {
                return;
            }
            if layer.canvas {
                if tile_pixels > 1.0 {
                    sampling = -1.0;
                } else if p.paint != NO_PAINT {
                    sampling = (-tile_pixels.max(1e-30).log2() - 0.5).clamp(0.0, 0.5);
                }
            }
        }
        let key = crate::atlas_key(p.b[2], p.c);
        let Some(texture) = (if drawing { self.images.tile(key) } else { self.images.sprite(key) }) else { return };
        // The parent tile (styk-draw `F_DRAWING`) and the quarter of it this tile covers.
        let parent = if sampling > 0.0 {
            let row = self.list.paints.get(p.paint as usize).copied().unwrap_or([0.0; 4]);
            self.images.tile((row[0] as u32, row[1] as u32, row[2] as u32)).map(|t| (t, [(row[3] as u32 & 1) as f32 * 32.0, (row[3] as u32 >> 1) as f32 * 32.0]))
        } else {
            None
        };
        let rect = p.c;
        let crisp = self.crisp;
        let corners = [o, [o[0] + u[0], o[1] + u[1]], [o[0] + v[0], o[1] + v[1]], [o[0] + u[0] + v[0], o[1] + u[1] + v[1]]].map(|c| apply32(&layer.m32, c));
        let Some(to_uv) = quad_inverse(&corners) else { return };
        let base = unpack(p.color);
        let tint = p.kind & F_TINT != 0;
        let smooth = p.kind & F_SMOOTH != 0 && !crisp;
        let page = PAGE as f32;
        let border = styk_eval::drawing::BORDER as f32;
        // The sprite's texels sit after its one-texel gutter: atlas texel coordinates relative to the gutter's corner.
        let origin = [(rect[0] * page).round() - 1.0, (rect[1] * page).round() - 1.0];
        let width = target.width;
        quad(corners, clip, positions(self.samples), |x, y, mask| {
            let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
            let uv = [(to_uv[0] * cx + to_uv[2] * cy + to_uv[4]) as f32, (to_uv[1] * cx + to_uv[3] * cy + to_uv[5]) as f32];
            let tex = if drawing && crisp {
                texture.texel(border as i64 + (uv[0] * 64.0).floor().clamp(0.0, 63.0) as i64, border as i64 + (uv[1] * 64.0).floor().clamp(0.0, 63.0) as i64)
            } else if drawing {
                let t = [uv[0] * 64.0 + border, uv[1] * 64.0 + border];
                let own = if sampling < 0.0 { texture.mitchell(t) } else { texture.bilinear(t) };
                match &parent {
                    Some((up, q)) => {
                        let above = up.bilinear([uv[0] * 32.0 + q[0] + border, uv[1] * 32.0 + q[1] + border]);
                        [0, 1, 2, 3].map(|k| own[k] + (above[k] - own[k]) * sampling)
                    }
                    None => own,
                }
            } else {
                let raw = [rect[0] + (rect[2] - rect[0]) * uv[0], rect[1] + (rect[3] - rect[1]) * uv[1]];
                if smooth {
                    texture.bilinear([raw[0] * page - origin[0], raw[1] * page - origin[1]])
                } else {
                    let half = 0.5 / page;
                    let q = [raw[0].clamp(rect[0] + half, rect[2] - half), raw[1].clamp(rect[1] + half, rect[3] - half)];
                    texture.nearest([q[0] * page - origin[0], q[1] * page - origin[1]])
                }
            };
            let src = if tint { scale([base[0] * tex[3], base[1] * tex[3], base[2] * tex[3], tex[3]], base[3]) } else { scale(tex, base[3]) };
            target.blend(y as usize * width + x as usize, mask, src, false);
        });
    }

    /// A lone glyph from its mask, where this frame has one (else its triangles draw).
    fn glyph(&self, target: &mut Target, layer: &Layer, clip: [i64; 4], p: &Prim) {
        let Some(Some(placed)) = self.glyphs.get(p.b[0].to_bits() as usize) else { return };
        let (w, h) = (placed.layout.width as f32, placed.layout.height as f32);
        let m = placed.layout.to_world.map(|v| v as f32);
        let world = |t: [f32; 2]| [m[0] * t[0] + m[2] * t[1] + m[4], m[1] * t[0] + m[3] * t[1] + m[5]];
        let corners = [[0.0, 0.0], [w, 0.0], [0.0, h], [w, h]].map(|t| apply32(&layer.m32, world(t)));
        let Some(to_uv) = quad_inverse(&corners) else { return };
        let base = unpack(p.color);
        let width = target.width;
        let mask_texels = &placed.mask;
        quad(corners, clip, positions(self.samples), |x, y, mask| {
            let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
            let uv = [(to_uv[0] * cx + to_uv[2] * cy + to_uv[4]) as f32 * w, (to_uv[1] * cx + to_uv[3] * cy + to_uv[5]) as f32 * h];
            // Clamped to its own texels, as an exact texture's edge would be.
            let t = [uv[0].clamp(0.5, w - 0.5), uv[1].clamp(0.5, h - 0.5)];
            let alpha = mask_texels.bilinear(t) * base[3];
            if alpha <= 0.0 {
                return;
            }
            target.blend(y as usize * width + x as usize, mask, [base[0] * alpha, base[1] * alpha, base[2] * alpha, alpha], false);
        });
    }

    /// Draws child group `p.b.x` into a target of its own, filters it, then composites it
    /// into `target` with its opacity.
    fn composite(&mut self, target: &mut Target, clip: [i64; 4], p: &Prim) {
        let child = p.b[0].to_bits() as usize;
        let Some(&layer) = self.layers.get(child).filter(|l| l.drawn) else { return };
        let [cw, ch] = layer.size;
        let mut own = Target::new(cw, ch, self.samples, [0; 4]);
        let bytes = own.bytes();
        self.hold(bytes as isize);
        self.group(child, &mut own);
        let grown = own.bytes();
        self.hold(grown as isize - bytes as isize);
        let mut pixels = own.resolve();
        self.hold(-(grown as isize) + (cw * ch * 4) as isize);
        self.stats.layers += 1;
        // A filtered layer runs its effect stack (styk_render::effects::recipe).
        let stack = self.list.groups.get(child).and_then(|g| self.list.layers.get(g.layer as usize)).map_or(&[][..], styk_eval::drawlist::layer_effects);
        if let (Some(filter), false) = (layer.filter, stack.is_empty()) {
            let mut records = Vec::new();
            let run = recipe::record(&mut records, stack, recipe::Frame { scale: filter.scale, origin: filter.origin, output_size: filter.output_size }, [cw as u32, ch as u32]);
            self.stats.effect_layers += 1;
            self.stats.effect_passes += run.steps.iter().filter(|s| matches!(s, recipe::Step::Pass { .. })).count() as u32;
            // Its working slots: at most eight of the layer's size besides it.
            self.hold((cw * ch * 4 * 8) as isize);
            pixels = crate::effects::run(&run, &records, pixels, [cw, ch]);
            self.hold(-((cw * ch * 4 * 8) as isize));
        }
        let opacity = unpack(p.color)[3];
        let texture = Texture { width: cw, height: ch, data: &pixels, straight: false };
        let show = layer.show;
        let corners = [[show[0], show[1]], [show[2], show[1]], [show[0], show[3]], [show[2], show[3]]].map(|c| {
            let q = apply(layer.p, c);
            [q[0] as f32, q[1] as f32]
        });
        let width = target.width;
        let full = target.full();
        let lp = layer.p;
        let translation = lp[0] == 1.0 && lp[1] == 0.0 && lp[2] == 0.0 && lp[3] == 1.0 && lp[4].fract() == 0.0 && lp[5].fract() == 0.0;
        if translation && show == [0.0, 0.0, cw as f64, ch as f64] {
            // A layer on its parent's grid lands texel on pixel: copied.
            let (ox, oy) = (lp[4] as i64, lp[5] as i64);
            let [x0, y0, x1, y1] = [ox.max(clip[0]), oy.max(clip[1]), (ox + cw as i64).min(clip[2]), (oy + ch as i64).min(clip[3])];
            for y in y0..y1 {
                for x in x0..x1 {
                    let t = pixels[(y - oy) as usize * cw + (x - ox) as usize];
                    if t[3] == 0 && t[0] == 0 && t[1] == 0 && t[2] == 0 {
                        continue;
                    }
                    let tex = [t[0] as f32 / 255.0, t[1] as f32 / 255.0, t[2] as f32 / 255.0, t[3] as f32 / 255.0];
                    target.blend(y as usize * width + x as usize, full, scale(tex, opacity), false);
                }
            }
        } else if let Some(to_uv) = quad_inverse(&corners) {
            let crisp = self.crisp;
            let (w, h) = (cw as f32, ch as f32);
            quad(corners, clip, positions(self.samples), |x, y, mask| {
                let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
                let s = [(to_uv[0] * cx + to_uv[2] * cy + to_uv[4]) as f32, (to_uv[1] * cx + to_uv[3] * cy + to_uv[5]) as f32];
                // The child's pixels at the interpolated position, clamped to its own rectangle.
                let mut uv = [(show[0] as f32 + (show[2] - show[0]) as f32 * s[0]).clamp(0.5, w - 0.5), (show[1] as f32 + (show[3] - show[1]) as f32 * s[1]).clamp(0.5, h - 0.5)];
                if crisp {
                    uv = [uv[0].floor() + 0.5, uv[1].floor() + 0.5];
                }
                let tex = texture.bilinear(uv);
                target.blend(y as usize * width + x as usize, mask, scale(tex, opacity), false);
            });
        }
        self.hold(-((cw * ch * 4) as isize));
    }

    /// The artboard filled with a colour, paint or background picture (a group's whole layer).
    fn fill(&self, target: &mut Target, g: usize, layer: &Layer, clip: [i64; 4], p: &Prim) {
        if g == 0 && p.kind & 255 == K_FILL_VIEW {
            if let styk_render::paint::PaintContext::CanvasDirect { background_bounds } = self.paint_context {
                let paint = styk_render::paint::PaintQuad::rectangle(self.view.matrix, background_bounds);
                // Only the independently certified axis-aligned fillRect takes
                // the packed coverage path. Rotated quads retain existing coverage.
                if paint.canvas_alpha(self.view.matrix,[0,0]).is_some() {
                    for y in clip[1]..clip[3] { for x in clip[0]..clip[2] {
                        let alpha = paint.canvas_alpha(self.view.matrix,[x as usize,y as usize]).expect("axis-aligned above");
                        if alpha == 0 { continue; }
                        let (cx,cy) = (x as f64+0.5,y as f64+0.5);
                        let inv = layer.inv;
                        let w = [(inv[0]*cx+inv[2]*cy+inv[4]) as f32,(inv[1]*cx+inv[3]*cy+inv[5]) as f32];
                        target.blend_paint(y as usize*target.width+x as usize, alpha, premul(self.base(p,w)));
                    }}
                    return;
                }
            }
        }
        let r = if g == 0 { self.view.artboard.map(|v| v as f32) } else { [0.0, 0.0, target.width as f32, target.height as f32] };
        let mut corners = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]];
        if g == 0 {
            if let styk_render::paint::PaintContext::CanvasDirect { background_bounds } = self.paint_context {
                if p.kind & 255 == K_FILL_VIEW {
                    let q = styk_render::paint::PaintQuad::rectangle(self.view.matrix, background_bounds).0.map(|p|p.map(|v|v as f32));
                    corners = [q[0],q[1],q[3],q[2]];
                } else {
                    // A Canvas bitmap is painted by pixel centre, then clipped;
                    // its fitted/raster domain is tested below without applying
                    // native artboard MSAA a second time.
                    corners = [[0.0,0.0],[target.width as f32,0.0],[0.0,target.height as f32],[target.width as f32,target.height as f32]];
                }
            }
        }
        let width = target.width;
        let inv = layer.inv;
        let bg = p.kind & 255 == K_BG_IMAGE;
        let texture = if bg { self.images.sprite(crate::atlas_key(p.a[2], p.c)) } else { None };
        if bg && texture.is_none() {
            return;
        }
        let rect = p.c;
        let page = PAGE as f32;
        let origin = [(rect[0] * page).round() - 1.0, (rect[1] * page).round() - 1.0];
        let base = unpack(p.color);
        let image_bounds = if g == 0 && bg {
            if let styk_render::paint::PaintContext::CanvasDirect { background_bounds } = self.paint_context {
                Some(styk_render::paint::background_image_bounds([p.a[0] as f64,p.a[1] as f64],[(rect[2]-rect[0]) as f64*PAGE as f64,(rect[3]-rect[1]) as f64*PAGE as f64],background_bounds))
            } else { None }
        } else { None };
        // An opaque colour (the usual background) covering a whole pixel replaces what is there.
        let solid = (texture.is_none() && p.paint == NO_PAINT).then(|| premul(base)).filter(|c| c[3] >= 1.0);
        let opaque = solid.map(|c| [quantize(c[0]), quantize(c[1]), quantize(c[2]), 255]);
        let full = target.full();
        quad(corners, clip, positions(self.samples), |x, y, mask| {
            if let (Some(px), true) = (opaque, mask == full) {
                target.set_opaque(y as usize * width + x as usize, px);
                return;
            }
            let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
            let w = [(inv[0] * cx + inv[2] * cy + inv[4]) as f32, (inv[1] * cx + inv[3] * cy + inv[5]) as f32];
            if image_bounds.is_some_and(|b| w[0] < b[0] as f32 || w[1] < b[1] as f32 || w[0] >= (b[0]+b[2]) as f32 || w[1] >= (b[1]+b[3]) as f32) { return; }
            let src = match texture {
                Some(texture) => {
                    let uv = [(w[0] / p.a[0]).clamp(0.0, 1.0), (w[1] / p.a[1]).clamp(0.0, 1.0)];
                    let half = 0.5 / page;
                    let q = [(rect[0] + (rect[2] - rect[0]) * uv[0]).clamp(rect[0] + half, rect[2] - half), (rect[1] + (rect[3] - rect[1]) * uv[1]).clamp(rect[1] + half, rect[3] - half)];
                    scale(texture.nearest([q[0] * page - origin[0], q[1] * page - origin[1]]), base[3])
                }
                None => premul(self.base(p, w)),
            };
            target.blend(y as usize * width + x as usize, mask, src, false);
        });
    }
}

/// The squared distance from `p` to the segment `a`–`b` (`sd_segment` without its square root).
#[inline]
fn segment_distance_squared(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let (pa, ba) = ([p[0] - a[0], p[1] - a[1]], [b[0] - a[0], b[1] - a[1]]);
    let h = ((pa[0] * ba[0] + pa[1] * ba[1]) / (ba[0] * ba[0] + ba[1] * ba[1]).max(1e-20)).clamp(0.0, 1.0);
    let (dx, dy) = (pa[0] - ba[0] * h, pa[1] - ba[1] * h);
    dx * dx + dy * dy
}

/// The corners of an axis-aligned rectangle (x0, y0, x1, y1) as a polygon.
fn rect(r: [f32; 4]) -> [[f32; 2]; 4] {
    [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]
}

/// The quad around segment `a`–`b` grown by `e` on every side, as a polygon.
fn capsule_quad(a: [f32; 2], b: [f32; 2], e: f32) -> [[f32; 2]; 4] {
    let mut d = [b[0] - a[0], b[1] - a[1]];
    let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
    d = if len > 1e-12 { [d[0] / len, d[1] / len] } else { [1.0, 0.0] };
    let n = [-d[1], d[0]];
    let at = |along: f32, across: f32| [a[0] + d[0] * along + n[0] * across, a[1] + d[1] * along + n[1] * across];
    [at(-e, -e), at(len + e, -e), at(len + e, e), at(-e, e)]
}

/// Pixels → the quad's (s, t) ∈ [0, 1]² for a parallelogram with corners `c` in the GPU's
/// corner order ((0, 0), (1, 0), (0, 1), (1, 1)).
fn quad_inverse(c: &[[f32; 2]; 4]) -> Option<Affine> {
    let o = [c[0][0] as f64, c[0][1] as f64];
    let u = [c[1][0] as f64 - o[0], c[1][1] as f64 - o[1]];
    let v = [c[2][0] as f64 - o[0], c[2][1] as f64 - o[1]];
    let det = u[0] * v[1] - u[1] * v[0];
    if det.abs() < 1e-12 || !det.is_finite() {
        return None;
    }
    Some(invert([u[0], u[1], v[0], v[1], o[0], o[1]]))
}
