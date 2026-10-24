use std::path::Path;
#[test]
fn timed_sheet_command_views_match_editor() {
    let folder =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-timed-sheet-commands");
    for family in [
        "playback-imported",
        "playback-authored",
        "place-imported",
        "place-authored",
        "split-imported",
        "split-authored-layer",
        "timing-live-errors",
        "timing-membership-gap",
        "timing-hidden-authored",
        "timing-live-accepted",
        "timing-locked",
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
