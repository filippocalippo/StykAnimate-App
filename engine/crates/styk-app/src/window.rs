//! The main window's settings: today's `desktop/main.cjs` window, and the switch for unattended runs.

use iced::{Point, Size, window};
use styk_core::Launch;

/// The window's default logical size (`desktop/main.cjs`: 1560 x 1000).
pub const DEFAULT_SIZE: (u32, u32) = (1560, 1000);

/// The smallest the window can be made (`desktop/main.cjs`: 1000 x 680).
pub const MIN_SIZE: (u32, u32) = (1000, 680);

/// Where an unattended window sits: far outside any desktop.
const OFF_SCREEN: f32 = -20000.0;

/// Whether `STYK_BACKGROUND_WINDOW=1` is set: every window opens off-screen, without focus and without a taskbar
/// entry, so scripts and agents never cover the desktop of the person at the computer.
pub fn background_requested() -> bool {
    std::env::var("STYK_BACKGROUND_WINDOW").is_ok_and(|value| value == "1")
}

/// Whether windows are created hidden and then shown without activation.
///
/// Where the platform can show a window without activating it (Windows), a background window is created hidden: a
/// window created visible is activated as it appears, wherever it is, and would take the keyboard.
pub const fn shown_after_creation(background: bool) -> bool {
    background && cfg!(windows)
}

pub fn settings(launch: &Launch, background: bool) -> window::Settings {
    let (width, height) = launch.size.unwrap_or(DEFAULT_SIZE);
    let mut settings = window::Settings {
        size: Size::new(width as f32, height as f32),
        // An explicit `--size` may ask for less than the usual minimum (a test of a small window); it is then the minimum.
        min_size: Some(Size::new(MIN_SIZE.0.min(width) as f32, MIN_SIZE.1.min(height) as f32)),
        // The window controls are drawn by the interface on Windows and Linux (`frame: false` in main.cjs); macOS keeps
        // its title bar until the shell is built.
        decorations: cfg!(target_os = "macos"),
        visible: !shown_after_creation(background),
        ..window::Settings::default()
    };
    if background {
        settings.position = window::Position::Specific(Point::new(OFF_SCREEN, OFF_SCREEN));
        #[cfg(windows)]
        {
            settings.platform_specific.skip_taskbar = true;
        }
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_window_is_todays_window() {
        let settings = settings(&Launch::default(), false);
        assert_eq!(settings.size, Size::new(1560.0, 1000.0));
        assert_eq!(settings.min_size, Some(Size::new(1000.0, 680.0)));
        assert!(settings.visible);
        assert!(matches!(settings.position, window::Position::Default));
    }

    #[test]
    fn size_comes_from_the_command_line() {
        let launch = Launch { size: Some((800, 600)), ..Launch::default() };
        let settings = settings(&launch, false);
        assert_eq!(settings.size, Size::new(800.0, 600.0));
        assert_eq!(settings.min_size, Some(Size::new(800.0, 600.0)), "a size below the usual minimum is not clamped up to it");
    }

    #[test]
    fn a_background_window_is_off_screen_and_off_the_taskbar() {
        let settings = settings(&Launch::default(), true);
        assert!(matches!(settings.position, window::Position::Specific(point) if point == Point::new(-20000.0, -20000.0)));
        #[cfg(windows)]
        {
            assert!(settings.platform_specific.skip_taskbar);
            assert!(!settings.visible, "created hidden, then shown without activation");
        }
    }
}
