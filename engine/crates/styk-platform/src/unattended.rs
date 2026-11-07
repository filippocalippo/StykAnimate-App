//! How an unattended run (`STYK_BACKGROUND_WINDOW`) keeps off the desktop of the person at the computer.
//!
//! Scripts, tests and agents start the app while someone is working. A window that opens on their screen, takes their
//! keyboard or adds a taskbar button is a defect, so each platform gets the strongest guarantee it can give:
//!
//! | Platform | Strategy | What happens |
//! | --- | --- | --- |
//! | Windows | [`Strategy::HiddenWindow`] | The window is created hidden and off-screen, then shown without activation as a tool window: no focus, no taskbar button. It is captured through the compositor (PrintWindow). |
//! | Linux, X11 | [`Strategy::OverrideRedirectWindow`] | An override-redirect window, off-screen: the window manager never sees it, so it cannot take focus or get a taskbar entry. |
//! | Linux, Wayland | [`Strategy::Headless`] | No window at all. A compositor decides where a window goes and ignores the requested position, so none is opened. |
//! | macOS | [`Strategy::Headless`] | No window at all. The system activates an application as it opens its first window, and AppKit keeps windows on a screen. |
//!
//! Headless means the interface is drawn offscreen by the same renderer the window uses, into a picture. Setting
//! `STYK_BACKGROUND_WINDOW=headless` chooses it on every platform, which is also how its code is exercised on Windows.

/// How an unattended run is shown, if at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    /// Created hidden and off-screen, shown without activation, no taskbar entry (Windows).
    HiddenWindow,
    /// Created off-screen as an override-redirect window the window manager ignores (X11).
    OverrideRedirectWindow,
    /// No window: drawn offscreen into a picture.
    Headless,
}

/// The operating system, as far as the choice cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
    Other,
}

impl Os {
    /// The system this program was built for.
    pub const fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(target_os = "linux") {
            Os::Linux
        } else {
            Os::Other
        }
    }
}

/// Which display servers a Linux session offers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Session {
    /// `WAYLAND_DISPLAY` or `WAYLAND_SOCKET` is set (and not empty).
    pub wayland: bool,
    /// `DISPLAY` is set (and not empty).
    pub x11: bool,
}

impl Session {
    /// The session this process runs in, read the way winit reads it: Wayland first, because X11 is often present
    /// under Wayland as well, and an empty variable counts as unset.
    pub fn from_environment() -> Session {
        let set = |name: &str| std::env::var(name).is_ok_and(|value| !value.is_empty());
        Session { wayland: set("WAYLAND_DISPLAY") || set("WAYLAND_SOCKET"), x11: set("DISPLAY") }
    }
}

/// The strategy for a platform and session; `forced_headless` is `STYK_BACKGROUND_WINDOW=headless`.
pub fn choose(os: Os, session: Session, forced_headless: bool) -> Strategy {
    if forced_headless {
        return Strategy::Headless;
    }
    match os {
        Os::Windows => Strategy::HiddenWindow,
        // winit prefers Wayland whenever it is present, so that is the backend a window would get.
        Os::Linux if session.x11 && !session.wayland => Strategy::OverrideRedirectWindow,
        // Wayland, no display server at all (a CI container), macOS and anything else: no window.
        Os::Linux | Os::MacOs | Os::Other => Strategy::Headless,
    }
}

/// What `STYK_BACKGROUND_WINDOW` asks for: nothing when unset or `0`, the platform's strategy for `1`, headless for
/// `headless`. Any other value is an error, so a typo cannot open a window on someone's desktop.
pub fn requested(setting: Option<&str>, os: Os, session: Session) -> Result<Option<Strategy>, String> {
    match setting {
        None | Some("") | Some("0") => Ok(None),
        Some("1") => Ok(Some(choose(os, session, false))),
        Some("headless") => Ok(Some(choose(os, session, true))),
        Some(other) => Err(format!("STYK_BACKGROUND_WINDOW is {other:?}; use 1, headless or leave it unset")),
    }
}

/// [`requested`] for this process: its environment variable, system and session.
pub fn requested_by_environment() -> Result<Option<Strategy>, String> {
    requested(std::env::var("STYK_BACKGROUND_WINDOW").ok().as_deref(), Os::current(), Session::from_environment())
}

#[cfg(test)]
mod tests {
    use super::*;

    const X11: Session = Session { wayland: false, x11: true };
    const WAYLAND: Session = Session { wayland: true, x11: false };
    const BOTH: Session = Session { wayland: true, x11: true };
    const NONE: Session = Session { wayland: false, x11: false };

    #[test]
    fn each_platform_gets_the_strongest_guarantee_it_can_give() {
        assert_eq!(choose(Os::Windows, NONE, false), Strategy::HiddenWindow);
        assert_eq!(choose(Os::Linux, X11, false), Strategy::OverrideRedirectWindow);
        assert_eq!(choose(Os::MacOs, NONE, false), Strategy::Headless);
    }

    #[test]
    fn wayland_and_a_missing_display_server_never_open_a_window() {
        assert_eq!(choose(Os::Linux, WAYLAND, false), Strategy::Headless);
        // XWayland: DISPLAY is set too, but winit would open a Wayland window, which ignores the position.
        assert_eq!(choose(Os::Linux, BOTH, false), Strategy::Headless);
        assert_eq!(choose(Os::Linux, NONE, false), Strategy::Headless);
        assert_eq!(choose(Os::Other, X11, false), Strategy::Headless);
    }

    #[test]
    fn headless_can_be_forced_anywhere() {
        for os in [Os::Windows, Os::MacOs, Os::Linux, Os::Other] {
            assert_eq!(choose(os, X11, true), Strategy::Headless);
        }
    }

    #[test]
    fn the_setting_is_read_strictly() {
        assert_eq!(requested(None, Os::Windows, NONE), Ok(None));
        assert_eq!(requested(Some("0"), Os::Windows, NONE), Ok(None));
        assert_eq!(requested(Some(""), Os::Windows, NONE), Ok(None));
        assert_eq!(requested(Some("1"), Os::Windows, NONE), Ok(Some(Strategy::HiddenWindow)));
        assert_eq!(requested(Some("headless"), Os::Windows, NONE), Ok(Some(Strategy::Headless)));
        assert!(requested(Some("yes"), Os::Windows, NONE).unwrap_err().contains("\"yes\""));
    }
}
