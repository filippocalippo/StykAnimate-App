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
    stages: HashMap<DocumentId, Arc<Surface>>,
    session: Session,
    focus: FocusState,
    presentation: Presentation,
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
            presentation: Presentation::english(),
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

    /// Gives a document its stage. A stage already attached to it is closed first.
    pub fn set_stage(&mut self, document: DocumentId, stage: Arc<Surface>) {
        if let Some(old) = self.stages.insert(document, stage) {
            old.close();
        }
    }

    /// The active document's stage, which the stage widget shows.
    pub fn stage(&self) -> Option<Arc<Surface>> {
        self.documents.active().and_then(|document| self.stages.get(&document.id())).cloned()
    }

    /// A document closed: its painter and host are closed and dropped (neither joins a worker).
    pub fn close_stage(&mut self, document: DocumentId) {
        if let Some(stage) = self.stages.remove(&document) {
            stage.close();
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

    /// Rebuilds the view models whose inputs changed since the last call, and places pending fact requests.
    pub fn refresh(&mut self) {
        let source = self.documents.active().and_then(|document| self.sources.get(&document.id())).cloned();
        self.inspector.refresh(&mut self.documents, &self.view, self.facts.as_mut(), source, &mut self.session);
    }

    /// Runs one command.
    pub fn dispatch(&mut self, command: Command) -> Vec<Effect> {
        self.session = Session::default();
        match command {
            Command::Inspector(event) => self.inspector.update(&mut self.documents, &mut self.view, &mut self.session, &self.presentation, event),
            Command::Run(id) => self.run(id),
            Command::Activate(id) => self.activate(id),
            Command::Stage(event) => self.stage_event(event),
        }
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
        };
        match result {
            Ok(()) => effects.push(Effect::RequestFrame),
            Err(message) => effects.push(warn(message)),
        }
        effects
    }
}
