//! The draw-list format: the one representation of a frame that evaluation
//! produces (`styk_eval::drawlist` encodes a scene into it) and every renderer
//! draws (`styk-render` on the GPU, `styk-raster` on the CPU).
//!
//! A [`DrawList`] is view independent: every record is in world units, so
//! panning and zooming change only the renderer's view transform.
//!
//! * [`Prim`]: one fixed-size record (64 bytes, `#[repr(C)]`, the GPU's instance
//!   layout). `kind & 255` is one of the `K_` kinds; the higher bits are `F_`
//!   flags. `color` is RGBA8 with straight alpha; `paint` is the offset of a
//!   paint record in [`DrawList::paints`] or [`NO_PAINT`]. The meaning of `a`,
//!   `b` and `c` per kind is documented on each `K_` constant.
//! * [`Group`]: an isolation layer (a translucent figure, outline or onion skin):
//!   its prims draw into a layer that a [`K_COMPOSITE`] record of the parent
//!   group composites with the group's opacity, at its place in painter order.
//!   Group 0 is the frame. Group ids are given depth first, so a group's
//!   descendants have the ids right after it.
//! * Prims are stored by depth, deepest first ([`Pass`]); within a depth, each
//!   group's prims are one contiguous run, in painter order.
//! * Paint records (`paints`, rows of four `f32`): a head row
//!   `[kind, stop count, 0, 0]`, a geometry row, an extra row, then two rows per
//!   stop: `[offset, 0, 0, 0]` and straight RGBA. [`sample_paint`] is the
//!   reference evaluation every renderer reproduces. The same table holds the
//!   rows of generated-effect draws ([`K_PARTICLE`], [`K_BEAM`]).

/// A stroked segment with round caps: `a` = (x0, y0, x1, y1), `b.x` = half width.
pub const K_CAPSULE: u32 = 1;
/// A stroked circular arc: `a` = (cx, cy, radius, half width), `b` = (start angle, sweep).
pub const K_ARC: u32 = 2;
/// A filled circle: `a` = (cx, cy, radius).
pub const K_DISC: u32 = 3;
/// A stroked circle: `a` = (cx, cy, radius, half width); with [`F_RING_FILL`], `b.x` holds
/// the bits of an RGBA8 interior drawn under the ring.
pub const K_RING: u32 = 4;
/// A filled triangle: `a` = (x0, y0, x1, y1), `b.xy` = (x2, y2).
pub const K_TRI: u32 = 5;
/// An image over the world quad `o + s·u + t·v`: `a` = (ox, oy, ux, uy), `b` = (vx, vy,
/// atlas layer, drawing level), `c` = atlas uv rectangle (u0, v0, u1, v1).
pub const K_IMAGE: u32 = 6;
/// Composites a child group: `a` = its world bounds, `b.x` = the bits of its id, `color`'s
/// alpha = its opacity.
pub const K_COMPOSITE: u32 = 7;
/// Fills the artboard with `color` or `paint` (a background colour or gradient).
pub const K_FILL_VIEW: u32 = 8;
/// A background picture covering the canvas rectangle [0, a.x] × [0, a.y] (world),
/// edges extended: `a.z` = atlas layer, `c` = atlas uv rectangle.
pub const K_BG_IMAGE: u32 = 9;
/// A stroked segment with square caps (same fields as [`K_CAPSULE`]).
pub const K_BOX: u32 = 10;
/// A whole open or closed polyline, shaded once per pixel (no joint overlap): `b.x` = half
/// width, `b.y`/`b.z` = the bits of its first vertex and vertex count in
/// [`DrawList::points`]; [`F_CLOSED`] closes it.
pub const K_POLYLINE: u32 = 11;
/// A closed [`K_POLYLINE`].
pub const F_CLOSED: u32 = 1 << 10;
/// Starts a depth run (docs/engine/spatial.md): the depth buffer is reset to far over the
/// world rectangle `a` = (x0, y0, x1, y1), which covers every face of the run. Draws no colour.
///
/// A depth run is consecutive depth-tested faces of one figure, as the editor composites
/// them (`paintDepthSurfaces`, `rasterizeMeshGroup`): `K_DEPTH_RESET`, then the run's
/// [`K_TRI`] records with [`F_DEPTH`]. Within the run a face hides what is behind it; the
/// run as a whole sits at its place in painter order, over what was drawn before it.
pub const K_DEPTH_RESET: u32 = 12;
/// A depth-tested [`K_TRI`] of a depth run: `b.zw` and `c.x` hold its corners' depths (larger
/// is nearer), `c.y` and `c.z` the run's smallest depth and depth range; renderers map them to
/// window depths with [`window_depth`] where they rasterize (smaller is nearer; an equal depth
/// keeps the later face). The GPU computes that mapping in its vertex shader, as the editor's
/// mesh raster does, so faces that nearly share a plane resolve as they do in the editor.
pub const F_DEPTH: u32 = 1 << 13;
/// Window depth of the far plane a [`K_DEPTH_RESET`] writes: beyond every face of a run,
/// whose depths lie in [0.0005, 0.9995].
pub const DEPTH_FAR: f32 = 0.9999;

