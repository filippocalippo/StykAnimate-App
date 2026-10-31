//! Origin-bearing records remain byte-identical to the editor at keys, fractional tweens and
//! property previews. These fixtures use the editor's Set Origin and construction edits.

use std::path::{Path, PathBuf};

use styk_doc::Value;
use styk_eval::records::Records;

fn fixtures() -> Vec<PathBuf> {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/records");
    let mut paths: Vec<_> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            name.starts_with("origin-") || name.starts_with("channels-origin") || name.starts_with("entries-origin-")
        })
        .collect();
    paths.sort();
    assert!(paths.len() >= 15, "{} origin record fixtures", paths.len());
    paths
}

fn parse(path: &Path, name: &str) -> Value {
    styk_doc::json::parse(&std::fs::read(path.join(name)).unwrap()).unwrap()
}

#[test]
fn origin_records_match_keys_tweens_and_property_previews() {
    let mut fractional = 0;
    for path in fixtures() {
        let (tree, reference) = (parse(&path, "report.json"), parse(&path, "records.json"));
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let records = Records::new(&tree, &prepared).unwrap();
        for entry in reference.get("ticks").unwrap().elements().unwrap().iter() {
            let tick = entry.get("tick").unwrap().as_f64().unwrap();
            fractional += usize::from(tick.fract() != 0.0);
            let got = styk_doc::json::to_string(&records.recorded(&entry).unwrap());
            let want = entry.get("json").unwrap().as_str().unwrap();
            assert_eq!(got, want, "{} tick {tick}", path.display());
        }
    }
    assert!(fractional >= 100, "{fractional} fractional ticks");
}

#[test]
fn origin_fixtures_need_their_pivots_and_support() {
    for path in fixtures().into_iter().filter(|path| path.file_name().unwrap().to_string_lossy().starts_with("origin-")) {
        let (mut tree, reference) = (parse(&path, "report.json"), parse(&path, "records.json"));
        for figure in tree.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap() {
            if let Some(styk) = figure.make_obj().unwrap().get_mut("_styk").and_then(Value::make_obj) {
                styk.remove("animationOrigin");
            }
        }
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let records = Records::new(&tree, &prepared).unwrap();
        let differs = reference.get("ticks").unwrap().elements().unwrap().iter().any(|entry| {
            styk_doc::json::to_string(&records.recorded(&entry).unwrap()) != entry.get("json").unwrap().as_str().unwrap()
        });
        assert!(differs, "{} matches without animation origins", path.display());
    }
}

#[test]
fn origin_property_values_match_the_editor() {
    let mut checked = 0;
    for path in fixtures() {
        let (tree, reference, properties) = (parse(&path, "report.json"), parse(&path, "records.json"), parse(&path, "properties.json"));
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let records = Records::new(&tree, &prepared).unwrap();
        let ticks = properties.get("ticks").unwrap().elements().unwrap();
        for (entry, properties) in reference.get("ticks").unwrap().elements().unwrap().iter().zip(ticks.iter()) {
            assert_eq!(entry.get("tick"), properties.get("tick"));
            let frame = records.recorded(&entry).unwrap();
            for value in properties.get("values").unwrap().elements().unwrap().iter() {
                let property = value.get("property").unwrap().as_str().unwrap();
                let got = records.property_value(&frame, value.get("target").unwrap(), property).unwrap().unwrap();
                assert_eq!(styk_doc::json::to_string(&got), styk_doc::json::to_string(value.get("value").unwrap()),
                    "{} tick {:?} property {property}", path.display(), entry.get("tick"));
                checked += 1;
            }
        }
    }
    assert!(checked >= 1000, "{checked} property values compared");
}

#[test]
fn exact_key_correction_preserves_mixed_poses_unknown_metadata_and_styles() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/records/origin-origin-support");
    let mut tree = parse(&folder, "report.json");
    let styk = tree.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap();
    styk.remove("layerSheet");
    styk.remove("animation");
    let objects = tree.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
    let origin_pose = objects[0].make_obj().unwrap();
    let origin = origin_pose.get_mut("_stykAnimationOrigin").unwrap().make_obj().unwrap();
    origin.set("future", Value::str("preserved pivot field"));
    if let Some(ghosts) = origin.get_mut("ghosts").and_then(Value::make_obj) {
        let first = ghosts.keys().next().unwrap().to_string();
        ghosts.get_mut(&first).unwrap().make_obj().unwrap().set("future", Value::str("preserved ghost field"));
    }
    // Style resolution produces a drawing variant; origin arithmetic uses the base figure.
    origin_pose.set("_stykStyle", styk_doc::json::parse(br#"{"segments":{"22":{"thickness":29,"opacity":0.4}}}"#).unwrap());
    objects[1].make_obj().unwrap().set("future", Value::str("untouched ordinary pose"));
    let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
    assert!(prepared.doc.keyframes[0].objects[0].figure_override.is_some(), "the style must produce a drawing variant");
    let expected = Records::new(&tree, &prepared).unwrap().evaluated(0.0).unwrap();
    let objects = tree.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
    let origin_pose = objects[0].make_obj().unwrap();
    for (field, delta) in [("root_x", 37.0), ("root_y", -19.0)] {
        let before = origin_pose.get(field).unwrap().as_f64().unwrap();
        origin_pose.set(field, Value::Num(before + delta));
    }
    let untouched = objects[1].clone();
    let retained_origin = objects[0].get("_stykAnimationOrigin").unwrap().clone();
    let before = styk_doc::json::to_string(&tree);
    let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
    let corrected = Records::new(&tree, &prepared).unwrap().evaluated(0.0).unwrap();
    assert_eq!(styk_doc::json::to_string(&corrected), styk_doc::json::to_string(&expected));
    assert_eq!(styk_doc::json::to_string(&tree), before, "evaluation must not mutate its source records");
    let objects = corrected.get("objects").unwrap();
    assert!(objects.item(1).unwrap().same_node(&untouched), "unrelated poses keep their record identity");
    assert!(objects.item(0).unwrap().get("_stykAnimationOrigin").unwrap().same_node(&retained_origin), "root correction keeps unknown pivot and ghost metadata");
}
