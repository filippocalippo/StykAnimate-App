//! A renderer that keeps a few pages of a document's sprite layout in its texture
//! (`Renderer::prepare_sprites_resident`, docs/engine/memory.md) draws every picture of the layout: the picture
//! itself when it is in the sprite texture, its soft copy (a texel to eight of the page's, always resident) when it is
//! not, and nothing while it has neither. A picture that was taken away and uploaded again draws exactly as it did,
//! and the swap from soft to sharp is a change of the table, not of any other pixel. Skipped where no GPU adapter exists.

use std::sync::Arc;

use styk_draw::{DrawList, Group, Pass, Prim, K_IMAGE, NO_LAYER};
use styk_eval::assets::{soft_rect, Assets, AtlasEntry, DecodedImage};
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

const SIZE: [u32; 2] = [64, 64];
const PICTURE: u32 = 16;
/// Page 1 and page 2 hold one picture each.
const PAGES: u32 = 3;
const NOTHING: [u8; 4] = [0; 4];
const SHARP: [[u8; 4]; 3] = [NOTHING, [220, 30, 30, 255], [30, 200, 60, 255]];
const SOFT: [[u8; 4]; 3] = [NOTHING, [20, 30, 230, 255], [230, 220, 20, 255]];

fn entry(layer: u32, x: u32, y: u32, side: u32) -> AtlasEntry {
    AtlasEntry { layer, x, y, w: side, h: side, source_w: side, source_h: side, valid: layer > 0 }
}

fn assets() -> Assets {
    let mut assets = Assets::default();
    assets.pages = PAGES;
    for page in 0..PAGES {
        assets.atlas.push(entry(page, 1, 1, PICTURE));
    }
    assets
}

fn sharp(assets: &Assets, picture: u32, color: [u8; 4]) -> DecodedImage {
    let e = &assets.atlas[picture as usize];
    let (w, h) = (e.w + 2, e.h + 2);
    DecodedImage { index: picture, drawing: false, soft: false, width: w, height: h, rgba: color.iter().copied().cycle().take((w * h * 4) as usize).collect() }
}

fn soft(assets: &Assets, picture: u32, color: [u8; 4]) -> DecodedImage {
    let (_, _, w, h) = soft_rect(&assets.atlas[picture as usize]);
    DecodedImage { index: picture, drawing: false, soft: true, width: w, height: h, rgba: color.iter().copied().cycle().take((w * h * 4) as usize).collect() }
}

/// A picture of the layout drawn as a `PICTURE` pixel square with its corner at `at`.
fn sprite(assets: &Assets, picture: usize, at: [f32; 2]) -> Prim {
    let e = &assets.atlas[picture];
    Prim { kind: K_IMAGE, group: 0, color: 0xffff_ffff, paint: u32::MAX, a: [at[0], at[1], PICTURE as f32, 0.0], b: [0.0, PICTURE as f32, e.layer as f32, 0.0], c: e.uv() }
}

fn list(prims: Vec<Prim>) -> Arc<DrawList> {
    let end = prims.len() as u32;
    Arc::new(DrawList {
        prims,
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 64.0, 64.0], layer: NO_LAYER }],
        passes: vec![Pass { depth: 0, start: 0, end }],
        ..Default::default()
    })
}

/// Page 1's picture at (4, 4) and page 2's at (36, 36).
fn two(assets: &Assets) -> Arc<DrawList> {
    list(vec![sprite(assets, 1, [4.0, 4.0]), sprite(assets, 2, [36.0, 36.0])])
}

fn view() -> ViewParams {
    ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0, 0.0], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT }
}

fn draw(renderer: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, list: &Arc<DrawList>) -> Vec<u8> {
    renderer.set_list(list);
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view(), SIZE);
    queue.submit([encoder.finish()]);
    read_frame(device, queue, renderer.frame_texture().expect("a frame")).2
}

/// The pixel at the middle of the square drawn at `at`.
fn centre(frame: &[u8], at: u32) -> [u8; 4] {
    let (x, y) = (at + PICTURE / 2, at + PICTURE / 2);
    let i = ((y * SIZE[0] + x) * 4) as usize;
    frame[i..i + 4].try_into().unwrap()
}

fn close(pixel: [u8; 4], color: [u8; 4]) -> bool {
    (0..4).all(|k| pixel[k].abs_diff(color[k]) <= 2)
}

fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return None;
    };
    Some(pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device"))
}

fn renderer(device: &wgpu::Device, queue: &wgpu::Queue) -> Renderer {
    Renderer::new(device, queue, wgpu::TextureFormat::Rgba8Unorm)
}

