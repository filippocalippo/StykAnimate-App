//! The camera's copy and paste. The copied pose is the session's own clipboard (`editor._cameraClipboard`): there is no
//! second copy here; whether Paste can run is a read of that clipboard.

use styk_doc::Value;

use crate::answers;
use crate::commands::{CommandId, Context};
use crate::documents::Document;
use crate::i18n::Msg;
use crate::range::Range;

/// Whether the session holds a copied camera pose.
pub fn can_paste(document: &Document) -> bool {
    matches!(document.read("clipboard", &Value::array(vec![Value::str("camera")])), Some(Ok(Some(value))) if !value.is_null())
}

pub fn run(context: &mut Context<'_>, id: CommandId) -> Result<(), Msg> {
    let document = context.documents.active().ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?;
    let doc = document.id();
    match id {
        CommandId::CameraCopy => answers::call(context.documents, doc, "copyCamera", &[], context.session).map(|_| ()),
        // `pasteCamera(rangeFrames())`: the frames it pastes into, the frame on show by default.
        CommandId::CameraPaste => {
            let frames = Range::of(context.view, document).map_or(Value::Null, |range| range.value());
            answers::call(context.documents, doc, "pasteCamera", &[frames], context.session).map(|_| ())
        }
        _ => Err(Msg::new("errors.engineOwner.notSupported")),
    }
}
