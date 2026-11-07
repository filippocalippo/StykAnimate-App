//! What the Inspector reads of a document: the session's frame on show (`editor.selectionFrame`: live gestures and
//! previews included), its typed figures and its records, projected into plain values. Nothing here is kept: the view
//! model holds what it displays, never a borrowed engine object.

use std::sync::Arc;

use styk_doc::Value;
use styk_eval::doc::Figure;

use crate::documents::Document;

pub(crate) fn num(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

pub(crate) fn item_f64(value: Option<&Value>, index: usize) -> Option<f64> {
    value.and_then(|items| items.item(index)).and_then(|item| item.as_f64())
}

/// `value * 180 / Math.PI`, as today's `degrees`.
pub(crate) fn degrees(radians: f64) -> f64 {
    radians * 180.0 / std::f64::consts::PI
}

/// The objects of the frame on show.
pub(crate) fn frame_objects(frame: &Value) -> Vec<Value> {
    frame.get("objects").and_then(Value::elements).map(|items| items.iter().collect()).unwrap_or_default()
}

fn uid_of(object: &Value) -> Option<u32> {
    object.get("unique_id").and_then(Value::as_f64).and_then(|uid| (uid >= 0.0 && uid.fract() == 0.0 && uid <= f64::from(u32::MAX)).then_some(uid as u32))
}

/// `editor.object`: the selected figure's pose in the frame on show, else the last selected one there.
pub(crate) fn selected_object(document: &Document, frame: &Value) -> Option<Value> {
    let selection = document.selection();
    let objects = frame_objects(frame);
    let by_uid = |uid: u32| objects.iter().find(|object| uid_of(object) == Some(uid)).cloned();
    selection.uid.and_then(by_uid).or_else(|| selection.uids.iter().rev().find_map(|uid| by_uid(*uid)))
}

/// `editor.selectedObjects`: every selected figure's pose in the frame on show, in frame order.
pub(crate) fn selected_objects(document: &Document, frame: &Value) -> Vec<Value> {
    let selection = document.selection();
    frame_objects(frame).into_iter().filter(|object| uid_of(object).is_some_and(|uid| selection.uids.contains(&uid))).collect()
}

/// The typed figure of a pose record.
pub(crate) fn figure_of(document: &Document, object: &Value) -> Option<Arc<Figure>> {
    let id = object.get("figure_type_id").and_then(Value::as_f64)? as u32;
    document.with_document(|typed| typed.figure(id).cloned()).ok().flatten()
}

/// The selected figure's definition and pose.
pub(crate) fn figure_of_selection(document: &Document) -> Option<(Arc<Figure>, Value)> {
    let frame = document.frame_records().ok()?;
    let object = selected_object(document, &frame)?;
    Some((figure_of(document, &object)?, object))
}

/// The Angle row: the pose's rotation relative to the figure's first segment, in degrees.
pub(crate) fn rotation(figure: &Figure, object: &Value) -> f64 {
    let first = item_f64(object.get("angles"), 0).unwrap_or(0.0);
    degrees(first - figure.segments.first().map_or(0.0, |segment| segment.angle))
}

pub(crate) fn rotation_of_selection(document: &Document) -> Option<f64> {
    figure_of_selection(document).map(|(figure, object)| rotation(&figure, &object))
}

/// A figure's kind as the Inspector names it (`figureDescriptor`'s `kind`): all text, all images, or a figure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FigureKind {
    Figure,
    Text,
    Image,
}

pub(crate) fn figure_kind(figure: &Figure) -> FigureKind {
    use styk_eval::doc::Prim;
    if !figure.segments.is_empty() && figure.segments.iter().all(|segment| segment.prim == Prim::Text) {
        FigureKind::Text
    } else if !figure.segments.is_empty() && figure.segments.iter().all(|segment| segment.prim == Prim::Image) {
        FigureKind::Image
    } else {
        FigureKind::Figure
    }
}

/// A layer of `_styk.layers`, front first as the Layer select lists them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LayerFact {
    pub id: Arc<str>,
    pub name: Arc<str>,
    pub locked: bool,
}

/// `editor.layers.filter(kind === 'layer').reverse()`: the figure layers, the front one first.
pub(crate) fn layers(records: &Value) -> Vec<LayerFact> {
    let Some(layers) = records.path(&["_styk", "layers"]) else {
        return vec![LayerFact { id: "layer-1".into(), name: "Layer 1".into(), locked: false }];
    };
    let by_id = layers.get("byId");
    let order: Vec<Arc<str>> = layers.get("order").and_then(Value::elements).map(|items| items.iter().filter_map(|id| id.as_str().map(Arc::from)).collect()).unwrap_or_default();
    order
        .into_iter()
        .rev()
        .map(|id| {
            let record = by_id.and_then(|by_id| by_id.get(&id));
            let name = record.and_then(|record| record.get("name")).and_then(Value::as_str).map(Arc::from).unwrap_or_else(|| id.clone());
            let locked = record.and_then(|record| record.get("locked")).is_some_and(Value::truthy);
            LayerFact { id, name, locked }
        })
        .collect()
}

/// `editor.layerForUid(uid)`: the layer a figure is assigned to, else the default layer.
pub(crate) fn layer_of(records: &Value, uid: u32) -> Arc<str> {
    let layers = records.path(&["_styk", "layers"]);
    let assigned = layers.and_then(|layers| layers.get("assignments")).and_then(|assignments| assignments.get(&uid.to_string())).and_then(Value::as_str);
    let default = layers.and_then(|layers| layers.get("defaultLayerId")).and_then(Value::as_str).unwrap_or("layer-1");
    Arc::from(assigned.unwrap_or(default))
}

/// `editor.activeLayerId`.
pub(crate) fn active_layer(records: &Value) -> Arc<str> {
    let layers = records.path(&["_styk", "layers"]);
    let id = layers.and_then(|layers| layers.get("activeId")).or_else(|| layers.and_then(|layers| layers.get("defaultLayerId"))).and_then(Value::as_str);
    Arc::from(id.unwrap_or("layer-1"))
}

/// The camera of the frame on show (`cameraValues`): x, y, scale, angle in radians.
pub(crate) fn camera(frame: &Value) -> [f64; 4] {
    let camera = frame.get("camera").filter(|camera| camera.is_object() && !camera.get("is_default").is_some_and(Value::truthy));
    let field = |name: &str| camera.and_then(|camera| camera.get(name)).and_then(Value::as_f64);
    [field("x").unwrap_or(0.0), field("y").unwrap_or(0.0), field("scale").unwrap_or(1.0), field("angle_rad").unwrap_or(0.0)]
}

/// `#rrggbb` of three bytes, as the Inspector's `hex`.
pub(crate) fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}
