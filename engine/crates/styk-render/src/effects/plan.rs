//! Where each isolation group is drawn for one view, and at what density.
//!
//! Draw lists are view independent; this runs every frame. A group is drawn in
//! a *space*, an affine map from world units to the pixels of its layer:
//!
//! * the frame and plain isolation groups use their parent's space (the
//!   screen's, at the top);
//! * an **entry** (top-level artwork holding effects) is rasterized on a
//!   world-aligned grid anchored at its `objectBounds`, at the density the
//!   editor's `rasterObject` chooses for the view, then resampled;
//! * a **nested** filtered group uses its entry's grid, on a rectangle grown by
//!   its effects' padding (`withVfx`);
//! * the **camera image** is drawn through the scene camera at the camera
//!   preview's density (`CameraVfx`) and projected onto the camera rectangle.
//!
//! Every layer is cropped to what can reach the screen: the part of its parent
//! that is drawn, widened by its effects' sampling reach. Cropping keeps the
//! pixel grid and the effects' global coordinates, so the pixels that reach the
//! screen are those of the uncropped layer.

use std::sync::Arc;

use styk_draw::{CameraPose, DrawList, LayerKind};
use styk_eval::doc::Camera;
use styk_eval::drawlist::layer_effects;
use styk_eval::vfx::Effect;
use styk_eval::view::{apply, camera_transform, compose, invert};

pub type Affine = [f64; 6];

/// The upright view: nothing moves.
pub const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// The pixel grid used by eligible filtered drawing entries. Ordinary GPU
/// presentation and prepared playback retain the world raster grid. Direct
/// Canvas presentation paints one current drawing on its destination grid.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DrawingGrid {
    #[default]
    World,
    Destination,
}

/// The view a frame is drawn for.
#[derive(Clone, Copy, Debug)]
pub struct View {
    /// World → screen pixels.
    pub matrix: Affine,
    pub size: [u32; 2],
    /// Workspace zoom and pan in screen pixels, before any scene camera.
    pub zoom: f64,
    pub pan: [f64; 2],
    /// The workspace view's rotation and mirroring on screen ([`crate::Renderer::set_orientation`]):
    /// the identity for an upright view. `matrix` already includes it.
    pub orient: Affine,
    /// Vertical over horizontal pixels per scene unit of the camera view (`ViewParams::stretch`).
    pub stretch: f64,
    /// The view shows the scene through its camera (playback), not the neutral workspace.
    pub camera_view: bool,
    /// The camera image's longest side at most (`ViewParams::camera_limit`).
    pub camera_limit: f64,
    /// The device's largest texture side.
    pub max_texture: u32,
}

/// How a filtered layer's effects read coordinates (`run`'s options), for the layer as cropped.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Filter {
    pub scale: f64,
    pub origin: [f64; 2],
    pub output_size: [f64; 2],
}

/// How the camera image reaches the screen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraComposite {
    /// Layer pixels → screen pixels.
    pub to_screen: Affine,
    /// The part of the layer shown (without the effects' margin): x0, y0, x1, y1.
    pub show: [f64; 4],
}

/// One group's placement, before atlas packing.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    /// World → this group's layer pixels.
    pub space: Affine,
    /// The layer: x0, y0, x1, y1 in its space, whole pixels; empty when not drawn.
    pub rect: [f64; 4],
    pub filter: Option<Filter>,
    pub camera: Option<CameraComposite>,
    /// The editor paints this layer with Canvas 2D (`rasterObject`: entries, nested and raster
    /// layers, and plain groups inside them): drawing cels in it are smoothed as Canvas 2D
    /// smooths them (styk-draw `F_DRAWING`). The frame, plain groups on it and the camera
    /// image draw cels as the editor's GPU drawing display does.
    pub canvas: bool,
}

impl Placement {
    pub fn drawn(&self) -> bool {
        self.rect[2] > self.rect[0] && self.rect[3] > self.rect[1]
    }
    pub fn size(&self) -> [u32; 2] {
        if self.drawn() { [(self.rect[2] - self.rect[0]) as u32, (self.rect[3] - self.rect[1]) as u32] } else { [0, 0] }
    }
}

const NOTHING: [f64; 4] = [0.0; 4];
/// Bytes of raster the editor allows one figure (`previewMemoryPlan().editorRasters` on a desktop).
const RASTER_BUDGET: f64 = 128.0 * 1024.0 * 1024.0;

/// `rasterResolution`: the physical scale rounded up to a quarter octave, at least 0.5.
pub fn raster_resolution(scale: f64) -> f64 {
    let scale = if scale == 0.0 || !scale.is_finite() { 1.0 } else { scale };
    2f64.powf(((scale.log2() * 4.0) - 1e-9).ceil() / 4.0).max(0.5)
}

