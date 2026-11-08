//! The application core's state and its one entry point, [`Core::dispatch`].
//!
//! `Core` owns the open documents (each one's session owns the document, its selection, playhead, history and
//! clipboards), the window's view state, the panels and the derived-facts worker. It routes: a command goes to the
//! module that owns its handler ([`CommandId::info`]), a panel's event to that panel. Every session answer passes the
//! one adapter ([`crate::answers`]), whose record of the dispatch is kept for the consumers of session events.
//!
//! The panels' lifecycle is one, shared ([`Lifecycle`]): before a command runs or another document becomes active,
//! every panel finishes what it has open, as today's `finishCurrentEdit` does; a panel that finds its document no longer
//! active on refresh abandons its open edit on that document. Nothing here blocks or builds geometry (D7): facts that
//! need evaluation come from [`crate::facts`].

use std::collections::HashMap;
use std::sync::Arc;

use crate::answers::Session;
use crate::commands::{Command, CommandId, Context, Effect, Notice, Owner, Severity};
use crate::documents::{DocumentId, Documents};
use crate::facts::Facts;
use crate::focus::FocusState;
use crate::frames::FrameDocument;
use crate::i18n::{Msg, Presentation};
use crate::inspector::Panel;
use crate::stage::Surface;
use crate::view_state::ViewState;

/// What every panel does when a command runs or the active document changes.
pub trait Lifecycle {
    /// Commits what the panel has open (an edit in a field), as today's `finishCurrentEdit`.
    fn finish(&mut self, documents: &mut Documents, session: &mut Session, effects: &mut Vec<Effect>);
}

pub struct Core {
    pub documents: Documents,
    view: ViewState,
    inspector: Panel,
    facts: Option<Facts>,
    /// Each document's published generations, which the workers read (K-doc supplies them).
    sources: HashMap<DocumentId, Arc<dyn FrameDocument>>,
    /// Each document's stage, while it is open: the host and the painter (`docs/native/stage.md`).
    /// With the lineage of the document each belongs to: a tab replaced by another document keeps its identity.
    stages: HashMap<DocumentId, (u64, Arc<Surface>)>,
    session: Session,
    focus: FocusState,
    overlays: crate::overlay::host::Host,
    shortcuts: crate::shortcuts::Shortcuts,
    select_commands: Option<(crate::focus::FocusId, Vec<Option<Command>>)>,
    presentation: Presentation,
    recovery: crate::recovery::Panel,
    /// The docked window's arrangement, gestures and saves (`docs/native/docking-views.md`).
    dock: crate::dock::Dock,
}

impl Default for Core {
    fn default() -> Core {
        Core {
            documents: Documents::default(),
            view: ViewState::default(),
            inspector: Panel::default(),
            facts: None,
            sources: HashMap::new(),
            stages: HashMap::new(),
            session: Session::default(),
            focus: FocusState::default(),
            overlays: crate::overlay::host::Host::default(),
            shortcuts: crate::shortcuts::Shortcuts::new(crate::shortcuts::Platform::Control, true),
            select_commands: None,
            presentation: Presentation::english(),
            recovery: crate::recovery::Panel::default(),
            dock: crate::dock::Dock::new(crate::layout::Size { w: 1560.0, h: 1000.0 }, 1.0, "unhosted"),
        }
    }
}

fn warn(message: Msg) -> Effect {
    Effect::Notice(Notice { message, severity: Severity::Warning })
}

impl Core {
    pub fn new(documents: Documents) -> Core {
        Core { documents, ..Core::default() }
    }

    /// The derived-facts worker. Without one, a fact that needs geometry stays pending.
    pub fn set_facts(&mut self, facts: Facts) {
        self.facts = Some(facts);
    }

    pub fn facts(&self) -> Option<&Facts> {
        self.facts.as_ref()
    }

    /// The published generations of a document, which the workers read.
    pub fn set_source(&mut self, document: DocumentId, source: Arc<dyn FrameDocument>) {
        self.sources.insert(document, source);
    }

    /// Gives a document its stage. A stage already attached to it is closed first; a document that is not open has none.
    pub fn set_stage(&mut self, document: DocumentId, stage: Arc<Surface>) {
        let Some(lineage) = self.documents.get(document).map(|open| open.lineage()) else {
            stage.close();
            return;
        };
        if let Some((_, old)) = self.stages.insert(document, (lineage, stage)) {
            old.close();
        }
    }

