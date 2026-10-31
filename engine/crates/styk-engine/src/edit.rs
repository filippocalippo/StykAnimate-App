//! The frame the editor is showing while it edits.
//!
//! Editing commands run in the engine's session, which shows the frame it is
//! editing, typed and built ([`EditScene::update_shown`]): the stage draws it as it
//! is. The one frame the session cannot show is the interface's own (a first
//! stroke on a blank exposure, whose cel the document does not hold yet): it
//! crosses as poses, only the objects that changed since the last frame. The
//! document's frames are not involved, so a gesture never waits for a commit.
//!
//! Onion skins are other poses of the document, kept by an id the caller chooses
//! (the tick they sample), with their geometry built once and reused while the
//! ghost does not change.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::Value;
use styk_eval::drawlist::{DrawList, EncodeMemory, Ghost, Overrides, encode_composed_remembering};
use styk_eval::eval::Frame;
use styk_eval::geometry::{BuildMemory, Scene, build_remembering_plain};
use styk_eval::load::Loader;
use styk_eval::onion::{GhostPlace, compose};
use styk_eval::vfx::generated::Batch;

use crate::Generation;

/// Ghost poses kept at most. The caller names the ones it shows each frame;
/// the least recently shown are dropped beyond this.
const MAX_GHOSTS: usize = 48;

#[derive(Clone)]
struct Pose {
    // Snapshots used by auxiliary views share the pose and its built geometry. Creating
    // one on the interface thread must not copy every object of a dense frame.
    frame: Arc<Frame>,
    /// Geometry of `frame`, built when first drawn.
    scene: Option<Arc<Scene>>,
    /// The draw counter when this pose was last shown.
    used: u64,
    /// `_cameraMotionTick`: the frame's time on the camera-motion clips, when it has any.
    motion_tick: Option<f64>,
    /// What the scene camera does to `frame`, for the generation it was worked out for.
    shot: Option<(u64, Shot)>,
    /// The effects timeline's tick the editor composed the pose at (`_vfxTimelineTick`).
    vfx_tick: Option<f64>,
    /// Its generated effects, built when first drawn (again while incomplete).
    generators: Option<Arc<Batch>>,
    /// The record it was made from, when the pose came as a record ([`EditScene::update_shown`]): the next one is
    /// read as its difference.
    record: Option<Value>,
    /// The views of the document the pose was converted against (a ghost's, to share its unchanged objects with the pose that replaces it).
    prepared: Option<Arc<styk_eval::eval::Prepared>>,
    /// What the pose's scene was built of, for the build after the document is published anew.
    memory: BuildMemory,
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    #[test]
    fn a_snapshot_shares_the_dense_pose_and_geometry_instead_of_cloning_them() {
        let mut source = EditScene { current: Some(Pose::new(Frame::default(), 3, Times::default())), lineage: 4, generation: 5, ..Default::default() };
        source.current.as_mut().unwrap().scene = Some(Arc::new(Scene::default()));
        let snapshot = source.snapshot();
        let original = source.current.as_ref().unwrap();
        let captured = snapshot.current.as_ref().unwrap();
        assert!(Arc::ptr_eq(&original.frame, &captured.frame));
        assert!(Arc::ptr_eq(original.scene.as_ref().unwrap(), captured.scene.as_ref().unwrap()));
        assert!(snapshot.ghosts.is_empty());
        assert_eq!((snapshot.lineage, snapshot.generation), (4, 5));
    }
}

/// How the effects of a pose are resolved when it is read.
#[derive(Clone, Copy, PartialEq)]
enum Effects {
    /// The pose holds the effects the editor composed into it (clips included).
    Composed,
    /// A ghost draws no effects.
    None,
}

/// The scene camera of a frame shown through it.
#[derive(Clone)]
struct Shot {
    /// `cameraAtTime`: the authored camera, follow clips and camera-motion impulses.
    camera: Option<styk_eval::doc::Camera>,
    /// How far parallax layers move each object (`parallaxResolver`).
    parallax: Option<Arc<styk_eval::parallax::Parallax>>,
}

