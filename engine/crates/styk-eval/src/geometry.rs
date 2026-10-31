//! World-space geometry of an evaluated frame (`buildGeometrySteps`): joints, segment primitives and polygons in the
//! exact painter order the JavaScript editor uses.
//!
//! Objects are resolved level by level along their joins; every level builds in
//! parallel. Points live in one shared buffer per scene, so a frame with 100k
//! primitives performs a handful of allocations, not 100k.

use std::sync::Arc;

mod cache;
mod interface;
pub use interface::write_groups;
pub(crate) use cache::{Resolved, arc_allocation};
pub use cache::{ClipSceneCache, RetainedScene, SceneBudget};

use crate::doc::*;
use crate::eval::Frame;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Line,
    SquareLine,
    Circle,
    CircleFill,
    CircleClear,
    Image,
    Text,
    Poly,
    /// Depth-tested faces of an evaluated mesh ([`Item::mesh`], [`Item::faces`]).
    Mesh,
}

impl ItemKind {
    pub fn name(self) -> &'static str {
        match self {
            ItemKind::Line | ItemKind::SquareLine => "line",
            ItemKind::Circle | ItemKind::CircleFill | ItemKind::CircleClear => "circle",
            ItemKind::Image => "image",
            ItemKind::Text => "text",
            ItemKind::Poly => "poly",
            ItemKind::Mesh => "mesh",
        }
    }
}

/// One drawable primitive.
#[derive(Clone, Debug)]
pub struct Item {
    pub slot: u32,
    pub kind: ItemKind,
    /// Segment index, or polygon index for `Poly`.
    pub index: u32,
    /// Index into [`Scene::figures`].
    pub figure: u32,
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub angle: f64,
    pub bend: f64,
    pub length: f64,
    pub thickness: f64,
    pub rgb: [u8; 3],
    pub alpha: f64,
    pub opacity: f64,
    /// Export's `hasDrawableVfx` source decision, including unused active scopes
    /// and the active figure/Scene effects of every outer movieclip owner.
    pub export_vfx: bool,
    pub z: f64,
    /// Range in [`Scene::points`] (bent lines and polygons).
    pub points: (u32, u32),
    /// The object's colour override (for gradient end colours).
    pub color: u32,
    /// The object's colour transition (index into [`Scene::transitions`], or
    /// `NO_TRANSITION`), which replaces `color` when mixing colours.
    pub transition: u32,
    pub scale: f64,
    pub image_text_flags: bool,
    /// Movieclip nesting: index into [`Scene::chains`], or `NO_CHAIN`.
    pub chain: u32,
    /// `ITEM_*` drawing flags.
    pub flags: u8,
    /// For `Mesh`: index into [`Scene::meshes`]; `NO_MESH` otherwise.
    pub mesh: u32,
    /// For `Mesh`: the faces of the mesh this drawable holds (a painter-order bucket).
    pub faces: (u32, u32),
    /// For a polygon that is a depth-tested surface: range in [`Scene::depths`],
    /// one depth per point (`depthValues`). Empty otherwise.
    pub depth: (u32, u32),
}

pub const NO_CHAIN: u32 = u32::MAX;
pub const NO_MESH: u32 = u32::MAX;
pub const NO_TRANSITION: u32 = u32::MAX;

impl Item {
    /// `depthSurface(item)`: the item is drawn depth tested against the depth
    /// surfaces next to it in its object's painter order. Meshes always are;
    /// a polygon is when it is an opaque triangle or clipped quad with one
    /// depth per point.
    pub fn depth_surface(&self) -> bool {
        match self.kind {
            ItemKind::Mesh => self.faces.1 > self.faces.0,
            ItemKind::Poly => {
                let points = self.points.1 - self.points.0;
                self.depth.1 > self.depth.0 && self.depth.1 - self.depth.0 == points && (3..=4).contains(&points) && self.alpha == 1.0
            }
            _ => false,
        }
    }
}
/// A polygon expanded from a shaped segment: paint it with the segment's brush.
pub const ITEM_SEG_BRUSH: u8 = 1;
/// A fixed colour: ignore the segment's paint and gradient.
pub const ITEM_SOLID: u8 = 2;
/// Stroke `points` as an open polyline (curved Stick Nodes segments).
pub const ITEM_POLYLINE: u8 = 4;
/// A polygon turned away from the view: only [`build_shapes`] keeps it (in [`Scene::measured`]).
pub const ITEM_CULLED: u8 = 8;

/// Query metadata of a segment before visible drawable/Stick Nodes expansion.
/// Curves remain in [`Scene::points`]; a straight segment's empty range reads
/// its existing start and this raw drawing end. No second geometry is built.
#[derive(Clone, Copy, Debug, Default)]
pub struct RawSegment {
    pub drawing_end: [f64; 2],
    pub points: (u32, u32),
    /// The existing rig/scale-adjusted stroke width.
    pub thickness: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ObjectGeometry {
    pub slot: u32,
    pub uid: u32,
    pub figure: u32,
    pub root: [f64; 2],
    /// The pose's scale.
    pub scale: f64,
    /// Handle position per segment index (NaN when unresolved).
    pub ends: Vec<[f64; 2]>,
    pub starts: Vec<[f64; 2]>,
    /// Per segment: the scaled length resolved in the existing geometry loop,
    /// including IK/rig derivation and invisible control segments.
    pub lengths: Vec<f64>,
    pub raw_segments: Vec<RawSegment>,
    pub opacity: f64,
    pub resolved: bool,
    /// What a spatial rig's joints carry besides their positions; `None` for
    /// a figure without one.
    pub spatial: Option<Arc<ObjectSpatial>>,
    /// Per segment of a figure with rig relationships, what editing reads from its
    /// evaluation (`rigSpace`, `connector`); `None` for a figure without any.
    pub rig: Option<Arc<[RigJoint]>>,
    /// What a follow camera frames of the object (`figureBounds`): `[x0, y0, x1, y1]` over
    /// its visible segments' endpoints, curves and circles with half their stroke, and
    /// every polygon's points (culled surfaces too); a movieclip's handle. `None` when
    /// nothing is finite, and for a figure built without [`build_measured`].
    pub extent: Option<[f64; 4]>,
    /// Per segment: the angle it was built at, after inverse kinematics and the rig. Recorded by
    /// [`build_shapes`] (a movieclip instance always has its own).
    pub angles: Vec<f64>,
    /// What inverse kinematics solved for the object, recorded by [`build_shapes`].
    pub solution: Option<Arc<crate::ik::Solution>>,
}

/// What a build collects besides the scene that is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Measure {
    Off,
    /// Each figure's [`ObjectGeometry::extent`], for a follow camera.
    Follow,
    /// The primitives the app's `boundsOf` measures ([`Scene::measured`]).
    Bounds,
    /// What the interface reads of every segment and polygon, drawn or not: [`Scene::measured`],
    /// [`ObjectGeometry::angles`] and [`ObjectGeometry::solution`].
    Shapes,
}

/// `figureBounds`, accumulated point by point.
#[derive(Clone, Copy, Debug)]
struct Bounds {
    rect: [f64; 4],
    found: bool,
}

impl Bounds {
    fn new() -> Bounds {
        Bounds { rect: [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], found: false }
    }

    fn add(&mut self, p: [f64; 2], pad: f64) {
        if !p[0].is_finite() || !p[1].is_finite() {
            return;
        }
        self.found = true;
        let r = &mut self.rect;
        if p[0] - pad < r[0] {
            r[0] = p[0] - pad;
        }
        if p[1] - pad < r[1] {
            r[1] = p[1] - pad;
        }
        if p[0] + pad > r[2] {
            r[2] = p[0] + pad;
        }
        if p[1] + pad > r[3] {
            r[3] = p[1] + pad;
        }
    }

    /// A segment as drawn before Stick Nodes shapes expand it: a circle by its centre and
    /// radius, a curve by its points, a line by its ends; half its stroke around each.
    fn segment(&mut self, it: &Item, prim: Prim, points: &[[f64; 2]]) {
        let pad = if it.thickness.is_nan() { f64::NAN } else { it.thickness.max(0.0) / 2.0 };
        if prim.is_circle() {
            self.add([(it.start[0] + it.end[0]) / 2.0, (it.start[1] + it.end[1]) / 2.0], it.length.abs() / 2.0 + pad);
        } else if !points.is_empty() {
            for &p in points {
                self.add(p, pad);
            }
        } else {
            self.add(it.start, pad);
            self.add(it.end, pad);
        }
    }

    fn extent(&self) -> Option<[f64; 4]> {
        self.found.then_some(self.rect)
    }
}

