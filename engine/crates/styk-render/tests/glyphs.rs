//! Lone glyphs drawn from masks (styk-draw `K_GLYPH`, docs/engine/rendering.md): the
//! outlined-text fixture without its outlines (and in a dark colour) is three single-character text figures,
//! which the editor's WebGPU renderer draws from glyph textures. The masks draw the glyphs
//! (with their triangles removed, the picture is the same), are kept across frames, and
//! past the editor's density 8 the triangles draw instead. Skipped where no GPU adapter exists.

use std::path::Path;
use std::sync::Arc;

use styk_eval::drawlist::{encode, DrawList, F_GLYPH_VECTOR, K_GLYPH};
use styk_render::{read_frame, wgpu, Edges, Renderer, ViewParams};

const SIZE: [u32; 2] = [400, 200];

fn list() -> DrawList {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/outlined-text.json");
    let mut doc = styk_eval::open(&path).unwrap();
    for figure in &mut doc.figures {
        let figure = Arc::make_mut(figure);
        figure.outline = None;
        // Dark text: the fixture's is white, on a white scene.
        figure.segments.iter_mut().for_each(|segment| segment.rgb = [20, 30, 60]);
    }
    let prepared = styk_eval::prepare(doc);
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(0.0));
    encode(&prepared.doc, &assets, &scene)
}

/// The 800×400 canvas at half size, or `zoom` times closer around (650, 200).
fn view(zoom: f64) -> ViewParams {
    let z = 0.5 * zoom;
    let pan = [200.0 - 650.0 * z, 100.0 - 200.0 * z];
    ViewParams { matrix: [z, 0.0, 0.0, z, pan[0], pan[1]], artboard: [pan[0], pan[1], pan[0] + 800.0 * z, pan[1] + 400.0 * z], clip_to_artboard: false, clear: [0.0; 4], zoom: z, pan, stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT }
}

fn draw(renderer: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, list: &Arc<DrawList>, view: &ViewParams) -> Vec<u8> {
    renderer.set_list(list);
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, view, SIZE);
    queue.submit([encoder.finish()]);
    read_frame(device, queue, renderer.frame_texture().expect("a frame")).2
}

/// Pixels of `a` that differ from `b` by more than 8 levels.
fn differing(a: &[u8], b: &[u8]) -> usize {
    a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(p, q)| (0..4).any(|k| p[k].abs_diff(q[k]) > 8)).count()
}

#[test]
fn lone_glyphs_draw_from_masks_kept_across_frames() {
    let with = Arc::new(list());
    assert_eq!(with.glyphs.len(), 3);
    // The same list with the glyphs' own triangles made records of no kind: only masks can draw them.
    let mut masks_only = (*with).clone();
    masks_only.prims.iter_mut().filter(|p| p.kind & F_GLYPH_VECTOR != 0).for_each(|p| p.kind = 0);
    let masks_only = Arc::new(masks_only);
    let mut empty = (*with).clone();
    empty.prims.iter_mut().filter(|p| p.kind & F_GLYPH_VECTOR != 0 || p.kind == K_GLYPH).for_each(|p| p.kind = 0);
    let empty = Arc::new(empty);
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    // Pictures without the glyphs, from a renderer of their own.
    let mut other = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    let blank = draw(&mut other, &device, &queue, &empty, &view(1.0));
    let first = draw(&mut renderer, &device, &queue, &with, &view(1.0));
    assert_eq!((renderer.stats.glyph_masks, renderer.stats.glyph_masks_filled), (3, 3), "one mask per glyph and size, filled once");
    assert!(renderer.stats.glyph_bytes > 0);
    assert!(differing(&first, &blank) > 200, "the glyphs are drawn");
    let again = draw(&mut renderer, &device, &queue, &masks_only, &view(1.0));
    assert_eq!(renderer.stats.glyph_masks_filled, 0, "the masks are kept across frames");
    assert_eq!(first, again, "at density 1 the masks draw the glyphs, not their triangles");
    // Past density 8 the editor draws no mask: the triangles do, and without them nothing.
    let blank = draw(&mut other, &device, &queue, &empty, &view(20.0));
    let close = draw(&mut renderer, &device, &queue, &with, &view(20.0));
    assert!(differing(&close, &blank) > 1000, "close up the glyph's triangles draw");
    let none = draw(&mut renderer, &device, &queue, &masks_only, &view(20.0));
    assert_eq!(differing(&none, &blank), 0, "close up no mask is drawn");
}

