//! Typed, immutable-by-default animation document.
//!
//! Every reader (PIV v4/v5, `.styk` containers) produces this one model. Shared
//! records are `Arc`s so that an edit clones only the keyframe/object it touches
//! (copy-on-write through `Arc::make_mut`), and so that evaluation threads can
//! read a document while the UI prepares the next revision.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
pub(crate) mod retained;

/// Pivot primitive codes (`segment.primitive_code`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Prim {
    Line = 0,
    Circle = 1,
    Image = 2,
    CircleFill = 3,
    CircleClear = 4,
    Text = 5,
    SquareLine = 6,
}

impl Prim {
    pub fn from_code(code: u8) -> Option<Prim> {
        Some(match code {
            0 => Prim::Line,
            1 => Prim::Circle,
            2 => Prim::Image,
            3 => Prim::CircleFill,
            4 => Prim::CircleClear,
            5 => Prim::Text,
            6 => Prim::SquareLine,
            _ => return None,
        })
    }
    pub fn is_circle(self) -> bool {
        matches!(self, Prim::Circle | Prim::CircleFill | Prim::CircleClear)
    }
    pub fn name(self) -> &'static str {
        match self {
            Prim::Line => "line",
            Prim::Circle => "circle",
            Prim::Image => "image",
            Prim::CircleFill => "circleFill",
            Prim::CircleClear => "circleClear",
            Prim::Text => "text",
            Prim::SquareLine => "squareLine",
        }
    }
}

