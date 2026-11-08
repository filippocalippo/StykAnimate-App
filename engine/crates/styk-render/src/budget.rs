//! Conservative byte admission for a worker-driven stage. This counts concrete
//! textures/buffers and their replacement overlap, not a multiplier of the input
//! file. Driver pipeline/command bookkeeping is outside the texture budget.
use crate::effects::{plan, recipe};
use crate::{FramePlan, Renderer, UNIFORM_STRIDE};

fn pixels(size: [u32; 2]) -> u64 {
    u64::from(size[0])
        .saturating_mul(u64::from(size[1]))
        .saturating_mul(4)
}
fn power(n: u64) -> u64 {
    n.max(1).checked_next_power_of_two().unwrap_or(u64::MAX)
}
fn table(bytes: u64, texel: u64) -> u64 {
    let row = crate::resources::TABLE_WIDTH as u64 * texel;
    power(bytes.div_ceil(row)).saturating_mul(row)
}
fn table_now(t: &crate::resources::Table) -> u64 {
    t.rows as u64 * crate::resources::TABLE_WIDTH as u64 * t.texel_bytes as u64
}

impl Renderer {
    /// Upper bound for scratch plus retained resources during this frame, before
    /// `set_list` or `render` allocates. Only the stage worker calls this. Output
    /// pictures and sprite pixels have separate budgets at their owning lifetime.
    /// Consumes the already recorded placement/round/effect plan, including scaling
    /// of oversized groups and the executor's 256-pixel size buckets.
    pub fn working_set_bound(&self, frame: &FramePlan) -> u64 {
        let list = &frame.list;
        let view = &frame.view;
        let size = frame.size;
        let page = frame.page;
        let retained = self
            .prims
            .size()
            .saturating_add(self.uniforms.size())
            .saturating_add(table_now(&self.paints))
            .saturating_add(table_now(&self.points))
            .saturating_add(table_now(&self.groups))
            .saturating_add(table_now(&self.glyphs.table))
            .saturating_add(self.glyphs.bytes())
            .saturating_add(self.materials.bytes())
            .saturating_add(self.pictures.bytes())
            .saturating_add(
                self.layers
                    .iter()
                    .map(|a| pixels(a.size) * u64::from(a.pages.max(2)))
                    .sum::<u64>(),
            )
            .saturating_add(self.target_bytes())
            .saturating_add(self.stats.depth_bytes)
            .saturating_add(self.executor.as_ref().map_or(0, |e| e.retained_bytes()));
        let mut pages = [0; 2];
        let mut passes = 1u64;
        for round in &frame.rounds {
            for (depth, &count) in round.pages_per_depth.iter().enumerate().skip(1) {
                pages[depth % 2] = pages[depth % 2].max(count);
                passes = passes.saturating_add(count as u64);
            }
        }
        let records = &frame.records;
        let effect_size = frame.biggest;
        // Inactive owners are already counted in retained. Active replacements
        // keep their page-count high-water mark, with old/new overlap admitted.
        let mut prospective = pages.iter().enumerate().map(|(parity,&count)| {
            if count == 0 { 0 } else { pixels(page).saturating_mul(u64::from(count.max(self.layers[parity].pages).max(2))) }
        }).sum::<u64>();
        let layer_target = if pages == [0; 2] { 0 } else { pixels(page) };
        if self.samples > 1 {
            prospective = prospective.saturating_add(
                pixels(size)
                    .saturating_add(layer_target)
                    .saturating_mul(self.samples as u64),
            );
        }
        if list.prims.iter().any(|p| p.kind & styk_draw::F_DEPTH != 0) {
            prospective = prospective.saturating_add(
                pixels(size)
                    .saturating_add(pixels(page))
                    .saturating_mul(self.samples as u64),
            );
        }
        prospective = prospective
            .saturating_add(power(std::mem::size_of_val(list.prims.as_slice()) as u64).max(65536))
            .saturating_add(table(
                std::mem::size_of_val(list.paints.as_slice()) as u64,
                16,
            ))
            .saturating_add(table(
                std::mem::size_of_val(list.points.as_slice()) as u64,
                8,
            ))
            .saturating_add(table(
                (list.groups.len() as u64)
                    .saturating_mul(std::mem::size_of::<crate::resources::GpuGroup>() as u64),
                16,
            ))
            .saturating_add(power(passes.max(8)).saturating_mul(UNIFORM_STRIDE));
        if !records.is_empty() {
            let bucket = effect_size.map(|n| n.saturating_add(255) / 256 * 256);
            let bucket = self.executor.as_ref().map_or(bucket, |e| e.required_size(effect_size));
            prospective = prospective
                .saturating_add(pixels(bucket).saturating_mul(recipe::SLOTS as u64))
                .saturating_add(power((records.len() as u64).max(64)).saturating_mul(768));
        }
        if !list.glyphs.is_empty() {
            // Geometric growth of the atlas, plus all temporary mask attachments
            // and vertices referenced by this frame's one command buffer.
            prospective = prospective
                .saturating_add(2 * crate::glyphs::BUDGET)
                .saturating_add(table((list.glyphs.len() as u64).saturating_mul(3 * 16), 16));
            let resolution = plan::raster_resolution(view.matrix[0].hypot(view.matrix[1]));
            for glyph in &list.glyphs {
                if let Some(mask) = glyph
                    .mask
                    .layout(resolution, styk_draw::GlyphMask::MAX_DIMENSION)
                {
                    prospective = prospective
                        .saturating_add(
                            u64::from(mask.width)
                                .saturating_mul(u64::from(mask.height))
                                .saturating_mul(5),
                        )
                        .saturating_add(std::mem::size_of_val(glyph.triangles.as_ref()) as u64);
                }
            }
        }
        if list.materials != 0 {
            for mip in 0..styk_draw::MATERIAL_LEVELS {
                prospective = prospective.saturating_add(
                    u64::from((styk_draw::MATERIAL_CELL * styk_draw::MATERIAL_COLUMNS) >> mip)
                        * u64::from((styk_draw::MATERIAL_CELL * styk_draw::MATERIAL_ROWS) >> mip)
                        * 2,
                );
            }
        }
        // Fixed sprite-map and empty-picture placeholders, including replacement.
        retained
            .saturating_add(prospective)
            .saturating_add(64 * 1024)
    }
}