/// The times an edit frame carries besides its pose.
#[derive(Clone, Copy, Default)]
struct Times {
    /// `_vfxTimelineTick`.
    vfx: Option<f64>,
    /// `_cameraMotionTick`.
    motion: Option<f64>,
}

impl Pose {
    fn new(frame: Frame, used: u64, times: Times) -> Pose {
        Pose::shared(Arc::new(frame), used, times)
    }

    fn shared(frame: Arc<Frame>, used: u64, times: Times) -> Pose {
        Pose { frame, scene: None, used, motion_tick: times.motion, shot: None, vfx_tick: times.vfx, generators: None, record: None, prepared: None, memory: BuildMemory::default() }
    }

    /// What the scene camera does to this pose, worked out once per document generation
    /// (follow paths are the generation's).
    fn shot(&mut self, generation: &Generation, prepare: bool) -> Option<Shot> {
        if let Some((id, shot)) = &self.shot
            && *id == generation.id
        {
            return Some(shot.clone());
        }
        let prepared = &generation.prepared;
        let doc = &prepared.doc;
        let authored = self.frame.camera;
        let (travel, camera) = match self.motion_tick {
            Some(tick) if !doc.camera_motion.is_empty() => {
                let travel = if prepare { prepared.travel(authored, tick) } else { prepared.travel_ready(authored, tick)? };
                (travel, styk_eval::camera::at_time(travel, &doc.camera_motion, tick, doc.fps))
            }
            _ => (authored, authored),
        };
        let shot = Shot { camera, parallax: styk_eval::parallax::resolve(doc, &self.frame, travel.as_ref()) };
        self.shot = Some((generation.id, shot.clone()));
        Some(shot)
    }
}

/// An edit frame, its onion skins, and what was last built from them. Owned by the thread that draws.
#[derive(Default)]
pub struct EditScene {
    loader: Option<Loader>,
    current: Option<Pose>,
    ghosts: HashMap<u32, Pose>,
    /// The document lineage and generation the kept poses and geometry belong to.
    lineage: u64,
    generation: u64,
    draws: u64,
    /// The last frame's generated effects used the current pose for some trails: draw again.
    refining: bool,
    /// The displayed pose needs a worker to warm its shared follow-camera path.
    camera_pending: Option<f64>,
    /// What the last frame was encoded as, for the objects the next frame keeps.
    encoded: EncodeMemory,
}

/// One onion skin of a frame.
#[derive(Clone, Debug)]
pub struct Onion<'a> {
    /// The id its pose was given in [`EditScene::update_ghost`].
    pub id: u32,
    pub opacity: f64,
    pub tint: Option<[u8; 3]>,
    pub show_on_top: bool,
    /// Slots of the ghost that are not drawn.
    pub hidden: &'a [u32],
}

/// The editor's session state for one frame.
#[derive(Clone, Debug, Default)]
pub struct EditOptions<'a> {
    /// Slots not drawn.
    pub hidden: &'a [u32],
    /// `(slot, [dx, dy])` of dragged objects.
    pub translations: &'a [(u32, [f64; 2])],
    /// ARGB canvas colour replacing the scene background.
    pub background: Option<u32>,
    /// Onion skins, far to near.
    pub onions: &'a [Onion<'a>],
    /// Draw without effects (the editor's effects preview is off).
    pub bypass_effects: bool,
    /// The frame is shown through the scene camera (playback preview), which moves parallax layers.
    pub camera: bool,
    /// Worker/offline callers may prepare a cold camera path. Interface callers
    /// read only already-published follow paths and receive `None` while cold.
    pub prepare_camera: bool,
    /// The host's clock and how long a frame may evaluate generated effects' earlier
    /// anchors (the editor's 6 ms); without a clock, all of them are evaluated.
    pub clock: Option<crate::Clock>,
    pub anchor_budget_ms: f64,
    /// Drawing cels the interface holds live ([`styk_eval::live`]), drawn in place of their published tiles.
    pub live: Option<&'a styk_eval::live::LiveCels>,
}

/// A clock for hosts that give none: anchors are then always evaluated.
fn no_clock() -> f64 {
    0.0
}

