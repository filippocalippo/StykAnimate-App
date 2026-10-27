//! One frame: isolation layer passes by round and depth, then the frame pass.

use styk_draw::K_COMPOSITE;
use styk_eval::drawlist::layer_effects;

use crate::effects::executor::{Executor, Frame, Run};
use crate::effects::{self, plan, Slot};
use crate::isolation::{page_size, plan_rounds};
use crate::resources::{buffer, GpuGroup, GpuView};
use crate::{Renderer, Stats, ViewParams, FORMAT, UNIFORM_STRIDE};

/// One effect run of a frame: a filtered group's layer at `at` on `page` of its depth's atlas.
struct Work {
    group: usize,
    round: usize,
    depth: u32,
    page: u32,
    at: [u32; 2],
    size: [u32; 2],
    run: Run,
}

/// Receipt of the composite operations just encoded for one owning target.
/// Uses the same published shader group record; no document/effect scan or
/// pixel readback. Opacity-zero, unplaced and clipped sources are not consumed.
fn consume_gpu_sources(prims: &[styk_draw::Prim], placed: &[GpuGroup], sources: &mut [bool], page: Option<u32>, root_clip: Option<[f32;4]>) {
    for p in prims {
        if p.kind & 255 != K_COMPOSITE || p.color >> 24 == 0 { continue; }
        let parent = p.group as usize;
        let child = p.b[0].to_bits() as usize;
        if !sources.get(child).copied().unwrap_or(false) { continue; }
        let Some(child) = placed.get(child).map(|g| g.0) else { continue };
        if child[6] < 0.0 || child[22] <= child[20] || child[23] <= child[21]
            || child[12]*child[15]-child[13]*child[14] == 0.0 { continue; }
        let clip = if parent == 0 { root_clip } else {
            let Some(group) = placed.get(parent).map(|g| g.0) else { continue };
            if page != Some(group[6] as u32) || group[6] < 0.0 { continue; }
            Some([group[8],group[9],group[10],group[11]])
        };
        let Some(clip) = clip else { continue };
        if clip[2] <= clip[0] || clip[3] <= clip[1] { continue; }
        // These are the compositor vertex owner's actual published f32 corners.
        let quad = [[child[20],child[21]],[child[22],child[21]],[child[22],child[23]],[child[20],child[23]]].map(|[x,y]| {
            let at = [child[12]*x+child[14]*y+child[16],child[13]*x+child[15]*y+child[17]];
            [(at[0] as f64-clip[0] as f64)/(clip[2] as f64-clip[0] as f64),
             (at[1] as f64-clip[1] as f64)/(clip[3] as f64-clip[1] as f64)]
        });
        if crate::paint::PaintQuad(quad).pixel_area([0.0,0.0]) > 0.0 {
            if let Some(source) = sources.get_mut(parent) { *source = true; }
        }
    }
}

/// What passes of a list with depth runs draw with: the flat and faces pipelines
/// (`DepthPipelines`) and the ranges of the list's prims that are faces.
struct DepthRuns {
    flat: wgpu::RenderPipeline,
    faces: wgpu::RenderPipeline,
    flat_add: wgpu::RenderPipeline,
    ranges: Vec<(u32, u32)>,
}

/// Where the list's prims add light (styk-draw `F_ADD`) and the additive pipeline.
struct Additive {
    pipeline: wgpu::RenderPipeline,
    ranges: Vec<(u32, u32)>,
}

impl DepthRuns {
    /// Whether prims `range` hold any face: only such passes get a depth buffer.
    fn within(&self, range: std::ops::Range<u32>) -> bool {
        let first = self.ranges.partition_point(|&(_, end)| end <= range.start);
        self.ranges.get(first).is_some_and(|&(start, _)| start < range.end)
    }
}

