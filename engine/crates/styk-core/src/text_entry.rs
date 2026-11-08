//! The hotkey suppression rule: typing never fires commands (`docs/hotkeys.md`, `src/hotkeys.mjs`).
//!
//! While a text field has focus no shortcut is a command, except the chords documented as working from fields; while an
//! input method composes, none. AltGraph chords type characters and are never commands.

use crate::focus::{FocusState, InputRole};

/// A key chord as the interface decodes it from a key event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    /// The physical or logical key name (`"KeyZ"`, `"F6"`, `"Escape"`).
    pub key: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    /// AltGraph is held (it types characters on many layouts).
    pub alt_graph: bool,
}

impl Chord {
    /// A chord of a key with the given modifiers, none else.
    pub fn new(key: &str, ctrl: bool, alt: bool, shift: bool) -> Chord {
        Chord { key: key.to_owned(), ctrl, alt, shift, meta: false, alt_graph: false }
    }

    /// F6, Ctrl+F6, Ctrl+Alt+M and Ctrl+Alt+L work from inside a text field (`docs/hotkeys.md`), and nothing else:
    /// Shift+F6 is Remove keyframes (`src/hotkeys.mjs`), so it must not run from a field.
    pub fn works_in_text_fields(&self) -> bool {
        self.works_in_text_fields_on(false)
    }

    /// The same four chords with `Mod` interpreted for the key map's platform.
    pub fn works_in_text_fields_on(&self, command_modifier: bool) -> bool {
        let (primary, secondary) = if command_modifier { (self.meta, self.ctrl) } else { (self.ctrl, self.meta) };
        if secondary || self.shift || self.alt_graph {
            return false;
        }
        match self.key.as_str() {
            "F6" => !self.alt,
            "KeyM" | "KeyL" => primary && self.alt,
            _ => false,
        }
    }
}

/// Whether `chord` may run a command given the focus: false while composing, for AltGraph, and in a text field unless
/// the chord is one of those that work there.
pub fn command_allowed(focus: &FocusState, chord: &Chord) -> bool {
    command_allowed_on(focus, chord, false)
}

/// Platform-aware form used by the single command shortcut router.
pub fn command_allowed_on(focus: &FocusState, chord: &Chord, command_modifier: bool) -> bool {
    if chord.alt_graph || focus.composing() {
        return false;
    }
    focus.input_role() == InputRole::None || chord.works_in_text_fields_on(command_modifier)
}

/// Whether the document's undo and redo are reachable: never while a text field has focus (its own history owns
/// Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y, whether or not the field has anything to undo).
pub fn document_undo_reachable(focus: &FocusState) -> bool {
    focus.input_role() == InputRole::None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::focus::{FocusArea, FocusId, FocusTarget, ScopeId, TargetKind};

    fn state(kind: TargetKind) -> FocusState {
        let mut f = FocusState::new();
        f.register(ScopeId::ROOT, vec![FocusTarget::new(1, FocusArea::Panels, kind)]);
        f.reconcile(Some(FocusId(1)));
        f
    }

    #[test]
    fn typing_in_a_field_fires_no_command() {
        let f = state(TargetKind::TextEntry);
        assert!(!command_allowed(&f, &Chord::new("KeyV", false, false, false)), "the V tool key types a v");
        assert!(!command_allowed(&f, &Chord::new("Delete", false, false, false)));
        assert!(!command_allowed(&f, &Chord::new("KeyZ", true, false, false)));
        assert!(command_allowed(&state(TargetKind::Control), &Chord::new("KeyV", false, false, false)));
    }

    #[test]
    fn the_documented_chords_work_from_a_field() {
        let f = state(TargetKind::TextEntry);
        assert!(command_allowed(&f, &Chord::new("F6", false, false, false)));
        assert!(command_allowed(&f, &Chord::new("F6", true, false, false)));
        assert!(!command_allowed(&f, &Chord::new("F6", false, false, true)), "Shift+F6 is Remove keyframes, not a field chord");
        assert!(command_allowed(&f, &Chord::new("KeyM", true, true, false)));
        assert!(command_allowed(&f, &Chord::new("KeyL", true, true, false)));
        assert!(!command_allowed(&f, &Chord::new("KeyM", true, false, false)));
    }

    #[test]
    fn composition_and_altgraph_allow_nothing() {
        let mut f = state(TargetKind::TextEntry);
        f.set_composing(true);
        assert!(!command_allowed(&f, &Chord::new("F6", false, false, false)));
        let mut altgr = Chord::new("KeyQ", true, true, false);
        altgr.alt_graph = true;
        assert!(!command_allowed(&state(TargetKind::Control), &altgr));
    }

    #[test]
    fn a_removed_field_does_not_suppress_hotkeys_for_good() {
        let mut f = state(TargetKind::TextEntry);
        f.register(ScopeId::ROOT, vec![]);
        assert!(command_allowed(&f, &Chord::new("KeyV", false, false, false)));
        assert!(document_undo_reachable(&f));
    }

    #[test]
    fn undo_belongs_to_the_focused_field() {
        assert!(!document_undo_reachable(&state(TargetKind::TextEntry)));
        assert!(document_undo_reachable(&state(TargetKind::Control)));
    }
}
