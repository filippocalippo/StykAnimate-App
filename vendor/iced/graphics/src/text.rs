//! Draw text.
pub mod cache;
pub mod editor;
pub mod paragraph;

pub use cache::Cache;
pub use editor::Editor;
pub use paragraph::Paragraph;

pub use cosmic_text;

use crate::core::alignment;
use crate::core::font::{self, Font};
use crate::core::text::{Alignment, Ellipsis, Shaping, Wrapping};
use crate::core::{Color, Pixels, Point, Rectangle, Size, Transformation};

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock, RwLock, Weak};

/// A text primitive.
#[derive(Debug, Clone, PartialEq)]
pub enum Text {
    /// A paragraph.
    #[allow(missing_docs)]
    Paragraph {
        paragraph: paragraph::Weak,
        position: Point,
        color: Color,
        clip_bounds: Rectangle,
        transformation: Transformation,
        /// Drawn in grayscale even where subpixel text is on (see [`Grayscale`]).
        grayscale: bool,
    },
    /// An editor.
    #[allow(missing_docs)]
    Editor {
        editor: editor::Weak,
        position: Point,
        color: Color,
        clip_bounds: Rectangle,
        transformation: Transformation,
        /// Drawn in grayscale even where subpixel text is on (see [`Grayscale`]).
        grayscale: bool,
    },
    /// Some cached text.
    Cached {
        /// The contents of the text.
        content: String,
        /// The bounds of the text.
        bounds: Rectangle,
        /// The color of the text.
        color: Color,
        /// The size of the text in logical pixels.
        size: Pixels,
        /// The line height of the text.
        line_height: Pixels,
        /// The font of the text.
        font: Font,
        /// The horizontal alignment of the text.
        align_x: Alignment,
        /// The vertical alignment of the text.
        align_y: alignment::Vertical,
        /// The shaping strategy of the text.
        shaping: Shaping,
        /// The wrapping strategy of the text.
        wrapping: Wrapping,
        /// The ellipsis strategy of the text.
        ellipsis: Ellipsis,
        /// The clip bounds of the text.
        clip_bounds: Rectangle,
        /// Drawn in grayscale even where subpixel text is on (see [`Grayscale`]).
        grayscale: bool,
    },
    /// Some raw text.
    #[allow(missing_docs)]
    Raw {
        raw: Raw,
        transformation: Transformation,
    },
}

impl Text {
    /// Returns the visible bounds of the [`Text`].
    pub fn visible_bounds(&self) -> Option<Rectangle> {
        match self {
            Text::Paragraph {
                position,
                paragraph,
                clip_bounds,
                transformation,
                ..
            } => Rectangle::new(*position, paragraph.min_bounds)
                .intersection(clip_bounds)
                .map(|bounds| bounds * *transformation),
            Text::Editor {
                editor,
                position,
                clip_bounds,
                transformation,
                ..
            } => Rectangle::new(*position, editor.bounds)
                .intersection(clip_bounds)
                .map(|bounds| bounds * *transformation),
            Text::Cached {
                bounds,
                clip_bounds,
                ..
            } => bounds.intersection(clip_bounds),
            Text::Raw { raw, .. } => Some(raw.clip_bounds),
        }
    }
}

/// How glyphs are rasterized and blended: subpixel (ClearType-style) coverage and the coverage adjustment the platform
/// asks for (`docs/native/typography.md`, section 6). Set once by the program (`set_rendering`) before it draws.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rendering {
    /// Subpixel coverage, with the order of the subpixels, or `None` for grayscale.
    pub subpixel: Option<SubpixelOrder>,
    /// Skia's luminance-dependent coverage adjustment: `(contrast, gamma)`, or `None` for none.
    pub adjustment: Option<(f32, f32)>,
    /// Draw glyph masks with DirectWrite on a worker thread (Windows), the rasterizer the browser uses there. A frame
    /// then lacks the glyphs the worker has not drawn yet: see [`glyphs_pending`] and [`set_glyph_notifier`].
    pub direct_write: bool,
}

/// The order of the subpixels of the display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubpixelOrder {
    /// Red, green, blue from left to right.
    Rgb,
    /// Blue, green, red.
    Bgr,
}

static RENDERING: RwLock<Rendering> = RwLock::new(Rendering { subpixel: None, adjustment: None, direct_write: false });

type GlyphNotifier = std::sync::Arc<dyn Fn() + Send + Sync>;
type GlyphSource = (fn() -> usize, fn(GlyphNotifier));

