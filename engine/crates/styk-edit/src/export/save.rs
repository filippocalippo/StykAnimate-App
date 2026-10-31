//! The document a `.styk` save writes (src/document-export-worker.mjs, which this replaced): the document the session holds
//! with the metadata every project file carries, checked as the save has always checked it, and with the poses its channels
//! share stored once. Writing the container is `styk-engine`'s (`styk_engine::save`).

use styk_doc::{Obj, Value};

use super::{items, number, pose_sequences, set, synchronize_derived, without_runtime_segments, Hold};
use crate::EditError;

fn object(value: Option<&Value>) -> Obj {
    value.and_then(Value::as_obj).cloned().unwrap_or_default()
}

/// What a project file stores of `tree`: `_styk.format`, `format_version` and the `name` the file is saved under (kept as the
/// document has it when there is none), no editor cache in the frames, the display aliases in line with their authoritative
/// fields, and the pose channels' lists stored once each. The document must be one the editor would open: the authored
/// channels, the movieclip graph and the scene are validated, in that order (a session's document passed them when it
/// opened and its commands keep them, so this is the net under a document no command could break, not a repair).
pub fn project_document(tree: &Value, name: Option<&str>, hold: &Hold<'_>) -> Result<Value, EditError> {
    let mut document = tree.clone();
    let mut styk = object(document.get("_styk"));
    styk.set("format", Value::str("StykAnimate"));
    styk.set("format_version", Value::Num(1.0));
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        styk.set("name", Value::str(name));
    }
    set(&mut document, "_styk", Value::object(styk));
    let document = without_runtime_segments(&document);
    hold.check()?;
    crate::load::validate_animation(&document)?;
    crate::load::validate_movieclip_graph(&document)?;
    hold.check()?;
    let document = synchronize_derived(&document)?;
    crate::load::validate_scene(&document)?;
    hold.check()?;
    Ok(pose_sequences::pack_pose_sequences(&document))
}

/// `parent` with the definition of the movieclip `type_id` holding `clip` (its document as it stands) and the duration of its
/// stored frames: the project a movieclip being edited belongs to, as a recovery copy stores it
/// (`movieclipProjectReport` of src/editor-movieclips.mjs, one scope at a time).
pub fn fold_movieclip(parent: &Value, type_id: f64, clip: &Value) -> Result<Value, EditError> {
    let stored = super::pivot::stored_frame_report(clip)?;
    let duration = crate::timeline::total_ticks(&crate::timeline::rows(&stored)).max(1.0);
    let figures: Vec<Value> = items(parent.get("figure_types"))
        .into_iter()
        .map(|figure| {
            if number(&figure, "figure_type_id") != Some(type_id) {
                return figure;
            }
            let mut asset = object(figure.path(&["_styk", "movieclip"]));
            asset.set("document", clip.clone());
            asset.set("duration", Value::Num(duration));
            let mut styk = object(figure.get("_styk"));
            styk.set("movieclip", Value::object(asset));
            let mut next = figure.clone();
            set(&mut next, "_styk", Value::object(styk));
            next
        })
        .collect();
    let mut document = parent.clone();
    set(&mut document, "_styk", Value::object(object(parent.get("_styk"))));
    set(&mut document, "figure_types", Value::array(figures));
    Ok(document)
}
