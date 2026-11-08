//! The controller the overlay views consume (K-widgets-b): menu trees, selects, the window's messages and tooltip, and
//! the next wake-up of all of them.
//!
//! `Stack`, `Menu`, `Messages` and `Tooltip` decide; this owns what ties them together, so a view only draws
//! [`OpenMenu`]s and forwards events:
//!
//! - **Menu trees.** Opening a root or a submenu registers its rows with the stack (one focus target per row, a disabled
//!   row included: it stays reachable by keys), applies each `menu::Action` (`OpenSubmenu*`, `CloseChild`, `CloseSubmenu`,
//!   activation) and keeps the models in step with what the stack closed, so a closed child is acknowledged to its parent.
//! - **Selects.** A select opens as an anchored menu over its options; choosing a row reports the option's index, never a
//!   command. The owner of the select sets the value.
//! - **Time.** Every method takes `now`, the application's monotonic milliseconds. [`Host::next_deadline`] is the one wake
//!   the runtime schedules (hover intent, a message's timeout, a tooltip's delay); [`Host::tick`] runs what is due. Nothing
//!   here reads a clock or polls.
//!
//! Geometry comes in as rectangles the views measured (an anchor's, a row's); placement arithmetic is `Menu::place`.

use super::menu::{self, Action, Anchor, Entry, Item, Menu, RowAction, ShortcutHint};
use super::messages::Messages;
use super::placement::Rect;
use super::tooltip::Tooltip;
use super::{Effect, Kind, OpenFocus, Overlay, Reason, Stack};
use crate::commands::CommandId;
use crate::focus::{FocusArea, FocusId, FocusState, FocusTarget, InputRole, TargetKind};
use crate::shortcuts::{Platform, Scope};

/// The most rows a menu registers as focus targets (a menu is short; the open-projects list is the longest).
pub const MAX_ROWS: usize = 4096;

/// The focus ID of a menu's `index`th item. Rows of different menus never collide, and none collides with an interface
/// target (those count up from small numbers).
pub fn row_id(menu: u64, index: usize) -> FocusId {
    FocusId((1 << 40) + (menu << 12) + index.min(MAX_ROWS - 1) as u64)
}

/// The item index a focus ID names in menu `menu`, if it is one of its rows.
pub fn row_index(menu: u64, id: FocusId) -> Option<usize> {
    id.0.checked_sub(row_id(menu, 0).0).filter(|&index| (index as usize) < MAX_ROWS).map(|index| index as usize)
}

/// What the shortcut hints of the menus depend on.
#[derive(Clone, Debug)]
pub struct Hints {
    pub platform: Platform,
    pub desktop: bool,
    /// The scopes active in the workspace (a hint claimed by a more specific active scope is hidden).
    pub scopes: Vec<Scope>,
}

impl Default for Hints {
    fn default() -> Hints {
        Hints { platform: Platform::Control, desktop: true, scopes: vec![Scope::Global] }
    }
}

/// What an open menu is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// Rows run registry commands.
    Commands,
    /// The options of a select: a chosen row reports its index.
    Select { invoker: FocusId },
}

/// One open menu of a tree, as a view draws it.
#[derive(Clone, Debug)]
pub struct OpenMenu {
    id: u64,
    parent: Option<u64>,
    /// The row of the parent this submenu opened from.
    from: Option<usize>,
    menu: Menu,
    anchor: Anchor,
    purpose: Purpose,
    hints: Vec<ShortcutHint>,
    rtl: bool,
    hovered: Option<usize>,
}

impl OpenMenu {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn parent(&self) -> Option<u64> {
        self.parent
    }

    /// The item the pointer is on (`:hover`): it takes the fill even when no key moved focus there.
    pub fn hovered(&self) -> Option<usize> {
        self.hovered
    }

    /// The item of the parent this submenu opened from.
    pub fn from_row(&self) -> Option<usize> {
        self.from
    }

    pub fn entries(&self) -> &[Entry] {
        self.menu.entries()
    }

    /// The focused item (an index among the items, not the entries).
    pub fn current(&self) -> Option<usize> {
        self.menu.current()
    }

    pub fn anchor(&self) -> Anchor {
        self.anchor
    }

    pub fn purpose(&self) -> Purpose {
        self.purpose
    }

    pub fn rtl(&self) -> bool {
        self.rtl
    }

