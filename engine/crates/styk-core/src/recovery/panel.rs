//! The state behind the recovery views. See the module above.

use super::model::{self, Choice, Chooser, Closing, Event, ids, words};
use crate::commands::{Effect, Notice, Severity};
use crate::documents::recovery::Command as Ask;
use crate::documents::{CloseChoice, Documents, Effect as Doc, HostError, PromptId, Request};
use crate::focus::{FocusArea, FocusId, FocusState, FocusTarget, TargetKind};
use crate::i18n::{Label, Msg, Presentation};
use crate::overlay::host::{Event as Overlay, Host, Update};
use crate::overlay::messages::Message;
use crate::overlay::Kind;
use styk_services::recovery::Slot;

/// The chooser while it is open.
struct Open {
    overlay: u64,
    /// The copy a restore was asked for: the dialog closes when it is gone from the host's list.
    restoring: Option<Slot>,
    /// A request the host refused (a tab limit, an edit not finished): shown under the body like a failed restore.
    refused: Option<Label>,
}

/// The close prompt while it is open.
struct Prompt {
    overlay: u64,
    id: PromptId,
    model: Closing,
}

/// The recovery views' state: the offer as the stage's message, the chooser and the close prompt as dialogs.
#[derive(Default)]
pub struct Panel {
    /// The offer's message and the copies it was written for.
    offer: Option<(u64, Vec<Slot>)>,
    chooser: Option<Open>,
    closing: Option<Prompt>,
    /// The person's UTC offset in minutes, for the copies' times.
    offset: i32,
    pending: Option<Request>,
    quit_requested: bool,
    session_end: bool,
}

fn carry(update: Update) -> Vec<Effect> {
    let mut effects: Vec<Effect> = update.effects.into_iter().map(Effect::Overlay).collect();
    effects.extend(update.dismissed.map(Effect::MessageDismissed));
    effects
}

fn is_open(host: &Host, overlay: u64) -> bool {
    host.stack().entries().iter().any(|entry| entry.id == overlay)
}

/// A refusal of the documents host as the person reads it.
fn refusal(error: &HostError) -> Label {
    match error {
        HostError::Documents(error) => Label::Msg(Msg::owned(error.message_key().to_owned())),
        other => Label::plain(other.to_string()),
    }
}

fn target(id: FocusId) -> FocusTarget {
    FocusTarget::new(id.0, FocusArea::Panels, TargetKind::Control)
}

/// Opens a modal dialog whose content has these focus targets; the new overlay's identity and the stack's effects.
fn open(host: &mut Host, focus: &mut FocusState, targets: Vec<FocusTarget>, initial: FocusId) -> (Option<u64>, Vec<Effect>) {
    let known: Vec<u64> = host.stack().entries().iter().map(|entry| entry.id).collect();
    let now = host.now();
    let update = host.event(Overlay::OpenOverlay { kind: Kind::Dialog, guarded: false, targets, initial: Some(initial) }, focus, now);
    let overlay = host.stack().entries().iter().map(|entry| entry.id).find(|id| !known.contains(id));
    (overlay, carry(update))
}

fn close(host: &mut Host, focus: &mut FocusState, overlay: u64) -> Vec<Effect> {
    let now = host.now();
    carry(host.event(Overlay::CloseOverlay(overlay), focus, now))
}

impl Panel {
    /// The person's UTC offset in minutes (the platform reads it): the copies' times are written in it.
    pub fn set_utc_offset(&mut self, minutes: i32) {
        self.offset = minutes;
    }

    /// The overlay the chooser dialog is, while it is open.
    pub fn chooser_overlay(&self) -> Option<u64> {
        self.chooser.as_ref().map(|open| open.overlay)
    }

    /// The overlay the close prompt is, and what it shows, while it is open.
    pub fn closing(&self) -> Option<(u64, &Closing)> {
        self.closing.as_ref().map(|prompt| (prompt.overlay, &prompt.model))
    }