    fn stage_of(&self, document: DocumentId) -> Option<Arc<Surface>> {
        let (lineage, stage) = self.stages.get(&document)?;
        self.documents.get(document).is_some_and(|open| open.lineage() == *lineage).then(|| stage.clone())
    }

    /// The active document's stage, which the stage widget shows. A closed or replaced document has none.
    pub fn stage(&self) -> Option<Arc<Surface>> {
        self.stage_of(self.documents.active()?.id())
    }

    /// A document closed: its painter and host are closed and dropped (neither joins a worker).
    pub fn close_stage(&mut self, document: DocumentId) {
        if let Some((_, stage)) = self.stages.remove(&document) {
            stage.close();
        }
    }

    /// Drops the stage of every document that was closed or replaced (the documents host closes tabs on its own:
    /// `Effect::Closed`, `ClosedSaved`, the last tab's replacement, quit), so a stage never outlives its document.
    fn prune_stages(&mut self) {
        let gone: Vec<DocumentId> = self.stages.keys().copied().filter(|id| self.stage_of(*id).is_none()).collect();
        for id in gone {
            self.close_stage(id);
        }
    }

    pub fn view_state(&self) -> &ViewState {
        &self.view
    }

    /// The view state, for the panels that set it (the timeline's frame range, the workspace tab).
    pub fn view_state_mut(&mut self) -> &mut ViewState {
        &mut self.view
    }

    pub fn inspector(&self) -> &Panel {
        &self.inspector
    }

    /// How the interface writes text in the selected language.
    pub fn presentation(&self) -> &Presentation {
        &self.presentation
    }

    /// Selects the interface's language (a catalogue locale: `de`, `pt-BR`); `false` for one the catalogue lacks.
    pub fn set_locale(&mut self, id: &str) -> bool {
        match Presentation::new(id) {
            Some(presentation) => {
                self.presentation = presentation;
                true
            }
            None => false,
        }
    }

    /// Which target holds focus, the scopes and the text-entry gate (`docs/native/text-input.md`).
    pub fn focus(&self) -> &FocusState {
        &self.focus
    }

    pub fn focus_mut(&mut self) -> &mut FocusState {
        &mut self.focus
    }

    /// What the session reported during the last dispatch (events, drawing forks, the clipboard filled).
    pub fn session_report(&self) -> &Session {
        &self.session
    }

    /// The recovery views: the offer, the chooser and the close prompt.
    pub fn recovery(&self) -> &crate::recovery::Panel {
        &self.recovery
    }

    /// The chooser dialog's overlay and model, while it is open.
    pub fn recovery_chooser(&self) -> Option<(u64, crate::recovery::model::Chooser)> {
        self.recovery.chooser(&self.documents)
    }

    /// The person's UTC offset in minutes (the platform reads it): recovery copies are listed in local time.
    pub fn set_utc_offset(&mut self, minutes: i32) {
        self.recovery.set_utc_offset(minutes);
    }

    /// An effect of the documents host that needs an answer from a person (a close or quit with unsaved work) or shows
    /// something (the recovery lane): the application hands every effect it takes from `Documents::poll` or
    /// `Documents::dispatch` here. What the core does with it comes back as effects, like a command's.
    pub fn document_effect(&mut self, effect: &crate::documents::Effect) -> Vec<Effect> {
        if self.session_end_expired() { return Vec::new(); }
        let effects = self.recovery.effect(effect, &self.documents, &mut self.overlays, &mut self.focus);
        effects.into_iter().chain(self.refresh()).collect()
    }

    pub fn request_quit(&mut self) -> Vec<Effect> {
        self.recovery.quit(&mut self.documents, &mut self.overlays, &mut self.focus)
    }

    /// A bounded OS checkpoint. Time comes from the application's injected clock;
    /// the platform supplies its shutdown budget. Repeated requests coalesce.
    pub fn request_session_end(&mut self, now: std::time::Duration, timeout: std::time::Duration) -> Vec<Effect> {
        self.recovery.session_end(now, timeout);
        self.request_quit()
    }