static GLYPH_SOURCE: OnceLock<GlyphSource> = OnceLock::new();
static GLYPH_NOTIFIER: std::sync::Mutex<Option<GlyphNotifier>> = std::sync::Mutex::new(None);

/// The renderer tells the text stack where glyph masks come from when they are drawn off the calling thread.
pub fn install_glyph_source(pending: fn() -> usize, set_notifier: fn(GlyphNotifier)) {
    if GLYPH_SOURCE.set((pending, set_notifier)).is_ok() {
        if let Some(notifier) = GLYPH_NOTIFIER.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
            set_notifier(notifier);
        }
    }
}

/// How many glyphs a worker has been asked for and the renderer has not picked up: zero when the text on screen is
/// complete (and always zero where masks are drawn on the calling thread).
pub fn glyphs_pending() -> usize {
    GLYPH_SOURCE.get().map_or(0, |(pending, _)| pending())
}

/// Calls `notifier`, from the worker's thread, whenever glyphs have been drawn: the program asks its window for another
/// frame, which picks them up.
pub fn set_glyph_notifier(notifier: impl Fn() + Send + Sync + 'static) {
    let notifier: GlyphNotifier = std::sync::Arc::new(notifier);
    *GLYPH_NOTIFIER.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(notifier.clone());
    if let Some((_, set)) = GLYPH_SOURCE.get() {
        set(notifier);
    }
}

/// Sets how glyphs are rasterized and blended, for every window.
pub fn set_rendering(rendering: Rendering) {
    *RENDERING.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = rendering;
}