/// Window depth of a face corner at depth `z` (larger is nearer) in a run whose depths
/// span `z_min`..`z_min + range`, as the editor's depth rasters compute it in single
/// precision (`0.9995 - 0.999 * (z - zMin) / range`).
pub fn window_depth(z: f32, z_min: f32, range: f32) -> f32 {
    0.9995 - 0.999 * (z - z_min) / range
}

/// One particle of a generated effect (docs/engine/vfx.md, Generated effects), in its
/// draw's local coordinates. `paint` is the offset of the draw's three rows in
/// [`DrawList::paints`]: `[m0, m1, m2, m3]` and `[tx, ty, s, shade]`, its transform to the
/// world (`x' = m0·x + m2·y + tx`, `y' = m1·x + m3·y + ty`, a movieclip's placement for
/// effects nested in one, `s` = √|det|), then `[softness, stretch, aspect, row]`, the
/// draw's constants (`row` is a sprite's material row plus one). The particle's shape is
/// [`particle_shape`] (`P_*`); `a` = (x, y, size, rotation), `b` = (vx, vy, h, 0) (`h`: a
/// chunk's random proportion), `c` = straight RGBA in floats (the opacity times its colour
/// stop's), `color` = a sprite's atlas cell, `column | row << 8`. A lightning arc segment
/// ([`P_ARC`]) has `a` = (x0, y0, x1, y1), `b.x` = its radius. Renderers expand the record
/// as the editor's vertex shader does (`vfx-generator-gpu.mjs`): its pixel margins are the
/// target's pixel in local units.
pub const K_PARTICLE: u32 = 13;
/// A beam of a generated effect, in local coordinates as [`K_PARTICLE`]: `a` = (origin x,
/// origin y, tip x, tip y), `b` = (width, wobble, seed, tick), `c` = (opacity, style, 0, 0);
/// `paint` = the draw's three rows, then its colours at ramp positions 0 and 1 (straight
/// RGB and the stop's opacity).
pub const K_BEAM: u32 = 14;
/// Drawn with additive blending: colour and alpha are added to the target's.
pub const F_ADD: u32 = 1 << 14;
/// A lone solid glyph drawn from its coverage mask ([`GlyphMask`], docs/engine/rendering.md):
/// `b.x` = the bits of its index in [`DrawList::glyphs`], `color` = straight RGBA (the text's
/// colour and opacity). Renderers draw the mask the view calls for
/// ([`GlyphMask::layout`] at the view's raster density) as a quad sampled bilinearly. Where
/// the view allows no mask, they draw the glyph's own triangles instead: the
/// [`F_GLYPH_VECTOR`] [`K_TRI`] records that follow the record.
pub const K_GLYPH: u32 = 15;
/// A [`K_TRI`] of a [`K_GLYPH`] record's glyph, drawn only where the view allows no mask:
/// `b.z` = the bits of the record's index in [`DrawList::glyphs`].
pub const F_GLYPH_VECTOR: u32 = 1 << 15;
/// Particle shapes, bits 16–18 of a [`K_PARTICLE`]'s kind.
pub const P_DISC: u32 = 0;
pub const P_STREAK: u32 = 1;
pub const P_RING: u32 = 2;
pub const P_CHUNK: u32 = 3;
pub const P_ARC: u32 = 5;
pub const P_SPRITE: u32 = 6;
pub const P_SQUARE: u32 = 7;

