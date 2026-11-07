//! The glyphs the interface always needs, drawn before the first frame asks for them.
//!
//! Glyph masks are drawn by a worker (`docs/native/typography.md`, section 6), and a frame whose text lacks one is kept
//! back until it arrives. The interface's own text is a fixed repertoire: the bundled fonts at the sizes and weights of
//! the type roles, and the characters labels, numbers and the person's own language use. [`prewarm`] asks the worker for
//! all of it while the program starts, so the first screens find their glyphs waiting. Anything else (a project's name
//! in another script, a character no role has used) still goes through the worker and the wait for it.

use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::TypeRole;
use iced::advanced::graphics::text::cosmic_text::{CacheKey, CacheKeyFlags, Font, SubpixelBin};
use iced::advanced::graphics::text::{font_system, rendering, GlyphDrawing, Paragraph};
use iced::advanced::text::{Alignment, Ellipsis, Paragraph as _, Shaping, Text, Wrapping};
use iced::widget::text::LineHeight;
use iced::{alignment, Pixels, Size};
use std::collections::HashSet;
use std::sync::Arc;

/// Every type role of the stylesheet (`tests::the_roles_are_all_of_them` keeps this list whole).
pub fn roles() -> [TypeRole; 17] {
    [
        scale::TYPE_MICRO,
        scale::TYPE_SMALL,
        scale::TYPE_SMALL_STRONG,
        scale::TYPE_UI,
        scale::TYPE_UI_STRONG,
        scale::TYPE_VALUE,
        scale::TYPE_BODY,
        scale::TYPE_EMPHASIS,
        scale::TYPE_NUMERAL,
        scale::TYPE_HEADING,
        scale::TYPE_TITLE,
        scale::TYPE_DISPLAY,
        scale::TYPE_BUTTON_PROMINENT,
        scale::TYPE_BUTTON,
        scale::TYPE_PANEL_TITLE,
        scale::TYPE_SECTION,
        scale::TYPE_EYEBROW,
    ]
}

/// The roles most of the text is set in: the language's own characters are drawn for these.
const COMMON: [usize; 6] = [1, 2, 3, 4, 5, 6];

/// The characters every role draws: printable ASCII and the punctuation and symbols of numbers and labels.
fn base_characters() -> Vec<char> {
    (0x20u32..0x7f).filter_map(char::from_u32).chain("°•…–—‘’“”€×÷±²³µ·".chars()).collect()
}

/// The characters of the language `locale` (a BCP 47 tag) is written in, beyond [`base_characters`]: the Latin
/// letters with accents for the Latin-script languages, the Cyrillic and Greek alphabets for theirs. Languages whose
/// text is shaped (Arabic, Hebrew, Thai, Indic) or too large to draw ahead (Chinese, Japanese, Korean) have none: their
/// text goes through the worker as it appears.
pub fn language_characters(locale: &str) -> Vec<char> {
    let language = locale.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
    let ranges: &[(u32, u32)] = match language.as_str() {
        "ru" | "uk" | "bg" | "be" | "sr" | "mk" | "kk" | "ky" | "mn" | "tg" => &[(0x400, 0x4ff)],
        "el" => &[(0x370, 0x3ff), (0x1f00, 0x1fff)],
        "ja" | "zh" | "ko" | "ar" | "fa" | "ur" | "he" | "yi" | "th" | "hi" | "bn" | "ta" | "te" | "mr" | "gu" | "kn" | "ml" | "pa" | "ne" | "si" | "km" | "lo" | "my" | "ka" | "hy" | "am" => &[],
        // Latin script: Latin-1, Latin Extended-A, and for Vietnamese the stacked accents.
        "vi" => &[(0xa0, 0x17f), (0x1a0, 0x1b0), (0x1ea0, 0x1ef9)],
        _ => &[(0xa0, 0x17f)],
    };
    ranges.iter().flat_map(|&(first, last)| (first..=last).filter_map(char::from_u32)).collect()
}

/// A paragraph of `characters` in the role's style, laid out as the interface lays text out.
fn paragraph(role: &TypeRole, characters: &[char]) -> Paragraph {
    let style = TextStyle::from_role(role);
    // Words of ten, so a glyph is not shaped against its neighbours more than a word would be.
    let content: String = characters.chunks(10).map(|word| word.iter().collect::<String>()).collect::<Vec<_>>().join(" ");
    Paragraph::with_text(Text {
        content: content.as_str(),
        bounds: Size::new(f32::INFINITY, f32::INFINITY),
        size: Pixels(style.size),
        line_height: LineHeight::Absolute(Pixels(style.line_height)),
        font: style.font,
        align_x: Alignment::Default,
        align_y: alignment::Vertical::Top,
        shaping: Shaping::Advanced,
        wrapping: Wrapping::None,
        ellipsis: Ellipsis::None,
        hint_factor: None,
    })
}

