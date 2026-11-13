//! Runs of primitives draw with the simplest fragment shader that holds their kinds (`src/shading.rs`): the frame is the
//! same, byte for byte, as when every primitive draws with the general shader, for every kind, background (opaque,
//! translucent, a gradient), drawing tiles, isolated groups, view (fitted, the canvas smaller than the view, partly off screen, through the camera,
//! turned and mirrored), paint context and edge mode. Compared on every adapter that draws one frame the same way twice
//! (Direct3D 12 multisampling on some drivers does not: docs/native/frame-parity.md); at least one must.

#[path = "support/gpu.rs"]
#[allow(dead_code)]
mod gpu;

use std::path::Path;
use std::sync::Arc;
use styk_draw::*;
use styk_eval::drawlist::{encode_with, Overrides};
use styk_eval::vfx::generated::{self, Evaluate};
use styk_render::paint::PaintContext;
use styk_render::{read_frame, wgpu, Edges, Renderer, ViewParams};

const SIZE: [u32; 2] = [192, 112];
const WORLD: [f64; 2] = [100.0, 60.0];

fn prim(kind: u32, color: u32, a: [f32; 4], b: [f32; 4]) -> Prim {
    Prim { kind, group: 0, color, paint: NO_PAINT, a, b, c: [0.0, 0.0, 10.0, 0.0] }
}

/// Every vector kind, from hairlines to thick strokes, over a view fill of `background` (ABGR), in a 100 × 60 world.
fn kinds(background: u32) -> DrawList {
    let points: Vec<[f32; 2]> = vec![[10.0, 40.0], [20.0, 52.0], [30.0, 41.0], [42.0, 55.0], [55.0, 44.0], [60.0, 50.0], [70.0, 40.0], [80.0, 48.0]];
    let bits = |v: u32| f32::from_bits(v);
    let prims = vec![
        prim(K_FILL_VIEW, background, [0.0; 4], [0.0; 4]),
        prim(K_CAPSULE, 0xff20_40e0, [5.0, 5.0, 60.0, 22.0], [3.5, 0.0, 0.0, 0.0]),
        prim(K_CAPSULE, 0x8000_c000, [8.0, 30.0, 90.0, 8.0], [0.2, 0.0, 0.0, 0.0]),
        prim(K_CAPSULE, 0xff00_0000, [12.0, 2.0, 12.0, 2.0], [2.0, 0.0, 0.0, 0.0]),
        prim(K_BOX, 0xc0e0_4020, [62.0, 8.0, 90.0, 20.0], [2.5, 0.0, 0.0, 0.0]),
        prim(K_ARC, 0xff80_2080, [70.0, 30.0, 12.0, 1.5], [0.4, 3.9, 0.0, 0.0]),
        prim(K_ARC, 0xff10_10a0, [30.0, 30.0, 6.0, 0.1], [-1.0, -2.5, 0.0, 0.0]),
        prim(K_POLYLINE, 0xffe0_e000, [10.0, 40.0, 80.0, 55.0], [1.2, bits(0), bits(points.len() as u32), 0.0]),
        prim(K_POLYLINE | F_CLOSED, 0x9010_a0f0, [10.0, 40.0, 80.0, 55.0], [0.6, bits(2), bits(4), 0.0]),
        prim(K_DISC, 0xff30_c0ff, [48.0, 26.0, 7.5, 0.0], [0.0; 4]),
        prim(K_DISC, 0x6000_00ff, [50.0, 30.0, 0.3, 0.0], [0.0; 4]),
        prim(K_RING, 0xff00_4080, [20.0, 20.0, 9.0, 1.2], [0.0; 4]),
        prim(K_RING | F_RING_FILL, 0xff40_0000, [85.0, 45.0, 8.0, 0.8], [bits(0x80ff_ff00), 0.0, 0.0, 0.0]),
        prim(K_TRI, 0x80ff_0000, [2.0, 58.0, 40.0, 35.0], [98.0, 59.0, 0.0, 0.0]),
        prim(K_TRI, 0xff00_ff00, [-20.0, -10.0, 5.0, -10.0], [-20.0, 30.0, 0.0, 0.0]),
    ];
    let end = prims.len() as u32;
    DrawList {
        prims,
        points,
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, WORLD[0] as f32, WORLD[1] as f32], layer: NO_LAYER }],
        passes: vec![Pass { depth: 0, start: 0, end }],
        background_prims: 1,
        ..Default::default()
    }
}

