//! The window's overlay owner: menus, selects, stage messages and tooltips over the page.
//!
//! The core decides everything (`styk_core::overlay::host`: which menu is open, what a key or a hover does, when a hover
//! intent or a message is due); this carries it out in the toolkit. [`Overlays`] holds the core's [`Host`], the bounds of
//! the focus targets the last tree walk found (an anchor, a row), and the messages a select's options stand for. It
//! returns what the owner of the window must do: run a command, handle the message a chosen option stands for, move
//! focus, and wake the host at [`Overlays::next_deadline`]. It never reads a clock or schedules a timer: `now` is the
//! application's monotonic milliseconds, supplied by the caller, and the caller schedules the one wake.
//!
//! The layer over the page is drawn by [`Overlays::layer`] (menus, the visible message, a tooltip); a dialog or popover is
//! the owner's content placed with `styk_design::widgets::dialog`.

use crate::message::Message;
use iced::advanced::widget::operate;
use iced::{Element, Rectangle, Task};
use styk_core::commands::CommandId;
use styk_core::focus::{FocusId, FocusState, FocusTarget};
use styk_core::overlay::host::{Hints, Host, Purpose, Update, option_rows};
use styk_core::overlay::menu::{Anchor, Entry, Key};
use styk_core::overlay::placement::Rect;
use styk_core::overlay::{Effect, Kind, Overlay, Reason};
use styk_design::widgets::focus::{self, Snapshot};
use styk_design::widgets::menu::{self, Event};
use styk_design::widgets::toast;
use styk_design::Palette;

/// What carrying out an event leaves for the window's owner.
pub struct Outcome {
    /// Focus moves and the like, as iced tasks.
    pub task: Task<Message>,
    /// The focus the toolkit must take, in order (`Some(id)` focuses it, `None` takes focus from everything): what the tasks do.
    pub focus: Vec<Option<FocusId>>,
    /// A command row was activated: run it.
    pub run: Option<CommandId>,
    /// A select's option was chosen: handle the message it stands for.
    pub pick: Option<Message>,
    /// The hotkey gate changed (`true`: hotkeys are blocked), and held keys must be released.
    pub gate: Option<bool>,
    pub release_keys: bool,
    /// A dialog's close guard is asked (the owner answers with [`Overlays::resolve_close`]).
    pub check_close: Vec<(u64, Reason)>,
}

impl Outcome {
    fn none() -> Outcome {
        Outcome { task: Task::none(), focus: Vec::new(), run: None, pick: None, gate: None, release_keys: false, check_close: Vec::new() }
    }
}

/// The overlay owner of one window.
#[derive(Clone)]
pub struct Overlays {
    host: Host,
    bounds: Vec<(FocusId, Rectangle)>,
    /// The select whose list is open (the menu's ID) and the message each option stands for.
    picks: Option<(u64, Vec<Message>)>,
}

fn rect(bounds: Rectangle) -> Rect {
    menu::rect_of(bounds)
}

impl Overlays {
    pub fn new(hints: Hints, rtl: bool) -> Overlays {
        Overlays { host: Host::new(hints, rtl), bounds: Vec::new(), picks: None }
    }

