use std::path::Path;
#[test]
fn native_movieclip_extension_matches_every_editor_step() {
    let folder =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-native-extension");
    for name in [
        "extend-imported",
        "extend-presence",
        "extend-hidden",
        "extend-layer2",
        "extend-noop",
        "extend-locked",
        "extend-live-errors",
        "extend-continuations",
        "extend-joined",
        "extend-joined-live",
    ] {
        let reference = styk_doc::json::parse(
            &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
        )
        .unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!(
            (outcome.matched, &outcome.unported),
            (outcome.steps, &None),
            "{name}"
        );
    }
}