    pub fn session_end_deadline(&self) -> Option<std::time::Duration> { self.recovery.session_end_deadline() }
    pub fn session_end_expired(&self) -> bool { self.recovery.session_end_expired() }
    pub fn session_end_requested(&self) -> bool { self.recovery.session_end_requested() }

    /// Run before polling worker replies, including replies queued at the deadline.
    pub fn session_end_tick(&mut self, now: std::time::Duration) -> Vec<Effect> {
        self.recovery.session_end_tick(now, &mut self.documents)
    }

    /// Called once on a host wake, after its bounded poll, never from refresh or view.
    pub fn documents_progress(&mut self) -> Vec<Effect> {
        self.recovery.progress(&mut self.documents, &mut self.overlays, &mut self.focus)
    }

    /// The shared notice effect reaches the existing bounded stage-message owner.
    pub fn show_notice(&mut self, notice: Notice) -> Vec<Effect> {
        use crate::overlay::messages::{Message, Tone};
        let tone = match notice.severity { Severity::Warning => Tone::Warning, Severity::Error => Tone::Error };
        let mut message = Message::new(self.overlays.fresh_id(), "notice", tone, false, Vec::new());
        message.text = self.presentation.text(&notice.message);
        self.overlay_event(crate::overlay::host::Event::ShowMessage(message), self.overlays.now())
    }

    /// Rebuilds the view models whose inputs changed since the last call, and places pending fact requests. The effects
    /// are the recovery views' (the offer's message, a dialog closing); the application carries them out like a command's.
    pub fn refresh(&mut self) -> Vec<Effect> {
        self.prune_stages();
        let source = self.documents.active().and_then(|document| self.sources.get(&document.id())).cloned();
        self.inspector.refresh(&mut self.documents, &self.view, self.facts.as_mut(), source, &mut self.session);
        self.recovery.refresh(&mut self.documents, &mut self.overlays, &mut self.focus, &self.presentation)
    }

    /// Toolkit adapters bind command choices; arbitrary owners receive `OverlayChoice` effects.
    pub fn bind_select(&mut self, invoker: crate::focus::FocusId, choices: Vec<Option<Command>>) {
        self.select_commands = Some((invoker, choices));
    }

    pub fn overlays(&self) -> &crate::overlay::host::Host { &self.overlays }
    pub fn shortcuts_mut(&mut self) -> &mut crate::shortcuts::Shortcuts { &mut self.shortcuts }

    /// Replace the window's single wake with this deadline, or cancel it for `None`.
    /// At that wake dispatch `Command::Overlay { event: Event::Tick, now }`.
    pub fn overlay_deadline(&self) -> Option<u64> { self.overlays.next_deadline() }

    /// One window wake for recovery, session end, overlays and an available layout lane.
    /// An occupied lane resumes from its worker receipt, not repeated expired deadlines.
    pub fn wake_deadline(&self, layouts_ready: bool) -> Option<u64> {
        self.documents.recovery_deadline().into_iter().chain(self.session_end_deadline())
            .map(|due| due.as_millis().min(u128::from(u64::MAX)) as u64)
            .chain(self.overlay_deadline()).chain(layouts_ready.then(|| self.dock.deadline()).flatten()).min()
    }

    fn overlay_event(&mut self, event: crate::overlay::host::Event, now: u64) -> Vec<Effect> {
        use crate::overlay::host::Purpose;
        let invoker = self.overlays.menus().iter().find_map(|m| match m.purpose() {
            Purpose::Select { invoker } => Some(invoker),
            Purpose::Commands => None,
        });
        let update = self.overlays.event(event, &mut self.focus, now);
        let mut effects = Vec::new();
        let choice = invoker.zip(update.chose);
        let command = choice.and_then(|(invoker, index)| {
            self.select_commands.as_ref().filter(|(id, _)| *id == invoker)
                .and_then(|(_, commands)| commands.get(index)).cloned().flatten()
        });
        if let Some((invoker, index)) = choice {
            effects.push(Effect::OverlayChoice { invoker, index });
        }
        if self.overlays.menus().is_empty() { self.select_commands = None; }
        if update.effects.contains(&crate::overlay::Effect::ReleaseHeldKeys) {
            effects.extend(self.shortcuts.release_all().map(Effect::ShortcutReleased));
        }
        effects.extend(update.effects.into_iter().map(Effect::Overlay));
        if let Some(id) = update.dismissed { effects.push(Effect::MessageDismissed(id)); }
        if let Some(command) = update.run { effects.extend(self.dispatch(Command::Run(command))); }
        if let Some(event) = update.act { effects.extend(self.dispatch(Command::Recovery(event))); }
        if let Some(command) = command { effects.extend(self.dispatch(command)); }
        effects
    }

