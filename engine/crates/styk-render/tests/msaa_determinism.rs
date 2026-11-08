//! Exact reproducer of the native DX12 MSAA floor; see msaa-determinism.md beside this file.
//! No Renderer, evaluator, assets, uniforms, uploads, caches, tiles or production shaders participate.
//! The ignored DX12 assertions are intentionally exact and currently fail on the recorded driver.

use styk_render::wgpu;

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const INSTANCES: u32 = 32 * 32 * 3;
const SHADER: &str = include_str!("support/msaa_determinism.wgsl");

struct Scene {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    multisample: wgpu::Texture,
    output: wgpu::Texture,
}

impl Scene {
    fn new(backend: wgpu::Backends, unoptimized: bool, opaque: bool) -> Self {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = backend;
        // Pin the compiler and flags, independent of the test profile and host environment.
        descriptor.backend_options.dx12.shader_compiler = wgpu::Dx12Compiler::Fxc;
        descriptor.flags = wgpu::InstanceFlags::VALIDATION;
        if unoptimized {
            descriptor.flags |= wgpu::InstanceFlags::DEBUG;
        }
        let instance = wgpu::Instance::new(descriptor);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        })).expect("the requested backend must be available for this GPU test");
        eprintln!("MSAA determinism: {:?}, unoptimized={unoptimized}, opaque={opaque}", adapter.get_info());
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("GPU device");
        let source = if opaque { SHADER.replace("var alpha = 0.535;", "var alpha = 1.0;") } else { SHADER.to_owned() };
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("independent MSAA reproducer"), source: wgpu::ShaderSource::Wgsl(source.into()) });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("independent MSAA reproducer"),
            layout: None,
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count: 4, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let texture = |samples| device.create_texture(&wgpu::TextureDescriptor {
            label: Some("independent MSAA target"),
            size: wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | if samples == 1 { wgpu::TextureUsages::COPY_SRC } else { wgpu::TextureUsages::TEXTURE_BINDING },
            view_formats: &[],
        });
        let (multisample, output) = (texture(4), texture(1));
        Self { device, queue, pipeline, multisample, output }
    }

    fn frame(&self, split: bool) -> Vec<u8> {
        let source = self.multisample.create_view(&Default::default());
        let destination = self.output.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("independent MSAA draw"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &source, depth_slice: None, resolve_target: Some(&destination),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            if split {
                for i in 0..INSTANCES { pass.draw(0..6, i..i + 1); }
            } else {
                pass.draw(0..6, 0..INSTANCES);
            }
        }
        self.queue.submit([encoder.finish()]);
        // Independent, checked readback. WIDTH*4 is already aligned: no padding or row conversion.
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("independent MSAA readback"), size: u64::from(WIDTH * HEIGHT * 4),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            self.output.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(WIDTH * 4), rows_per_image: Some(HEIGHT) } },
            wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let slice = staging.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| sender.send(result).expect("mapping receiver"));
        self.device.poll(wgpu::PollType::wait_indefinitely()).expect("readback completion");
        receiver.recv().expect("mapping callback").expect("mapped readback");
        let pixels = slice.get_mapped_range().expect("mapped bytes").to_vec();
        staging.unmap();
        pixels
    }
}

fn different(a: &[u8], b: &[u8]) -> usize {
    assert_eq!(a.len(), b.len());
    a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(a, b)| a != b).count()
}

fn equality(backend: wgpu::Backends, unoptimized: bool, opaque: bool, split: bool) {
    let mut reference: Option<Vec<u8>> = None;
    let mut failures = 0;
    for device in 0..3 {
        let scene = Scene::new(backend, unoptimized, opaque);
        let first = scene.frame(false);
        if let Some(reference) = &reference {
            let changed = different(reference, &first);
            eprintln!("device {device}, fresh device: {changed} different pixels");
            failures += usize::from(changed != 0);
        }
        reference = Some(first.clone());
        let mut changed_frames = 0;
        // Repetition is necessary: the same command stream fails intermittently on DX12.
        // Partitioning preserves primitive order and reproduces the discrepancy every time here.
        for run in 1..if split { 2 } else { 30 } {
            let next = scene.frame(split);
            let changed = different(&first, &next);
            if changed != 0 {
                let largest = first.iter().zip(&next).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
                eprintln!("device {device}, run {run}: {changed} pixels differ, maximum {largest} channel levels");
                changed_frames += 1;
            }
        }
        eprintln!("device {device}: {changed_frames} differing frames");
        failures += changed_frames;
    }
    assert_eq!(failures, 0, "MSAA frames must be byte-identical, including fresh devices");
}

#[test]
#[ignore = "ND platform floor: DX12/FXC + NVIDIA 617.42 changes MSAA bytes; run explicitly to recheck"]
fn dx12_repeated_frames_are_identical() { equality(wgpu::Backends::DX12, false, false, false); }

#[test]
#[ignore = "ND platform floor persists with FXC optimization disabled; run explicitly to recheck"]
fn dx12_unoptimized_repeated_frames_are_identical() { equality(wgpu::Backends::DX12, true, false, false); }

#[test]
#[ignore = "ND platform floor: order-preserving draw partition changes DX12 MSAA bytes"]
fn dx12_draw_partition_preserves_bytes() { equality(wgpu::Backends::DX12, false, false, true); }

#[test]
#[ignore = "Explicit GPU control for ND; needs Vulkan on the same hardware as the DX12 reproducer"]
fn vulkan_repeated_frames_are_identical() { equality(wgpu::Backends::VULKAN, false, false, false); }

#[test]
#[ignore = "Explicit GPU control for ND; needs Vulkan on the same hardware as the DX12 reproducer"]
fn vulkan_draw_partition_preserves_bytes() { equality(wgpu::Backends::VULKAN, false, false, true); }

#[test]
#[ignore = "Explicit opaque control for ND; needs DX12"]
fn dx12_opaque_frames_are_identical() { equality(wgpu::Backends::DX12, false, true, false); }
