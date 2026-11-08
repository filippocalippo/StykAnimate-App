//! Resolved menu data and keyboard/hover decisions from `ui-menu.mjs`.
use crate::commands::CommandId;
use crate::shortcuts::{Platform, Scope, aria_binding, format_binding};
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Separator,
    Label(String),
    Item(Item),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RowAction { Command(CommandId), Choice(usize) }
impl From<CommandId> for RowAction { fn from(id: CommandId) -> Self { Self::Command(id) } }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub action: RowAction,
    pub label: String,
    pub icon: Option<String>,
    pub checked: Option<bool>,
    pub radio: bool,
    pub group: Option<String>,
    pub danger: bool,
    pub disabled: bool,
    pub reason: String,
    pub hidden: bool,
    pub keep_open: bool,
    pub submenu: Option<Vec<Entry>>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShortcutHint {
    pub text: String,
    pub keyshortcuts: String,
}
impl Item {
    /// A row names a registry command or a stable choice identity; its label may be contextual.
    pub fn new(command: impl Into<RowAction>, label: impl Into<String>) -> Self {
        Self { action: command.into(), label: label.into(), icon: None, checked: None, radio: false,
            group: None, danger: false, disabled: false, reason: String::new(), hidden: false,
            keep_open: false, submenu: None }
    }