/// A repository document's frame, encoded as the stage encodes one (generated effects evaluated), with its world size.
fn document(file: &str, tick: f64) -> (DrawList, [f64; 2], Option<styk_eval::doc::Camera>, Arc<styk_eval::doc::Document>) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(file);
    let prepared = styk_eval::prepare(styk_eval::open(&path).unwrap_or_else(|e| panic!("{file}: {e}")));
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let batch = generated::build(&prepared, &frame, &scene, Some(tick), Some(&Evaluate), 1.0);
    let list = encode_with(&prepared.doc, &assets, &scene, &Overrides { generators: batch.as_ref(), ..Default::default() });
    let world = [prepared.doc.canvas[0] as f64, prepared.doc.canvas[1] as f64];
    (list, world, scene.camera, prepared.doc.clone())
}

/// How a frame is viewed: the zoom relative to fitting the world in the frame, where it is moved from the centre (in
/// output pixels), whether the camera applies, the turn and mirror, the artboard clip and the paint context.
#[derive(Clone, Copy, Debug)]
struct Look {
    scale: f64,
    offset: [f64; 2],
    camera: bool,
    turn: Option<(f64, bool)>,
    clip: bool,
    canvas: bool,
}

const LOOKS: [Look; 6] = [
    Look { scale: 1.0, offset: [0.0, 0.0], camera: true, turn: None, clip: true, canvas: false },
    // The canvas smaller than the view, on a pasteboard.
    Look { scale: 0.45, offset: [0.0, 0.0], camera: false, turn: None, clip: true, canvas: false },
    // Partly off screen, nothing clipped to the artboard.
    Look { scale: 1.6, offset: [-70.0, 25.0], camera: false, turn: None, clip: false, canvas: false },
    Look { scale: 0.8, offset: [6.5, -3.25], camera: true, turn: Some((0.5, true)), clip: true, canvas: false },
    // The camera monitor's Canvas painter: fractional edges, the clip and the fill's own coverage.
    Look { scale: 0.73, offset: [0.3, 0.6], camera: false, turn: None, clip: true, canvas: true },
    Look { scale: 1.3, offset: [-11.0, 7.0], camera: true, turn: Some((-0.25, false)), clip: true, canvas: true },
];

/// The frame of `list` seen as `look`, with the shading runs on or off.
#[allow(clippy::too_many_arguments)]
fn draw(renderer: &mut Renderer, device: &wgpu::Device, queue: &wgpu::Queue, list: &Arc<DrawList>, world: [f64; 2], doc: Option<(&styk_eval::doc::Document, Option<&styk_eval::doc::Camera>)>, look: Look, runs: bool) -> Vec<u8> {
    let [w, h] = SIZE.map(|v| v as f64);
    let zoom = (w / world[0]).min(h / world[1]) * look.scale;
    let pan = [(w - world[0] * zoom) / 2.0 + look.offset[0], (h - world[1] * zoom) / 2.0 + look.offset[1]];
    let upright = match doc {
        Some((doc, camera)) => styk_eval::view::camera_matrix(doc, if look.camera { camera } else { None }, zoom, pan),
        None => [zoom, 0.0, 0.0, zoom, pan[0], pan[1]],
    };
    let turn = look.turn.and_then(|(rotation, flip)| styk_eval::view::orientation(rotation, flip, [pan[0] + world[0] * zoom / 2.0, pan[1] + world[1] * zoom / 2.0]));
    renderer.set_orientation(turn);
    renderer.set_paint_context(if look.canvas { PaintContext::CanvasDirect { background_bounds: [0.0, 0.0, world[0], world[1]] } } else { PaintContext::Native });
    renderer.set_shading_runs(runs);
    let view = ViewParams {
        matrix: turn.map_or(upright, |o| styk_eval::view::compose(o, upright)),
        artboard: [pan[0], pan[1], pan[0] + world[0] * zoom, pan[1] + world[1] * zoom],
        clip_to_artboard: look.clip,
        clear: [0.0; 4],
        zoom,
        pan,
        stretch: 1.0,
        camera_view: look.camera && doc.is_some(),
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    };
    renderer.set_list(list);
    let mut encoder = device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view, SIZE);
    queue.submit([encoder.finish()]);
    read_frame(device, queue, renderer.frame_texture().expect("a frame")).2
}

