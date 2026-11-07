//! Undo and redo: the session's own history, through the answer adapter.

use crate::answers;
use crate::commands::{CommandId, Context};
use crate::i18n::Msg;

/// Runs `undo` or `redo` on the active document.
pub fn run(context: &mut Context<'_>, id: CommandId) -> Result<(), Msg> {
    let document = context.documents.active().ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?.id();
    let method = if id == CommandId::Redo { "redo" } else { "undo" };
    answers::call(context.documents, document, method, &[], context.session).map(|_| ())
}