/// How glyphs are rasterized and blended.
pub fn rendering() -> Rendering {
    *RENDERING.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

thread_local! {
    static GRAYSCALE_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// While alive, text drawn on this thread is grayscale whatever [`rendering`] says: a browser draws subpixel text only
/// on opaque layers, so text under a translucent or composited surface (a faded, disabled panel; canvas text) stays
/// grayscale there too.
#[derive(Debug)]
pub struct Grayscale(());

impl Grayscale {
    /// Starts a scope of grayscale text.
    pub fn scope() -> Self {
        GRAYSCALE_DEPTH.with(|depth| depth.set(depth.get() + 1));
        Self(())
    }
}

impl Drop for Grayscale {
    fn drop(&mut self) {
        GRAYSCALE_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// Whether a [`Grayscale`] scope is active on this thread.
pub fn grayscale_active() -> bool {
    GRAYSCALE_DEPTH.with(|depth| depth.get() > 0)
}

/// The regular variant of the [Fira Sans] font.
///
/// It is loaded as part of the default fonts when the `fira-sans`
/// feature is enabled.
///
/// [Fira Sans]: https://mozilla.github.io/Fira/
#[cfg(feature = "fira-sans")]
pub const FIRA_SANS_REGULAR: &[u8] = include_bytes!("../fonts/FiraSans-Regular.ttf").as_slice();

static FONT_SYSTEM: OnceLock<RwLock<FontSystem>> = OnceLock::new();

/// Returns the global [`FontSystem`] if it has been built, and never builds it.
///
/// Building it scans every installed font and can take about a second. [`font_system`] does that on first use, on
/// the calling thread, and any other thread that asks meanwhile waits for it. A program that must not stall its event
/// loop builds it on a worker (calling [`font_system`] there) and lets nothing on the interface thread reach it
/// before this returns `Some`.
pub fn font_system_if_built() -> Option<&'static RwLock<FontSystem>> {
    FONT_SYSTEM.get()
}

/// Returns the global [`FontSystem`], building it on first use.
pub fn font_system() -> &'static RwLock<FontSystem> {
    FONT_SYSTEM.get_or_init(|| {
        #[allow(unused_mut)]
        let mut raw = cosmic_text::FontSystem::new_with_fonts([
            cosmic_text::fontdb::Source::Binary(Arc::new(
                include_bytes!("../fonts/Iced-Icons.ttf").as_slice(),
            )),
            #[cfg(feature = "fira-sans")]
            cosmic_text::fontdb::Source::Binary(Arc::new(
                include_bytes!("../fonts/FiraSans-Regular.ttf").as_slice(),
            )),
        ]);

        #[cfg(feature = "fira-sans")]
        raw.db_mut().set_sans_serif_family("Fira Sans");

        #[cfg(target_os = "macos")]
        {
            #[cfg(not(feature = "fira-sans"))]
            raw.db_mut().set_sans_serif_family(".SF NS");
            raw.db_mut().set_serif_family("Times New Roman");
            raw.db_mut().set_monospace_family("Menlo");
        }

        #[cfg(target_os = "windows")]
        {
            #[cfg(not(feature = "fira-sans"))]
            raw.db_mut().set_sans_serif_family("Segoe UI");
            raw.db_mut().set_serif_family("Times New Roman");
            raw.db_mut().set_monospace_family("Consolas");
        }

        RwLock::new(FontSystem {
            raw,
            loaded_fonts: HashSet::new(),
            version: Version::default(),
        })
    })
}

/// A set of system fonts.
pub struct FontSystem {
    raw: cosmic_text::FontSystem,
    loaded_fonts: HashSet<usize>,
    version: Version,
}

impl FontSystem {
    /// Returns the raw [`cosmic_text::FontSystem`].
    pub fn raw(&mut self) -> &mut cosmic_text::FontSystem {
        &mut self.raw
    }

    /// Loads a font from its bytes.
    pub fn load_font(&mut self, bytes: Cow<'static, [u8]>) {
        if let Cow::Borrowed(bytes) = bytes {
            let address = bytes.as_ptr() as usize;

            if !self.loaded_fonts.insert(address) {
                return;
            }
        }

        let _ = self
            .raw
            .db_mut()
            .load_font_source(cosmic_text::fontdb::Source::Binary(Arc::new(
                bytes.into_owned(),
            )));

        self.version = Version(self.version.0 + 1);
    }

    /// Returns an iterator over the family names of all font faces
    /// in the font database.
    pub fn families(&self) -> impl Iterator<Item = &str> {
        self.raw
            .db()
            .faces()
            .filter_map(|face| face.families.first())
            .map(|(name, _)| name.as_str())
    }

    /// Returns the current [`Version`] of the [`FontSystem`].
    ///
    /// Loading a font will increase the version of a [`FontSystem`].
    pub fn version(&self) -> Version {
        self.version
    }
}

/// A version number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Version(u32);

/// A weak reference to a [`cosmic_text::Buffer`] that can be drawn.
#[derive(Debug, Clone)]
pub struct Raw {
    /// A weak reference to a [`cosmic_text::Buffer`].
    pub buffer: Weak<cosmic_text::Buffer>,
    /// The position of the text.
    pub position: Point,
    /// The color of the text.
    pub color: Color,
    /// The clip bounds of the text.
    pub clip_bounds: Rectangle,
}

impl PartialEq for Raw {
    fn eq(&self, _other: &Self) -> bool {
        // TODO: There is no proper way to compare raw buffers
        // For now, no two instances of `Raw` text will be equal.
        // This should be fine, but could trigger unnecessary redraws
        // in the future.
        false
    }
}

/// Measures the dimensions of the given [`cosmic_text::Buffer`].
pub fn measure(buffer: &cosmic_text::Buffer) -> (Size, bool) {
    let (width, height, has_rtl) =
        buffer
            .layout_runs()
            .fold((0.0, 0.0, false), |(width, height, has_rtl), run| {
                (
                    run.line_w.max(width),
                    height + run.line_height,
                    has_rtl || run.rtl,
                )
            });

    (Size::new(width, height), has_rtl)
}

/// Aligns the given [`cosmic_text::Buffer`] with the given [`Alignment`]
/// and returns its minimum [`Size`].
pub fn align(
    buffer: &mut cosmic_text::Buffer,
    font_system: &mut cosmic_text::FontSystem,
    alignment: Alignment,
) -> Size {
    let (min_bounds, has_rtl) = measure(buffer);
    let mut needs_relayout = has_rtl;

    if let Some(align) = to_align(alignment) {
        let has_multiple_lines = buffer.lines.len() > 1
            || buffer
                .lines
                .first()
                .is_some_and(|line| line.layout_opt().is_some_and(|layout| layout.len() > 1));

        if has_multiple_lines {
            for line in &mut buffer.lines {
                let _ = line.set_align(Some(align));
            }

            needs_relayout = true;
        } else if let Some(line) = buffer.lines.first_mut() {
            needs_relayout |= line.set_align(None);
        }
    }

    // TODO: Avoid relayout with some changes to `cosmic-text` (?)
    if needs_relayout {
        log::trace!("Relayouting paragraph...");

        buffer.set_size(Some(min_bounds.width), Some(min_bounds.height));
        buffer.shape_until_scroll(font_system, false);
    }

    min_bounds
}

/// Returns the attributes of the given [`Font`]. An [`OpticalSize::Auto`] has no size to follow here and stays at the
/// font's default coordinate: use [`to_attributes_sized`] where the size of the text is known.
pub fn to_attributes(font: Font) -> cosmic_text::Attrs<'static> {
    let mut attributes = cosmic_text::Attrs::new()
        .family(to_family(font.family))
        .weight(to_weight(font.weight))
        .stretch(to_stretch(font.stretch))
        .style(to_style(font.style));

    if font.tracking != 0 {
        attributes = attributes.letter_spacing(f32::from(font.tracking) / 1000.0);
    }

    if !font.features.is_empty() {
        let mut features = cosmic_text::FontFeatures::new();

        for (tag, value) in font.features {
            let _ = features.set(cosmic_text::FeatureTag::new(tag), *value);
        }

        attributes = attributes.font_features(features);
    }

    attributes
}

/// Returns the attributes of the given [`Font`] for text of the given size in logical pixels, which sets the
/// optical size an [`OpticalSize::Auto`] font asks for.
pub fn to_attributes_sized(font: Font, size: f32) -> cosmic_text::Attrs<'static> {
    let attributes = to_attributes(font);

    match font.optical_size {
        font::OpticalSize::Default => attributes,
        font::OpticalSize::Auto => {
            attributes.optical_size(cosmic_text::OpticalSize::from_pixels(size))
        }
    }
}

