//! Worker-owned frame preparation, shared by the native scheduler and engine cache.
//! No document/store lock is held during evaluation or encoding.

use crate::{FrameData, Generation};
use std::sync::Arc;
use styk_eval::drawlist::{
    EncodeMemory, Ghost, Overrides, encode_composed, encode_composed_remembering,
};
use styk_eval::geometry::{
    BuildMemory, Scene, build, build_remembering_plain, build_remembering_plain_over,
};
use styk_eval::onion::{GhostPlace, compose};

#[derive(Clone, Debug, PartialEq)]
pub struct Onion {
    pub tick: f64,
    pub opacity: f64,
    pub tint: Option<[u8; 3]>,
    pub on_top: bool,
    /// Additional figures excluded by this onion's layer/scope plan.
    pub hidden_uids: Vec<u32>,
}

/// Inputs that change world-space geometry. Size, zoom, pan and quality belong
/// to the renderer, but must still be part of its caller's presentation key.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub hidden_uids: Vec<u32>,
    pub effects: bool,
    pub camera: bool,
    pub clip_to_canvas: bool,
    pub background: Option<u32>,
    /// Figure drags, by stable object identity, in world units.
    pub translations: Vec<(u32, [f64; 2])>,
    /// Far to near, as in the engine's onion composition. Camera mode hides onions.
    pub onions: Vec<Onion>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            hidden_uids: Vec::new(),
            effects: true,
            camera: true,
            clip_to_canvas: true,
            background: None,
            translations: Vec::new(),
            onions: Vec::new(),
        }
    }
}

/// One worker's reuse state. The owner bounds retained derived bytes and retires
/// this state after sustained idleness or document close. Parallel object maps
/// still run through styk-eval's existing native parallel path.
#[derive(Default)]
pub struct FrameBuilder {
    lineage: u64,
    memory: BuildMemory,
    scene: Option<Scene>,
    encoded: EncodeMemory,
}

impl FrameBuilder {
    /// Derived reuse buffers, using the geometry and encoder owners' accounting.
    /// Shared authored resources stay in the document's lifetime, not this budget.
    pub fn retained_bytes(&self) -> usize {
        self.memory.retained_bytes().saturating_add(self.scene.as_ref().map_or(0, |s| s.retained_bytes))
            .saturating_add(self.encoded.retained_bytes_checked().unwrap_or(usize::MAX))
    }

    pub fn release_over(&mut self, bytes: usize) {
        if self.retained_bytes() > bytes { *self = Self::default(); }
    }

    pub fn prepare(
        &mut self,
        generation: &Generation,
        tick: f64,
        options: &Options,
        clock: impl Fn() -> f64,
        cancelled: impl Fn() -> bool,
    ) -> Option<FrameData> {
        self.prepare_inner(generation, tick, options, &clock, &cancelled, true)
    }

    pub(crate) fn prepare_fresh(
        generation: &Generation,
        tick: f64,
        options: &Options,
        clock: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
    ) -> FrameData {
        // The existing synchronous worker entry is never cancelled.
        Self::default()
            .prepare_inner(generation, tick, options, &|| clock(), &|| false, false)
            .expect("uncancelled preparation")
    }

