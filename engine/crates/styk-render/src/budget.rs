//! Conservative byte admission for a worker-driven stage. This counts concrete
//! textures/buffers and their replacement overlap, not a multiplier of the input
//! file. Driver pipeline/command bookkeeping is outside the texture budget.
use crate::effects::{self, plan, recipe};
use crate::isolation::{page_size, plan_rounds};
use crate::{Renderer, UNIFORM_STRIDE, ViewParams};
use styk_draw::DrawList;

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
    /// Uses the same placement/round/effect planners as render, including scaling
    /// of oversized groups and the executor's 256-pixel size buckets.
    pub fn working_set_bound(&self, list: &DrawList, view: &ViewParams, size: [u32; 2]) -> u64 {
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
        let planned = plan::plan_with_grid(
            list,
            &plan::View {
                matrix: view.matrix,
                size,
                zoom: view.zoom,
                pan: view.pan,
                orient: self.orientation.unwrap_or(plan::IDENTITY),
                stretch: view.stretch,
                camera_view: view.camera_view,
                camera_limit: view.camera_limit,
                max_texture: self.device.limits().max_texture_dimension_2d,
            },
            self.drawing_grid,
        );
        let sizes: Vec<_> = planned.iter().map(plan::Placement::size).collect();
        let largest = sizes
            .iter()
            .skip(1)
            .fold([0u32; 2], |a, s| [a[0].max(s[0]), a[1].max(s[1])]);
        let wanted = page_size(size, largest);
        let page = if self.exact_sizes {
            wanted
        } else {
            [wanted[0].max(self.page[0]), wanted[1].max(self.page[1])]
        };
        let rounds = plan_rounds(list, &sizes, page);
        let mut pages = [self.layers[0].pages, self.layers[1].pages];
        let mut passes = 1u64;
        let mut effect_size = [0u32; 2];
        let mut records = Vec::new();
        for round in &rounds {
            for (depth, &count) in round.pages_per_depth.iter().enumerate().skip(1) {
                pages[depth % 2] = pages[depth % 2].max(count);
                passes = passes.saturating_add(count as u64);
            }
            for &(g, slot) in &round.placed {
                let Some(filter) = planned[g].filter else {
                    continue;
                };
                let stack = list
                    .layers
                    .get(list.groups[g].layer as usize)
                    .map_or(&[][..], styk_eval::drawlist::layer_effects);
                if stack.is_empty() {
                    continue;
                }
                let at = sizes[g].map(|n| (f64::from(n) * slot.scale).ceil().max(1.0) as u32);
                let f = effects::scaled(filter, slot.scale);
                let _run = recipe::record(
                    &mut records,
                    stack,
                    recipe::Frame {
                        scale: f.scale,
                        origin: f.origin,
                        output_size: f.output_size,
                    },
                    at,
                );
                effect_size = [effect_size[0].max(at[0]), effect_size[1].max(at[1])];
            }
        }
        // Both layer parities may be replaced; each array has at least two layers.
        let mut prospective =
            pixels(page).saturating_mul(u64::from(pages[0].max(2)) + u64::from(pages[1].max(2)));
        if self.samples > 1 {
            prospective = prospective.saturating_add(
                pixels(size)
                    .saturating_add(pixels(page))
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
