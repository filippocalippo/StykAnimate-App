//! Renderer-owned counters only. No polling the device, mapping, or GPU readback.
#[derive(Clone, Copy, Debug)]
pub struct MemoryReport {
    pub sprites: u64,
    pub soft_copies: u64,
    pub effects: u64,
    pub layers: u64,
    pub depth: u64,
    pub materials: u64,
    pub glyphs: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct PassReport {
    pub draws: u32,
    pub effects: u32,
    pub rounds: u32,
    pub downscaled: bool,
}
impl crate::Renderer {
    pub fn memory_report(&self) -> MemoryReport {
        MemoryReport {
            sprites: self.sprite_memory().1,
            soft_copies: self.soft_memory(),
            effects: self.stats.effect_bytes,
            layers: self.stats.layer_bytes,
            depth: self.stats.depth_bytes,
            materials: self.stats.material_bytes,
            glyphs: self.stats.glyph_bytes,
        }
    }
    pub fn last_frame_passes(&self) -> PassReport {
        PassReport {
            draws: self.stats.passes,
            effects: self.stats.effect_passes,
            rounds: self.stats.rounds,
            downscaled: self.stats.downscaled,
        }
    }
}