    /// The shortcut hint of the `index`th item (empty for a submenu row and for a select's option).
    pub fn hint(&self, index: usize) -> &ShortcutHint {
        static NONE: ShortcutHint = ShortcutHint { text: String::new(), keyshortcuts: String::new() };
        self.hints.get(index).unwrap_or(&NONE)
    }
}

/// What an event changed that the owner must carry out.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Update {
    /// The stack's effects: focus moves, the hotkey gate, closings. The interface carries them out.
    pub effects: Vec<Effect>,
    /// A command row was activated: run it (`Command::Run`). The menu has been closed unless the row keeps it open.
    pub run: Option<CommandId>,
    /// A select's option was chosen (its index among the select's options).
    pub chose: Option<usize>,
    /// The event belonged to the menus and nothing else may act on it.
    pub consumed: bool,
    pub dismissed: Option<u64>,
}

impl Update {
    /// Focus moved in the core: the toolkit's focus follows (a key or the pointer moved it, no effect said so).
    fn follow(mut self, before: Option<FocusId>, focus: &FocusState) -> Update {
        let after = focus.focused();
        if after != before && !self.effects.iter().any(|effect| matches!(effect, Effect::Focus(_))) {
            self.effects.push(Effect::Focus(after));
        }
        self
    }

    fn merge(&mut self, other: Update) {
        self.effects.extend(other.effects);
        self.run = self.run.or(other.run);
        self.chose = self.chose.or(other.chose);
        self.consumed |= other.consumed;
    }
}

/// The overlay controller of one window.
#[derive(Clone, Debug, Default)]
pub struct Host {
    stack: Stack,
    menus: Vec<OpenMenu>,
    messages: Messages,
    tooltip: Tooltip,
    hints: Hints,
    rtl: bool,
    next: u64,
    now: u64,
    message_hovered: bool,
    last_activation: Option<(FocusId, u64)>,
    press_sequence: u64,
    animations: Vec<(u64, Animation, u64)>,
    animation_deadline: Option<u64>,
    bounds: Vec<(FocusId, Rect)>,
}

impl Host {
    pub fn new(hints: Hints, rtl: bool) -> Host {
        Host { hints, rtl, ..Host::default() }
    }

    pub fn stack(&self) -> &Stack {
        &self.stack
    }

    pub fn stack_mut(&mut self) -> &mut Stack {
        &mut self.stack
    }

    pub fn messages(&self) -> &Messages {
        &self.messages
    }

    pub fn messages_mut(&mut self) -> &mut Messages {
        &mut self.messages
    }

    pub fn tooltip(&self) -> &Tooltip {
        &self.tooltip
    }

    pub fn tooltip_mut(&mut self) -> &mut Tooltip {
        &mut self.tooltip
    }

    /// The open menus, parents before children.
    pub fn menus(&self) -> &[OpenMenu] {
        &self.menus
    }

    /// The next overlay identity (strictly increasing for the window).
    pub fn fresh_id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    pub fn set_hints(&mut self, hints: Hints) {
        self.hints = hints;
    }

    pub fn set_rtl(&mut self, rtl: bool) {
        self.rtl = rtl;
    }

    fn targets(entries: &[Entry], id: u64, select: bool) -> Vec<FocusTarget> {
        entries
            .iter()
            .filter_map(|entry| if let Entry::Item(item) = entry { Some(item) } else { None })
            .take(MAX_ROWS)
            .enumerate()
            .map(|(index, _)| {
                let mut target = FocusTarget::new(row_id(id, index).0, FocusArea::Panels, TargetKind::Control);
                // A select's rows stay inside the select's own role (editor keys stay out), as the select itself does.
                if select {
                    target.input_role = InputRole::Select;
                }
                target
            })
            .collect()
    }

    fn hints_of(&self, menu: &Menu, select: bool) -> Vec<ShortcutHint> {
        menu.items()
            .map(|item| if select { ShortcutHint::default() } else { item.shortcuts(self.hints.platform, self.hints.desktop, &self.hints.scopes) })
            .collect()
    }

