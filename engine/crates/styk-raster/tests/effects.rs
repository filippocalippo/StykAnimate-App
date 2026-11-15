//! Filter effects on both renderers: a filtered group is drawn on its entry's grid, its effect
//! recipe (`styk_render::effects::recipe`) run on its pixels, then composited. Each test states
//! what is drawn and checks it on the CPU and, where the machine has a graphics adapter, on the GPU.

use std::sync::{Arc, OnceLock};

use styk_draw::{DrawList, EffectLayer, Effects, Group, LayerKind, Pass, Prim, K_COMPOSITE, K_TRI, NO_LAYER, NO_PAINT};
use styk_eval::vfx::registry::{Blur, BlurMode, Outline, Params, Pixelate, Tint};
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
    draw_gpu_at(list, images, view, size, true)
}

/// `draw_gpu` with effect images between passes in half floats (`float`) or eight bits, as WebGL2 without half-float
/// targets has them.
fn draw_gpu_at(list: &DrawList, images: &Images, view: &ViewParams, size: [u32; 2], float: bool) -> Option<Vec<u8>> {
    let (device, queue) = gpu()?;
    let mut renderer = styk_render::Renderer::new(device, queue, styk_render::wgpu::TextureFormat::Rgba8Unorm);
    renderer.set_float_effects(float);
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

/// Light over transparency (a generated effect's glow on a transparent background: colour beyond its coverage, docs/engine/vfx.md
/// "Light and paint") goes through a colour filter as the colour it shows, with its coverage: a tint recolours it, a grade
/// grades it, grain and a light sweep keep it, instead of dividing it by an alpha of nothing and losing it. Paint is filtered as
/// before.
#[test]
fn colour_filters_keep_light_over_transparency() {
    use styk_draw::{particle_kind, P_DISC};
    use styk_eval::vfx::registry::{Grade, LightSweep, Noise};
    // An orange disc (radius 12) at (32, 32), all light (`emissive` 1) or all paint, in a layer filtered by `effects`.
    let disc = |emissive: f32, effects: Vec<Effect>| {
        let mut list = filtered(effects);
        list.prims[0] = Prim { kind: particle_kind(P_DISC), group: 1, color: 0, paint: 0, a: [32.0, 32.0, 12.0, 0.0], b: [0.0, 0.0, emissive, 0.0], c: [1.0, 0.5, 0.0, 1.0] };
        list.prims.remove(1);
        list.passes = vec![Pass { depth: 1, start: 0, end: 1 }, Pass { depth: 0, start: 1, end: 2 }];
        list.paints = vec![[1.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0], [0.0, 1.0, 1.0, 0.0], [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4]];
        list
    };
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 64.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: 2048.0 };
    let middle = |list: &DrawList| draw_both(list, &view, [64, 64]).into_iter().map(|(renderer, pixels)| (renderer, pixel(&pixels, 64, 32, 32))).collect::<Vec<_>>();
    let effect = |params: Params| Effect { id: Arc::from("e"), enabled: true, params };
    let blue = || effect(Params::Tint(Tint { color: Color::Rgb(0x0000ff), mix: 1.0, ..Default::default() }));
    for (renderer, got) in middle(&disc(1.0, vec![])) {
        assert!(near(got, [255, 128, 0, 0], 2), "{renderer}: unfiltered light is orange beyond its coverage: {got:?}");
    }
    for (renderer, got) in middle(&disc(1.0, vec![blue()])) {
        assert!(near(got, [0, 0, 255, 0], 2), "{renderer}: a blue tint turns the light blue: {got:?}");
    }
    for (renderer, got) in middle(&disc(0.0, vec![blue()])) {
        assert!(near(got, [0, 0, 255, 255], 2), "{renderer}: and the paint blue, as before: {got:?}");
    }
    // A saturating grade keeps the light, more saturated; faint grain and a sweep whose band is elsewhere keep it as it is.
    let grade = effect(Params::Grade(Grade { saturation: 2.0, ..Default::default() }));
    for (renderer, got) in middle(&disc(1.0, vec![grade])) {
        // Saturation 2 about the luminance l = 0.2126 + 0.7152 × 0.5 = 0.570: green 2 × 0.5 − l = 0.43 (110), red and blue clamp.
        assert!(near(got, [255, 110, 0, 0], 2), "{renderer}: a saturating grade keeps the light, more saturated: {got:?}");
    }
    let quiet = vec![effect(Params::Noise(Noise { amount: 0.01, ..Default::default() })), effect(Params::LightSweep(LightSweep { position: -0.5, ..Default::default() }))];
    for (renderer, got) in middle(&disc(1.0, quiet)) {
        assert!(near(got, [255, 128, 0, 0], 3), "{renderer}: faint grain and a sweep elsewhere keep the light: {got:?}");
    }
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

/// A frame pass that holds depth-tested faces (a spatial figure drawn outside any layer) has a depth buffer, and the camera
/// rectangle's clear is drawn in that same pass: it draws there too, and the faces draw as they do without a scene stack.
#[test]
fn the_camera_rectangle_clears_in_a_pass_with_faces() {
    use styk_draw::{F_DEPTH, K_DEPTH_RESET};
    let prepared = stroke_document(DISSOLVED, r#"{"is_default":false,"x":0,"y":0,"scale":0.5,"angle_rad":0}"#);
    let (mut list, view, size) = scene_frame(&prepared, 1.0, false, BACKDROP);
    // A green square of two faces at canvas x 2–10, y 2–10 (outside the camera rectangle), drawn last in the root.
    let (x0, y0, x1, y1) = (2.0, 2.0, 10.0, 10.0);
    let face = |a: [f32; 4], b: [f32; 2]| Prim { kind: K_TRI | F_DEPTH, group: 0, color: 0xff00_ff00, paint: NO_PAINT, a, b: [b[0], b[1], 5.0, 5.0], c: [5.0, 0.0, 10.0, 0.0] };
    let reset = Prim { kind: K_DEPTH_RESET, group: 0, color: 0, paint: NO_PAINT, a: [x0, y0, x1, y1], b: [0.0; 4], c: [0.0; 4] };
    let root = list.passes.iter_mut().filter(|p| p.depth == 0).max_by_key(|p| p.end).expect("a root pass");
    assert_eq!(root.end as usize, list.prims.len(), "the root pass ends the list");
    list.prims.extend([reset, face([x0, y0, x1, y0], [x1, y1]), face([x0, y0, x1, y1], [x0, y1])]);
    root.end = list.prims.len() as u32;
    for (renderer, pixels) in draw_both(&list, &view, size) {
        let square = pixel(&pixels, size[0], 10 + 6, 10 + 6);
        assert!(near(square, [0, 255, 0, 255], 1), "{renderer}: the faces are drawn: {square:?}");
        let inside = pixel(&pixels, size[0], 10 + 40, 10 + 30);
        assert!(near(inside, BACKDROP8, 1), "{renderer}: the camera rectangle is still cleared and dissolved: {inside:?}");
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

// ---- The filter core: what each operation draws -----------------------------------------------------------------------

/// Colours of the shapes the tests draw (the draw list's packed RGBA: alpha, blue, green, red from the top byte).
const RED: u32 = 0xff00_00ff;

/// Opaque rectangles (x0, y0, x1, y1 in world units, a colour) in one group filtered by `effects`: an entry layer whose
/// effect domain is the rectangles' bounds, grown by the stack's padding.
fn shapes(rects: &[([f32; 4], u32)], effects: Vec<Effect>) -> DrawList {
    let mut prims = Vec::new();
    for &(r, color) in rects {
        let tri = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| Prim { kind: K_TRI, group: 1, color, paint: NO_PAINT, a: [a[0], a[1], b[0], b[1]], b: [c[0], c[1], 0.0, 0.0], c: [0.0; 4] };
        prims.push(tri([r[0], r[1]], [r[2], r[1]], [r[2], r[3]]));
        prims.push(tri([r[0], r[1]], [r[2], r[3]], [r[0], r[3]]));
    }
    let domain = rects.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, (r, _)| [b[0].min(r[0] as f64), b[1].min(r[1] as f64), b[2].max(r[2] as f64), b[3].max(r[3] as f64)]);
    let stack: Vec<Arc<Effect>> = effects.into_iter().map(Arc::new).collect();
    let pad = styk_eval::vfx::padding(&stack, 1.0, 0.0) + 3.0;
    let bounds = [domain[0] - pad, domain[1] - pad, domain[2] - domain[0] + 2.0 * pad, domain[3] - domain[1] + 2.0 * pad];
    let count = prims.len() as u32;
    prims.push(Prim { kind: K_COMPOSITE, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [0.0; 4], b: [f32::from_bits(1), 0.0, 0.0, 0.0], c: [0.0; 4] });
    let effects: Effects = Arc::new(stack);
    DrawList {
        prims,
        groups: vec![
            Group { parent: 0, depth: 0, opacity: 1.0, bounds: [-1e5, -1e5, 1e5, 1e5], layer: NO_LAYER },
            Group { parent: 0, depth: 1, opacity: 1.0, bounds: [bounds[0] as f32, bounds[1] as f32, (bounds[0] + bounds[2]) as f32, (bounds[1] + bounds[3]) as f32], layer: 0 },
        ],
        passes: vec![Pass { depth: 1, start: 0, end: count }, Pass { depth: 0, start: count, end: count + 1 }],
        layers: vec![EffectLayer { effects: Some(effects), kind: LayerKind::Entry { bounds, domain: [domain[0], domain[1], domain[2] - domain[0], domain[3] - domain[1]], scale: 1.0, padding: pad, single_drawing: false } }],
        ..Default::default()
    }
}

/// A view of `size` pixels at `zoom` pixels a world unit, on a transparent clear.
fn zoomed(size: [u32; 2], zoom: f64) -> ViewParams {
    ViewParams { matrix: [zoom, 0.0, 0.0, zoom, 0.0, 0.0], artboard: [0.0, 0.0, size[0] as f64, size[1] as f64], clip_to_artboard: false, clear: [0.0; 4], zoom, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: 2048.0 }
}

fn effect(params: Params) -> Effect {
    Effect { id: Arc::from("e"), enabled: true, params }
}

/// The normal distribution's cumulative function (Abramowitz and Stegun 7.1.26, within 1.5e-7).
fn phi(x: f64) -> f64 {
    let z = x.abs() / std::f64::consts::SQRT_2;
    let t = 1.0 / (1.0 + 0.327_591_1 * z);
    let erf = 1.0 - t * (0.254_829_592 + t * (-0.284_496_736 + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429)))) * (-z * z).exp();
    if x >= 0.0 { 0.5 * (1.0 + erf) } else { 0.5 * (1.0 - erf) }
}

fn alpha_row(pixels: &[u8], width: u32, y: u32) -> Vec<f64> {
    (0..width).map(|x| pixel(pixels, width, x, y)[3] as f64).collect()
}

/// A blur is the Gaussian of its radius (σ = 0.57735 × radius pixels), at every size: across the straight edge of a large
/// shape, the blurred alpha is the normal distribution's cumulative function, to a few levels, wherever the blur halves the
/// layer (radii 25 and 60 do; 4 and 10 do not). (Below a σ of about 2 pixels any kernel on pixels departs from the continuous
/// curve; that a tiny radius is a tiny blur is `a_blur_grows_continuously_with_its_radius`'s.)
#[test]
fn a_blur_is_the_gaussian_of_its_radius() {
    let size = [760, 440];
    for radius in [4.0, 10.0, 25.0, 60.0] {
        let sigma = 0.57735 * radius;
        let list = shapes(&[([300.0, 20.0, 700.0, 420.0], RED)], vec![effect(Params::Blur(Blur { radius, ..Default::default() }))]);
        for (renderer, pixels) in draw_both(&list, &zoomed(size, 1.0), size) {
            let row = alpha_row(&pixels, size[0], 220);
            let (mut worst, mut total, mut n) = (0.0f64, 0.0, 0.0);
            let reach = (3.5 * sigma).ceil() as i64 + 2;
            for x in 300 - reach..300 + reach {
                let expected = 255.0 * phi((x as f64 + 0.5 - 300.0) / sigma);
                let error = (row[x as usize] - expected).abs();
                worst = worst.max(error);
                total += error;
                n += 1.0;
            }
            eprintln!("{renderer} radius {radius}: worst {worst:.2} levels, mean {:.2}", total / n);
            assert!(worst <= 4.0 && total / n <= 1.5, "{renderer} radius {radius}: the edge is the Gaussian's to {worst:.1} levels (mean {:.2})", total / n);
        }
    }
}

/// A blur grows continuously with its radius, through the sizes at which it halves the layer once more (radii 5.2, 10.4,
/// 20.8, 41.6), and a radius of a fraction of a pixel is a fraction of a pixel's blur. Renders 121 radii on both renderers:
/// about two seconds.
#[test]
fn a_blur_grows_continuously_with_its_radius() {
    let size = [480, 320];
    let probes = [(185u32, "outside"), (196, "near outside"), (204, "near inside")];
    let mut previous: Vec<Option<Vec<f64>>> = vec![None, None];
    let mut largest = [0.0f64; 2];
    for step in 0..=120 {
        let radius = step as f64 * 0.5;
        let list = shapes(&[([200.0, 20.0, 420.0, 300.0], RED)], if radius == 0.0 { vec![] } else { vec![effect(Params::Blur(Blur { radius, ..Default::default() }))] });
        for (k, (renderer, pixels)) in draw_both(&list, &zoomed(size, 1.0), size).into_iter().enumerate() {
            let values: Vec<f64> = probes.iter().map(|&(x, _)| pixel(&pixels, size[0], x, 160)[3] as f64).collect();
            if let Some(before) = &previous[k] {
                for (i, (&now, &was)) in values.iter().zip(before).enumerate() {
                    let jump = (now - was).abs();
                    largest[k] = largest[k].max(jump);
                    assert!(jump <= 6.0, "{renderer}: radius {} to {radius}: the {} probe jumps {jump} levels", radius - 0.5, probes[i].1);
                }
            }
            previous[k] = Some(values);
        }
    }
    eprintln!("largest step between radii 0.5 apart: {largest:?} levels");
    // A tenth of a pixel's radius: the edge moves by a level or two, not by a pixel's blur.
    let plain = shapes(&[([200.0, 20.0, 420.0, 300.0], RED)], vec![]);
    let tiny = shapes(&[([200.0, 20.0, 420.0, 300.0], RED)], vec![effect(Params::Blur(Blur { radius: 0.2, ..Default::default() }))]);
    for ((renderer, a), (_, b)) in draw_both(&plain, &zoomed(size, 1.0), size).into_iter().zip(draw_both(&tiny, &zoomed(size, 1.0), size)) {
        let (outside, inside) = (pixel(&b, size[0], 199, 160)[3], pixel(&b, size[0], 200, 160)[3]);
        assert_eq!(pixel(&a, size[0], 199, 160)[3], 0);
        assert!(outside <= 12 && inside >= 243, "{renderer}: a 0.2 radius blurs the edge by a few levels: {outside} outside, {inside} inside");
    }
}

/// A one-pixel line blurred far keeps its energy (every source pixel counts when the layer is halved) and holds still when it
/// moves by fractions of a pixel (nothing aliases). Blurred this far the line is a level or three of alpha, which the dither
/// spreads over neighbouring levels: the row measured is the average of the 200 middle rows. (Not at exactly half a pixel: the
/// layer is then drawn half a pixel off the frame's grid, and its composite rounds the ties of two neighbouring levels, which
/// on some GPUs all go one way.)
#[test]
fn a_thin_line_keeps_its_energy_and_holds_still_when_blurred() {
    let size = [480, 440];
    let mut sums = Vec::new();
    for offset in [0.0f32, 0.25, 0.4, 0.75] {
        let x0 = 240.0 + offset;
        let list = shapes(&[([x0, 20.0, x0 + 1.0, 420.0], RED)], vec![effect(Params::Blur(Blur { radius: 60.0, ..Default::default() }))]);
        for (renderer, pixels) in draw_both(&list, &zoomed(size, 1.0), size) {
            let rows = 120..320;
            let mut row = vec![0.0; size[0] as usize];
            for y in rows.clone() {
                for (total, value) in row.iter_mut().zip(alpha_row(&pixels, size[0], y)) {
                    *total += value / rows.len() as f64;
                }
            }
            let sum = row.iter().sum::<f64>() / 255.0;
            let peak = row.iter().cloned().fold(0.0, f64::max);
            eprintln!("{renderer} at +{offset}: sum {sum:.4}, peak {peak:.2}");
            assert!((sum - 1.0).abs() <= 0.02, "{renderer} at +{offset}: the blurred line holds {sum:.3} of its one pixel's energy");
            sums.push((renderer, offset, sum, peak));
        }
    }
    for &(renderer, offset, sum, peak) in &sums {
        let (_, _, first, first_peak) = sums.iter().find(|s| s.0 == renderer).copied().unwrap();
        assert!((sum - first).abs() <= 0.01 && (peak - first_peak).abs() <= 0.25, "{renderer}: moved by {offset} the line's blur changes ({sum:.3} against {first:.3}, peak {peak:.2} against {first_peak:.2})");
    }
}

/// The sum of the blue channel along a row, in pixels of full coverage.
fn blue_width(pixels: &[u8], width: u32, y: u32, from: u32, to: u32) -> f64 {
    (from..to).map(|x| pixel(pixels, width, x, y)[2] as f64 / 255.0).sum()
}

/// An outline is as wide in scene units at every density, fractional widths included: drawn under the artwork, its blue
/// coverage along a row from the artwork's edge outward adds up to the width. (At densities 0.71 and 1.41 the layer is drawn
/// at 0.84 and 1.41 pixels a unit, so the edge falls inside a pixel.)
#[test]
fn an_outline_has_its_width_at_every_density() {
    let outline = |width: f64| effect(Params::Outline(Outline { color: Color::Rgb(0x0000ff), width, ..Default::default() }));
    for zoom in [0.71, 1.0, 1.41, 2.0] {
        for width in [0.5, 1.5, 3.0] {
            let list = shapes(&[([100.0, 60.0, 200.0, 300.0], RED)], vec![outline(width)]);
            let size = [(320.0 * zoom) as u32, (360.0 * zoom) as u32];
            for (renderer, pixels) in draw_both(&list, &zoomed(size, zoom), size) {
                let y = (180.0 * zoom) as u32;
                let edge = (200.0 * zoom).floor() as u32;
                let measured = blue_width(&pixels, size[0], y, edge.saturating_sub(2), edge + (12.0 * zoom) as u32) / zoom;
                assert!((measured - width).abs() <= 0.12, "{renderer} at density {zoom}: an outline of {width} measures {measured:.3}");
                if width == 0.5 && zoom == 1.0 {
                    let darkest = (edge - 2..edge + 4).map(|x| pixel(&pixels, size[0], x, y)[2]).max().unwrap();
                    assert!(darkest < 200, "{renderer}: half a pixel of outline covers no pixel whole ({darkest})");
                }
            }
        }
    }
}

/// Each pixelate cell shows the average of what it covers: a one-pixel line through 16-pixel cells makes cells of 1/16.
#[test]
fn pixelate_cells_average_what_they_cover() {
    let size = [256, 128];
    let list = shapes(&[([100.0, 16.0, 101.0, 80.0], RED)], vec![effect(Params::Pixelate(Pixelate { size: 16.0, ..Default::default() }))]);
    for (renderer, pixels) in draw_both(&list, &zoomed(size, 1.0), size) {
        // The cells are on the effect's grid, from the domain's corner (100, 16): the line's cells are x 100–116.
        for y in [20u32, 40, 60, 75] {
            for x in [100u32, 104, 108, 115] {
                let a = pixel(&pixels, size[0], x, y)[3];
                assert!((14..=18).contains(&a), "{renderer}: ({x}, {y}) is {a}, a cell 1/16 covered is 16");
            }
            assert_eq!(pixel(&pixels, size[0], 120, y)[3], 0, "{renderer}: the next cell is empty");
        }
    }
}

/// A long directional blur of a small bright spot is one unbroken streak of even strength, not copies of the spot.
#[test]
fn a_long_directional_blur_is_one_unbroken_streak() {
    let size = [640, 200];
    let list = shapes(&[([320.0, 100.0, 322.0, 102.0], RED)], vec![effect(Params::Blur(Blur { mode: BlurMode::Directional, radius: 100.0, ..Default::default() }))]);
    for (renderer, pixels) in draw_both(&list, &zoomed(size, 1.0), size) {
        let row = alpha_row(&pixels, size[0], 100);
        for x in 226..416 {
            assert!((1.0..=5.0).contains(&row[x]), "{renderer}: the streak at x {x} is {} (two pixels spread over 201 are 2.5 levels)", row[x]);
        }
        let sum = row.iter().sum::<f64>() / 255.0;
        assert!((sum - 2.0).abs() <= 0.25, "{renderer}: the streak holds the spot's two pixels ({sum:.2})");
    }
}

/// A zoom blur grows with the distance from its centre and is nothing at the centre.
#[test]
fn a_zoom_blur_leaves_its_centre_sharp() {
    let size = [400, 400];
    // Vertical stripes four units wide, every other one red, over 98–302 on both axes: the centre (200, 200) is in a stripe.
    let stripes: Vec<([f32; 4], u32)> = (0..26).map(|i| ([98.0 + i as f32 * 8.0, 98.0, 102.0 + i as f32 * 8.0, 302.0], RED)).collect();
    let zoom = vec![effect(Params::Blur(Blur { mode: BlurMode::Zoom, radius: 40.0, ..Default::default() }))];
    let (plain, list) = (shapes(&stripes, vec![]), shapes(&stripes, zoom));
    for ((renderer, a), (_, b)) in draw_both(&plain, &zoomed(size, 1.0), size).into_iter().zip(draw_both(&list, &zoomed(size, 1.0), size)) {
        for (x, y) in [(199, 199), (200, 200), (199, 201), (200, 199)] {
            let (sharp, zoomed_at) = (pixel(&a, size[0], x, y)[3] as i32, pixel(&b, size[0], x, y)[3] as i32);
            assert!((sharp - zoomed_at).abs() <= 3, "{renderer}: at the centre ({x}, {y}) the stripes stay sharp: {zoomed_at} against {sharp}");
        }
        // Near the corner the blur runs along the diagonal, across the stripes: they average out.
        let corner = pixel(&b, size[0], 114, 114)[3];
        assert!((60..=200).contains(&corner), "{renderer}: near the corner the stripes are blurred together ({corner})");
    }
}

/// On WebGL2 the browser compiles a pipeline on the interface thread, so there a frame creates few
/// (`Executor::set_compile_limit`): a layer whose pipelines are not all there yet is left as it is, unfiltered, and the
/// executor says to draw again; the frames after create the rest, and the layer then looks as it does without a limit.
#[test]
fn a_frame_that_creates_one_pipeline_filters_its_layer_over_the_frames_after() {
    use styk_eval::vfx::registry::Glow;
    use styk_render::effects::executor::{Executor, Frame};
    use styk_render::wgpu;
    let Some((device, queue)) = gpu() else { eprintln!("skipped: no graphics adapter"); return };
    let size = [96u32, 64];
    let pixels: Vec<u8> = (0..size[0] * size[1]).flat_map(|i| if (30..66).contains(&(i % size[0])) && (20..44).contains(&(i / size[0])) { [255, 0, 0, 255] } else { [0; 4] }).collect();
    let layer = || {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(texture.as_image_copy(), &pixels, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size[0] * 4), rows_per_image: None }, texture.size());
        texture
    };
    let stack = vec![
        Arc::new(effect(Params::Glow(Glow { radius: 12.0, ..Default::default() }))),
        Arc::new(effect(Params::Outline(Outline { width: 2.0, ..Default::default() }))),
    ];
    // Draws one frame of the layer; whether it was filtered, and its pixels.
    let draw = |executor: &mut Executor| {
        let run = executor.record(&stack, Frame { scale: 1.0, origin: [0.0; 2], output_size: size.map(f64::from) }, size);
        executor.prepare_own(device, queue, &[&run]);
        let texture = layer();
        let mut encoder = device.create_command_encoder(&Default::default());
        let filtered = executor.encode(device, &mut encoder, 0, &run, texture.as_image_copy());
        queue.submit([encoder.finish()]);
        (filtered, styk_render::read_frame(device, queue, &texture).2)
    };
    let mut unlimited = Executor::new(device, true);
    let (filtered, expected) = draw(&mut unlimited);
    assert!(filtered && !unlimited.pending());
    let needed = unlimited.stats.pipelines;
    assert!(needed > 2, "the stack needs several pipelines ({needed})");

    let mut limited = Executor::new(device, true);
    limited.set_compile_limit(Some(1));
    for frame in 1..needed {
        let (filtered, drawn) = draw(&mut limited);
        assert!(!filtered && limited.pending(), "frame {frame} of {needed}: the layer waits for its pipelines");
        assert_eq!(drawn, pixels, "frame {frame}: a waiting layer is drawn as it is");
        assert_eq!(limited.stats.pipelines, frame);
    }
    let (filtered, drawn) = draw(&mut limited);
    assert!(filtered && !limited.pending(), "with its last pipeline the layer is filtered");
    assert_eq!(drawn, expected, "as a frame without a limit filters it");
}