/// Where two frames differ first, for the message.
fn first_difference(a: &[u8], b: &[u8]) -> String {
    let i = a.iter().zip(b).position(|(x, y)| x != y).unwrap_or(0) / 4;
    format!("pixel ({}, {}): {:?} against {:?}, {} pixels in all", i % SIZE[0] as usize, i / SIZE[0] as usize, &a[i * 4..i * 4 + 4], &b[i * 4..i * 4 + 4],
        a.chunks_exact(4).zip(b.chunks_exact(4)).filter(|(x, y)| x != y).count())
}

#[test]
fn every_run_draws_what_the_general_shader_draws() {
    let lists: Vec<(String, Arc<DrawList>, [f64; 2], Option<(Arc<styk_eval::doc::Document>, Option<styk_eval::doc::Camera>)>)> = {
        let mut lists = vec![
            ("every kind on an opaque background".to_string(), Arc::new(kinds(0xff_f0_e8_e0)), WORLD, None),
            ("every kind on a translucent background".to_string(), Arc::new(kinds(0x60_20_a0_ff)), WORLD, None),
            ("every kind on no background".to_string(), Arc::new(kinds(0)), WORLD, None),
        ];
        for (file, tick) in [
            ("engine/crates/styk-eval/tests/fixtures/drawlist/painted-limbs.json", 0.0),
            ("engine/crates/styk-eval/tests/fixtures/drawlist/outlined-text.json", 0.0),
            ("engine/crates/styk-eval/tests/fixtures/vfx/pose-native.json", 6.0),
            ("engine/crates/styk-eval/tests/fixtures/spatial/mesh-instances.json", 1.0),
            ("engine/crates/styk-eval/tests/fixtures/generators/smoke.json", 12.0),
            ("engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json", 0.0),
        ] {
            let (list, world, camera, doc) = document(file, tick);
            lists.push((file.rsplit('/').next().unwrap().to_string(), Arc::new(list), world, Some((doc, camera))));
        }
        lists
    };
    // The lists hold the simpler runs this compares, and the documents the general shader's kinds beside them.
    assert!(lists.iter().all(|(_, list, _, _)| list.prims.iter().any(|p| p.kind & 255 == K_FILL_VIEW)), "every list has a view fill");
    assert!(lists.iter().any(|(_, list, _, _)| list.prims.iter().any(|p| p.paint != NO_PAINT)), "a gradient");
    assert!(lists.iter().any(|(_, list, _, _)| list.prims.iter().any(|p| p.kind & 255 == K_COMPOSITE)), "an isolated group");
    assert!(lists.iter().any(|(_, list, _, _)| list.prims.iter().any(|p| p.kind & F_DEPTH != 0)), "a depth run");
    assert!(lists.iter().any(|(_, list, _, _)| list.prims.iter().any(|p| p.kind & 255 == K_IMAGE && p.kind & F_DRAWING != 0)), "a drawing tile");

    // Where the runs are used (a software rasterizer: WARP, llvmpipe, lavapipe, SwiftShader), and a graphics card's Vulkan
    // compiler beside them. Direct3D 12's compiler on a graphics card moved one pixel of the Canvas painter by a level
    // between the two shaders, which is why a graphics card keeps the general shader (`Renderer::set_shading_runs`).
    // A software rasterizer draws the lists with smooth edges and without depth runs or additive effects, each of which
    // builds more pipelines of the general shader. Even so WARP takes about 40 s here (it compiles and draws the general
    // shader slowly), against about a second for the whole set on a graphics card's Vulkan.
    let backends = wgpu::Backends::all() - wgpu::Backends::BROWSER_WEBGPU;
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = backends;
    let instance = wgpu::Instance::new(descriptor);
    let mut chosen: Vec<wgpu::Adapter> = Vec::new();
    for adapter in pollster::block_on(instance.enumerate_adapters(backends)) {
        let info = adapter.get_info();
        let vulkan_card = info.backend == wgpu::Backend::Vulkan && info.device_type != wgpu::DeviceType::Cpu;
        if info.device_type == wgpu::DeviceType::Cpu || (vulkan_card && !chosen.iter().any(|a| a.get_info().backend == wgpu::Backend::Vulkan && a.get_info().device_type != wgpu::DeviceType::Cpu)) {
            chosen.push(adapter);
        }
    }
    let mut compared = Vec::new();
    for adapter in chosen {
        let info = adapter.get_info();
        let Ok((device, queue)) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())) else { continue };
        let name = format!("{:?} {} ({:?})", info.backend, info.name, info.device_type);
        let software = info.device_type == wgpu::DeviceType::Cpu;
        let mut repeatable = true;
        'edges: for edges in if software { &[Edges::Smooth][..] } else { &[Edges::Smooth, Edges::Crisp][..] } {
            let edges = *edges;
            let mut renderer = Renderer::with_edges(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, edges);
            for (what, list, world, doc) in &lists {
                if software && list.prims.iter().any(|p| p.kind & (F_DEPTH | F_ADD) != 0) {
                    continue;
                }
                let doc = doc.as_ref().map(|(doc, camera)| (&**doc, camera.as_ref()));
                for look in LOOKS {
                    let general = draw(&mut renderer, &device, &queue, list, *world, doc, look, false);
                    if draw(&mut renderer, &device, &queue, list, *world, doc, look, false) != general {
                        eprintln!("{name}: the same frame differs between two draws ({what}, {look:?}); not compared there");
                        repeatable = false;
                        break 'edges;
                    }
                    let shaded = draw(&mut renderer, &device, &queue, list, *world, doc, look, true);
                    assert!(shaded == general, "{name}, {edges:?}, {what}, {look:?}: {}", first_difference(&shaded, &general));
                }
            }
        }
        if repeatable {
            compared.push(name);
        }
    }
    eprintln!("compared on: {compared:?}");
    if compared.is_empty() {
        gpu::missing("no software rasterizer or Vulkan adapter that draws a frame the same way twice");
    }
}