    fn prepare_inner(
        &mut self,
        generation: &Generation,
        tick: f64,
        options: &Options,
        clock: &impl Fn() -> f64,
        cancelled: &impl Fn() -> bool,
        reuse: bool,
    ) -> Option<FrameData> {
        if cancelled() {
            return None;
        }
        let started = clock();
        if self.lineage != generation.lineage {
            *self = Self {
                lineage: generation.lineage,
                ..Self::default()
            };
        }
        let prepared = &generation.prepared;
        let doc = &prepared.doc;
        let frame = prepared.evaluate(tick);
        if cancelled() {
            return None;
        }
        if reuse {
            match &self.scene {
                Some(previous) => {
                    if let Some(scene) =
                        build_remembering_plain_over(doc, &frame, &mut self.memory, previous)
                    {
                        self.scene = Some(scene);
                    }
                }
                None => self.scene = Some(build_remembering_plain(doc, &frame, &mut self.memory)),
            }
        } else {
            self.scene = Some(build(doc, &frame));
        }
        let scene = self.scene.as_ref()?;
        if cancelled() {
            return None;
        }
        let hidden = crate::frames::hidden_slots(generation, &frame, &options.hidden_uids);
        let moved: Vec<_> = options
            .translations
            .iter()
            .filter_map(|(uid, offset)| {
                frame
                    .objects
                    .iter()
                    .position(|o| o.uid == *uid)
                    .map(|slot| (slot as u32, *offset))
            })
            .collect();
        let translations = frame
            .parallax
            .as_ref()
            .filter(|_| options.camera)
            .map(|p| p.translations(&moved))
            .unwrap_or_else(|| moved.clone());
        let mut batch = generation
            .anchors
            .as_ref()
            .filter(|_| options.effects)
            .and_then(|anchors| {
                // The sampler uses the engine's function-pointer clock only to enforce
                // a deadline. This worker has none, as in frames::produce.
                let sampler = anchors.sampler(no_deadline_clock, f64::INFINITY);
                styk_eval::vfx::generated::build(
                    prepared,
                    &frame,
                    scene,
                    Some(tick),
                    Some(&sampler),
                    1.0,
                )
            });
        if let Some(batch) = batch.as_mut().filter(|_| {
            !options.translations.is_empty()
                || (options.camera && frame.parallax.is_some() && doc.layers.is_some())
        }) {
            batch.offset(|uid| {
                let depth = frame
                    .parallax
                    .as_ref()
                    .filter(|_| options.camera)
                    .zip(doc.layers.as_deref())
                    .map_or([0.0; 2], |(parallax, layers)| parallax.of_uid(layers, uid));
                Some(
                    match options.translations.iter().find(|(id, _)| *id == uid) {
                        Some((_, offset)) => [depth[0] + offset[0], depth[1] + offset[1]],
                        None => depth,
                    },
                )
            });
        }
        if cancelled() {
            return None;
        }
        let mut ghosts = Vec::new();
        if !options.camera {
            for onion in &options.onions {
                if cancelled() {
                    return None;
                }
                let mut ghost = prepared.evaluate(onion.tick);
                ghost.vfx = None;
                let mut hidden =
                    crate::frames::hidden_slots(generation, &ghost, &options.hidden_uids);
                if !onion.hidden_uids.is_empty() {
                    hidden.resize(ghost.objects.len(), false);
                    for (slot, object) in ghost.objects.iter().enumerate() {
                        hidden[slot] |= onion.hidden_uids.contains(&object.uid);
                    }
                }
                let scene = build(doc, &ghost);
                ghosts.push((ghost, scene, hidden));
            }
        }
        let places: Vec<_> = ghosts
            .iter()
            .zip(&options.onions)
            .map(|((frame, scene, hidden), onion)| GhostPlace {
                frame,
                scene,
                hidden,
                show_on_top: onion.on_top,
            })
            .collect();
        let order =
            (!places.is_empty()).then(|| compose(doc.layers.as_deref(), &frame, scene, &places));
        let ghosts: Vec<_> = ghosts
            .iter()
            .zip(&options.onions)
            .map(|((_, scene, hidden), onion)| Ghost {
                scene,
                hidden,
                opacity: onion.opacity,
                tint: onion.tint,
            })
            .collect();
        let overrides = Overrides {
            hidden: &hidden,
            translations: &translations,
            background: options.background,
            bypass_effects: !options.effects,
            generators: batch.as_ref(),
            ..Default::default()
        };
        let mut list = if reuse {
            encode_composed_remembering(
                doc,
                &generation.assets,
                scene,
                &overrides,
                &ghosts,
                order.as_deref(),
                &mut self.encoded,
            )
        } else {
            encode_composed(
                doc,
                &generation.assets,
                scene,
                &overrides,
                &ghosts,
                order.as_deref(),
            )
        };
        if options.clip_to_canvas {
            styk_eval::drawlist::cull_outside(&mut list, doc, scene.camera.as_ref());
        }
        if cancelled() {
            return None;
        }
        Some(FrameData {
            generation: generation.id,
            tick,
            list: Arc::new(list),
            camera: scene.camera,
            background: scene.background,
            ms: (clock() - started) as f32,
        })
    }
}

fn no_deadline_clock() -> f64 {
    0.0
}
