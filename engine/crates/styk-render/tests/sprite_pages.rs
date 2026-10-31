//! A renderer that keeps a few pages of a document's sprite layout in its texture
//! (`Renderer::prepare_sprites_resident`, docs/engine/memory.md): a page draws what its layer holds, a
//! page without a layer draws nothing (never another page's picture), and a page that comes back after it
//! left draws exactly as it did before. Skipped where no GPU adapter exists.

use std::sync::Arc;

use styk_draw::{DrawList, Group, Pass, Prim, K_IMAGE, NO_LAYER};
use styk_eval::assets::{Assets, AtlasEntry, DecodedImage};
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

const SIZE: [u32; 2] = [64, 64];
const PICTURE: u32 = 16;
/// Page 1 and page 2 hold one picture each.
const PAGES: u32 = 3;
const COLORS: [[u8; 4]; 3] = [[0, 0, 0, 0], [220, 30, 30, 255], [30, 200, 60, 255]];

fn assets() -> Assets {
    let mut assets = Assets::default();
    assets.pages = PAGES;
    for page in 0..PAGES {
        assets.atlas.push(AtlasEntry { layer: page, x: 1, y: 1, w: PICTURE, h: PICTURE, source_w: PICTURE, source_h: PICTURE, valid: page > 0 });
    }
    assets
}

fn picture(page: u32) -> DecodedImage {
    let side = PICTURE + 2;
    let rgba = COLORS[page as usize].iter().copied().cycle().take((side * side * 4) as usize).collect();
    DecodedImage { index: page, drawing: false, width: side, height: side, rgba }
}

/// Page 1's picture at (4, 4) and page 2's at (36, 36), each 16 pixels square.
fn list() -> Arc<DrawList> {
    let sprite = |page: u32, at: f32| {
        let uv = [1.0 / 4096.0, 1.0 / 4096.0, (1 + PICTURE) as f32 / 4096.0, (1 + PICTURE) as f32 / 4096.0];
        Prim { kind: K_IMAGE, group: 0, color: 0xffff_ffff, paint: u32::MAX, a: [at, at, PICTURE as f32, 0.0], b: [0.0, PICTURE as f32, page as f32, 0.0], c: uv }
    };
    Arc::new(DrawList {
        prims: vec![sprite(1, 4.0), sprite(2, 36.0)],
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 64.0, 64.0], layer: NO_LAYER }],
        passes: vec![Pass { depth: 0, start: 0, end: 2 }],
        ..Default::default()
    })
}

fn view() -> ViewParams {
    ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0, 0.0], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT }
}

fn draw(renderer: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue) -> Vec<u8> {
    renderer.set_list(&list());
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view(), SIZE);
    queue.submit([encoder.finish()]);
    read_frame(device, queue, renderer.frame_texture().expect("a frame")).2
}

/// The pixel at the middle of the picture drawn at `at`.
fn centre(frame: &[u8], at: u32) -> [u8; 4] {
    let (x, y) = (at + PICTURE / 2, at + PICTURE / 2);
    let i = ((y * SIZE[0] + x) * 4) as usize;
    frame[i..i + 4].try_into().unwrap()
}

fn close(pixel: [u8; 4], color: [u8; 4]) -> bool {
    (0..4).all(|k| pixel[k].abs_diff(color[k]) <= 2)
}

#[test]
fn a_page_draws_from_its_layer_and_a_page_without_one_draws_nothing() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let assets = assets();
    let images: Vec<DecodedImage> = (1..PAGES).map(picture).collect();

    // The layout held whole: the frame every other state is compared with.
    let mut whole = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    whole.prepare_sprites(&assets);
    whole.upload_images(&assets, &images);
    let reference = draw(&mut whole, &device, &queue);
    assert!(close(centre(&reference, 4), COLORS[1]) && close(centre(&reference, 36), COLORS[2]), "the reference draws both pictures");

    // Two layers beside the empty one, for three pages: nothing is in until a page is given a layer.
    let mut kept = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    kept.prepare_sprites_resident(PAGES, 3);
    let blank = draw(&mut kept, &device, &queue);
    assert!(close(centre(&blank, 4), COLORS[0]) && close(centre(&blank, 36), COLORS[0]), "a page without a layer draws nothing");

    // Page 1 in layer 2 (not the layer of its number): its picture, and only its picture.
    kept.map_sprite_page(1, Some(2));
    kept.flush_sprite_map();
    kept.upload_images(&assets, &images);
    let first = draw(&mut kept, &device, &queue);
    assert!(close(centre(&first, 4), COLORS[1]), "page 1 draws its picture from layer 2");
    assert!(close(centre(&first, 36), COLORS[0]), "page 2 has no layer: not page 1's picture, not anything");

    // Page 2 takes layer 1, then page 1 leaves and page 2 is drawn in its place: layers are reused.
    kept.map_sprite_page(2, Some(1));
    kept.map_sprite_page(1, None);
    kept.flush_sprite_map();
    kept.upload_images(&assets, &images);
    let second = draw(&mut kept, &device, &queue);
    assert!(close(centre(&second, 36), COLORS[2]), "page 2 draws from layer 1");
    assert!(close(centre(&second, 4), COLORS[0]), "page 1 left: its old layer's picture is not drawn for it");

    // Page 1 comes back in the layer page 2 does not hold, uploaded again: the frame is the reference's, pixel for pixel.
    kept.map_sprite_page(1, Some(2));
    kept.flush_sprite_map();
    kept.upload_images(&assets, &images);
    let back = draw(&mut kept, &device, &queue);
    assert_eq!(back, reference, "a page that was taken away and uploaded again draws exactly as it did");

    // The texture grows for a working set it was too small for, keeping what it holds.
    kept.map_sprite_page(2, None);
    kept.resize_sprite_layers(4);
    kept.map_sprite_page(2, Some(3));
    kept.flush_sprite_map();
    kept.upload_images(&assets, &images);
    assert_eq!(kept.sprite_memory().0, 4);
    assert_eq!(draw(&mut kept, &device, &queue), reference, "growing the texture keeps the pictures in it");
}
