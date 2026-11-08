//! Today's physical key map and held-key lifecycle. All bindings live in the command registry.

use crate::command_registry::{ENTRIES, Entry};
use crate::focus::{FocusState, HistoryOwner, InputRole};
use crate::text_entry::Chord;

/// Which physical modifier `Mod` names; a data convention, not an OS implementation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform { Control, Command }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope { Drawing, Polygon, Hover, Canvas, Builder, Timeline, Simple, Library, Global }

impl Scope {
    pub fn name(self) -> &'static str {
        match self { Self::Drawing => "drawing", Self::Polygon => "polygon", Self::Hover => "hover",
            Self::Canvas => "canvas", Self::Builder => "builder", Self::Timeline => "timeline",
            Self::Simple => "simple", Self::Library => "library", Self::Global => "global" }
    }
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.iter().find(|scope| scope.name() == name).copied()
    }
    pub const ALL: [Self; 9] = [Self::Drawing, Self::Polygon, Self::Hover, Self::Canvas, Self::Builder,
        Self::Timeline, Self::Simple, Self::Library, Self::Global];
    pub fn rank(self) -> usize { self as usize }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shortcut {
    pub keys: &'static [&'static str],
    pub mac_keys: &'static [&'static str],
    pub desktop_only: bool,
    pub scope: Scope,
    pub hold: bool,
    pub repeat: bool,
    pub extra_shift: bool,
    /// Declaration order in today's hotkey map, which breaks ties inside a scope.
    pub order: u16,
}

impl Shortcut {
    pub fn bindings(&self, platform: Platform, desktop: bool) -> &'static [&'static str] {
        if self.desktop_only && !desktop { &[] }
        else if platform == Platform::Command { self.mac_keys } else { self.keys }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Physical<'a> { code: &'a str, ctrl: bool, meta: bool, alt: bool, shift: bool }

fn physical(binding: &str, platform: Platform) -> Option<Physical<'_>> {
    let mut parts = binding.rsplitn(2, '+');
    let code = parts.next()?;
    let mut result = Physical { code, ctrl: false, meta: false, alt: false, shift: false };
    if let Some(modifiers) = parts.next() {
        for modifier in modifiers.split('+') {
            match modifier {
                "Mod" if platform == Platform::Command => result.meta = true,
                "Mod" | "Ctrl" => result.ctrl = true,
                "Meta" => result.meta = true, "Alt" => result.alt = true, "Shift" => result.shift = true,
                _ => return None,
            }
        }
    }
    Some(result)
}

