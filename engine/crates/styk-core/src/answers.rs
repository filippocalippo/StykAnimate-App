//! The one place a session's answer is taken apart (`docs/native/documents.md`: handle even a refusal's events).
//!
//! Every panel and command handler calls the session through [`call`]: the result becomes a value or a message (the
//! error policy's key and parameters), and the answer's events, drawing forks, retirement and clipboard data go to the
//! dispatch's [`Session`] record whatever the result was, so a refusal never loses what the session reported.

use styk_doc::Value;

use crate::commands::refusal;
use crate::documents::{DocumentId, Documents};
use crate::engine::CallAnswer;
use crate::i18n::Msg;

/// What the session reported during one dispatch, besides results: kept for the consumers that act on it (the stage,
/// the timeline, drawing). [`crate::app::Core::dispatch`] starts each dispatch with an empty record.
#[derive(Debug, Default)]
pub struct Session {
    pub events: Vec<Value>,
    pub drawing_forks: Vec<(String, String)>,
    pub drawing_retired: bool,
    /// The kind of the last clipboard the session filled (its data stays the session's).
    pub copied: Option<&'static str>,
}

impl Session {
    /// Takes an answer apart: its reports are kept, its result returned.
    pub fn take(&mut self, answer: CallAnswer) -> Result<Value, Msg> {
        // A retired clipboard was already handed to the documents host's reclamation by `Documents::call`.
        let CallAnswer { result, events, drawing_forks, drawing_retired, clipboard, draws_left: _, retired_clipboard: _ } = answer;
        self.events.extend(events);
        self.drawing_forks.extend(drawing_forks);
        self.drawing_retired |= drawing_retired;
        if let Some((kind, _)) = clipboard {
            self.copied = Some(kind);
        }
        result.map_err(|error| refusal(&error))
    }
}

/// Runs a session command of document `id` with native arguments; refusals of the host (no such tab, not active) are
/// messages too.
pub fn call(documents: &mut Documents, id: DocumentId, method: &str, args: &[Value], session: &mut Session) -> Result<Value, Msg> {
    if matches!(method, "updateBuilderSegmentStyle" | "replaceFigureColor") {
        use crate::documents::{Request, Effect};
        return match documents.dispatch(Request::Call { document: id, method: method.into(), args: args.to_vec(), view: Value::Null }) {
            Ok(Effect::Started(_)) => Ok(Value::Null),
            Err((error, _)) => Err(crate::inspector::host_refusal(&error)),
            Ok(_) => Err(Msg::new("errors.editorSessions.finishTheCurrentOperationFirst")),
        };
    }
    match documents.call(id, method, args, &Value::Null) {
        Ok(answer) => session.take(answer),
        Err(error) => Err(Msg::owned(error.message_key().to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EditError;

    #[test]
    fn a_refusal_keeps_its_events_and_reports() {
        let mut session = Session::default();
        let refused = CallAnswer {
            result: Err(EditError::Invalid("errors.editorSelection.alignmentAxisMustBeXOrY".into())),
            events: vec![Value::str("selection")],
            drawing_forks: vec![("cel".into(), "fork".into())],
            drawing_retired: true,
            clipboard: None,
            draws_left: None,
            retired_clipboard: None,
        };
        let error = session.take(refused).unwrap_err();
        assert_eq!(error.key, "errors.editorSelection.alignmentAxisMustBeXOrY");
        assert_eq!(session.events, [Value::str("selection")], "the refusal's events are kept");
        assert_eq!(session.drawing_forks.len(), 1);
        assert!(session.drawing_retired);
    }
}