    /// Opens a root menu (a menu button's, a context menu's or a select's) and focuses its first row, or `focus` when given.
    /// `invoker` is where focus returns. A pointer-opened menu hides the ring until the first key (`keyboard == false`).
    #[allow(clippy::too_many_arguments)] // One opening: what the menu holds, where it goes, who asked and who gets focus back.
    pub fn open(&mut self, entries: Vec<Entry>, anchor: Anchor, purpose: Purpose, invoker: Option<FocusId>, keyboard: bool, focus_row: Option<usize>, focus: &mut FocusState) -> Update {
        let menu = Menu::new(entries);
        let id = self.fresh_id();
        let select = matches!(purpose, Purpose::Select { .. });
        let targets = Self::targets(menu.entries(), id, select);
        let mut overlay = Overlay::new(id, Kind::Menu);
        overlay.anchor = invoker;
        overlay.keyboard_scope = true;
        let initial = focus_row.map(|row| row_id(id, row));
        let mut update = Update::default();
        if keyboard {
            focus.key_pressed();
        } else {
            focus.pointer_pressed();
        }
        match self.stack.open(overlay, focus, targets, initial) {
            Ok(effects) => update.effects = effects,
            Err(_) => return update,
        }
        let hints = self.hints_of(&menu, select);
        let mut open = OpenMenu { id, parent: None, from: None, menu, anchor, purpose, hints, rtl: self.rtl, hovered: None };
        open.menu.rtl = self.rtl;
        // The row the stack focused is the model's current row.
        if let Some(index) = focus.focused().and_then(|focused| row_index(id, focused)) {
            open.menu.focus(index);
        }
        self.menus.push(open);
        update.consumed = true;
        update
    }

    fn index(&self, id: u64) -> Option<usize> {
        self.menus.iter().position(|menu| menu.id == id)
    }

    fn children_of(&self, id: u64) -> Vec<u64> {
        self.menus.iter().filter(|menu| menu.parent == Some(id)).map(|menu| menu.id).collect()
    }

    fn root_of(&self, mut id: u64) -> u64 {
        while let Some(parent) = self.index(id).and_then(|i| self.menus[i].parent) {
            id = parent;
        }
        id
    }

    /// Keeps the models in step with what the stack closed: a closed child is acknowledged to its parent.
    fn sync(&mut self, effects: &[Effect]) {
        for effect in effects {
            if let Effect::Closed { id, .. } = effect {
                // Whatever closed (a menu, a dialog, a popover) stops entering.
                self.animations.retain(|(key, _, _)| key != id);
            }
            if let Effect::Closed { id, .. } = effect
                && let Some(at) = self.index(*id)
            {
                let gone = self.menus.remove(at);
                if let Some(parent) = gone.parent.and_then(|parent| self.index(parent)) {
                    self.menus[parent].menu.submenu_closed();
                }
            }
        }
    }

    fn close(&mut self, id: u64, reason: Reason, focus: &mut FocusState) -> Update {
        let effects = self.stack.request_close(id, reason, focus);
        self.sync(&effects);
        self.schedule_animation(self.now, false);
        Update { effects, consumed: true, ..Update::default() }
    }

    fn finish(&mut self, id: u64, reason: Reason, focus: &mut FocusState) -> Update {
        let effects = self.stack.finish(id, reason, focus);
        self.sync(&effects);
        self.schedule_animation(self.now, false);
        Update { effects, consumed: true, ..Update::default() }
    }

    /// Opens (or enters) the submenu of the `index`th item of `parent`. `bounds` measures a row.
    fn open_child(&mut self, parent: u64, index: usize, intent: OpenFocus, bounds: &dyn Fn(FocusId) -> Option<Rect>, focus: &mut FocusState) -> Update {
        let Some(at) = self.index(parent) else { return Update::default() };
        let Some(entries) = self.menus[at].menu.items().nth(index).and_then(|item| item.submenu.clone()) else { return Update::default() };
        let mut update = Update { consumed: true, ..Update::default() };
        // The same child is already open (hover opened it, or the click follows the hover): enter it for the keyboard.
        if let Some(open) = self.menus.iter().find(|menu| menu.parent == Some(parent) && menu.from == Some(index)) {
            if intent != OpenFocus::Keep
                && let Some(effect) = self.stack.focus_menu(open.id, focus)
            {
                update.effects.push(effect);
            }
            return update;
        }
        // Another child of the parent is open: it gives way.
        for child in self.children_of(parent) {
            update.merge(self.finish(child, Reason::Replace, focus));
        }
        let Some(at) = self.index(parent) else { return update };
        let row = bounds(row_id(parent, index)).unwrap_or_default();
        let menu = Menu::new(entries);
        let id = self.fresh_id();
        let select = matches!(self.menus[at].purpose, Purpose::Select { .. });
        let targets = Self::targets(menu.entries(), id, select);
        let mut overlay = Overlay::new(id, Kind::Menu);
        overlay.parent = Some(parent);
        overlay.anchor = Some(row_id(parent, index));
        overlay.keyboard_scope = true;
        match self.stack.open_with_focus(overlay, focus, targets, intent) {
            Ok(effects) => update.effects.extend(effects),
            Err(_) => return update,
        }
        let hints = self.hints_of(&menu, select);
        let mut open = OpenMenu { id, parent: Some(parent), from: Some(index), menu, anchor: Anchor::Submenu(row), purpose: self.menus[at].purpose, hints, rtl: self.rtl, hovered: None };
        open.menu.rtl = self.rtl;
        open.menu.nested = true;
        if intent != OpenFocus::Keep {
            open.menu.focus(0);
        }
        self.menus[at].menu.submenu_opened(index);
        self.menus.push(open);
        update
    }

