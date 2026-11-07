//! The main window's settings: today's `desktop/main.cjs` window, and how an unattended run is kept off the desktop.
//!
//! On Windows the window is frameless and made hidden: the shell (`crate::shell`) puts it at its saved frame and shows it, so
//! it never appears at one place and jumps to another.

use iced::{Point, Size, window};
use styk_core::Launch;
use styk_platform::unattended::Strategy;

/// The window's default logical size (`desktop/main.cjs`: 1560 x 1000).
pub const DEFAULT_SIZE: (u32, u32) = (1560, 1000);

/// The smallest the window can be made (`desktop/main.cjs`: 1000 x 680).
pub const MIN_SIZE: (u32, u32) = (1000, 680);

/// Where an unattended window sits: far outside any desktop.
const OFF_SCREEN: f32 = -20000.0;

/// Whether the window is created hidden and shown afterwards without activation (Windows' unattended strategy): a
/// window created visible is activated as it appears, wherever it is, and would take the keyboard.
pub const fn shown_after_creation(strategy: Option<Strategy>) -> bool {
    matches!(strategy, Some(Strategy::HiddenWindow))
}

/// Whether the shell shows the window itself, at the frame it chose (every ordinary Windows run).
pub const fn shell_shows(strategy: Option<Strategy>) -> bool {
    cfg!(windows) && strategy.is_none()
}

/// The main window's settings. `strategy` is how an unattended run keeps off the desktop (`styk_platform::unattended`),
/// or nothing for an ordinary run; the headless strategy opens no window, so it never reaches here.
pub fn settings(launch: &Launch, strategy: Option<Strategy>) -> window::Settings {
    let (width, height) = launch.size.unwrap_or(DEFAULT_SIZE);
    let mut settings = window::Settings {
        size: Size::new(width as f32, height as f32),
        // An explicit `--size` may ask for less than the usual minimum (a test of a small window); it is then the minimum.
        min_size: Some(Size::new(MIN_SIZE.0.min(width) as f32, MIN_SIZE.1.min(height) as f32)),
        // The window controls are drawn by the interface on Windows and Linux (`frame: false` in main.cjs); macOS keeps
        // its title bar until the shell is built.
        decorations: cfg!(target_os = "macos"),
        visible: !shown_after_creation(strategy) && !shell_shows(strategy),
        // The close guard of the core decides when the program ends; until it exists the shell saves and exits.
        exit_on_close_request: false,
        ..window::Settings::default()
    };
    #[cfg(windows)]
    {
        settings.platform_specific.undecorated_shadow = true;
    }
    if strategy.is_some() {
        settings.position = window::Position::Specific(Point::new(OFF_SCREEN, OFF_SCREEN));
        #[cfg(windows)]
        {
            settings.platform_specific.skip_taskbar = true;
        }
        #[cfg(target_os = "linux")]
        if strategy == Some(Strategy::OverrideRedirectWindow) {
            // The window manager never sees an override-redirect window: it takes no focus and gets no taskbar entry.
            settings.platform_specific.override_redirect = true;
        }
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_window_is_todays_window() {
        let settings = settings(&Launch::default(), None);
        assert_eq!(settings.size, Size::new(1560.0, 1000.0));
        assert_eq!(settings.min_size, Some(Size::new(1000.0, 680.0)));
        assert_eq!(settings.visible, !cfg!(windows), "on Windows the shell shows the window at its frame");
        assert!(!settings.exit_on_close_request);
        assert!(matches!(settings.position, window::Position::Default));
    }

    #[test]
    fn size_comes_from_the_command_line() {
        let launch = Launch { size: Some((800, 600)), ..Launch::default() };
        let settings = settings(&launch, None);
        assert_eq!(settings.size, Size::new(800.0, 600.0));
        assert_eq!(settings.min_size, Some(Size::new(800.0, 600.0)), "a size below the usual minimum is not clamped up to it");
    }

    #[test]
    fn an_unattended_window_is_off_screen_whatever_the_strategy() {
        for strategy in [Strategy::HiddenWindow, Strategy::OverrideRedirectWindow] {
            let settings = settings(&Launch::default(), Some(strategy));
            assert!(matches!(settings.position, window::Position::Specific(point) if point == Point::new(-20000.0, -20000.0)), "{strategy:?}");
        }
    }

    #[test]
    fn only_the_hidden_window_strategy_is_created_hidden() {
        assert!(!settings(&Launch::default(), Some(Strategy::HiddenWindow)).visible);
        assert!(settings(&Launch::default(), Some(Strategy::OverrideRedirectWindow)).visible);
        assert_eq!(settings(&Launch::default(), None).visible, !cfg!(windows));
    }

    #[cfg(windows)]
    #[test]
    fn the_frameless_window_keeps_its_shadow_and_has_no_native_decorations() {
        let settings = settings(&Launch::default(), None);
        assert!(!settings.decorations);
        assert!(settings.platform_specific.undecorated_shadow);
    }

    #[cfg(windows)]
    #[test]
    fn a_hidden_window_has_no_taskbar_entry() {
        assert!(settings(&Launch::default(), Some(Strategy::HiddenWindow)).platform_specific.skip_taskbar);
        assert!(!settings(&Launch::default(), None).platform_specific.skip_taskbar);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_x11_unattended_window_is_override_redirect() {
        assert!(settings(&Launch::default(), Some(Strategy::OverrideRedirectWindow)).platform_specific.override_redirect);
        assert!(!settings(&Launch::default(), None).platform_specific.override_redirect);
    }
}