    /// Hints are derived from the one registry at display time, including aliases and scope precedence.
    pub fn shortcuts(&self, platform: Platform, desktop: bool, active: &[Scope]) -> ShortcutHint {
        if self.submenu.is_some() { return ShortcutHint::default(); }
        let RowAction::Command(command) = self.action else { return ShortcutHint::default(); };
        let bindings = command.info().visible_bindings(platform, desktop, active);
        ShortcutHint {
            text: bindings.first().map_or_else(String::new, |key| format_binding(key, platform)),
            keyshortcuts: bindings.iter().map(|key| aria_binding(key, platform)).collect::<Vec<_>>().join(" "),
        }
    }
}
/// Owners supply localized labels and availability. Disabled rows remain focusable.
pub fn normalize(entries: Vec<Entry>) -> Vec<Entry> {
    let mut filtered = Vec::new();
    for entry in entries {
        match entry {
            Entry::Item(mut item) => {
                if item.hidden {
                    continue;
                }
                if let Some(sub) = item.submenu.take() {
                    let sub = normalize(sub);
                    if !sub.iter().any(|e| matches!(e, Entry::Item(_))) {
                        continue;
                    }
                    item.submenu = Some(sub);
                }
                if !item.disabled {
                    item.reason.clear();
                }
                filtered.push(Entry::Item(item));
            }
            other => filtered.push(other),
        }
    }
    let mut tidy = Vec::new();
    for (i, e) in filtered.iter().enumerate() {
        if matches!(e, Entry::Label(_)) && !matches!(filtered.get(i + 1), Some(Entry::Item(_))) {
            continue;
        }
        if matches!(e, Entry::Separator)
            && (tidy.is_empty() || matches!(tidy.last(), Some(Entry::Separator)))
        {
            continue;
        }
        tidy.push(e.clone());
    }
    while matches!(tidy.last(), Some(Entry::Separator)) {
        tidy.pop();
    }
    tidy
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Swallow,
    Move(usize),
    OpenSubmenu(usize),
    OpenSubmenuHover(usize),
    CloseChild,
    CloseSubmenu,
    CloseEscape,
    CloseTab,
    Menubar(i8),
    Activate {
        index: usize,
        action: RowAction,
        close: bool,
    },
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Key<'a> {
    pub key: &'a str,
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
    pub composing: bool,
}
#[derive(Clone, Debug, Default)]
pub struct Menu {
    entries: Vec<Entry>,
    current: Option<usize>,
    buffer: String,
    last: Option<u64>,
    hover: Option<(Option<usize>, u64)>,
    child: Option<usize>,
    pub nested: bool,
    pub menubar: bool,
    pub rtl: bool,
}
impl Menu {
    pub fn new(entries: Vec<Entry>) -> Self {
        Self {
            entries: normalize(entries),
            ..Self::default()
        }
    }
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub(super) fn sync_focus(&mut self, index: Option<usize>) {
        self.current = index.filter(|&i| i < self.items().count());
    }
    pub fn current(&self) -> Option<usize> {
        self.current
    }
    pub fn items(&self) -> impl Iterator<Item = &Item> {
        self.entries.iter().filter_map(|e| {
            if let Entry::Item(i) = e {
                Some(i)
            } else {
                None
            }
        })
    }
    pub fn focus(&mut self, index: usize) -> Action {
        if index < self.items().count() {
            self.current = Some(index);
            Action::Move(index)
        } else {
            Action::Swallow
        }
    }
    pub fn activate(&mut self) -> Action {
        let Some(index) = self.current else {
            return Action::Swallow;
        };
        let Some(i) = self.items().nth(index) else {
            return Action::Swallow;
        };
        if i.disabled {
            return Action::Swallow;
        }
        if i.submenu.is_some() {
            return Action::OpenSubmenu(index);
        }
        let keep = i.keep_open && (i.radio || i.checked.is_some());
        let radio = i.radio;
        let group = i.group.clone();
        let action = i.action.clone();
        if keep {
            for (n, e) in self
                .entries
                .iter_mut()
                .filter_map(|e| {
                    if let Entry::Item(i) = e {
                        Some(i)
                    } else {
                        None
                    }
                })
                .enumerate()
            {
                if n == index {
                    e.checked = Some(if radio {
                        true
                    } else {
                        !e.checked.unwrap_or(false)
                    });
                } else if radio && e.radio && e.group == group {
                    e.checked = Some(false);
                }
            }
        }
        Action::Activate {
            index,
            action,
            close: !keep,
        }
    }
    pub fn key(&mut self, e: Key<'_>, now: u64) -> Action {
        if e.composing {
            return Action::Swallow;
        }
        let key = match (self.rtl, e.key) {
            (true, "ArrowLeft") => "ArrowRight",
            (true, "ArrowRight") => "ArrowLeft",
            _ => e.key,
        };
        let n = self.items().count();
        match key {
            "ArrowDown" if n > 0 => self.focus(self.current.map_or(0, |i| (i + 1) % n)),
            "ArrowUp" if n > 0 => self.focus(self.current.map_or(n - 1, |i| (i + n - 1) % n)),
            "Home" | "PageUp" if n > 0 => self.focus(0),
            "End" | "PageDown" if n > 0 => self.focus(n - 1),
            "ArrowRight" => {
                if let Some(i) = self.current
                    && self
                        .items()
                        .nth(i)
                        .is_some_and(|r| !r.disabled && r.submenu.is_some())
                {
                    return Action::OpenSubmenu(i);
                }
                if self.menubar {
                    Action::Menubar(1)
                } else {
                    Action::Swallow
                }
            }
            "ArrowLeft" => {
                if self.nested {
                    Action::CloseSubmenu
                } else if self.menubar {
                    Action::Menubar(-1)
                } else {
                    Action::Swallow
                }
            }
            "Enter" | " " => self.activate(),
            "Escape" => {
                if self.nested {
                    Action::CloseSubmenu
                } else {
                    Action::CloseEscape
                }
            }
            "Tab" => Action::CloseTab,
            _ => {
                if key.encode_utf16().count() != 1 || e.ctrl || e.meta || e.alt {
                    return Action::Swallow;
                }
                if self.last.is_none_or(|t| now.saturating_sub(t) >= 700) {
                    self.buffer.clear();
                }
                self.buffer.push_str(&key.to_lowercase());
                self.last = Some(now);
                let found = find_typeahead(
                    self.items().map(|i| i.label.as_str()),
                    &self.buffer,
                    self.current,
                );
                found.map_or(Action::Swallow, |i| self.focus(i))
            }
        }
    }
    pub fn hover(&mut self, index: usize, now: u64) -> Action {
        let action = self.focus(index);
        if self.child == Some(index) {
            self.hover = None;
            return action;
        }
        self.hover = if self
            .items()
            .nth(index)
            .is_some_and(|i| !i.disabled && i.submenu.is_some())
        {
            Some((Some(index), now.saturating_add(150)))
        } else if self.child.is_some() {
            Some((None, now.saturating_add(250)))
        } else {
            None
        };
        action
    }
    pub fn cancel_hover(&mut self) {
        self.hover = None;
    }
    /// The owning controller acknowledges only a child that actually opened.
    pub fn submenu_opened(&mut self, index: usize) {
        if self
            .items()
            .nth(index)
            .is_some_and(|i| !i.disabled && i.submenu.is_some())
        {
            self.child = Some(index);
        }
    }
    pub fn submenu_closed(&mut self) {
        self.child = None;
        self.hover = None;
    }
    pub fn tick(&mut self, now: u64) -> Action {
        if let Some((i, d)) = self.hover
            && now >= d
        {
            self.hover = None;
            return i.map_or(Action::CloseChild, Action::OpenSubmenuHover);
        }
        Action::Swallow
    }
}
pub fn find_typeahead<'a>(
    labels: impl Iterator<Item = &'a str>,
    query: &str,
    current: Option<usize>,
) -> Option<usize> {
    let labels: Vec<_> = labels.collect();
    if labels.is_empty() || query.is_empty() {
        return None;
    }
    let text = query.to_lowercase();
    let first = text.chars().next()?;
    let repeated = text.chars().all(|c| c == first);
    let needle = if repeated { first.to_string() } else { text };
    let start = if repeated {
        current.map_or(0, |i| i + 1)
    } else {
        current.unwrap_or(0)
    };
    (0..labels.len())
        .map(|step| (start + step) % labels.len())
        .find(|&i| labels[i].trim().to_lowercase().starts_with(&needle))
}