    fn apply(&mut self, id: u64, action: Action, bounds: &dyn Fn(FocusId) -> Option<Rect>, focus: &mut FocusState) -> Update {
        let mut update = Update { consumed: true, ..Update::default() };
        match action {
            Action::Swallow | Action::Move(_) | Action::Menubar(_) => {}
            Action::OpenSubmenu(index) | Action::OpenSubmenuHover(index) => {
                if let Some(intent) = action.submenu_focus() {
                    update.merge(self.open_child(id, index, intent, bounds, focus));
                }
            }
            Action::CloseChild => {
                for child in self.children_of(id) {
                    update.merge(self.finish(child, Reason::Hover, focus));
                }
            }
            Action::CloseSubmenu => update.merge(self.finish(id, Reason::Escape, focus)),
            Action::CloseEscape => update.merge(self.close(id, Reason::Escape, focus)),
            Action::CloseTab => {
                let root = self.root_of(id);
                update.merge(self.close(root, Reason::Tab, focus));
            }
            Action::Activate { action, close, .. } => {
                match action {
                    RowAction::Choice(chosen) => update.chose = Some(chosen),
                    RowAction::Command(command) => update.run = Some(command),
                }
                if close {
                    let root = self.root_of(id);
                    update.merge(self.close(root, Reason::Selected, focus));
                }
            }
        }
        update
    }

    /// A key while a menu is open. Every key belongs to the menus (letters never reach the editor's hotkeys).
    pub fn key(&mut self, key: menu::Key<'_>, bounds: &dyn Fn(FocusId) -> Option<Rect>, focus: &mut FocusState, now: u64) -> Update {
        let Some(id) = self.stack.active_menu(focus) else { return Update::default() };
        let Some(at) = self.index(id) else { return Update::default() };
        focus.key_pressed();
        let before = focus.focused();
        let action = self.stack.menu_key(id, &mut self.menus[at].menu, focus, key, now);
        self.apply(id, action, bounds, focus).follow(before, focus)
    }

    /// The pointer moved onto the `index`th item of menu `id`: it takes focus (without the ring) and a submenu row starts its
    /// hover intent.
    pub fn hover(&mut self, id: u64, index: usize, focus: &mut FocusState, now: u64) -> Update {
        let Some(at) = self.index(id) else { return Update::default() };
        focus.pointer_pressed();
        let before = focus.focused();
        let action = self.stack.menu_hover(id, index, &mut self.menus[at].menu, focus, now);
        if action != Action::Swallow {
            self.menus[at].hovered = Some(index);
        }
        Update { consumed: action != Action::Swallow, ..Update::default() }.follow(before, focus)
    }

    /// The pointer left every menu: a pending hover intent is cancelled.
    pub fn leave(&mut self) {
        for open in &mut self.menus {
            open.menu.cancel_hover();
            open.hovered = None;
        }
    }

    /// A click on the `index`th item of menu `id`.
    pub fn press(&mut self, id: u64, index: usize, bounds: &dyn Fn(FocusId) -> Option<Rect>, focus: &mut FocusState, now: u64) -> Update {
        let Some(at) = self.index(id) else { return Update::default() };
        focus.pointer_pressed();
        let before = focus.focused();
        if self.stack.menu_hover(id, index, &mut self.menus[at].menu, focus, now) == Action::Swallow {
            return Update { consumed: true, ..Update::default() };
        }
        self.menus[at].menu.cancel_hover();
        let action = self.menus[at].menu.activate();
        self.apply(id, action, bounds, focus).follow(before, focus)
    }