#[test]
fn a_picture_draws_soft_until_it_is_in_and_sharp_after_and_never_blank_between() {
    let Some((device, queue)) = device() else { return };
    let assets = assets();
    let list = two(&assets);
    let fulls: Vec<DecodedImage> = (1..PAGES).map(|p| sharp(&assets, p, SHARP[p as usize])).collect();
    let softs: Vec<DecodedImage> = (1..PAGES).map(|p| soft(&assets, p, SOFT[p as usize])).collect();

    // The layout held whole: the frame every other state is compared with.
    let mut whole = renderer(&device, &queue);
    whole.prepare_sprites(&assets);
    whole.upload_images(&assets, &fulls);
    let reference = draw(&mut whole, &device, &queue, &list);
    assert!(close(centre(&reference, 4), SHARP[1]) && close(centre(&reference, 36), SHARP[2]), "the reference draws both pictures");

    // Two layers for three pages: nothing is in, and nothing has a soft copy yet.
    let mut kept = renderer(&device, &queue);
    kept.prepare_sprites_resident(&assets, 0, 2);
    let nothing = draw(&mut kept, &device, &queue, &list);
    assert!(close(centre(&nothing, 4), NOTHING) && close(centre(&nothing, 36), NOTHING), "a picture with neither draws nothing");

    // Soft copies: every picture draws at once, from the soft atlas.
    kept.upload_images(&assets, &softs);
    let soft_frame = draw(&mut kept, &device, &queue, &list);
    assert!(close(centre(&soft_frame, 4), SOFT[1]) && close(centre(&soft_frame, 36), SOFT[2]), "pictures draw their soft copies");

    // A second renderer on the same device that shares the atlas (the camera monitor) draws the soft copies too.
    let mut monitor = renderer(&device, &queue);
    monitor.share_sprites(&kept);
    assert_eq!(draw(&mut monitor, &device, &queue, &list), soft_frame, "a view sharing the atlas draws a picture that is not in as the stage does");

    // Page 1 in layer 1 (not the layer of its number): its picture is sharp, page 2 is still soft.
    kept.map_sprite_page(1, Some(1));
    kept.flush_sprite_map();
    kept.upload_images(&assets, &fulls[..1]);
    let before_swap = draw(&mut kept, &device, &queue, &list);
    assert!(close(centre(&before_swap, 4), SOFT[1]), "pixels uploaded but not put in the table: still the soft copy, no blank, no half picture");
    kept.set_picture(&assets.atlas[1], Some(1));
    kept.flush_pictures();
    let first = draw(&mut kept, &device, &queue, &list);
    assert!(close(centre(&first, 4), SHARP[1]), "page 1's picture is sharp once it is in");
    assert!(close(centre(&first, 36), SOFT[2]), "page 2's is soft, not page 1's picture and not nothing");
    // Only the picture's own pixels changed between the two frames.
    let changed: Vec<usize> = (0..before_swap.len() / 4).filter(|&i| before_swap[i * 4..i * 4 + 4] != first[i * 4..i * 4 + 4]).collect();
    assert!(!changed.is_empty() && changed.iter().all(|&i| (i as u32 % SIZE[0]) < 24 && (i as u32 / SIZE[0]) < 24), "the swap changes the picture's pixels and no others");

    // Page 1 leaves: its soft copy again, and nothing else changes.
    kept.map_sprite_page(1, None);
    kept.set_picture(&assets.atlas[1], None);
    kept.flush_sprite_map();
    kept.flush_pictures();
    let left = draw(&mut kept, &device, &queue, &list);
    assert!(close(centre(&left, 4), SOFT[1]) && close(centre(&left, 36), SOFT[2]), "a picture that left draws its soft copy, never blank");

    // Both back, in layers that are not their numbers: the frame is the reference's, pixel for pixel.
    kept.map_sprite_page(1, Some(1));
    kept.map_sprite_page(2, Some(0));
    kept.flush_sprite_map();
    kept.upload_images(&assets, &fulls);
    kept.set_picture(&assets.atlas[1], Some(1));
    kept.set_picture(&assets.atlas[2], Some(0));
    kept.flush_pictures();
    assert_eq!(draw(&mut kept, &device, &queue, &list), reference, "pictures taken away and uploaded again draw exactly as they did");

    // The layout grows (a revision appended pictures): the table holds the new pictures, what was in stays in, and
    // the soft copies are kept.
    let mut larger = assets.clone();
    larger.pages = PAGES + 6;
    larger.atlas.push(entry(PAGES + 5, 1, 1, PICTURE));
    kept.extend_pictures(&larger);
    assert_eq!(draw(&mut kept, &device, &queue, &list), reference, "growing the layout keeps the pictures in");
    kept.set_picture(&assets.atlas[1], None);
    kept.set_picture(&assets.atlas[2], None);
    kept.flush_pictures();
    let after = draw(&mut kept, &device, &queue, &list);
    assert!(close(centre(&after, 4), SOFT[1]) && close(centre(&after, 36), SOFT[2]), "growing the layout keeps the soft copies");

    // The texture grows for a working set it was too small for, keeping what it holds.
    kept.resize_sprite_layers(4);
    assert_eq!(kept.sprite_memory().0, 4);
    kept.set_picture(&assets.atlas[1], Some(1));
    kept.set_picture(&assets.atlas[2], Some(0));
    kept.flush_pictures();
    assert_eq!(draw(&mut kept, &device, &queue, &list), reference, "growing the texture keeps the pictures in it");

    // A picture uploaded in bands of rows, a few a frame, draws as one uploaded whole.
    let mut banded = renderer(&device, &queue);
    banded.prepare_sprites_resident(&assets, 0, 2);
    banded.map_sprite_page(1, Some(1));
    banded.map_sprite_page(2, Some(0));
    banded.flush_sprite_map();
    for image in &fulls {
        for first in (0..image.height).step_by(5) {
            banded.upload_rows(&assets, image, first, 5);
        }
    }
    banded.set_picture(&assets.atlas[1], Some(1));
    banded.set_picture(&assets.atlas[2], Some(0));
    banded.flush_pictures();
    assert_eq!(draw(&mut banded, &device, &queue, &list), reference, "pictures uploaded in bands of rows draw as they do whole");
}