/// A rigged joint as geometry evaluated it, for editing: the space its authored
/// angle is in (`rigSpace`, which `authoredRigTarget` inverts) and whether it is a
/// connector sliding between two joints.
#[derive(Clone, Copy, Debug, Default)]
pub struct RigJoint {
    pub space: Option<crate::rig::Space>,
    pub connector: bool,
    /// The joint as the rig evaluated it, drawn or not: angle, bend and scaled length.
    pub angle: f64,
    pub bend: f64,
    pub length: f64,
    /// The angle the pose authored for it before the rig's own turns (`authoredAngle`).
    pub authored: f64,
    /// The rotation it inherits (`rigRotation`), and the space the joints below it are authored in
    /// (`rigChildSpace`) when it passes one on.
    pub rotation: f64,
    pub child_space: Option<crate::rig::Space>,
}

/// The 3D side of an evaluated figure: what surfaces, meshes and attached
/// movieclip meshes read from its bones ([`crate::spatial`]).
#[derive(Clone, Debug, Default)]
pub struct ObjectSpatial {
    /// Spatial frame per segment index (bones only).
    pub frames: Vec<Option<crate::rig::SpatialFrame>>,
    /// Depth guide and unprojected position per segment index.
    pub depths: Vec<crate::spatial::JointDepth>,
    /// `animationRotation(figure, object)`.
    pub figure_angle: f64,
    pub mirror: bool,
    /// The pose's perspective.
    pub camera: Option<crate::spatial::Camera>,
    /// Per segment index: the angle the pose authored for it (`authoredAngle`).
    pub authored: Vec<f64>,
    /// Per segment index: a spatial bone's start before perspective (`start.rawPoint`).
    pub start_raws: Vec<Option<[f64; 3]>>,
}

impl ObjectGeometry {
    pub fn joint(&self, fig: &Figure, handle: u32) -> Option<[f64; 2]> {
        if handle == 0 {
            return Some(self.root);
        }
        let i = *fig.plan.index_of.get(&handle)? as usize;
        let p = self.ends[i];
        (!p[0].is_nan()).then_some(p)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    /// Retained derived-buffer charge computed once by the builder. Reading it
    /// is O(1). Shared document/figure payloads and allocator overhead are
    /// outside this charge; resolved effects/paints are conservatively charged.
    /// A caller changing public buffers must rebuild
    /// this value with [`Scene::account_buffers`] before using it as a charge.
    pub retained_bytes: usize,
    pub objects: Vec<ObjectGeometry>,
    pub items: Vec<Item>,
    pub points: Vec<[f64; 2]>,
    pub figures: Vec<Arc<Figure>>,
    /// Per object slot: its resolved instance in [`Scene::figures`]. Kept from
    /// the builder's existing figure table; `u32::MAX` means absent.
    pub figure_of: Vec<u32>,
    pub camera: Option<Camera>,
    pub background: (u32, u32, f64),
    pub warnings: Vec<String>,
    /// Scene colour key (ARGB) replacing the native background, if any.
    pub background_color: Option<u32>,
    /// Movieclip owner opacities.
    pub owners: Vec<f64>,
    /// By owner: the instance's absolute scale, times the scales of the
    /// instances it is nested in (the scale its container effects apply at).
    pub owner_scales: Vec<f64>,
    /// Owner chains, outermost first: (owner, child slot inside that clip).
    pub chains: Vec<Vec<(u32, u32)>>,
    /// The effects of the frame this scene was built from ([`Frame::vfx`]).
    pub vfx: Option<Arc<crate::vfx::FrameVfx>>,
    /// By owner (as [`Scene::owners`]): the effects of the clip's own frame,
    /// which its child slots in [`Scene::chains`] index.
    pub clip_vfx: Vec<Option<Arc<crate::vfx::FrameVfx>>>,
    /// Evaluated meshes ([`Item::mesh`]).
    pub meshes: Vec<crate::spatial::SharedMesh>,
    /// Depths of depth-tested surfaces ([`Item::depth`]).
    pub depths: Vec<f64>,
    /// Colour transitions of the objects that have one ([`Item::transition`]).
    pub transitions: Vec<ColorTransition>,
    /// Built by [`build_only_measured`]: what the app's `boundsOf` measures of each object,
    /// whether it is drawn or not ([`crate::drawlist::app_bounds`]): every segment as it stands
    /// before a Stick Nodes shape expands it, every polygon (culled ones too) and the figure's
    /// mesh. Empty from every other build.
    pub measured: Vec<Item>,
    /// By object slot, the build ([`BuildMemory::built_in`]) that made its geometry, for a scene built with a memory (empty for any other):
    /// a number is never another build's in any memory, so an object with the same number has the same items.
    pub built_in: Vec<u64>,
    /// Which scene this is: every build is numbered, and a scene is never changed once built, so what was made of a stamp is what
    /// the scene still gives. Unlike an address, a stamp is never another scene's.
    pub stamp: Stamp,
}

/// The number a build gives its scene (0: a scene that was not built, which nothing is remembered of).
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct Stamp(u64);

impl Stamp {
    /// The number, 0 if the scene was not built.
    pub fn get(self) -> u64 {
        self.0
    }
}

// What a scene is stamped with is not part of what it holds: scenes built twice print alike.
impl std::fmt::Debug for Stamp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Stamp")
    }
}

static STAMPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Scene {
    /// The actual styled/pose-choice figure of this object's geometry.
    pub fn figure_for(&self, slot: usize) -> Option<&Figure> {
        self.figures.get(*self.figure_of.get(slot)? as usize).map(|f| &**f)
    }

    pub fn points_of(&self, item: &Item) -> &[[f64; 2]] {
        &self.points[item.points.0 as usize..item.points.1 as usize]
    }

    /// `depthValues` of a depth-tested surface.
    pub fn depths_of(&self, item: &Item) -> &[f64] {
        &self.depths[item.depth.0 as usize..item.depth.1 as usize]
    }

    /// The mesh a `Mesh` item draws faces of.
    pub fn mesh_of(&self, item: &Item) -> Option<&crate::spatial::MeshGeometry> {
        self.meshes.get(item.mesh as usize).map(|mesh| &**mesh)
    }
}

/// `arc()` in geometry.mjs: a bent segment sampled as a circular arc.
pub fn arc_points(start: [f64; 2], angle: f64, length: f64, bend: f64, out: &mut Vec<[f64; 2]>) {
    if !start[0].is_finite() || !start[1].is_finite() || !angle.is_finite() || !length.is_finite() || !bend.is_finite() {
        return;
    }
    if bend.abs() < 1e-7 {
        out.push(start);
        out.push([start[0] + length * styk_math::cos(angle), start[1] + length * styk_math::sin(angle)]);
        return;
    }
    let steps = 8f64.max(160f64.min((bend.abs() * 16.0).ceil()).min((length.abs() / 4.0).ceil())) as usize;
    let r = length / bend;
    let (s0, c0) = (styk_math::sin(angle), styk_math::cos(angle));
    for i in 0..=steps {
        let a = angle + (bend * i as f64) / steps as f64;
        out.push([start[0] + r * (styk_math::sin(a) - s0), start[1] + r * (c0 - styk_math::cos(a))]);
    }
}

pub fn fround(v: f64) -> f64 {
    v as f32 as f64
}

/// `objectColor`: a colour of a figure as the object draws it, mixed with its override, or
/// with both overrides of its colour transition and taken `t` of the way between them.
pub fn object_rgb(base: [u8; 3], color: u32, transition: Option<&ColorTransition>) -> [u8; 3] {
    let Some(c) = transition else { return mix_color(base, color) };
    let (a, b) = (mix_color(base, c.from), mix_color(base, c.to));
    // `Math.round(lerp(a, b, t))`; a NaN channel is drawn as 0, as the GPU renderer clamps it.
    std::array::from_fn(|i| (a[i] as f64 + (b[i] as f64 - a[i] as f64) * c.t + 0.5).floor() as u8)
}

pub fn mix_color(base: [u8; 3], raw: u32) -> [u8; 3] {
    let k = raw >> 24;
    if k == 0 {
        return base;
    }
    let c = [(raw & 255) as u8, (raw >> 8 & 255) as u8, (raw >> 16 & 255) as u8];
    if k == 255 {
        return c;
    }
    let mut out = [0u8; 3];
    for i in 0..3 {
        let v = base[i] as i64;
        out[i] = ((v * 256 + k as i64 * (c[i] as i64 - v)) as f64 / 256.0).floor() as u8;
    }
    out
}

/// Per-object build output before it is spliced into the scene buffers.
#[derive(Clone)]
struct Built {
    geometry: ObjectGeometry,
    items: Vec<Item>,
    points: Vec<[f64; 2]>,
    /// Movieclip content: its own figure table, owners and chains (local ids).
    figures: Vec<Arc<Figure>>,
    owners: Vec<f64>,
    owner_scales: Vec<f64>,
    chains: Vec<Vec<(u32, u32)>>,
    clip_vfx: Vec<Option<Arc<crate::vfx::FrameVfx>>>,
    /// Evaluated meshes and surface depths (local indices).
    meshes: Vec<crate::spatial::SharedMesh>,
    depths: Vec<f64>,
    /// Colour transitions (local indices).
    transitions: Vec<ColorTransition>,
    /// [`Scene::measured`] of this object.
    measured: Vec<Item>,
}

