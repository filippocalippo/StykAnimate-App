//! Canvas-style cel sampling agrees on GPU and CPU: enlarged translucent ink, tile
//! seams, tint/crisp modes and the parent reduction used while shrinking. No browser API
//! enters either renderer; the layer plan marks artwork requiring Canvas-style sampling.

use std::sync::Arc;

use styk_draw::{DrawList, EffectLayer, Group, LayerKind, Pass, Prim, F_DRAWING, F_TINT, K_COMPOSITE, K_IMAGE, NO_LAYER, NO_PAINT};
use styk_eval::assets::{Assets, AtlasEntry, DecodedImage};
use styk_render::{read_frame, wgpu, Edges, Renderer, ViewParams};

const SIZE: [u32; 2] = [224, 224];

/// High-contrast colored ink, transparent outside the 128×128 cel and in speckled gaps.
fn ink(x: i32, y: i32) -> [u8; 4] {
    if !(0..128).contains(&x) || !(0..128).contains(&y) { return [0; 4]; }
    [(x * 47 % 256) as u8, (y * 73 % 256) as u8, ((x + y) * 19 % 256) as u8, if (x + 3 * y) % 5 == 0 { 0 } else { 180 }]
}

fn images() -> (Assets, Vec<DecodedImage>, styk_raster::Images) {
    let mut assets = Assets::default();
    let mut decoded = Vec::new();
    for index in 0..5 {
        assets.drawing.push(AtlasEntry { layer: 0, x: 2 + index * 68, y: 2, w: 64, h: 64, source_w: 64, source_h: 64, valid: true });
        let mut rgba = Vec::with_capacity(68 * 68 * 4);
        for y in -2..66 {
            for x in -2..66 {
                let pixel = if index < 4 {
                    ink((index & 1) as i32 * 64 + x, (index >> 1) as i32 * 64 + y)
                } else {
                    // The same integer, alpha-weighted 2×2 reduction as down_tile.
                    let block = [ink(x * 2, y * 2), ink(x * 2 + 1, y * 2), ink(x * 2, y * 2 + 1), ink(x * 2 + 1, y * 2 + 1)];
                    let a: u32 = block.iter().map(|p| p[3] as u32).sum();
                    if a == 0 { [0; 4] } else {
                        let channel = |k: usize| ((block.iter().map(|p| p[k] as u32 * p[3] as u32).sum::<u32>() * 2 + a) / (a * 2)) as u8;
                        [channel(0), channel(1), channel(2), ((a + 2) / 4) as u8]
                    }
                };
                rgba.extend(pixel);
            }
        }
        decoded.push(DecodedImage { index, drawing: true, soft: false, width: 68, height: 68, rgba, placement: 0 });
    }
    assets.pages = 1;
    let mut cpu = styk_raster::Images::default();
    for image in &decoded { cpu.add(&assets, image); }
    (assets, decoded, cpu)
}

fn list(assets: &Assets, canvas: bool, tint: bool) -> DrawList {
    let parent = assets.drawing[4];
    let paints = (0..4).map(|q| [parent.layer as f32, parent.x as f32, parent.y as f32, q as f32]).collect();
    let mut prims: Vec<_> = assets.drawing.iter().enumerate().map(|(i, e)| {
        let (span, level) = if i == 4 { (128.0, 1.0) } else { (64.0, 0.0) };
        let origin = if i == 4 { [0.0; 2] } else { [(i & 1) as f32 * 64.0, (i >> 1) as f32 * 64.0] };
        Prim { kind: K_IMAGE | F_DRAWING | if tint { F_TINT } else { 0 }, group: u32::from(canvas), color: if tint { 0x9920_e0ff } else { 0xffff_ffff }, paint: if i == 4 { NO_PAINT } else { i as u32 }, a: [origin[0], origin[1], span, 0.0], b: [0.0, span, e.layer as f32, level], c: e.uv() }
    }).collect();
    let root = Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 128.0, 128.0], layer: NO_LAYER };
    let mut list = DrawList { paints, groups: vec![root], passes: vec![Pass { depth: 0, start: 0, end: 5 }], ..Default::default() };
    if canvas {
        prims.push(Prim { kind: K_COMPOSITE, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [-2.0, -2.0, 130.0, 130.0], b: [f32::from_bits(1), 0.0, 0.0, 0.0], c: [0.0; 4] });
        list.groups.push(Group { parent: 0, depth: 1, opacity: 1.0, bounds: [0.0, 0.0, 128.0, 128.0], layer: 0 });
        list.layers = vec![EffectLayer { effects: None, kind: LayerKind::Nested { bounds: [0.0, 0.0, 128.0, 128.0], domain: [0.0, 0.0, 128.0, 128.0], scale: 1.0 } }];
        list.passes = vec![Pass { depth: 1, start: 0, end: 5 }, Pass { depth: 0, start: 5, end: 6 }];
    }
    list.prims = prims;
    list
}

