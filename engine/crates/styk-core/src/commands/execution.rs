//! Engine-dependent dispatch context and refusal translation. Plain messages live in the parent module.

use crate::answers::Session;
use crate::documents::Documents;
use crate::engine::EditError;
use crate::i18n::{Arg, Msg};
use crate::view_state::ViewState;

/// What a handler is given: the documents, the view state and the dispatch's record of what the session reported.
pub struct Context<'a> {
    pub documents: &'a mut Documents,
    pub view: &'a mut ViewState,
    pub session: &'a mut Session,
}

/// A refusal of the session as a message (`messageError`): the key, and the values its message names.
pub fn refusal(error: &EditError) -> Msg {
    match error {
        EditError::Invalid(text) => {
            let (key, params) = text.split_once('\u{1f}').unwrap_or((text.as_str(), ""));
            let mut msg = Msg::owned(key.to_owned());
            if let Ok(styk_doc::Value::Obj(object)) = styk_doc::json::parse(params.as_bytes()) {
                for (name, value) in object.iter() {
                    let arg = match value {
                        styk_doc::Value::Num(number) => Arg::Num(*number),
                        other => Arg::Text(other.as_str().map_or_else(|| styk_doc::json::to_string(other), str::to_owned).into()),
                    };
                    msg = msg.with(name.to_string(), arg);
                }
            }
            msg
        }
        EditError::Unported(_) => Msg::new("errors.engineOwner.notSupported"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_keeps_its_key_and_parameters() {
        let refused = refusal(&EditError::Invalid("errors.nativePropertyEdit.enterAValueFromTo\u{1f}{\"min\":1,\"max\":1000}".into()));
        assert_eq!(refused.key, "errors.nativePropertyEdit.enterAValueFromTo");
        assert_eq!(crate::i18n::english(&refused), crate::i18n::english(&Msg::new("errors.nativePropertyEdit.enterAValueFromTo").with("min", 1.0).with("max", 1000.0)));
        assert_eq!(refusal(&EditError::Unported("x".into())).key, "errors.engineOwner.notSupported");
    }
}
