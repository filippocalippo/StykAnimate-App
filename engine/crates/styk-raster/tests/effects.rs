//! Filter effects on both renderers: a filtered group is drawn on its entry's grid, its effect
//! recipe (`styk_render::effects::recipe`) run on its pixels, then composited. Each test states
//! what is drawn and checks it on the CPU and, where the machine has a graphics adapter, on the GPU.

use std::sync::{Arc, OnceLock};

use styk_draw::{DrawList, EffectLayer, Effects, Group, LayerKind, Pass, Prim, K_COMPOSITE, K_TRI, NO_LAYER, NO_PAINT};
use styk_eval::vfx::registry::{Blur, Params, Tint};
use styk_eval::vfx::{Color, Effect};
use styk_raster::{Edges, Images, ViewParams};

/// An opaque red square (x 20–44, y 20–44) in a group filtered by `effects`, on a 64×64 view.
fn filtered(effects: Vec<Effect>) -> DrawList {
    let square = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| Prim { kind: K_TRI, group: 1, color: 0xff00_00ff, paint: NO_PAINT, a: [a[0], a[1], b[0], b[1]], b: [c[0], c[1], 0.0, 0.0], c: [0.0; 4] };
    let composite = Prim { kind: K_COMPOSITE, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [0.0, 0.0, 64.0, 64.0], b: [f32::from_bits(1), 0.0, 0.0, 0.0], c: [0.0; 4] };
    let stack: Effects = Arc::new(effects.into_iter().map(Arc::new).collect::<Vec<_>>());
    let layer = EffectLayer { effects: Some(stack), kind: LayerKind::Entry { bounds: [4.0, 4.0, 56.0, 56.0], domain: [20.0, 20.0, 24.0, 24.0], scale: 1.0, padding: 16.0, single_drawing: false } };
    DrawList {
        prims: vec![square([20.0, 20.0], [44.0, 20.0], [44.0, 44.0]), square([20.0, 20.0], [44.0, 44.0], [20.0, 44.0]), composite],
        groups: vec![
            Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 64.0, 64.0], layer: NO_LAYER },
            Group { parent: 0, depth: 1, opacity: 1.0, bounds: [4.0, 4.0, 60.0, 60.0], layer: 0 },
        ],
        passes: vec![Pass { depth: 1, start: 0, end: 2 }, Pass { depth: 0, start: 2, end: 3 }],
        layers: vec![layer],
        ..Default::default()
    }
}

fn draw(list: &DrawList) -> Vec<u8> {
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: 2048.0 };
    styk_raster::render(list, &Images::default(), &view, [64, 64], Edges::Smooth).pixels
}

fn at(pixels: &[u8], x: usize, y: usize) -> [u8; 4] {
    pixels[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4].try_into().unwrap()
}

#[test]
fn a_tint_recolours_the_layer() {
    let tint = Effect { id: Arc::from("t"), enabled: true, params: Params::Tint(Tint { color: Color::Rgb(0x0000ff), mix: 1.0, ..Default::default() }) };
    let pixels = draw(&filtered(vec![tint]));
    assert_eq!(at(&pixels, 32, 32), [0, 0, 255, 255], "the square is blue");
    assert_eq!(at(&pixels, 10, 10), [0, 0, 0, 0], "nothing around it");
}

#[test]
fn a_blur_spreads_the_layer() {
    let blur = Effect { id: Arc::from("b"), enabled: true, params: Params::Blur(Blur { radius: 6.0, ..Default::default() }) };
    let (plain, blurred) = (draw(&filtered(vec![])), draw(&filtered(vec![blur])));
    assert_eq!(at(&plain, 17, 32)[3], 0);
    assert!(at(&blurred, 17, 32)[3] > 20, "the blur reaches past the square's edge: {:?}", at(&blurred, 17, 32));
    assert!(at(&blurred, 21, 32)[3] < 255, "and softens it: {:?}", at(&blurred, 21, 32));
    let middle = at(&blurred, 32, 32);
    assert!(middle[0] >= 254 && middle[1] == 0 && middle[2] == 0 && middle[3] >= 254, "the middle stays red (a Gaussian's tail takes less than a level): {middle:?}");
}

// ---- Both renderers ------------------------------------------------------------------------------------------------------