#[test]
fn crisp_edges_draw_lone_glyphs_from_their_outlines() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let with = Arc::new(list());
    let mut crisp = Renderer::with_edges(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, Edges::Crisp);
    let pixels = draw(&mut crisp, &device, &queue, &with, &view(1.0));
    assert_eq!(crisp.stats.glyph_masks, 0, "a mask's coverage is smooth: crisp edges fill none");
    // The outlines are drawn, aliased: every glyph pixel is fully covered or not at all.
    let mut empty = (*with).clone();
    empty.prims.iter_mut().filter(|p| p.kind & F_GLYPH_VECTOR != 0 || p.kind == K_GLYPH).for_each(|p| p.kind = 0);
    let blank = draw(&mut Renderer::with_edges(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, Edges::Crisp), &device, &queue, &Arc::new(empty), &view(1.0));
    assert!(differing(&pixels, &blank) > 200, "the glyphs are drawn");
}

/// A frame of lone glyphs built here: `count` blobs of their own (each has a mask of its own), each of glyph-space size 100 drawn at
/// `scale`, so their masks are `2^k` texels with `k` from the scale.
fn glyphs(count: usize, scale: f64) -> Arc<DrawList> {
    use styk_draw::{GlyphInstance, GlyphMask, Group, Pass, Prim, NO_LAYER, NO_PAINT};
    let mut list = DrawList::default();
    for index in 0..count {
        let ring: Vec<[f32; 2]> = (0..7).map(|k| {
            let angle = k as f64 / 7.0 * std::f64::consts::TAU;
            let radius = 30.0 + 3.0 * ((index * 7 + k) % 5) as f64;
            [(50.0 + radius * angle.cos()) as f32, (50.0 + radius * angle.sin()) as f32]
        }).collect();
        let triangles: Vec<[f32; 2]> = (0..7).flat_map(|k| [[50.0, 50.0], ring[k], ring[(k + 1) % 7]]).collect();
        let mask = GlyphMask { bounds: [0.0, 0.0, 100.0, 100.0], origin: [10.0 + (index % 20) as f64 * 15.0, 10.0 + (index / 20) as f64 * 12.0], angle: 0.0, scale: [scale, scale], offset: [0.0, 0.0] };
        list.glyphs.push(GlyphInstance { mask, triangles: triangles.into() });
        list.prims.push(Prim { kind: K_GLYPH, group: 0, color: 0xff20_40c0, paint: NO_PAINT, a: [0.0; 4], b: [f32::from_bits(index as u32), 0.0, 0.0, 0.0], c: [0.0; 4] });
    }
    list.groups.push(Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 400.0, 200.0], layer: NO_LAYER });
    list.passes.push(Pass { depth: 0, start: 0, end: count as u32 });
    Arc::new(list)
}

/// The atlas keeps within its 64 MiB when the side of its pages changes. Its layers used to carry over from a texture of another
/// side: many small pages, then one large mask, made that many pages of 4,096² texels (a mask of 2,000 texels a side, then 300 of 64,
/// then the large one again measured 32, 5 and 80 MiB).
#[test]
fn the_glyph_atlas_stays_in_its_budget_when_the_side_of_its_pages_changes() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    const BUDGET: u64 = 64 << 20;
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 400.0, 200.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT };
    let (large, small) = (glyphs(1, 20.0), glyphs(300, 0.5));
    // An export sizes its pages by each frame; the stage lets them only grow, so it meets the large mask after the small ones.
    for (exact, order) in [(true, vec![&large, &small, &large]), (false, vec![&small, &large])] {
        let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        renderer.set_exact_sizes(exact);
        let mut bytes = Vec::new();
        for list in order {
            draw(&mut renderer, &device, &queue, list, &view);
            bytes.push(renderer.stats.glyph_bytes);
        }
        assert!(bytes.iter().all(|&b| b <= BUDGET), "exact {exact}: the atlas is within {BUDGET} bytes in every frame: {bytes:?}");
        let last = *bytes.last().unwrap();
        assert!(last >= 4096 * 4096, "exact {exact}: the large mask is on a page of 4,096 texels a side: {bytes:?}");
        if exact {
            assert!(bytes[1] > 0 && bytes[1] < 4096 * 4096, "the small masks are on smaller pages: {bytes:?}");
            assert_eq!(last, bytes[0], "the large mask needs what it needed before, not the layers the small pages grew to: {bytes:?}");
        } else {
            assert_eq!(last, 2 * 4096 * 4096, "the large mask needs two layers, not as many as the small pages had: {bytes:?}");
        }
    }
}
