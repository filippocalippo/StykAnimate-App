//! The stored form of pose channels in a figure file (src/pose-sequence-storage.mjs, the reader): the keys of a `pose`
//! channel are a list of poses, and channels that share one list store it once in `poseSequences` and refer to it with
//! `{sequence}`. A list is shared when it is the same node of the document, as the session builds them (a figure group's
//! channels all point at one list), so a movieclip of many figures does not carry its poses once per figure.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::{Obj, Value};

use super::{items, set};

/// Which node a container value is, for sharing: containers that are not one (a missing list) all count as one.
fn node(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Arr(items)) => Arc::as_ptr(items) as *const () as usize,
        Some(Value::Nums(numbers)) => Arc::as_ptr(numbers) as *const () as usize,
        Some(Value::Obj(object)) => Arc::as_ptr(object) as *const () as usize,
        _ => 0,
    }
}

fn object(value: Option<&Value>) -> Obj {
    value.and_then(Value::as_obj).cloned().unwrap_or_default()
}

/// An animation with its pose channels' lists stored once each; one without pose channels as it is.
fn pack_animation(animation: &Value) -> Value {
    let Some(channels) = animation.get("channels").filter(|channels| channels.truthy()) else { return animation.clone() };
    let mut ids: HashMap<usize, usize> = HashMap::new();
    let mut sequences: Vec<Value> = Vec::new();
    let channels: Vec<Value> = items(Some(channels))
        .into_iter()
        .map(|channel| {
            if channel.get("property").and_then(Value::as_str) != Some("pose") {
                return channel;
            }
            let keys = channel.get("keys");
            let sequence = *ids.entry(node(keys)).or_insert_with(|| {
                sequences.push(keys.cloned().unwrap_or(Value::Null));
                sequences.len() - 1
            });
            let mut packed = channel.clone();
            set(&mut packed, "keys", Value::object({
                let mut reference = Obj::new();
                reference.set("sequence", Value::Num(sequence as f64));
                reference
            }));
            packed
        })
        .collect();
    if sequences.is_empty() {
        return animation.clone();
    }
    let mut packed = animation.clone();
    set(&mut packed, "version", Value::Num(2.0));
    set(&mut packed, "poseSequences", Value::array(sequences));
    set(&mut packed, "channels", Value::array(channels));
    packed
}

/// `document` with the pose channels of its animation, of the baseline of a working frame, of the movieclip documents of its figures
/// and of the original a movieclip was made from in their stored form. A document shared by several figures is packed once.
pub(crate) fn pack_pose_sequences(document: &Value) -> Value {
    pack_document(document, &mut HashMap::new())
}