/// What a build keeps of one object for the next build over the same document.
#[derive(Clone)]
struct Kept {
    object: Arc<Object>,
    figure: Arc<Figure>,
    /// Where the figure stood in the scene's table (the items name it).
    table: u32,
    root: [u64; 2],
    ik: Option<crate::ik::Solution>,
    built: Arc<Built>,
    /// The build that made it ([`BuildMemory::serial`]).
    serial: u64,
}

impl Kept {
    fn new(object: &Arc<Object>, figure: &Arc<Figure>, table: u32, root: [f64; 2], ik: Option<crate::ik::Solution>, built: Arc<Built>) -> Kept {
        Kept { object: object.clone(), figure: figure.clone(), table, root: root.map(f64::to_bits), ik, built, serial: 0 }
    }
}

/// The build of an object the last build kept, when everything the build reads of it is what it read then: the object
/// (the same node of the typed frame), its figure, the root it hangs from and the pose inverse kinematics gave it.
fn reuse(previous: Option<&[Option<Kept>]>, slot: usize, object: &Arc<Object>, figure: &Arc<Figure>, table: u32, root: [f64; 2], ik: Option<&crate::ik::Solution>) -> Option<Arc<Built>> {
    let kept = previous?.get(slot)?.as_ref()?;
    (Arc::ptr_eq(&kept.object, object) && Arc::ptr_eq(&kept.figure, figure) && kept.table == table && kept.root == root.map(f64::to_bits) && kept.ik.as_ref() == ik).then(|| kept.built.clone())
}

/// Numbers the builds of every memory: an object's build is never taken for another memory's.
static BUILDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// What successive builds of one document's frame share: an object whose inputs are the ones its last build had is not built
/// again, so a gesture that moves one figure builds that figure and the figures that hang from what moved, not the frame.
/// The scene is the same whether objects were built or kept. One memory serves one kind of build (`measure`) of one
/// document: the owner drops it with the document.
#[derive(Default, Clone)]
pub struct BuildMemory {
    slots: Vec<Option<Kept>>,
    measure: Option<(Measure, u32)>,
    serial: u64,
}

impl BuildMemory {
    /// Starts a build of `count` objects of kind `measure` of a document of `version`: another kind, count or version
    /// forgets what was kept.
    fn begin(&mut self, count: usize, measure: Measure, version: u32) {
        if self.slots.len() != count || self.measure != Some((measure, version)) {
            self.slots.clear();
            self.slots.resize_with(count, || None);
            self.measure = Some((measure, version));
        }
    }

    /// Ends the build: the objects built anew are kept (numbered by this build), the others stay as they were, and an
    /// object the build did not make is forgotten.
    fn finish(&mut self, built: &[Option<Arc<Built>>], anew: Vec<(usize, Kept)>) {
        self.serial = BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        for (slot, mut kept) in anew {
            kept.serial = self.serial;
            self.slots[slot] = Some(kept);
        }
        for (slot, built) in built.iter().enumerate() {
            if built.is_none() {
                self.slots[slot] = None;
            }
        }
    }

    /// The number of the last build (builds are numbered in the order they end, across every memory).
    pub fn serial(&self) -> u64 {
        self.serial
    }

    /// The build that last made the object at `slot` (0 for none): an object whose number is above that of an earlier build
    /// is not what that build had.
    pub fn built_in(&self, slot: usize) -> u64 {
        self.slots.get(slot).and_then(Option::as_ref).map_or(0, |kept| kept.serial)
    }
}

impl Built {
    fn new(geometry: ObjectGeometry) -> Built {
        Built { geometry, items: Vec::new(), points: Vec::new(), figures: Vec::new(), owners: Vec::new(), owner_scales: Vec::new(), chains: Vec::new(), clip_vfx: Vec::new(), meshes: Vec::new(), depths: Vec::new(), transitions: Vec::new(), measured: Vec::new() }
    }
}

/// `ik` is the object's derived pose when a pinned IK controller reaches it:
/// its angles (and stretched lengths) replace the authored channels.
#[allow(clippy::too_many_arguments)]
/// A segment's pose as the object stores it, before inverse kinematics, rigs and
/// scale: angle, bend and length, with the editor's fallbacks (`segmentAt`).
pub fn segment_pose(obj: &Object, seg: &crate::doc::Segment, i: usize) -> (f64, f64, f64) {
    let angle = obj.angles.get(i).copied().unwrap_or(seg.angle);
    let bend = match &obj.bends {
        Some(b) => b.get(i).copied().unwrap_or(0.0),
        None => seg.bend,
    };
    let length = match &obj.lengths {
        Some(l) => l.get(i).copied().unwrap_or(seg.length),
        None => seg.length,
    };
    (angle, bend, length)
}

