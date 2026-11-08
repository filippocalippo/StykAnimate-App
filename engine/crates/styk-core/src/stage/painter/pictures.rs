//! Worker-owned residency; pixels arrive from the document engine's bounded queue.
use super::{PaintError, PaintLimits};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use styk_engine::{Acquired, Engine, Generation, PlaceIndex, Residency, Uploaded, pictures_of};
use styk_eval::assets::PAGE;
use styk_eval::drawlist::DrawList;
use styk_render::Renderer;

#[derive(Default)]
pub(super) struct Pictures {
    lineage: Option<u64>,
    assets: Option<u64>,
    residency: Option<Residency>,
    index: PlaceIndex,
    cel_at: HashMap<(u32, u32, u32), usize>,
    cel_pages: HashMap<usize, Vec<u32>>,
    uploaded: Uploaded,
    blank_images: HashSet<u32>,
    requested_images: HashSet<u32>,
    requested_cels: HashSet<usize>,
    refused: HashSet<u64>,
    pub uploaded_bytes: u64,
}
impl Pictures {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn prefetch(&mut self, renderer: &mut Renderer, generation: &Arc<Generation>, engine: Option<&Engine>,
        current: &DrawList, next: &DrawList, limits: PaintLimits) -> Result<bool,PaintError> {
        self.prepare_for(renderer,generation,engine,next,limits,Some(current))
    }
    pub(super) fn begin(&mut self) {
        self.requested_images.clear();
        self.requested_cels.clear();
        self.refused.clear();
    }
    /// One upload slice. False keeps the admitted candidate pending; the caller
    /// submits this slice and yields while existing engine workers decode ahead.
    pub(super) fn prepare(
        &mut self,
        renderer: &mut Renderer,
        generation: &Arc<Generation>,
        engine: Option<&Engine>,
        list: &DrawList,
        limits: PaintLimits,
    ) -> Result<bool, PaintError> {
        self.prepare_for(renderer,generation,engine,list,limits,None)
    }