fn view(scale: f64, rotated: bool) -> ViewParams {
    let angle: f64 = if rotated { 0.23 } else { 0.0 };
    let (cos, sin) = (angle.cos() * scale, angle.sin() * scale);
    ViewParams { matrix: [cos, sin, -sin, cos, 34.31, 6.23], artboard: [0.0, 0.0, SIZE[0] as f64, SIZE[1] as f64], clip_to_artboard: false, clear: [0.0; 4], zoom: scale, pan: [34.31, 6.23], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT }
}

/// The unchanged D13 rule: no 3×3 solid area above 32, mean beyond two levels ≤0.25.
fn d13(a: &[u8], b: &[u8]) -> (usize, f64) {
    let d: Vec<_> = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).map(|(p, q)| (0..4).map(|k| p[k].abs_diff(q[k])).max().unwrap()).collect();
    let w = SIZE[0] as usize;
    let mut solid = 0;
    for y in 1..SIZE[1] as usize - 1 {
        for x in 1..w - 1 {
            solid += usize::from((0..9).all(|k| d[(y + k / 3 - 1) * w + x + k % 3 - 1] > 32));
        }
    }
    (solid, d.iter().filter(|&&v| v > 2).map(|&v| v as f64).sum::<f64>() / d.len() as f64 + 0.0)
}

#[test]
fn canvas_enlargement_changes_ink_but_exact_size_and_crisp_keep_the_display_rule() {
    let (assets, _, images) = images();
    for (scale, edges, changes) in [(1.0, Edges::Smooth, false), (1.000001, Edges::Smooth, true), (1.3, Edges::Smooth, true), (1.3, Edges::Crisp, false)] {
        let direct = styk_raster::render(&list(&assets, false, false), &images, &view(scale, false), SIZE, edges).pixels;
        let canvas = styk_raster::render(&list(&assets, true, false), &images, &view(scale, false), SIZE, edges).pixels;
        let (solid, mean) = d13(&direct, &canvas);
        if changes {
            assert!(mean > 1.0, "scale {scale}: Canvas enlargement must use its own filter ({mean})");
        } else {
            assert!(solid == 0 && mean < 0.25, "scale {scale}, {edges:?}: direct and Canvas differ ({solid}, {mean})");
        }
    }
}

#[test]
fn canvas_cel_sampling_matches_the_gpu() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped on the GPU: no adapter");
        return;
    };
    eprintln!("GPU adapter: {:?}", adapter.get_info());
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let (assets, decoded, images) = images();
    let below = |scale: f32| f64::from(f32::from_bits(scale.to_bits() - 1));
    let above = |scale: f32| f64::from(f32::from_bits(scale.to_bits() + 1));
    let cases = [
        (below(1.0), false, false, Edges::Smooth),
        (1.0, false, false, Edges::Smooth),
        (above(1.0), false, false, Edges::Smooth),
        (1.3, false, false, Edges::Smooth),
        (1.3, true, true, Edges::Smooth),
        (1.3, false, true, Edges::Crisp),
        (0.55, false, false, Edges::Smooth),
        (0.71, false, true, Edges::Smooth),
        (0.82, true, false, Edges::Smooth),
        (below(0.5), false, false, Edges::Smooth),
        (0.5, false, false, Edges::Smooth),
        (above(0.5), false, false, Edges::Smooth),
    ];
    for edges in [Edges::Smooth, Edges::Crisp] {
        let mut renderer = Renderer::with_edges(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, edges);
        renderer.prepare_sprites(&assets);
        renderer.upload_images(&assets, &decoded);
        for canvas in [false, true] {
            for &(scale, rotated, tint, mode) in &cases {
                if mode != edges { continue; }
                let list = list(&assets, canvas, tint);
                let view = view(scale, rotated);
                renderer.set_list(&Arc::new(list.clone()));
                let mut encoder = device.create_command_encoder(&Default::default());
                renderer.render(&mut encoder, &view, SIZE);
                queue.submit([encoder.finish()]);
                let gpu = read_frame(&device, &queue, renderer.frame_texture().expect("a frame")).2;
                let cpu = styk_raster::render(&list, &images, &view, SIZE, edges).pixels;
                let (solid, mean) = d13(&gpu, &cpu);
                eprintln!("Canvas {canvas}, scale {scale}, rotated {rotated}, tint {tint}, {edges:?}: {solid} solid, mean {mean:.4}");
                assert!(solid == 0 && mean <= 0.25, "Canvas {canvas}, scale {scale}, rotated {rotated}, tint {tint}, {edges:?}: {solid} solid, mean {mean:.4}");
            }
        }
    }
}