/// The shape of a [`K_PARTICLE`] record.
pub const fn particle_shape(kind: u32) -> u32 {
    kind >> 16 & 7
}

/// The kind of a [`K_PARTICLE`] record of `shape`.
pub const fn particle_kind(shape: u32, additive: bool) -> u32 {
    K_PARTICLE | (shape & 7) << 16 | if additive { F_ADD } else { 0 }
}

/// The particle material atlas the renderers sample for [`P_SPRITE`] particles (the
/// editor's procedural atlas, `styk_eval::vfx::generated::atlas`): `MATERIAL_ROWS` rows of
/// `MATERIAL_COLUMNS` cells of `MATERIAL_CELL` pixels, two channels (shading × coverage,
/// coverage), `MATERIAL_LEVELS` box-reduced levels sampled trilinearly.
pub const MATERIAL_CELL: u32 = 128;
pub const MATERIAL_COLUMNS: u32 = 8;
pub const MATERIAL_ROWS: u32 = 17;
pub const MATERIAL_LEVELS: u32 = 4;

/// An image sampled bilinearly (drawings); Pivot sprites sample their nearest texel.
pub const F_SMOOTH: u32 = 1 << 8;
/// A [`K_RING`] with an interior colour.
pub const F_RING_FILL: u32 = 1 << 9;
/// An image drawn in the record's colour through its own coverage (onion tint).
pub const F_TINT: u32 = 1 << 11;
/// A drawing cel tile (`styk_eval::drawing`): straight-alpha texels with a border, filtered
/// by the shader; the record's `b[3]` is its display level. Its `paint` is not a paint
/// record: it is the row of [`DrawList::paints`] naming the tile's **parent**, the tile one
/// level up that covers it (`[atlas layer, x, y, quadrant]`: the parent slot's first texel,
/// past its border, and which quarter of it this tile reduces to, `qx + 2·qy`), or
/// [`NO_PAINT`] when there is none (the last level). Renderers drawing a cel inside a layer
/// the editor paints with Canvas 2D ([`LayerKind`]: entries, nested and raster layers) blend
/// the parent in as Canvas 2D's smoothing samples its reduced levels; elsewhere one level is
/// drawn and the row is unused.
pub const F_DRAWING: u32 = 1 << 12;

/// `Prim::paint` of a record drawn in its `color`.
pub const NO_PAINT: u32 = u32::MAX;

/// One GPU primitive (std430, 64 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Prim {
    pub kind: u32,
    pub group: u32,
    /// RGBA8, straight alpha.
    pub color: u32,
    /// Offset of a paint record in [`DrawList::paints`] (vec4 units), or `NO_PAINT`.
    pub paint: u32,
    pub a: [f32; 4],
    pub b: [f32; 4],
    pub c: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct Group {
    pub parent: u32,
    pub depth: u32,
    pub opacity: f32,
    /// World-space bounds (x0, y0, x1, y1) of everything drawn in the group.
    pub bounds: [f32; 4],
    /// Index into [`DrawList::layers`] when the group is drawn on a raster of its own
    /// (effects, or artwork holding effects), or [`NO_LAYER`].
    pub layer: u32,
}

/// [`Group::layer`] of a group without a raster of its own.
pub const NO_LAYER: u32 = u32::MAX;

/// The effects a layer runs, as the encoder resolved them (`styk_eval`'s
/// `Vec<Arc<vfx::Effect>>`). The format does not interpret them: a renderer that
/// filters downcasts them, one that does not ignores them.
pub type Effects = std::sync::Arc<dyn std::any::Any + Send + Sync>;