pub(crate) fn same_binding(a: &str, b: &str, platform: Platform) -> bool {
    physical(a, platform).is_some_and(|a| Some(a) == physical(b, platform))
}
pub(crate) fn same_binding_with_shift(a: &str, b: &str, platform: Platform) -> bool {
    let Some(mut b) = physical(b, platform) else { return false; };
    b.shift = true;
    physical(a, platform) == Some(b)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Activation {
    pub entry: &'static Entry,
    pub key: &'static str,
    /// Extra gesture Shift, separated from Shift that is part of the binding.
    pub shift: bool,
}

/// Matching has no side effects and does not decide whether a focused field owns a key.
pub fn resolve(chord: &Chord, scopes: &[Scope], platform: Platform, desktop: bool) -> Option<Activation> {
    if chord.alt_graph { return None; }
    for scope in scopes.iter().copied().chain(std::iter::once(Scope::Global)) {
        // Exact bindings win over extra Shift even when the extra-Shift command comes first.
        for extra in [false, true] {
            let mut best: Option<(u16, Activation)> = None;
            for entry in ENTRIES {
                let Some(shortcut) = &entry.shortcut else { continue; };
                if shortcut.scope != scope || (extra && !shortcut.extra_shift) { continue; }
                for binding in shortcut.bindings(platform, desktop) {
                    let Some(mut key) = physical(binding, platform) else { continue; };
                    if extra { if key.shift { continue; } key.shift = true; }
                    if key.code == chord.key && key.ctrl == chord.ctrl && key.meta == chord.meta && key.alt == chord.alt && key.shift == chord.shift
                        && best.as_ref().is_none_or(|(order, _)| shortcut.order < *order) {
                        best = Some((shortcut.order, Activation { entry, key: key.code, shift: if shortcut.extra_shift { extra } else { chord.shift } }));
                    }
                }
            }
            if let Some((_, activation)) = best { return Some(activation); }
        }
    }
    None
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    pub repeat: bool,
    pub prevented: bool,
    /// IME provenance supplied with the event, including the legacy 229 marker.
    pub composing: bool,
    pub blocked_by_overlay: bool,
    pub home: bool,
    pub polygon: bool,
    pub drag: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Press {
    Ignored,
    Consumed,
    Run(Activation),
    FeatureHistory { owner: HistoryOwner, action: FieldAction },
    CancelDrag,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Release { pub activation: Activation, pub cancelled: bool }

/// Native menu accelerators keep field history/editing with the focused owner (SH-011).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldAction { Cut, Copy, Paste, SelectAll, Undo, Redo, Delete }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeRoute {
    Blocked,
    Field(FieldAction),
    /// A feature such as the VFX inspector owns the focused field's history.
    FeatureHistory { owner: HistoryOwner, action: FieldAction },
    Run,
}

pub fn native_route(entry: &Entry, focus: &FocusState, dialog: bool) -> NativeRoute {
    let edit = match entry.id {
        "cut" => Some(FieldAction::Cut), "copy" => Some(FieldAction::Copy), "paste" => Some(FieldAction::Paste),
        "select-all" => Some(FieldAction::SelectAll), "undo" => Some(FieldAction::Undo), "redo" => Some(FieldAction::Redo),
        "delete" => Some(FieldAction::Delete), _ => None,
    };
    if let Some(edit) = edit {
        if focus.history_owner() != HistoryOwner::Field && !dialog && matches!(edit, FieldAction::Undo | FieldAction::Redo) {
            return NativeRoute::FeatureHistory { owner: focus.history_owner(), action: edit };
        }
        if matches!(focus.input_role(), InputRole::Text | InputRole::Checkbox | InputRole::Radio | InputRole::Other) {
            return NativeRoute::Field(edit);
        }
    }
    if dialog { NativeRoute::Blocked } else { NativeRoute::Run }
}

/// Held physical keys, not modifiers or focus: key-up still ends the press after a dialog opens.
pub struct Shortcuts {
    platform: Platform,
    desktop: bool,
    held: Vec<Activation>,
}

impl Shortcuts {
    pub fn new(platform: Platform, desktop: bool) -> Self {
        Self { platform, desktop, held: Vec::new() }
    }

    pub fn press(&mut self, focus: &FocusState, chord: &Chord, scopes: &[Scope], input: Input, allow: impl FnOnce(&Entry) -> bool) -> Press {
        if input.composing || focus.composing() || chord.alt_graph { return Press::Ignored; }
        let resolved = resolve(chord, scopes, self.platform, self.desktop);
        let entry = resolved.map(|activation| activation.entry);
        let in_input = focus.input_role() != InputRole::None;
        // The field capture handler precedes ordinary routing and has no repeat or general command predicate.
        if in_input && !input.home && !input.blocked_by_overlay
            && chord.works_in_text_fields_on(self.platform == Platform::Command)
            && let Some(activation) = resolved.filter(|activation| activation.entry.field_key) {
            return Press::Run(activation);
        }
        if input.home && entry.is_none_or(|entry| !entry.key_on_home) { return Press::Ignored; }
        let builder_input = matches!(focus.input_role(), InputRole::Checkbox | InputRole::Radio)
            && entry.is_some_and(|entry| entry.id.starts_with("builder-") && entry.shortcut.is_some_and(|key| key.scope == Scope::Builder));
        let history = entry.and_then(|entry| match entry.id { "undo" => Some(FieldAction::Undo), "redo" => Some(FieldAction::Redo), _ => None });
        let feature_history = history.is_some() && focus.history_owner() != HistoryOwner::Field;
        if input.blocked_by_overlay || (in_input && !builder_input && !feature_history) {
            return if entry.is_some_and(|entry| entry.id == "command-palette") { Press::Consumed } else { Press::Ignored };
        }
        if resolved.is_none() && input.drag {
            let plain = Chord::new(&chord.key, false, false, false);
            if resolve(&plain, scopes, self.platform, self.desktop).is_some_and(|activation| activation.entry.id == "cancel") {
                return Press::CancelDrag;
            }
        }
        if input.prevented { return Press::Ignored; }
        let Some(activation) = resolved else { return Press::Ignored; };
        let entry = activation.entry;
        let Some(shortcut) = entry.shortcut else { return Press::Ignored; };
        if (input.polygon && !entry.polygon_key) || !allow(entry) || (input.repeat && !shortcut.repeat) { return Press::Consumed; }
        if feature_history && let Some(action) = history {
            return Press::FeatureHistory { owner: focus.history_owner(), action };
        }
        if shortcut.hold {
            if let Some(held) = self.held.iter_mut().find(|held| held.key == activation.key) {
                if !shortcut.repeat { return Press::Consumed; }
                *held = activation;
            } else {
                // There are finitely many held bindings in the registry: no event text is retained.
                self.held.push(activation);
            }
        }
        Press::Run(activation)
    }

    pub fn release(&mut self, key: &str) -> Option<Release> {
        let index = self.held.iter().position(|held| held.key == key)?;
        Some(Release { activation: self.held.remove(index), cancelled: false })
    }

    /// A refused submission rolls back its held-key bookkeeping, returning the terminal cancellation.
    pub fn reject(&mut self, activation: Activation) -> Option<Release> {
        if !self.held.contains(&activation) { return None; }
        let mut release = self.release(activation.key)?;
        release.cancelled = true;
        Some(release)
    }

    /// Blur, hidden window and document teardown all use this same terminal path.
    pub fn release_all(&mut self) -> impl Iterator<Item = Release> + '_ {
        self.held.drain(..).map(|activation| Release { activation, cancelled: true })
    }
}