// ---- Time and the new controls ---------------------------------------------------------------------------------------------

/// A red and a blue rectangle side by side (x 20–60 and 60–100, y 20–60) filtered by `effect` on its clock `clock`, drawn on
/// both renderers on a 120×80 view.
fn two_colours(effect: Effect, clock: f64) -> Vec<(&'static str, Vec<u8>)> {
    let timed = styk_eval::vfx::at_time(&Arc::new(effect), clock);
    let list = shapes(&[([20.0, 20.0, 60.0, 60.0], RED), ([60.0, 20.0, 100.0, 60.0], 0xffff_0000)], vec![(*timed).clone()]);
    draw_both(&list, &zoomed([120, 80], 1.0), [120, 80])
}

/// The mean difference of two pictures, in levels per channel.
fn mean_difference(a: &[u8], b: &[u8]) -> f64 {
    a.iter().zip(b).map(|(&x, &y)| x.abs_diff(y) as f64).sum::<f64>() / a.len() as f64
}

/// A speed moves its effect with the clock (the clip's local time, frames) exactly as the value it advances: at clock t the
/// picture is the one of the authored value plus speed × t, between frames too, while the authored values stay as saved.
#[test]
fn a_speed_draws_the_authored_value_it_advances_by_the_clock() {
    use styk_eval::vfx::registry::{Crt, Noise, NoisePattern, Turbulence, Wave};
    let cases: Vec<(&str, Params, Params, f64)> = vec![
        ("wave", Params::Wave(Wave { speed: 30.0, ..Default::default() }), Params::Wave(Wave { phase: 75.0, ..Default::default() }), 2.5),
        ("crt", Params::Crt(Crt { roll: 4.0, ..Default::default() }), Params::Crt(Crt { phase: 10.0, ..Default::default() }), 2.5),
        ("turbulence", Params::Turbulence(Turbulence { speed: 0.5, ..Default::default() }), Params::Turbulence(Turbulence { evolution: 1.25, ..Default::default() }), 2.5),
        // Clouds evolve a quarter of their speed a frame.
        ("clouds", Params::Noise(Noise { pattern: NoisePattern::Clouds, speed: 1.0, ..Default::default() }), Params::Noise(Noise { pattern: NoisePattern::Clouds, phase: 0.625, ..Default::default() }), 2.5),
        // Grain re-rolls once a frame at speed 1, as each 1/1024 of its phase does.
        ("grain", Params::Noise(Noise { speed: 1.0, ..Default::default() }), Params::Noise(Noise { phase: 3.0 / 1024.0, ..Default::default() }), 3.5),
    ];
    for (name, moving, authored, clock) in cases {
        let effect = |params: Params| Effect { id: Arc::from("e"), enabled: true, params };
        let still = two_colours(effect(moving.clone()), 0.0);
        let moved = two_colours(effect(moving.clone()), clock);
        let expected = two_colours(effect(authored), 0.0);
        for (((renderer, still), (_, moved)), (_, expected)) in still.iter().zip(&moved).zip(&expected) {
            assert!(mean_difference(still, moved) > 0.05, "{renderer} {name}: the effect moves with the clock");
            assert_eq!(moved, expected, "{renderer} {name}: at clock {clock} it is the authored value advanced by speed × clock");
        }
        let timed = styk_eval::vfx::at_time(&Arc::new(effect(moving.clone())), clock);
        assert_eq!(timed.params.time(), clock);
        let mut saved = timed.params.clone();
        saved.set_time(0.0);
        assert_eq!(saved, moving, "{name}: the clock changes no authored value");
    }
}