/// Multi-stop gradient paint (`paint.mjs`), normalized at load time.
#[derive(Clone, Debug, PartialEq)]
pub struct Paint {
    pub kind: PaintKind,
    /// Degrees, for linear paints.
    pub angle: f64,
    pub stops: Vec<PaintStop>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaintKind {
    Solid,
    Linear,
    Radial,
    Angular,
    Diamond,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintStop {
    pub offset: f64,
    pub rgb: [u8; 3],
    pub opacity: f64,
}

#[derive(Clone, Debug)]
pub struct Segment {
    pub id: u32,
    pub parent: u32,
    pub length: f64,
    pub angle: f64,
    pub thickness: f64,
    pub bend: f64,
    pub prim: Prim,
    pub is_static: bool,
    /// `_stykControl.level === 'detail'`: a detail handle, hidden by default.
    pub control_detail: bool,
    pub rgb: [u8; 3],
    pub alpha: f64,
    pub secondary: Option<([u8; 3], u8)>,
    pub z: f64,
    pub visible: bool,
    /// Image/text table index (`extra_u16`).
    pub asset: u32,
    /// `extra_u8_a`: swap parent/tip endpoints.
    pub reverse: bool,
    /// `extra_u8_b`: mirror across the baseline.
    pub mirror: bool,
    pub paint: Option<Arc<Paint>>,
    /// Stick Nodes source shape, if this segment came from a Stick Nodes import.
    pub sticknodes_shape: Option<Arc<crate::sticknodes::Shape>>,
    pub name: Option<String>,
    /// Rig relationship (`_stykRig`).
    pub rig: Option<Arc<crate::rig::Rig>>,
    /// `_stykPoseChoice.hidden === 0`: a hidden expression of a spatial bone
    /// scales uniformly about its origin instead of stretching along its axis.
    pub choice_scale: bool,
}

#[derive(Clone, Debug)]
pub struct Polyfill {
    /// `polyfill_id` (or index + 1): the identity style overlays address.
    pub id: u32,
    /// Joint handle ids (segment ids, `0` = root) around the polygon.
    pub joints: Vec<u32>,
    pub rgb: [u8; 3],
    pub alpha: f64,
    pub z: f64,
    /// `_stykSurface`: a one-sided face with a reference triangle (docs/engine/spatial.md).
    pub surface: Option<Surface>,
}

/// A one-sided native fill (`_stykSurface`, src/pivot/surfaces.mjs).
#[derive(Clone, Debug, PartialEq)]
pub struct Surface {
    /// Origin, X and Y reference joints: their winding is the front.
    pub basis: [u32; 3],
    /// `side === 'back'`.
    pub back: bool,
    pub flipped: bool,
    /// Depth guide joints (empty when the face has none).
    pub depth: Vec<u32>,
    /// The face is drawn depth tested against its neighbours.
    pub depth_test: bool,
}

#[derive(Clone, Debug)]
pub struct Outline {
    pub width: f64,
    pub rgb: [u8; 3],
    pub alpha: f64,
}

#[derive(Clone, Debug)]
pub struct ImageAsset {
    pub index: u32,
    pub anchor_start: [f64; 2],
    pub anchor_end: [f64; 2],
    pub anchor_length: f64,
    pub anchor_angle: f64,
    /// Displayed size in figure units (decoded pixel size unless overridden).
    pub display_size: Option<[f64; 2]>,
    /// The asset's own `width` and `height`, when it records them (a Stick Nodes
    /// sprite is sized from them).
    pub size: Option<[f64; 2]>,
    /// Index into `Document::images`.
    pub image: Option<u32>,
    /// Smooth sampling (authored drawings); Pivot sprites sample nearest.
    pub smooth: bool,
    /// Drawing cel tiles, placed in the cel's pixel space at `drawing_anchor`.
    pub tiles: Option<Arc<DrawingTiles>>,
    /// The drawing cel this asset belongs to (`_styk.drawing.celId`), whose pixels the
    /// interface may hold live ([`crate::live`]) before they are published as tiles.
    pub cel: Option<CelRef>,
}

/// A drawing cel by identity.
#[derive(Clone, Debug)]
pub struct CelRef {
    pub id: Arc<str>,
    /// Where the cel's pixel (0, 0) sits in the figure's asset space (`drawing_anchor`).
    pub anchor: [f64; 2],
}

#[derive(Clone, Debug)]
pub struct DrawingTiles {
    pub anchor: [f64; 2],
    pub pixels_per_unit: f64,
    /// Published tight ink bounds in cel pixels (`_styk.drawing.bounds`).
    /// They anchor effect rasters; whole-tile coverage only places drawing quads.
    pub bounds: Option<[f64; 4]>,
    /// Tight bounds resolved by the existing background PNG decode. No pixel cache
    /// and no document mutation: a loaded store's nonempty bounds supersede metadata.
    pub decoded_bounds: OnceLock<Option<[f64; 4]>>,
    /// Level-0 tiles: `(tx, ty, PNG bytes)` in tile coordinates (64 cel pixels per tile).
    pub tiles: Vec<(i32, i32, Arc<[u8]>)>,
    /// The tiles drawn at each display level 0–8 ([`crate::drawing::level_tiles`]).
    pub levels: Vec<Vec<(i32, i32)>>,
}

impl DrawingTiles {
    /// `presenter.store.bounds ?? drawingPixelBounds(figure)` in the editor.
    pub fn artwork_bounds(&self) -> Option<[f64; 4]> {
        self.decoded_bounds.get().copied().flatten().or(self.bounds)
    }
}

#[derive(Clone, Debug)]
pub struct Glyph {
    /// Path commands in glyph space.
    pub path: Vec<PathCmd>,
    /// The glyph's stored bounds (`glyph.bounds`: left, top, right, bottom), which size
    /// the editor's glyph masks; `None` without them or without a path, which the
    /// editor then draws from the object's raster.
    pub bounds: Option<[f64; 4]>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathCmd {
    Move(f32, f32),
    Line(f32, f32),
    Cubic(f32, f32, f32, f32, f32, f32),
    Close,
}

#[derive(Clone, Debug)]
pub struct TextAsset {
    pub index: u32,
    /// Unique glyph outlines in glyph space.
    pub glyphs: Vec<Arc<Glyph>>,
    /// Visible characters: glyph index and its offset from the text's lower-left corner.
    pub placements: Vec<(u32, f32, f32)>,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default)]
pub struct FigurePlan {
    /// Parent segment index per segment (`u32::MAX` = attached to root).
    pub parent: Vec<u32>,
    /// Topological (breadth first) evaluation order.
    pub order: Vec<u32>,
    pub index_of: HashMap<u32, u32>,
    /// Children lists flattened: `children[child_start[i]..child_start[i+1]]`.
    pub child_start: Vec<u32>,
    pub children: Vec<u32>,
    /// Per polygon: the edges joining consecutive handles.
    pub polygons: Vec<PolygonPlan>,
    /// Rig evaluation plan when any segment has a rig relationship.
    pub rig: Option<Arc<crate::rig::RigPlan>>,
    /// A joint carries depth (a spatial bone or skin point, or a weighted joint
    /// with a depth): geometry keeps what surfaces and meshes read from it.
    pub spatial: bool,
}

#[derive(Clone, Debug, Default)]
pub struct PolygonPlan {
    pub first: Option<u32>,
    pub edges: Vec<PolygonEdge>,
}

#[derive(Clone, Copy, Debug)]
pub struct PolygonEdge {
    /// Segment index of the edge, or `u32::MAX` when the handles are not adjacent.
    pub index: u32,
    pub reverse: bool,
    /// Handle id the edge ends at.
    pub end: u32,
}

#[derive(Clone, Debug)]
pub struct Figure {
    pub id: u32,
    pub name: String,
    pub segments: Vec<Segment>,
    pub polyfills: Vec<Polyfill>,
    pub images: Vec<ImageAsset>,
    pub texts: Vec<TextAsset>,
    pub outline: Option<Outline>,
    /// `_styk.colorMode === 'segments'`.
    pub segment_colors: bool,
    pub is_drawing: bool,
    pub movieclip: Option<Arc<Movieclip>>,
    /// `_styk.spatialMesh`, compiled against this figure's joints ([`crate::spatial`]).
    pub mesh: Option<Arc<crate::spatial::MeshPlan>>,
    /// `_styk.animationOrigin`: the pivot and joint basis its animation keeps after Set
    /// Origin re-rooted its construction ([`crate::origin`]).
    pub origin: Option<Arc<crate::origin::Origin>>,
    /// The mesh palette as this figure draws it (an instance's `meshColors` replace entries).
    pub mesh_colors: Arc<[[u8; 3]]>,
    pub plan: FigurePlan,
    /// For a figure resolved from an instance's style overlay: the definition it was resolved from.
    pub base: Option<Arc<Figure>>,
}

impl Figure {
    pub fn image(&self, index: u32) -> Option<&ImageAsset> {
        self.images.iter().find(|a| a.index == index)
    }
    pub fn text(&self, index: u32) -> Option<&TextAsset> {
        self.texts.iter().find(|a| a.index == index)
    }
}

pub struct Movieclip {
    pub duration: f64,
    pub source_start: f64,
    pub pivot: [f64; 2],
    pub document: Arc<Document>,
    /// `spatialMeshes`: one indexed mesh per local frame, drawn in place of the
    /// clip's own document ([`crate::spatial::ClipMesh`]).
    pub meshes: Option<Arc<[Arc<crate::spatial::ClipMesh>]>>,
    /// `drawingSets`: named groups of single frames (forms), each a list of views'
    /// frames ([`crate::geometry`]'s rotated drawings).
    pub drawing_sets: Vec<Vec<f64>>,
    /// `drawingRotation`: joined to a spatial bone, the clip shows the view its turn
    /// and tilt select (`steps` directions at three tilts).
    pub drawing_rotation: Option<DrawingRotation>,
    /// The clip's own timeline, prepared once.
    pub prepared: Arc<crate::eval::Prepared>,
    /// Evaluated local frames shared by every instance, bounded by entry count
    /// and retained derived-buffer bytes, also reserving from the nested
    /// document's shared lineage budget. Authored resources are separate.
    pub cache: std::sync::Mutex<crate::geometry::ClipSceneCache>,
}

/// `drawingRotation` of a movieclip (src/movieclip-drawings.mjs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawingRotation {
    pub steps: u32,
    /// The tilt past which the up or down views show, in radians.
    pub tilt_threshold: f64,
}

impl std::fmt::Debug for Movieclip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Movieclip").field("duration", &self.duration).field("pivot", &self.pivot).finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Join {
    pub slot: u32,
    pub handle: u32,
}

