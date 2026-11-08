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

use super::menu::{self, Action, Anchor, Entry, Item, Menu, ShortcutHint};
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
#[derive(Debug, Default)]
pub struct Host {
    stack: Stack,
    menus: Vec<OpenMenu>,
    messages: Messages,
    tooltip: Tooltip,
    hints: Hints,
    rtl: bool,
    next: u64,
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
        Update { effects, consumed: true, ..Update::default() }
    }

    fn finish(&mut self, id: u64, reason: Reason, focus: &mut FocusState) -> Update {
        let effects = self.stack.finish(id, reason, focus);
        self.sync(&effects);
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
            Action::Activate { index, command, close } => {
                let select = self.index(id).and_then(|at| match self.menus[at].purpose {
                    Purpose::Select { .. } => Some(index),
                    Purpose::Commands => None,
                });
                match select {
                    Some(chosen) => update.chose = Some(chosen),
                    None => update.run = Some(command),
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
        let expired = self.messages.tick(now);
        self.tooltip.tick(now);
        (update.follow(before, focus), expired)
    }

    /// When the runtime must next call [`Host::tick`]: the earliest of every menu's hover intent, the visible message's
    /// timeout and the tooltip's delay.
    pub fn next_deadline(&self) -> Option<u64> {
        self.menus.iter().filter_map(|open| open.menu.deadline()).chain(self.messages.deadline()).chain(self.tooltip.deadline()).min()
    }

    /// The top overlay (the one Escape and outside presses address).
    pub fn top(&self) -> Option<&Overlay> {
        self.stack.top()
    }
}

/// The rows of a select's list: one per option, a disabled option a disabled row. A select's rows are not registry
/// commands, so they carry the registry's `Menu` identity as a placeholder, which [`Host`] never reports for a select (it
/// reports the chosen index instead).
pub fn option_rows<'a>(options: impl IntoIterator<Item = (&'a str, bool)>) -> Vec<Entry> {
    options.into_iter().map(|(label, disabled)| Entry::Item(Item { disabled, ..Item::new(CommandId::Menu, label) })).collect()
}