/// `list` with `count` quads of a live cel's room (`styk_eval::drawlist::room_quad`) after its tiles, as the encoder pads a live cel.
fn with_room(mut list: DrawList, count: usize) -> DrawList {
    let at = list.prims.iter().position(|p| p.kind & 255 == K_COMPOSITE).unwrap_or(list.prims.len());
    let room = styk_eval::drawlist::room_quad(&list.prims[0]);
    assert!(styk_eval::drawlist::is_room_quad(&room));
    list.prims.splice(at..at, std::iter::repeat_n(room, count));
    for pass in &mut list.passes {
        if pass.start as usize >= at { pass.start += count as u32; }
        if pass.end as usize >= at { pass.end += count as u32; }
    }
    list
}

/// The room a live cel's block keeps for the tiles a stroke adds draws nothing: the frame with it is the frame without it, byte for
/// byte, on the CPU and on the GPU, at every level a view shows, in Canvas sampling and direct, smooth and crisp.
#[test]
fn a_live_cels_room_draws_nothing() {
    let (assets, decoded, images) = images();
    let cases = [(1.0, false, false), (1.3, true, true), (0.71, false, true), (0.5, false, false), (0.3, true, false), (2.6, false, false)];
    for edges in [Edges::Smooth, Edges::Crisp] {
        for canvas in [false, true] {
            for &(scale, rotated, tint) in &cases {
                let (plain, padded) = (list(&assets, canvas, tint), with_room(list(&assets, canvas, tint), 59));
                let view = view(scale, rotated);
                let what = format!("Canvas {canvas}, scale {scale}, rotated {rotated}, tint {tint}, {edges:?}");
                assert!(styk_raster::render(&plain, &images, &view, SIZE, edges).pixels == styk_raster::render(&padded, &images, &view, SIZE, edges).pixels, "CPU, {what}");
            }
        }
    }
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped on the GPU: no adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    for edges in [Edges::Smooth, Edges::Crisp] {
        let mut renderer = Renderer::with_edges(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, edges);
        renderer.prepare_sprites(&assets);
        renderer.upload_images(&assets, &decoded);
        for canvas in [false, true] {
            for &(scale, rotated, tint) in &cases {
                let view = view(scale, rotated);
                let mut frame = |list: DrawList| {
                    renderer.set_list(&Arc::new(list));
                    let mut encoder = device.create_command_encoder(&Default::default());
                    renderer.render(&mut encoder, &view, SIZE);
                    queue.submit([encoder.finish()]);
                    read_frame(&device, &queue, renderer.frame_texture().expect("a frame")).2
                };
                let (plain, padded) = (frame(list(&assets, canvas, tint)), frame(with_room(list(&assets, canvas, tint), 59)));
                assert!(plain == padded, "GPU, Canvas {canvas}, scale {scale}, rotated {rotated}, tint {tint}, {edges:?}");
            }
        }
    }
}

/// The bounds in output pixels of a drawing tile's quad under `view`, with a margin of two pixels.
fn quad_bounds(p: &Prim, view: &ViewParams) -> [f64; 4] {
    let m = view.matrix;
    let (o, u, v) = ([p.a[0] as f64, p.a[1] as f64], [p.a[2] as f64, p.a[3] as f64], [p.b[0] as f64, p.b[1] as f64]);
    let corners = [o, [o[0] + u[0], o[1] + u[1]], [o[0] + v[0], o[1] + v[1]], [o[0] + u[0] + v[0], o[1] + u[1] + v[1]]].map(|c| [m[0] * c[0] + m[2] * c[1] + m[4], m[1] * c[0] + m[3] * c[1] + m[5]]);
    let (xs, ys) = (corners.map(|c| c[0]), corners.map(|c| c[1]));
    [xs.iter().copied().fold(f64::INFINITY, f64::min) - 2.0, ys.iter().copied().fold(f64::INFINITY, f64::min) - 2.0, xs.iter().copied().fold(f64::NEG_INFINITY, f64::max) + 2.0, ys.iter().copied().fold(f64::NEG_INFINITY, f64::max) + 2.0]
}