/// `rasterBounds` (src/raster-view.mjs): a crop of `bounds` around `visible` on
/// the complete raster's pixel grid. `[x, y, width, height]` in world units, or
/// `None` when nothing is visible.
pub fn raster_bounds(bounds: [f64; 4], visible: Option<[f64; 4]>, resolution: f64, max_dimension: f64, margin: f64, padding: f64) -> Option<[f64; 4]> {
    let coverage = margin.min((max_dimension / 8.0).floor());
    let step = if coverage != 0.0 { 1f64.max(128f64.min(2f64.powf((max_dimension / 8.0).log2().floor()))) } else { 1.0 };
    let mut pixel_scale = resolution;
    if visible.is_none() || resolution <= 8.0 && bounds[2] * resolution <= max_dimension && bounds[3] * resolution <= max_dimension {
        pixel_scale = resolution.min(max_dimension / bounds[2]).min(max_dimension / bounds[3]);
    }
    let region = |density: f64| {
        let full = [(bounds[2] * density).ceil().max(1.0), (bounds[3] * density).ceil().max(1.0)];
        let guard = 2.0 + coverage + padding * density;
        match visible {
            Some(v) => [
                0f64.max((((v[0] - bounds[0]) * density - guard) / step).floor() * step),
                0f64.max((((v[1] - bounds[1]) * density - guard) / step).floor() * step),
                full[0].min((((v[0] + v[2] - bounds[0]) * density + guard) / step).ceil() * step),
                full[1].min((((v[1] + v[3] - bounds[1]) * density + guard) / step).ceil() * step),
            ],
            None => [0.0, 0.0, full[0], full[1]],
        }
    };
    let mut rect = region(pixel_scale);
    if rect[2] <= rect[0] || rect[3] <= rect[1] {
        return None;
    }
    if rect[2] - rect[0] > max_dimension || rect[3] - rect[1] > max_dimension {
        let reserve = 2.0 * (coverage + 2.0 + step);
        let extent = visible.map_or([bounds[2], bounds[3]], |v| [v[2], v[3]]);
        pixel_scale = pixel_scale.min((max_dimension - reserve).max(1.0) / (extent[0] + 2.0 * padding).max(extent[1] + 2.0 * padding));
        rect = region(pixel_scale);
    }
    Some([bounds[0] + rect[0] / pixel_scale, bounds[1] + rect[1] / pixel_scale, (rect[2] - rect[0]) / pixel_scale, (rect[3] - rect[1]) / pixel_scale])
}

/// The grid an entry is rasterized on (`rasterObject` with `vfxRasterScale`):
/// its world origin, its density and its complete size in pixels. `bounds` is
/// `objectBounds` with effect padding, `padding` the largest item padding,
/// `physical` the view's pixels per world unit, `visible` the world rectangle
/// on screen. `filtered`: the artwork holds effects, whose surfaces cap the density
/// (`vfxRasterScale`). `None` when it is entirely off screen at a cropping density.
pub fn entry_raster(bounds: [f64; 4], padding: f64, physical: f64, visible: [f64; 4], max_texture: u32, filtered: bool) -> Option<([f64; 2], f64, [u32; 2])> {
    let max = 8192f64.min(max_texture as f64);
    let desired = raster_resolution(physical);
    let mut resolution = desired;
    let mut rect = bounds;
    let detail = desired > 8.0 || bounds[2] * desired > max || bounds[3] * desired > max;
    if detail {
        let mut plan = raster_bounds(bounds, Some(visible), resolution, max, 128.0, padding)?;
        let pixels = |p: [f64; 4], density: f64| (p[2] * density).round() * (p[3] * density).round() * 4.0;
        if pixels(plan, resolution) > RASTER_BUDGET {
            resolution *= (RASTER_BUDGET / pixels(plan, resolution)).sqrt();
            plan = raster_bounds(bounds, Some(visible), resolution, max, 0.0, padding)?;
        }
        rect = plan;
    } else {
        resolution = resolution.min((RASTER_BUDGET / 4.0 / (bounds[2] * bounds[3]).max(1.0)).sqrt());
    }
    let mut density = resolution.min(max / rect[2]).min(max / rect[3]);
    // `vfxRasterScale`: nested halos within the effect surface limit.
    if filtered {
        let edge = 4096f64.min(max) - 128.0;
        density = density.min(edge / (rect[2] + 2.0 * padding)).min(edge / (rect[3] + 2.0 * padding));
    }
    let size = [(rect[2] * density).ceil().max(1.0) as u32, (rect[3] * density).ceil().max(1.0) as u32];
    Some(([rect[0], rect[1]], density, size))
}

