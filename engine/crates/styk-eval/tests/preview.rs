//! Read-only in-between previews against the editor, including hidden/native rows.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use styk_eval::parity;

fn folder() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/preview") }
fn fixtures() -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(folder()).unwrap().filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".json").filter(|name| !name.ends_with(".reference") && !name.ends_with(".native.reference")).map(str::to_owned)).collect();
    names.sort(); names
}
fn reference(name: &str) -> styk_doc::Value {
    let suffix = if name.starts_with("layer-sheet") { "reference" } else { "native.reference" };
    styk_doc::json::parse(&std::fs::read(folder().join(format!("{name}.{suffix}.json"))).unwrap()).unwrap()
}
#[test]
fn inbetween_fixtures_match_every_editor_sample() {
    assert!(fixtures().len() >= 5);
    for name in fixtures() {
        let original = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let view = original.inbetween_view();
        assert!(Arc::ptr_eq(&original.doc.figures[0], &view.doc.figures[0]));
        assert!(Arc::ptr_eq(&original.doc.keyframes[0], &view.doc.keyframes[0]));
        let report = parity::compare(&original, &reference(&name));
        assert!(report.frames >= 7 && report.joints > 0);
        assert!(report.matches(), "{name}: {:?}", report.bad_frames);
    }
}
#[test]
fn preview_fixtures_fail_without_forced_sampling_and_explicit_intervals() {
    for name in ["force-linear", "legacy-force-tween"] {
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let report = parity::compare_with(&prepared, &reference(name), |frame, _| {
            let sample = frame.get("inbetween").unwrap();
            prepared.inbetween(sample.get("index").and_then(styk_doc::Value::as_f64).unwrap() as usize, sample.get("ratio").and_then(styk_doc::Value::as_f64).unwrap()).unwrap()
        });
        assert!(!report.matches(), "{name} did not expose forced interpolation");
    }
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("hidden-and-single-tick.json")).unwrap()).inbetween_view();
    let mut reference = reference("hidden-and-single-tick");
    if let styk_doc::Value::Obj(root) = &mut reference {
        if let Some(styk_doc::Value::Arr(frames)) = Arc::make_mut(root).get_mut("frames") {
            for frame in Arc::make_mut(frames) { if let styk_doc::Value::Obj(fields) = frame { Arc::make_mut(fields).remove("inbetween"); } }
        }
    }
    assert!(!parity::compare(&prepared, &reference).matches(), "ordinary playback ticks must not masquerade as explicit hidden/one-tick preview samples");
}