    /// A pointer press or release; `inside` says whether it landed on any menu of the tree, `anchor` which focus target (if
    /// any) it landed on. Releases never dismiss.
    pub fn pointer(&mut self, press: bool, inside: bool, anchor: Option<FocusId>, focus: &mut FocusState) -> Update {
        let effects = self.stack.pointer(press, inside, anchor, focus);
        self.sync(&effects);
        Update { consumed: !effects.is_empty(), effects, ..Update::default() }
    }

    /// The window changed under the menus (resize, blur, the anchor scrolled): the menus close without restoring focus.
    pub fn environment(&mut self, reason: Reason, focus: &mut FocusState) -> Update {
        let effects = self.stack.environment(reason, focus);
        self.sync(&effects);
        Update { effects, ..Update::default() }
    }

    /// Time reached `now`: due hover intents fire, a message whose time is up goes, a tooltip whose delay passed shows.
    /// Returns the ID of a message that expired, if one did.
    pub fn tick(&mut self, now: u64, bounds: &dyn Fn(FocusId) -> Option<Rect>, focus: &mut FocusState) -> (Update, Option<u64>) {
        self.now = now;
        self.focus_changed(focus, now);
        self.animations.retain(|(_, kind, start)| kind.looping() || now.saturating_sub(*start) < kind.duration());
        let mut update = Update::default();
        let before = focus.focused();
        let ids: Vec<u64> = self.menus.iter().map(|menu| menu.id).collect();
        for id in ids {
            let Some(at) = self.index(id) else { continue };
            let action = self.menus[at].menu.tick(now);
            if action != Action::Swallow {
                update.merge(self.apply(id, action, bounds, focus));
            }
        }
        self.schedule_animation(now, true);
        let expired = self.messages.tick(now);
        self.tooltip.tick(now);
        (update.follow(before, focus), expired)
    }

    /// When the runtime must next call [`Host::tick`]: the earliest of every menu's hover intent, the visible message's
    /// timeout and the tooltip's delay.
    pub fn next_deadline(&self) -> Option<u64> {
        self.menus.iter().filter_map(|open| open.menu.deadline()).chain(self.messages.deadline()).chain(self.tooltip.deadline()).chain(self.animation_deadline).min()
    }

    /// The top overlay (the one Escape and outside presses address).
    pub fn top(&self) -> Option<&Overlay> {
        self.stack.top()
    }
}

/// Select rows retain their original option identity through menu normalization.
pub fn option_rows<'a>(options: impl IntoIterator<Item = (&'a str, bool)>) -> Vec<Entry> {
    options.into_iter().enumerate().map(|(index, (label, disabled))| Entry::Item(Item { disabled, ..Item::new(RowAction::Choice(index), label) })).collect()
}

