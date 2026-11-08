//! The workspace switch: Animate, Draw and Build, and the rules for changing between them (`changeMode` and
//! `modeRequest` in `src/studio-shell.mjs`).
//!
//! The rules, as today's app keeps them:
//!
//! - Only the latest request wins. A request that is superseded while the drawing is committing does nothing when the
//!   commit ends.
//! - Leaving Draw (for any workspace but Draw) first waits for the drawing to commit its pixels; if that fails Draw
//!   stays, and the request ends there.
//! - Entering Draw from Build asks Build to exit first (it asks to keep or discard); if Build is still active after
//!   that, the request stays pending and Draw begins when Build reports that it left.
//! - Asking for Animate asks Build to exit; Build's Done and "Return to animation" ask for Animate.
//!
//! The machine decides; it never acts. Each decision is an [`Effect`] for the owner of the drawing and Build sessions,
//! which answers with a [`Report`] of what really happened. The current workspace is what those sessions report (today's
//! `mode()`), never what was asked for.

/// The three workspaces, in the order of the switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Workspace {
    /// Animate: poses and timing (the default).
    Animate,
    /// Draw: pixels on cels.
    Draw,
    /// Build: a figure's parts and rig (`rig` in today's code).
    Build,
}

impl Workspace {
    /// The workspaces in the order the switch shows them.
    pub const ALL: [Workspace; 3] = [Workspace::Animate, Workspace::Draw, Workspace::Build];
}

/// What the machine asks of the owner of the drawing and Build sessions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Commit the drawing's pixels and leave Draw; answer with [`Report::DrawingExited`].
    ExitDrawing,
    /// Ask Build to exit (it may ask the person to keep or discard); answer with [`Report::BuildActive`].
    RequestBuildExit,
    /// Begin Draw; answer with [`Report::DrawingEntered`].
    EnterDrawing,
    /// Begin Build; answer with [`Report::BuildEntered`].
    EnterBuild,
}

/// What the owner of the sessions reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Report {
    /// Draw began.
    DrawingEntered,
    /// The commit that leaving Draw waited for ended: `true` when the pixels were published and Draw is left.
    DrawingExited(bool),
    /// Build began.
    BuildEntered,
    /// Build is (still) active or not, after it was asked to exit or when it ended by itself (Done, the keep or discard
    /// answer).
    BuildActive(bool),
}

/// The switch's state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Workspaces {
    drawing: bool,
    building: bool,
    /// The workspace the newest request wants, while its commit of the drawing is running (`drawingExit`): a newer
    /// request replaces it, and only the newest goes on when the commit ends (`modeRequest`).
    exiting: Option<Workspace>,
    /// Draw was asked for while Build was active: it begins when Build is gone (`pendingDraw`).
    pending_draw: bool,
}

impl Workspaces {
    /// Animate, with nothing active.
    pub fn new() -> Workspaces {
        Workspaces::default()
    }

    /// The workspace in front: Draw while the drawing is active, else Build while Build is, else Animate.
    pub fn current(&self) -> Workspace {
        if self.drawing {
            Workspace::Draw
        } else if self.building {
            Workspace::Build
        } else {
            Workspace::Animate
        }
    }

    /// Whether a request is waiting for the drawing to commit.
    pub fn waiting(&self) -> bool {
        self.exiting.is_some()
    }

    /// The person chose a workspace.
    pub fn choose(&mut self, next: Workspace) -> Vec<Effect> {
        self.pending_draw = next == Workspace::Draw;
        // Pixel operations may still own the drawing selection: finish Draw before Build binds a figure or sets its tool.
        // A second request for Draw while the commit is already running waits for that same commit.
        if next != Workspace::Draw || self.exiting.is_some() {
            if self.exiting.is_some() {
                self.exiting = Some(next);
                return Vec::new();
            }
            if self.drawing {
                self.exiting = Some(next);
                return vec![Effect::ExitDrawing];
            }
        }
        self.proceed(next)
    }

    /// The owner of the sessions reports what happened.
    pub fn report(&mut self, report: Report) -> Vec<Effect> {
        match report {
            Report::DrawingEntered => {
                self.drawing = true;
                self.pending_draw = false;
                Vec::new()
            }
            Report::BuildEntered => {
                self.building = true;
                Vec::new()
            }
            Report::DrawingExited(true) => {
                self.drawing = false;
                match self.exiting.take() {
                    Some(next) => self.proceed(next),
                    None => Vec::new(),
                }
            }
            Report::DrawingExited(false) => {
                // The drawing reports the error and stays active.
                self.exiting = None;
                self.pending_draw = false;
                Vec::new()
            }
            Report::BuildActive(active) => {
                self.building = active;
                if !active && self.pending_draw && !self.drawing {
                    self.pending_draw = false;
                    return vec![Effect::EnterDrawing];
                }
                Vec::new()
            }
        }
    }

