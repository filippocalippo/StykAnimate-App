//! The model behind a text field: the text, and what Escape returns to (`docs/native/text-input.md` section 1).
//!
//! The field widget is controlled: it shows the text it is given and reports every change. This holds the text and the
//! value the field started from, so Escape has something to roll back to.

/// The role of a field, which fixes what Enter and Escape do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// One line; Enter commits and the field keeps focus; Escape reverts and blurs.
    SingleLine,
    /// One line inside a dialog; Enter submits the dialog's primary action; Escape belongs to the dialog.
    DialogLine,
    /// Several lines; Enter is a line break (Ctrl+Enter submits); Escape blurs and keeps the text.
    Multiline,
    /// A number; Enter commits and blurs; Escape rolls back to the gesture baseline and blurs.
    Number,
    /// A search; Enter submits; Escape clears, or blurs when empty.
    Search,
}

/// What Enter does for a role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnterAction {
    /// Nothing special: the editor's own (a line break in a multiline field).
    Default,
    /// Commit the text.
    Commit,
    /// Commit the text and leave the field.
    CommitAndBlur,
    /// Submit (the dialog's primary action, the search).
    Submit,
}

/// What Escape does for a role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscapeAction {
    /// Roll the text back to the baseline and leave the field.
    RevertAndBlur,
    /// Leave the field, keeping the text.
    Blur,
    /// Do nothing here: the enclosing dialog handles it.
    PassToDialog,
    /// Empty the field, or leave it when it is already empty.
    ClearOrBlur,
}

impl Role {
    /// Enter, without modifiers.
    pub fn enter(self) -> EnterAction {
        match self {
            Role::SingleLine => EnterAction::Commit,
            Role::DialogLine | Role::Search => EnterAction::Submit,
            Role::Multiline => EnterAction::Default,
            Role::Number => EnterAction::CommitAndBlur,
        }
    }

    /// Ctrl+Enter.
    pub fn ctrl_enter(self) -> EnterAction {
        match self {
            Role::Multiline => EnterAction::Submit,
            other => other.enter(),
        }
    }

    /// Escape.
    pub fn escape(self) -> EscapeAction {
        match self {
            Role::SingleLine | Role::Number => EscapeAction::RevertAndBlur,
            Role::DialogLine => EscapeAction::PassToDialog,
            Role::Multiline => EscapeAction::Blur,
            Role::Search => EscapeAction::ClearOrBlur,
        }
    }

    /// Whether the role is a single line (a pasted line break is dropped).
    pub fn single_line(self) -> bool {
        !matches!(self, Role::Multiline)
    }
}

/// A field's text and its rollback baseline.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldValue {
    text: String,
    baseline: String,
}

impl FieldValue {
    /// A field showing `text`, which is also its baseline.
    pub fn new(text: impl Into<String>) -> FieldValue {
        let text = text.into();
        FieldValue { baseline: text.clone(), text }
    }

    /// The text shown.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The value Escape returns to.
    pub fn baseline(&self) -> &str {
        &self.baseline
    }

    /// The text changed under the user's typing.
    pub fn input(&mut self, text: String) {
        self.text = text;
    }

    /// The value was set from outside (the document changed): it is also the new baseline.
    pub fn set(&mut self, text: impl Into<String>) {
        self.text = text.into();
        self.baseline = self.text.clone();
    }

    /// The edit was committed without leaving the field: what Escape returns to is now the committed text.
    pub fn commit(&mut self) {
        self.baseline = self.text.clone();
    }

    /// Escape: the text goes back to the baseline.
    pub fn revert(&mut self) {
        self.text = self.baseline.clone();
    }

    /// Escape in a search field: empty the text (the baseline stays).
    pub fn clear(&mut self) {
        self.text.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_roles_set_what_enter_and_escape_do() {
        assert_eq!(Role::SingleLine.enter(), EnterAction::Commit);
        assert_eq!(Role::DialogLine.enter(), EnterAction::Submit);
        assert_eq!(Role::Multiline.enter(), EnterAction::Default);
        assert_eq!(Role::Multiline.ctrl_enter(), EnterAction::Submit);
        assert_eq!(Role::Number.enter(), EnterAction::CommitAndBlur);
        assert_eq!(Role::Search.enter(), EnterAction::Submit);
        assert_eq!(Role::SingleLine.escape(), EscapeAction::RevertAndBlur);
        assert_eq!(Role::DialogLine.escape(), EscapeAction::PassToDialog);
        assert_eq!(Role::Multiline.escape(), EscapeAction::Blur);
        assert_eq!(Role::Number.escape(), EscapeAction::RevertAndBlur);
        assert_eq!(Role::Search.escape(), EscapeAction::ClearOrBlur);
        assert!(Role::Search.single_line() && !Role::Multiline.single_line());
    }

    #[test]
    fn escape_reverts_to_the_baseline_and_a_commit_moves_it() {
        let mut field = FieldValue::new("Layer 1");
        field.input("Layer 12".into());
        field.commit();
        field.input("Layer 123".into());
        field.revert();
        assert_eq!(field.text(), "Layer 12", "only the edit since the last commit reverts");
        field.set("Other");
        field.revert();
        assert_eq!(field.text(), "Other", "a value set from outside is the new baseline");
    }

    #[test]
    fn clearing_a_search_keeps_the_baseline() {
        let mut field = FieldValue::new("abc");
        field.clear();
        assert_eq!(field.text(), "");
        assert_eq!(field.baseline(), "abc");
    }
}