/// Animation identifiers belong to the mounting owner; stop them on unmount.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Animation { Progress, Spinner, Entry(Kind) }
impl Animation {
    pub fn duration(self) -> u64 { match self { Self::Progress => 1300, Self::Spinner => 800, Self::Entry(Kind::Menu | Kind::Popover) => 160, Self::Entry(_) => 240 } }
    fn looping(self) -> bool { matches!(self, Self::Progress | Self::Spinner) }
}
/// Events carry injected time separately, and physical press identity when available.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    OpenMenu { entries: Vec<Entry>, anchor: Anchor, invoker: Option<FocusId>, keyboard: bool },
    Environment(Reason),
    ResolveClose { id: u64, allow: bool },
    Select { invoker: FocusId, anchor: Rect, options: Vec<(String, bool)>, chosen: Option<usize>, keyboard: bool, press: u64 },
    Key { key: String, ctrl: bool, meta: bool, alt: bool },
    Hover { menu: u64, index: usize },
    Leave { menu: Option<u64> },
    Press { menu: u64, index: usize },
    Pointer { pressed: bool, inside: bool, anchor: Option<FocusId>, press: u64 },
    Bounds(Vec<(FocusId, Rect)>),
    FocusChanged,
    MessageHover(bool),
    MessageAction { id: u64, index: usize },
    MessageDismiss(u64),
    ShowMessage(super::messages::Message),
    /// A dialog, popover, palette or sheet opens on the stack; its `targets` are the focus targets of its content.
    OpenOverlay { kind: Kind, guarded: bool, targets: Vec<FocusTarget>, initial: Option<FocusId> },
    /// Escape reached the window with no menu holding it: the top overlay's Escape applies (and a tooltip hides).
    Escape,
    /// The pointer or keyboard focus reached a target that has a tooltip.
    TooltipShow { target: FocusId, content: super::tooltip::Content, touch: bool, keyboard: bool },
    /// The pointer left the target, or focus did, or a press, scroll or Escape ended it.
    TooltipHide,
    Animate { id: u64, kind: Option<Animation> },
    Tick,
    Time,
}
/// Shared identity of a message action (slot 15 is its close button).
pub fn message_button_id(message: u64, slot: usize) -> FocusId { FocusId((1 << 41) + (message << 4) + slot.min(15) as u64) }
impl Host {
    pub fn anchor_at(&self, x: f64, y: f64) -> Option<FocusId> {
        self.top().and_then(|top| top.anchor).filter(|id| self.bounds.iter().any(|(key, b)| key == id && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height))
    }
    pub fn press_sequence(&self) -> u64 { self.press_sequence }
    pub fn now(&self) -> u64 { self.now }
    fn schedule_animation(&mut self, now: u64, fired: bool) {
        if self.animations.is_empty() { self.animation_deadline = None; }
        else if fired || self.animation_deadline.is_none() {
            self.animation_deadline = Some(self.animations.iter().filter(|(_, kind, _)| !kind.looping())
                .map(|(_, kind, start)| start.saturating_add(kind.duration()))
                .fold(now.saturating_add(16), u64::min));
        }
    }
    pub fn phase(&self, id: u64) -> f32 {
        self.animations.iter().find(|(key, _, _)| *key == id).map_or(1.0, |(_, kind, start)| {
            let elapsed = self.now.saturating_sub(*start);
            if kind.looping() { (elapsed % kind.duration()) as f32 / kind.duration() as f32 }
            else { (elapsed as f32 / kind.duration() as f32).min(1.0) }
        })
    }
    pub fn focus_changed(&mut self, focus: &FocusState, now: u64) {
        let within = self.messages.current().is_some_and(|m| focus.focused().is_some_and(|id|
            (0..m.actions.len()).any(|slot| message_button_id(m.id, slot) == id) || message_button_id(m.id, 15) == id));
        self.messages.interaction(self.message_hovered, within, now);
    }
    pub fn event(&mut self, event: Event, focus: &mut FocusState, now: u64) -> Update {
        self.now = now;
        let previous_overlays: Vec<u64> = self.stack.entries().iter().map(|e| e.id).collect();
        let previous_message = self.messages.current().map(|m| m.id);
        let bounds = self.bounds.clone();
        let lookup = |id| bounds.iter().find(|(key, _)| *key == id).map(|(_, rect)| *rect);
        let mut out = Update::default();
        match event {
            // The press that closed this opener's menu (outside-press toggle) does not open it again on its release.
            Event::OpenMenu { invoker: Some(invoker), keyboard: false, .. } if self.last_activation == Some((invoker, self.press_sequence)) => return out,
            Event::OpenMenu { entries, anchor, invoker, keyboard } => out = self.open(entries, anchor, Purpose::Commands, invoker, keyboard, None, focus),
            Event::Environment(reason) => out = self.environment(reason, focus),
            Event::ResolveClose { id, allow } => { out.effects = self.stack.resolve_close(id, allow, focus); self.sync(&out.effects); }
            Event::Select { invoker, anchor, options, chosen, keyboard, press } => {
                if !keyboard && self.last_activation == Some((invoker, press)) { return out; }
                if !keyboard { self.last_activation = Some((invoker, press)); }
                if let Some(id) = self.menus.iter().find(|m| m.purpose == Purpose::Select { invoker }).map(|m| m.id) {
                    out = self.close(id, Reason::Toggle, focus);
                } else {
                    out = self.open(option_rows(options.iter().map(|(s, d)| (s.as_str(), *d))), Anchor::Root(anchor), Purpose::Select { invoker }, Some(invoker), keyboard, chosen, focus);
                }
            }
            Event::Pointer { pressed, inside, anchor, press } => {
                if pressed { self.tooltip.hide(now); }
                if !pressed { self.press_sequence = self.press_sequence.wrapping_add(1); self.last_activation = None; }
                if pressed && let Some(invoker) = anchor {
                    if self.last_activation == Some((invoker, press)) { return out; }
                    self.last_activation = Some((invoker, press));
                }
                out = self.pointer(pressed, inside, anchor, focus);
            }
            Event::Key { key, ctrl, meta, alt } => { if key == "Escape" { self.tooltip.hide(now); } out = self.key(menu::Key { key: &key, ctrl, meta, alt, composing: focus.composing() }, &lookup, focus, now); }
            Event::Hover { menu, index } => { self.leave(); out = self.hover(menu, index, focus, now); }
            Event::Leave { menu } => {
                for open in &mut self.menus { if menu.is_none_or(|id| id == open.id) { open.menu.cancel_hover(); open.hovered = None; } }
            }
            Event::Press { menu, index } => out = self.press(menu, index, &lookup, focus, now),
            Event::Bounds(bounds) => self.bounds = bounds,
            Event::FocusChanged | Event::Time => {},
            Event::MessageHover(hover) => self.message_hovered = hover,
            Event::MessageAction { id, index } => {
                if let Some(action) = self.messages.current().filter(|m| m.id == id).and_then(|m| m.actions.get(index)).cloned() {
                    out.run = Some(action.command);
                    if action.dismiss { out.dismissed = self.messages.dismiss(id, now); }
                }
            }
            Event::MessageDismiss(id) => out.dismissed = self.messages.dismiss(id, now),
            Event::ShowMessage(message) => {
                let push = self.messages.push(message, now);
                out.dismissed = push.dropped;
            }
            Event::OpenOverlay { kind, guarded, targets, initial } => {
                let id = self.fresh_id();
                let mut overlay = Overlay::new(id, kind);
                overlay.guarded = guarded;
                if let Ok(effects) = self.stack.open(overlay, focus, targets, initial) { out.effects = effects; }
                out.consumed = true;
            }
            Event::Escape => {
                self.tooltip.hide(now);
                out.effects = self.stack.escape(focus.composing(), focus);
                self.sync(&out.effects);
                out.consumed = !out.effects.is_empty();
            }
            Event::TooltipShow { target, content, touch, keyboard } => self.tooltip.schedule(super::tooltip::Tip { target: target.0, content }, now, touch, keyboard),
            Event::TooltipHide => self.tooltip.hide(now),
            Event::Animate { id, kind } => {
                self.animations.retain(|(key, _, _)| *key != id);
                if let Some(kind) = kind { self.animations.push((id, kind, now)); }
            }
            Event::Tick => { let (update, expired) = self.tick(now, &lookup, focus); out = update; out.dismissed = expired; }
        }
        for entry in self.stack.entries() {
            // A tooltip or message is drawn by its own phase; every box the stack opened enters.
            if !previous_overlays.contains(&entry.id) && !entry.kind.passive_entry() { self.animations.push((entry.id, Animation::Entry(entry.kind), now)); }
        }
        if previous_message != self.messages.current().map(|m| m.id) {
            self.message_hovered = false;
            if let Some(id) = previous_message { self.animations.retain(|(key, _, _)| *key != message_animation_id(id) && *key != message_progress_id(id)); }
            if let Some(m) = self.messages.current() {
                self.animations.push((message_animation_id(m.id), Animation::Entry(Kind::Toast), now));
                if m.task { self.animations.push((message_progress_id(m.id), Animation::Progress, now)); }
            }
        }
        self.schedule_animation(now, false);
        self.focus_changed(focus, now);
        out
    }
}

/// Entry animation key for the visible message, separate from menu IDs.
pub fn message_animation_id(id: u64) -> u64 { (1 << 63) | id }
/// The key of a task message's progress loop.
pub fn message_progress_id(id: u64) -> u64 { (1 << 62) | id }

impl Host {
    /// Where a focus target was when the last walk of the tree found it.
    pub fn bound_of(&self, id: FocusId) -> Option<Rect> {
        self.bounds.iter().find(|(key, _)| *key == id).map(|(_, rect)| *rect)
    }

    /// The tooltip that shows now and the rectangle of the target it names.
    pub fn tooltip_anchor(&self) -> Option<(&super::tooltip::Tip, Rect)> {
        let tip = self.tooltip.visible()?;
        Some((tip, self.bound_of(FocusId(tip.target))?))
    }
}