    /// What follows once nothing is committing.
    fn proceed(&mut self, next: Workspace) -> Vec<Effect> {
        match next {
            Workspace::Draw => {
                if self.building {
                    // Build asks to keep or discard; Draw begins when it reports that it left.
                    return vec![Effect::RequestBuildExit];
                }
                self.pending_draw = false;
                if self.drawing { Vec::new() } else { vec![Effect::EnterDrawing] }
            }
            Workspace::Build => {
                if self.building { Vec::new() } else { vec![Effect::EnterBuild] }
            }
            Workspace::Animate => {
                if self.building { vec![Effect::RequestBuildExit] } else { Vec::new() }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Effect::*;
    use Workspace::*;

    /// A host that does what the sessions do, with the drawing's commit and Build's answer under the test's control.
    fn enter_draw(machine: &mut Workspaces) {
        assert_eq!(machine.choose(Draw), vec![EnterDrawing]);
        machine.report(Report::DrawingEntered);
        assert_eq!(machine.current(), Draw);
    }

    #[test]
    fn it_starts_in_animate_and_a_workspace_is_current_only_when_its_session_says_so() {
        let mut machine = Workspaces::new();
        assert_eq!(machine.current(), Animate);
        assert_eq!(machine.choose(Draw), vec![EnterDrawing]);
        assert_eq!(machine.current(), Animate, "asked for, not yet entered");
        machine.report(Report::DrawingEntered);
        assert_eq!(machine.current(), Draw);
    }

    #[test]
    fn choosing_the_current_workspace_asks_for_nothing() {
        let mut machine = Workspaces::new();
        assert_eq!(machine.choose(Animate), Vec::new());
        enter_draw(&mut machine);
        assert_eq!(machine.choose(Draw), Vec::new());
        assert_eq!(machine.current(), Draw);
    }

    #[test]
    fn leaving_draw_waits_for_the_drawing_to_commit() {
        let mut machine = Workspaces::new();
        enter_draw(&mut machine);
        assert_eq!(machine.choose(Animate), vec![ExitDrawing]);
        assert!(machine.waiting());
        assert_eq!(machine.current(), Draw, "Draw stays in front until its pixels are published");
        assert_eq!(machine.report(Report::DrawingExited(true)), Vec::new(), "Animate needs nothing more");
        assert_eq!(machine.current(), Animate);
        assert!(!machine.waiting());
    }

    #[test]
    fn a_failed_commit_keeps_draw_and_ends_the_request() {
        let mut machine = Workspaces::new();
        enter_draw(&mut machine);
        assert_eq!(machine.choose(Workspace::Build), vec![ExitDrawing]);
        assert_eq!(machine.report(Report::DrawingExited(false)), Vec::new());
        assert_eq!(machine.current(), Draw);
        assert!(!machine.waiting());
        // The next request starts afresh.
        assert_eq!(machine.choose(Animate), vec![ExitDrawing]);
    }

    #[test]
    fn only_the_latest_request_wins_while_the_drawing_commits() {
        let mut machine = Workspaces::new();
        enter_draw(&mut machine);
        assert_eq!(machine.choose(Animate), vec![ExitDrawing]);
        assert_eq!(machine.choose(Workspace::Build), Vec::new(), "the same commit serves the newer request");
        assert_eq!(machine.report(Report::DrawingExited(true)), vec![EnterBuild], "Build, not Animate, goes on");
        machine.report(Report::BuildEntered);
        assert_eq!(machine.current(), Workspace::Build);
    }

    #[test]
    fn a_request_for_draw_during_the_commit_supersedes_the_one_that_started_it() {
        let mut machine = Workspaces::new();
        enter_draw(&mut machine);
        assert_eq!(machine.choose(Animate), vec![ExitDrawing]);
        assert_eq!(machine.choose(Draw), Vec::new());
        assert_eq!(machine.report(Report::DrawingExited(true)), vec![EnterDrawing], "the newest request was Draw");
    }

    #[test]
    fn entering_draw_from_build_asks_build_to_exit_and_waits_for_its_answer() {
        let mut machine = Workspaces::new();
        assert_eq!(machine.choose(Workspace::Build), vec![EnterBuild]);
        machine.report(Report::BuildEntered);
        assert_eq!(machine.choose(Draw), vec![RequestBuildExit]);
        // Build is still active (the person has not answered keep or discard): Draw stays pending.
        assert_eq!(machine.report(Report::BuildActive(true)), Vec::new());
        assert_eq!(machine.current(), Workspace::Build);
        // The person keeps the figure: Build reports that it left and Draw begins.
        assert_eq!(machine.report(Report::BuildActive(false)), vec![EnterDrawing]);
        machine.report(Report::DrawingEntered);
        assert_eq!(machine.current(), Draw);
    }

    #[test]
    fn a_later_choice_cancels_a_pending_draw() {
        let mut machine = Workspaces::new();
        machine.choose(Workspace::Build);
        machine.report(Report::BuildEntered);
        assert_eq!(machine.choose(Draw), vec![RequestBuildExit]);
        machine.report(Report::BuildActive(true));
        // The person returns to Animate instead; when Build then leaves, Draw must not start.
        assert_eq!(machine.choose(Animate), vec![RequestBuildExit]);
        assert_eq!(machine.report(Report::BuildActive(false)), Vec::new());
        assert_eq!(machine.current(), Animate);
    }

    #[test]
    fn animate_asks_build_to_exit_and_build_dones_return_there() {
        let mut machine = Workspaces::new();
        machine.choose(Workspace::Build);
        machine.report(Report::BuildEntered);
        assert_eq!(machine.choose(Animate), vec![RequestBuildExit]);
        machine.report(Report::BuildActive(false));
        assert_eq!(machine.current(), Animate);
    }

    #[test]
    fn build_is_entered_once() {
        let mut machine = Workspaces::new();
        assert_eq!(machine.choose(Workspace::Build), vec![EnterBuild]);
        machine.report(Report::BuildEntered);
        assert_eq!(machine.choose(Workspace::Build), Vec::new());
    }
}