#[derive(Clone, Debug)]
pub struct Object {
    pub uid: u32,
    pub figure: u32,
    pub root: [f64; 2],
    pub scale: f64,
    pub color: u32,
    /// Native transparency byte (0 opaque .. 255 invisible); fractional while tweening.
    pub transparency: f64,
    pub image_text_flags: bool,
    pub angles: Arc<[f64]>,
    pub lengths: Option<Arc<[f64]>>,
    pub bends: Option<Arc<[f64]>>,
    pub join: Option<Join>,
    pub movieclip: Option<Arc<MovieclipPlayback>>,
    /// Local clip time chosen by evaluation (`_movieclipSample`).
    pub clip_time: Option<f64>,
    pub z_index: f64,
    /// Per-instance Stick Nodes shapes by segment id (`_sticknodesShapes`).
    pub sticknodes_shapes: Option<Arc<HashMap<u32, Arc<crate::sticknodes::Shape>>>>,
    /// Per-instance style overlay and the figure it resolves to.
    pub style: Option<Arc<crate::style::ObjectStyle>>,
    pub figure_override: Option<Arc<Figure>>,
    /// Inverse-kinematics controllers of this pose (`_stykIK`), see [`crate::ik`].
    pub ik: Option<Arc<crate::ik::Table>>,
    /// Per-pose effect stacks of the figure and its nodes (`_stykVfx`), see [`crate::vfx`].
    pub vfx: Option<Arc<crate::vfx::Stacks>>,
    /// `_stykVfxScope === 1`: the figure's own stack covers its attached figures.
    pub vfx_scope: bool,
    /// `_vfxConnectedEffects`: the stack of the connected group this object owns,
    /// as the editor composed it with its clips. Only edit frames carry it
    /// ([`crate::vfx::frame::composed`]); documents never save it.
    pub vfx_connected: Option<Arc<[Arc<crate::vfx::Effect>]>>,
    /// Perspective and part proportions of a 3D pose (`_stykSpatial`).
    pub spatial: Option<Arc<SpatialPose>>,
    /// `color_transition`: the object's colours part way between two overrides, in place
    /// of its own override ([`crate::geometry::object_rgb`]).
    pub color_transition: Option<Arc<ColorTransition>>,
    /// `_sticknodesSprite`: how an imported Stick Nodes sprite stretches and pivots its
    /// picture, applied to the figure the object resolves to ([`crate::sticknodes::sprite_figure`]).
    pub sticknodes_sprite: Option<Arc<crate::sticknodes::Sprite>>,
    /// `_stykAnimationOrigin`: where the animation pivot of a figure with an origin is.
    pub origin: Option<Arc<crate::origin::PoseOrigin>>,
}