use super::placement::{self, Align, Placement, Positioned, Rect, Side, Size};
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    Root(Rect),
    Point { x: f64, y: f64 },
    Submenu(Rect),
}
impl Menu {
    pub fn deadline(&self) -> Option<u64> {
        self.hover.map(|(_, deadline)| deadline)
    }
    /// Menu-specific placement from ui-menu.mjs #place. Root placement is physical
    /// bottom-start in both directions; submenus select left-start for RTL.
    pub fn place(
        anchor: Anchor,
        size: Size,
        viewport: Size,
        top_inset: f64,
        rtl: bool,
    ) -> Positioned {
        let mut options = Placement {
            top_inset,
            overlap: true,
            ..Placement::default()
        };
        let rect = match anchor {
            Anchor::Root(r) => r,
            Anchor::Point { x, y } => {
                options.offset = 2.;
                Rect {
                    x,
                    y,
                    width: 0.,
                    height: 0.,
                }
            }
            Anchor::Submenu(r) => {
                let right = r.x + r.width;
                let cramped =
                    size.width > viewport.width - 8. - right - 2. && size.width > r.x - 8. - 2.;
                let right = if cramped {
                    right.min(viewport.width - 8. - size.width - 2.).max(8.)
                } else {
                    right
                };
                let left = if cramped { right } else { r.x };
                options.side = if rtl { Side::Left } else { Side::Right };
                options.align = Align::Start;
                options.offset = 2.;
                options.flip = !cramped;
                Rect {
                    x: left,
                    y: r.y - 4.,
                    width: right - left,
                    height: r.height + 8.,
                }
            }
        };
        placement::compute(rect, size, viewport, options)
    }
}

impl Action {
    /// Opening intent travels with the action; views do not choose focus policy.
    pub fn submenu_focus(&self) -> Option<super::OpenFocus> {
        match self {
            Self::OpenSubmenu(_) => Some(super::OpenFocus::First),
            Self::OpenSubmenuHover(_) => Some(super::OpenFocus::Keep),
            _ => None,
        }
    }
}
