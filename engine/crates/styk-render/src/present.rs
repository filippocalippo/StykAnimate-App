//! Handing a finished frame over: drawn into the host's render pass, or read
//! back as pixels (tools, tests, exports).

use crate::Renderer;

impl Renderer {
    /// Draws the rendered frame into the host's render pass (viewport already set).
    pub fn present(&self, pass: &mut wgpu::RenderPass<'_>) {
        let Some((_, _, bind, _)) = &self.output else { return };
        pass.set_pipeline(&self.blit);
        pass.set_bind_group(0, bind, &[]);
        pass.draw(0..3, 0..1);
    }

    /// The offscreen frame (for screenshots/tests).
    pub fn frame_texture(&self) -> Option<&wgpu::Texture> {
        self.output.as_ref().map(|o| &o.0)
    }

}

/// Reads back the offscreen frame as RGBA8 rows (tests and screenshots).
pub fn read_frame(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture) -> (u32, u32, Vec<u8>) {
    let (w, h) = (texture.width(), texture.height());
    let row = (w * 4).div_ceil(256) * 256;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("styk readback"),
        size: (row * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = slice.get_mapped_range().expect("mapped readback");
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        out.extend_from_slice(&data[(y * row) as usize..(y * row + w * 4) as usize]);
    }
    drop(data);
    staging.unmap();
    (w, h, out)
}

