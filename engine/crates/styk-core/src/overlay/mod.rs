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
    /// IDs strictly increase for this window, so delayed guard replies cannot target a replacement.
    pub fn open(
        &mut self,
        mut entry: Overlay,
        focus: &mut FocusState,
        targets: Vec<FocusTarget>,
        initial: Option<FocusId>,
    ) -> Result<Vec<Effect>, &'static str> {
        if entry.id <= self.last_id {
            return Err("overlay ID must increase for this window");
        }
        if entry
            .parent
            .is_some_and(|id| !self.entries.iter().any(|e| e.id == id))
        {
            return Err("overlay parent is not open");
        }
        let mut out = Vec::new();
        entry.scope = !entry.kind.passive();
        if entry.scope {
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
        let Some(top) = self.top() else {
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