/// The glyph keys of the repertoire at `scale` for `locale`, each with the font instance that draws it. Takes the font
/// system for a moment, so it must not run before the system is built (the interface does not touch it until then).
pub fn keys(scale: f32, locale: &str) -> Vec<(CacheKey, Arc<Font>)> {
    let rendering = rendering();
    let mut flags = CacheKeyFlags::empty();
    if rendering.aliased {
        flags |= CacheKeyFlags::ALIASED;
    } else if rendering.subpixel.is_some() {
        flags |= CacheKeyFlags::LCD;
    }
    let base = base_characters();
    let language = language_characters(locale);
    let roles = roles();
    let mut wanted = HashSet::new();
    let mut glyphs = Vec::new();
    for (index, role) in roles.iter().enumerate() {
        let mut characters = base.clone();
        if COMMON.contains(&index) {
            characters.extend(language.iter().copied());
        }
        let paragraph = paragraph(role, &characters);
        for run in paragraph.buffer().layout_runs() {
            for glyph in run.glyphs {
                let physical = glyph.physical((0.0, 0.0), scale);
                for x_bin in [SubpixelBin::Zero, SubpixelBin::One, SubpixelBin::Two, SubpixelBin::Three] {
                    let mut key = physical.cache_key;
                    key.x_bin = x_bin;
                    key.flags |= flags;
                    if wanted.insert(key) {
                        glyphs.push(key);
                    }
                }
            }
        }
    }
    let mut system = font_system().write().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut fonts = std::collections::HashMap::new();
    glyphs
        .into_iter()
        .filter_map(|key| {
            let font = match fonts.get(&(key.font_id, key.font_weight, key.font_optical_size)) {
                Some(font) => Arc::clone(font),
                None => {
                    let font = system.raw().get_font_instance(key.font_id, key.font_weight, key.font_optical_size)?;
                    fonts.insert((key.font_id, key.font_weight, key.font_optical_size), Arc::clone(&font));
                    font
                }
            };
            Some((key, font))
        })
        .collect()
}

/// The repertoire laid out and its fonts collected: everything that needs the font system is done. [`Prepared::feed`]
/// then queues the glyphs for the worker without touching it again.
pub struct Prepared {
    glyphs: Vec<(CacheKey, Arc<Font>)>,
    direct_write: bool,
}

impl Prepared {
    /// How many glyphs there are to draw.
    pub fn len(&self) -> usize {
        self.glyphs.len()
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.glyphs.is_empty()
    }

    /// Queues the glyphs for the worker from a thread of its own, as the worker's bounded queue drains. Never touches the
    /// font system (the interface thread takes it synchronously). Returns at once, with the thread that feeds the worker
    /// (it ends when everything is queued).
    pub fn feed(self) -> Option<std::thread::JoinHandle<()>> {
        std::thread::Builder::new().name("glyph-warm".into()).spawn(move || feed(self.glyphs, self.direct_write)).ok()
    }
}

/// Lays the repertoire out at `scale` for `locale` and collects its fonts, or `None` where glyphs are drawn on the
/// calling thread. This is the part that takes the font system, so a program does it before it lets the interface thread
/// reach the fonts (`warm_up` does it before it publishes readiness).
pub fn prepare(scale: f32, locale: &str) -> Option<Prepared> {
    let drawing = rendering().glyphs;
    if drawing == GlyphDrawing::Inline {
        return None;
    }
    Some(Prepared { glyphs: keys(scale, locale), direct_write: drawing == GlyphDrawing::DirectWrite })
}

/// [`prepare`] and [`Prepared::feed`] in one: for programs and tests that have no interface thread to protect.
pub fn prewarm(scale: f32, locale: String) -> Option<std::thread::JoinHandle<()>> {
    prepare(scale, &locale)?.feed()
}

/// Feeds `glyphs` to the worker as its queue has room, for at most ten seconds.
fn feed(glyphs: Vec<(CacheKey, Arc<Font>)>, direct_write: bool) {
    let mut glyphs: std::collections::VecDeque<_> = glyphs.into();
    let started = std::time::Instant::now();
    let mut stalled = 0;
    while !glyphs.is_empty() && started.elapsed() < std::time::Duration::from_secs(10) && stalled < 400 {
        if cryoglyph::prewarm(&mut glyphs, direct_write) == 0 {
            // The queue is full (or the warm results are not being used): let the worker catch up.
            stalled += 1;
            std::thread::sleep(std::time::Duration::from_millis(5));
        } else {
            stalled = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_roles_are_all_of_them() {
        let source = include_str!("tokens.rs");
        let declared = source.matches("pub const TYPE_").count();
        assert_eq!(declared, roles().len(), "a role was added to the stylesheet: list it in `roles`");
    }

    #[test]
    fn a_language_draws_its_own_script() {
        let italian = language_characters("it-IT");
        assert!(italian.contains(&'à') && italian.contains(&'ù'), "Latin-1 accents");
        let russian = language_characters("ru-RU");
        assert!(russian.contains(&'Ж') && !russian.contains(&'à'));
        assert!(language_characters("el-GR").contains(&'Ω'));
        assert!(language_characters("vi-VN").contains(&'ế'));
        assert!(language_characters("ja-JP").is_empty(), "shaped or too large to draw ahead");
        assert!(!language_characters("").is_empty(), "an unknown language is Latin");
    }
}
