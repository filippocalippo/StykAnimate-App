//! A snapshot of the frame the stage actually displayed, for a camera-monitor worker.
//! Capturing an edit pose shares its frame and geometry; preparation happens only when
//! the worker asks for the list. There are no platform or browser assumptions here.

use std::sync::Arc;

use styk_draw::DrawList;
use styk_eval::doc::Camera;

use crate::edit::{EditOptions, EditScene};
use crate::{Engine, FrameData, Generation};

enum Source {
    Prepared { tick: f64, epoch: Option<u64> },
    Edit { scene: EditScene, hidden: Vec<u32>, translations: Vec<(u32, [f64; 2])>, effects: bool },
}

/// One pending monitor request. A newer stage frame supersedes it; dropping it releases
/// the pinned generation and pose without affecting the stage or engine workers.
pub struct MonitorFrame {
    pub engine: Engine,
    pub generation: Arc<Generation>,
    source: Source,
}

impl MonitorFrame {
    pub fn prepared(engine: Engine, generation: Arc<Generation>, frame: Arc<FrameData>) -> MonitorFrame {
        Self::prepared_sample_at(engine, generation, frame.tick)
    }

    /// Captures a displayed tick even while cold image bounds invalidate its cached
    /// list. The existing frame cache is read or repaired only on the worker.
    pub fn prepared_at(engine: Engine, generation: Arc<Generation>, tick: u32) -> MonitorFrame {
        Self::prepared_sample_at(engine, generation, tick as f64)
    }

    /// Captures the actual finite fractional time successfully displayed by the stage.
    pub fn prepared_sample_at(engine: Engine, generation: Arc<Generation>, tick: f64) -> MonitorFrame {
        MonitorFrame { engine, generation, source: Source::Prepared { tick, epoch: None } }
    }

    /// Captures the actual successfully shown prepared ticket. Cache eviction
    /// may be repaired on the worker; another settings/resource epoch is stale.
    pub fn prepared_ticket(engine: Engine, generation: Arc<Generation>, tick: f64, epoch: u64) -> MonitorFrame {
        MonitorFrame { engine, generation, source: Source::Prepared { tick, epoch: Some(epoch) } }
    }

    pub fn edit(engine: Engine, generation: Arc<Generation>, scene: &EditScene, hidden: Vec<u32>, translations: Vec<(u32, [f64; 2])>, effects: bool) -> MonitorFrame {
        MonitorFrame { engine, generation, source: Source::Edit { scene: scene.snapshot(), hidden, translations, effects } }
    }

    /// Only the successfully prepared Edit snapshot's typed solid owner.
    pub fn plain_solid_background(&self) -> bool {
        match &self.source {
            Source::Edit { scene, .. } => scene.plain_solid_background(&self.generation.prepared.doc),
            Source::Prepared { .. } => false,
        }
    }

    /// Called on the auxiliary worker, after its pictures have decoded. Camera travel,
    /// parallax and effects follow the displayed pose; onion skins are omitted.
    pub fn prepare(&mut self) -> Result<Option<(Arc<DrawList>, Option<Camera>)>, String> {
        match &mut self.source {
            Source::Prepared { tick, epoch } => {
                if self.engine.generation().is_none_or(|generation| generation.id != self.generation.id) { return Ok(None); }
                if epoch.is_some_and(|epoch| !self.engine.frame_epoch_current(self.generation.id, epoch)) { return Ok(None); }
                // A late cel decode can correct effect bounds within this generation.
                // Never reuse the old ticket's list: this is the engine's one cache,
                // and any missing frame is prepared here, on the monitor worker.
                let frame = self.engine.frame_now_at(*tick).filter(|frame| frame.generation == self.generation.id);
                if epoch.is_some_and(|epoch| !self.engine.frame_epoch_current(self.generation.id, epoch)) { return Ok(None); }
                Ok(frame.map(|frame| (frame.list.clone(), frame.camera)))
            },
            Source::Edit { scene, hidden, translations, effects } => {
                let options = EditOptions { hidden, translations, bypass_effects: !*effects, camera: true, prepare_camera: true, ..Default::default() };
                Ok(scene.draw_list(&self.generation, &options)?.map(|list| (list, scene.camera())))
            }
        }
    }
}
