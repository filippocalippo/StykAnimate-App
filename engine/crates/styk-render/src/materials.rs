//! The particle material atlas of generated effects (docs/engine/vfx.md,
//! Generated effects): the editor's procedural rows (`styk_eval::vfx::generated::atlas`)
//! in one two-channel texture with its reduced levels, sampled trilinearly by sprite
//! particles. A placeholder texel until a draw list needs a row; then the full atlas
//! (5.9 MB), filled row by row as lists name them (`DrawList::materials`).

use styk_draw::{MATERIAL_CELL, MATERIAL_COLUMNS, MATERIAL_LEVELS, MATERIAL_ROWS};
use styk_eval::vfx::generated::atlas;

use crate::Renderer;

pub(crate) struct Materials {
    pub(crate) texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    /// The full atlas (not the placeholder).
    full: bool,
    /// Rows uploaded, one bit each.
    rows: u32,
}

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rg8Unorm;

impl Materials {
    fn create(device: &wgpu::Device, full: bool) -> Materials {
        let (size, levels) = if full { ([MATERIAL_CELL * MATERIAL_COLUMNS, MATERIAL_CELL * MATERIAL_ROWS], MATERIAL_LEVELS) } else { ([1, 1], 1) };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("styk particle materials"),
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        Materials { texture, view, full, rows: 0 }
    }

    pub(crate) fn placeholder(device: &wgpu::Device) -> Materials {
        Materials::create(device, false)
    }

    /// GPU memory held: the full atlas with its levels, or nothing.
    pub(crate) fn bytes(&self) -> u64 {
        if !self.full {
            return 0;
        }
        (0..MATERIAL_LEVELS).map(|l| ((MATERIAL_CELL * MATERIAL_COLUMNS) >> l) as u64 * ((MATERIAL_CELL * MATERIAL_ROWS) >> l) as u64 * 2).sum()
    }
}

/// The trilinear sampler of the atlas (the editor's: linear filters and levels, clamped).
pub(crate) fn sampler(device: &wgpu::Device) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("styk particle materials"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        ..Default::default()
    })
}

impl Renderer {
    /// Uploads the material rows in `rows` (one bit each) not uploaded yet. A row no
    /// engine worker has generated yet is generated here (the engine prepares them in
    /// the background when a document with generated effects opens).
    pub(crate) fn ensure_materials(&mut self, rows: u32) {
        let missing = rows & !self.materials.rows;
        if missing == 0 {
            return;
        }
        if !self.materials.full {
            self.materials = Materials::create(&self.device, true);
            self.rebind_sprites();
        }
        for row in 0..MATERIAL_ROWS {
            if missing & 1 << row == 0 {
                continue;
            }
            for (mip, level) in atlas::row(row as usize).levels.iter().enumerate() {
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.materials.texture,
                        mip_level: mip as u32,
                        origin: wgpu::Origin3d { x: 0, y: row * level.height as u32, z: 0 },
                        aspect: wgpu::TextureAspect::All,
                    },
                    &level.data,
                    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(level.width as u32 * 2), rows_per_image: Some(level.height as u32) },
                    wgpu::Extent3d { width: level.width as u32, height: level.height as u32, depth_or_array_layers: 1 },
                );
            }
        }
        self.materials.rows |= missing;
    }
}
