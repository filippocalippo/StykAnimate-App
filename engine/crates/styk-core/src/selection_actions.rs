//! The selection's commands the Inspector offers (`src/app.mjs` `actions`): rotate, reset colours, one-step layer order
//! and alignment, each over Edit together's frames when it reaches two or more.

use styk_doc::{Obj, Value};

use crate::answers;
use crate::commands::{CommandId, Context};
use crate::i18n::Msg;
use crate::range::Range;

fn object(pairs: &[(&str, Value)]) -> Value {
    let mut obj = Obj::new();
    for (key, value) in pairs {
        obj.set(key, value.clone());
    }
    Value::object(obj)
}

/// The app's figure-bounds callback (`boundsOf`), measured by the session from its geometry.
fn bounds_callback() -> Value {
    object(&[("boundsOf", object(&[("@boundsCallback", Value::str("app"))]))])
}

pub fn run(context: &mut Context<'_>, id: CommandId) -> Result<(), Msg> {
    let document = context.documents.active().ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?;
    let doc = document.id();
    let range = Range::of(context.view, document).map(|range| range.value());
    let call = |context: &mut Context<'_>, method: &str, args: &[Value]| answers::call(context.documents, doc, method, args, context.session).map(|_| ());
    use CommandId as C;
    match id {
        C::Rotate => match range {
            Some(frames) => call(context, "rotateFiguresInFrames", &[Value::Num(std::f64::consts::PI / 12.0), frames]),
            None => call(context, "rotateFigure", &[Value::Num(std::f64::consts::PI / 12.0)]),
        },
        C::ResetColor => call(context, "resetFigureColors", &[object(&[("indices", range.unwrap_or(Value::Null))])]),
        C::LayerUp | C::LayerDown => {
            let step = Value::Num(if id == C::LayerUp { 1.0 } else { -1.0 });
            match range {
                Some(frames) => call(context, "orderFiguresInFrames", &[step, frames]),
                None => call(context, "moveSelectionLayer", &[step]),
            }
        }
        C::AlignLeft | C::AlignCenterX | C::AlignRight | C::AlignTop | C::AlignCenterY | C::AlignBottom => {
            let (axis, edge) = match id {
                C::AlignLeft => ("x", "start"),
                C::AlignCenterX => ("x", "center"),
                C::AlignRight => ("x", "end"),
                C::AlignTop => ("y", "start"),
                C::AlignCenterY => ("y", "center"),
                _ => ("y", "end"),
            };
            // `alignSelection(axis, edge)`: over the chosen frames, `alignFiguresInFrames` with the same callback.
            match range {
                Some(frames) => call(context, "alignFiguresInFrames", &[Value::str(axis), Value::str(edge), frames, bounds_callback()]),
                None => call(context, "alignSelection", &[Value::str(axis), Value::str(edge), bounds_callback()]),
            }
        }
        _ => Err(Msg::new("errors.engineOwner.notSupported")),
    }
}