    fn needed(&self, list: &DrawList) -> (Vec<u32>, HashSet<usize>) {
        let images = pictures_of(list, &self.index);
        let cels = list.prims.iter().filter(|p| p.kind & 255 == styk_eval::drawlist::K_IMAGE && p.kind & styk_eval::drawlist::F_DRAWING != 0)
            .filter_map(|p| self.cel_at.get(&(p.b[2] as u32,(p.c[0]*PAGE as f32).round() as u32,(p.c[1]*PAGE as f32).round() as u32)).copied()).collect();
        (images,cels)
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_for(&mut self, renderer: &mut Renderer, generation: &Arc<Generation>, engine: Option<&Engine>,
        list: &DrawList, limits: PaintLimits, protect: Option<&DrawList>) -> Result<bool, PaintError> {
        let assets = &generation.assets;
        let budget = limits.sprite_bytes;
        if self.lineage != Some(generation.lineage) {
            *self = Self {
                lineage: Some(generation.lineage),
                uploaded_bytes: self.uploaded_bytes,
                ..Self::default()
            };
        }
        if self.assets != Some(assets.id()) {
            self.index = PlaceIndex::new(assets);
            self.cel_at.clear();
            self.cel_pages.clear();
            for (&id, (_, levels)) in &assets.cels {
                let mut pages = Vec::new();
                for &slot in levels.iter().flatten() {
                    if let Some(entry) = assets.drawing.get(slot as usize).filter(|e| e.valid) {
                        self.cel_at.insert((entry.layer, entry.x, entry.y), id);
                        pages.push(entry.layer);
                    }
                }
                pages.sort_unstable();
                pages.dedup();
                self.cel_pages.insert(id, pages);
            }
            if self.residency.is_none() {
                if assets.pages == 0 {
                    renderer.prepare_sprites(assets);
                } else {
                    let required = 2 * u64::from(PAGE).pow(2) * 4;
                    if required > budget {
                        return Err(PaintError::Budget {
                            required,
                            limit: budget,
                        });
                    }
                    renderer
                        .prepare_sprites_export_bounded(assets, 2, limits.working_bytes)
                        .map_err(|required| PaintError::Budget {
                            required,
                            limit: limits.working_bytes,
                        })?;
                    self.residency = Some(Residency::new(assets.pages, 2));
                }
            } else {
                renderer
                    .sync_pictures_bounded(assets, limits.working_bytes)
                    .map_err(|required| PaintError::Budget {
                        required,
                        limit: limits.working_bytes,
                    })?;
                if let Some(residency) = &mut self.residency {
                    residency.extend(assets.pages);
                }
            }
            // The assets owner assigns stable serials to unchanged cel payloads.
            // Only new placements invalidate their previous texels, not revisions
            // or resource epochs (bounds changes have no new image pixels).
            self.uploaded.observe(assets);
            self.assets = Some(assets.id());
        }
        if assets.pages == 0 {
            return Ok(true);
        }
        let engine = engine
            .ok_or_else(|| PaintError::Device("document picture service unavailable".into()))?;
        let (images,cels) = self.needed(list);
        let mut pages: Vec<u32> = images
            .iter()
            .filter_map(|&i| assets.atlas.get(i as usize).map(|a| a.layer))
            .chain(
                cels.iter()
                    .flat_map(|id| self.cel_pages.get(id).into_iter().flatten().copied()),
            )
            .collect();
        if let Some(protect) = protect {
            let (images,cels) = self.needed(protect);
            pages.extend(images.iter().filter_map(|&i|assets.atlas.get(i as usize).map(|a|a.layer)));
            pages.extend(cels.iter().flat_map(|id|self.cel_pages.get(id).into_iter().flatten().copied()));
        }
        pages.sort_unstable();
        pages.dedup();
        let wanted_layers = (pages.len() as u32).max(2).max(self.residency.as_ref().map_or(0,Residency::layers));
        let required = u64::from(wanted_layers) * u64::from(PAGE).pow(2) * 4;
        if required > budget {
            return Err(PaintError::Budget {
                required,
                limit: budget,
            });
        }
        if wanted_layers > renderer.device().limits().max_texture_array_layers
            || pages.iter().any(|&page| page >= styk_render::MAX_PAGES)
        {
            return Err(PaintError::Device(
                "sprite working set exceeds the device or page-map limit".into(),
            ));
        }
        // Grow once, not once per page: only one old/new array pair can be in
        // flight, and it is completed before another candidate starts.
        renderer.resize_sprite_layers(wanted_layers);
        let Some(residency) = self.residency.as_mut() else {
            return Err(PaintError::Decode);
        };
        // Previously shown pixels are in a detached output, not dependent on the
        // sprite atlas. Protect the entire candidate set throughout all uploads.
        residency.hold(&pages);
        for &page in &pages {
            match residency.acquire(page, &pages, true) {
                Acquired::Resident(_) => {}
                Acquired::Given { layer, evicted } => {
                    if let Some(old) = evicted {
                        renderer.map_sprite_page(old, None);
                        self.uploaded.forget_page(old);
                        self.blank_images
                            .retain(|&i| assets.atlas[i as usize].layer != old);
                        for image in styk_engine::images_on(assets, old) {
                            renderer.set_picture(&assets.atlas[image], None);
                        }
                    }
                    renderer.map_sprite_page(page, Some(layer));
                }
                Acquired::Full => {
                    return Err(PaintError::Budget {
                        required,
                        limit: budget,
                    });
                }
            }
        }
        renderer.flush_sprite_map();
        renderer.flush_pictures();

        let batch = engine.take_picture_batch(4 << 20);
        self.refused.extend(batch.refused);
        for image in batch.images {
            if image.soft {
                continue;
            }
            let entry = if image.drawing {
                assets.drawing.get(image.index as usize)
            } else {
                assets.atlas.get(image.index as usize)
            };
            let Some(entry) = entry.filter(|e| e.valid) else {
                continue;
            };
            if image.placement != 0 && !assets.holds_placement(image.placement) {
                continue;
            }
            if residency.layer_of(entry.layer).is_none() {
                continue;
            }
            if !self.refused.contains(&image.placement) && self.uploaded.has(entry) {
                continue;
            }
            renderer.upload_images(assets, std::iter::once(image.as_ref()));
            self.uploaded_bytes = self.uploaded_bytes.saturating_add(image.rgba.len() as u64);
            if !self.refused.contains(&image.placement) {
                self.uploaded.record(assets, &image);
                if !image.drawing {
                    renderer.set_picture(entry, residency.layer_of(entry.layer));
                }
            }
        }
        renderer.flush_pictures();
        if cels
            .iter()
            .any(|&id| self.refused.contains(&assets.placement(id)))
        {
            return Err(PaintError::Decode);
        }
        let missing_images: Vec<_> = images
            .iter()
            .copied()
            .filter(|i| {
                !self.blank_images.contains(i)
                    && assets
                        .atlas
                        .get(*i as usize)
                        .is_some_and(|e| e.valid && !self.uploaded.has(e))
            })
            .collect();
        let missing_cels: Vec<_> = cels
            .iter()
            .copied()
            .filter(|id| {
                assets.cels[id].1.iter().flatten().any(|&slot| {
                    assets
                        .drawing
                        .get(slot as usize)
                        .is_some_and(|e| e.valid && !self.uploaded.has(e))
                })
            })
            .collect();
        if missing_images.is_empty() && missing_cels.is_empty() {
            residency.touch(&pages);
            return Ok(true);
        }
        if engine.images_backlog() == (0, 0) {
            if engine.images_refused(generation, &missing_images)
                && missing_images.iter().any(|i| self.requested_images.contains(i)) {
                return Err(PaintError::Decode);
            }
            // Initial publication already queues decodes. Only missing/evicted
            // resources need demand jobs, once; malformed images stay blank.
            for &image in &missing_images {
                if !self.requested_images.insert(image) {
                    self.blank_images.insert(image);
                    renderer.set_picture(&assets.atlas[image as usize], None);
                }
            }
            if missing_cels
                .iter()
                .any(|cel| self.requested_cels.contains(cel))
            {
                return Err(PaintError::Decode);
            }
            let demand: Vec<_> = missing_images
                .iter()
                .copied()
                .filter(|i| !self.blank_images.contains(i))
                .map(|i| i as usize)
                .collect();
            self.requested_cels.extend(&missing_cels);
            engine.decode_images(generation, &demand, true);
            engine.decode_cels(generation, &missing_cels);
            renderer.flush_pictures();
            if demand.is_empty() && missing_cels.is_empty() {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
