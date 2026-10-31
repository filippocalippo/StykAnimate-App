//! What an export asks for: the output size and Pivot's three sampling choices
//! (`src/export-sampling.mjs`, docs/export-sampling.md).

use styk_render::Edges;

/// The largest output side, in pixels (`exportSamplingSize`).
pub const MAX_SIDE: u32 = 16_384;
/// The most pixels an output frame may have (Safari's canvases stop at 16,777,216; the
/// interface passes that bound there).
pub const MAX_PIXELS: u64 = 67_108_864;

/// Pivot's pixel-export sampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Smoothing {
    /// Smooth edges (the default): antialiased shapes, sprites sampled to the nearest pixel.
    Edges,
    /// No smoothing: hard shape edges, opacity kept.
    None,
    /// Smooth sprites: drawn at twice the width and height, each 2×2 block averaged.
    Sprites,
}

impl Smoothing {
    /// The interface's names: `edges`, `none`, `sprites`.
    pub fn parse(name: &str) -> Option<Smoothing> {
        match name {
            "edges" => Some(Smoothing::Edges),
            "none" => Some(Smoothing::None),
            "sprites" => Some(Smoothing::Sprites),
            _ => None,
        }
    }

    /// Rendered pixels per output pixel along each axis.
    pub fn factor(self) -> u32 {
        if self == Smoothing::Sprites { 2 } else { 1 }
    }

    /// How the renderer covers edges.
    pub fn edges(self) -> Edges {
        if self == Smoothing::None { Edges::Crisp } else { Edges::Smooth }
    }

    /// `exportSVG`: composited effects/generated/3D frames are smooth even when
    /// No smoothing was requested. Plain artwork keeps the requested policy.
    pub fn edges_for(self, list: &styk_draw::DrawList) -> Edges {
        if list.composited_export { Edges::Smooth } else { self.edges() }
    }
}

/// A validated export frame size and sampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub smoothing: Smoothing,
}

impl Settings {
    /// The checks of `exportSamplingSize`: whole pixels, at most 16,384 a side and
    /// `max_pixels` in all, and Smooth sprites at most 8,192 a side (its rendering is twice as large).
    pub fn new(width: u32, height: u32, smoothing: Smoothing, max_pixels: u64) -> Result<Settings, String> {
        let max_pixels = max_pixels.min(MAX_PIXELS);
        if width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width as u64 * height as u64 > max_pixels {
            return Err(format!("Export dimensions must be whole pixels up to {MAX_SIDE} per side and {} million pixels.", (max_pixels as f64 / 1e6).round()));
        }
        let factor = smoothing.factor();
        if width * factor > MAX_SIDE || height * factor > MAX_SIDE {
            return Err("Smooth sprites supports output dimensions up to 8192 pixels per side.".into());
        }
        Ok(Settings { width, height, smoothing })
    }

    /// The size the frame is rendered at before sampling down.
    pub fn render_size(&self) -> [u32; 2] {
        let f = self.smoothing.factor();
        [self.width * f, self.height * f]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limits_are_the_interfaces() {
        assert!(Settings::new(1920, 1080, Smoothing::Edges, MAX_PIXELS).is_ok());
        assert!(Settings::new(16_384, 4_096, Smoothing::Edges, MAX_PIXELS).is_ok());
        assert!(Settings::new(16_385, 10, Smoothing::Edges, MAX_PIXELS).is_err());
        assert!(Settings::new(0, 10, Smoothing::None, MAX_PIXELS).is_err());
        assert!(Settings::new(16_384, 4_097, Smoothing::Edges, MAX_PIXELS).is_err(), "more than 67 million pixels");
        assert!(Settings::new(4_097, 4_096, Smoothing::Edges, 16_777_216).is_err(), "Safari's bound");
        assert!(Settings::new(8_192, 8_192, Smoothing::Sprites, MAX_PIXELS).is_ok());
        assert!(Settings::new(8_193, 100, Smoothing::Sprites, MAX_PIXELS).is_err());
        assert_eq!(Settings::new(640, 360, Smoothing::Sprites, MAX_PIXELS).unwrap().render_size(), [1280, 720]);
        assert_eq!(Smoothing::parse("none").map(Smoothing::edges), Some(Edges::Crisp));
        assert_eq!(Smoothing::parse("blur"), None);
    }
}