/// A pass's depth buffer: each run resets the depth it uses, so it is never kept.
fn depth_attachment(view: &wgpu::TextureView) -> wgpu::RenderPassDepthStencilAttachment<'_> {
    wgpu::RenderPassDepthStencilAttachment { view, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }
}

/// Draws prims `range` of the list in one instanced draw, split where generated effects
/// add light (`additive`) and where depth-tested faces need the depth pipeline (`depth`:
/// the flat and faces pipelines of a pass with a depth buffer, and the list's face ranges).
fn draw_prims(pass: &mut wgpu::RenderPass<'_>, base: &wgpu::RenderPipeline, additive: Option<&Additive>, depth: Option<&DepthRuns>, range: std::ops::Range<u32>) {
    let Some(add) = additive else { return draw_painted(pass, base, depth, range) };
    let mut at = range.start;
    let first = add.ranges.partition_point(|&(_, end)| end <= range.start);
    for &(start, end) in &add.ranges[first..] {
        if start >= range.end {
            break;
        }
        if start > at {
            draw_painted(pass, base, depth, at..start);
        }
        pass.set_pipeline(depth.map_or(&add.pipeline, |d| &d.flat_add));
        pass.draw(0..6, start.max(at)..end.min(range.end));
        at = end.min(range.end);
    }
    if range.end > at {
        draw_painted(pass, base, depth, at..range.end);
    }
}

/// [`draw_prims`] for prims blended over the target.
fn draw_painted(pass: &mut wgpu::RenderPass<'_>, base: &wgpu::RenderPipeline, depth: Option<&DepthRuns>, range: std::ops::Range<u32>) {
    let Some(DepthRuns { flat, faces, ranges, .. }) = depth else {
        pass.set_pipeline(base);
        pass.draw(0..6, range);
        return;
    };
    let mut at = range.start;
    let first = ranges.partition_point(|&(_, end)| end <= range.start);
    for &(start, end) in &ranges[first..] {
        if start >= range.end {
            break;
        }
        if start > at {
            pass.set_pipeline(flat);
            pass.draw(0..6, at..start);
        }
        pass.set_pipeline(faces);
        pass.draw(0..6, start.max(at)..end.min(range.end));
        at = end.min(range.end);
    }
    if range.end > at {
        pass.set_pipeline(flat);
        pass.draw(0..6, at..range.end);
    }
}

impl Renderer {
    /// A depth buffer of `size` with `samples` per pixel for passes with depth runs.
    fn depth_buffer(device: &wgpu::Device, slot: &mut Option<(wgpu::Texture, [u32; 2])>, size: [u32; 2], samples: u32) -> wgpu::TextureView {
        if slot.as_ref().is_none_or(|s| s.1 != size) {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("styk depth"),
                size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: samples,
                dimension: wgpu::TextureDimension::D2,
                format: crate::pipeline::DEPTH_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            *slot = Some((texture, size));
        }
        slot.as_ref().unwrap().0.create_view(&Default::default())
    }