/// Each control the filters gained changes the picture, and both renderers draw it alike.
#[test]
fn every_new_control_changes_the_picture_on_both_renderers() {
    use styk_eval::vfx::registry::{Crt, Dissolve, Glow, GlowSource, Grade, LightSweep, Noise, TintBlend, Turbulence, Wave};
    let tint = |blend| Params::Tint(Tint { mix: 1.0, blend, ..Default::default() });
    let cases: Vec<(&str, Params, Params, f64)> = vec![
        ("tint multiply", tint(TintBlend::Normal), tint(TintBlend::Multiply), 0.0),
        ("tint screen", tint(TintBlend::Normal), tint(TintBlend::Screen), 0.0),
        ("tint overlay", tint(TintBlend::Normal), tint(TintBlend::Overlay), 0.0),
        ("tint colour", tint(TintBlend::Normal), tint(TintBlend::Color), 0.0),
        ("tint add", tint(TintBlend::Normal), tint(TintBlend::Add), 0.0),
        ("glow from the artwork", Params::Glow(Glow { radius: 10.0, ..Default::default() }), Params::Glow(Glow { radius: 10.0, source: GlowSource::Artwork, ..Default::default() }), 0.0),
        ("outline softness", Params::Outline(Outline { width: 6.0, ..Default::default() }), Params::Outline(Outline { width: 6.0, softness: 1.0, ..Default::default() }), 0.0),
        ("grade hue", Params::Grade(Grade::default()), Params::Grade(Grade { hue: 90.0, ..Default::default() }), 0.0),
        ("directional dissolve", Params::Dissolve(Dissolve { progress: 0.5, ..Default::default() }), Params::Dissolve(Dissolve { progress: 0.5, directional: 1.0, angle: 45.0, ..Default::default() }), 0.0),
        ("noise speed", Params::Noise(Noise::default()), Params::Noise(Noise { speed: 1.0, ..Default::default() }), 3.0),
        ("turbulence speed", Params::Turbulence(Turbulence::default()), Params::Turbulence(Turbulence { speed: 0.5, ..Default::default() }), 3.0),
        ("wave speed", Params::Wave(Wave::default()), Params::Wave(Wave { speed: 30.0, ..Default::default() }), 3.0),
        // (A roll of a whole number of scanlines, 3 pixels apart, is the same picture: 1.5 pixels, not 12.)
        ("crt roll", Params::Crt(Crt::default()), Params::Crt(Crt { roll: 0.5, ..Default::default() }), 3.0),
        ("light sweep speed", Params::LightSweep(LightSweep::default()), Params::LightSweep(LightSweep { speed: 0.1, ..Default::default() }), 3.0),
        ("light sweep without loop", Params::LightSweep(LightSweep { speed: 0.1, ..Default::default() }), Params::LightSweep(LightSweep { speed: 0.1, looped: false, ..Default::default() }), 12.0),
    ];
    for (name, before, after, clock) in cases {
        let effect = |params: Params| Effect { id: Arc::from("e"), enabled: true, params };
        let (a, b) = (two_colours(effect(before), clock), two_colours(effect(after), clock));
        for ((renderer, a), (_, b)) in a.iter().zip(&b) {
            let changed = mean_difference(a, b);
            assert!(changed > 0.5, "{renderer} {name}: the control changes the picture ({changed:.2} levels)");
        }
        if let [(_, cpu), (_, gpu)] = &b[..] {
            let apart = mean_difference(cpu, gpu);
            let far = cpu.iter().zip(gpu).filter(|(x, y)| x.abs_diff(**y) > 8).count() as f64 / cpu.len() as f64;
            assert!(apart <= 0.5 && far <= 0.01, "{name}: the renderers differ by {apart:.2} levels, {:.2}% of channels by more than 8", far * 100.0);
        }
    }
}