    /// Runs one command.
    pub fn dispatch(&mut self, command: Command) -> Vec<Effect> {
        self.session = Session::default();
        // Freeze every input owner, including stage gestures, drawing and text drafts, as soon as
        // the documents host accepts quit. Overlay housekeeping must still drive the shared wake;
        // its command/action callbacks re-enter this gate. Progress and save replies have separate APIs.
        if (self.documents.edits_locked() || self.session_end_expired()) && !matches!(command, Command::Overlay { .. }) { return Vec::new(); }
        match command {
            Command::Overlay { event, now } => self.overlay_event(event, now),
            Command::Inspector(event) => self.inspector.update(&mut self.documents, &mut self.view, &mut self.session, &self.presentation, event),
            Command::Run(id) => self.run(id),
            Command::Recovery(event) => self.recovery.event(event, &mut self.documents, &mut self.overlays, &mut self.focus),
            Command::Activate(id) => self.activate(id),
            Command::Stage(event) => self.stage_event(event),
            Command::Dock(event) => {
                let now = self.overlays.now();
                // A press on a header does not say which tab it landed on: the tree's last walk measured each tab.
                let event = match event {
                    crate::dock::Event::HeaderPressed { group, tab: None, x, y } => {
                        let tab = self.overlays.target_at(x, y).and_then(crate::dock::ids::group_of).filter(|(g, _)| *g == group).map(|(_, i)| i);
                        crate::dock::Event::HeaderPressed { group, tab, x, y }
                    }
                    other => other,
                };
                let effects = self.dock.handle(event, now);
                self.dock_effects(effects)
            }
        }
    }

    /// The docked window: the arrangement, the solution for the window and the gesture in progress.
    pub fn dock(&self) -> &crate::dock::Dock {
        &self.dock
    }

    /// The dock, for the host that starts it (the window's size, the stored arrangements) and runs its writes.
    pub fn dock_mut(&mut self) -> &mut crate::dock::Dock {
        &mut self.dock
    }

    /// What the dock asked of the host, as the core's effects: a refusal is a message over the stage, a focus request
    /// the target of the panel's tab strip (or of its body where it has none).
    pub fn dock_effects(&mut self, asked: Vec<crate::dock::Effect>) -> Vec<Effect> {
        use crate::dock::Effect as Asked;
        self.focus.set_regions(self.dock.regions());
        let mut effects = Vec::new();
        for ask in asked {
            match ask {
                Asked::Message(msg) => {
                    let text = self.presentation.text(&msg);
                    let mut message = crate::overlay::messages::Message::new(self.overlays.fresh_id(), format!("dock:{}", msg.key), crate::overlay::messages::Tone::Warning, false, Vec::new());
                    message.text = text;
                    let now = self.overlays.now();
                    effects.extend(self.overlay_event(crate::overlay::host::Event::ShowMessage(message), now));
                }
                Asked::Focus(panel) => {
                    effects.extend(self.dock.focus_target(&panel).map(Effect::FocusTarget));
                }
            }
        }
        effects
    }

    /// A stage event for the active document's stage. The stage keeps navigation; what it does not take goes back to the
    /// tool owner, which no chunk has built yet, so it does nothing.
    fn stage_event(&mut self, event: crate::stage::Event) -> Vec<Effect> {
        if let Some(stage) = self.stage() {
            // A refusal (a closed stage, a NaN from a device) leaves the view as it was.
            drop(stage.event(event));
        }
        Vec::new()
    }

    /// Every panel finishes what it has open.
    fn finish_panels(&mut self, effects: &mut Vec<Effect>) {
        let panels: [&mut dyn Lifecycle; 1] = [&mut self.inspector];
        for panel in panels {
            panel.finish(&mut self.documents, &mut self.session, effects);
        }
    }

