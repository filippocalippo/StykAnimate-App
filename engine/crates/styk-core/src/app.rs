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
    /// The docked window's arrangement, gestures and saves (`docs/native/docking-views.md`).
    dock: crate::dock::Dock,
    /// Numbers the dock's notices so each is its own message.
    dock_notices: u64,
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
            dock: crate::dock::Dock::new(crate::layout::Size { w: 1560.0, h: 1000.0 }, 1.0, "unhosted"),
            dock_notices: 0,
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

    /// Rebuilds the view models whose inputs changed since the last call, and places pending fact requests.
    pub fn refresh(&mut self) {
        self.prune_stages();
        let source = self.documents.active().and_then(|document| self.sources.get(&document.id())).cloned();
        self.inspector.refresh(&mut self.documents, &self.view, self.facts.as_mut(), source, &mut self.session);
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
        if let Some(command) = update.run { effects.extend(self.run(command)); }
        if let Some(command) = command { effects.extend(self.dispatch(command)); }
        effects
    }

    /// Runs one command.
    pub fn dispatch(&mut self, command: Command) -> Vec<Effect> {
        self.session = Session::default();
        match command {
            #[cfg(feature = "devtools")]
            Command::Developer(event) => self.dev_extension_dispatch(event),
            Command::Overlay { event, now } => self.overlay_event(event, now),
            Command::Inspector(event) => self.inspector.update(&mut self.documents, &mut self.view, &mut self.session, &self.presentation, event),
            Command::Run(id) => self.run(id),
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
                    self.dock_notices += 1;
                    let mut message = crate::overlay::messages::Message::new(self.dock_notices, format!("dock:{}", msg.key), crate::overlay::messages::Tone::Warning, false, Vec::new());
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

    #[cfg(feature = "devtools")]
    fn dev_extension_dispatch(&mut self,event:crate::dev_extension::Event)->Vec<Effect>{
        let mut effects=Vec::new();
        if let crate::dev_extension::Event::Panel{panel,open}=&event{
            let asked=self.dock.developer_panel(*panel,*open,self.overlays.now());
            effects.extend(self.dock_effects(asked));
        }
        effects.extend(crate::dev_extension::route(event));effects
    }

    /// Routes a registry command to its owner, after the panels finish what they have open.
    fn run(&mut self, id: CommandId) -> Vec<Effect> {
        let mut effects = Vec::new();
        self.finish_panels(&mut effects);
        match id.info().owner {
            #[cfg(feature = "devtools")]
            Owner::Developer => { effects.extend(self.dev_extension_dispatch(crate::dev_extension::command(id))); return effects; },
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
            #[cfg(feature = "devtools")]
            Owner::Developer => return effects,
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
        #[cfg(feature="devtools")]
        let scopes = &[crate::shortcuts::Scope::Developer][..];
        #[cfg(not(feature="devtools"))]
        let scopes = &[][..];
        let activation = self.shortcuts.resolve(chord, scopes)?;
        let accepted = matches!(activation.command.info().owner, Owner::Dock | Owner::Focus);
        #[cfg(feature = "devtools")]
        let accepted = accepted || activation.command.info().owner == Owner::Developer;
        if !accepted { return None; }
        match self.shortcuts.press(&self.focus, chord, scopes, input, |_| true) {
            crate::shortcuts::Press::Run(activation) => Some(self.dispatch(Command::Run(activation.command))),
            crate::shortcuts::Press::Consumed => Some(Vec::new()),
            _ => None,
        }
    }
}
