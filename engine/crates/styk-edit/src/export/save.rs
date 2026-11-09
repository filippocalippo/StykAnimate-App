//! The document a `.styk` save writes (src/document-export-worker.mjs, which this replaced): the document the session holds
//! with the metadata every project file carries, checked as the save has always checked it, and with the poses its channels
//! share stored once. Writing the container is `styk-engine`'s (`styk_engine::save`).

use styk_doc::{Obj, Value};

use super::{items, number, pose_sequences, set, synchronize_derived, without_runtime_segments, Hold};
use crate::EditError;

fn object(value: Option<&Value>) -> Obj {
    value.and_then(Value::as_obj).cloned().unwrap_or_default()
}

/// A document prepared for a save, and the document its scene is still to be checked on.
pub struct Projected {
    /// What the project file stores.
    pub document: Value,
    /// The document before its pose lists are stored once; [`check_openable`] checks it.
    pub scene: Value,
    /// What was found wrong of the authored channels or the movieclip graph, which [`project_document`] refuses, and a save refuses
    /// unless [`check_openable`] mends it.
    pub unmet: Option<EditError>,
}

/// The scene check of the load (`validateScene`): read-only, the slowest of the checks, and independent of everything that is done with
/// the prepared document next, so a save runs it beside the lift. Its error is the save's.
pub fn check_scene(scene: &Value) -> Result<(), EditError> {
    crate::load::validate_scene(scene)
}

/// What opening the document a save is about to write would make of it. The reader's whole check, on every document the project holds
/// (the movieclips and the scenes they retain too: `styk_edit::load`), so that a save never writes a file opening refuses.
pub enum Openable {
    /// Opening finds nothing to mend: the document is written as it is.
    Sound,
    /// Opening would mend it (`repairs` things); `document` is the document as opening holds it, which the save writes instead.
    Mended { document: Value, repairs: usize },
    /// Opening would refuse it and nothing can mend what it refuses: the save is refused with this reason.
    Refused(EditError),
}

/// [`Openable`] of `scene` (the document before its pose lists are stored once). Read-only: the document it answers with for a mended
/// project is a new one, and `scene` is not changed.
pub fn check_openable(scene: &Value) -> Openable {
    match crate::load::prepare_to_check_openable(scene.clone(), &styk_doc::fanout::Sequential) {
        Ok(opened) if opened.repairs == 0 => Openable::Sound,
        Ok(opened) => Openable::Mended { document: opened.report, repairs: opened.repairs },
        Err(refusal) => Openable::Refused(refusal),
    }
}

/// What a project file stores of `tree`: `_styk.format`, `format_version` and the `name` the file is saved under (kept as the
/// document has it when there is none), no editor cache in the frames, the display aliases in line with their authoritative
/// fields, and the pose channels' lists stored once each. The document must be one the editor would open: the authored
/// channels, the movieclip graph and the scene are validated, in that order (a session's document passed them when it
/// opened and its commands keep them, so this is the net under a document no command could break, not a repair).
pub fn project_document(tree: &Value, name: Option<&str>, hold: &Hold<'_>) -> Result<Value, EditError> {
    let projected = prepare_project(tree, name, hold)?;
    if let Some(unmet) = projected.unmet {
        return Err(unmet);
    }
    check_scene(&projected.scene)?;
    hold.check()?;
    Ok(projected.document)
}

/// [`project_document`] without the scene check, which [`check_scene`] does (and which a save that checks it beside the
/// lift must not forget: its error is the save's).
pub fn prepare_project(tree: &Value, name: Option<&str>, hold: &Hold<'_>) -> Result<Projected, EditError> {
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
    let unmet = crate::load::validate_animation(&document).and_then(|()| crate::load::validate_movieclip_graph(&document)).err();
    hold.check()?;
    let scene = synchronize_derived(&document)?;
    Ok(Projected { document: pose_sequences::pack_pose_sequences(&scene), scene, unmet })
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
