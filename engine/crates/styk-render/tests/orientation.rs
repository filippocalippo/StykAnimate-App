//! A rotated or mirrored workspace view on the GPU (`Renderer::set_orientation`): the artboard
//! is a turned quad, the background follows it, the scene outside it shows on the pasteboard
//! unless the frame clips to the artboard. Skipped where no GPU adapter exists.

use std::sync::Arc;
use styk_draw::*;
use styk_eval::view::{compose, orientation};
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

const RED: u32 = 0xff00_00ff;
const BLUE: u32 = 0xffff_0000;
const WHITE: u32 = 0xffff_ffff;

fn tri(color: u32, p: [[f32; 2]; 3]) -> Prim {
    Prim { kind: K_TRI, group: 0, color, paint: NO_PAINT, a: [p[0][0], p[0][1], p[1][0], p[1][1]], b: [p[2][0], p[2][1], 0.0, 0.0], c: [0.0, 0.0, 10.0, 0.0] }
}

fn square(color: u32, x0: f32, y0: f32, x1: f32, y1: f32) -> [Prim; 2] {
    [tri(color, [[x0, y0], [x1, y0], [x1, y1]]), tri(color, [[x0, y0], [x1, y1], [x0, y1]])]
}

/// A white artboard, a blue square at its top left corner, and a red square left of it on the
/// pasteboard, in world units (the artboard is 40 × 20 at the world's origin).
fn scene() -> DrawList {
    let mut prims = vec![Prim { kind: K_FILL_VIEW, group: 0, color: WHITE, paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] }];
    prims.extend(square(BLUE, 0.0, 0.0, 10.0, 10.0));
    prims.extend(square(RED, -20.0, 0.0, -10.0, 10.0));
    let end = prims.len() as u32;
    DrawList {
        prims,
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [-20.0, 0.0, 40.0, 20.0], layer: NO_LAYER }],
        passes: vec![Pass { depth: 0, start: 0, end }],
        background_prims: 1,
        ..Default::default()
    }
}

struct Frame {
    width: u32,
    pixels: Vec<u8>,
}

impl Frame {
    fn at(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.width + x) * 4) as usize;
        [self.pixels[i], self.pixels[i + 1], self.pixels[i + 2], self.pixels[i + 3]]
    }
}

/// The scene on a 100 × 100 screen, the artboard at (30, 40), turned and mirrored as asked;
/// `None` where no GPU adapter exists.
fn draw(rotation: f64, flip: bool, clip_to_artboard: bool) -> Option<Frame> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return None;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_list(&Arc::new(scene()));
    let pan = [30.0, 40.0];
    let turn = orientation(rotation, flip, [pan[0] + 20.0, pan[1] + 10.0]);
    renderer.set_orientation(turn);
    let upright = [1.0, 0.0, 0.0, 1.0, pan[0], pan[1]];
    let view = ViewParams { matrix: turn.map_or(upright, |o| compose(o, upright)), artboard: [30.0, 40.0, 70.0, 60.0], clip_to_artboard, clear: [0.0; 4], zoom: 1.0, pan, stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT };
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view, [100, 100]);
    queue.submit([encoder.finish()]);
    let (width, _, pixels) = read_frame(&device, &queue, renderer.frame_texture().expect("a frame"));
    Some(Frame { width, pixels })
}

const NOTHING: [u8; 4] = [0, 0, 0, 0];
const WHITE_PIXEL: [u8; 4] = [255, 255, 255, 255];

#[test]
fn a_quarter_turn_moves_the_artboard_its_background_and_the_scene() {
    let Some(frame) = draw(std::f64::consts::FRAC_PI_2, false, false) else { return };
    assert_eq!(frame.at(45, 65), WHITE_PIXEL, "the turned artboard is white where the upright one was not");
    assert_eq!(frame.at(35, 50), NOTHING, "and bare where the upright one was");
    assert_eq!(frame.at(55, 35), [0, 0, 255, 255], "the square that was at its top left corner turned with it");
    assert_eq!(frame.at(55, 15), [255, 0, 0, 255], "the pasteboard shows the scene beyond the artboard");
}

#[test]
fn clipping_to_the_artboard_follows_the_turn() {
    let Some(frame) = draw(std::f64::consts::FRAC_PI_2, false, true) else { return };
    assert_eq!(frame.at(55, 15), NOTHING, "the pasteboard square is clipped by the turned artboard");
    assert_eq!(frame.at(55, 35), [0, 0, 255, 255], "the square inside it stays");
    assert_eq!(frame.at(45, 65), WHITE_PIXEL);
}

#[test]
fn a_mirror_swaps_the_artboard_about_its_centre() {
    let Some(frame) = draw(0.0, true, false) else { return };
    assert_eq!(frame.at(65, 45), [0, 0, 255, 255], "the blue square is at the right now");
    assert_eq!(frame.at(35, 45), WHITE_PIXEL, "the artboard is white where it was blue");
    assert_eq!(frame.at(85, 45), [255, 0, 0, 255], "the pasteboard square is on the right of the artboard");
}

#[test]
fn an_upright_view_draws_as_it_did() {
    let Some(frame) = draw(0.0, false, false) else { return };
    assert_eq!(frame.at(35, 45), [0, 0, 255, 255]);
    assert_eq!(frame.at(65, 55), WHITE_PIXEL);
    assert_eq!(frame.at(15, 45), [255, 0, 0, 255]);
}