/// Many pictures on one page: the table finds each, whichever of them are in.
#[test]
fn the_picture_table_finds_every_picture_of_a_crowded_page() {
    let Some((device, queue)) = device() else { return };
    let mut assets = Assets::default();
    assets.pages = 2;
    // 64 pictures of 40 pixels on page 1, 8 a row, drawn as squares of 5 pixels, so the corners hash all over the table.
    for i in 0..64u32 {
        assets.atlas.push(entry(1, 1 + (i % 8) * 77, 1 + (i / 8) * 53, 40));
    }
    let prims: Vec<Prim> = (0..64usize)
        .map(|i| {
            let mut prim = sprite(&assets, i, [(i % 8) as f32 * 8.0, (i / 8) as f32 * 8.0]);
            prim.a[2] = 5.0;
            prim.b[1] = 5.0;
            prim
        })
        .collect();
    let list = list(prims);
    let color = |i: u32, full: bool| if full { [200, (i * 3) as u8, 40, 255] } else { [40, (i * 3) as u8, 200, 255] };
    let mut kept = renderer(&device, &queue);
    kept.prepare_sprites_resident(&assets, 0, 2);
    kept.map_sprite_page(1, Some(0));
    kept.flush_sprite_map();
    for i in 0..64u32 {
        let e = &assets.atlas[i as usize];
        let (w, h) = (e.w + 2, e.h + 2);
        let sharp = DecodedImage { index: i, drawing: false, soft: false, width: w, height: h, rgba: color(i, true).iter().copied().cycle().take((w * h * 4) as usize).collect() };
        let (_, _, sw, sh) = soft_rect(e);
        let soft = DecodedImage { index: i, drawing: false, soft: true, width: sw, height: sh, rgba: color(i, false).iter().copied().cycle().take((sw * sh * 4) as usize).collect() };
        kept.upload_images(&assets, [&soft, &sharp]);
        // Every third picture is in; the rest draw soft.
        if i % 3 == 0 {
            kept.set_picture(e, Some(0));
        }
    }
    kept.flush_pictures();
    let frame = draw(&mut kept, &device, &queue, &list);
    for i in 0..64u32 {
        let (x, y) = ((i % 8) * 8 + 2, (i / 8) * 8 + 2);
        let at = ((y * SIZE[0] + x) * 4) as usize;
        let pixel: [u8; 4] = frame[at..at + 4].try_into().unwrap();
        assert!(close(pixel, color(i, i % 3 == 0)), "picture {i}: {pixel:?}");
    }
}

/// A page the table has no row for draws nothing, and never another page's picture.
#[test]
fn a_page_beyond_the_table_draws_nothing() {
    let Some((device, queue)) = device() else { return };
    let mut assets = assets();
    // A picture on a page past the table's rows (the layout's own page count is small: a texture for it would be huge).
    let beyond = styk_render::MAX_PAGES + 4;
    assets.atlas.push(entry(beyond, 1, 1, PICTURE));
    let far = assets.atlas.len() - 1;
    let mut kept = renderer(&device, &queue);
    kept.prepare_sprites_resident(&assets, 0, 2);
    let softs: Vec<DecodedImage> = (1..PAGES).map(|p| soft(&assets, p, SOFT[p as usize])).collect();
    kept.upload_images(&assets, &softs);
    // Its soft copy is refused too.
    kept.upload_images(&assets, [&soft(&assets, far as u32, SOFT[1])]);
    let list = list(vec![sprite(&assets, 1, [4.0, 4.0]), sprite(&assets, far, [36.0, 36.0])]);
    let frame = draw(&mut kept, &device, &queue, &list);
    assert!(close(centre(&frame, 4), SOFT[1]), "pages inside the table draw as before");
    assert!(close(centre(&frame, 36), NOTHING), "a page beyond the table draws nothing");
}
