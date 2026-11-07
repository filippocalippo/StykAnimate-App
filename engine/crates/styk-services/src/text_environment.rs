//! Portable text settings supplied by the host.

/// What the system does to the edges of text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Smoothing {
    /// No smoothing: text is aliased.
    Off,
    /// Grayscale antialiasing.
    Grayscale,
    /// ClearType: antialiasing with the display's subpixels.
    ClearType,
}

/// The order of the display's subpixels, left to right.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubpixelOrder {
    /// Red, green, blue.
    Rgb,
    /// Blue, green, red.
    Bgr,
}

/// The system's text smoothing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontSmoothing {
    /// What is done to the edges of text.
    pub smoothing: Smoothing,
    /// The order of the display's subpixels.
    pub order: SubpixelOrder,
    /// The contrast the person configured for the primary display, when they did.
    pub contrast: Option<f32>,
    /// The gamma the person configured for the primary display, when they did.
    pub gamma: Option<f32>,
}

impl Default for FontSmoothing {
    /// Grayscale with no preferences: what a platform without the setting gets.
    fn default() -> Self {
        FontSmoothing { smoothing: Smoothing::Grayscale, order: SubpixelOrder::Rgb, contrast: None, gamma: None }
    }
}

/// Queries run on the font worker before interface readiness is published.
pub trait TextEnvironment: Send + Sync {
    fn smoothing(&self) -> FontSmoothing;
    fn scale(&self) -> f32;
    fn locale(&self) -> String;
}