/// `color_transition` of a pose (`objectColor` of the recorded editor): each colour is
/// mixed with both overrides and taken `t` of the way from the first to the second.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorTransition {
    /// ARGB overrides, as `color_override_raw`.
    pub from: u32,
    pub to: u32,
    pub t: f64,
}

/// `_stykSpatial` (src/spatial-projection.mjs): what a pose adds to a spatial rig.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpatialPose {
    pub camera: Option<SpatialCamera>,
    /// Width and taper by bone handle. Integer keys iterate in ascending order
    /// in JavaScript, which is the order a `BTreeMap` keeps.
    pub shape: Option<std::collections::BTreeMap<u32, SpatialShape>>,
}

/// `_stykSpatial.camera`: perspective of one figure. A missing centre is the figure's root.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialCamera {
    pub strength: f64,
    pub distance: f64,
    pub center: [Option<f64>; 2],
}

/// `_stykSpatial.shape[handle]`: radial width and its taper along the bone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialShape {
    pub width: f64,
    pub taper: f64,
}

/// `_stykMovieclip` playback settings of one instance.
#[derive(Clone, Debug, PartialEq)]
pub struct MovieclipPlayback {
    pub start: f64,
    pub end: Option<f64>,
    pub offset: f64,
    pub speed: f64,
    pub mode: MovieclipMode,
    pub presence: bool,
    /// Restart keys: (tick, offset).
    pub restarts: Vec<(f64, f64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MovieclipMode {
    Loop,
    Once,
    Hold,
    Single,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub angle: f64,
    pub is_default: bool,
    /// `_parallaxMotionOffset`: the screen impulse a camera-motion bake folded into
    /// this camera, which parallax layers do not follow ([`crate::parallax`]).
    pub motion_offset: Option<[f64; 2]>,
}

impl Default for Camera {
    fn default() -> Self {
        Camera { x: 0.0, y: 0.0, scale: 1.0, angle: 0.0, is_default: true, motion_offset: None }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EasingMode {
    Auto,
    Bezier,
    EaseIn,
    EaseOut,
    Linear,
    Constant,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Easing {
    pub mode: EasingMode,
    pub bezier: [f64; 4],
}

impl Easing {
    pub const LINEAR: Easing = Easing { mode: EasingMode::Linear, bezier: [0.42, 0.0, 0.58, 1.0] };
}

#[derive(Clone, Debug)]
pub struct Keyframe {
    pub duration: u32,
    /// `_vfxTimelineTick` retained by a captured pose/template, when present.
    pub retained_vfx_tick: Option<f64>,
    pub objects: Vec<Arc<Object>>,
    /// Back-to-front slots. Always a permutation of `objects`.
    pub draw_order: Vec<u32>,
    pub camera: Option<Camera>,
    pub background: u32,
    pub background_b: u32,
    pub background_mix: f64,
    pub easing: Option<Easing>,
    /// `_styk.frameId` (pose source identity).
    pub frame_id: Option<Arc<str>>,
    /// Object slot by unique id.
    pub slot_of: HashMap<u32, u32>,
    /// Presence-clock movieclips carried by this pose without an instance.
    pub continuations: Vec<(u32, Arc<MovieclipPlayback>)>,
    /// Scene colour key (`_stykBackgroundColor`, ARGB) replacing the native fill.
    pub background_color: Option<u32>,
    /// The scene's per-pose effect stack (`_stykVfx` of the frame), see [`crate::vfx`].
    pub vfx: Option<Arc<crate::vfx::Stacks>>,
}

impl Keyframe {
    pub fn object(&self, uid: u32) -> Option<&Arc<Object>> {
        self.slot_of.get(&uid).map(|&s| &self.objects[s as usize])
    }
    pub fn reindex(&mut self) {
        self.slot_of = self.objects.iter().enumerate().map(|(i, o)| (o.uid, i as u32)).collect();
    }
}

#[derive(Clone, Debug)]
pub enum BackgroundKind {
    Image { image: Option<u32> },
    Solid { argb: u32 },
    Linear { a: u32, b: u32, x1: f64, y1: f64, x2: f64, y2: f64 },
    Radial { a: u32, b: u32, x1: f64, y1: f64, x2: f64, y2: f64 },
    Paint(Arc<Paint>),
}

#[derive(Clone, Debug)]
pub struct Background {
    pub id: u32,
    pub kind: BackgroundKind,
}

/// Encoded image bytes (PNG/JPEG/BMP/GIF). Decoding happens on worker threads.
#[derive(Clone, Debug)]
pub struct ImageData {
    pub bytes: Arc<[u8]>,
    /// Pivot 4 bitmap sprites key out one colour.
    pub color_key: Option<[u8; 3]>,
}

/// StykAnimate layer exposure sheet (`_styk.layerSheet`).
#[derive(Clone, Debug)]
pub struct LayerSheet {
    pub duration: u32,
    /// Tracks by layer id ("scene", "camera", "layer-N").
    pub tracks: HashMap<String, Arc<SheetTrack>>,
}

#[derive(Clone, Debug)]
pub struct SheetTrack {
    pub end: u32,
    pub keys: Vec<SheetKey>,
}

#[derive(Clone, Debug)]
pub struct SheetKey {
    pub tick: u32,
    pub easing: Option<Easing>,
    pub hidden: bool,
    pub patch_only: bool,
    pub value: SheetValue,
    pub movieclip_patches: Vec<MovieclipPatch>,
}

#[derive(Clone, Debug)]
pub enum SheetValue {
    /// A pose from `frameSources` / keyframes by frame id; `None` = empty cell.
    Frame(Option<Arc<str>>),
    /// Imported span: sample the legacy timeline at this source tick.
    SourceTick(f64),
}

#[derive(Clone, Debug)]
pub struct MovieclipPatch {
    pub uid: u32,
    pub frame_id: Arc<str>,
    pub replacement_uid: Option<u32>,
    pub order_index: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct Layers {
    pub order: Vec<String>,
    pub assignments: HashMap<u32, String>,
    pub default_layer: String,
    pub hidden: Vec<String>,
    pub camera_visible: bool,
    pub scene_visible: bool,
    /// The layers with parallax on (`byId[id].parallax.enabled`), in `order`.
    pub parallax: Vec<(String, LayerParallax)>,
}

/// `byId[id].parallax` of a layer whose parallax is on (src/layer-parallax.mjs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerParallax {
    /// How much of the camera's travel the layer follows on each axis (1 = all of it).
    pub x: f64,
    pub y: f64,
    /// The camera position at which the layer sits where it was drawn.
    pub reference: [f64; 2],
}

impl Layers {
    pub fn layer_of(&self, uid: u32) -> &str {
        self.assignments.get(&uid).map(String::as_str).unwrap_or(&self.default_layer)
    }
}

/// An immutable crop baseline; local keys map their output intervals into this source.
#[derive(Clone, Debug)]
pub struct MovieclipSource {
    pub document: Arc<Document>,
    pub ticks: Vec<Option<f64>>,
}

#[derive(Clone, Debug, Default)]
pub struct Document {
    /// The lineage's aggregate budget for derived scenes retained by movieclip
    /// caches. Root and nested typed documents of one Loader share this token,
    /// including revisions and cloned loaders with the same typed resources.
    /// Authored payloads and caller-held transient scenes are separate.
    pub scene_budget: Arc<crate::geometry::SceneBudget>,
    pub name: String,
    pub version: u32,
    pub canvas: [u32; 2],
    pub fps: f64,
    pub auto_easing: bool,
    pub figures: Vec<Arc<Figure>>,
    pub figure_index: HashMap<u32, u32>,
    pub keyframes: Vec<Arc<Keyframe>>,
    pub backgrounds: Vec<Background>,
    pub images: Vec<ImageData>,
    pub layers: Option<Arc<Layers>>,
    pub sheet: Option<Arc<LayerSheet>>,
    pub frame_sources: HashMap<Arc<str>, Arc<Keyframe>>,
    pub camera_motion: Vec<CameraMotionClip>,
    /// Effect clips (`_styk.vfxClips`), see [`crate::vfx`]; `None` when there are none.
    pub vfx_clips: Option<Arc<crate::vfx::Clips>>,
    /// Effects saved outside poses and clips (property channels of effects, which
    /// [`Document::animation`] evaluates; clips of a captured movieclip's source, which
    /// nothing reads), for [`crate::vfx::document_has_vfx`].
    pub vfx_elsewhere: bool,
    /// The property channels the native timeline is evaluated with ([`crate::channels`]):
    /// `_styk.animation`, or a layer sheet's `legacyAnimation`, which its imported keys
    /// sample. `None` when there is no channel.
    pub animation: Option<Arc<crate::channels::Animation>>,
    /// Non-fatal notes from loading.
    pub notes: Vec<String>,
    /// A figure has an animation origin ([`crate::origin`]): native intervals correct roots.
    pub origins: bool,
    /// `_styk.movieclipSource`: exact source curves of a cropped movieclip.
    pub movieclip_source: Option<Arc<MovieclipSource>>,
}

#[derive(Clone, Debug)]
pub struct CameraMotionClip {
    pub kind: String,
    pub start: f64,
    pub duration: f64,
    pub enabled: bool,
    pub muted: Vec<(f64, f64)>,
    pub params: HashMap<String, f64>,
    /// A follow clip's figures and their weights ([`crate::follow`]).
    pub targets: Vec<(u32, f64)>,
}

impl Document {
    pub fn figure(&self, id: u32) -> Option<&Arc<Figure>> {
        self.figure_index.get(&id).map(|&i| &self.figures[i as usize])
    }

    pub fn pose_source(&self, id: &str) -> Option<&Arc<Keyframe>> {
        if let Some(frame) = self.frame_sources.get(id) {
            return Some(frame);
        }
        self.keyframes.iter().find(|k| k.frame_id.as_deref() == Some(id))
    }

    pub fn reindex_figures(&mut self) {
        self.figure_index = self.figures.iter().enumerate().map(|(i, f)| (f.id, i as u32)).collect();
    }

    pub fn segment_count(&self) -> usize {
        self.figures.iter().map(|f| f.segments.len()).sum()
    }
}

/// Builds the parent/children/topological plan of a figure.
pub fn plan_figure(segments: &[Segment], polyfills: &[Polyfill]) -> FigurePlan {
    let n = segments.len();
    let index_of: HashMap<u32, u32> = segments.iter().enumerate().map(|(i, s)| (s.id, i as u32)).collect();
    let parent: Vec<u32> = segments.iter().map(|s| *index_of.get(&s.parent).unwrap_or(&u32::MAX)).collect();
    let mut counts = vec![0u32; n + 1];
    for &p in &parent {
        if p != u32::MAX {
            counts[p as usize] += 1;
        }
    }
    let mut child_start = vec![0u32; n + 1];
    for i in 0..n {
        child_start[i + 1] = child_start[i] + counts[i];
    }
    let mut fill = child_start.clone();
    let mut children = vec![0u32; child_start[n] as usize];
    for (i, &p) in parent.iter().enumerate() {
        if p != u32::MAX {
            children[fill[p as usize] as usize] = i as u32;
            fill[p as usize] += 1;
        }
    }
    // Breadth-first from root-attached segments, in record order (same as the JS `ready` queue).
    let mut order: Vec<u32> = (0..n as u32).filter(|&i| parent[i as usize] == u32::MAX).collect();
    let mut q = 0;
    while q < order.len() {
        let i = order[q] as usize;
        for &c in &children[child_start[i] as usize..child_start[i + 1] as usize] {
            order.push(c);
        }
        q += 1;
    }
    // Polygon edges between consecutive handles: the segment whose (parent, id)
    // pair matches, walked forward or in reverse. Like geometry-definition.mjs,
    // only reachable segments count and the last duplicate edge wins.
    let mut edge_of: HashMap<(u32, u32), u32> = HashMap::with_capacity(n);
    for &i in &order {
        let s = &segments[i as usize];
        edge_of.insert((s.parent, s.id), i);
    }
    let polygons = polyfills
        .iter()
        .map(|poly| {
            let ids = &poly.joints;
            let mut plan = PolygonPlan { first: ids.first().copied(), edges: Vec::with_capacity(ids.len()) };
            for j in 0..ids.len() {
                let a = ids[j];
                let b = ids[(j + 1) % ids.len()];
                let (index, reverse) = match edge_of.get(&(a, b)) {
                    Some(&i) => (i, false),
                    None => (edge_of.get(&(b, a)).copied().unwrap_or(u32::MAX), true),
                };
                plan.edges.push(PolygonEdge { index, reverse, end: b });
            }
            plan
        })
        .collect();
    let rig = crate::rig::plan(segments, &index_of).map(Arc::new);
    let spatial = segments.iter().any(|s| s.rig.as_ref().is_some_and(|r| r.spatial.is_some() || r.weighted.as_ref().is_some_and(|w| w.depth.is_some())));
    FigurePlan { parent, order, index_of, child_start, children, polygons, rig, spatial }
}