    pub(crate) fn ensure_output(&mut self, size: [u32; 2]) {
        if self.output.as_ref().is_some_and(|o| o.3 == size) {
            return;
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("styk frame"),
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk blit"),
            layout: &self.blit_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.nearest) },
            ],
        });
        self.output = Some((texture, view, bind, size));
    }

    /// The multisampled target of passes with `samples` per pixel (more than one).
    pub(crate) fn msaa(device: &wgpu::Device, slot: &mut Option<(wgpu::Texture, [u32; 2])>, size: [u32; 2], samples: u32) -> wgpu::TextureView {
        if slot.as_ref().is_none_or(|s| s.1 != size) {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("styk msaa"),
                size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: samples,
                dimension: wgpu::TextureDimension::D2,
                format: FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            *slot = Some((texture, size));
        }
        slot.as_ref().unwrap().0.create_view(&Default::default())
    }

    /// Renders the current draw list into the offscreen frame.
    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, view: &ViewParams, size: [u32; 2]) {
        self.root_gpu_source = false;
        let foreground = matches!(self.paint_context, crate::paint::PaintContext::CanvasForeground { .. });
        let size = [size[0].max(1), size[1].max(1)];
        self.ensure_output(size);
        let Some(list) = self.list.clone() else {
            self.clear_only(encoder, view);
            return;
        };
        if self.bind0.is_none() {
            self.rebind();
        }
        // Lone glyphs: the masks this view calls for (filled now when no frame has yet).
        self.prepare_glyphs(encoder, &list, plan::raster_resolution(view.matrix[0].hypot(view.matrix[1])));
        let n = list.groups.len();
        // Local execution receipt, never a second retained scene or cache.
        let mut gpu_sources = foreground.then(|| vec![false; n]);
        let max_depth = list.groups.iter().map(|g| g.depth).max().unwrap_or(0);
        // Where every group is drawn for this view (effects::plan), then where it lands in the atlas.
        let planned = plan::plan_with_grid(&list, &plan::View {
            matrix: view.matrix,
            size,
            zoom: view.zoom,
            pan: view.pan,
            orient: self.orientation.unwrap_or(plan::IDENTITY),
            stretch: view.stretch,
            camera_view: view.camera_view,
            camera_limit: view.camera_limit,
            max_texture: self.device.limits().max_texture_dimension_2d,
        }, self.drawing_grid);
        let sizes: Vec<[u32; 2]> = planned.iter().map(plan::Placement::size).collect();
        let largest = sizes.iter().skip(1).fold([0u32, 0u32], |a, s| [a[0].max(s[0]), a[1].max(s[1])]);
        // Pages hold the frame and grow for larger layers (effect layers at the editor's density, the
        // camera image); after 240 frames that all fit the frame they shrink back to it.
        let wanted = page_size(size, largest);
        self.page_small = if wanted == size { self.page_small + 1 } else { 0 };
        if self.page_frame != size || self.page_small > 240 {
            self.page_frame = size;
            self.page = size;
            self.page_small = 0;
        }
        self.page = [self.page[0].max(wanted[0]), self.page[1].max(wanted[1])];
        let page = self.page;
        let rounds = plan_rounds(&list, &sizes, page);
        let mut slots: Vec<Option<Slot>> = vec![None; n];
        for round in &rounds {
            for &(g, slot) in &round.placed {
                slots[g] = Some(slot);
            }
        }
        let mut placed = vec![GpuGroup::default(); n];
        let mut matrices: Vec<plan::Affine> = vec![view.matrix; n];
        for g in 1..n {
            let (record, matrix) = effects::record(&planned[g], matrices[list.groups[g].parent as usize], slots[g]);
            placed[g] = GpuGroup(record);
            matrices[g] = matrix;
        }
        let downscaled = rounds.iter().any(|round| round.downscaled);
        if self.groups.write(&self.device, &self.queue, bytemuck::cast_slice(&placed)) {
            self.rebind();
        }
        // Effect runs: recorded now (their uniforms are written once), encoded after their depth's layer pass.
        let mut work: Vec<Work> = Vec::new();
        if list.layers.iter().any(|layer| layer.effects.is_some()) {
            let executor = self.executor.get_or_insert_with(|| Executor::new(&self.device));
            executor.begin();
            let mut biggest = [0u32, 0u32];
            for (r, round) in rounds.iter().enumerate() {
                for &(g, slot) in &round.placed {
                    let Some(filter) = planned[g].filter else { continue };
                    let stack = list.layers.get(list.groups[g].layer as usize).map_or(&[][..], layer_effects);
                    if stack.is_empty() {
                        continue;
                    }
                    let s = sizes[g];
                    let at = [(s[0] as f64 * slot.scale).ceil().max(1.0) as u32, (s[1] as f64 * slot.scale).ceil().max(1.0) as u32];
                    let f = effects::scaled(filter, slot.scale);
                    let run = executor.record(stack, Frame { scale: f.scale, origin: f.origin, output_size: f.output_size }, at);
                    biggest = [biggest[0].max(at[0]), biggest[1].max(at[1])];
                    work.push(Work { group: g, round: r, depth: list.groups[g].depth, page: slot.page, at: [slot.offset[0] as u32, slot.offset[1] as u32], size: at, run });
                }
            }
            executor.prepare(&self.device, &self.queue, biggest);
        } else if let Some(executor) = &mut self.executor {
            executor.begin();
            executor.prepare(&self.device, &self.queue, [0, 0]);
        }
        // Each group's prims are one run inside its depth's pass (the encoder emits them by group).
        let mut runs = vec![(u32::MAX, 0u32); n];
        for (i, p) in list.prims.iter().enumerate() {
            let run = &mut runs[p.group as usize];
            run.0 = run.0.min(i as u32);
            run.1 = i as u32 + 1;
        }
        // One uniform slot per layer pass (round, depth, page) and one for the frame.
        let mut passes: Vec<(usize, u32, u32, u32, u32)> = Vec::new(); // round, depth, page, start, end
        for (r, round) in rounds.iter().enumerate() {
            for depth in (1..=max_depth).rev() {
                let (mut start, mut end) = (u32::MAX, 0u32);
                for g in round.first..round.end {
                    if list.groups[g].depth == depth && runs[g].0 < runs[g].1 {
                        start = start.min(runs[g].0);
                        end = end.max(runs[g].1);
                    }
                }
                if start >= end {
                    continue;
                }
                for page in 0..round.pages_per_depth[depth as usize] {
                    passes.push((r, depth, page, start, end));
                }
            }
        }
        let root = list.passes.iter().find(|p| p.depth == 0).map(|p| (p.start, p.end)).unwrap_or((0, 0));
        let root = if foreground { (root.0 + list.background_prims.min(root.1-root.0), root.1) } else { root };
        let slots_needed = passes.len() as u64 + 1;
        if slots_needed > self.uniform_slots {
            self.uniform_slots = slots_needed.next_power_of_two();
            self.uniforms = buffer(&self.device, "styk views", UNIFORM_STRIDE * self.uniform_slots, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST);
            self.rebind();
        }
        let mut uniform_data = vec![0u8; (UNIFORM_STRIDE * slots_needed) as usize];
        for (i, &(_, depth, page_index, _, _)) in passes.iter().enumerate() {
            let v = view.gpu([page[0] as f32, page[1] as f32, page_index as f32, depth as f32], self.crisp);
            let o = i * UNIFORM_STRIDE as usize;
            uniform_data[o..o + std::mem::size_of::<GpuView>()].copy_from_slice(bytemuck::bytes_of(&v));
        }
        let mut v = view.gpu([size[0] as f32, size[1] as f32, 0.0, 0.0], self.crisp);
        if let crate::paint::PaintContext::CanvasDirect { background_bounds } | crate::paint::PaintContext::CanvasForeground { background_bounds } = self.paint_context {
            let paint = crate::paint::PaintQuad::rectangle(view.matrix, background_bounds);
            let q = paint.0.map(|p|p.map(|v|v as f32));
            v.inv_t[2] = 1.0;
            v.inv_t[3] = if paint.canvas_alpha(view.matrix,[0,0]).is_some() { 1.0 } else { 0.0 };
            v.canvas_clip = crate::paint::CanvasClip::new(view.artboard).rect();
            v.background_bounds = background_bounds.map(|v|v as f32);
            v.paint_quad0 = [q[0][0],q[0][1],q[1][0],q[1][1]];
            v.paint_quad1 = [q[2][0],q[2][1],q[3][0],q[3][1]];
        }
        // A rotated or mirrored workspace view: the artboard is a quad on screen, and the scene
        // outside it is clipped by the fragments (a scissor rectangle cannot follow it).
        let artboard = match self.orientation {
            Some(orientation) => {
                let a = view.artboard;
                let corners = [[a[0], a[1]], [a[2], a[1]], [a[2], a[3]], [a[0], a[3]]].map(|p| styk_eval::view::apply(orientation, p).map(|v| v as f32));
                v.orient_quad0 = [corners[0][0], corners[0][1], corners[1][0], corners[1][1]];
                v.orient_quad1 = [corners[2][0], corners[2][1], corners[3][0], corners[3][1]];
                v.orient_flags = [1.0, if view.clip_to_artboard { 1.0 } else { 0.0 }, 0.0, 0.0];
                let xs = corners.map(|p| p[0] as f64);
                let ys = corners.map(|p| p[1] as f64);
                [xs.into_iter().fold(f64::INFINITY, f64::min), ys.into_iter().fold(f64::INFINITY, f64::min), xs.into_iter().fold(f64::NEG_INFINITY, f64::max), ys.into_iter().fold(f64::NEG_INFINITY, f64::max)]
            }
            None => view.artboard,
        };
        let o = passes.len() * UNIFORM_STRIDE as usize;
        uniform_data[o..o + std::mem::size_of::<GpuView>()].copy_from_slice(bytemuck::bytes_of(&v));
        self.queue.write_buffer(&self.uniforms, 0, &uniform_data);

        for depth in 1..=max_depth {
            let pages = rounds.iter().map(|round| round.pages_per_depth[depth as usize]).max().unwrap_or(0);
            if pages > 0 {
                self.ensure_layers(depth as usize % 2, page, pages);
            }
        }
        // Where the frame stops for the next round: before the first composite of a group the next round draws.
        let mut round_of = vec![usize::MAX; n];
        for (r, round) in rounds.iter().enumerate() {
            round_of[round.first..round.end].fill(r);
        }
        let bg = if foreground { 0 } else { list.background_prims.min(root.1 - root.0) };
        let mut stops = vec![root.1; rounds.len()];
        let mut next = 1;
        for i in root.0 + bg..root.1 {
            let p = &list.prims[i as usize];
            if p.kind & 255 != K_COMPOSITE {
                continue;
            }
            let r = round_of.get(p.b[0].to_bits() as usize).copied().unwrap_or(usize::MAX);
            while next < rounds.len() && r != usize::MAX && r >= next {
                stops[next - 1] = i;
                next += 1;
            }
        }
        let bind0 = self.bind0.clone().unwrap();
        // Depth runs: depth-buffered passes, created only for lists that have faces.
        let depth_runs = (!self.depth_faces.is_empty()).then(|| {
            let ranges = self.depth_faces.clone();
            let pipelines = self.depth_pipelines();
            DepthRuns { flat: pipelines.flat.clone(), faces: pipelines.faces.clone(), flat_add: pipelines.flat_add.clone(), ranges }
        });
        let additive = (!self.add_ranges.is_empty()).then(|| Additive { pipeline: self.additive_pipeline(), ranges: self.add_ranges.clone() });
        let (mut layer_depth, mut frame_depth) = (false, false);
        let mut from = root.0 + bg;
        for (r, _) in rounds.iter().enumerate() {
            for depth in (1..=max_depth).rev() {
                for (i, &(round, pass_depth, page_index, start, end)) in passes.iter().enumerate() {
                    if round != r || pass_depth != depth {
                        continue;
                    }
                    let parity = depth as usize % 2;
                    let target = self.layers[parity].texture.create_view(&wgpu::TextureViewDescriptor {
                        dimension: Some(wgpu::TextureViewDimension::D2),
                        base_array_layer: page_index,
                        array_layer_count: Some(1),
                        ..Default::default()
                    });
                    // With one sample a pixel the pass draws straight into its atlas page.
                    let msaa = (self.samples > 1).then(|| Self::msaa(&self.device, &mut self.msaa_layer, page, self.samples));
                    let face_runs = depth_runs.as_ref().filter(|r| r.within(start..end));
                    let depth_view = face_runs.map(|_| Self::depth_buffer(&self.device, &mut self.depth_layer, page, self.samples));
                    layer_depth |= depth_view.is_some();
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("styk layer pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: msaa.as_ref().unwrap_or(&target),
                            depth_slice: None,
                            resolve_target: msaa.as_ref().map(|_| &target),
                            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: if msaa.is_some() { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store } },
                        })],
                        depth_stencil_attachment: depth_view.as_ref().map(depth_attachment),
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
                    pass.set_bind_group(0, &bind0, &[(i as u64 * UNIFORM_STRIDE) as u32]);
                    pass.set_bind_group(1, &self.sprite_bind, &[]);
                    pass.set_bind_group(2, &self.layer_binds[(depth as usize + 1) % 2], &[]);
                    pass.set_vertex_buffer(0, self.prims.slice(..));
                    draw_prims(&mut pass, &self.pipeline, additive.as_ref(), face_runs, start..end);
                    if let Some(sources) = &mut gpu_sources {
                        consume_gpu_sources(&list.prims[start as usize..end as usize], &placed, sources, Some(page_index), None);
                    }
                }
                // The filtered groups of this depth, before the next depth composites them.
                if let Some(executor) = &mut self.executor {
                    let atlas = &self.layers[depth as usize % 2].texture;
                    for w in work.iter().filter(|w| w.round == r && w.depth == depth) {
                        let extent = wgpu::Extent3d { width: w.size[0], height: w.size[1], depth_or_array_layers: 1 };
                        let place = wgpu::TexelCopyTextureInfo { texture: atlas, mip_level: 0, origin: wgpu::Origin3d { x: w.at[0], y: w.at[1], z: w.page }, aspect: wgpu::TextureAspect::All };
                        encoder.copy_texture_to_texture(place, executor.slot_texture(&self.device, 0).as_image_copy(), extent);
                        executor.encode(&self.device, encoder, &w.run);
                        if let Some(sources) = &mut gpu_sources {
                            sources[w.group] |= w.run.steps.iter().any(|step| matches!(step, effects::recipe::Step::Pass { .. }));
                        }
                        encoder.copy_texture_to_texture(executor.slot_texture(&self.device, w.run.result).as_image_copy(), place, extent);
                    }
                }
            }
            // The frame, up to the next round's first composite. The multisampled frame is kept between rounds.
            let last = r + 1 == rounds.len();
            let until = if last { root.1 } else { stops[r] };
            // With one sample a pixel the frame is drawn straight into the output, kept between rounds.
            let msaa = (self.samples > 1).then(|| Self::msaa(&self.device, &mut self.msaa_main, size, self.samples));
            // Faces sit in raster entries, so a frame pass seldom holds any.
            let face_runs = depth_runs.as_ref().filter(|r| r.within(root.0..root.1));
            let depth_view = face_runs.map(|_| Self::depth_buffer(&self.device, &mut self.depth_main, size, self.samples));
            frame_depth |= depth_view.is_some();
            let output = &self.output.as_ref().unwrap().1;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("styk frame pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: msaa.as_ref().unwrap_or(output),
                    depth_slice: None,
                    resolve_target: if last && msaa.is_some() { Some(output) } else { None },
                    ops: wgpu::Operations {
                        load: if r == 0 {
                            wgpu::LoadOp::Clear(wgpu::Color { r: view.clear[0], g: view.clear[1], b: view.clear[2], a: view.clear[3] })
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: if last && msaa.is_some() { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store },
                    },
                })],
                depth_stencil_attachment: depth_view.as_ref().map(depth_attachment),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &bind0, &[(passes.len() as u64 * UNIFORM_STRIDE) as u32]);
            pass.set_bind_group(1, &self.sprite_bind, &[]);
            pass.set_bind_group(2, &self.layer_binds[1], &[]);
            pass.set_vertex_buffer(0, self.prims.slice(..));
            if r == 0 && bg > 0 {
                draw_prims(&mut pass, &self.pipeline, additive.as_ref(), face_runs, root.0..root.0 + bg);
            }
            if until > from {
                if view.clip_to_artboard {
                    let a = artboard;
                    let x0 = a[0].clamp(0.0, size[0] as f64).floor() as u32;
                    let y0 = a[1].clamp(0.0, size[1] as f64).floor() as u32;
                    let x1 = a[2].clamp(0.0, size[0] as f64).ceil() as u32;
                    let y1 = a[3].clamp(0.0, size[1] as f64).ceil() as u32;
                    if x1 > x0 && y1 > y0 {
                        pass.set_scissor_rect(x0, y0, x1 - x0, y1 - y0);
                        draw_prims(&mut pass, &self.pipeline, additive.as_ref(), face_runs, from..until);
                        if let Some(sources) = &mut gpu_sources {
                            consume_gpu_sources(&list.prims[from as usize..until as usize], &placed, sources, None, Some([
                                crate::paint::CanvasClip::new(view.artboard).rect()[0].max(x0 as f32),
                                crate::paint::CanvasClip::new(view.artboard).rect()[1].max(y0 as f32),
                                crate::paint::CanvasClip::new(view.artboard).rect()[2].min(x1 as f32),
                                crate::paint::CanvasClip::new(view.artboard).rect()[3].min(y1 as f32)]));
                        }
                    }
                } else {
                    draw_prims(&mut pass, &self.pipeline, additive.as_ref(), face_runs, from..until);
                    if let Some(sources) = &mut gpu_sources {
                        consume_gpu_sources(&list.prims[from as usize..until as usize], &placed, sources, None, Some([0.0,0.0,size[0] as f32,size[1] as f32]));
                    }
                }
            }
            // WebGL resolves a multisampled attachment with gl.blit_framebuffer,
            // which respects the current scissor. Resolve the cleared card margins
            // too, after the artboard has clipped every drawn scene primitive.
            pass.set_scissor_rect(0, 0, size[0], size[1]);
            from = until;
            self.root_gpu_source = gpu_sources.as_ref().is_some_and(|sources| sources.first() == Some(&true));
        }
        // Depth buffers live while frames use them (a document with 3D faces).
        if !layer_depth {
            self.depth_layer = None;
        }
        if !frame_depth {
            self.depth_main = None;
        }
        let fx = self.executor.as_ref().map(|e| e.stats).unwrap_or_default();
        // An atlas always has two layers at least (resources::array_texture).
        let layer_bytes = self.layers.iter().map(|a| a.size[0] as u64 * a.size[1] as u64 * 4 * a.pages.max(2) as u64).sum();
        // Four samples of four bytes (depth24plus) per pixel, frame and layer pages.
        let depth_bytes = [&self.depth_main, &self.depth_layer].iter().filter_map(|d| d.as_ref()).map(|d| d.1[0] as u64 * d.1[1] as u64 * 4 * self.samples as u64).sum();
        self.stats = Stats {
            prims: list.prims.len() as u32,
            groups: n as u32 - 1,
            passes: passes.len() as u32 + rounds.len() as u32,
            downscaled,
            rounds: rounds.len() as u32,
            effect_layers: fx.layers,
            effect_passes: fx.passes,
            effect_bytes: fx.slot_bytes,
            layer_bytes,
            depth_bytes,
            material_bytes: self.materials.bytes(),
            glyph_masks: self.glyphs.count() as u32,
            glyph_masks_filled: self.glyphs.filled,
            glyph_bytes: self.glyphs.bytes(),
        };
    }

    fn clear_only(&mut self, encoder: &mut wgpu::CommandEncoder, view: &ViewParams) {
        let output = &self.output.as_ref().unwrap().1;
        let _ = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("styk clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color { r: view.clear[0], g: view.clear[1], b: view.clear[2], a: view.clear[3] }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
    }

}


