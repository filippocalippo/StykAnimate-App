//! Thin subpixel triangles cover the same samples on Direct3D 12 and on Vulkan, drawn by the production pipeline.
//!
//! The vertex stage turns a screen position into clip space, and the rasteriser snaps that to a 1/256 pixel grid before it
//! decides which of a pixel's four samples a triangle covers, so one bit of the clip position can move an edge across a
//! sample. Shader compilers may reassociate arithmetic (WGSL allows it and does not require a fused multiply-add): the DX12
//! backend's compiler (FXC) folded `t / size * 2 - 1` into a reciprocal product, which rounds differently from Vulkan and
//! from Chromium's WebGPU, and thin triangles drew a quarter of the coverage differently. `clip_pos` is written so that the
//! division is a statement of its own.
//!
//! The regression draws the same thousands of thin triangles (slivers a pixel wide at most, at subpixel positions) with the
//! real `Renderer` at several sizes that are not powers of two, on Direct3D 12 with FXC named (the native host's first
//! attempt) and on Vulkan, and asserts that the two frames are equal byte for byte. With the shader as it was before the fix
//! the frames differ. A CPU check holds where it is robust: rectangles on whole pixel boundaries cover exactly their pixels,
//! which catches a broken pipeline but not the fold. Without both backends the test fails (or, with `STYK_ALLOW_NO_GPU=1`,
//! is ignored) with the reason; it exists on Windows only, the one platform with both.

#![cfg(windows)]

#[path = "support/gpu.rs"]
mod gpu;

use std::sync::Arc;
use styk_draw::*;
use styk_render::native_gpu::{open_attempt, Attempt};
use styk_render::{read_frame, wgpu, Renderer, ViewParams};

/// Sizes that are not powers of two.
const SIZES: [[u32; 2]; 3] = [[700, 400], [1000, 650], [599, 331]];
const SLIVERS: usize = 2500;

struct Random(u32);

impl Random {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }
}

/// Rectangles on whole pixels, as two triangles each.
fn rectangles(size: [u32; 2]) -> Vec<[f32; 4]> {
    vec![[3.0, 2.0, 40.0, 17.0], [100.0, 90.0, 101.0, 91.0], [size[0] as f32 - 50.0, 30.0, size[0] as f32 - 2.0, 60.0]]
}

fn scene(size: [u32; 2], rects: &[[f32; 4]], slivers: usize) -> DrawList {
    let mut random = Random(0x2545_f491 ^ size[0]);
    let mut prims = Vec::new();
    for r in rects {
        prims.push(Prim { kind: K_TRI, group: 0, color: 0xff00_00ff, paint: NO_PAINT, a: [r[0], r[1], r[2], r[1]], b: [r[2], r[3], 0.0, 0.0], c: [0.0; 4] });
        prims.push(Prim { kind: K_TRI, group: 0, color: 0xff00_00ff, paint: NO_PAINT, a: [r[0], r[1], r[2], r[3]], b: [r[0], r[3], 0.0, 0.0], c: [0.0; 4] });
    }
    for _ in 0..slivers {
        let (x, y) = (random.next() * size[0] as f32, random.next() * size[1] as f32);
        let (angle, length) = (random.next() * std::f32::consts::TAU, 20.0 + random.next() * 280.0);
        let spread = 0.0005 + random.next() * 0.01;
        let (bx, by) = (x + length * angle.cos(), y + length * angle.sin());
        let (cx, cy) = (x + length * (angle + spread).cos(), y + length * (angle + spread).sin());
        let color = 0xff00_0000 | ((random.next() * 255.0) as u32) << 16 | ((random.next() * 255.0) as u32) << 8 | (random.next() * 255.0) as u32;
        prims.push(Prim { kind: K_TRI, group: 0, color, paint: NO_PAINT, a: [x, y, bx, by], b: [cx, cy, 0.0, 0.0], c: [0.0; 4] });
    }
    let end = prims.len() as u32;
    DrawList {
        prims,
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, size[0] as f32, size[1] as f32], layer: NO_LAYER }],
        passes: vec![Pass { depth: 0, start: 0, end }],
        background_prims: 0,
        ..Default::default()
    }
}

struct Opened {
    name: String,
    backend: wgpu::Backend,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

fn open(attempt: &Attempt) -> Result<Opened, String> {
    let (_, adapter, device, queue) = open_attempt(attempt, "backend coverage", &|a: &wgpu::Adapter| a.limits())?;
    let info = adapter.get_info();
    Ok(Opened { name: info.name, backend: info.backend, device, queue })
}

fn frame(gpu: &Opened, size: [u32; 2], list: DrawList) -> Vec<u8> {
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, size[0] as f64, size[1] as f64], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: styk_render::CAMERA_PREVIEW_LIMIT };
    renderer.set_list(&Arc::new(list));
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    renderer.render(&mut encoder, &view, size);
    gpu.queue.submit([encoder.finish()]);
    read_frame(&gpu.device, &gpu.queue, renderer.frame_texture().expect("a frame")).2
}

fn backends() -> Option<(Opened, Opened)> {
    let dx12 = Attempt { name: "Direct3D 12 with FXC".into(), backends: wgpu::Backends::DX12, fxc: true, from_env: false };
    let vulkan = Attempt { name: "Vulkan".into(), backends: wgpu::Backends::VULKAN, fxc: false, from_env: false };
    match (open(&dx12), open(&vulkan)) {
        (Ok(a), Ok(b)) if a.name == b.name => Some((a, b)),
        (Ok(a), Ok(b)) => {
            gpu::missing(&format!("the two backends expose different adapters ({} and {}), so their frames cannot be compared", a.name, b.name));
            None
        }
        (a, b) => {
            gpu::missing(&format!("both backends are needed (Direct3D 12 with FXC: {}; Vulkan: {})", a.err().unwrap_or_else(|| "ok".into()), b.err().unwrap_or_else(|| "ok".into())));
            None
        }
    }
}

#[test]
fn thin_triangles_cover_the_same_samples_on_direct3d_12_and_vulkan() {
    let Some((a, b)) = backends() else { return };
    assert_eq!((a.backend, b.backend), (wgpu::Backend::Dx12, wgpu::Backend::Vulkan));
    for size in SIZES {
        let rects = rectangles(size);
        let (frame_a, frame_b) = (frame(&a, size, scene(size, &rects, SLIVERS)), frame(&b, size, scene(size, &rects, SLIVERS)));
        let differing = frame_a.chunks_exact(4).zip(frame_b.chunks_exact(4)).filter(|(p, q)| p != q).count();
        assert_eq!(differing, 0, "{size:?}: {differing} of {} pixels differ between Direct3D 12 (FXC) and Vulkan on {}", size[0] * size[1], a.name);
    }
}

#[test]
fn rectangles_on_whole_pixels_cover_exactly_their_pixels_on_either_backend() {
    let Some((a, b)) = backends() else { return };
    for size in SIZES {
        let rects = rectangles(size);
        for gpu in [&a, &b] {
            let pixels = frame(gpu, size, scene(size, &rects, 0));
            let wrong = (0..size[1] * size[0])
                .filter(|&i| {
                    let (x, y) = ((i % size[0]) as f32, (i / size[0]) as f32);
                    let inside = rects.iter().any(|r| x >= r[0] && x < r[2] && y >= r[1] && y < r[3]);
                    pixels[i as usize * 4 + 3] != if inside { 255 } else { 0 }
                })
                .count();
            assert_eq!(wrong, 0, "{:?} {size:?}: {wrong} pixels are not exactly covered or empty", gpu.backend);
        }
    }
}
