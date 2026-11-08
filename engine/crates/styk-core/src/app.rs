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
struct Runtime {
    spawner: Arc<dyn styk_services::Spawner>, clock: Arc<dyn styk_services::Clock>, progress: Arc<crate::stage::Progress>,
    published: Option<(DocumentId, u64, u64)>,
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
    timeline: crate::timeline::Panel,
    settings: crate::settings::Settings,
    settings_store: Option<crate::settings::persistence::Persistence>,
    deferred: Option<(Option<(DocumentId, u64)>, Command)>,
    /// A terminal quit waits for the existing panel/session lifecycle barrier.
    quit_pending: bool,
    now: u64,
    runtime: Option<Runtime>,
    audio_open: Option<styk_services::worker::Worker<(), Result<crate::audio::AudioTransport, String>>>,
    command_queue: crate::command_queue::GestureQueue,
    space_origin: Option<crate::stage::View>,
    alt_graph: bool,
    settings_mode_pending: bool,
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
            timeline: Default::default(), settings: Default::default(), settings_store: None, deferred: None, now: 0,
            runtime: None, audio_open: None, quit_pending: false,
            command_queue: Default::default(), space_origin: None, alt_graph: false, settings_mode_pending: false,
            recovery: crate::recovery::Panel::default(),
            dock: crate::dock::Dock::new(crate::layout::Size { w: 1560.0, h: 1000.0 }, 1.0, "unhosted"),
        }
    }
}

fn warn(message: Msg) -> Effect {
    Effect::Notice(Notice { message, severity: Severity::Warning })
}

