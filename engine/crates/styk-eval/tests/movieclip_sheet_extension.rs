use std::path::Path;
#[test]
fn extended_sheet_views_match_editor() {
    let folder =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-sheet-extension");
    for family in [
        "extend-imported",
        "extend-presence",
        "extend-authored",
        "extend-layer2",
        "extend-noop",
        "extend-locked",
        "extend-live-errors",
        "extend-continuations",
    ] {
        for suffix in ["applied", "final"] {
            let name = format!("{family}-{suffix}");
            let tree =
                styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap())
                    .unwrap();
            let reference = styk_doc::json::parse(
                &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
            )
            .unwrap();
            let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
            assert!(
                prepared.doc.unsupported.is_empty(),
                "{name}: {:?}",
                prepared.doc.unsupported
            );
            let report = styk_eval::parity::compare(&prepared, &reference);
            assert!(report.matches(), "{name}: {:?}", report.bad_frames);
        }
    }
}
