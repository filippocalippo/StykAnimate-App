//! The band's session buttons (`syncBandSession` and `BAND_SESSIONS` in `src/shell/topbar.mjs`).
//!
//! A session is a task that takes over the band's right cluster: Build, editing a movieclip, and editing the camera. At
//! rest the band shows Export as the one ink primary; in a session Export turns into a quiet button beside the
//! session's Done, so every session keeps Export one click away.

/// What the band is a session of; `None` at rest.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Session {
    /// Nothing: the everyday band.
    #[default]
    None,
    /// Build a figure: Test rig and Done.
    Build,
    /// Editing a movieclip: Cancel and Done.
    Movieclip,
    /// Editing the camera: Done.
    Camera,
}

/// The "Done" buttons are three buttons, one per session, of which at most one shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Done {
    /// Finish building the figure; returns to Animate.
    Build,
    /// Finish editing the movieclip.
    Movieclip,
    /// Finish editing the camera.
    Camera,
}

/// How Export looks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportLook {
    /// The ink primary pill (at rest).
    Primary,
    /// A quiet button beside a session's Done.
    Ghost,
}

impl Session {
    /// Export's look: the primary at rest, ghost in a session.
    pub fn export(self) -> ExportLook {
        if self == Session::None { ExportLook::Primary } else { ExportLook::Ghost }
    }

    /// Whether Cancel shows (a movieclip's "Discard the changes to this movieclip").
    pub fn cancel(self) -> bool {
        self == Session::Movieclip
    }

    /// Whether Test rig shows (Build's).
    pub fn test_rig(self) -> bool {
        self == Session::Build
    }

    /// The Done button the session shows.
    pub fn done(self) -> Option<Done> {
        match self {
            Session::None => None,
            Session::Build => Some(Done::Build),
            Session::Movieclip => Some(Done::Movieclip),
            Session::Camera => Some(Done::Camera),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_rest_export_is_the_primary_and_no_session_button_shows() {
        let rest = Session::None;
        assert_eq!(rest.export(), ExportLook::Primary);
        assert!(!rest.cancel() && !rest.test_rig());
        assert_eq!(rest.done(), None);
    }

    #[test]
    fn every_session_keeps_export_one_click_away_as_a_quiet_button_beside_its_done() {
        for session in [Session::Build, Session::Movieclip, Session::Camera] {
            assert_eq!(session.export(), ExportLook::Ghost, "{session:?}");
            assert!(session.done().is_some(), "{session:?}");
        }
    }

    #[test]
    fn each_session_shows_its_own_buttons() {
        assert_eq!((Session::Build.test_rig(), Session::Build.cancel(), Session::Build.done()), (true, false, Some(Done::Build)));
        assert_eq!((Session::Movieclip.test_rig(), Session::Movieclip.cancel(), Session::Movieclip.done()), (false, true, Some(Done::Movieclip)));
        assert_eq!((Session::Camera.test_rig(), Session::Camera.cancel(), Session::Camera.done()), (false, false, Some(Done::Camera)));
    }
}