fn pack_document(document: &Value, done: &mut HashMap<usize, Value>) -> Value {
    let id = node(Some(document));
    if let Some(packed) = done.get(&id).filter(|_| id != 0) {
        return packed.clone();
    }
    let mut result = document.as_obj().cloned().unwrap_or_default();
    let mut styk = object(document.get("_styk"));
    if let Some(animation) = styk.get("animation").filter(|animation| animation.truthy()) {
        let packed = pack_animation(animation);
        styk.set("animation", packed);
    }
    if let Some(draft) = styk.get("simpleFrameDraft").filter(|draft| draft.get("animationBaseline").is_some_and(Value::truthy)) {
        let mut next = draft.clone();
        set(&mut next, "animationBaseline", pack_animation(draft.get("animationBaseline").expect("checked above")));
        styk.set("simpleFrameDraft", next);
    }
    if let Some(source) = styk.get("movieclipSource").filter(|source| source.get("document").is_some_and(|inner| inner.as_obj().is_some())) {
        let mut next = source.clone();
        set(&mut next, "document", pack_document(source.get("document").expect("checked above"), done));
        styk.set("movieclipSource", next);
    }
    result.set("_styk", Value::object(styk));
    if document.get("figure_types").is_some_and(|figures| figures.elements().is_some()) {
        let figures: Vec<Value> = items(document.get("figure_types"))
            .into_iter()
            .map(|figure| {
                let Some(clip) = figure.path(&["_styk", "movieclip"]).filter(|clip| clip.truthy()) else { return figure };
                let Some(inner) = clip.get("document").filter(|inner| inner.as_obj().is_some()) else { return figure };
                let mut packed_clip = clip.clone();
                set(&mut packed_clip, "document", pack_document(inner, done));
                let mut styk = object(figure.get("_styk"));
                styk.set("movieclip", packed_clip);
                let mut packed = figure.clone();
                set(&mut packed, "_styk", Value::object(styk));
                packed
            })
            .collect();
        result.set("figure_types", Value::array(figures));
    }
    let packed = Value::object(result);
    if id != 0 {
        done.insert(id, packed.clone());
    }
    packed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        styk_doc::json::parse(text.as_bytes()).unwrap()
    }

    fn channel(keys: &Value, property: &str) -> Value {
        let mut channel = Obj::new();
        channel.set("property", Value::str(property));
        channel.set("keys", keys.clone());
        Value::object(channel)
    }

    #[test]
    fn channels_that_share_a_list_of_poses_store_it_once() {
        let shared = parse(r#"[{"id":"a","tick":0},{"id":"b","tick":4}]"#);
        let other = parse(r#"[{"id":"c","tick":0}]"#);
        let same_content = parse(r#"[{"id":"a","tick":0},{"id":"b","tick":4}]"#);
        let mut animation = Obj::new();
        animation.set("version", Value::Num(1.0));
        animation.set("channels", Value::array(vec![
            channel(&shared, "pose"), channel(&shared, "pose"), channel(&other, "pose"), channel(&same_content, "pose"), channel(&shared, "x"),
        ]));
        let mut styk = Obj::new();
        styk.set("animation", Value::object(animation));
        let mut document = Obj::new();
        document.set("_styk", Value::object(styk));
        let packed = pack_pose_sequences(&Value::object(document));
        let animation = packed.path(&["_styk", "animation"]).unwrap();
        assert_eq!(animation.get("version").and_then(Value::as_f64), Some(2.0));
        let sequences = items(animation.get("poseSequences"));
        assert_eq!(sequences.len(), 3, "a list is shared by being the same node, not by what it holds");
        let references: Vec<Option<f64>> = items(animation.get("channels")).iter().map(|channel| channel.path(&["keys", "sequence"]).and_then(Value::as_f64)).collect();
        assert_eq!(references, vec![Some(0.0), Some(0.0), Some(1.0), Some(2.0), None]);
        assert!(items(animation.get("channels"))[4].get("keys").is_some_and(|keys| keys.same_node(&shared)), "other properties keep their keys");
    }

    #[test]
    fn a_document_without_pose_channels_is_not_changed_and_clip_documents_are_packed() {
        let plain = parse(r#"{"_styk":{"animation":{"version":1,"channels":[{"property":"x","keys":[]}]}}}"#);
        assert_eq!(styk_doc::json::to_string(&pack_pose_sequences(&plain)), styk_doc::json::to_string(&plain));
        let keys = parse(r#"[{"id":"a","tick":0}]"#);
        let mut animation = Obj::new();
        animation.set("channels", Value::array(vec![channel(&keys, "pose")]));
        let mut styk = Obj::new();
        styk.set("animation", Value::object(animation));
        let mut inner = Obj::new();
        inner.set("_styk", Value::object(styk));
        let mut clip = Obj::new();
        clip.set("document", Value::object(inner));
        let mut figure_styk = Obj::new();
        figure_styk.set("movieclip", Value::object(clip));
        let mut figure = Obj::new();
        figure.set("_styk", Value::object(figure_styk));
        let mut document = Obj::new();
        document.set("figure_types", Value::array(vec![Value::object(figure)]));
        let packed = pack_pose_sequences(&Value::object(document));
        let animation = packed.path(&["figure_types"]).and_then(|figures| figures.item(0)).and_then(|figure| figure.path(&["_styk", "movieclip", "document", "_styk", "animation"]).cloned()).unwrap();
        assert_eq!(animation.get("version").and_then(Value::as_f64), Some(2.0));
        assert_eq!(items(animation.get("poseSequences")).len(), 1);
    }
}
