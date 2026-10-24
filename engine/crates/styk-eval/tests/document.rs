//! The deepest movieclip graph the editor accepts must evaluate without truncation.
use std::path::Path;
use styk_eval::parity;

fn field<'a>(value: &'a mut styk_doc::Value, key: &str) -> &'a mut styk_doc::Value {
    let styk_doc::Value::Obj(fields) = value else { panic!("object") };
    std::sync::Arc::make_mut(fields).get_mut(key).unwrap()
}
fn first(value: &mut styk_doc::Value) -> &mut styk_doc::Value {
    let styk_doc::Value::Arr(items) = value else { panic!("array") };
    &mut std::sync::Arc::make_mut(items)[0]
}

#[test]
fn eight_nested_movieclips_match_the_editor_and_require_the_innermost_pose() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/document");
    let reference = styk_doc::json::parse(&std::fs::read(folder.join("deep-eight.native.reference.json")).unwrap()).unwrap();
    let document = styk_eval::open(&folder.join("deep-eight.json")).unwrap();
    let prepared = styk_eval::prepare(document);
    let report = parity::compare(&prepared, &reference);
    assert!(report.frames == 5 && report.primitives > 0 && report.joints > 0);
    assert!(report.matches(), "{:?}", report.bad_frames);
    let mut value = styk_doc::json::parse(&std::fs::read(folder.join("deep-eight.json")).unwrap()).unwrap();
    let mut leaf = &mut value;
    for _ in 0..8 {
        leaf = field(field(field(first(field(leaf, "figure_types")), "_styk"), "movieclip"), "document");
    }
    let pose = first(field(leaf, "keyframes"));
    let root = field(first(field(pose, "objects")), "root_x");
    *root = styk_doc::Value::Num(root.as_f64().unwrap() + 100.0);
    let mutated = styk_eval::prepare(styk_eval::from_value(&value, "mutated").unwrap());
    assert!(!parity::compare(&mutated, &reference).matches(), "the innermost pose did not affect the picture");
}

fn read(folder: &Path, name: &str) -> styk_doc::Value {
    styk_doc::json::parse(&std::fs::read(folder.join(name)).unwrap()).unwrap()
}

/// The movieclip a document nests, if any: its figure with a clip document.
fn clip_document(value: &mut styk_doc::Value) -> Option<&mut styk_doc::Value> {
    let styk_doc::Value::Arr(figures) = field(value, "figure_types") else { panic!("array") };
    let figure = std::sync::Arc::make_mut(figures).iter_mut().find(|figure| figure.path(&["_styk", "movieclip", "document"]).is_some())?;
    Some(field(field(field(figure, "_styk"), "movieclip"), "document"))
}

fn depth(value: &mut styk_doc::Value) -> usize {
    clip_document(value).map_or(0, |inner| 1 + depth(inner))
}

fn innermost(value: &mut styk_doc::Value) -> &mut styk_doc::Value {
    if clip_document(value).is_none() { return value; }
    innermost(clip_document(value).unwrap())
}

/// Nested editing builds documents the editor will not open from a file (eight levels), and the
/// interface once kept those from the engine. The editor evaluates them like any other.
#[test]
fn movieclips_nested_deeper_than_a_file_opens_match_the_editor_down_to_the_innermost_pose() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/document");
    for (name, levels) in [("deep-seventeen", 17), ("deep-twenty-four", 24)] {
        let reference = read(&folder, &format!("{name}.reference.json"));
        let mut value = read(&folder, &format!("{name}.json"));
        assert_eq!(depth(&mut value), levels, "{name} nests that many clips");
        let document = styk_eval::from_value(&value, name).unwrap();
        assert!(document.unsupported.is_empty(), "{name}: {:?}", document.unsupported);
        let prepared = styk_eval::prepare(document);
        let report = parity::compare(&prepared, &reference);
        assert!(report.frames == 5 && report.primitives > 0 && report.joints > 0, "{name}");
        assert!(report.matches(), "{name}: {:?}", report.bad_frames);
        // The pose at the bottom of the chain, in the sheet's retained poses, reaches the picture.
        let styk_doc::Value::Obj(sources) = field(field(innermost(&mut value), "_styk"), "frameSources") else { panic!("object") };
        let sources = std::sync::Arc::make_mut(sources);
        for id in sources.keys().cloned().collect::<Vec<_>>() {
            let styk_doc::Value::Arr(objects) = field(sources.get_mut(&id).unwrap(), "objects") else { panic!("array") };
            for object in std::sync::Arc::make_mut(objects).iter_mut() {
                let root = field(object, "root_x");
                *root = styk_doc::Value::Num(root.as_f64().unwrap() + 100.0);
            }
        }
        let mutated = styk_eval::prepare(styk_eval::from_value(&value, "mutated").unwrap());
        assert!(!parity::compare(&mutated, &reference).matches(), "{name}: the innermost pose did not affect the picture");
    }
}

/// A project saved with a frame draft (the Simple timeline's working frame) holds the stored pose
/// and the stored animation beside the working ones. The interface shows the working pose and the
/// stored one as onion skins, both from poses it hands the engine; nothing the engine evaluates
/// from the document reads the draft, so the editor and the engine draw the same frames.
#[test]
fn a_saved_frame_draft_changes_nothing_the_engine_evaluates() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/document");
    for (name, reference) in [("frame-draft-add", "frame-draft-add.native.reference.json"), ("frame-draft-update", "frame-draft-update.native.reference.json"), ("frame-draft-sheet", "frame-draft-sheet.reference.json")] {
        let reference = read(&folder, reference);
        let value = read(&folder, &format!("{name}.json"));
        let draft = value.path(&["_styk", "simpleFrameDraft"]).unwrap_or_else(|| panic!("{name} holds no draft"));
        assert!(draft.get("baseline").is_some() && draft.get("animationBaseline").is_some(), "{name}: the draft keeps the stored pose and animation");
        assert_eq!(value.path(&["_styk", "layerSheet"]).is_some(), name.ends_with("sheet"), "{name}");
        let document = styk_eval::from_value(&value, name).unwrap();
        assert!(document.unsupported.is_empty(), "{name}: {:?}", document.unsupported);
        let report = parity::compare(&styk_eval::prepare(document), &reference);
        assert!(report.frames == 5 && report.primitives > 0 && report.joints > 0, "{name}");
        assert!(report.matches(), "{name}: {:?}", report.bad_frames);
    }
}

/// Pivot permits an animation with no keys (the editor adds a private working pose to it). The
/// engine holds it, with no frames to play (`Generation::playable_ticks`) and no artwork to draw.
#[test]
fn an_animation_with_no_keys_loads_and_has_no_artwork() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/document");
    let document = styk_eval::from_value(&read(&folder, "empty-animation.json"), "empty").unwrap();
    assert!(document.keyframes.is_empty() && document.unsupported.is_empty());
    let assets = styk_eval::assets::Assets::build(&document);
    let prepared = styk_eval::prepare(document);
    let frame = prepared.evaluate(0.0);
    assert!(frame.objects.is_empty());
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    assert!(scene.items.is_empty());
    // What is left to draw is the scene itself.
    styk_eval::drawlist::encode(&prepared.doc, &assets, &scene);
}