#[allow(clippy::too_many_arguments)]
fn build_object(doc: &Document, version: u32, frame: &Frame, slot: usize, figure_slot: u32, fig: &Figure, root: [f64; 2], ik: Option<&crate::ik::Solution>, measure: Measure, render_output: bool) -> Built {
    let obj = &frame.objects[slot];
    let n = fig.segments.len();
    let scale = obj.scale;
    let opacity = 1.0 - obj.transparency / 255.0;
    let nan = [f64::NAN, f64::NAN];
    let mut ends = vec![nan; n];
    let mut starts = vec![nan; n];
    let mut lengths = vec![f64::NAN; n];
    let mut angles: Vec<f64> = if measure == Measure::Shapes { vec![f64::NAN; n] } else { Vec::new() };
    let mut raw_segments = vec![RawSegment::default(); n];
    let mut items: Vec<Item> = if render_output { Vec::with_capacity(n + fig.polyfills.len()) } else { Vec::new() };
    let mut points: Vec<[f64; 2]> = Vec::new();
    // Segment item index per segment (for polygon edges).
    let mut seg_item = if render_output { vec![u32::MAX; n] } else { Vec::new() };
    let plan = &fig.plan;
    let black_override = version < 5 && !fig.segment_colors;
    let mut segment_items: Vec<Item> = if render_output { Vec::with_capacity(n) } else { Vec::new() };
    let (transition, transitions) = match (&obj.color_transition, render_output) {
        (Some(c), true) => (0, vec![**c]),
        _ => (NO_TRANSITION, Vec::new()),
    };
    // Rigged figures evaluate in dependency order with their rig context.
    let rig_plan = plan.rig.clone();
    let mut rig_states: Vec<Option<crate::rig::State>> = if rig_plan.is_some() { vec![None; n] } else { Vec::new() };
    let figure_angle = crate::origin::rotation(fig, obj);
    let order: &[u32] = match &rig_plan {
        Some(r) => &r.order,
        None => &plan.order,
    };
    // 3D: the pose's perspective, and per joint what surfaces and meshes read.
    let has_spatial = rig_plan.is_some() && plan.spatial;
    let camera = if has_spatial { crate::spatial::Camera::of(obj, root) } else { None };
    let shape = obj.spatial.as_ref().and_then(|s| s.shape.as_ref());
    let mut frames: Vec<Option<crate::rig::SpatialFrame>> = if has_spatial { vec![None; n] } else { Vec::new() };
    let mut depths: Vec<crate::spatial::JointDepth> = if has_spatial { vec![Default::default(); n] } else { Vec::new() };
    let mut authored: Vec<f64> = if has_spatial { vec![f64::NAN; n] } else { Vec::new() };
    let mut start_raws: Vec<Option<[f64; 3]>> = if has_spatial { vec![None; n] } else { Vec::new() };
    for &i in order {
        let i = i as usize;
        let seg = &fig.segments[i];
        let parent = plan.parent[i];
        let start = if parent == u32::MAX { root } else { ends[parent as usize] };
        let mut start = if start[0].is_nan() { root } else { start };
        let (posed_angle, mut bend, posed_length) = segment_pose(obj, seg, i);
        let mut angle = ik.map(|s| s.angles[i]).unwrap_or(posed_angle);
        let mut length = ik.and_then(|s| s.lengths.as_ref()).map(|l| l[i]).unwrap_or(posed_length) * scale;
        let mut width = 1.0;
        let mut rig_handle: Option<([f64; 2], bool)> = None;
        if let Some(rp) = &rig_plan {
            let ctx = crate::rig::Context {
                segments: &fig.segments,
                index_of: &plan.index_of,
                plan: rp,
                root,
                scale,
                figure_angle,
                mirror: obj.image_text_flags,
                len_flag: obj.lengths.is_some(),
                lengths: obj.lengths.as_deref(),
                camera,
                shape,
            };
            let joint = |id: u32| -> Option<[f64; 2]> {
                if id == 0 {
                    return Some(root);
                }
                let k = *plan.index_of.get(&id)? as usize;
                (!ends[k][0].is_nan()).then_some(ends[k])
            };
            let st = crate::rig::evaluate(&ctx, &mut rig_states, i, crate::rig::Input { start, angle, length, bend }, &joint);
            if has_spatial {
                frames[i] = st.spatial;
                depths[i] = crate::spatial::JointDepth { offset: st.depth_offset, raw: st.raw_point };
                authored[i] = st.authored_angle;
                start_raws[i] = st.start_raw;
            }
            start = st.start;
            angle = st.angle;
            length = st.length;
            bend = st.bend;
            width = st.width;
            let derived = seg.rig.as_ref().is_some_and(|r| r.spatial.is_some() || r.weighted.is_some());
            rig_handle = st.handle.map(|h| (h, derived));
        }
        let p0 = points.len() as u32;
        let end;
        if let Some((h, true)) = rig_handle {
            end = [fround(h[0]), fround(h[1])];
        } else if bend.abs() < 1e-7 && start[0].is_finite() && start[1].is_finite() && angle.is_finite() && length.is_finite() {
            end = [fround(start[0] + length * angle.cos()), fround(start[1] + length * angle.sin())];
        } else {
            arc_points(start, angle, length, bend, &mut points);
            let last = points.last().copied().unwrap_or(start);
            end = [fround(last[0]), fround(last[1])];
            if let Some(l) = points.last_mut() {
                *l = end;
            }
        }
        let p1 = points.len() as u32;
        // Children and joins attach at the rig handle (a connector's slider), drawing ends at `end`.
        ends[i] = match rig_handle {
            Some((h, false)) => [fround(h[0]), fround(h[1])],
            _ => end,
        };
        starts[i] = start;
        lengths[i] = length;
        if measure == Measure::Shapes {
            angles[i] = angle;
        }
        if !render_output {
            raw_segments[i] = RawSegment { drawing_end: end, points: (p0, p1), thickness: seg.thickness * scale.abs() * width };
            continue;
        }
        let rgb = if black_override {
            if (obj.color as i32) < 0 { [0, 0, 0] } else { [(obj.color & 255) as u8, (obj.color >> 8 & 255) as u8, (obj.color >> 16 & 255) as u8] }
        } else {
            object_rgb(seg.rgb, obj.color, obj.color_transition.as_deref())
        };
        let kind = match seg.prim {
            Prim::Line => ItemKind::Line,
            Prim::SquareLine => ItemKind::SquareLine,
            Prim::Circle => ItemKind::Circle,
            Prim::CircleFill => ItemKind::CircleFill,
            Prim::CircleClear => ItemKind::CircleClear,
            Prim::Image => ItemKind::Image,
            Prim::Text => ItemKind::Text,
        };
        seg_item[i] = segment_items.len() as u32;
        segment_items.push(Item {
            slot: slot as u32,
            kind,
            index: i as u32,
            figure: figure_slot,
            start,
            end,
            angle,
            bend,
            length,
            thickness: seg.thickness * scale.abs() * width,
            rgb,
            alpha: seg.alpha,
            opacity,
            z: seg.z,
            points: (p0, p1),
            color: obj.color,
            transition,
            scale,
            image_text_flags: obj.image_text_flags,
            chain: NO_CHAIN,
            flags: 0,
            mesh: NO_MESH,
            faces: (0, 0),
            depth: (0, 0),
            export_vfx: false,
        });
        // A curved Stick Nodes segment draws along its sagitta curve.
        if let Some(shape) = crate::sticknodes::shape_for(seg, obj)
            && shape.sagitta != 0.0
            && bend.abs() < 1e-7
        {
            let item = segment_items.last_mut().unwrap();
            let q0 = points.len() as u32;
            crate::sticknodes::curve(shape, shape.reversed, item.start, item.angle, item.length, scale, &mut points);
            item.points = (q0, points.len() as u32);
            item.bend = 1e-6;
            item.flags |= ITEM_POLYLINE;
        }
        let item = segment_items.last().unwrap();
        raw_segments[i] = RawSegment { drawing_end: item.end, points: item.points, thickness: item.thickness };
    }
    // Shape queries keep the same segment arithmetic and curve samples. Polygon
    // points, colors and drawable ordering do not change the joints just built.
    if !render_output {
        let mut built = Built::new(ObjectGeometry { slot: slot as u32, uid: obj.uid, figure: fig.id, root, scale, ends, starts, lengths, raw_segments, opacity, resolved: true, spatial: None, rig: None, extent: None, angles, solution: None });
        built.points = points;
        return built;
    }
    let joint = |handle: u32| -> Option<[f64; 2]> {
        if handle == 0 {
            return Some(root);
        }
        let i = *plan.index_of.get(&handle)? as usize;
        (!ends[i][0].is_nan()).then_some(ends[i])
    };
    // What a joint is before perspective (`rawPoint`); the root has none.
    let raw_of = |handle: u32| -> Option<[f64; 3]> {
        let i = *plan.index_of.get(&handle)? as usize;
        depths.get(i)?.raw
    };
    let joint_depth = |handle: u32| -> crate::spatial::JointDepth { plan.index_of.get(&handle).and_then(|&i| depths.get(i as usize)).copied().unwrap_or_default() };
    let mut surface_depths: Vec<f64> = Vec::new();
    let mut raws: Vec<Option<[f64; 3]>> = Vec::new();
    // What a follow camera frames (`figureBounds`), only when asked for ([`build_measured`]).
    let mut bounds = Bounds::new();
    let mut measured: Vec<Item> = Vec::new();
    if measure == Measure::Follow {
        for it in &segment_items {
            let seg = &fig.segments[it.index as usize];
            if seg.visible {
                bounds.segment(it, seg.prim, &points[it.points.0 as usize..it.points.1 as usize]);
            }
        }
    }
    for (pi, poly) in fig.polyfills.iter().enumerate() {
        let pp = &plan.polygons[pi];
        let p0 = points.len() as u32;
        // A depth-tested face of a perspective pose is clipped before projection,
        // which needs every point's depth.
        let projecting = camera.is_some() && poly.surface.as_ref().is_some_and(|s| s.depth_test);
        raws.clear();
        if let Some(first) = pp.first
            && let Some(p) = joint(first)
        {
            points.push(p);
            if projecting {
                raws.push(raw_of(first));
            }
        }
        for edge in &pp.edges {
            let item = if edge.index == u32::MAX { None } else { segment_items.get(seg_item[edge.index as usize] as usize) };
            // A connector's edge follows its curve only where the polygon leaves its start, and ends at its slider.
            let connector = item.and_then(|_| fig.segments[edge.index as usize].rig.as_ref()).and_then(|rig| rig.connector.as_ref());
            match item {
                Some(e) if e.bend.abs() > 1e-7 && connector.is_none_or(|c| fig.segments[edge.index as usize].parent == c.start) => {
                    let slid = connector.and_then(|_| rig_states.get(edge.index as usize).copied().flatten()).and_then(|state| state.position);
                    let (a, b) = (e.points.0 as usize, e.points.1 as usize);
                    if let Some(position) = slid {
                        let mut arc = Vec::new();
                        arc_points(e.start, e.angle, e.length * position, e.bend * position, &mut arc);
                        if edge.reverse {
                            points.extend(arc.iter().rev().skip(1));
                        } else {
                            points.extend(arc.iter().skip(1));
                        }
                        if projecting {
                            raws.resize(points.len() - p0 as usize, None);
                        }
                    } else if b > a {
                        if edge.reverse {
                            for k in (a..b - 1).rev() {
                                points.push(points[k]);
                            }
                        } else {
                            for k in a + 1..b {
                                points.push(points[k]);
                            }
                        }
                        if projecting {
                            raws.resize(points.len() - p0 as usize, None);
                        }
                    }
                }
                _ => {
                    if let Some(p) = joint(edge.end) {
                        points.push(p);
                        if projecting {
                            raws.push(raw_of(edge.end));
                        }
                    }
                }
            }
        }
        let p1 = points.len() as u32;
        let mut range = (p0, p1);
        if p1 - p0 > 1 && points[p0 as usize] == points[p1 as usize - 1] {
            points.pop();
            raws.pop();
            range.1 -= 1;
        }
        // One-sided surfaces: culled when they look away, ordered by their depth
        // guides, and depth tested against their neighbours (`surfaceEvaluation`).
        let mut z = poly.z;
        let mut depth = (0u32, 0u32);
        let mut culled = false;
        if let Some(surface) = &poly.surface {
            let mut projected = None;
            if projecting {
                match crate::spatial::project_face(&points[range.0 as usize..range.1 as usize], &raws, camera.as_ref()) {
                    Some(Ok(depths)) => projected = Some(depths),
                    Some(Err((clipped, depths))) => {
                        points.truncate(p0 as usize);
                        points.extend_from_slice(&clipped);
                        range = (p0, points.len() as u32);
                        projected = Some(depths);
                    }
                    None => {}
                }
            }
            if measure == Measure::Follow {
                for &p in &points[range.0 as usize..range.1 as usize] {
                    bounds.add(p, 0.0);
                }
            }
            let result = crate::spatial::evaluate_surface(surface, poly.z, &points[range.0 as usize..range.1 as usize], projected, root, &joint, &joint_depth);
            if result.culled {
                culled = true;
            } else {
                z = result.z;
                if let Some(values) = result.depth_values {
                    let d0 = surface_depths.len() as u32;
                    surface_depths.extend_from_slice(&values);
                    depth = (d0, surface_depths.len() as u32);
                }
            }
        } else {
            if measure == Measure::Follow {
                for &p in &points[range.0 as usize..range.1 as usize] {
                    bounds.add(p, 0.0);
                }
            }
        }
        let item = Item {
            slot: slot as u32,
            kind: ItemKind::Poly,
            index: pi as u32,
            figure: figure_slot,
            start: root,
            end: root,
            angle: 0.0,
            bend: 0.0,
            length: 0.0,
            thickness: 0.0,
            rgb: object_rgb(poly.rgb, obj.color, obj.color_transition.as_deref()),
            alpha: poly.alpha,
            opacity,
            z,
            points: range,
            color: obj.color,
            transition,
            scale,
            image_text_flags: obj.image_text_flags,
            chain: NO_CHAIN,
            flags: 0,
            mesh: NO_MESH,
            faces: (0, 0),
            depth,
            export_vfx: false,
        };
        if culled {
            // The editor measures a polygon turned away from the view; nothing draws it.
            if measure == Measure::Shapes {
                measured.push(Item { flags: item.flags | ITEM_CULLED, ..item });
            } else if measure == Measure::Bounds {
                measured.push(item);
            } else {
                points.truncate(p0 as usize);
            }
            continue;
        }
        if measure == Measure::Shapes {
            measured.push(item.clone());
        }
        items.push(item);
    }
    // The figure's mesh: evaluated once after its bones, then split where the
    // figure's other visible primitives lie in painter order (`spatialMeshDrawables`).
    let mut meshes: Vec<crate::spatial::SharedMesh> = Vec::new();
    if let Some(mesh_plan) = fig.mesh.as_ref().filter(|_| rig_plan.is_some()) {
        let context = crate::spatial::MeshContext {
            root,
            scale,
            figure_angle,
            mirror: obj.image_text_flags,
            camera,
            joint: &joint,
            colors: fig.mesh_colors.iter().map(|&c| object_rgb(c, obj.color, obj.color_transition.as_deref())).collect(),
        };
        if let Some(mut mesh) = crate::spatial::evaluate_mesh(mesh_plan, &|i| frames.get(i).copied().flatten(), context) {
            let mut levels: Vec<f64> = items.iter().map(|it| it.z).collect();
            // Zero-width lines paint nothing and must not split the depth-tested faces.
            levels.extend(segment_items.iter().filter(|it| fig.segments[it.index as usize].visible && !(matches!(it.kind, ItemKind::Line | ItemKind::SquareLine) && (it.thickness.is_nan() || it.thickness <= 0.0))).map(|it| it.z));
            for drawable in mesh.split(&levels) {
                items.push(Item {
                    slot: slot as u32,
                    kind: ItemKind::Mesh,
                    index: drawable.index,
                    figure: figure_slot,
                    start: root,
                    end: root,
                    angle: 0.0,
                    bend: 0.0,
                    length: 0.0,
                    thickness: 0.0,
                    rgb: [0, 0, 0],
                    alpha: 1.0,
                    opacity,
                    z: drawable.z,
                    points: (0, 0),
                    color: obj.color,
                    transition,
                    scale,
                    image_text_flags: obj.image_text_flags,
                    chain: NO_CHAIN,
                    flags: 0,
                    mesh: 0,
                    faces: drawable.faces,
                    depth: (0, 0),
                    export_vfx: false,
                });
            }
            meshes.push(Arc::new(mesh));
        }
    }
    if measure == Measure::Bounds {
        measured.extend(items.iter().cloned());
        measured.extend(segment_items.iter().cloned());
    } else if measure == Measure::Shapes {
        measured.extend(items.iter().filter(|it| it.kind == ItemKind::Mesh).cloned());
        measured.extend(segment_items.iter().cloned());
    }
    // Drawables: polygons, mesh faces, then visible segments in record order, stably by z.
    segment_items.sort_by_key(|it| it.index);
    for it in segment_items {
        let seg = &fig.segments[it.index as usize];
        if !seg.visible {
            continue;
        }
        match crate::sticknodes::shape_for(seg, obj) {
            Some(shape) => {
                let own: Vec<[f64; 2]> = points[it.points.0 as usize..it.points.1 as usize].to_vec();
                crate::sticknodes::expand(&it, shape, &own, &mut points, &mut items);
            }
            None => items.push(it),
        }
    }
    items.sort_by(|a, b| a.z.total_cmp(&b.z));
    let _ = doc;
    let spatial = has_spatial.then(|| Arc::new(ObjectSpatial { frames, depths, figure_angle, mirror: obj.image_text_flags, camera, authored, start_raws }));
    let rig = rig_plan.is_some().then(|| {
        rig_states
            .iter()
            .zip(&fig.segments)
            .map(|(state, seg)| RigJoint {
                space: state.and_then(|s| s.space),
                connector: seg.rig.as_ref().is_some_and(|r| r.connector.is_some()),
                angle: state.map_or(f64::NAN, |s| s.angle),
                bend: state.map_or(f64::NAN, |s| s.bend),
                length: state.map_or(f64::NAN, |s| s.length),
                authored: state.map_or(f64::NAN, |s| s.authored_angle),
                rotation: state.map_or(f64::NAN, |s| s.rotation),
                child_space: state.and_then(|s| s.child_space),
            })
            .collect()
    });
    let extent = bounds.extent();
    let mut built = Built::new(ObjectGeometry { slot: slot as u32, uid: obj.uid, figure: fig.id, root, scale, ends, starts, lengths, raw_segments, opacity, resolved: true, spatial, rig, extent, angles, solution: ik.filter(|_| measure == Measure::Shapes).map(|solution| Arc::new(solution.clone())) });
    built.items = items;
    built.points = points;
    built.meshes = meshes;
    built.depths = surface_depths;
    built.transitions = transitions;
    built.measured = measured;
    built
}

