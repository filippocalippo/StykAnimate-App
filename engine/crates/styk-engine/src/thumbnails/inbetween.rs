//! Read-only in-between thumbnails, sampled and encoded only on a worker.
use std::sync::Arc;
use styk_draw::DrawList;
use styk_eval::doc::Camera;
use styk_eval::drawlist::{encode_preview, Ghost, Overrides};
use styk_eval::eval::Prepared;
use styk_eval::geometry::build;
use crate::{Clock, Generation};

#[derive(Clone, Copy)]
pub struct Onions {
    /// 0: adjacent; 1: settings; 2: none.
    pub mode: u32,
    pub count: u32,
    pub opacity: f64,
    pub ahead: bool,
}

/// One sampling view per pinned generation, sharing its typed poses and media.
pub struct InbetweenPreview { generation: Arc<Generation>, sampling: Prepared }
impl InbetweenPreview {
    pub fn new(generation: Arc<Generation>) -> Self {
        let sampling = generation.prepared.inbetween_view();
        Self { generation, sampling }
    }

    pub fn sample(&self, index: usize, ratio: f64, onions: Onions, clock: Clock) -> Result<(Arc<DrawList>, Option<Camera>), String> {
        if onions.mode > 2 || onions.count > 9 || !onions.opacity.is_finite() || !(0.0..=1.0).contains(&onions.opacity) { return Err("Invalid in-between preview options.".into()); }
        let generation = &self.generation;
        let prepared = &generation.prepared;
        let doc = &prepared.doc;
        let frame = self.sampling.inbetween(index, ratio).map_err(str::to_owned)?;
        let scene = build(doc, &frame);
        let hidden = crate::frames::hidden_slots(generation, &frame, &[]);
        let translations = frame.parallax.as_ref().map(|p| p.translations(&[])).unwrap_or_default();
        let mut batch = generation.anchors.as_ref().and_then(|anchors| {
            let sampler = anchors.sampler(clock, f64::INFINITY);
            styk_eval::vfx::generated::build(prepared, &frame, &scene, Some(frame.tick), Some(&sampler), 1.0)
        });
        if let (Some(batch), Some(parallax), Some(layers)) = (batch.as_mut(), frame.parallax.as_ref(), doc.layers.as_deref()) { batch.offset(|uid| Some(parallax.of_uid(layers, uid))); }
        let count = match onions.mode { 0 => 1, 1 => onions.count, _ => 0 };
        let mut ghosts = Vec::new();
        for distance in (1..=count).rev() {
            for ahead in [false, true] {
                if onions.mode == 1 && ahead && !onions.ahead { continue; }
                let source = if ahead { index.checked_add(distance as usize - 1) } else { index.checked_sub(distance as usize) };
                let Some(source) = source.filter(|&source| source < doc.keyframes.len()) else { continue; };
                let tick = prepared.rows[source].start as f64;
                let source_frame = prepared.evaluate_interval(source, 0.0, tick);
                let mut ghost = build(doc, &source_frame);
                for item in &mut ghost.items { item.opacity *= onions.opacity / distance as f64; }
                let hidden = crate::frames::hidden_slots(generation, &source_frame, &[]);
                ghosts.push((ghost, hidden));
            }
        }
        let ghosts: Vec<_> = ghosts.iter().map(|(scene, hidden)| Ghost { scene, hidden, tint: None, opacity: 1.0 }).collect();
        let overrides = Overrides { hidden: &hidden, translations: &translations, generators: batch.as_ref(), ..Default::default() };
        Ok((Arc::new(encode_preview(doc, &generation.assets, &scene, &overrides, &ghosts)), scene.camera))
    }
}