/// This machine's graphics device, made once for the file (`None` where there is no adapter: the GPU half is skipped).
fn gpu() -> Option<&'static (styk_render::wgpu::Device, styk_render::wgpu::Queue)> {
    use styk_render::wgpu;
    static GPU: OnceLock<Option<(wgpu::Device, wgpu::Queue)>> = OnceLock::new();
    GPU.get_or_init(|| {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits: adapter.limits(), ..Default::default() })).ok()
    })
    .as_ref()
}

/// `list` drawn on the GPU, straight RGBA, or `None` without an adapter.
fn draw_gpu(list: &DrawList, images: &Images, view: &ViewParams, size: [u32; 2]) -> Option<Vec<u8>> {
    let (device, queue) = gpu()?;
    let mut renderer = styk_render::Renderer::new(device, queue, styk_render::wgpu::TextureFormat::Rgba8Unorm);
    let _ = images;
    renderer.set_list(&Arc::new(list.clone()));
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, view, size);
    queue.submit([encoder.finish()]);
    Some(styk_render::read_frame(device, queue, renderer.frame_texture().expect("a frame")).2)
}

/// `list` on both renderers: the CPU's pixels, and the GPU's where there is an adapter.
fn draw_both(list: &DrawList, view: &ViewParams, size: [u32; 2]) -> Vec<(&'static str, Vec<u8>)> {
    let images = Images::default();
    let mut out = vec![("cpu", styk_raster::render(list, &images, view, size, Edges::Smooth).pixels)];
    if let Some(gpu) = draw_gpu(list, &images, view, size) {
        out.push(("gpu", gpu));
    }
    out
}

fn pixel(pixels: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let at = ((y * width + x) * 4) as usize;
    pixels[at..at + 4].try_into().unwrap()
}

fn near(a: [u8; 4], b: [u8; 4], levels: u8) -> bool {
    (0..4).all(|k| a[k].abs_diff(b[k]) <= levels)
}

// ---- Documents -----------------------------------------------------------------------------------------------------------

/// A document of one figure on an 80×60 canvas: a black stroke 8 units thick from (12, 30) to (68, 30), the scene's stack
/// `scene` (saved effects, JSON) and the camera `camera` (a keyframe's camera, JSON).
fn stroke_document(scene: &str, camera: &str) -> styk_eval::eval::Prepared {
    let json = format!(
        r#"{{"version":5,"canvas_width":80,"canvas_height":60,"fps":24,"backgrounds":[],
        "figure_types":[{{"figure_type_id":1,"name":"F","segment_count":1,"segments":[{{"segment_id":1,"parent_id":0,"length":56,"angle_rad":0,"thickness":8,"bend_rad":0,"primitive_code":0,"aux_code":0,"flags":0,"segment_type":"line","segment_kind":"line","color_rgb":[0,0,0],"transparency":0,"visible":true,"z_order":1,"is_static":false}}],"polyfills":[],"image_assets":[],"text_assets":[]}}],
        "keyframes":[{{"duration_raw":1,"background_id":0,"background_id_b":0,"background_mix":0,"camera":{camera},
        "objects":[{{"object_slot":0,"unique_id":1,"figure_type_id":1,"root_x":12,"root_y":30,"scale":1,"color_override_raw":0,"field28":0,"angles":[0],"len_flag":0,"lengths":[],"bend_flag":0,"bends":[],"join":null}}],
        "object_draw_order":[0],"object_draw_order_unique_ids":[1],"_stykVfx":{{"figure":{scene}}}}}]}}"#
    );
    styk_eval::prepare(styk_eval::open_bytes(json.as_bytes(), "json", "stroke").expect("the document opens"))
}

const DEFAULT_CAMERA: &str = r#"{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0}"#;

/// The draw list of tick 0 and the view that shows the canvas at `zoom` with a 10-pixel margin: through the camera
/// (`camera_view`, playback and export) or in the neutral workspace.
fn scene_frame(prepared: &styk_eval::eval::Prepared, zoom: f64, camera_view: bool, clear: [f64; 4]) -> (DrawList, ViewParams, [u32; 2]) {
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let frame = prepared.evaluate(0.0);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let list = styk_eval::drawlist::encode(&prepared.doc, &assets, &scene);
    let (cw, ch) = (prepared.doc.canvas[0] as f64, prepared.doc.canvas[1] as f64);
    let pan = [10.0, 10.0];
    let size = [(cw * zoom + 20.0) as u32, (ch * zoom + 20.0) as u32];
    let view = ViewParams {
        matrix: styk_eval::view::camera_matrix(&prepared.doc, if camera_view { scene.camera.as_ref() } else { None }, zoom, pan),
        artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom],
        clip_to_artboard: true,
        clear,
        zoom,
        pan,
        stretch: 1.0,
        camera_view,
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    };
    (list, view, size)
}

