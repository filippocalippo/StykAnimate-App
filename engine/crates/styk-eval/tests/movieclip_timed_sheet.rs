use std::path::Path;
#[test]
fn planned_timed_sheet_views_match_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-timed-sheet");
    for family in ["prepare-imported", "prepare-dense", "prepare-multilayer", "prepare-locked", "prepare-noop", "channels-timing", "channels-masked", "channels-scalar-fixed", "channels-live-errors"] {
        for suffix in ["applied", "final"] {
            let name = format!("{family}-{suffix}");
            let tree = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
            let report = styk_eval::parity::compare(&prepared, &reference);
            assert!(report.matches(), "{name}: {:?}", report.bad_frames);
        }
    }
}
