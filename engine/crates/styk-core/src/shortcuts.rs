//! Today's physical key map and held-key lifecycle. All bindings live in the command registry.

use crate::commands::CommandId;
use crate::focus::{FocusState, HistoryOwner, InputRole};
use crate::text_entry::Chord;

/// Which physical modifier `Mod` names; a data convention, not an OS implementation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform { Control, Command }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope { Drawing, Polygon, Hover, Canvas, Builder, Timeline, Simple, Library, Global, #[cfg(feature="devtools")] Developer }

impl Scope {
    pub fn name(self) -> &'static str {
        match self { #[cfg(feature="devtools")] Self::Developer=>"developer", Self::Drawing => "drawing", Self::Polygon => "polygon", Self::Hover => "hover",
            Self::Canvas => "canvas", Self::Builder => "builder", Self::Timeline => "timeline",
            Self::Simple => "simple", Self::Library => "library", Self::Global => "global" }
    }
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.iter().find(|scope| scope.name() == name).copied()
    }
    #[cfg(feature="devtools")]
    pub const ALL: [Self;10] = [Self::Drawing,Self::Polygon,Self::Hover,Self::Canvas,Self::Builder,Self::Timeline,Self::Simple,Self::Library,Self::Global,Self::Developer];
    #[cfg(not(feature="devtools"))]
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

/// Today's visible binding spelling (`hotkeys.mjs::formatBinding`). No binding is stored here.
pub fn format_binding(binding: &str, platform: Platform) -> String {
    binding.split('+').map(|part| binding_part(part, platform, false)).collect::<Vec<_>>().join("+")
}

/// Today's accessible binding spelling (`command-registry.mjs::ariaKeyShortcut`).
pub fn aria_binding(binding: &str, platform: Platform) -> String {
    binding.split('+').map(|part| binding_part(part, platform, true)).collect::<Vec<_>>().join("+")
}

fn binding_part(part: &str, platform: Platform, aria: bool) -> String {
    let label = match part {
        "Mod" => match (platform, aria) {
            (Platform::Control, false) => "Ctrl", (Platform::Control, true) => "Control",
            (Platform::Command, false) => "Cmd", (Platform::Command, true) => "Meta",
        },
        "Ctrl" if aria => "Control",
        "Meta" if !aria && platform == Platform::Command => "Cmd",
        "Escape" if !aria => "Esc",
        "ArrowLeft" if !aria => "←", "ArrowRight" if !aria => "→",
        "ArrowUp" if !aria => "↑", "ArrowDown" if !aria => "↓",
        "CapsLock" if !aria => "Caps Lock",
        "Comma" => ",", "Period" => ".", "Slash" => "/", "Backslash" => "\\",
        "Semicolon" => ";", "Quote" => "'", "BracketLeft" => "[", "BracketRight" => "]",
        "Minus" if !aria => "−", "Minus" => "-", "Equal" => "=", "Backquote" => "`",
        other => {
            let key = other.strip_prefix("Key").or_else(|| other.strip_prefix("Digit")).unwrap_or(other);
            return key.strip_prefix("Numpad").map_or_else(|| key.to_owned(), |n| {
                if aria { n.to_owned() } else { format!("Num {n}") }
            });
        }
    };
    label.to_owned()
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
    pub command: CommandId,
    pub key: &'static str,
    /// Extra gesture Shift, separated from Shift that is part of the binding.
    pub shift: bool,
    /// This admission continues an already-held key; a refused fresh start has no terminal to dispatch.
    pub continued: bool,
}