/// A movieclip instance's extent for a follow camera: its handle, from the root 40 units along its angle.
fn handle_extent(root: [f64; 2], end: [f64; 2]) -> Option<[f64; 4]> {
    let mut bounds = Bounds::new();
    bounds.add(root, 0.0);
    bounds.add(end, 0.0);
    bounds.extent()
}

/// The object a movieclip instance is joined to, for an attached mesh: its
/// pose, figure and geometry.
struct JoinedParent<'a> {
    object: &'a Object,
    figure: &'a Figure,
    geometry: &'a ObjectGeometry,
}

/// `buildMovieclipMeshSteps`: an attached mesh. Joined to a spatial bone, the
/// bone alone owns its orientation and the instance's root is the bone's start. The app's `boundsOf` measures the mesh's faces
/// ([`Scene::measured`]); the handle paints nothing.
#[allow(clippy::too_many_arguments)]
fn build_clip_mesh(frame: &Frame, slot: usize, figure_slot: u32, fig: &Figure, clip: &Movieclip, meshes: &[Arc<crate::spatial::ClipMesh>], mut root: [f64; 2], parent: Option<JoinedParent<'_>>, measure: Measure) -> Built {
    let obj = &frame.objects[slot];
    let local_angle = obj.angles.first().copied().unwrap_or(0.0);
    let scale = obj.scale;
    let opacity = 1.0 - obj.transparency / 255.0;
    // The bone the instance hangs from, if its join target is one.
    let bone = parent.as_ref().and_then(|p| {
        let handle = obj.join?.handle;
        let index = *p.figure.plan.index_of.get(&handle)? as usize;
        let spatial = p.geometry.spatial.as_ref()?;
        Some((spatial, spatial.frames.get(index)?.as_ref()?, p.geometry.starts[index]))
    });
    let attachment = match (&parent, &bone) {
        (Some(p), Some((spatial, bone_frame, start))) => {
            root = *start;
            Some(crate::spatial::Attachment { frame: bone_frame, figure_angle: spatial.figure_angle, root: p.geometry.root, scale: p.object.scale, mirror: p.object.image_text_flags, camera: crate::spatial::Camera::of(p.object, p.geometry.root) })
        }
        _ => None,
    };
    let angle = attachment.as_ref().map_or(local_angle, |a| a.figure_angle);
    let end = [root[0] + 40.0 * scale * styk_math::cos(angle), root[1] + 40.0 * scale * styk_math::sin(angle)];
    let mut built = Built::new(ObjectGeometry { slot: slot as u32, uid: obj.uid, figure: fig.id, root, scale, ends: vec![end], starts: vec![root], lengths: vec![40.0 * scale], raw_segments: vec![RawSegment { drawing_end: end, ..Default::default() }], opacity, resolved: true, spatial: None, rig: None, extent: handle_extent(root, end), angles: vec![angle], solution: None });
    let Some(local) = obj.clip_time else { return built };
    let transition = match &obj.color_transition {
        Some(c) => {
            built.transitions.push(**c);
            0
        }
        None => NO_TRANSITION,
    };
    // `Math.floor(local)` clamped to the forms the clip has.
    let form = (local.floor().max(0.0) as usize).min(meshes.len() - 1);
    let mesh = &meshes[form];
    let pose = crate::spatial::ClipPose {
        root,
        angle: local_angle,
        scale,
        mirror: obj.image_text_flags,
        pivot: clip.pivot,
        attachment,
        colors: mesh.colors.iter().map(|&c| object_rgb(c, obj.color, obj.color_transition.as_deref())).collect(),
    };
    let mut geometry = crate::spatial::evaluate_clip_mesh(mesh, pose);
    for drawable in geometry.split(&[]) {
        built.items.push(Item {
            slot: slot as u32,
            kind: ItemKind::Mesh,
            index: drawable.index,
            figure: figure_slot,
            start: root,
            end: root,
            angle: 0.0,
            bend: 0.0,
            length: 0.0,
            thickness: 0.0,
            rgb: [0, 0, 0],
            alpha: 1.0,
            opacity,
            z: drawable.z,
            points: (0, 0),
            color: obj.color,
            transition,
            scale,
            image_text_flags: obj.image_text_flags,
            chain: NO_CHAIN,
            flags: 0,
            mesh: 0,
            faces: drawable.faces,
            depth: (0, 0),
            export_vfx: false,
        });
    }
    built.meshes.push(Arc::new(geometry));
    if matches!(measure, Measure::Bounds | Measure::Shapes) {
        built.measured = built.items.clone();
    }
    built
}

