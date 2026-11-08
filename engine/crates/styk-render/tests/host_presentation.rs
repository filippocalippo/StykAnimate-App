use styk_render::{Renderer, ViewParams, native_gpu, read_frame, wgpu};

#[test]
fn detached_presentation_composites_premultiplied_pixels_and_surface_presentation_copies() {
    let gpu = native_gpu::native_gpu(true, "host compositing regression", |a| {
        wgpu::Limits::default().using_resolution(a.limits())
    })
    .unwrap();
    let mut renderer = Renderer::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
    let target = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("opaque host"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    for (clear, composite, copied) in [
        ([0.0; 4], [51, 51, 51, 255], [0, 0, 0, 0]),
        // Exact byte centres avoid an unrelated half-way clear-to-UNORM
        // rounding tie. Source-over is [64,32,0] + [51;3]*(1-128/255).
        ([64.0/255.0, 32.0/255.0, 0.0, 128.0/255.0], [89, 57, 25, 255], [64, 32, 0, 128]),
    ] {
        let view = ViewParams {
            matrix: [1., 0., 0., 1., 0., 0.],
            artboard: [0., 0., 1., 1.],
            clip_to_artboard: false,
            clear,
            zoom: 1.,
            pan: [0.; 2],
            stretch: 1.,
            camera_view: false,
            camera_limit: 2048.,
        };
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        renderer.render(&mut encoder, &view, [1, 1]);
        gpu.queue.submit([encoder.finish()]);
        for detached in [false, true] {
            let picture = detached.then(|| renderer.take_frame().unwrap());
            let target_view = target.create_view(&Default::default());
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &target_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.2,
                                g: 0.2,
                                b: 0.2,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                if let Some(picture) = &picture {
                    picture.present(&mut pass);
                } else {
                    renderer.present(&mut pass);
                }
            }
            gpu.queue.submit([encoder.finish()]);
            assert_eq!(
                read_frame(&gpu.device, &gpu.queue, &target).2,
                if detached { composite } else { copied },
                "detached={detached}, clear={clear:?}"
            );
            if let Some(picture) = picture {
                renderer.recycle_frame(picture);
            }
        }
    }
}