/// The camera image (`CameraVfx.#prepare` and `renderTexture` with `CameraGpuSource`).
pub struct CameraPlan {
    pub space: Affine,
    pub size: [u32; 2],
    pub filter: Filter,
    pub composite: CameraComposite,
}

pub fn camera_plan(stack: &[Arc<Effect>], canvas: [u32; 2], camera: Option<CameraPose>, view: &View) -> CameraPlan {
    let camera = camera.map(|c| Camera { x: c.x, y: c.y, scale: c.scale, angle: c.angle, is_default: c.is_default, motion_offset: None });
    let (cw, ch) = (canvas[0] as f64, canvas[1] as f64);
    let longest = cw.max(ch);
    let padding = styk_eval::vfx::padding(stack, 1.0, longest);
    let edge = 4096f64.min(view.max_texture as f64) - 128.0;
    let c = camera.unwrap_or_default();
    // A stretched export keeps both axes at least at the output's density.
    let requested = (view.zoom * if view.camera_view { view.stretch.max(1.0) } else { c.scale }).max(0.01);
    let resolution = requested.min(view.camera_limit / longest).min(edge / (cw + 2.0 * padding)).min(edge / (ch + 2.0 * padding));
    let (width, height) = ((cw * resolution).ceil().max(1.0), (ch * resolution).ceil().max(1.0));
    let scale = width / cw;
    let reach = styk_eval::vfx::padding(stack, scale, width.max(height));
    let pad = if reach != 0.0 { reach + 2.0 } else { 0.0 };
    let space = camera_transform(camera.as_ref(), canvas, scale, [pad, pad]);
    let screen: Affine = compose(view.orient, if view.camera_view {
        [view.zoom, 0.0, 0.0, view.zoom * view.stretch, view.pan[0], view.pan[1]]
    } else {
        // `cameraSceneAffine`: the artboard placed where the camera looks, in the workspace.
        let (sin, cos) = c.angle.sin_cos();
        let (a, b) = (cos * c.scale, sin * c.scale);
        let (cx, cy) = (cw / 2.0, ch / 2.0);
        let (x, y) = (cx + c.x - a * cx + b * cy, cy + c.y - b * cx - a * cy);
        let z = view.zoom;
        [a * z, b * z, -b * z, a * z, view.pan[0] + x * z, view.pan[1] + y * z]
    });
    // The shown part of the image maps onto the artboard, a little stretched where
    // the image's whole-pixel size rounds the two axes differently, as the editor's quad does.
    let to_report: Affine = [cw / width, 0.0, 0.0, ch / height, -pad * cw / width, -pad * ch / height];
    CameraPlan {
        space,
        size: [(width + 2.0 * pad) as u32, (height + 2.0 * pad) as u32],
        filter: Filter { scale, origin: [-pad, -pad], output_size: [width, height] },
        composite: CameraComposite { to_screen: compose(screen, to_report), show: [pad, pad, pad + width, pad + height] },
    }
}

fn corners(r: [f64; 4]) -> [[f64; 2]; 4] {
    [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]]
}

/// The box around `rect` (x0, y0, x1, y1) mapped by `m`.
fn mapped(m: Affine, rect: [f64; 4]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in corners(rect) {
        let q = apply(m, p);
        b = [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])];
    }
    b
}

fn intersect(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let r = [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])];
    if r[2] > r[0] && r[3] > r[1] { r } else { NOTHING }
}

fn grow(r: [f64; 4], by: f64) -> [f64; 4] {
    [r[0] - by, r[1] - by, r[2] + by, r[3] + by]
}

/// Whole pixels covering `r`.
fn outward(r: [f64; 4]) -> [f64; 4] {
    [r[0].floor(), r[1].floor(), r[2].ceil(), r[3].ceil()]
}

/// A layer no larger than the device allows, keeping its first pixel.
fn capped(r: [f64; 4], max: f64) -> [f64; 4] {
    [r[0], r[1], r[2].min(r[0] + max), r[3].min(r[1] + max)]
}

/// Pixels per world unit of an axis-aligned space.
fn density(m: Affine) -> f64 {
    m[0].hypot(m[1])
}

/// Places every group of `list` for `view`. Index 0 is the frame itself.
pub fn plan(list: &DrawList, view: &View) -> Vec<Placement> {
    plan_with_grid(list, view, DrawingGrid::World)
}