/// A frame that differs from the one before it in a part (a stroke's tiles) is drawn in that part alone over the kept frame, and is the
/// frame drawn whole, byte for byte, with four samples a pixel and with one; a frame of another view, or over pictures uploaded since,
/// is drawn whole.
#[test]
fn a_frame_drawn_in_a_part_is_the_frame_drawn_whole() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let (assets, decoded, _) = images();
    for (edges, multisampled) in [(Edges::Smooth, true), (Edges::Smooth, false), (Edges::Crisp, false)] {
        let fresh = || {
            let mut renderer = Renderer::with_edges(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, edges);
            renderer.set_multisampled(multisampled);
            renderer.prepare_sprites(&assets);
            renderer.upload_images(&assets, &decoded);
            renderer
        };
        let draw = |renderer: &mut Renderer, list: &Arc<DrawList>, view: &ViewParams, within: Option<[f64; 4]>| {
            if let Some(rect) = within {
                renderer.redraw_within(rect);
            }
            renderer.set_list(list);
            let mut encoder = device.create_command_encoder(&Default::default());
            renderer.render(&mut encoder, view, SIZE);
            queue.submit([encoder.finish()]);
            (read_frame(&device, &queue, renderer.frame_texture().expect("a frame")).2, renderer.drew_part())
        };
        for (scale, rotated) in [(1.0, false), (1.3, true), (0.71, false)] {
            let what = format!("{edges:?}, multisampled {multisampled}, scale {scale}, rotated {rotated}");
            let view = view(scale, rotated);
            let before = Arc::new(list(&assets, false, false));
            // A tile moves by a few units and another goes (its quad becomes the room of a live cel's block): what a stroke frame changes.
            let mut changed = list(&assets, false, false);
            changed.prims[1].a[0] += 3.25;
            changed.prims[1].a[1] -= 1.5;
            changed.prims[2] = styk_eval::drawlist::room_quad(&changed.prims[2]);
            let after = Arc::new(changed);
            let part = [1usize, 2].iter().flat_map(|&i| [quad_bounds(&before.prims[i], &view), quad_bounds(&after.prims[i], &view)]).fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |a, b| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]);
            let whole = draw(&mut fresh(), &after, &view, None).0;

            let mut kept = fresh();
            kept.set_keep_frames(true);
            draw(&mut kept, &before, &view, None);
            let (drawn, in_part) = draw(&mut kept, &after, &view, Some(part));
            assert!(in_part, "{what}: the frame is drawn in the part");
            assert!(drawn == whole, "{what}: the frame drawn in a part is the frame drawn whole");
            let (again, in_part) = draw(&mut kept, &after, &view, Some(part));
            assert!(in_part && again == whole, "{what}: drawn in the part again, the same frame");

            // Another view: the kept frame is not what it would be drawn over.
            let mut other = fresh();
            other.set_keep_frames(true);
            draw(&mut other, &before, &self::view(scale * 1.01, rotated), None);
            let (drawn, in_part) = draw(&mut other, &after, &view, Some(part));
            assert!(!in_part && drawn == whole, "{what}: after another view the frame is drawn whole");

            // Pictures uploaded since the kept frame: drawn whole.
            let mut uploaded = fresh();
            uploaded.set_keep_frames(true);
            draw(&mut uploaded, &before, &view, None);
            uploaded.upload_images(&assets, &decoded);
            let (drawn, in_part) = draw(&mut uploaded, &after, &view, Some(part));
            assert!(!in_part && drawn == whole, "{what}: over pictures uploaded since, the frame is drawn whole");

            // Not kept: drawn whole.
            let mut plain = fresh();
            draw(&mut plain, &before, &view, None);
            let (drawn, in_part) = draw(&mut plain, &after, &view, Some(part));
            assert!(!in_part && drawn == whole, "{what}: a renderer that keeps no frame draws it whole");
        }
    }
}
