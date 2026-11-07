//! The font system, built off the interface thread.
//!
//! iced builds its global font system on first use: it scans every installed font (about a second on a cold start),
//! and every other thread that asks for it meanwhile waits. Left to happen at the first label, that is a frozen
//! window. The rule here is:
//!
//! 1. [`warm_up`] is the first task the program starts. A worker thread builds the system, adds the bundled Inter and
//!    Inter Tight, and only then marks it [`ready`].
//! 2. Until [`ready`], nothing on the interface thread reaches the font system: the view is built without text (and
//!    `iced::Settings::fonts` is not used, because the runtime loads those on the event loop, which would build the
//!    system there).
//! 3. [`warm_up`] resolves when the system is ready; the program then shows its text.
//!
//! The event loop keeps running through all of it: the only thing it waits for is a message.

use crate::fonts;
use crate::tokens::scale;
use iced::advanced::graphics::text::cosmic_text::fontdb::{Database, Source};
use iced::advanced::graphics::text::cosmic_text::{Fallback, PlatformFallback, Script};
use iced::advanced::graphics::text::{font_system, font_system_if_built};
use iced::Task;
use std::borrow::Cow;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static READY: AtomicBool = AtomicBool::new(false);
static BUILT_EARLY: AtomicBool = AtomicBool::new(false);

/// Proof that the font system is ready. The code that lays out text asks for one: the view's text-bearing part takes a
/// `Ready` argument, so a screen that needs fonts cannot be built before [`warm_up`] has finished.
#[derive(Clone, Copy, Debug)]
pub struct Ready(());

/// The proof, once the font system is ready.
pub fn proof() -> Option<Ready> {
    ready().then_some(Ready(()))
}

/// Whether the font system was built by someone other than the warm-up worker: the interface thread reached it first
/// and waited for the scan. A run that ends with this true has a defect (`styk-text-check` and the application fail it).
pub fn built_early() -> bool {
    BUILT_EARLY.load(Ordering::Acquire)
}

/// How long the warm-up worker waits before it starts, from `STYK_FONT_WARMUP_DELAY_MS` (milliseconds, default 0): the
/// cold start of a machine with thousands of fonts, reproduced, so that a run shows what the interface does and does
/// not touch while the fonts load.
pub fn delay_from_environment() -> Duration {
    Duration::from_millis(std::env::var("STYK_FONT_WARMUP_DELAY_MS").ok().and_then(|value| value.parse().ok()).unwrap_or(0))
}

/// Whether the font system is built and holds the bundled fonts, so text can be laid out without waiting.
pub fn ready() -> bool {
    READY.load(Ordering::Acquire)
}

/// Builds the font system on a worker and resolves when [`ready`]; the worker starts after
/// [`delay_from_environment`].
pub fn warm_up() -> Task<()> {
    warm_up_after(delay_from_environment())
}

/// [`warm_up`] that starts building after `delay`.
pub fn warm_up_after(delay: Duration) -> Task<()> {
    Task::future(async move {
        let (sender, receiver) = iced::futures::channel::oneshot::channel();
        let spawned = std::thread::Builder::new().name("fonts".into()).spawn(move || {
            std::thread::sleep(delay);
            build_on_worker();
            let _ = sender.send(());
        });
        if spawned.is_ok() {
            let _ = receiver.await;
        } else {
            // No worker could be started: build here, once; the interface is the only thing left to wait.
            build_on_worker();
        }
    })
}

/// What the worker does: notes whether the system already existed (the interface thread built it first), builds it if
/// not, installs the bundled fonts and marks it ready.
fn build_on_worker() {
    if font_system_if_built().is_some() {
        BUILT_EARLY.store(true, Ordering::Release);
    }
    build();
}

/// Builds the system (the first call to it does) and installs the bundled fonts, then marks it ready.
fn build() {
    let _ = install_bundled();
    READY.store(true, Ordering::Release);
}

/// Makes the bundled Inter and Inter Tight the only faces of those families.
///
/// The text stack scans the installed fonts, and a machine with a static Inter installed would otherwise answer
/// "Inter" with that file: no `wght` or `opsz` axis, other metrics. A web font beats an installed font of the same
/// name in the browser; here the bundled one does, by dropping the installed faces of those two families first.
/// Calling it again changes nothing.
pub fn install_bundled() -> Ready {
    let mut system = font_system().write().unwrap_or_else(|poisoned| poisoned.into_inner());
    drop_installed(system.raw().db_mut());
    for font in fonts::ALL {
        system.load_font(Cow::Borrowed(font));
    }
    system.raw().set_fallback(StylesheetFallback);
    // The text system's other setup: how glyphs are rasterized and blended (subpixel coverage, contrast).
    crate::typography::apply_system_text_rendering();
    Ready(())
}