fn flags(slots: &[u32], count: usize) -> Vec<bool> {
    let mut hidden = vec![false; count];
    for &slot in slots {
        if let Some(flag) = hidden.get_mut(slot as usize) {
            *flag = true;
        }
    }
    hidden
}

impl EditScene {
    /// A read-only snapshot of the displayed pose for an auxiliary worker. The frame,
    /// geometry and generated batches are shared; ghosts and parsing caches are not copied.
    /// The worker builds camera/parallax geometry and draw lists, never the interface.
    pub fn snapshot(&self) -> EditScene {
        EditScene { loader: Some(Loader::new()), current: self.current.clone(), lineage: self.lineage, generation: self.generation, draws: self.draws, ..Default::default() }
    }
    /// Starts over when the document is another project; drops built geometry when its definitions changed.
    fn follow(&mut self, generation: &Generation) {
        if self.lineage != generation.lineage || self.loader.is_none() {
            self.loader = Some(Loader::new());
            self.current = None;
            self.ghosts.clear();
            self.encoded = EncodeMemory::default();
            self.lineage = generation.lineage;
        }
        if self.generation != generation.id {
            // Figures may have changed: geometry is rebuilt from the kept poses.
            self.generation = generation.id;
            if let Some(pose) = &mut self.current {
                pose.scene = None;
                pose.generators = None;
            }
            for pose in self.ghosts.values_mut() {
                pose.scene = None;
            }
        }
    }

    /// Reads a pose and the times it carries. Its effects are the ones the editor composed
    /// into it (clips included), never sampled again here: see `docs/engine/vfx.md`.
    fn parse(&mut self, generation: &Generation, text: &[u8], previous: Option<&Frame>) -> Result<(Frame, Times), String> {
        let value: Value = styk_doc::json::parse(text).map_err(|e| e.to_string())?;
        self.convert(generation, &value, previous, Effects::Composed)
    }

    /// [`EditScene::parse`] of a pose already read. A pose the interface composed holds its effect clips already.
    fn convert(&mut self, generation: &Generation, value: &Value, previous: Option<&Frame>, effects: Effects) -> Result<(Frame, Times), String> {
        let times = Times { vfx: value.get("_vfxTimelineTick").and_then(Value::as_f64), motion: value.get("_cameraMotionTick").and_then(Value::as_f64) };
        let loader = self.loader.as_mut().expect("follow() ran");
        let doc = &generation.prepared.doc;
        let mut frame = loader.edit_frame(value, previous, doc).map_err(|e| e.to_string())?;
        let fields = frame.pose_vfx.is_some() || frame.objects.iter().any(|o| o.vfx.is_some() || o.vfx_connected.is_some());
        if (fields || generation.prepared.has_vfx) && effects != Effects::None {
            frame.vfx = styk_eval::vfx::frame::composed(doc, &frame);
        }
        Ok((frame, times))
    }

    /// Replaces the frame. `text` is a keyframe-shaped JSON record whose `objects`
    /// entries are poses or `null` for "unchanged since the last call".
    pub fn update(&mut self, generation: &Generation, text: &[u8]) -> Result<(), String> {
        self.follow(generation);
        let previous = self.current.take();
        let (frame, times) = self.parse(generation, text, previous.as_ref().map(|pose| pose.frame.as_ref()))?;
        self.current = Some(Pose::new(frame, self.draws, times));
        Ok(())
    }

    /// Replaces the frame with the one the engine's own session shows, typed and built (`styk_edit::Editor::shown_scene`): nothing is
    /// converted or built here. `false` when the session's document is not the one `generation` holds (the session publishes after a
    /// change, and the frame is taken once that has landed).
    pub fn update_shown(&mut self, generation: &Generation, shown: &styk_edit::ShownScene) -> bool {
        if !Arc::ptr_eq(&shown.prepared, &generation.prepared) {
            return false;
        }
        self.follow(generation);
        let times = Times { vfx: shown.times.0, motion: shown.times.1 };
        let mut pose = Pose::shared(shown.frame.clone(), self.draws, times);
        pose.scene = Some(shown.scene.clone());
        self.current = Some(pose);
        true
    }