const BACKDROP: [f64; 4] = [0.2, 0.3, 0.4, 1.0];
const BACKDROP8: [u8; 4] = [51, 77, 102, 255];
/// A scene dissolve that has taken everything: the camera image is transparent everywhere.
const DISSOLVED: &str = r#"[{"version":2,"id":"d","type":"dissolve","enabled":true,"params":{"effectStrength":1,"progress":1}}]"#;

/// Through the camera, a scene stack's transparent pixels show the backdrop the canvas is drawn on, never the unfiltered
/// scene: the scene is drawn once, inside the camera image (docs/engine/vfx.md, "The camera image").
#[test]
fn a_scene_dissolve_shows_the_backdrop_through_the_camera() {
    let prepared = stroke_document(DISSOLVED, DEFAULT_CAMERA);
    let (list, view, size) = scene_frame(&prepared, 1.0, true, BACKDROP);
    for (renderer, pixels) in draw_both(&list, &view, size) {
        for (x, y) in [(10 + 40, 10 + 30), (10 + 5, 10 + 5), (10 + 70, 10 + 50)] {
            let got = pixel(&pixels, size[0], x, y);
            assert!(near(got, BACKDROP8, 1), "{renderer}: ({x}, {y}) is {got:?}, the backdrop is {BACKDROP8:?}");
        }
    }
}

/// In the workspace, the camera rectangle shows the camera image alone; artwork outside it is still drawn unfiltered.
#[test]
fn the_workspace_shows_the_camera_image_alone_inside_the_camera_rectangle() {
    // The camera looks at the middle half of the canvas: x 20–60, y 15–45.
    let prepared = stroke_document(DISSOLVED, r#"{"is_default":false,"x":0,"y":0,"scale":0.5,"angle_rad":0}"#);
    let (list, view, size) = scene_frame(&prepared, 1.0, false, BACKDROP);
    for (renderer, pixels) in draw_both(&list, &view, size) {
        let inside = pixel(&pixels, size[0], 10 + 40, 10 + 30);
        assert!(near(inside, BACKDROP8, 1), "{renderer}: the stroke inside the camera rectangle is dissolved to the backdrop: {inside:?}");
        let stroke = pixel(&pixels, size[0], 10 + 14, 10 + 30);
        assert!(near(stroke, [0, 0, 0, 255], 2), "{renderer}: the stroke outside the camera rectangle is drawn unfiltered: {stroke:?}");
        let canvas = pixel(&pixels, size[0], 10 + 5, 10 + 5);
        assert!(near(canvas, [255, 255, 255, 255], 2), "{renderer}: the canvas outside the camera rectangle: {canvas:?}");
    }
}

/// Without a scene stack nothing changes, and with one that keeps everything the camera image is the scene itself.
#[test]
fn a_neutral_scene_stack_draws_the_scene_as_it_is() {
    let plain = stroke_document("[]", DEFAULT_CAMERA);
    let tinted = stroke_document(r#"[{"version":2,"id":"t","type":"tint","enabled":true,"params":{"effectStrength":1,"color":255,"mix":0.001}}]"#, DEFAULT_CAMERA);
    for camera_view in [true, false] {
        let (list, view, size) = scene_frame(&plain, 1.0, camera_view, BACKDROP);
        let (filtered, _, _) = scene_frame(&tinted, 1.0, camera_view, BACKDROP);
        for ((renderer, a), (_, b)) in draw_both(&list, &view, size).into_iter().zip(draw_both(&filtered, &view, size)) {
            for (x, y) in [(10 + 40, 10 + 30), (10 + 5, 10 + 5), (3, 3)] {
                let (pa, pb) = (pixel(&a, size[0], x, y), pixel(&b, size[0], x, y));
                assert!(near(pa, pb, 2), "{renderer}, camera view {camera_view}: ({x}, {y}) {pa:?} against {pb:?}");
            }
        }
    }
}