impl Core {
    pub fn start_runtime(&mut self, spawner: Arc<dyn styk_services::Spawner>, clock: Arc<dyn styk_services::Clock>, progress: Arc<crate::stage::Progress>) -> Result<(), styk_services::SpawnError> {
        self.start_timeline(spawner.as_ref(), progress.wake())?;
        self.set_facts(Facts::start(spawner.as_ref(), progress.wake())?);
        self.runtime = Some(Runtime { spawner, clock, progress, published: None }); Ok(())
    }
    /// Opening an output can wait for a device. The caller supplies the services; the core opens it on its worker.
    pub fn start_audio(&mut self, spawner: &dyn styk_services::Spawner, open: impl FnOnce() -> Result<crate::audio::AudioTransport, String> + Send + 'static, wake: Arc<dyn Fn() + Send + Sync>) -> Result<(), styk_services::SpawnError> {
        let mut open = Some(open);
        let worker = styk_services::worker::Worker::start(spawner, "styk audio open", move |()| match open.take() { Some(open) => open(), None => Err("audio already opened".into()) }, wake)?;
        if worker.submit(()).is_err() { return Err(styk_services::SpawnError("audio open lane refused".into())); }
        self.audio_open = Some(worker); Ok(())
    }
    fn sync_stage(&mut self) {
        let published = self.documents.published();
        let Some(runtime) = &self.runtime else { return; };
        if runtime.published == published { return; }
        let Some((id, revision, _)) = published else { return; };
        if let Some(stage) = self.stage_of(id) { stage.revise(revision); }
        else if let (Some(document), Some(source)) = (self.documents.get(id), self.documents.frame_source(id)) {
            let size = document.records().ok().map(|r| [r.get("canvas_width").and_then(styk_doc::Value::as_f64).unwrap_or(960.) as u32, r.get("canvas_height").and_then(styk_doc::Value::as_f64).unwrap_or(540.) as u32]).unwrap_or([960, 540]);
            if let Ok(frames) = crate::frames::Frames::new(document.lineage(), revision, 0, &source, crate::frames::Config::default(), runtime.spawner.as_ref(), runtime.clock.clone(), runtime.progress.wake()) {
                if let Ok(host) = crate::stage::Host::new(frames, size, crate::stage::Viewport { origin: [0., 0.], size: [960., 540.], dpr: 1., ..Default::default() }) {
                    let stage = Arc::new(Surface::new(host, runtime.spawner.clone(), runtime.clock.clone(), runtime.progress.clone(), crate::stage::PaintLimits::default()));
                    self.set_source(id, source); self.set_stage(id, stage);
                }
            }
        }
        if let Some(runtime) = &mut self.runtime { runtime.published = published; }
    }
    pub fn timeline(&self) -> &crate::timeline::Panel { &self.timeline }
    pub fn settings(&self) -> &crate::settings::Settings { &self.settings }
    pub fn start_timeline(&mut self, spawner: &dyn styk_services::Spawner, wake: Arc<dyn Fn() + Send + Sync>) -> Result<(), styk_services::SpawnError> {
        self.timeline.start(spawner, wake)
    }
    pub fn start_settings(&mut self, spawner: &dyn styk_services::Spawner, storage: Arc<dyn styk_services::storage::Storage>, wake: Arc<dyn Fn() + Send + Sync>) -> Result<(), styk_services::SpawnError> {
        self.settings_store = Some(crate::settings::persistence::Persistence::start(spawner, storage, wake)?); Ok(())
    }
    pub fn set_audio(&mut self, audio: Result<crate::audio::AudioTransport, String>) { self.timeline.set_audio(audio); }
    /// Receipt of the Settings maintenance lane; the app combines it with layout's receipt after QuitReady.
    pub fn settings_idle(&self) -> bool { self.settings_store.as_ref().is_none_or(|store| store.idle()) }
    fn input_fenced(&self) -> bool { self.documents.edits_locked() || self.session_end_expired() }
    pub fn next_deadline(&self) -> Option<u64> {
        if self.input_fenced() { return self.overlay_deadline().into_iter().chain(self.settings_store.as_ref().and_then(|s| s.deadline())).min(); }
        [self.overlay_deadline(), self.timeline.deadline(), self.settings_store.as_ref().and_then(|s| s.deadline()),
            ((!self.command_queue.is_empty() || self.settings_mode_pending) && !self.activity().operation).then_some(self.now)].into_iter().flatten().min()
    }
    /// Shared barrier used by the document host before save, scope changes, close, quit and session end.
    /// Its caller retains a Busy request, exactly as Documents::dispatch does.
    pub fn dispatch_document(&mut self, request: crate::documents::Request) -> crate::documents::Dispatch {
        if self.input_fenced() { return Err((crate::documents::DocumentsError::Busy.into(), request)); }
        if matches!(request, crate::documents::Request::Publish) { return self.documents.dispatch(request); }
        let mut effects = Vec::new();
        if !self.finish_panels(&mut effects) { return Err((crate::documents::DocumentsError::Busy.into(), request)); }
        let effects = self.settings_event(crate::settings::Event::Flush { now: self.now });
        self.show_notices(&effects);
        self.documents.dispatch(request)
    }
    /// The real document wake adapter. Every completion, including a refusal's session events, is consumed here.
    pub fn poll_document(&mut self) -> Option<crate::documents::Effect> {
        use crate::documents::Effect as DocumentEffect;
        let effect = self.documents.poll()?;
        match effect {
            DocumentEffect::Called { document: _, answer } => {
                let result = self.session.take(answer);
                let stage = self.stage();
                self.timeline.completed(&self.documents, stage.as_deref(), result.is_ok());
                if let Err(message) = result { self.show_notices(&[warn(message)]); }
                Some(DocumentEffect::None)
            }
            effect @ (DocumentEffect::Failed { .. } | DocumentEffect::Cancelled(_) | DocumentEffect::Stale(_)) => {
                let stage = self.stage(); self.timeline.completed(&self.documents, stage.as_deref(), false);
                Some(effect)
            }
            effect => Some(effect),
        }
    }
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
            self.sources.remove(&id);
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
        self.dispatch(Command::Quit)
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
        if self.input_fenced() { return Vec::new(); }
        self.prune_stages();
        self.sync_stage();
        self.timeline.refresh(&self.documents, &mut self.view, &self.settings);
        let _ = self.documents.set_auto_key(self.settings.animation().timeline_mode == crate::settings::TimelineMode::Advanced && self.settings.view().auto_key);
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
            .chain(self.next_deadline()).chain(layouts_ready.then(|| self.dock.deadline()).flatten()).min()
    }

    fn overlay_event(&mut self, event: crate::overlay::host::Event, now: u64) -> Vec<Effect> {
        self.now = now;
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
            let releases: Vec<_> = self.shortcuts.release_all().collect();
            for release in releases { effects.push(Effect::ShortcutReleased(release)); if !self.input_fenced() { effects.extend(self.invoke(crate::command_queue::Invocation::release(release, self.documents.active().map(|d| d.id())))); } }
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
        // Accepted document quit fences all input. Only preference maintenance and
        // overlay housekeeping may run; a wake must never replay deferred edits.
        if self.input_fenced() {
            return match command {
                Command::Overlay { event, now } => self.overlay_event(event, now),
                Command::Settings(event @ (crate::settings::Event::Finish { .. } | crate::settings::Event::Wake { .. } | crate::settings::Event::Abandon)) => self.settings_event(event),
                Command::Wake { now } => {
                    self.now = now;
                    let mut effects = self.settings_event(crate::settings::Event::Wake { now });
                    effects.extend(self.overlay_event(crate::overlay::host::Event::Tick, now));
                    effects
                }
                _ => Vec::new(),
            };
        }
        self.session = Session::default();
        let mut effects = match command {
            Command::Quit => {
                self.quit_pending = true;
                let mut effects = Vec::new();
                if self.finish_panels(&mut effects) {
                    self.quit_pending = false;
                    effects.extend(self.recovery.quit(&mut self.documents, &mut self.overlays, &mut self.focus));
                }
                effects
            }
            Command::Shell(event) => {
                let mut effects = Vec::new();
                if self.finish_panels(&mut effects) { effects.push(Effect::ShellReady(event)); }
                else { effects.extend(self.defer(Command::Shell(event))); }
                effects
            }
            Command::KeyPressed { chord, repeat, prevented } => self.key_pressed(chord, repeat, prevented),
            Command::KeyReleased { key, cancelled } => self.key_released(&key, cancelled),
            Command::Blur => {
                self.alt_graph = false;
                let releases: Vec<_> = self.shortcuts.release_all().collect();
                let mut effects = Vec::new();
                for release in releases { effects.extend(self.invoke(crate::command_queue::Invocation::release(release, self.documents.active().map(|d| d.id())))); }
                effects
            }
            Command::Wake { now } => self.wake(now),
            Command::Timeline(event) => self.timeline_event(event),
            Command::Settings(event) => self.settings_event(event),
            Command::Overlay { event, now } => self.overlay_event(event, now),
            Command::Inspector(event) => {
                let stage = self.stage();
                if self.timeline.finish(&mut self.documents, &mut self.session, stage.as_deref()).is_err() {
                    self.defer(Command::Inspector(event))
                } else { self.inspector.update(&mut self.documents, &mut self.view, &mut self.session, &self.presentation, event) }
            }
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
        };
        effects.extend(self.refresh()); effects
    }
    fn show_notices(&mut self, effects: &[Effect]) {
        for effect in effects { if let Effect::Notice(notice) = effect { drop(self.show_notice(notice.clone())); } }
    }
    fn active_identity(&self) -> Option<(DocumentId, u64)> { self.documents.active().map(|d| (d.id(), d.lineage())) }
    fn wake(&mut self, now: u64) -> Vec<Effect> {
        self.now = now;
        let mut effects = self.refresh();
        if let Some(answer) = self.audio_open.as_ref().and_then(|worker| worker.take()) { self.audio_open = None; self.set_audio(answer); }
        if let Some(stage) = self.stage() { drop(stage.event(crate::stage::Event::Progress)); }
        effects.extend(self.settings_event(crate::settings::Event::Wake { now }));
        effects.extend(self.overlay_event(crate::overlay::host::Event::Tick, now));
        effects.extend(self.timeline_event(crate::timeline::Event::Wake { now }));
        if self.documents.active().is_none_or(|d| d.view().is_ok()) {
            if let Some((identity, command)) = self.deferred.take() {
                if identity == self.active_identity() { effects.extend(self.dispatch(command)); }
                else { effects.push(warn(Msg::new("errors.editorSessions.finishTheCurrentOperationFirst"))); }
            }
        }
        // One bounded admission per wake; a preceding command can start another exclusive operation.
        let activity = self.activity();
        match self.command_queue.next(self.documents.active().map(|d| d.id()), activity, crate::command_queue::Settlement::Ready) {
            crate::command_queue::Next::Ready(invocation) => effects.extend(self.invoke(invocation)),
            crate::command_queue::Next::Cancelled(invocation) => {
                if let Some(key) = invocation.key { effects.extend(self.key_released(key, true)); }
            }
            crate::command_queue::Next::Empty | crate::command_queue::Next::Blocked => {}
        }
        if self.quit_pending { effects.extend(self.request_quit()); }
        effects
    }
    fn activity(&self) -> crate::command_queue::Activity {
        crate::command_queue::Activity { operation: self.documents.active().is_some_and(|d| d.view().is_err()), ..Default::default() }
    }
    fn key_pressed(&mut self, mut chord: crate::text_entry::Chord, repeat: bool, prevented: bool) -> Vec<Effect> {
        if chord.key == "AltRight" && chord.ctrl && chord.alt { self.alt_graph = true; }
        chord.alt_graph |= self.alt_graph;
        use crate::shortcuts::{Scope, Input, Press};
        let scopes = match self.focus.area() { Some(crate::focus::FocusArea::Timeline) => vec![if self.settings.animation().timeline_mode == crate::settings::TimelineMode::Simple { Scope::Simple } else { Scope::Timeline }], Some(crate::focus::FocusArea::Stage) => vec![Scope::Canvas], _ => Vec::new() };
        let pressed = self.shortcuts.press(&self.focus, &chord, &scopes, Input { repeat, prevented, composing: self.focus.composing(), blocked_by_overlay: self.overlays.top().is_some(), home: self.documents.active().is_none(), ..Default::default() }, |id| id.info().owner != Owner::NotYet || matches!(id, CommandId::SelectAll | CommandId::Cancel));
        match pressed {
            Press::Run(activation) => {
                let invocation = crate::command_queue::Invocation::press(activation, self.documents.active().map(|d| d.id()));
                match self.command_queue.submit(invocation, self.activity(), self.shortcuts.held()) {
                    crate::command_queue::Submitted::Ready(invocation) => self.invoke(invocation),
                    crate::command_queue::Submitted::Queued => Vec::new(),
                    crate::command_queue::Submitted::Refused { reason, .. } => { self.shortcuts.reject(activation); vec![warn(Msg::new(reason.message_key()))] }
                }
            }
            Press::CancelDrag => self.timeline_event(crate::timeline::Event::Action { id: CommandId::Cancel, payload: crate::timeline::Payload::None, now: self.now }),
            Press::FeatureHistory { .. } => vec![warn(Msg::new("errors.editorSessions.finishTheCurrentOperationFirst"))],
            Press::Ignored | Press::Consumed => Vec::new(),
        }
    }
    fn key_released(&mut self, key: &str, cancelled: bool) -> Vec<Effect> {
        if key == "AltRight" || key == "AltGraph" { self.alt_graph = false; }
        let Some(mut release) = self.shortcuts.release(key) else { return Vec::new(); };
        release.cancelled |= cancelled;
        let invocation = crate::command_queue::Invocation::release(release, self.documents.active().map(|d| d.id()));
        match self.command_queue.submit(invocation, self.activity(), self.shortcuts.held()) {
            crate::command_queue::Submitted::Ready(invocation) => self.invoke(invocation),
            crate::command_queue::Submitted::Queued => Vec::new(),
            crate::command_queue::Submitted::Refused { reason, .. } => vec![warn(Msg::new(reason.message_key()))],
        }
    }
    fn invoke(&mut self, invocation: crate::command_queue::Invocation) -> Vec<Effect> {
        use crate::command_queue::Phase;
        if invocation.command == CommandId::PlayPan {
            let stage = self.stage();
            match invocation.phase {
                Phase::Press => { self.space_origin = stage.as_ref().and_then(|s| s.view()); if let Some(stage) = stage { drop(stage.event(crate::stage::Event::Space(true))); } Vec::new() }
                Phase::Release { cancelled } => {
                    let same = self.space_origin.take() == stage.as_ref().and_then(|s| s.view());
                    if let Some(stage) = stage { drop(stage.event(crate::stage::Event::Space(false))); }
                    if !cancelled && same { self.run(CommandId::Play) } else { Vec::new() }
                }
                Phase::Invoke => self.run(CommandId::Play),
            }
        } else if matches!(invocation.phase, Phase::Release { .. }) { Vec::new() }
        else if invocation.command.info().owner == Owner::Timeline {
            let payload = if self.focus.area() != Some(crate::focus::FocusArea::Timeline) && matches!(invocation.command, CommandId::FirstFrame | CommandId::PreviousFrame | CommandId::NextFrame | CommandId::LastFrame) {
                crate::timeline::Payload::GlobalNavigation
            } else { crate::timeline::Payload::Modifiers(crate::timeline::Modifiers { extend: invocation.shift, toggle: false }) };
            self.timeline_event(crate::timeline::Event::Action { id: invocation.command, payload, now: self.now })
        } else { self.run(invocation.command) }
    }
    fn timeline_event(&mut self, event: crate::timeline::Event) -> Vec<Effect> {
        use crate::timeline::{Event, Payload, Phase};
        let mut effects = Vec::new();
        if let Event::Action { id, payload, now } = &event {
            self.now = *now;
            if matches!(id, CommandId::TimelineSimple | CommandId::TimelineAdvanced | CommandId::ToggleLoop) {
                let (id, value) = if *id == CommandId::ToggleLoop { (crate::settings::SettingId::LoopPlayback, styk_doc::Value::Bool(!self.settings.animation().loop_playback)) }
                    else { (crate::settings::SettingId::TimelineMode, styk_doc::Value::str(if *id == CommandId::TimelineSimple { "simple" } else { "advanced" })) };
                return self.settings_event(crate::settings::Event::Set { id, value, now: *now });
            }
            let continuing = matches!(payload, Payload::Scrub { phase: Phase::Move | Phase::End | Phase::Cancel, .. });
            if *id != CommandId::Cancel && ((!continuing && !matches!(id, CommandId::Play | CommandId::PlayPan)) || (!self.timeline.playing() && matches!(id, CommandId::Play | CommandId::PlayPan))) {
                if !self.finish_panels(&mut effects) { effects.extend(self.defer(Command::Timeline(event))); return effects; }
            }
        }
        let stage = self.stage();
        effects.extend(self.timeline.update(event, &mut self.documents, &mut self.view, &mut self.session, &self.settings, stage.as_deref()));
        effects
    }
    fn defer(&mut self, command: Command) -> Vec<Effect> {
        if self.deferred.is_none() { self.deferred = Some((self.active_identity(), command)); Vec::new() }
        else { vec![warn(Msg::new("errors.editorSessions.finishTheCurrentOperationFirst"))] }
    }
    fn settings_event(&mut self, event: crate::settings::Event) -> Vec<Effect> {
        use crate::settings::{Event, SettingId};
        let mut effects = Vec::new();
        match event {
            Event::Set { id, value, now } => {
                if self.settings.value(id) == value { return effects; }
                if id == SettingId::TimelineMode && !self.finish_panels(&mut effects) { effects.extend(self.defer(Command::Settings(Event::Set { id, value, now }))); return effects; }
                match self.settings.set(id, value) {
                    Ok(change) => {
                        if id == SettingId::TimelineMode {
                            if self.timeline.mode_changed(&mut self.documents, &mut self.view, &mut self.session, &self.settings).is_err() {
                                effects.extend(self.settings_event(Event::Revert { change, now })); return effects;
                            }
                        }
                        if let Some(store) = &mut self.settings_store { store.changed(&change, now); }
                        effects.push(Effect::SettingsChanged(change));
                    }
                    Err(_) => effects.push(warn(Msg::new("app.preparing"))),
                }
            }
            Event::Revert { change, now } => {
                if change.id == SettingId::TimelineMode && !self.finish_panels(&mut effects) { effects.extend(self.defer(Command::Settings(Event::Revert { change, now }))); return effects; }
                if let Ok(reverted) = self.settings.revert(&change) {
                    if reverted.id == SettingId::TimelineMode { let _ = self.timeline.mode_changed(&mut self.documents, &mut self.view, &mut self.session, &self.settings); }
                    if let Some(store) = &mut self.settings_store { store.changed(&reverted, now); }
                    effects.push(Effect::SettingsChanged(reverted));
                }
            }
            Event::Flush { now } => { if let Some(store) = &mut self.settings_store { store.flush(now); } effects.extend(self.settings_event(Event::Wake { now })); }
            Event::Finish { now } => { if let Some(store) = &mut self.settings_store { store.finish(now); } effects.extend(self.settings_event(Event::Wake { now })); }
            Event::Abandon => { self.settings_store = None; }
            Event::Wake { now } => {
                if let Some(answer) = self.settings_store.as_mut().and_then(|store| store.poll(now)) {
                    use crate::settings::persistence::Completion;
                    match answer {
                        Completion::Loaded(Ok(loaded)) => {
                            let changed = self.settings.loaded(loaded.envelope);
                            if self.settings.read_only() { effects.push(warn(Msg::new("native.settings.readOnly"))); }
                            self.settings_mode_pending |= changed.iter().any(|c| c.id == SettingId::TimelineMode);
                            effects.extend(changed.into_iter().map(Effect::SettingsChanged));
                        }
                        Completion::Loaded(Err(_)) | Completion::Saved(Err(_)) => {
                            let read_only = self.settings_store.as_ref().is_some_and(|s| s.read_only());
                            if read_only { self.settings.refuse_writes(); }
                            effects.push(Effect::Notice(Notice { message: Msg::new(if read_only { "native.settings.readOnly" } else { "native.settings.saveFailed" }), severity: Severity::Error }));
                        }
                        Completion::Saved(Ok(())) => {}
                    }
                }
            }
        }
        if !self.input_fenced() && self.settings_mode_pending && self.finish_panels(&mut effects)
            && self.timeline.mode_changed(&mut self.documents, &mut self.view, &mut self.session, &self.settings).is_ok() { self.settings_mode_pending = false; }
        if !self.input_fenced() && effects.iter().any(|e| matches!(e, Effect::SettingsChanged(c) if c.effects.contains(&crate::settings::Effect::PlaybackQuality))) {
            let stage = self.stage(); self.timeline.quality_changed(self.settings.animation().playback_quality, stage.as_deref());
        }
        effects
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
        if matches!(event, crate::stage::Event::Blur) {
            let effects = self.dispatch(Command::Blur);
            if let Some(stage) = self.stage() { drop(stage.event(event)); }
            return effects;
        }
        if let crate::stage::Event::Space(held) = event {
            return if held { self.key_pressed(crate::text_entry::Chord::new("Space", false, false, false), false, false) } else { self.key_released("Space", false) };
        }
        if let crate::stage::Event::Frame(tick) = event {
            return self.timeline_event(crate::timeline::Event::Action { id: CommandId::TimelineSeek, payload: crate::timeline::Payload::Number(tick), now: self.now });
        }
        let progress = matches!(event, crate::stage::Event::Progress | crate::stage::Event::Tick);
        if let Some(stage) = self.stage() {
            // A refusal (a closed stage, a NaN from a device) leaves the view as it was.
            drop(stage.event(event));
        }
        if progress { self.timeline_event(crate::timeline::Event::Wake { now: self.now }) } else { Vec::new() }
    }

    /// Every panel finishes what it has open.
    fn finish_panels(&mut self, effects: &mut Vec<Effect>) -> bool {
        let stage = self.stage();
        if let Err(message) = self.timeline.finish(&mut self.documents, &mut self.session, stage.as_deref()) { effects.push(warn(message)); return false; }
        let panels: [&mut dyn Lifecycle; 1] = [&mut self.inspector];
        for panel in panels {
            panel.finish(&mut self.documents, &mut self.session, effects);
        }
        self.documents.active().is_none_or(|document| document.view().is_ok_and(|view| !view.editing))
    }

    /// Makes another tab active: every panel finishes first, then the documents switch, as today's tab switch does.
    fn activate(&mut self, id: DocumentId) -> Vec<Effect> {
        let mut effects = Vec::new();
        if !self.finish_panels(&mut effects) { effects.extend(self.defer(Command::Activate(id))); return effects; }
        match self.documents.activate(id) {
            Ok(_) => effects.push(Effect::RequestFrame),
            Err(error) => effects.push(warn(Msg::owned(error.message_key().to_owned()))),
        }
        effects
    }

    /// Routes a registry command to its owner, after the panels finish what they have open.
    fn run(&mut self, id: CommandId) -> Vec<Effect> {
        if id.info().owner == Owner::Timeline || (id == CommandId::Cancel && self.timeline.playing()) || (matches!(id, CommandId::SelectAll | CommandId::Cancel) && self.focus.area() == Some(crate::focus::FocusArea::Timeline) && self.focus.text_entry().is_none()) {
            let payload = if matches!(id, CommandId::FirstFrame | CommandId::PreviousFrame | CommandId::NextFrame | CommandId::LastFrame) { crate::timeline::Payload::GlobalNavigation } else { crate::timeline::Payload::None };
            return self.timeline_event(crate::timeline::Event::Action { id, payload, now: self.now });
        }
        let mut effects = Vec::new();
        if !self.finish_panels(&mut effects) { effects.extend(self.defer(Command::Run(id))); return effects; }
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
                let on = !context.view.apply_range() && context.view.edit_range().len() > 1;
                context.view.set_apply_range(on);
                return effects;
            }
            Owner::Timeline | Owner::NotYet => {
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