#[test]
fn a_list_drawn_over_the_one_before_keeps_its_runs_right() {
    // A gesture changes some primitives of the list on show (`Renderer::note_changes`): where one becomes a kind of
    // another shader the runs are worked out again, and the frame is still the general shader's.
    let Ok((_, device, queue)) = gpu::device(&wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env()), wgpu::Backends::VULKAN) else {
        return gpu::missing("a Vulkan adapter");
    };
    let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    let before = Arc::new(kinds(0xff_ff_ff_ff));
    let look = LOOKS[0];
    draw(&mut renderer, &device, &queue, &before, WORLD, None, look, true);
    let mut changed = kinds(0xff_ff_ff_ff);
    // A segment moves, and a disc becomes a gradient (the general shader's).
    changed.prims[1].a[2] += 9.0;
    changed.paints = vec![[0.0, 2.0, 0.0, 0.0], [40.0, 20.0, 56.0, 32.0], [0.0; 4], [0.0; 4], [1.0, 0.0, 0.0, 1.0], [1.0; 4], [0.0, 0.0, 1.0, 1.0]];
    changed.prims[9].paint = 0;
    let changed = Arc::new(changed);
    renderer.note_changes(&changed, &before, vec![(1, 2), (9, 10)]);
    let shaded = draw(&mut renderer, &device, &queue, &changed, WORLD, None, look, true);
    let mut fresh = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
    let general = draw(&mut fresh, &device, &queue, &changed, WORLD, None, look, false);
    assert!(shaded == general, "{}", first_difference(&shaded, &general));
}