/// The clip's own scene at a local time, shared by every instance.
pub fn clip_scene(clip: &Movieclip, local: f64) -> Arc<Scene> {
    let key = local.to_bits();
    if let Some(s) = clip.cache.lock().unwrap().get(&key) {
        return s.clone();
    }
    let frame = clip.prepared.evaluate_clip(clip.source_start + local);
    let scene = Arc::new(build(&clip.document, &frame));
    let mut cache = clip.cache.lock().unwrap();
    cache.publish(key, scene, &clip.document.scene_budget)
}

/// The drawing a spatial bone turns a movieclip to (`rotatedDrawing`): the view its turn and
/// tilt select in the instance's form, the roll it adds, and how it places the instance.
struct RotatedDrawing {
    frame: f64,
    root: [f64; 2],
    angle: f64,
    scale: f64,
    flip: f64,
}

/// `drawingSelection(asset, object).group`: the form whose views hold the instance's frame.
fn drawing_group(clip: &Movieclip, obj: &Object) -> usize {
    let frame = obj.movieclip.as_ref().map_or(0.0, |p| p.offset);
    clip.drawing_sets.iter().position(|views| views.contains(&frame)).unwrap_or(0)
}

/// `rotatedDrawing` with `drawingRotationReference`, and the placement
/// `buildMovieclipGeometrySteps` gives it: at the bone's start, turned by its roll and the
/// figure's rotation, scaled by its stretch and its depth under perspective.
fn rotated_drawing(clip: &Movieclip, obj: &Object, parent: &JoinedParent<'_>) -> Option<RotatedDrawing> {
    let rotation = clip.drawing_rotation?;
    let index = *parent.figure.plan.index_of.get(&obj.join?.handle)? as usize;
    let spatial = parent.geometry.spatial.as_ref()?;
    let bone = spatial.frames.get(index)?.as_ref()?;
    let figure_angle = crate::origin::rotation(parent.figure, parent.object);
    // The native angles of the turn and tilt controls up the bone chain disambiguate the
    // equivalent Euler branches of side and back views.
    let sign = if parent.object.image_text_flags { -1.0 } else { 1.0 };
    let (mut turn, mut pitch) = (0.0, 0.0);
    let mut current = Some(index);
    while let Some(k) = current {
        let Some(crate::rig::Spatial::Bone { parent: up, turn: turn_id, pitch: pitch_id, .. }) = parent.figure.segments[k].rig.as_ref().and_then(|r| r.spatial.as_ref()) else { break };
        if spatial.frames.get(k).copied().flatten().is_none() {
            break;
        }
        for (id, sum) in [(*turn_id, &mut turn), (*pitch_id, &mut pitch)] {
            let control = *parent.figure.plan.index_of.get(&id)? as usize;
            *sum += (spatial.authored[control] - figure_angle) * sign - parent.figure.segments[control].angle;
        }
        current = if *up != 0 { parent.figure.plan.index_of.get(up).map(|&i| i as usize) } else { None };
    }
    let [bend, turn, pitch] = crate::rig::quaternion_pose(bone.q, [bone.native_bend, turn, pitch]);
    let steps = rotation.steps as f64;
    let direction = (((yaw_step(turn, steps)) % steps) + steps) % steps;
    let tilt = if pitch < -rotation.tilt_threshold { 1.0 } else if pitch > rotation.tilt_threshold { 2.0 } else { 0.0 };
    let view = (tilt * steps + direction) as usize;
    let frame = *clip.drawing_sets.get(drawing_group(clip, obj))?.get(view)?;
    let camera = crate::spatial::Camera::of(parent.object, parent.geometry.root);
    let depth_scale = match (camera, spatial.start_raws.get(index).copied().flatten()) {
        (Some(camera), Some(raw)) => 1.0 / (1.0 - camera.k * raw[2]).max(0.05),
        _ => 1.0,
    };
    let inherited = if parent.object.image_text_flags { -1.0 } else { 1.0 };
    Some(RotatedDrawing {
        frame,
        root: parent.geometry.starts[index],
        angle: obj.angles.first().copied().unwrap_or(0.0) + bend * inherited + figure_angle,
        scale: obj.scale * bone.stretch * depth_scale,
        flip: (if obj.image_text_flags { -1.0 } else { 1.0 }) * inherited,
    })
}

/// `Math.floor(yaw / (2π) * steps + .5)`: the nearest of `steps` directions.
fn yaw_step(yaw: f64, steps: f64) -> f64 {
    (yaw / (std::f64::consts::PI * 2.0) * steps + 0.5).floor()
}

