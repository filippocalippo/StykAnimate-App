//! Worker-owned sprite residency, using the engine's existing page owner.
use super::{PaintError, PaintLimits};
use std::collections::{HashMap, HashSet};
use styk_engine::{Acquired, Generation, PlaceIndex, Residency, pictures_of};
use styk_eval::assets::{PAGE, Picture, decode_picture};
use styk_eval::drawlist::DrawList;
use styk_render::Renderer;

#[derive(Default)]
pub(super) struct Pictures {
    identity: Option<(u64, u64, u64, u64)>,
    residency: Option<Residency>,
    index: PlaceIndex,
    cel_at: HashMap<(u32, u32, u32), usize>,
    cel_pages: HashMap<usize, Vec<u32>>,
    loaded_images: HashSet<u32>,
    loaded_cels: HashSet<usize>,
}
impl Pictures {
    pub(super) fn prepare(
        &mut self,
        renderer: &mut Renderer,
        generation: &Generation,
        resource_epoch: u64,
        list: &DrawList,
        limits: PaintLimits,
        cancelled: impl Fn() -> bool,
    ) -> Result<(), PaintError> {
        let assets = &generation.assets;
        let budget = limits.sprite_bytes;
        let identity = (
            generation.lineage,
            generation.revision,
            assets.id(),
            resource_epoch,
        );
        if self.identity != Some(identity) {
            *self = Self {
                identity: Some(identity),
                index: PlaceIndex::new(assets),
                ..Self::default()
            };
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
            if assets.pages == 0 {
                renderer.prepare_sprites(assets);
            } else {
                // Texture arrays have two layers minimum (D11). Refuse before allocation.
                let required = 2 * u64::from(PAGE).pow(2) * 4;
                if required > budget {
                    self.identity = None;
                    return Err(PaintError::Budget {
                        required,
                        limit: budget,
                    });
                }
                if let Err(required) =
                    renderer.prepare_sprites_export_bounded(assets, 2, limits.working_bytes)
                {
                    self.identity = None;
                    return Err(PaintError::Budget {
                        required,
                        limit: limits.working_bytes,
                    });
                }
                self.residency = Some(Residency::new(assets.pages, 2));
            }
        }
        if assets.pages == 0 {
            return Ok(());
        }
        let images = pictures_of(list, &self.index);
        let mut cels = HashSet::new();
        for prim in &list.prims {
            if prim.kind & 255 == styk_eval::drawlist::K_IMAGE
                && prim.kind & styk_eval::drawlist::F_DRAWING != 0
            {
                let place = (
                    prim.b[2] as u32,
                    (prim.c[0] * PAGE as f32).round() as u32,
                    (prim.c[1] * PAGE as f32).round() as u32,
                );
                if let Some(&cel) = self.cel_at.get(&place) {
                    cels.insert(cel);
                }
            }
        }
        let mut pages: Vec<u32> = images
            .iter()
            .filter_map(|&i| assets.atlas.get(i as usize).map(|a| a.layer))
            .chain(
                cels.iter()
                    .flat_map(|id| self.cel_pages.get(id).into_iter().flatten().copied()),
            )
            .collect();
        pages.sort_unstable();
        pages.dedup();
        let required = (pages.len() as u64).max(2) * u64::from(PAGE).pow(2) * 4;
        if required > budget {
            return Err(PaintError::Budget {
                required,
                limit: budget,
            });
        }
        let wanted_layers = (pages.len() as u32).max(2);
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
                        self.loaded_images
                            .retain(|&i| assets.atlas[i as usize].layer != old);
                        self.loaded_cels
                            .retain(|id| !self.cel_pages[id].contains(&old));
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
        for image in images {
            if cancelled() {
                return Err(PaintError::Closed);
            }
            if self.loaded_images.contains(&image) {
                continue;
            }
            let decoded = decode_picture(
                &generation.prepared.doc,
                assets,
                Picture::Image(image as usize),
            )
            .map_err(|_| PaintError::Decode)?;
            renderer.upload_images(assets, decoded.iter());
            let entry = &assets.atlas[image as usize];
            // A malformed image is blank, as in export. Never expose old texels.
            renderer.set_picture(
                entry,
                if decoded.is_empty() {
                    None
                } else {
                    residency.layer_of(entry.layer)
                },
            );
            self.loaded_images.insert(image);
        }
        let mut cels: Vec<_> = cels.into_iter().collect();
        cels.sort_unstable();
        for cel in cels {
            if cancelled() {
                return Err(PaintError::Closed);
            }
            if self.loaded_cels.contains(&cel) {
                continue;
            }
            // Refusal never marks a cel ready or publishes the candidate. A later
            // successful request overwrites all its slots before showing it.
            let decoded = decode_picture(&generation.prepared.doc, assets, Picture::Cel(cel))
                .map_err(|_| PaintError::Decode)?;
            renderer.upload_images(assets, decoded.iter());
            self.loaded_cels.insert(cel);
        }
        renderer.flush_pictures();
        residency.touch(&pages);
        Ok(())
    }
}
