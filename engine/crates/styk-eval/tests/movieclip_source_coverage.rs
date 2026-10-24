use std::path::Path;
use styk_doc::Value;
use styk_eval::{parity, records::Records};
fn parse(path: &Path) -> Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn remove_sources(tree: &mut Value) {
    if let Some(styk) = tree.make_obj().and_then(|o| o.get_mut("_styk")).and_then(Value::make_obj) {
        styk.remove("movieclipSource");
    }
    if let Some(figures) = tree.make_obj().and_then(|o| o.get_mut("figure_types")).and_then(Value::make_arr) {
        for figure in figures {
            if let Some(document) =
                figure.make_obj().and_then(|o| o.get_mut("_styk")).and_then(Value::make_obj).and_then(|s| s.get_mut("movieclip")).and_then(Value::make_obj).and_then(|c| c.get_mut("document"))
            {
                remove_sources(document);
            }
        }
    }
}
#[test]
fn retained_sources_keep_effects_clocks_channels_and_camera_contracts() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-source-coverage");
    let mut failures = Vec::new();
    for name in [
        "effects-inherited",
        "effects-recursive-crop",
        "effects-partial-authoring",
        "effects-empty-local",
        "effects-local-override",
        "presence-gap",
        "timed-restarts",
        "channels-figure",
        "channels-pose",
        "channels-pose-joined-uid2",
        "channels-pose-joined-uid3",
        "channels-follow",
    ] {
        let tree = parse(&folder.join(format!("{name}.records/report.json")));
        let reference = parse(&folder.join(format!("{name}.records/records.json")));
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let records = Records::new(&tree, &prepared).unwrap();
        for entry in reference.get("ticks").unwrap().elements().unwrap().iter() {
            let got = styk_doc::json::to_string(&records.recorded(&entry).unwrap());
            let want = entry.get("json").unwrap().as_str().unwrap();
            if got != want {
                failures.push(format!("{name} records tick {:?}: got {got}, want {want}", entry.get("tick")));
                break;
            }
        }
        let samples = parse(&folder.join(format!("{name}.samples.json")));
        for sample in samples.elements().unwrap().iter() {
            let pair = sample.elements().unwrap().iter().collect::<Vec<_>>();
            let tick = pair[0].as_f64().unwrap();
            let frame = prepared.evaluate_clip(tick);
            if prepared.doc.vfx_clips.is_none() && frame.retained_vfx_tick.map(Value::Num).unwrap_or(Value::Null) != pair[2] {
                failures.push(format!("{name} inherited effect clock at {tick}: got {:?}, want {:?}", frame.retained_vfx_tick, pair[2]));
            }
            let got = Value::array(
                frame
                    .objects
                    .iter()
                    .filter_map(|o| prepared.doc.figure(o.figure)?.movieclip.as_ref().map(|_| Value::array(vec![Value::Num(o.uid as f64), o.clip_time.map(Value::Num).unwrap_or(Value::Null)])))
                    .collect(),
            );
            if got != pair[1] {
                failures.push(format!("{name} clip times at {tick}: got {got:?}, want {:?}", pair[1]));
                break;
            }
        }
        for (file, reference_file) in [
            (name.to_string(), format!("{name}.native.reference.json")),
            (format!("{name}-app"), format!("{name}-app.reference.json")),
            (format!("{name}-host"), format!("{name}-host.reference.json")),
        ] {
            let tree = parse(&folder.join(format!("{file}.json")));
            let reference = parse(&folder.join(reference_file));
            let document = styk_eval::from_value(&tree, "").unwrap();
            let report = parity::compare(&styk_eval::prepare(document), &reference);
            if !report.matches() {
                failures.push(format!("{file} parity: {:?}", report.bad_frames));
            }
            if file == "effects-partial-authoring" {
                // Authored figure poses materialize the curve; the merged sheet
                // still inherits the saved template clock for its source effects.
                let mut mutant = tree.clone();
                for key in mutant.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap() {
                    key.make_obj().unwrap().remove("_vfxTimelineTick");
                }
                let mutant = parity::compare(&styk_eval::prepare(styk_eval::from_value(&mutant, "").unwrap()), &reference);
                if mutant.matches() {
                    failures.push(format!("{file} template-clock-removal mutant matched"));
                }
            }
            if file.ends_with("-host") && name != "effects-partial-authoring" {
                let mut mutant = tree.clone();
                remove_sources(&mut mutant);
                let mutant = parity::compare(&styk_eval::prepare(styk_eval::from_value(&mutant, "").unwrap()), &reference);
                if mutant.matches() {
                    failures.push(format!("{file} source-removal mutant matched"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