/// Uses the same layer owner with an explicit portable drawing presentation
/// policy. The default [`plan`] preserves ordinary GPU and tool output.
pub fn plan_with_grid(list: &DrawList, view: &View, drawing_grid: DrawingGrid) -> Vec<Placement> {
    let screen = [0.0, 0.0, view.size[0] as f64, view.size[1] as f64];
    let max = view.max_texture as f64;
    let physical = view.matrix[0].hypot(view.matrix[1]);
    let to_world = invert(view.matrix);
    let visible = mapped(to_world, screen);
    let visible = [visible[0], visible[1], visible[2] - visible[0], visible[3] - visible[1]];
    let mut out: Vec<Placement> = Vec::with_capacity(list.groups.len());
    out.push(Placement { space: view.matrix, rect: screen, filter: None, camera: None, canvas: false });
    for g in 1..list.groups.len() {
        let group = list.groups[g];
        let parent = out[group.parent as usize];
        let none = Placement { space: parent.space, rect: NOTHING, filter: None, camera: None, canvas: false };
        if !parent.drawn() {
            out.push(none);
            continue;
        }
        let layer = list.layers.get(group.layer as usize);
        let stack = layer.map_or(&[][..], layer_effects);
        let placement = match layer.map(|l| l.kind) {
            None => {
                let b = group.bounds;
                if !(b[0] <= b[2] && b[1] <= b[3]) {
                    none
                } else {
                    let rect = mapped(parent.space, [b[0] as f64, b[1] as f64, b[2] as f64, b[3] as f64]);
                    let rect = intersect([rect[0].floor() - 2.0, rect[1].floor() - 2.0, rect[2].ceil() + 2.0, rect[3].ceil() + 2.0], parent.rect);
                    Placement { space: parent.space, rect: capped(rect, max), filter: None, camera: None, canvas: parent.canvas }
                }
            }
            Some(LayerKind::Raster { bounds }) => {
                // An entry without effects: the editor's grid for the view, resampled.
                let region = mapped(invert(parent.space), parent.rect);
                match entry_raster(bounds, 0.0, physical, visible, view.max_texture, false) {
                    None => none,
                    Some((origin, ps, size)) => {
                        let space = [ps, 0.0, 0.0, ps, -origin[0] * ps, -origin[1] * ps];
                        let wanted = outward(grow(mapped(space, region), 2.0));
                        Placement { space, rect: capped(intersect([0.0, 0.0, size[0] as f64, size[1] as f64], wanted), max), filter: None, camera: None, canvas: true }
                    }
                }
            }
            Some(LayerKind::Entry { bounds, domain, scale, single_drawing: true, .. }) if drawing_grid == DrawingGrid::Destination => {
                destination_layer(parent, stack, bounds, domain, scale, max)
            }
            Some(LayerKind::Entry { bounds, domain, scale, padding, .. }) => {
                // What of the parent is drawn, in world units. The grid itself is the
                // editor's for the view (the camera image reuses the view's rasters).
                let region = mapped(invert(parent.space), parent.rect);
                match entry_raster(bounds, padding, physical, visible, view.max_texture, true) {
                    None => none,
                    Some((origin, ps, size)) => {
                        let space = [ps, 0.0, 0.0, ps, -origin[0] * ps, -origin[1] * ps];
                        let margin = if stack.is_empty() { 2.0 } else { styk_eval::vfx::sampling_padding(stack, ps * scale, 0.0) + 2.0 };
                        let wanted = outward(grow(mapped(space, region), margin));
                        let rect = capped(intersect([0.0, 0.0, size[0] as f64, size[1] as f64], wanted), max);
                        let filter = (!stack.is_empty()).then(|| Filter {
                            scale: ps * scale,
                            origin: [(origin[0] - domain[0]) * ps + rect[0], (origin[1] - domain[1]) * ps + rect[1]],
                            output_size: [domain[2] * ps, domain[3] * ps],
                        });
                        Placement { space, rect, filter, camera: None, canvas: true }
                    }
                }
            }
            Some(LayerKind::Nested { bounds, domain, scale }) => {
                destination_layer(parent, stack, bounds, domain, scale, max)
            }
            Some(LayerKind::Camera { canvas, camera }) => {
                let c = camera_plan(stack, canvas, camera, view);
                Placement { space: c.space, rect: capped([0.0, 0.0, c.size[0] as f64, c.size[1] as f64], max), filter: Some(c.filter), camera: Some(c.composite), canvas: false }
            }
        };
        out.push(placement);
    }
    out
}