    /// Replaces the pose of ghost `id` with a frame the engine's session evaluated (it draws no effects).
    pub fn update_ghost(&mut self, generation: &Generation, id: u32, record: &Value) -> Result<(), String> {
        self.follow(generation);
        let old = self.ghosts.remove(&id);
        let (mut frame, times) = self.convert(generation, record, None, Effects::None)?;
        if let Some((old_record, old_prepared)) = old.as_ref().and_then(|old| old.record.as_ref().zip(old.prepared.as_ref())) {
            frame.keep_unchanged(record, &old.as_ref().expect("checked").frame, old_record, &old_prepared.doc, &generation.prepared.doc);
        }
        let mut pose = Pose::new(frame, self.draws, times);
        pose.record = Some(record.clone());
        pose.prepared = Some(generation.prepared.clone());
        if let Some(old) = old {
            pose.memory = old.memory;
        }
        self.ghosts.insert(id, pose);
        Ok(())
    }

    /// Whether ghost `id` is kept and was made from `record` (the same node: the session's frame has not changed).
    pub fn has_ghost(&self, id: u32, record: &Value) -> bool {
        self.ghosts.get(&id).and_then(|pose| pose.record.as_ref()).is_some_and(|held| held.same_node(record))
    }

    /// A ghost not shown by the last draw keeps its pose and scene but not what its scene was built of: the builds of every object are
    /// held only for the ghosts that are on show.
    fn release_idle_ghosts(&mut self) {
        for pose in self.ghosts.values_mut().filter(|pose| pose.used != self.draws) {
            pose.memory = BuildMemory::default();
        }
    }

    pub fn has_frame(&self) -> bool {
        self.current.is_some()
    }

    /// The frame the stage shows: the pose last received, converted.
    pub fn frame(&self) -> Option<Arc<Frame>> {
        self.current.as_ref().map(|pose| pose.frame.clone())
    }

    /// Whether the last frame's generated effects are still being refined: some of their
    /// earlier anchors did not fit the frame's budget, so the next frame should be drawn
    /// again (`incomplete` batches in the editor).
    pub fn refining(&self) -> bool {
        self.refining
    }

    /// The camera the edit frame is seen through in the camera preview (`cameraAtTime`),
    /// as the last [`EditScene::draw_list`] with `camera` worked it out; the authored one otherwise.
    pub fn camera(&self) -> Option<styk_eval::doc::Camera> {
        let pose = self.current.as_ref()?;
        match &pose.shot {
            Some((_, shot)) => shot.camera,
            None => pose.frame.camera,
        }
    }

    /// Worker-only resolved background owner, after this snapshot prepared.
    pub fn plain_solid_background(&self, doc: &styk_eval::doc::Document) -> bool {
        self.current.as_ref().and_then(|pose|pose.scene.as_deref()).is_some_and(|scene|styk_eval::drawlist::plain_solid_background(doc,scene))
    }

    /// Exact motion time whose follow path is still cold. The caller schedules
    /// worker frame tickets and retries after engine progress; it keeps its last draw.
    pub fn camera_pending(&self) -> Option<f64> { self.camera_pending }