/// Matching has no side effects and does not decide whether a focused field owns a key.
pub fn resolve(chord: &Chord, scopes: &[Scope], platform: Platform, desktop: bool) -> Option<Activation> {
    if chord.alt_graph { return None; }
    for scope in scopes.iter().copied().chain(std::iter::once(Scope::Global)) {
        // Exact bindings win over extra Shift even when the extra-Shift command comes first.
        for extra in [false, true] {
            let mut best: Option<(u16, Activation)> = None;
            for &command in CommandId::ALL {
                let entry = command.info();
                let Some(shortcut) = &entry.shortcut else { continue; };
                if shortcut.scope != scope || (extra && !shortcut.extra_shift) { continue; }
                for binding in shortcut.bindings(platform, desktop) {
                    let Some(mut key) = physical(binding, platform) else { continue; };
                    if extra { if key.shift { continue; } key.shift = true; }
                    if key.code == chord.key && key.ctrl == chord.ctrl && key.meta == chord.meta && key.alt == chord.alt && key.shift == chord.shift
                        && best.as_ref().is_none_or(|(order, _)| shortcut.order < *order) {
                        best = Some((shortcut.order, Activation { command, key: key.code, shift: if shortcut.extra_shift { extra } else { chord.shift }, continued: false }));
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

pub fn native_route(command: CommandId, focus: &FocusState, dialog: bool) -> NativeRoute {
    let edit = match command {
        CommandId::Cut => Some(FieldAction::Cut), CommandId::Copy => Some(FieldAction::Copy), CommandId::Paste => Some(FieldAction::Paste),
        CommandId::SelectAll => Some(FieldAction::SelectAll), CommandId::Undo => Some(FieldAction::Undo), CommandId::Redo => Some(FieldAction::Redo),
        CommandId::Delete => Some(FieldAction::Delete), _ => None,
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

    /// Current physical holds, including a press pending admission. A refused press must be rejected immediately.
    pub fn held(&self) -> &[Activation] { &self.held }

    pub fn resolve(&self, chord: &Chord, scopes: &[Scope]) -> Option<Activation> {
        resolve(chord, scopes, self.platform, self.desktop)
    }

    pub fn press(&mut self, focus: &FocusState, chord: &Chord, scopes: &[Scope], input: Input, allow: impl FnOnce(CommandId) -> bool) -> Press {
        if input.composing || focus.composing() || chord.alt_graph { return Press::Ignored; }
        let resolved = resolve(chord, scopes, self.platform, self.desktop);
        let entry = resolved.map(|activation| activation.command.info());
        let in_input = focus.input_role() != InputRole::None;
        // The field capture handler precedes ordinary routing and has no repeat or general command predicate.
        if in_input && !input.home && !input.blocked_by_overlay
            && chord.works_in_text_fields_on(self.platform == Platform::Command)
            && let Some(activation) = resolved.filter(|activation| activation.command.info().field_key) {
            return Press::Run(activation);
        }
        if input.home && entry.is_none_or(|entry| !entry.key_on_home) { return Press::Ignored; }
        let builder_input = matches!(focus.input_role(), InputRole::Checkbox | InputRole::Radio)
            && entry.is_some_and(|entry| entry.id.is_builder_shortcut() && entry.shortcut.is_some_and(|key| key.scope == Scope::Builder));
        let history = entry.and_then(|entry| match entry.id { CommandId::Undo => Some(FieldAction::Undo), CommandId::Redo => Some(FieldAction::Redo), _ => None });
        let feature_history = history.is_some() && focus.history_owner() != HistoryOwner::Field;
        if input.blocked_by_overlay || (in_input && !builder_input && !feature_history) {
            return if entry.is_some_and(|entry| entry.id == CommandId::CommandPalette) { Press::Consumed } else { Press::Ignored };
        }
        if resolved.is_none() && input.drag {
            let plain = Chord::new(&chord.key, false, false, false);
            if resolve(&plain, scopes, self.platform, self.desktop).is_some_and(|activation| activation.command == CommandId::Cancel) {
                return Press::CancelDrag;
            }
        }
        if input.prevented { return Press::Ignored; }
        let Some(mut activation) = resolved else { return Press::Ignored; };
        let entry = activation.command.info();
        let Some(shortcut) = entry.shortcut else { return Press::Ignored; };
        if (input.polygon && !entry.polygon_key) || !allow(activation.command) || (input.repeat && !shortcut.repeat) { return Press::Consumed; }
        if feature_history && let Some(action) = history {
            return Press::FeatureHistory { owner: focus.history_owner(), action };
        }
        if shortcut.hold {
            if let Some(held) = self.held.iter_mut().find(|held| held.key == activation.key) {
                if !shortcut.repeat { return Press::Consumed; }
                activation.continued = true;
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

    /// Roll back a refused admission. Only a previously accepted hold needs a terminal cancellation;
    /// a fresh refused press clears bookkeeping without inventing a release for an unstarted key.
    pub fn reject(&mut self, activation: Activation) -> Option<Release> {
        if !self.held.contains(&activation) { return None; }
        let mut release = self.release(activation.key)?;
        release.cancelled = true;
        activation.continued.then_some(release)
    }

    /// Blur, hidden window and document teardown use this terminal path. Submit the drained
    /// releases as one batch before accepting other input, so their reserved slots stay available.
    pub fn release_all(&mut self) -> impl Iterator<Item = Release> + '_ {
        self.held.drain(..).map(|activation| Release { activation, cancelled: true })
    }
}
