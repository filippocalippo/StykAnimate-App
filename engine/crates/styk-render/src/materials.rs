//! The noise material atlas of generated effects (docs/engine/vfx.md, Generated effects):
//! the procedural materials (`styk_eval::vfx::generated::atlas`) in one two-channel texture
//! (density, light) of 1,024 texels square with its reduced levels, sampled trilinearly by
//! material particles within their cells. A placeholder texel until a draw list needs a
//! material; then the full atlas (2.7 MB), filled material by material as lists name them
//! (`DrawList::materials`) and as the engine's workers finish generating them.

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
    /// Uploads the materials in `rows` (one bit each) not uploaded yet and ready: the engine's
    /// workers generate them when a document with generated effects opens. One not ready is
    /// never generated here (the interface thread draws this): the list draws its particles
    /// as soft discs meanwhile and asks to be drawn again (styk-draw `MATERIALS_PENDING`).
    pub(crate) fn ensure_materials(&mut self, rows: u32) {
        // Bits beyond the rows say other things (styk-draw `MATERIALS_REDUCED`, `MATERIALS_PENDING`).
        let all = (1u32 << MATERIAL_ROWS) - 1;
        let rows = rows & all;
        // Cells are sampled within their own sides; exact sizes still bring every material in, so
        // what a frame draws never depends on the lists before it.
        let rows = if self.exact_sizes && rows != 0 { all } else { rows };
        let missing = rows & !self.materials.rows;
        if missing == 0 {
            return;
        }
        // 1,024 texels square: within every device's limit (WebGL2 guarantees 2,048).
        if self.device.limits().max_texture_dimension_2d < MATERIAL_CELL * MATERIAL_COLUMNS.max(MATERIAL_ROWS) {
            return;
        }
        if !self.materials.full {
            self.materials = Materials::create(&self.device, true);
            crate::resources::warm_texture(&self.queue, &self.materials.texture);
            self.rebind_sprites();
        }
        for row in 0..MATERIAL_ROWS {
            if missing & 1 << row == 0 {
                continue;
            }
            let Some(material) = atlas::ready(row as usize) else { continue };
            for (mip, level) in material.levels.iter().enumerate() {
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
            self.materials.rows |= 1 << row;
        }
    }
}
