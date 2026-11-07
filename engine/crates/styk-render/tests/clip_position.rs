//! The vertex stage's clip position is the same on every graphics backend, to the last bit.
//!
//! The hardware snaps a vertex to a 1/256 pixel grid before it decides which of a pixel's four samples a triangle covers,
//! so a one-bit difference in the clip position moves an edge across a sample, and the sliver triangles of thin shapes show
//! it. Shader compilers rewrite arithmetic: the DX12 backend's compiler turned `t / size * 2` into `t * (2 / size)`,
//! which rounds differently, and some pixels of the same frame differed from Vulkan and from Chromium's WebGPU by a
//! quarter of the coverage. `clip_pos` now divides first and doubles after. A GPU's division is not required to be exactly
//! rounded (Vulkan's is not), so the test does not hold a backend to the exact value: it compiles the shader's own
//! `clip_pos` (cut out of `prim.wgsl`) into a compute pass on every adapter of a desktop backend, requires each result to
//! be within one ulp of the exact one, and requires the backends to agree with one another bit for bit, for sizes that are
//! not powers of two. With one backend present only the first holds. Skipped where no such adapter exists.

use std::sync::mpsc;
use styk_render::wgpu;
use wgpu::util::DeviceExt;

const SOURCE: &str = include_str!("../src/prim.wgsl");
const SIZES: [[f32; 2]; 5] = [[700.0, 400.0], [1000.0, 650.0], [960.0, 540.0], [3840.0, 2160.0], [599.0, 331.0]];
const COUNT: usize = 8192;

/// `fn clip_pos` of the primitive shader, exactly as written there.
fn clip_pos_source() -> &'static str {
    let start = SOURCE.find("fn clip_pos(").expect("prim.wgsl has clip_pos");
    let end = start + SOURCE[start..].find("\n}\n").expect("clip_pos ends") + 3;
    &SOURCE[start..end]
}

/// Positions spread over a size's range.
fn positions(size: [f32; 2]) -> Vec<[f32; 2]> {
    let mut state = 0x9e37_79b9_u32;
    let mut next = || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (state >> 8) as f32 / (1u32 << 24) as f32
    };
    (0..COUNT).map(|_| [next() * size[0], next() * size[1]]).collect()
}

/// The correctly rounded division, then an exact doubling and one rounded subtraction.
fn expected(t: [f32; 2], size: [f32; 2]) -> [f32; 2] {
    [(t[0] / size[0]) * 2.0 - 1.0, 1.0 - (t[1] / size[1]) * 2.0]
}

fn shader() -> String {
    format!(
        "struct View {{ dest: vec4<f32> }}\n@group(0) @binding(0) var<uniform> view: View;\n@group(0) @binding(1) var<storage, read> input: array<vec2<f32>>;\n@group(0) @binding(2) var<storage, read_write> output: array<vec2<f32>>;\n{}\n@compute @workgroup_size(64)\nfn main(@builtin(global_invocation_id) id: vec3<u32>) {{\n    let i = id.x;\n    if (i >= {COUNT}u) {{ return; }}\n    output[i] = clip_pos(input[i]).xy;\n}}\n",
        clip_pos_source()
    )
}

/// Every clip position (x then y, sizes in turn) one adapter's compiled `clip_pos` gives.
fn run(device: &wgpu::Device, queue: &wgpu::Queue) -> Vec<f32> {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("clip_pos"), source: wgpu::ShaderSource::Wgsl(shader().into()) });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: None, layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
    let bytes = (COUNT * 8) as u64;
    let mut all = Vec::new();
    for size in SIZES {
        let input = positions(size);
        let view = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&[size[0], size[1], 0.0, 0.0]), usage: wgpu::BufferUsages::UNIFORM });
        let input_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytemuck::cast_slice(&input), usage: wgpu::BufferUsages::STORAGE });
        let output = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let read = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: view.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: input_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: output.as_entire_binding() },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(COUNT.div_ceil(64) as u32, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &read, 0, bytes);
        queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::channel();
        read.slice(..).map_async(wgpu::MapMode::Read, move |result| sender.send(result).unwrap());
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        receiver.recv().unwrap().expect("the read-back maps");
        let data = read.slice(..).get_mapped_range().expect("mapped");
        all.extend(data.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
    }
    all
}

#[test]
fn the_clip_position_is_the_same_on_every_backend() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let mut results: Vec<(String, Vec<f32>)> = Vec::new();
    for adapter in pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all())) {
        let info = adapter.get_info();
        if info.device_type == wgpu::DeviceType::Cpu || !matches!(info.backend, wgpu::Backend::Dx12 | wgpu::Backend::Vulkan | wgpu::Backend::Metal) {
            continue;
        }
        let Ok((device, queue)) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())) else { continue };
        results.push((format!("{:?} {}", info.backend, info.name), run(&device, &queue)));
    }
    if results.is_empty() {
        eprintln!("skipped: no desktop GPU adapter");
        return;
    }
    let exact: Vec<f32> = SIZES.iter().flat_map(|&size| positions(size).into_iter().flat_map(move |t| expected(t, size))).collect();
    for (name, got) in &results {
        let far = got.iter().zip(&exact).filter(|(g, e)| (g.to_bits() as i64 - e.to_bits() as i64).abs() > 1 && (**g - **e).abs() > 2e-7).count();
        assert_eq!(far, 0, "{name}: {far} of {} clip positions are more than an ulp from the exact value", exact.len());
    }
    for (name, got) in &results[1..] {
        let differing = got.iter().zip(&results[0].1).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
        assert_eq!(differing, 0, "{name} differs from {} in {differing} of {} clip positions", results[0].0, got.len());
    }
}
