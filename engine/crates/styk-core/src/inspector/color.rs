//! Solid colour commits from the existing Inspector control, through the session's colour owners.
use super::model::{ColorTarget, Paint, Row};
use crate::{answers::{self, Session}, documents::Documents, i18n::Msg, range::Range, view_state::ViewState};
use styk_doc::{Obj, Value};

pub fn initial(panel: &super::Panel, target: ColorTarget) -> Option<[u8; 3]> {
    if panel.pending() || !matches!(target, ColorTarget::Figure | ColorTarget::Segment) { return None; }
    fn find(rows: &[Row], target: ColorTarget) -> Option<[u8; 3]> {
        rows.iter().find_map(|row| match row {
            Row::Color(row) if row.target == target && !row.disabled => match &row.paint { Paint::Solid(rgb) => Some(*rgb), Paint::Gradient(_) => None },
            Row::Grid { rows, .. } | Row::Group { rows, .. } => find(rows, target),
            _ => None,
        })
    }
    panel.model()?.sections.iter().find_map(|section| find(&section.rows, target))
}

pub fn commit(documents: &mut Documents, view: &ViewState, session: &mut Session, target: ColorTarget, rgb: [u8; 3]) -> Result<(), Msg> {
    let doc = documents.active().ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?;
    let id = doc.id();
    let range = Range::of(view, doc).map(|r| r.value()).unwrap_or(Value::Null);
    let mut options = Obj::new(); options.set("indices", range);
    let color = Value::array(rgb.into_iter().map(|v| Value::Num(f64::from(v))).collect());
    let (method, args) = match target {
        ColorTarget::Figure => ("setFigureColor", vec![color, Value::object(options)]),
        ColorTarget::Segment => {
            let mut patch = Obj::new(); patch.set("color", color);
            ("updateBuilderSegmentStyle", vec![Value::object(patch)])
        }
        _ => return Err(Msg::new("errors.engineOwner.notSupported")),
    };
    answers::call(documents, id, method, &args, session).map(|_| ())
}