/// A group drawn the way the editor draws artwork with effects: on its own
/// raster, filtered, then composited (docs/engine/vfx.md, Rendering).
#[derive(Clone)]
pub struct EffectLayer {
    /// Filters run in order; `None` for a layer that only holds filtered artwork.
    pub effects: Option<Effects>,
    pub kind: LayerKind,
}

impl std::fmt::Debug for EffectLayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EffectLayer").field("filtered", &self.effects.is_some()).field("kind", &self.kind).finish()
    }
}

/// The scene camera as the camera image applies it (`Camera` in styk_eval::doc).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraPose {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub angle: f64,
    pub is_default: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LayerKind {
    /// Top-level artwork (an object, a movieclip instance or a connected run)
    /// rasterized on a world-aligned grid anchored at `bounds`, at the editor's
    /// raster density for the view (`rasterObject`), then resampled.
    Entry {
        /// `objectBounds` with every effect's padding: x, y, width, height (world units).
        bounds: [f64; 4],
        /// The effects' coordinate domain: `objectBounds` without effect padding.
        domain: [f64; 4],
        /// What effect sizes are multiplied by (the owner's absolute scale).
        scale: f64,
        /// The largest effect padding of one item, which caps the raster density.
        padding: f64,
        /// This entry is one current published drawing image, whose direct Canvas
        /// presentation filters on the destination's pixel grid. Onion rasters
        /// retain the ordinary world grid. A renderer's explicit presentation
        /// policy decides whether this eligibility is used.
        single_drawing: bool,
    },
    /// Artwork inside an entry, filtered on the entry's own pixel grid (`withVfx`).
    Nested { bounds: [f64; 4], domain: [f64; 4], scale: f64 },
    /// Top-level artwork without effects that the editor still draws from a raster of
    /// its own (`requiresCompatibilityTexture`, `rasterObject`): an object or movieclip
    /// instance holding depth-tested 3D faces (docs/engine/spatial.md) or text
    /// (docs/engine/rendering.md). Rasterized like an [`LayerKind::Entry`], on a grid
    /// anchored at `bounds` (`objectBounds`, x, y, width, height) at the editor's raster
    /// density for the view, then resampled.
    Raster { bounds: [f64; 4] },
    /// The camera image: everything but onion skins, drawn through the scene's
    /// camera at the camera preview's density, filtered, then projected onto the
    /// camera rectangle (`CameraVfx`). `canvas` is the scene's size.
    Camera { canvas: [u32; 2], camera: Option<CameraPose> },
}

/// A glyph the editor's WebGPU renderer draws from a mask of its own
/// (`glyphTextureDescriptor`): an object holding one text
/// segment with one visible character, solid, without effects, outline or movieclip.
/// The mask is the glyph's path filled on a grid in glyph space whose sides are powers
/// of two, at least 1.25 times the view's raster density plus two texels of padding;
/// it is drawn as a quad, sampled bilinearly, in the text's colour and opacity.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphMask {
    /// The glyph's bounds in glyph space (`glyph.bounds`): left, top, right, bottom.
    pub bounds: [f64; 4],
    /// Glyph space to world: a glyph point `p` lands at
    /// `origin + R(angle)·(scale.x·(p.x + offset.x), scale.y·(p.y + offset.y))`: the
    /// text's start, angle and scales (`scale.x` negative when mirrored) and the
    /// character's offset from the text's lower-left corner.
    pub origin: [f64; 2],
    pub angle: f64,
    pub scale: [f64; 2],
    pub offset: [f64; 2],
}

/// The mask of a [`GlyphMask`] for one raster density: its size in texels, where its
/// texels land (`x' = m0·u + m2·v + m4`, `y' = m1·u + m3·v + m5`, texel units) and how
/// glyph space maps onto it (`u = g0·x + g2`, `v = g1·y + g3`, the editor's
/// `setTransform(scaleX, 0, 0, scaleY, -left·scaleX, -top·scaleY)`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphMaskLayout {
    pub width: u32,
    pub height: u32,
    pub to_world: [f64; 6],
    pub from_glyph: [f64; 4],
}