/// `buildMovieclipGeometrySteps`: the clip's scene placed at its pivot.
fn build_clip(frame: &Frame, slot: usize, fig: &Figure, clip: &Movieclip, root: [f64; 2], parent: Option<JoinedParent<'_>>) -> Built {
    let obj = &frame.objects[slot];
    let drawing = parent.as_ref().and_then(|parent| rotated_drawing(clip, obj, parent));
    let root = drawing.as_ref().map_or(root, |d| d.root);
    let angle = drawing.as_ref().map_or_else(|| obj.angles.first().copied().unwrap_or(0.0), |d| d.angle);
    let scale = drawing.as_ref().map_or(obj.scale, |d| d.scale);
    let flip = drawing.as_ref().map_or(if obj.image_text_flags { -1.0 } else { 1.0 }, |d| d.flip);
    let (a, b) = (angle.cos() * scale, angle.sin() * scale);
    let end = [root[0] + 40.0 * angle.cos() * scale, root[1] + 40.0 * angle.sin() * scale];
    let opacity = 1.0 - obj.transparency / 255.0;
    let mut built = Built::new(ObjectGeometry { slot: slot as u32, uid: obj.uid, figure: fig.id, root, scale, ends: vec![end], starts: vec![root], lengths: vec![40.0 * scale], raw_segments: vec![RawSegment { drawing_end: end, ..Default::default() }], opacity, resolved: true, spatial: None, rig: None, extent: handle_extent(root, end), angles: vec![angle], solution: None });
    let Some(local) = obj.clip_time else { return built };
    // A rotated drawing shows the frame its bone selects, whatever the clip's own time.
    let local = drawing.as_ref().map_or(local, |d| d.frame);
    let source = clip_scene(clip, local);
    // Meshes inside the clip keep their evaluated positions: the editor places a
    // clip's points, starts and ends, and a mesh drawable has none of them.
    built.meshes = source.meshes.clone();
    let pivot = clip.pivot;
    let point = |p: [f64; 2]| {
        let (dx, dy) = (p[0] - pivot[0], (p[1] - pivot[1]) * flip);
        [root[0] + a * dx - b * dy, root[1] + b * dx + a * dy]
    };
    built.figures = source.figures.clone();
    built.owners.push(opacity);
    built.owners.extend_from_slice(&source.owners);
    built.owner_scales.push(scale.abs());
    built.owner_scales.extend(source.owner_scales.iter().map(|s| s * scale.abs()));
    built.clip_vfx.push(source.vfx.clone());
    built.clip_vfx.extend_from_slice(&source.clip_vfx);
    // The clip's items keep their indices into its own transitions.
    built.transitions = source.transitions.clone();
    // Chain 0..n of the source shift by one owner and gain this clip as outermost.
    let hidden = clip.document.layers.as_ref().map(|l| l.hidden.clone()).unwrap_or_default();
    let mut chain_ids: std::collections::HashMap<(u32, u32), u32> = std::collections::HashMap::new();
    for it in &source.items {
        let child = &source.objects[it.slot as usize];
        if !hidden.is_empty()
            && let Some(layers) = &clip.document.layers
            && hidden.iter().any(|h| h == layers.layer_of(child.uid))
        {
            continue;
        }
        let chain = *chain_ids.entry((it.slot, it.chain)).or_insert_with(|| {
            let mut c = vec![(0u32, it.slot)];
            if it.chain != NO_CHAIN {
                c.extend(source.chains[it.chain as usize].iter().map(|&(o, p)| (o + 1, p)));
            }
            built.chains.push(c);
            built.chains.len() as u32 - 1
        });
        let p0 = built.points.len() as u32;
        for p in source.points_of(it) {
            built.points.push(point(*p));
        }
        let p1 = built.points.len() as u32;
        let d0 = built.depths.len() as u32;
        built.depths.extend_from_slice(source.depths_of(it));
        built.items.push(Item {
            slot: slot as u32,
            points: (p0, p1),
            depth: (d0, built.depths.len() as u32),
            start: point(it.start),
            end: point(it.end),
            angle: it.angle * flip + angle,
            bend: it.bend * flip,
            length: it.length * scale,
            thickness: it.thickness * scale.abs(),
            scale: it.scale * scale,
            image_text_flags: it.image_text_flags != obj.image_text_flags,
            chain,
            ..it.clone()
        });
    }
    built
}

/// How a movieclip joined to a spatial bone is placed when its drawings turn with the bone (`g.drawingView` and
/// `g.drawingTransform`): the frame of the view the bone selects, and the angle, scale and flip the clip is drawn with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawingView {
    pub frame: f64,
    pub angle: f64,
    pub scale: f64,
    pub flip: f64,
}

/// The view the movieclip at `slot` shows, from a scene built for `frame`; `None` for any object that is not a clip
/// whose drawings rotate with the bone it is joined to.
pub fn drawing_view(frame: &Frame, scene: &Scene, slot: usize) -> Option<DrawingView> {
    let obj = frame.objects.get(slot)?;
    let clip = scene.figure_for(slot)?.movieclip.as_ref()?;
    let parent_slot = obj.join?.slot as usize;
    let parent = JoinedParent { object: frame.objects.get(parent_slot)?, figure: scene.figure_for(parent_slot)?, geometry: scene.objects.get(parent_slot)? };
    let drawing = rotated_drawing(clip, obj, &parent)?;
    Some(DrawingView { frame: drawing.frame, angle: drawing.angle, scale: drawing.scale, flip: drawing.flip })
}

/// Builds the scene for an evaluated frame.
pub fn build(doc: &Document, frame: &Frame) -> Scene {
    build_filtered(doc, frame, None, Measure::Off, true, None)
}

/// [`build`] with every figure's [`ObjectGeometry::extent`]: what a follow camera samples.
pub fn build_measured(doc: &Document, frame: &Frame) -> Scene {
    build_filtered(doc, frame, None, Measure::Follow, true, None)
}

/// [`build_only`] with [`Scene::measured`]: what the app's `boundsOf` reads of the objects in
/// `slots`, for [`crate::drawlist::app_bounds`].
pub fn build_only_measured(doc: &Document, frame: &Frame, slots: &[usize]) -> Scene {
    build_only_with(doc, frame, slots, true, Measure::Bounds)
}

/// [`build_only`] with what the interface reads of each object (`Scene::measured` holds every segment
/// and polygon, drawn or not; `ObjectGeometry::angles` and `ObjectGeometry::solution`), for the objects in
/// `slots` (and the ones they are joined to), or all of them.
pub fn build_shapes(doc: &Document, frame: &Frame, slots: Option<&[usize]>) -> Scene {
    match slots {
        Some(slots) => build_only_with(doc, frame, slots, true, Measure::Shapes),
        None => build_filtered(doc, frame, None, Measure::Shapes, true, None),
    }
}

/// [`build_shapes` of every object](build_shapes), keeping what it builds in `memory` and taking from it what a previous
/// build of this document's frame built the same way.
pub fn build_remembering(doc: &Document, frame: &Frame, memory: &mut BuildMemory) -> Scene {
    build_filtered(doc, frame, None, Measure::Shapes, true, Some(memory))
}

/// [`build`] for the objects in `slots` and the objects they are joined to, the others
/// left unresolved: what an editing call reads of one figure's geometry, without the
/// whole frame's.
pub fn build_only(doc: &Document, frame: &Frame, slots: &[usize]) -> Scene {
    build_only_with(doc, frame, slots, true, Measure::Off)
}

/// [`build_only`] for a shape query: ordinary 2D objects retain their joints,
/// scaled lengths and raw segment curves, but omit colors and render primitives.
/// Polygon constraints still participate in the unchanged IK solvers. Any needed
/// rig, spatial pose, movieclip, mesh, surface or Stick Nodes shape uses the full builder.
/// The returned scene is query geometry; callers must not render it.
pub fn build_only_for_shape(doc: &Document, frame: &Frame, slots: &[usize]) -> Scene {
    build_only_with(doc, frame, slots, false, Measure::Off)
}

fn build_only_with(doc: &Document, frame: &Frame, slots: &[usize], render_output: bool, measure: Measure) -> Scene {
    let count = frame.objects.len();
    let mut needed = vec![false; count];
    for &slot in slots {
        let mut at = Some(slot);
        while let Some(i) = at.filter(|&i| i < count && !needed[i]) {
            needed[i] = true;
            at = frame.objects[i].join.map(|j| j.slot as usize);
        }
    }
    build_filtered(doc, frame, Some(&needed), measure, render_output, None)
}