#[cfg(test)]
mod source_receipt_tests {
    use super::*;
    fn groups() -> Vec<GpuGroup> {
        let mut record = [0.0;effects::GROUP_FLOATS];
        record[6]=0.0;record[8..12].copy_from_slice(&[0.0,0.0,10.0,10.0]);
        record[12]=1.0;record[15]=1.0;record[20..24].copy_from_slice(&[0.0,0.0,10.0,10.0]);
        vec![GpuGroup::default(),GpuGroup(record),GpuGroup(record)]
    }
    fn composite(parent:u32,child:u32,alpha:u8)->styk_draw::Prim {
        styk_draw::Prim {kind:K_COMPOSITE,group:parent,color:(alpha as u32)<<24,paint:styk_draw::NO_PAINT,
            a:[0.0;4],b:[f32::from_bits(child),0.0,0.0,0.0],c:[0.0;4]}
    }
    #[test]
    fn only_completed_consumed_sources_reach_root() {
        let g=groups();let p=composite(0,1,255);let mut sources=[false;3];
        consume_gpu_sources(&[p],&g,&mut sources,None,Some([0.0,0.0,20.0,20.0]));
        assert!(!sources[0],"a composite is not evidence of GPU effect execution");
        sources[1]=true;
        consume_gpu_sources(&[p],&g,&mut sources,None,Some([0.0,0.0,20.0,20.0]));
        assert!(sources[0]);
    }
    #[test]
    fn skipped_composites_never_consume_a_source() {
        let g=groups();
        for (p,clip) in [(composite(0,1,0),[0.0,0.0,20.0,20.0]),(composite(0,1,255),[20.0,20.0,30.0,30.0])] {
            let mut sources=[false,true,false];consume_gpu_sources(&[p],&g,&mut sources,None,Some(clip));assert!(!sources[0]);
        }
        for at in [6usize,12] {
            let mut g=g.clone();g[1].0[at]=-1.0;
            if at==12 {g[1].0[12]=0.0;}
            let mut sources=[false,true,false];consume_gpu_sources(&[composite(0,1,255)],&g,&mut sources,None,Some([0.0,0.0,20.0,20.0]));assert!(!sources[0]);
        }
    }
    #[test]
    fn a_rotated_bbox_corner_does_not_consume_a_clipped_source() {
        let mut g=groups();
        // Diamond (0,5),(5,0),(10,5),(5,10): its bounds intersect
        // the clip at0..1,0..1, but its actual composite misses it.
        g[1].0[12]=0.5;g[1].0[13]=-0.5;g[1].0[14]=0.5;g[1].0[15]=0.5;g[1].0[16]=0.0;g[1].0[17]=5.0;
        let mut sources=[false,true,false];
        consume_gpu_sources(&[composite(0,1,255)],&g,&mut sources,None,Some([0.0,0.0,1.0,1.0]));assert!(!sources[0]);
        consume_gpu_sources(&[composite(0,1,255)],&g,&mut sources,None,Some([4.0,4.0,6.0,6.0]));assert!(sources[0]);
    }
    #[test]
    fn nested_consumption_uses_actual_parent_page_and_opacity() {
        let g=groups();let mut sources=[false,false,true];
        consume_gpu_sources(&[composite(1,2,255)],&g,&mut sources,Some(1),None);assert!(!sources[1]);
        consume_gpu_sources(&[composite(1,2,0)],&g,&mut sources,Some(0),None);assert!(!sources[1]);
        consume_gpu_sources(&[composite(1,2,255)],&g,&mut sources,Some(0),None);assert!(sources[1]);assert!(!sources[0]);
        consume_gpu_sources(&[composite(0,1,255)],&g,&mut sources,None,Some([0.0,0.0,20.0,20.0]));assert!(sources[0]);
    }
}
