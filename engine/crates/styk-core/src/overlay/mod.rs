//! Overlay ownership, dismissal and focus. No toolkit, services or clock reads.
pub mod menu;
pub mod messages;
pub mod placement;
pub mod tooltip;
use crate::focus::{FocusId, FocusState, FocusTarget, ScopeId};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dialog,
    Menu,
    Popover,
    Palette,
    Sheet,
    Toast,
    Tooltip,
}
impl Kind {
    fn passive(self) -> bool {
        matches!(self, Self::Toast | Self::Tooltip)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Escape,
    OutsidePress,
    Tab,
    Blur,
    Resize,
    AnchorScroll,
    Selected,
    Abort,
    Removed,
    CloseAll,
    Toggle,
    Hover,
    Replace,
}
#[derive(Clone, Debug)]
pub struct Overlay {
    pub id: u64,
    pub kind: Kind,
    pub parent: Option<u64>,
    pub anchor: Option<FocusId>,
    pub modal: bool,
    pub keyboard_scope: bool,
    pub close_on_escape: bool,
    pub outside_press: bool,
    pub return_focus: bool,
    pub guarded: bool,
    pending: Option<Reason>,
    scope: bool,
    focus_scope: Option<ScopeId>,
    target_ids: Vec<FocusId>,
}
impl Overlay {
    pub fn new(id: u64, kind: Kind) -> Self {
        Self {
            id,
            kind,
            parent: None,
            anchor: None,
            modal: kind == Kind::Dialog,
            keyboard_scope: false,
            close_on_escape: true,
            outside_press: kind == Kind::Menu,
            return_focus: !kind.passive(),
            guarded: false,
            pending: None,
            scope: false,
            focus_scope: None,
            target_ids: Vec::new(),
        }
    }
    fn blocks(&self) -> bool {
        self.modal || self.keyboard_scope || matches!(self.kind, Kind::Menu | Kind::Palette)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    ReleaseHeldKeys,
    Blocking(bool),
    Focus(Option<FocusId>),
    Closed { id: u64, reason: Reason },
    CheckClose { id: u64, reason: Reason },
}
#[derive(Clone, Debug, Default)]
pub struct Stack {
    entries: Vec<Overlay>,
    external_dialog: bool,
    blocking: bool,
    last_id: u64,
}
impl Stack {
    pub fn entries(&self) -> &[Overlay] {
        &self.entries
    }
    pub fn blocks_hotkeys(&self) -> bool {
        self.blocking
    }
    pub fn top(&self) -> Option<&Overlay> {
        self.entries.iter().rev().find(|e| !e.kind.passive())
    }
    pub fn modal_host(&self) -> Option<u64> {
        self.entries.iter().rev().find(|e| e.modal).map(|e| e.id)
    }
    fn gate(&mut self, effects: &mut Vec<Effect>) {
        let b = self.external_dialog || self.entries.iter().any(Overlay::blocks);
        if b != self.blocking {
            self.blocking = b;
            if b {
                effects.push(Effect::ReleaseHeldKeys);
            }
            effects.push(Effect::Blocking(b));
        }
    }
    pub fn external_dialog(&mut self, open: bool) -> Vec<Effect> {
        self.external_dialog = open;
        let mut out = Vec::new();
        self.gate(&mut out);
        out
    }
    /// IDs strictly increase for this window. Root menus and non-menu overlays own scopes;
    /// submenus join their root menu's scope, so ancestor rows remain eligible for focus.
    pub fn open(
        &mut self,
        entry: Overlay,
        focus: &mut FocusState,
        targets: Vec<FocusTarget>,
        initial: Option<FocusId>,
    ) -> Result<Vec<Effect>, &'static str> {
        self.open_with_focus(
            entry,
            focus,
            targets,
            initial.map_or(OpenFocus::First, OpenFocus::Target),
        )
    }
    pub fn open_with_focus(
        &mut self,
        mut entry: Overlay,
        focus: &mut FocusState,
        targets: Vec<FocusTarget>,
        intent: OpenFocus,
    ) -> Result<Vec<Effect>, &'static str> {
        if entry.id <= self.last_id {
            return Err("overlay ID must increase for this window");
        }
        let parent = entry
            .parent
            .and_then(|id| self.entries.iter().find(|e| e.id == id));
        if entry.parent.is_some() && parent.is_none() {
            return Err("overlay parent is not open");
        }
        let shared = parent
            .filter(|p| p.kind == Kind::Menu && entry.kind == Kind::Menu)
            .and_then(|p| p.focus_scope);
        if intent == OpenFocus::Keep && shared.is_none() {
            return Err("keep-focus opening requires a parent menu");
        }
        entry.target_ids = targets.iter().map(|t| t.id).collect();
        if shared.is_some() {
            entry.anchor = entry.anchor.or(focus.focused());
        }
        entry.scope = !entry.kind.passive() && shared.is_none();
        entry.focus_scope = if entry.scope {
            Some(ScopeId(entry.id))
        } else {
            shared
        };
        let initial = match intent {
            OpenFocus::Target(id) => Some(id),
            _ => None,
        };
        let mut out = Vec::new();
        if let Some(scope) = shared {
            let first = initial
                .filter(|id| targets.iter().any(|t| t.id == *id && t.enabled))
                .or_else(|| {
                    targets
                        .iter()
                        .find(|t| t.enabled && t.tab_stop)
                        .or_else(|| targets.iter().find(|t| t.enabled))
                        .map(|t| t.id)
                });
            focus.replace_scope_targets(scope, &[], targets);
            if intent != OpenFocus::Keep
                && let Some(id) = first
            {
                out.push(Effect::Focus(focus.focus(id)));
            }
        } else if entry.scope {
            if let Some(anchor) = entry.anchor {
                focus.focus(anchor);
            }
            out.push(Effect::Focus(focus.open_scope(
                ScopeId(entry.id),
                targets,
                initial,
            )));
        }
        self.last_id = entry.id;
        self.entries.push(entry);
        self.gate(&mut out);
        Ok(out)
    }
    /// Replace one menu's rows without removing its ancestors' or descendants' targets.
    pub fn register_targets(
        &mut self,
        id: u64,
        targets: Vec<FocusTarget>,
        focus: &mut FocusState,
    ) -> Option<FocusId> {
        let entry = self.entries.iter_mut().find(|e| e.id == id)?;
        let scope = entry.focus_scope?;
        let ids = targets.iter().map(|t| t.id).collect();
        let result = focus.replace_scope_targets(scope, &entry.target_ids, targets);
        entry.target_ids = ids;
        result
    }
    /// ui-menu #activeMenu: the menu holding focus, otherwise the deepest open menu.
    pub fn active_menu(&self, focus: &FocusState) -> Option<u64> {
        let deepest = self.top().filter(|e| e.kind == Kind::Menu)?;
        Some(
            self.entries
                .iter()
                .rev()
                .find(|e| {
                    e.kind == Kind::Menu
                        && e.focus_scope == deepest.focus_scope
                        && focus.focused().is_some_and(|id| e.target_ids.contains(&id))
                })
                .unwrap_or(deepest)
                .id,
        )
    }
    /// Keyboard opening of an already visible hover submenu enters its first eligible row.
    pub fn focus_menu(&self, id: u64, focus: &mut FocusState) -> Option<Effect> {
        let entry = self
            .entries
            .iter()
            .find(|e| e.id == id && e.kind == Kind::Menu)?;
        entry
            .target_ids
            .iter()
            .find_map(|id| focus.focus(*id))
            .map(|id| Effect::Focus(Some(id)))
    }
    /// Pointer movement focuses a row anywhere in the active menu tree, including ancestors.
    pub fn menu_hover(
        &self,
        id: u64,
        index: usize,
        model: &mut menu::Menu,
        focus: &mut FocusState,
        now: u64,
    ) -> menu::Action {
        let Some(entry) = self
            .entries
            .iter()
            .find(|e| e.id == id && e.kind == Kind::Menu)
        else {
            return menu::Action::Swallow;
        };
        let Some(target) = entry.target_ids.get(index) else {
            return menu::Action::Swallow;
        };
        if focus.focus(*target).is_none() {
            return menu::Action::Swallow;
        }
        model.hover(index, now)
    }
    /// Synchronize the active row from the tree's single focus owner before interpreting a key.
    /// The returned action is core policy; Move is applied to the shared focus scope here.
    pub fn menu_key(
        &self,
        id: u64,
        model: &mut menu::Menu,
        focus: &mut FocusState,
        event: menu::Key<'_>,
        now: u64,
    ) -> menu::Action {
        if self.active_menu(focus) != Some(id) {
            return menu::Action::Swallow;
        }
        let Some(entry) = self.entries.iter().find(|e| e.id == id) else {
            return menu::Action::Swallow;
        };
        model.nested = entry.parent.is_some_and(|id| {
            self.entries
                .iter()
                .any(|e| e.id == id && e.kind == Kind::Menu)
        });
        model.sync_focus(
            focus
                .focused()
                .and_then(|id| entry.target_ids.iter().position(|t| *t == id)),
        );
        let action = model.key(event, now);
        if let menu::Action::Move(index) = action
            && let Some(id) = entry.target_ids.get(index)
        {
            focus.focus(*id);
        }
        action
    }
    pub fn request_close(
        &mut self,
        id: u64,
        reason: Reason,
        focus: &mut FocusState,
    ) -> Vec<Effect> {
        let Some(e) = self.entries.iter_mut().find(|e| e.id == id) else {
            return Vec::new();
        };
        if e.pending.is_some() {
            return Vec::new();
        }
        if e.guarded {
            e.pending = Some(reason);
            return vec![Effect::CheckClose { id, reason }];
        }
        self.finish(id, reason, focus)
    }
    /// Guard failures are supplied as `allow=false`; replies after removal are harmless.
    pub fn resolve_close(&mut self, id: u64, allow: bool, focus: &mut FocusState) -> Vec<Effect> {
        let Some(e) = self.entries.iter_mut().find(|e| e.id == id) else {
            return Vec::new();
        };
        let Some(reason) = e.pending.take() else {
            return Vec::new();
        };
        if allow {
            self.finish(id, reason, focus)
        } else {
            Vec::new()
        }
    }
    /// Unconditional lifecycle teardown, also for abort/removal. Removes only the named scope.
    pub fn finish(&mut self, id: u64, reason: Reason, focus: &mut FocusState) -> Vec<Effect> {
        let mut descendants = Vec::new();
        if self
            .entries
            .iter()
            .any(|e| e.id == id && e.kind == Kind::Menu)
        {
            let children: Vec<_> = self
                .entries
                .iter()
                .rev()
                .filter(|e| e.parent == Some(id) && e.kind == Kind::Menu)
                .map(|e| e.id)
                .collect();
            for child in children {
                descendants.extend(self.finish(child, reason, focus));
            }
        }
        let Some(index) = self.entries.iter().position(|e| e.id == id) else {
            return Vec::new();
        };
        let entry = self.entries.remove(index);
        let mut out = descendants;
        out.push(Effect::Closed { id, reason });
        if entry.scope {
            let restored = focus.remove_scope(ScopeId(id), entry.return_focus);
            out.push(Effect::Focus(restored));
        } else if let Some(scope) = entry.focus_scope {
            let had_focus = focus
                .focused()
                .is_some_and(|id| entry.target_ids.contains(&id));
            focus.remove_scope_targets(scope, &entry.target_ids, entry.anchor);
            let restore = entry.return_focus
                && !matches!(
                    reason,
                    Reason::Hover
                        | Reason::Replace
                        | Reason::OutsidePress
                        | Reason::Blur
                        | Reason::Resize
                        | Reason::AnchorScroll
                        | Reason::Removed
                        | Reason::Abort
                );
            if (restore || had_focus)
                && let Some(id) = entry.anchor.and_then(|id| focus.focus(id))
            {
                out.push(Effect::Focus(Some(id)));
            }
        }
        for child in &mut self.entries {
            if child.parent == Some(id) {
                child.parent = entry.parent;
            }
        }
        self.gate(&mut out);
        out
    }
    /// Pointer releases never dismiss a context menu opened during a press.
    /// `inside` includes the menu tree; an anchor press closes as a toggle.
    pub fn pointer(
        &mut self,
        press: bool,
        inside: bool,
        anchor: Option<FocusId>,
        focus: &mut FocusState,
    ) -> Vec<Effect> {
        let Some(top) = self.top() else {
            return Vec::new();
        };
        if !press || inside || !top.outside_press {
            return Vec::new();
        }
        let mut root = top;
        while root.kind == Kind::Menu {
            let Some(parent) = root.parent.and_then(|id| {
                self.entries
                    .iter()
                    .find(|e| e.id == id && e.kind == Kind::Menu)
            }) else {
                break;
            };
            root = parent;
        }
        let reason = if anchor.is_some() && anchor == root.anchor {
            Reason::Toggle
        } else {
            Reason::OutsidePress
        };
        self.request_close(root.id, reason, focus)
    }
    pub fn escape(&mut self, composing: bool, focus: &mut FocusState) -> Vec<Effect> {
        let Some(top) = self
            .active_menu(focus)
            .and_then(|id| self.entries.iter().find(|e| e.id == id))
            .or_else(|| self.top())
        else {
            return Vec::new();
        };
        if composing || !top.close_on_escape {
            return Vec::new();
        }
        self.request_close(top.id, Reason::Escape, focus)
    }
    pub fn environment(&mut self, reason: Reason, focus: &mut FocusState) -> Vec<Effect> {
        let ids: Vec<_> = self
            .entries
            .iter()
            .rev()
            .filter(|e| e.kind == Kind::Menu)
            .map(|e| e.id)
            .collect();
        let mut out = Vec::new();
        for id in ids {
            out.extend(self.request_close(id, reason, focus));
        }
        out
    }
    /// Continue after each allowed guard reply. A veto leaves lower overlays untouched.
    pub fn close_all(&mut self, focus: &mut FocusState) -> Vec<Effect> {
        let mut out = Vec::new();
        while let Some(e) = self.entries.last() {
            let id = e.id;
            let guarded = e.guarded;
            out.extend(self.request_close(id, Reason::CloseAll, focus));
            if guarded {
                break;
            }
        }
        out
    }
}
#[cfg(test)]
mod placement_reference_tests;
#[cfg(test)]
mod tests;

/// Submenus may open from keyboard input or pointer intent without stealing the parent's focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFocus {
    First,
    Target(FocusId),
    Keep,
}
