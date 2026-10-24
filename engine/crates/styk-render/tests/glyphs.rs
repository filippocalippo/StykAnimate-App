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
