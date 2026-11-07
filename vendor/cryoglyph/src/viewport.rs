use crate::raster::{Client, Lookup};
use crate::{Cache, GlyphDrawing, Params, Resolution};
use cosmic_text::{CacheKey, Font};
use std::sync::{Arc, Mutex};

use wgpu::{BindGroup, Buffer, BufferDescriptor, BufferUsages, Device, Queue};

use std::mem;
use std::slice;

/// Skia's coverage adjustment (`SkMaskGamma`): glyph coverage is bent by the text colour's luminance, with the contrast
/// and the gamma the platform asks for, so that text keeps the weight of its font on either polarity.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CoverageAdjustment {
    /// The contrast, 0 for none (Skia's default is 0.5).
    pub contrast: f32,
    /// The gamma of the luminance conversion (1 is linear).
    pub gamma: f32,
}

/// How glyphs are drawn, set on the [`Viewport`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TextRendering {
    /// The subpixels run blue, green, red instead of red, green, blue.
    pub bgr: bool,
    /// The coverage adjustment, if any.
    pub adjustment: Option<CoverageAdjustment>,
    /// Who draws the glyph masks.
    pub glyphs: GlyphDrawing,
    /// Draw glyphs without antialiasing (the system draws text unsmoothed): a pixel is covered or not.
    pub aliased: bool,
}

#[derive(Debug)]
pub struct Viewport {
    /// This viewport's glyph requests: a viewport is a consumer of the glyph worker with a bookkeeping of its own, so
    /// two windows never retire each other's requests.
    client: Mutex<Client>,
    rendering: TextRendering,
    params: Params,
    params_buffer: Buffer,
    pub(crate) bind_group: BindGroup,
}

impl Viewport {
    pub fn new(device: &Device, cache: &Cache) -> Self {
        let params = Params {
            screen_resolution: Resolution {
                width: 0,
                height: 0,
            },
            contrast: 0.0,
            gamma: 1.0,
            flags: 0,
            _pad: [0; 3],
        };

        let params_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("glyphon params"),
            size: mem::size_of::<Params>() as u64,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group = cache.create_uniforms_bind_group(device, &params_buffer);

        Self {
            client: Mutex::new(Client::new()),
            rendering: TextRendering::default(),
            params,
            params_buffer,
            bind_group,
        }
    }

    pub fn update(&mut self, queue: &Queue, resolution: Resolution) {
        if self.params.screen_resolution != resolution {
            self.params.screen_resolution = resolution;
            self.write(queue);
        }
    }

    /// Sets how glyphs are rasterized and blended: the order of the subpixels and the coverage adjustment.
    pub fn set_rendering(&mut self, queue: &Queue, rendering: TextRendering) {
        self.rendering = rendering;
        let mut params = self.params;
        params.flags = u32::from(rendering.bgr) | (u32::from(rendering.adjustment.is_some()) << 1);
        if let Some(adjustment) = rendering.adjustment {
            params.contrast = adjustment.contrast;
            params.gamma = adjustment.gamma;
        }
        if params != self.params {
            self.params = params;
            self.write(queue);
        }
    }

    fn write(&self, queue: &Queue) {
        queue.write_buffer(&self.params_buffer, 0, unsafe {
            slice::from_raw_parts(&self.params as *const Params as *const u8, mem::size_of::<Params>())
        });
    }

    /// Who draws the glyph masks.
    pub fn glyph_drawing(&self) -> GlyphDrawing {
        self.rendering.glyphs
    }

    /// Whether glyphs are drawn without antialiasing.
    pub fn aliased(&self) -> bool {
        self.rendering.aliased
    }

    /// Starts preparing a candidate frame with this viewport.
    pub fn begin_candidate(&self) {
        self.client().begin();
    }

    /// Ends the candidate frame: whether glyphs it needs are still being drawn (it is incomplete). Whatever it did not
    /// ask for again is obsolete.
    pub fn end_candidate(&self) -> bool {
        self.client().end()
    }

    /// How many glyph jobs this viewport has outstanding and how many entries (asked for or drawn and waiting) it keeps.
    pub fn glyph_state(&self) -> (usize, usize) {
        self.client().state()
    }

    pub(crate) fn lookup(&self, key: &CacheKey, font: impl FnOnce() -> Option<Arc<Font>>, direct_write: bool) -> Lookup {
        self.client().lookup(key, font, direct_write)
    }

    fn client(&self) -> std::sync::MutexGuard<'_, Client> {
        // Only this viewport's interface thread takes it: the worker never does.
        self.client.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn resolution(&self) -> Resolution {
        self.params.screen_resolution
    }
}