fn build_filtered(doc: &Document, frame: &Frame, needed: Option<&[bool]>, measure: Measure, render_output: bool, mut memory: Option<&mut BuildMemory>) -> Scene {
    let count = frame.objects.len();
    if let Some(memory) = memory.as_deref_mut() {
        memory.begin(count, measure, doc.version);
    }
    let mut scene = Scene {
        objects: vec![ObjectGeometry::default(); count],
        camera: frame.camera,
        background: (frame.background, frame.background_b, frame.background_mix),
        background_color: frame.background_color,
        vfx: frame.vfx.clone(),
        ..Default::default()
    };
    // Figure table for items (styled instances resolve to their own figure).
    let mut figure_slot = std::collections::HashMap::new();
    let mut fig_of = vec![u32::MAX; count];
    for (i, o) in frame.objects.iter().enumerate() {
        let fig = match &o.figure_override {
            Some(f) => Some(f),
            None => doc.figure(o.figure),
        };
        if let Some(fig) = fig {
            let len = scene.figures.len() as u32;
            let s = *figure_slot.entry(Arc::as_ptr(fig) as usize).or_insert_with(|| {
                scene.figures.push(fig.clone());
                len
            });
            fig_of[i] = s;
        }
    }
    // The full path keeps all output needed by complex shape callers and their
    // ancestors. Inspect the already-resolved figure/pose, including style and
    // Stick Nodes overrides; never infer eligibility from the stored definition.
    let render_output = render_output || frame.objects.iter().enumerate().any(|(i, object)| {
        if needed.is_some_and(|needed| !needed[i]) {
            return false;
        }
        let Some(figure) = scene.figures.get(fig_of[i] as usize) else {
            // Preserve the full builder's existing missing-figure behavior.
            return true;
        };
        figure.plan.rig.is_some() || figure.plan.spatial || object.spatial.is_some()
            || figure.movieclip.is_some() || figure.mesh.is_some()
            || figure.polyfills.iter().any(|polygon| polygon.surface.is_some())
            || figure.segments.iter().any(|segment| crate::sticknodes::shape_for(segment, object).is_some())
    });
    let (level, order) = {
        let mut level = vec![u32::MAX; count];
        let mut order: Vec<Vec<usize>> = Vec::new();
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); count];
        let mut current: Vec<usize> = Vec::new();
        for (i, o) in frame.objects.iter().enumerate() {
            match o.join {
                Some(j) if (j.slot as usize) < count => children[j.slot as usize].push(i),
                _ => current.push(i),
            }
        }
        let mut depth = 0;
        while !current.is_empty() {
            let mut next = Vec::new();
            for &i in &current {
                level[i] = depth;
                next.extend(children[i].iter().copied());
            }
            order.push(std::mem::take(&mut current));
            current = next;
            depth += 1;
            if depth as usize > count {
                break;
            }
        }
        (level, order)
    };
    // IK across joined figures solves once per assembly, before its objects build (`solveJoinedIK`).
    let joined_ik = crate::ik::joined::solve(frame, &|slot| fig_of.get(slot).filter(|&&s| s != u32::MAX).map(|&s| &scene.figures[s as usize]));
    let mut built: Vec<Option<Arc<Built>>> = (0..count).map(|_| None).collect();
    // What the last build of this document kept of each object, and what this one builds anew.
    let previous = memory.as_deref().map(|memory| &memory.slots[..]);
    let mut anew: Vec<(usize, Kept)> = Vec::new();
    // Publication still follows draw order.
    for slots in order.iter().map(Vec::as_slice) {
        let filtered: Vec<usize>;
        let slots = match needed {
            Some(needed) => {
                filtered = slots.iter().copied().filter(|&i| needed[i]).collect();
                &filtered
            }
            _ => slots,
        };
        let resolve_root = |i: usize, built: &[Option<Arc<Built>>]| -> Option<[f64; 2]> {
            let o = &frame.objects[i];
            let mut root = [o.root[0], o.root[1]];
            if let Some(j) = o.join {
                let parent = built.get(j.slot as usize)?.as_ref()?;
                let pfig = doc.figure(frame.objects[j.slot as usize].figure)?;
                if let Some(p) = parent.geometry.joint(pfig, j.handle) {
                    root = p;
                }
            }
            Some(root)
        };
        let make = |&i: &usize| -> Option<(usize, Arc<Built>, Option<Kept>)> {
            let fig = &scene.figures[*fig_of.get(i)? as usize];
            let root = resolve_root(i, &built).unwrap_or(frame.objects[i].root);
            if let Some(clip) = &fig.movieclip {
                // An attached mesh, or drawings a bone turns, read the bone the instance is
                // joined to from its parent's geometry.
                let parent = frame.objects[i].join.filter(|_| clip.meshes.is_some() || clip.drawing_rotation.is_some()).and_then(|j| {
                    let geometry = &built.get(j.slot as usize)?.as_ref()?.geometry;
                    let figure = scene.figures.get(*fig_of.get(j.slot as usize)? as usize)?;
                    Some(JoinedParent { object: &frame.objects[j.slot as usize], figure, geometry })
                });
                // What an instance reads of its parent's geometry is not part of what a kept build is checked against.
                let remembered = previous.filter(|_| parent.is_none());
                if let Some(kept) = reuse(remembered, i, &frame.objects[i], fig, fig_of[i], root, None) {
                    return Some((i, kept, None));
                }
                let built = if let Some(meshes) = &clip.meshes {
                    build_clip_mesh(frame, i, fig_of[i], fig, clip, meshes, root, parent, measure)
                } else {
                    build_clip(frame, i, fig, clip, root, parent)
                };
                let built = Arc::new(built);
                // Kept whether or not it can be reused, so that the build is numbered: what reads the scene learns the instance changed.
                return Some((i, built.clone(), previous.map(|_| Kept::new(&frame.objects[i], fig, fig_of[i], root, None, built))));
            }
            // IK: a pinned object draws its derived pose, from its assembly or solved on its own (`evaluateIKPose`).
            let local;
            let ik = match joined_ik.get(&i) {
                Some(solution) => Some(solution),
                None => {
                    local = crate::ik::solve_local(fig, &frame.objects[i], root);
                    local.as_ref()
                }
            };
            if let Some(kept) = reuse(previous, i, &frame.objects[i], fig, fig_of[i], root, ik) {
                return Some((i, kept, None));
            }
            let built = Arc::new(build_object(doc, doc.version, frame, i, fig_of[i], fig, root, ik, measure, render_output));
            Some((i, built.clone(), previous.map(|_| Kept::new(&frame.objects[i], fig, fig_of[i], root, ik.cloned(), built))))
        };
        let results: Vec<(usize, Arc<Built>, Option<Kept>)> = crate::par::map(&slots, 32, make).into_iter().flatten().collect();
        for (i, b, fresh) in results {
            built[i] = Some(b);
            if let Some(fresh) = fresh {
                anew.push((i, fresh));
            }
        }
    }
    for (i, l) in level.iter().enumerate() {
        if *l == u32::MAX {
            scene.warnings.push(format!("Cyclic join or unresolved target at object {i}"));
        }
    }
    if let Some(memory) = memory {
        memory.finish(&built, anew);
        scene.built_in = (0..count).map(|slot| memory.built_in(slot)).collect();
    }
    // Splice in draw order.
    let total_items: usize = built.iter().flatten().map(|b| b.items.len()).sum();
    let total_points: usize = built.iter().flatten().map(|b| b.points.len()).sum();
    scene.items.reserve(total_items);
    scene.points.reserve(total_points);
    for &slot in &frame.draw_order {
        // Read in place: a build the memory also holds is shared, and only the parts the scene owns are copied.
        let Some(b) = built[slot as usize].as_deref() else { continue };
        let base = scene.points.len() as u32;
        scene.points.extend_from_slice(&b.points);
        let mut geometry = b.geometry.clone();
        for raw in &mut geometry.raw_segments {
            raw.points = (raw.points.0 + base, raw.points.1 + base);
        }
        // Movieclip content brings its own figures, owners and chains.
        let figure_map: Vec<u32> = b
            .figures
            .iter()
            .map(|f| {
                let key = Arc::as_ptr(f) as usize;
                let len = scene.figures.len() as u32;
                *figure_slot.entry(key).or_insert_with(|| {
                    scene.figures.push(f.clone());
                    len
                })
            })
            .collect();
        let owner_base = scene.owners.len() as u32;
        scene.owners.extend_from_slice(&b.owners);
        scene.owner_scales.extend_from_slice(&b.owner_scales);
        scene.clip_vfx.extend_from_slice(&b.clip_vfx);
        let chain_base = scene.chains.len() as u32;
        for c in &b.chains {
            scene.chains.push(c.iter().map(|&(o, p)| (o + owner_base, p)).collect());
        }
        let mesh_base = scene.meshes.len() as u32;
        scene.meshes.extend_from_slice(&b.meshes);
        let depth_base = scene.depths.len() as u32;
        scene.depths.extend_from_slice(&b.depths);
        let transition_base = scene.transitions.len() as u32;
        scene.transitions.extend_from_slice(&b.transitions);
        let export_vfx = frame.export_vfx.get(slot as usize).copied().unwrap_or_else(|| {
            // Editor-composed frames already carry sampled clips in their typed
            // pose scopes; no timeline sampling is needed here.
            let object = &frame.objects[slot as usize];
            let container = scene.figures[fig_of[slot as usize] as usize].movieclip.is_some();
            object.vfx.as_ref().is_some_and(|pose| {
                if container { crate::vfx::active(pose.figure()).next().is_some() }
                else { pose.entries.iter().any(|(_, stack)| crate::vfx::active(stack).next().is_some()) }
            }) || frame.vfx.as_ref().and_then(|vfx| vfx.object(slot)).is_some_and(|vfx| !vfx.figure.is_empty() || vfx.attached.is_some() || !vfx.segments.is_empty())
        });
        for it in &b.measured {
            let mut it = it.clone();
            it.points = (it.points.0 + base, it.points.1 + base);
            it.depth = (it.depth.0 + depth_base, it.depth.1 + depth_base);
            if it.mesh != NO_MESH {
                it.mesh += mesh_base;
            }
            scene.measured.push(it);
        }
        for it in &b.items {
            let mut it = it.clone();
            it.export_vfx |= export_vfx;
            it.points = (it.points.0 + base, it.points.1 + base);
            it.depth = (it.depth.0 + depth_base, it.depth.1 + depth_base);
            if it.mesh != NO_MESH {
                it.mesh += mesh_base;
            }
            if !figure_map.is_empty() {
                it.figure = figure_map[it.figure as usize];
            }
            if it.chain != NO_CHAIN {
                it.chain += chain_base;
            }
            if it.transition != NO_TRANSITION {
                it.transition += transition_base;
            }
            scene.items.push(it);
        }
        scene.objects[slot as usize] = geometry;
    }
    scene.figure_of = fig_of;
    scene.stamp = Stamp(STAMPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1);
    scene.account_buffers();
    scene
}