fn to_family(family: font::Family) -> cosmic_text::Family<'static> {
    match family {
        font::Family::Name(name) => cosmic_text::Family::Name(name),
        font::Family::SansSerif => cosmic_text::Family::SansSerif,
        font::Family::Serif => cosmic_text::Family::Serif,
        font::Family::Cursive => cosmic_text::Family::Cursive,
        font::Family::Fantasy => cosmic_text::Family::Fantasy,
        font::Family::Monospace => cosmic_text::Family::Monospace,
    }
}

fn to_weight(weight: font::Weight) -> cosmic_text::Weight {
    match weight {
        font::Weight::Thin => cosmic_text::Weight::THIN,
        font::Weight::ExtraLight => cosmic_text::Weight::EXTRA_LIGHT,
        font::Weight::Light => cosmic_text::Weight::LIGHT,
        font::Weight::Normal => cosmic_text::Weight::NORMAL,
        font::Weight::Medium => cosmic_text::Weight::MEDIUM,
        font::Weight::Semibold => cosmic_text::Weight::SEMIBOLD,
        font::Weight::Bold => cosmic_text::Weight::BOLD,
        font::Weight::ExtraBold => cosmic_text::Weight::EXTRA_BOLD,
        font::Weight::Black => cosmic_text::Weight::BLACK,
        font::Weight::Value(value) => cosmic_text::Weight(value),
    }
}

fn to_stretch(stretch: font::Stretch) -> cosmic_text::Stretch {
    match stretch {
        font::Stretch::UltraCondensed => cosmic_text::Stretch::UltraCondensed,
        font::Stretch::ExtraCondensed => cosmic_text::Stretch::ExtraCondensed,
        font::Stretch::Condensed => cosmic_text::Stretch::Condensed,
        font::Stretch::SemiCondensed => cosmic_text::Stretch::SemiCondensed,
        font::Stretch::Normal => cosmic_text::Stretch::Normal,
        font::Stretch::SemiExpanded => cosmic_text::Stretch::SemiExpanded,
        font::Stretch::Expanded => cosmic_text::Stretch::Expanded,
        font::Stretch::ExtraExpanded => cosmic_text::Stretch::ExtraExpanded,
        font::Stretch::UltraExpanded => cosmic_text::Stretch::UltraExpanded,
    }
}

fn to_style(style: font::Style) -> cosmic_text::Style {
    match style {
        font::Style::Normal => cosmic_text::Style::Normal,
        font::Style::Italic => cosmic_text::Style::Italic,
        font::Style::Oblique => cosmic_text::Style::Oblique,
    }
}

fn to_align(alignment: Alignment) -> Option<cosmic_text::Align> {
    match alignment {
        Alignment::Default => None,
        Alignment::Left => Some(cosmic_text::Align::Left),
        Alignment::Center => Some(cosmic_text::Align::Center),
        Alignment::Right => Some(cosmic_text::Align::Right),
        Alignment::Justified => Some(cosmic_text::Align::Justified),
    }
}