/// Where a device cannot render to half floats (WebGL2 without `EXT_color_buffer_float`), effect images between passes are
/// eight bits, dithered: a wide blur, glow and bloom then draw what they draw in half floats, to a level or two, without bands.
#[test]
fn eight_bit_working_images_draw_what_half_floats_draw() {
    use styk_eval::vfx::registry::{Bloom, Glow};
    let images = Images::default();
    let size = [200, 140];
    let cases: Vec<(&str, Params)> = vec![
        ("blur", Params::Blur(Blur { radius: 30.0, ..Default::default() })),
        ("glow", Params::Glow(Glow { radius: 40.0, ..Default::default() })),
        ("bloom", Params::Bloom(Bloom { radius: 30.0, threshold: 0.2, ..Default::default() })),
    ];
    for (name, params) in cases {
        let list = shapes(&[([80.0, 50.0, 120.0, 90.0], RED)], vec![effect(params)]);
        let (Some(half), Some(eight)) = (draw_gpu_at(&list, &images, &zoomed(size, 1.0), size, true), draw_gpu_at(&list, &images, &zoomed(size, 1.0), size, false)) else {
            eprintln!("skipped: no graphics adapter");
            return;
        };
        let mean = mean_difference(&half, &eight);
        let worst = half.iter().zip(&eight).map(|(x, y)| x.abs_diff(*y)).max().unwrap();
        eprintln!("{name}: eight bits differ by {mean:.3} levels on average, {worst} at most");
        assert!(mean <= 0.25 && worst <= 4, "{name}: eight-bit working images differ from half floats by {mean:.2} levels on average, {worst} at most");
        // Along the falloff right of the square, alpha changes smoothly: no flat run of one level longer than the half-float
        // picture's longest by more than a few pixels.
        let longest = |pixels: &[u8]| {
            let row = alpha_row(pixels, size[0], 70);
            let (mut best, mut run) = (0, 0);
            for x in 121..size[0] as usize {
                run = if row[x] == row[x - 1] && row[x] > 0.0 { run + 1 } else { 0 };
                best = best.max(run);
            }
            best
        };
        assert!(longest(&eight) <= longest(&half) + 3, "{name}: eight bits band the falloff ({} pixels of one level against {})", longest(&eight), longest(&half));
    }
}