    /// Makes another tab active: every panel finishes first, then the documents switch, as today's tab switch does.
    fn activate(&mut self, id: DocumentId) -> Vec<Effect> {
        let mut effects = Vec::new();
        self.finish_panels(&mut effects);
        match self.documents.activate(id) {
            Ok(_) => effects.push(Effect::RequestFrame),
            Err(error) => effects.push(warn(Msg::owned(error.message_key().to_owned()))),
        }
        effects
    }

    /// Routes a registry command to its owner, after the panels finish what they have open.
    fn run(&mut self, id: CommandId) -> Vec<Effect> {
        let mut effects = Vec::new();
        self.finish_panels(&mut effects);
        match id.info().owner {
            Owner::Dock => {
                let focused = self.focus.focused().filter(|id| self.dock.panel_of(*id).is_some())
                    .or_else(|| self.focus.focused_area().and_then(|area| self.dock.region_panel_target(area)));
                let asked = self.dock.run(id, focused, self.overlays.now());
                effects.extend(self.dock_effects(asked));
                return effects;
            }
            Owner::Focus => {
                self.focus.set_regions(self.dock.regions());
                effects.extend(self.focus.cycle_area(id == CommandId::FocusNextRegion).map(Effect::FocusTarget));
                return effects;
            }
            _ => {}
        }
        let mut context = Context { documents: &mut self.documents, view: &mut self.view, session: &mut self.session };
        let result = match id.info().owner {
            Owner::History => crate::history::run(&mut context, id),
            Owner::Selection => crate::selection_actions::run(&mut context, id),
            Owner::Camera => crate::camera_actions::run(&mut context, id),
            Owner::ViewState => {
                // `toggle-range-edit`: Edit together on or off.
                let on = !context.view.apply_range();
                context.view.set_apply_range(on);
                return effects;
            }
            Owner::NotYet => {
                effects.push(Effect::NotAvailable(id));
                return effects;
            }
            Owner::Dock | Owner::Focus => return effects,
        };
        match result {
            Ok(()) => effects.push(Effect::RequestFrame),
            Err(message) => effects.push(warn(message)),
        }
        effects
    }

    /// Shared resolver and field/IME gates for the registered dock/focus commands. Other features
    /// remain with their existing host; an unmodified/extra-modifier chord never starts a layout edit.
    pub fn dock_shortcut(&mut self, chord: &crate::text_entry::Chord, input: crate::shortcuts::Input) -> Option<Vec<Effect>> {
        let activation = self.shortcuts.resolve(chord, &[])?;
        if !matches!(activation.command.info().owner, Owner::Dock | Owner::Focus) { return None; }
        match self.shortcuts.press(&self.focus, chord, &[], input, |_| true) {
            crate::shortcuts::Press::Run(activation) => Some(self.dispatch(Command::Run(activation.command))),
            crate::shortcuts::Press::Consumed => Some(Vec::new()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod merged_notice_tests {
    use super::*;
    #[test]
    fn session_quit_clearance_survives_an_unrelated_late_failure() {
        let mut core = Core::new(Documents::new());
        core.recovery.session_end(std::time::Duration::ZERO, std::time::Duration::from_secs(5));
        let effects = core.document_effect(&crate::documents::Effect::QuitReady);
        assert!(effects.contains(&Effect::QuitReady));
        assert!(core.session_end_requested());
        core.document_effect(&crate::documents::Effect::Recovery(crate::documents::recovery::Event::Failed(styk_services::recovery::RecoveryError::Missing)));
        assert!(core.session_end_requested(), "a late failure cannot turn OS quit into an unbounded preferences flush");
    }
    #[test]
    fn dock_and_recovery_notices_share_the_overlay_identity_owner() {
        let mut core = Core::new(Documents::new());
        core.show_notice(Notice { message: Msg::new("privacyUi.operationFailedPleaseTryAgain"), severity: Severity::Error });
        let first = core.overlays().messages().current().unwrap().id;
        core.dispatch(Command::Dock(crate::dock::Event::Close(crate::layout::PanelId::new("stage"))));
        core.dispatch(Command::Overlay { event: crate::overlay::host::Event::MessageDismiss(first), now: 0 });
        let next = core.overlays().messages().current().expect("the queued dock refusal");
        assert_ne!(next.id, first, "a stale recovery action must not address a dock notice");
    }
}