/// `withVfx` on the destination's current affine grid. Nested artwork and
/// explicitly eligible direct drawing entries share this exact owner.
fn destination_layer(parent: Placement, stack: &[Arc<Effect>], bounds: [f64; 4], domain: [f64; 4], scale: f64, max: f64) -> Placement {
    let space = parent.space;
    let ps = density(space);
    let pad = styk_eval::vfx::padding(stack, ps * scale, 0.0) + 2.0;
    let b = mapped(space, [bounds[0], bounds[1], bounds[0] + bounds[2], bounds[1] + bounds[3]]);
    let full = [b[0].floor() - pad, b[1].floor() - pad, b[2].ceil() + pad, b[3].ceil() + pad];
    let margin = styk_eval::vfx::sampling_padding(stack, ps * scale, 0.0) + 2.0;
    let rect = capped(intersect(full, outward(grow(parent.rect, margin))), max);
    let anchor = apply(space, [domain[0], domain[1]]);
    let filter = (!stack.is_empty()).then(|| Filter {
        scale: ps * scale,
        origin: [rect[0] - anchor[0], rect[1] - anchor[1]],
        output_size: [domain[2] * ps, domain[3] * ps],
    });
    Placement { space, rect, filter, camera: None, canvas: true }
}

/// `a ∘ b⁻¹`, for composites: a child's layer pixels into its parent's.
pub fn relative(parent: Affine, child: Affine) -> Affine {
    compose(parent, invert(child))
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_draw::{EffectLayer, Effects, Group, NO_LAYER};
    use styk_eval::vfx::registry::{Blur, Params};

    #[test]
    fn quarter_octaves() {
        assert_eq!(raster_resolution(1.0), 1.0);
        assert!((raster_resolution(1.25) - 2f64.sqrt()).abs() < 1e-12, "1.25 rounds up to 2^(2/4)");
        assert!((raster_resolution(2f64.powf(0.25)) - 2f64.powf(0.25)).abs() < 1e-9, "a bucket stays itself");
        assert_eq!(raster_resolution(0.1), 0.5);
        assert_eq!(raster_resolution(0.0), 1.0);
    }

    #[test]
    fn an_entry_takes_the_editors_density_and_grid() {
        // A 300×200 figure at a 1.25 view: rasterized at 2^0.5 on its own bounds.
        let (origin, ps, size) = entry_raster([100.0, 50.0, 300.0, 200.0], 20.0, 1.25, [0.0, 0.0, 2000.0, 2000.0], 8192, true).unwrap();
        assert_eq!(origin, [100.0, 50.0]);
        assert!((ps - 2f64.sqrt()).abs() < 1e-12);
        assert_eq!(size, [425, 283]);
        // Large halos lower the density so the layer stays within the effect surface.
        let (_, ps, size) = entry_raster([0.0, 0.0, 3000.0, 100.0], 400.0, 2.0, [0.0, 0.0, 3000.0, 100.0], 8192, true).unwrap();
        assert!((ps - 3968.0 / 3800.0).abs() < 1e-12);
        assert_eq!(size[0], (3000.0 * ps).ceil() as u32);
    }

    #[test]
    fn close_ups_crop_on_the_complete_grid() {
        // At 16x only the visible part is rasterized, on a grid of whole 128-pixel steps.
        let visible = [150.0, 120.0, 40.0, 30.0];
        let (origin, ps, size) = entry_raster([100.0, 100.0, 200.0, 200.0], 4.0, 16.0, visible, 8192, true).unwrap();
        assert_eq!(ps, 16.0);
        let steps = |v: f64| ((v - 100.0) * ps).rem_euclid(128.0);
        assert!(steps(origin[0]) == 0.0 && steps(origin[1]) == 0.0, "{origin:?}");
        assert_eq!(origin, [132.0, 100.0]);
        assert!(origin[0] <= visible[0] && origin[0] + size[0] as f64 / ps >= visible[0] + visible[2]);
    }

    fn list(groups: Vec<Group>, layers: Vec<EffectLayer>) -> DrawList {
        DrawList { groups, layers, ..Default::default() }
    }

    fn stack(effects: Vec<Arc<Effect>>) -> Option<Effects> {
        Some(Arc::new(effects))
    }

    fn blur(radius: f64) -> Arc<Effect> {
        Arc::new(Effect { id: Arc::from("b"), enabled: true, params: Params::Blur(Blur { radius, ..Default::default() }) })
    }

    fn view() -> View {
        View { matrix: [1.25, 0.0, 0.0, 1.25, 10.0, 20.0], size: [1000, 800], zoom: 1.25, pan: [10.0, 20.0], orient: IDENTITY, stretch: 1.0, camera_view: false, camera_limit: 2048.0, max_texture: 8192 }
    }

    #[test]
    fn drawing_destination_grid_is_explicit_and_keeps_unmarked_entries_unchanged() {
        let root = Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0,0.0,800.0,600.0], layer: u32::MAX };
        let entry = |layer| Group { parent: 0, depth: 1, opacity: 1.0, bounds: [40.0,40.0,470.0,330.0], layer };
        let layer = |single_drawing| EffectLayer { effects: stack(vec![blur(4.0)]), kind: LayerKind::Entry { bounds:[36.0,36.0,439.0,295.0],domain:[37.0,37.0,437.0,293.0],scale:0.56,padding:1.0,single_drawing } };
        let list = list(vec![root,entry(0),entry(1)],vec![layer(true),layer(false)]);
        let view = View {matrix:[0.8703703703703703,0.0,0.0,0.8703703703703703,152.0,16.0],size:[1096,502], ..view()};
        let default = plan(&list,&view);
        let world = plan_with_grid(&list,&view,DrawingGrid::World);
        assert_eq!(default[1].space,world[1].space);
        assert_eq!(default[1].rect,world[1].rect);
        assert_eq!(default[1].filter,world[1].filter);
        assert_eq!(world[1].space,[1.0,0.0,0.0,1.0,-36.0,-36.0]);
        let destination = plan_with_grid(&list,&view,DrawingGrid::Destination);
        assert_eq!(destination[1].space,view.matrix);
        assert_eq!(destination[1].filter.unwrap().scale,view.matrix[0]*0.56);
        assert_eq!(destination[2].space,world[2].space,"ordinary artwork and onions stay on their world grid");
        assert_eq!(destination[2].rect,world[2].rect);
        assert_eq!(destination[2].filter,world[2].filter);
        assert!(!destination[0].canvas,"plain cel sampling remains unchanged");
    }

    #[test]
    fn destination_drawing_reuses_the_affine_nested_filter_owner() {
        let root = Group {parent:0,depth:0,opacity:1.0,bounds:[0.0,0.0,800.0,600.0],layer:u32::MAX};
        let group = |layer| Group {parent:0,depth:1,opacity:1.0,bounds:[40.0,40.0,470.0,330.0],layer};
        let effects = stack(vec![blur(4.0)]);
        let bounds=[36.0,36.0,439.0,295.0];let domain=[37.0,37.0,437.0,293.0];
        let list=list(vec![root,group(0),group(1)],vec![
            EffectLayer {effects:effects.clone(),kind:LayerKind::Entry {bounds,domain,scale:0.56,padding:1.0,single_drawing:true}},
            EffectLayer {effects,kind:LayerKind::Nested {bounds,domain,scale:0.56}},
        ]);
        for (matrix,camera_view) in [
            ([0.87,0.0,0.0,0.87,152.0,16.0],false),
            ([-0.87,0.0,0.0,0.87,850.0,16.0],false),
            ([0.81,0.31,-0.31,0.81,152.0,16.0],false),
            ([1.2,0.1,-0.1,1.2,20.0,30.0],true),
        ] {
            let placements=plan_with_grid(&list,&View {matrix,camera_view,..view()},DrawingGrid::Destination);
            assert_eq!(placements[1].space,placements[2].space);
            assert_eq!(placements[1].rect,placements[2].rect);
            assert_eq!(placements[1].filter,placements[2].filter);
            assert_eq!(placements[1].canvas,placements[2].canvas);
        }
    }

    #[test]
    fn entries_and_nested_layers_share_a_grid() {
        let root = Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER };
        let entry = Group { parent: 0, depth: 1, opacity: 1.0, bounds: [100.0, 100.0, 300.0, 300.0], layer: 0 };
        let node = Group { parent: 1, depth: 2, opacity: 1.0, bounds: [150.0, 150.0, 200.0, 200.0], layer: 1 };
        let layers = vec![
            EffectLayer { effects: stack(vec![blur(4.0)]), kind: LayerKind::Entry { bounds: [90.0, 90.0, 220.0, 220.0], domain: [97.0, 97.0, 206.0, 206.0], scale: 1.0, padding: 13.0, single_drawing: false } },
            EffectLayer { effects: stack(vec![blur(2.0)]), kind: LayerKind::Nested { bounds: [140.0, 140.0, 70.0, 70.0], domain: [147.0, 147.0, 56.0, 56.0], scale: 0.5 } },
        ];
        let plans = plan(&list(vec![root, entry, node], layers), &view());
        let (e, n) = (plans[1], plans[2]);
        assert!(e.canvas && n.canvas, "cels in both effect rasters use Canvas smoothing");
        assert_eq!(e.space, n.space, "the nested layer is on its entry's grid");
        let ps = 2f64.sqrt();
        assert_eq!(e.rect, [0.0, 0.0, (220.0 * ps).ceil(), (220.0 * ps).ceil()]);
        let f = e.filter.unwrap();
        assert!((f.origin[0] + 7.0 * ps).abs() < 1e-9, "the domain's corner is the effects' origin");
        assert!((f.output_size[0] - 206.0 * ps).abs() < 1e-9);
        // The node's layer: its bounds on the grid, grown by its padding plus two pixels.
        let pad = styk_eval::vfx::padding(&[blur(2.0)], ps * 0.5, 0.0) + 2.0;
        assert_eq!(n.rect[0], ((140.0 - 90.0) * ps).floor() - pad);
        let nf = n.filter.unwrap();
        assert!((nf.origin[0] - (n.rect[0] - (147.0 - 90.0) * ps)).abs() < 1e-9);
        assert!((nf.scale - ps * 0.5).abs() < 1e-12);
    }

    #[test]
    fn a_raster_entry_takes_the_editors_grid_without_an_effect_cap() {
        let root = Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER };
        let object = Group { parent: 0, depth: 1, opacity: 1.0, bounds: [100.0, 100.0, 300.0, 300.0], layer: 0 };
        let layers = vec![EffectLayer { effects: None, kind: LayerKind::Raster { bounds: [97.0, 98.0, 206.0, 205.0] } }];
        let p = plan(&list(vec![root, object], layers), &view())[1];
        // The view's 1.25 pixels per unit, a quarter octave up: √2, on a grid anchored at the bounds.
        let ps = 2f64.sqrt();
        assert_eq!(p.space, [ps, 0.0, 0.0, ps, -97.0 * ps, -98.0 * ps]);
        assert_eq!(p.rect, [0.0, 0.0, (206.0 * ps).ceil(), (205.0 * ps).ceil()]);
        assert!(p.filter.is_none());
        assert!(p.canvas, "compatibility rasters paint cels with Canvas smoothing too");
        // Only artwork with effects keeps within the effect surface (`vfxRasterScale`).
        let wide = [0.0, 0.0, 3000.0, 100.0];
        let visible = [0.0, 0.0, 3000.0, 100.0];
        assert_eq!(entry_raster(wide, 0.0, 1.25, visible, 8192, false).unwrap().1, ps);
        assert!(entry_raster(wide, 0.0, 1.25, visible, 8192, true).unwrap().1 < ps);
    }

    #[test]
    fn plain_groups_inherit_their_parents_drawing_sampler() {
        let group = |parent, depth, layer| Group { parent, depth, opacity: 0.5, bounds: [110.0, 110.0, 160.0, 160.0], layer };
        let layers = vec![
            EffectLayer { effects: stack(vec![blur(2.0)]), kind: LayerKind::Entry { bounds: [90.0, 90.0, 100.0, 100.0], domain: [100.0, 100.0, 80.0, 80.0], scale: 1.0, padding: 10.0, single_drawing: false } },
            EffectLayer { effects: stack(vec![blur(1.0)]), kind: LayerKind::Nested { bounds: [100.0, 100.0, 80.0, 80.0], domain: [110.0, 110.0, 60.0, 60.0], scale: 1.0 } },
            EffectLayer { effects: None, kind: LayerKind::Raster { bounds: [90.0, 90.0, 100.0, 100.0] } },
            EffectLayer { effects: stack(vec![blur(2.0)]), kind: LayerKind::Camera { canvas: [960, 540], camera: None } },
        ];
        let groups = vec![
            group(0, 0, NO_LAYER), group(0, 1, NO_LAYER),
            group(0, 1, 0), group(2, 2, NO_LAYER),
            group(2, 2, 1), group(4, 3, NO_LAYER),
            group(0, 1, 2), group(6, 2, NO_LAYER),
            group(0, 1, 3), group(8, 2, NO_LAYER),
        ];
        let plans = plan(&list(groups, layers), &view());
        assert!(plans.iter().all(Placement::drawn), "all sampler cases must be visible");
        assert_eq!(plans.iter().map(|p| p.canvas).collect::<Vec<_>>(),
            [false, false, true, true, true, true, true, true, false, false],
            "only object rasters and their isolation children use Canvas cel smoothing");
    }

    #[test]
    fn offscreen_layers_are_cropped_or_skipped() {
        let root = Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER };
        let far = Group { parent: 0, depth: 1, opacity: 1.0, bounds: [5000.0, 0.0, 5100.0, 100.0], layer: 0 };
        let wide = Group { parent: 0, depth: 1, opacity: 1.0, bounds: [-2000.0, 0.0, 3000.0, 100.0], layer: 1 };
        let entry = |x: f64, w: f64| EffectLayer { effects: stack(vec![blur(10.0)]), kind: LayerKind::Entry { bounds: [x, 0.0, w, 100.0], domain: [x + 30.0, 30.0, w - 60.0, 40.0], scale: 1.0, padding: 30.0, single_drawing: false } };
        let plans = plan(&list(vec![root, far, wide], vec![entry(4970.0, 160.0), entry(-2030.0, 5060.0)]), &view());
        assert!(!plans[1].drawn(), "entirely off screen");
        let w = plans[2];
        let reach = styk_eval::vfx::sampling_padding(&[blur(10.0)], w.filter.unwrap().scale, 0.0) + 2.0;
        // The screen is 1000 pixels wide from x = -8 world units: the layer starts there, less the blur's reach.
        let ps = density(w.space);
        assert_eq!(w.rect[0], (((-8.0 - -2030.0) * ps) - reach).floor());
        assert!(w.rect[2] - w.rect[0] < 1000.0 * ps / 1.25 + 2.0 * reach + 4.0);
    }

    #[test]
    fn the_camera_image_maps_onto_the_artboard() {
        let stack = vec![blur(8.0)];
        let camera = CameraPose { x: 40.0, y: -10.0, scale: 0.8, angle: 0.1, is_default: false };
        let c = camera_plan(&stack, [960, 540], Some(camera), &view());
        // The workspace zoom times the camera's scale, below the 2048-pixel cap.
        let resolution: f64 = 1.25 * 0.8;
        assert_eq!(c.filter.output_size, [(960.0 * resolution).ceil(), (540.0 * resolution).ceil()]);
        let pad = c.filter.origin[0].abs();
        assert_eq!(c.size[0] as f64, c.filter.output_size[0] + 2.0 * pad);
        // The shown part's corners land on the camera rectangle's corners in the workspace.
        let top_left = apply(c.composite.to_screen, [c.composite.show[0], c.composite.show[1]]);
        let (sin, cos) = 0.1f64.sin_cos();
        let (a, b) = (cos * 0.8, sin * 0.8);
        let corner = [480.0 + 40.0 - a * 480.0 + b * 270.0, 270.0 - 10.0 - b * 480.0 - a * 270.0];
        assert!((top_left[0] - (10.0 + corner[0] * 1.25)).abs() < 1e-9 && (top_left[1] - (20.0 + corner[1] * 1.25)).abs() < 1e-9);
        // A capped preview: never more than 2048 pixels on its longest side.
        let near = View { zoom: 9.0, matrix: [9.0, 0.0, 0.0, 9.0, 0.0, 0.0], ..view() };
        assert_eq!(camera_plan(&stack, [960, 540], None, &near).filter.output_size[0], 2048.0);
        // An export follows the output, within the effect surface (4096 less its margin).
        let export = View { camera_view: true, zoom: 3.0, matrix: [3.0, 0.0, 0.0, 3.0, 0.0, 0.0], pan: [0.0; 2], camera_limit: f64::INFINITY, ..view() };
        assert_eq!(camera_plan(&stack, [960, 540], None, &export).filter.output_size[0], 2880.0);
        let huge = View { zoom: 8.0, matrix: [8.0, 0.0, 0.0, 8.0, 0.0, 0.0], ..export };
        let width = camera_plan(&stack, [960, 540], None, &huge).filter.output_size[0];
        assert!(width < 3968.0 && width > 3700.0, "{width}");
    }

    #[test]
    fn a_stretched_export_maps_the_camera_image_onto_the_whole_output() {
        // 960×540 exported at 1920×540: twice the density across, the same down.
        let view = View { camera_view: true, zoom: 2.0, stretch: 0.5, matrix: [2.0, 0.0, 0.0, 1.0, 0.0, 0.0], size: [1920, 540], pan: [0.0; 2], camera_limit: f64::INFINITY, ..view() };
        let c = camera_plan(&[blur(8.0)], [960, 540], None, &view);
        let corner = |x: f64, y: f64| apply(c.composite.to_screen, [x, y]);
        let s = c.composite.show;
        assert_eq!(corner(s[0], s[1]), [0.0, 0.0]);
        let far = corner(s[2], s[3]);
        assert!((far[0] - 1920.0).abs() < 1e-9 && (far[1] - 540.0).abs() < 1e-9, "{far:?}");
    }
}