/// Converts some [`Shaping`] strategy to a [`cosmic_text::Shaping`] strategy.
pub fn to_shaping(shaping: Shaping, text: &str, font: Font) -> cosmic_text::Shaping {
    match shaping {
        Shaping::Auto => {
            // The basic shaper applies no OpenType feature and no kerning: a font that asks for features, or a bundled
            // family whose text the browser kerns, is always shaped in full.
            if text.is_ascii() && font.features.is_empty() && !matches!(font.family, font::Family::Name(_)) {
                cosmic_text::Shaping::Basic
            } else {
                cosmic_text::Shaping::Advanced
            }
        }
        Shaping::Basic => cosmic_text::Shaping::Basic,
        Shaping::Advanced => cosmic_text::Shaping::Advanced,
    }
}

/// Converts some [`Wrapping`] strategy to a [`cosmic_text::Wrap`] strategy.
pub fn to_wrap(wrapping: Wrapping) -> cosmic_text::Wrap {
    match wrapping {
        Wrapping::None => cosmic_text::Wrap::None,
        Wrapping::Word => cosmic_text::Wrap::Word,
        Wrapping::Glyph => cosmic_text::Wrap::Glyph,
        Wrapping::WordOrGlyph => cosmic_text::Wrap::WordOrGlyph,
    }
}

/// Converts some [`Ellipsis`] strategy to a [`cosmic_text::Ellipsize`] strategy.
pub fn to_ellipsize(ellipsis: Ellipsis, max_height: f32) -> cosmic_text::Ellipsize {
    let limit = cosmic_text::EllipsizeHeightLimit::Height(max_height);

    match ellipsis {
        Ellipsis::None => cosmic_text::Ellipsize::None,
        Ellipsis::Start => cosmic_text::Ellipsize::Start(limit),
        Ellipsis::Middle => cosmic_text::Ellipsize::Middle(limit),
        Ellipsis::End => cosmic_text::Ellipsize::End(limit),
    }
}

/// Converts some [`Color`] to a [`cosmic_text::Color`].
pub fn to_color(color: Color) -> cosmic_text::Color {
    let [r, g, b, a] = color.into_rgba8();

    cosmic_text::Color::rgba(r, g, b, a)
}

/// Returns the ideal hint factor given the size and scale factor of some text.
pub fn hint_factor(_size: Pixels, _scale_factor: Option<f32>) -> Option<f32> {
    // TODO: Fix hinting in `cosmic-text`
    // const MAX_HINTING_SIZE: f32 = 18.0;

    // let hint_factor = scale_factor?;

    // if size.0 * hint_factor < MAX_HINTING_SIZE {
    //     Some(hint_factor)
    // } else {
    //     None
    // }

    None // Disable all text hinting for now
}

/// Computes selection regions in the given buffer.
pub fn regions(
    buffer: &cosmic_text::Buffer,
    start: cosmic_text::Cursor,
    end: cosmic_text::Cursor,
) -> Vec<Rectangle> {
    let mut regions = Vec::new();
    let scroll = buffer.scroll();

    for run in buffer.layout_runs() {
        let line_i = run.line_i;
        let line_w = run.line_w;
        let line_top = run.line_top;
        let line_height = run.line_height;
        let line_break = run.line_height / 2.0;

        if line_i >= start.line && line_i <= end.line {
            let mut highlights = run.highlight(start, end).peekable();

            if highlights.peek().is_none() && run.glyphs.is_empty() && end.line > line_i {
                regions.push(Rectangle {
                    x: 0.0,
                    y: line_top,
                    width: line_break,
                    height: line_height,
                });
            }

            while let Some((x, width)) = highlights.next() {
                let mut min = x;
                let mut max = x + width;

                // Extend the last rect to the line edge for
                // multi-line selections
                if highlights.peek().is_none() && end.line > line_i {
                    if run.rtl {
                        min = 0.0;
                    } else {
                        max = line_w + line_break;
                    }
                }

                regions.push(Rectangle {
                    x: min - scroll.horizontal,
                    y: line_top,
                    width: (max - min).max(0.0),
                    height: line_height,
                });
            }
        }
    }

    regions
}

/// A text renderer coupled to `iced_graphics`.
pub trait Renderer {
    /// Draws the given [`Raw`] text.
    fn fill_raw(&mut self, raw: Raw);
}