    pub fn host(&self) -> &Host {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut Host {
        &mut self.host
    }

    /// The bounds of the focus targets a walk of the tree found, kept for placing submenus and telling an anchor press.
    pub fn observe(&mut self, snapshot: &Snapshot) {
        self.bounds.clone_from(&snapshot.bounds);
    }

    fn bounds_of(&self, id: FocusId) -> Option<Rect> {
        self.bounds.iter().find(|(known, _)| *known == id).map(|(_, bounds)| rect(*bounds))
    }

    /// When the window must next call [`Overlays::tick`].
    pub fn next_deadline(&self) -> Option<u64> {
        self.host.next_deadline()
    }

    fn carry(&mut self, update: Update) -> Outcome {
        let mut out = Outcome::none();
        // The chosen option's message is read before the list's closing forgets them.
        if let Some(index) = update.chose {
            out.pick = self.picks.as_ref().and_then(|(_, picks)| picks.get(index).cloned());
        }
        let mut tasks = Vec::new();
        for effect in update.effects {
            match effect {
                Effect::Focus(Some(id)) => {
                    out.focus.push(Some(id));
                    tasks.push(operate(focus::focus(id)).discard());
                }
                Effect::Focus(None) => {
                    out.focus.push(None);
                    tasks.push(operate(focus::unfocus()).discard());
                }
                Effect::ReleaseHeldKeys => out.release_keys = true,
                Effect::Blocking(blocked) => out.gate = Some(blocked),
                Effect::CheckClose { id, reason } => out.check_close.push((id, reason)),
                Effect::Closed { id, .. } => {
                    if self.picks.as_ref().is_some_and(|(menu, _)| *menu == id) {
                        self.picks = None;
                    }
                }
            }
        }
        out.task = Task::batch(tasks);
        out.run = update.run;
        if self.host.menus().is_empty() {
            self.picks = None;
        }
        out
    }

    /// Opens a command menu (a menu button's, a context menu): `keyboard` says a key asked (the ring shows).
    pub fn open_menu(&mut self, entries: Vec<Entry>, anchor: Anchor, invoker: Option<FocusId>, keyboard: bool, focus: &mut FocusState) -> Outcome {
        let update = self.host.open(entries, anchor, Purpose::Commands, invoker, keyboard, None, focus);
        self.carry(update)
    }

    /// Opens a dialog on the stack: its `targets` are the focus targets of its content (the dialog's view wraps them in the
    /// scope of the returned ID), `guarded` asks the owner before it closes. Returns its overlay ID.
    pub fn open_dialog(&mut self, guarded: bool, targets: Vec<FocusTarget>, initial: Option<FocusId>, focus: &mut FocusState) -> (u64, Outcome) {
        let id = self.host.fresh_id();
        let mut overlay = Overlay::new(id, Kind::Dialog);
        overlay.guarded = guarded;
        let effects = self.host.stack_mut().open(overlay, focus, targets, initial).unwrap_or_default();
        (id, self.carry(Update { effects, ..Update::default() }))
    }

    /// Carries out one message of the overlay layer or a select's request.
    pub fn update(&mut self, message: Message, focus: &mut FocusState, now: u64) -> Outcome {
        let bounds = self.bounds.clone();
        let lookup = move |id: FocusId| bounds.iter().find(|(known, _)| *known == id).map(|(_, bounds)| rect(*bounds));
        match message {
            Message::OpenSelect(request) => {
                let request = *request;
                let rows = option_rows(request.options.iter().map(|(label, disabled)| (label.as_str(), *disabled)));
                let update = self.host.open(rows, Anchor::Root(rect(request.anchor)), Purpose::Select { invoker: request.invoker }, Some(request.invoker), request.keyboard, request.chosen, focus);
                if let Some(open) = self.host.menus().last() {
                    self.picks = Some((open.id(), request.picks));
                }
                self.carry(update)
            }
            Message::Overlay(Event::Key(press)) => {
                let key = Key { key: &press.key, ctrl: press.ctrl, meta: press.meta, alt: press.alt, composing: focus.composing() };
                let update = self.host.key(key, &lookup, focus, now);
                self.carry(update)
            }
            Message::Overlay(Event::Hover { menu, index }) => {
                let update = self.host.hover(menu, index, focus, now);
                self.carry(update)
            }
            Message::Overlay(Event::Press { menu, index }) => {
                let update = self.host.press(menu, index, &lookup, focus, now);
                self.carry(update)
            }
            Message::Overlay(Event::Pointer { press, inside, x, y }) => {
                // A press on the menu's own opener toggles it closed.
                let anchor = self.host.top().and_then(|top| top.anchor).filter(|id| self.bounds_of(*id).is_some_and(|b| b.x <= f64::from(x) && f64::from(x) <= b.x + b.width && b.y <= f64::from(y) && f64::from(y) <= b.y + b.height));
                let hit = if inside { None } else { anchor };
                let update = self.host.pointer(press, inside, hit, focus);
                self.carry(update)
            }
            Message::Toast(toast::Event::Dismiss(id)) => {
                self.host.messages_mut().dismiss(id, now);
                Outcome::none()
            }
            Message::Toast(toast::Event::Action { id, index }) => {
                let action = self.host.messages().current().filter(|message| message.id == id).and_then(|message| message.actions.get(index).cloned());
                let mut out = Outcome::none();
                if let Some(action) = action {
                    out.run = Some(action.command);
                    if action.dismiss {
                        self.host.messages_mut().dismiss(id, now);
                    }
                }
                out
            }
            _ => Outcome::none(),
        }
    }

    /// Escape reached the window with no menu holding it: the top overlay's Escape (a dialog, a popover) applies.
    pub fn escape(&mut self, focus: &mut FocusState) -> Outcome {
        let effects = self.host.stack_mut().escape(focus.composing(), focus);
        self.carry(Update { effects, ..Update::default() })
    }

    /// The owner's answer to a close guard.
    pub fn resolve_close(&mut self, id: u64, allow: bool, focus: &mut FocusState) -> Outcome {
        let effects = self.host.stack_mut().resolve_close(id, allow, focus);
        self.carry(Update { effects, ..Update::default() })
    }

    /// Time reached `now` (the wake [`Overlays::next_deadline`] asked for): due hover intents fire. Returns the ID of a
    /// message that expired.
    pub fn tick(&mut self, focus: &mut FocusState, now: u64) -> (Outcome, Option<u64>) {
        let bounds = self.bounds.clone();
        let lookup = move |id: FocusId| bounds.iter().find(|(known, _)| *known == id).map(|(_, bounds)| rect(*bounds));
        let (update, expired) = self.host.tick(now, &lookup, focus);
        (self.carry(update), expired)
    }

    /// The menus and the visible message as a layer over the page: put it above the page in a `stack!`. `top_inset` is the
    /// lowest top a menu may take; `stage` is the stage region the message sits at the foot of.
    pub fn layer<'a>(&'a self, palette: &'static Palette, focus: &FocusState, top_inset: f32, stage: Option<Rectangle>) -> Element<'a, Message> {
        let extra = self.host.messages().current().map(|current| toast::placed(palette, current, stage, Message::Toast)).into_iter().collect();
        menu::layer(palette, &self.host, focus.focus_visible(), top_inset, extra, Message::Overlay)
    }
}