    /// The draw list of the current frame under `options`. `Err` names a ghost the
    /// interface asked for and never sent.
    pub fn draw_list(&mut self, generation: &Generation, options: &EditOptions<'_>) -> Result<Option<Arc<DrawList>>, String> {
        self.follow(generation);
        self.camera_pending = None;
        self.draws += 1;
        let doc = &generation.prepared.doc;
        let scene_of = |pose: &mut Pose| pose.scene.get_or_insert_with(|| Arc::new(build_remembering_plain(doc, &pose.frame, &mut pose.memory))).clone();
        let Some(current) = self.current.as_mut() else { return Ok(None) };
        let scene = scene_of(current);
        let hidden = flags(options.hidden, current.frame.objects.len());
        // Through the scene camera, parallax layers move after any drag (onion skins are
        // never shown with the camera on, so they take no parallax).
        let parallax = if options.camera {
            let Some(shot) = current.shot(generation, options.prepare_camera) else {
                self.camera_pending = current.motion_tick;
                return Ok(None);
            };
            shot.parallax
        } else { None };
        let moved = parallax.as_ref().map(|p| p.translations(options.translations));
        let translations = moved.as_deref().unwrap_or(options.translations);
        // Generated effects: built once per pose, again while trails are being refined.
        self.refining = false;
        let mut batch = None;
        if let Some(anchors) = generation.anchors.as_ref().filter(|_| !options.bypass_effects) {
            if current.generators.as_ref().is_none_or(|b| b.incomplete) {
                let clock = options.clock.unwrap_or(no_clock);
                let deadline = if options.clock.is_some() { clock() + options.anchor_budget_ms } else { f64::INFINITY };
                let sampler = anchors.sampler(clock, deadline);
                current.generators = styk_eval::vfx::generated::build(&generation.prepared, &current.frame, &scene, current.vfx_tick, Some(&sampler), 1.0).map(Arc::new);
            }
            self.refining = current.generators.as_ref().is_some_and(|b| b.incomplete);
            batch = current.generators.clone();
            // Draws beside a figure move with its drag and its parallax (`offsetGeneratorBatch`:
            // `parallax(uid)` plus the drag of the figure with that identity).
            let layers = doc.layers.as_deref().filter(|_| parallax.is_some());
            if let Some(b) = batch.as_mut().filter(|_| !options.translations.is_empty() || layers.is_some()) {
                let frame = &current.frame;
                Arc::make_mut(b).offset(|uid| {
                    let depth = parallax.as_ref().zip(layers).map_or([0.0, 0.0], |(p, layers)| p.of_uid(layers, uid));
                    let slot = frame.objects.iter().position(|o| o.uid == uid).map(|slot| slot as u32);
                    let drag = slot.and_then(|slot| options.translations.iter().find(|(s, _)| *s == slot)).map_or([0.0, 0.0], |(_, d)| *d);
                    Some([depth[0] + drag[0], depth[1] + drag[1]])
                });
            }
        }
        let overrides = Overrides { hidden: &hidden, translations, background: options.background, bypass_effects: options.bypass_effects, generators: batch.as_deref(), live: options.live.map(|cels| styk_eval::live::LiveView { cels, base: generation.assets.pages }) };
        if options.onions.is_empty() {
            let frame_scene = scene;
            let list = Arc::new(encode_composed_remembering(doc, &generation.assets, &frame_scene, &overrides, &[], None, &mut self.encoded));
            self.release_idle_ghosts();
            return Ok(Some(list));
        }
        let mut scenes = Vec::with_capacity(options.onions.len());
        for onion in options.onions {
            let pose = self.ghosts.get_mut(&onion.id).ok_or_else(|| format!("onion skin {} was never sent", onion.id))?;
            pose.used = self.draws;
            let ghost_scene = scene_of(pose);
            scenes.push((ghost_scene, flags(onion.hidden, pose.frame.objects.len())));
        }
        let current = self.current.as_ref().expect("checked above");
        let places: Vec<GhostPlace<'_>> = options
            .onions
            .iter()
            .zip(&scenes)
            .map(|(onion, (ghost_scene, ghost_hidden))| GhostPlace {
                frame: &self.ghosts[&onion.id].frame,
                scene: ghost_scene,
                hidden: ghost_hidden,
                show_on_top: onion.show_on_top,
            })
            .collect();
        let order = compose(doc.layers.as_deref(), &current.frame, &scene, &places);
        let ghosts: Vec<Ghost<'_>> = options
            .onions
            .iter()
            .zip(&scenes)
            .map(|(onion, (ghost_scene, ghost_hidden))| Ghost { scene: ghost_scene, opacity: onion.opacity, tint: onion.tint, hidden: ghost_hidden })
            .collect();
        let list = Arc::new(encode_composed_remembering(doc, &generation.assets, &scene, &overrides, &ghosts, Some(&order), &mut self.encoded));
        drop(places);
        self.release_idle_ghosts();
        if self.ghosts.len() > MAX_GHOSTS {
            let mut by_age: Vec<(u64, u32)> = self.ghosts.iter().map(|(&id, pose)| (pose.used, id)).collect();
            by_age.sort_unstable();
            for &(_, id) in &by_age[..self.ghosts.len() - MAX_GHOSTS] {
                self.ghosts.remove(&id);
            }
        }
        Ok(Some(list))
    }
}