    /// The chooser as it is now: the copies the host lists, its selection, its busy state and what it reported.
    pub fn chooser(&self, documents: &Documents) -> Option<(u64, Chooser)> {
        let open = self.chooser.as_ref()?;
        let view = documents.recovery_view()?;
        let mut model = model::chooser(&view.copies, view.selected.as_ref(), view.busy, view.error.as_deref(), self.offset);
        if open.refused.is_some() {
            model.error = open.refused.clone();
        }
        Some((open.overlay, model))
    }

    /// The offer's message for the copies the host lists now.
    fn offer_message(&self, documents: &Documents, host: &mut Host, presentation: &Presentation) -> Option<(Message, Vec<Slot>)> {
        let view = documents.recovery_view().filter(|view| view.visible && !view.copies.is_empty())?;
        let fallback = documents.active().map_or(words::UNTITLED, |document| Label::plain(document.name()));
        let offer = model::offer(&view.copies, &fallback, self.offset)?;
        let message = model::message(&offer, host.fresh_id(), presentation);
        Some((message, view.copies.iter().map(|copy| copy.slot.clone()).collect()))
    }

    /// Brings the views in line with the documents host: the offer for the copies it lists, the chooser closed once
    /// its copy is restored or none are left or the dialog was dismissed, a close prompt dismissed as Cancel.
    pub(crate) fn refresh(&mut self, documents: &mut Documents, host: &mut Host, focus: &mut FocusState, presentation: &Presentation) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(overlay) = self.chooser_overlay() {
            let view = documents.recovery_view();
            let busy = view.is_some_and(|view| view.busy);
            let empty = view.is_none_or(|view| view.copies.is_empty());
            let restoring = self.chooser.as_ref().and_then(|open| open.restoring.clone());
            let restored = !busy && restoring.as_ref().is_some_and(|slot| !view.is_some_and(|view| view.copies.iter().any(|copy| copy.slot == *slot)));
            if !is_open(host, overlay) {
                self.chooser = None;
            } else if empty || restored {
                self.chooser = None;
                effects.extend(close(host, focus, overlay));
            } else if !busy && restoring.is_some() && let Some(open) = &mut self.chooser {
                // The host answered with its copy still listed: it reported why, in its view.
                open.restoring = None;
            }
        }
        if self.closing.as_ref().is_some_and(|prompt| !is_open(host, prompt.overlay)) {
            effects.extend(self.respond(Choice::Cancel, documents, host, focus));
        }
        let wanted = self.offer_message(documents, host, presentation);
        match (self.offer.take(), wanted) {
            (None, None) => {}
            (None, Some((message, slots))) => {
                let id = message.id;
                effects.extend(Self::show(host, focus, message));
                self.offer = Some((id, slots));
            }
            (Some((id, shown)), Some((message, slots))) => {
                if shown == slots {
                    self.offer = Some((id, shown));
                } else {
                    effects.extend(Self::dismiss(host, focus, id));
                    let id = message.id;
                    effects.extend(Self::show(host, focus, message));
                    self.offer = Some((id, slots));
                }
            }
            (Some((id, _)), None) => effects.extend(Self::dismiss(host, focus, id)),
        }
        effects
    }

    fn show(host: &mut Host, focus: &mut FocusState, message: Message) -> Vec<Effect> {
        let now = host.now();
        carry(host.event(Overlay::ShowMessage(message), focus, now))
    }

    fn dismiss(host: &mut Host, focus: &mut FocusState, id: u64) -> Vec<Effect> {
        let now = host.now();
        carry(host.event(Overlay::MessageDismiss(id), focus, now))
    }

    fn notice(error: &HostError) -> Vec<Effect> {
        vec![Effect::Notice(Notice {
            message: match refusal(error) { Label::Msg(msg) => msg, Label::Plain(_) => Msg::new("privacyUi.operationFailedPleaseTryAgain") },
            severity: if matches!(error, HostError::Documents(_)) { Severity::Warning } else { Severity::Error },
        })]
    }

    fn ask(documents: &mut Documents, ask: Ask) -> Result<Vec<Effect>, HostError> {
        documents.dispatch(Request::Recovery(ask)).map(|_| vec![Effect::PollDocuments]).map_err(|(error, _)| error)
    }

    /// One thing a recovery view said.
    pub(crate) fn event(&mut self, event: Event, documents: &mut Documents, host: &mut Host, focus: &mut FocusState) -> Vec<Effect> {
        match event {
            Event::NotNow => Self::ask(documents, Ask::Dismiss).map_or_else(|error| Self::notice(&error), |effects| effects),
            Event::Manage => self.open_chooser(host, focus),
            Event::Restore => {
                let copies: Vec<Slot> = documents.recovery_view().map(|view| view.copies.iter().map(|copy| copy.slot.clone()).collect()).unwrap_or_default();
                match copies.as_slice() {
                    [] => Vec::new(),
                    [only] => Self::ask(documents, Ask::Restore(only.clone())).map_or_else(|error| Self::notice(&error), |effects| effects),
                    _ => self.open_chooser(host, focus),
                }
            }
            Event::Pick(slot) => {
                let result = Self::ask(documents, Ask::Select(slot));
                self.report(result)
            }
            Event::RestoreChosen | Event::DiscardChosen => {
                let Some(slot) = documents.recovery_view().and_then(|view| view.selected.clone()) else { return Vec::new() };
                let restore = event == Event::RestoreChosen;
                let result = Self::ask(documents, if restore { Ask::Restore(slot.clone()) } else { Ask::Discard(slot.clone()) });
                if result.is_ok() && restore && let Some(open) = &mut self.chooser {
                    open.restoring = Some(slot);
                }
                self.report(result)
            }
            Event::CancelChooser => match self.chooser.take() {
                Some(open) => close(host, focus, open.overlay),
                None => Vec::new(),
            },
            Event::Respond(choice) => self.respond(choice, documents, host, focus),
        }
    }

    /// A refusal under the chooser's body; success clears the last one.
    fn report(&mut self, result: Result<Vec<Effect>, HostError>) -> Vec<Effect> {
        match result {
            Ok(effects) => { if let Some(open) = &mut self.chooser { open.refused = None; } effects }
            Err(error) => { if let Some(open) = &mut self.chooser { open.refused = Some(refusal(&error)); } Vec::new() }
        }
    }

    fn open_chooser(&mut self, host: &mut Host, focus: &mut FocusState) -> Vec<Effect> {
        if self.chooser.is_some() {
            return Vec::new();
        }
        let ids = [ids::CHOOSER_CLOSE, ids::SELECT, ids::CANCEL, ids::DISCARD, ids::RESTORE];
        let (overlay, effects) = open(host, focus, ids.into_iter().map(target).collect(), ids::SELECT);
        self.chooser = overlay.map(|overlay| Open { overlay, restoring: None, refused: None });
        effects
    }

    /// One coalesced quit intent. Only host progress retries a refused request.
    pub(crate) fn quit(&mut self, session_end: bool, documents: &mut Documents, host: &mut Host, focus: &mut FocusState) -> Vec<Effect> {
        self.session_end |= session_end;
        if self.quit_requested {
            if self.closing.is_some() { return self.checkpoint_finished(); }
            return Vec::new();
        }
        self.quit_requested = true;
        self.control(Request::Quit, documents, host, focus)
    }

    pub(crate) fn progress(&mut self, documents: &mut Documents, host: &mut Host, focus: &mut FocusState) -> Vec<Effect> {
        match self.pending.take() {
            Some(request) => self.control(request, documents, host, focus),
            None => Vec::new(),
        }
    }

    fn checkpoint_finished(&mut self) -> Vec<Effect> {
        if std::mem::take(&mut self.session_end) { vec![Effect::SessionCheckpointFinished] } else { Vec::new() }
    }

    fn control(&mut self, request: Request, documents: &mut Documents, host: &mut Host, focus: &mut FocusState) -> Vec<Effect> {
        let response = matches!(request, Request::Respond { .. });
        let cancelled = matches!(request, Request::Respond { choice: CloseChoice::Cancel, .. });
        match documents.dispatch(request) {
            Ok(answer) => {
                self.pending = None;
                let mut effects = Vec::new();
                if response && let Some(prompt) = self.closing.take() && is_open(host, prompt.overlay) {
                    effects.extend(close(host, focus, prompt.overlay));
                }
                if cancelled { self.quit_requested = false; }
                effects.extend(self.effect(&answer, documents, host, focus));
                effects
            }
            Err((HostError::Documents(crate::documents::DocumentsError::Busy), request)) => {
                self.pending = Some(request);
                Vec::new()
            }
            Err((error, _)) => {
                self.pending = None;
                self.quit_requested = false;
                let mut effects = self.checkpoint_finished();
                // Only Busy leaves K-doc's question alive. A stale/failed answer consumed it.
                if response && let Some(prompt) = self.closing.take() && is_open(host, prompt.overlay) {
                    effects.extend(close(host, focus, prompt.overlay));
                }
                effects.extend(Self::notice(&error));
                effects
            }
        }
    }

    /// A refusal keeps the prompt and returned request. Cancel supersedes a pending answer.
    fn respond(&mut self, choice: Choice, documents: &mut Documents, host: &mut Host, focus: &mut FocusState) -> Vec<Effect> {
        let Some(prompt) = self.closing.as_ref() else { return Vec::new() };
        if choice == Choice::Save && !prompt.model.save_available { return Vec::new(); }
        let choice = match choice {
            Choice::Save => CloseChoice::Save, Choice::Discard => CloseChoice::Discard,
            Choice::Cancel => CloseChoice::Cancel, Choice::Retry => CloseChoice::RetryRecovery,
        };
        self.control(Request::Respond { prompt: prompt.id, choice }, documents, host, focus)
    }

    /// Route close/checkpoint progress and terminal answers; confirmations open the existing prompt.
    /// An unavailable save-file dialog is prevented by the prompt's save availability.
    pub(crate) fn effect(&mut self, effect: &Doc, documents: &Documents, host: &mut Host, focus: &mut FocusState) -> Vec<Effect> {
        match effect {
            Doc::Recovery(crate::documents::recovery::Event::Started) | Doc::Started(_) | Doc::ScopeChanged(_) => return vec![Effect::PollDocuments],
            Doc::QuitReady => { self.quit_requested = false; let mut effects = self.checkpoint_finished(); effects.push(Effect::QuitReady); return effects; }
            Doc::Failed { .. } | Doc::Stale(_) | Doc::Cancelled(_) | Doc::Recovery(crate::documents::recovery::Event::Failed(_)) => {
                if self.pending.is_none() && self.closing.is_none() && !documents.close_checkpoint_pending() {
                    self.quit_requested = false;
                    return self.checkpoint_finished();
                }
                return Vec::new();
            }
            _ => {}
        }
        let (id, names, error): (PromptId, Vec<String>, Option<&str>) = match effect {
            Doc::ConfirmClose { prompt, name, recovery_error, .. } => (*prompt, vec![name.clone()], recovery_error.as_deref()),
            Doc::ConfirmQuit { prompt, names, recovery_error } => (*prompt, names.clone(), recovery_error.as_deref()),
            _ => return Vec::new(),
        };
        let mut effects = self.checkpoint_finished();
        if let Some(old) = self.closing.take() && is_open(host, old.overlay) {
            effects.extend(close(host, focus, old.overlay));
        }
        let mut model = model::closing(&names, error);
        // K-shell has no save-file dialog yet: never enter an unconsumable Save prompt.
        model.save_available = match effect {
            Doc::ConfirmClose { document, .. } => documents.get(*document).is_some_and(|tab| tab.target().is_some()),
            _ => documents.tabs().iter().filter(|tab| tab.dirty()).all(|tab| tab.target().is_some()),
        };
        let mut stops = vec![ids::PROMPT_CLOSE, ids::DONT_SAVE, ids::KEEP_EDITING];
        if model.retry() {
            stops.push(ids::RETRY);
        }
        if model.save_available { stops.push(ids::SAVE); }
        let (overlay, opened) = open(host, focus, stops.into_iter().map(target).collect(), if model.save_available { ids::SAVE } else { ids::KEEP_EDITING });
        effects.extend(opened);
        self.closing = overlay.map(|overlay| Prompt { overlay, id, model });
        effects
    }
}