/// The families after Inter in `--font-ui`, in the stylesheet's order, with the emoji and symbol faces a browser
/// reaches last. The browser tries the stylesheet's families in order for every character Inter lacks; the text stack
/// would otherwise choose by script and system locale (Yu Gothic for kana on a Japanese system, Arial for Arabic),
/// and the same text would look different in the two programs.
fn stylesheet_families() -> &'static [&'static str] {
    static FAMILIES: OnceLock<Vec<&'static str>> = OnceLock::new();
    FAMILIES.get_or_init(|| {
        let mut families: Vec<&'static str> = scale::FONT_UI
            .split(',')
            .map(|name| name.trim().trim_matches('"'))
            .filter(|name| !matches!(*name, "Inter" | "system-ui" | "-apple-system" | "sans-serif"))
            .collect();
        // `system-ui` is Segoe UI on Windows, which the list already names.
        families.extend(["Segoe UI Emoji", "Segoe UI Symbol", "Segoe UI Historic"]);
        families
    })
}

/// The font fallback of the interface: the stylesheet's families first, then the platform's choice per script for
/// the scripts those do not cover (Thai, Devanagari, ...). Han, kana and Hangul have no platform entry here: the
/// stylesheet's `Microsoft YaHei UI` answers for them, as it does in the browser.
struct StylesheetFallback;

impl Fallback for StylesheetFallback {
    fn common_fallback(&self) -> &[&'static str] {
        stylesheet_families()
    }

    fn forbidden_fallback(&self) -> &[&'static str] {
        &[]
    }

    fn script_fallback(&self, script: Script, locale: &str) -> &[&'static str] {
        match script {
            Script::Han | Script::Hangul | Script::Hiragana | Script::Katakana => &[],
            _ => PlatformFallback.script_fallback(script, locale),
        }
    }
}

/// Removes the faces of the bundled families that came from files on disk; the bundled ones are in memory.
fn drop_installed(database: &mut Database) {
    let installed: Vec<_> = database
        .faces()
        .filter(|face| face.families.iter().any(|(name, _)| name == fonts::INTER_FAMILY || name == fonts::INTER_TIGHT_FAMILY))
        .filter(|face| !matches!(face.source, Source::Binary(_)))
        .map(|face| face.id)
        .collect();
    for id in installed {
        database.remove_face(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_ready_until_the_worker_has_loaded_the_bundled_fonts() {
        // One test owns the global flag: a second would see the first's result.
        assert!(!ready(), "the font system must not be ready before warm_up runs");
        let started = std::time::Instant::now();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            build();
            sender.send(()).unwrap();
        });
        // While the worker is still on its way the caller can poll without ever waiting for it.
        let mut polls = 0;
        while receiver.try_recv().is_err() {
            assert!(!ready() || started.elapsed() >= Duration::from_millis(150));
            polls += 1;
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(polls > 5, "the caller kept running while the font system was built ({polls} polls)");
        assert!(ready());
        let system = iced::advanced::graphics::text::font_system_if_built().expect("built");
        let families: Vec<String> = system.read().unwrap().families().map(str::to_owned).collect();
        assert!(families.iter().any(|name| name == fonts::INTER_FAMILY), "{families:?}");
        assert!(families.iter().any(|name| name == fonts::INTER_TIGHT_FAMILY), "{families:?}");
    }

    #[test]
    fn an_installed_inter_never_answers_for_the_bundled_one() {
        use iced::advanced::graphics::text::cosmic_text::fontdb::{FaceInfo, Language, Stretch, Style, Weight, ID};
        let mut database = Database::new();
        let installed = |family: &str| FaceInfo {
            id: ID::dummy(),
            source: Source::File("C:/Windows/Fonts/installed.ttf".into()),
            index: 0,
            families: vec![(family.to_string(), Language::English_UnitedStates)],
            post_script_name: String::new(),
            style: Style::Normal,
            weight: Weight::NORMAL,
            stretch: Stretch::Normal,
            monospaced: false,
        };
        let _ = database.push_face_info(installed(fonts::INTER_FAMILY));
        let _ = database.push_face_info(installed(fonts::INTER_TIGHT_FAMILY));
        let other = database.push_face_info(installed("Segoe UI"));
        database.load_font_data(fonts::INTER.to_vec());
        drop_installed(&mut database);
        let faces: Vec<_> = database.faces().map(|face| (face.families[0].0.clone(), matches!(face.source, Source::Binary(_)))).collect();
        assert_eq!(faces.iter().filter(|(name, _)| name == fonts::INTER_FAMILY).collect::<Vec<_>>(), [&(fonts::INTER_FAMILY.to_string(), true)], "{faces:?}");
        assert!(!faces.iter().any(|(name, _)| name == fonts::INTER_TIGHT_FAMILY), "{faces:?}");
        assert!(database.face(other).is_some(), "other installed fonts stay");
    }
}
