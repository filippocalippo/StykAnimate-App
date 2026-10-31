use std::path::Path;
const PORTED: &[&str] = &[
    "clip-empty-native",
    "clip-empty-sheet",
    "clip-create-definition-native",
    "clip-create-definition-sheet",
    "clip-create-loose-sheet",
    "clip-create-joined-sheet",
    "clip-unique-sheet",
    "clip-break-sheet",
    "clip-create-multilayer-sheet",
    "clip-create-locked-sheet",
    "clip-create-errors-sheet",
    "clip-break-joined-sheet",
    "clip-break-flip-sheet",
    "clip-break-nested-sheet",
];
#[test]
fn movieclip_recordings_match_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in PORTED {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
    }
}