impl GlyphMask {
    /// The largest mask side the editor allows (`glyphTextureDescriptor`'s default).
    pub const MAX_DIMENSION: f64 = 4096.0;
    /// The largest raster density at which the editor uses masks (`rasterResolution(scale) <= 8`).
    pub const MAX_RESOLUTION: f64 = 8.0;

    /// The mask at raster density `resolution` (`rasterResolution` of the view), or `None`
    /// where the editor draws the object's raster instead: a density above
    /// [`GlyphMask::MAX_RESOLUTION`], a mask that would exceed `max_dimension`, or a
    /// degenerate placement. The arithmetic is `glyphTextureDescriptor`'s, in its order.
    pub fn layout(&self, resolution: f64, max_dimension: f64) -> Option<GlyphMaskLayout> {
        let [left, top, right, bottom] = self.bounds;
        let [xs, ys] = self.scale;
        if resolution > Self::MAX_RESOLUTION || !(right > left && bottom > top) || ![left, top, right, bottom].iter().all(|v| v.is_finite()) {
            return None;
        }
        if ![xs, ys, self.angle, resolution, self.offset[0], self.offset[1]].iter().all(|v| v.is_finite()) || xs == 0.0 || ys == 0.0 || resolution <= 0.0 {
            return None;
        }
        let (span_x, span_y) = (right - left, bottom - top);
        let required_x = span_x * xs.abs() * resolution + 4.0;
        let required_y = span_y * ys.abs() * resolution + 4.0;
        if required_x > max_dimension || required_y > max_dimension {
            return None;
        }
        let dimension = |required: f64| max_dimension.min(2f64.powf((8f64.max((required - 4.0) * 1.25 + 4.0)).log2().ceil()));
        let (width, height) = (dimension(required_x), dimension(required_y));
        let (scale_x, scale_y) = ((width - 4.0) / span_x, (height - 4.0) / span_y);
        let (mask_left, mask_top) = (left - 2.0 / scale_x, top - 2.0 / scale_y);
        let (sin, cos) = self.angle.sin_cos();
        let px = (self.offset[0] + mask_left) * xs;
        let py = (self.offset[1] + mask_top) * ys;
        let x = self.origin[0] + px * cos - py * sin;
        let y = self.origin[1] + px * sin + py * cos;
        // `axes` over the whole mask, per texel.
        let axes = [width / scale_x * xs * cos, width / scale_x * xs * sin, -height / scale_y * ys * sin, height / scale_y * ys * cos];
        Some(GlyphMaskLayout {
            width: width as u32,
            height: height as u32,
            to_world: [axes[0] / width, axes[1] / width, axes[2] / height, axes[3] / height, x, y],
            from_glyph: [scale_x, scale_y, -mask_left * scale_x, -mask_top * scale_y],
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Pass {
    pub depth: u32,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Default)]
pub struct DrawList {
    /// ExportSVG's whole-frame Canvas fallback: No smoothing still composites
    /// effects, generated artwork and 3D smoothly. Host metadata, not a prim flag.
    pub composited_export: bool,
    pub prims: Vec<Prim>,
    pub paints: Vec<[f32; 4]>,
    /// Polyline vertices referenced by `K_POLYLINE` records.
    pub points: Vec<[f32; 2]>,
    pub groups: Vec<Group>,
    /// Prim ranges per depth, deepest first; the last pass (depth 0) is the frame.
    pub passes: Vec<Pass>,
    /// Number of leading root prims that are background fills (drawn unclipped by figures).
    pub background_prims: u32,
    /// Raster layers of the groups that have one ([`Group::layer`]).
    pub layers: Vec<EffectLayer>,
    /// The particle material rows [`P_SPRITE`] particles sample, one bit per row.
    pub materials: u32,
    /// The glyphs [`K_GLYPH`] records draw, by index.
    pub glyphs: Vec<GlyphInstance>,
}

/// One [`K_GLYPH`] record's glyph: where its mask is laid out and what fills it.
#[derive(Clone, Debug)]
pub struct GlyphInstance {
    pub mask: GlyphMask,
    /// The glyph's triangles in glyph space (even-odd resolved, no overlaps), shared by
    /// every instance of one glyph drawn at one tessellation level: renderers key the masks
    /// they keep by this allocation.
    pub triangles: std::sync::Arc<[[f32; 2]]>,
}

impl DrawList {
    pub fn bytes(&self) -> usize {
        self.prims.len() * std::mem::size_of::<Prim>()
            + self.paints.len() * 16
            + self.points.len() * 8
            + self.groups.len() * std::mem::size_of::<Group>()
            + self.layers.len() * (std::mem::size_of::<EffectLayer>() + 64)
            + self.glyphs.len() * std::mem::size_of::<GlyphInstance>()
    }
}

pub fn rgba8(rgb: [u8; 3], alpha: f64) -> u32 {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    rgb[0] as u32 | (rgb[1] as u32) << 8 | (rgb[2] as u32) << 16 | a << 24
}

/// RGBA8 (straight) from a Pivot ARGB integer.
pub fn argb8(raw: u32) -> u32 {
    let (a, r, g, b) = (raw >> 24, raw >> 16 & 255, raw >> 8 & 255, raw & 255);
    r | g << 8 | b << 16 | a << 24
}

/// Paint record kinds (the first value of a record's head row).
pub const P_LINEAR: f32 = 0.0;
pub const P_RADIAL: f32 = 1.0;
pub const P_ANGULAR: f32 = 2.0;
pub const P_DIAMOND: f32 = 3.0;
pub const P_RADIAL_RING: f32 = 4.0;


/// Shared handle for a draw list produced on a worker thread.
pub type SharedDrawList = std::sync::Arc<DrawList>;

/// The straight RGBA of paint record `offset` at world point `w`: the reference
/// evaluation (`paint_at` in styk-render's prim.wgsl does the same in `f32`).
pub fn sample_paint(paints: &[[f32; 4]], offset: u32, w: [f32; 2]) -> [f32; 4] {
    let row = |i: u32| paints.get(i as usize).copied().unwrap_or([0.0; 4]);
    let head = row(offset);
    let g = row(offset + 1);
    let (kind, count) = (head[0], head[1] as u32);
    let t = if kind == P_LINEAR {
        let d = [g[2] - g[0], g[3] - g[1]];
        ((w[0] - g[0]) * d[0] + (w[1] - g[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]).max(1e-12)
    } else if kind == P_RADIAL {
        (w[0] - g[0]).hypot(w[1] - g[1]) / g[2].max(1e-12)
    } else if kind == P_ANGULAR {
        let turns = ((w[1] - g[1]).atan2(w[0] - g[0]) - g[2]) / (2.0 * std::f32::consts::PI);
        turns - turns.floor()
    } else if kind == P_DIAMOND {
        let (u, v) = ((w[0] - g[0]) / g[3].max(1e-12), (w[1] - g[1]) / g[3].max(1e-12));
        let (cs, sn) = (g[2].cos(), g[2].sin());
        (u * cs + v * sn).abs() + (-u * sn + v * cs).abs()
    } else {
        ((w[0] - g[0]).hypot(w[1] - g[1]) - g[2]) / (g[3] - g[2]).max(1e-12)
    }
    .clamp(0.0, 1.0);
    let base = offset + 3;
    let (mut prev_offset, mut prev) = (row(base)[0], row(base + 1));
    if t <= prev_offset {
        return prev;
    }
    for i in 1..count {
        let (o, col) = (row(base + i * 2)[0], row(base + i * 2 + 1));
        if t < o {
            let f = (t - prev_offset) / (o - prev_offset).max(1e-12);
            return [0, 1, 2, 3].map(|k| prev[k] + (col[k] - prev[k]) * f);
        }
        prev_offset = o;
        prev = col;
    }
    prev
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_linear_paint_interpolates_between_its_stops() {
        let paints = vec![[P_LINEAR, 2.0, 0.0, 0.0], [0.0, 0.0, 10.0, 0.0], [0.0; 4], [0.0; 4], [1.0, 0.0, 0.0, 1.0], [1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 1.0]];
        assert_eq!(sample_paint(&paints, 0, [-5.0, 0.0]), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(sample_paint(&paints, 0, [5.0, 3.0]), [0.5, 0.0, 0.5, 1.0]);
        assert_eq!(sample_paint(&paints, 0, [20.0, 0.0]), [0.0, 0.0, 1.0, 1.0]);
    }

    /// `glyphTextureDescriptor` on the same three items: plain,
    /// mirrored at a large scale, and reversed and mirrored by the object's flag at a
    /// quarter-octave density. Expected numbers printed by the editor's own function.
    #[test]
    fn glyph_masks_are_laid_out_as_the_editor_lays_them_out() {
        use std::f64::consts::PI;
        let bounds = [0.5859375, 10.68359375, 31.162109375, 26.23046875];
        let (left, bottom, width) = (-3.25, 2.5, 40.75);
        let offset = [1.25 - left, -0.75 - bottom];
        let mask = |start: [f64; 2], end: [f64; 2], angle: f64, ys: f64, reverse: bool, mirror: bool| GlyphMask {
            bounds,
            origin: if reverse { end } else { start },
            angle: angle + if reverse { PI } else { 0.0 } - if mirror { PI } else { 0.0 },
            scale: [(end[0] - start[0]).hypot(end[1] - start[1]) / width * if mirror { -1.0 } else { 1.0 }, ys],
            offset,
        };
        let cases = [
            (mask([100.0, 50.0], [180.0, 70.0], 20f64.atan2(80.0), 1.5, false, false), 0.5, (64, 32, [105.68340140318618, 61.197407935312526], [64.02862985685071, 16.00715746421268, -6.464007506548696, 25.856030026194784])),
            (
                mask([1095.0865478515625, -342.3170166015625], [-1200.0, 300.0], 2.91361312482548, 60.0, false, true),
                0.5,
                (2048, 1024, [907.4258268119008, 157.2079183415732], [-1745.3927877345693, 404.9540393340701, 211.6515252892565, 912.2394392222302]),
            ),
            (
                mask([-20.0, 10.0], [30.0, -40.0], -0.785, -2.0, true, true),
                2.378414230005442,
                (256, 128, [13.900951276616404, -44.221814954907316], [-38.1274515700087, 38.097101741289485, -22.686808232252876, -22.704881542624634]),
            ),
        ];
        for (glyph, resolution, (w, h, at, axes)) in cases {
            let layout = glyph.layout(resolution, GlyphMask::MAX_DIMENSION).expect("a mask");
            assert_eq!((layout.width, layout.height), (w, h));
            let m = layout.to_world;
            let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * b.abs().max(1.0);
            assert!(close(m[4], at[0]) && close(m[5], at[1]), "{m:?} against {at:?}");
            let whole = [m[0] * w as f64, m[1] * w as f64, m[2] * h as f64, m[3] * h as f64];
            assert!(whole.iter().zip(axes).all(|(&a, b)| close(a, b)), "{whole:?} against {axes:?}");
        }
        // Beyond the editor's density or its largest mask, the object's raster is drawn instead.
        let (glyph, ..) = cases[0];
        assert!(glyph.layout(8.0, GlyphMask::MAX_DIMENSION).is_some());
        assert!(glyph.layout(9.51, GlyphMask::MAX_DIMENSION).is_none());
        assert!(cases[1].0.layout(4.0, GlyphMask::MAX_DIMENSION).is_none(), "a mask wider than 4096 texels");
    }

    #[test]
    fn colours_pack_as_straight_rgba8() {
        assert_eq!(rgba8([1, 2, 3], 1.0), 0xff03_0201);
        assert_eq!(argb8(0x80_102030), 0x80_302010);
    }
}
