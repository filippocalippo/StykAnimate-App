//! Regression of imported endpoints assigned identities in track-table order.
#[test]
fn camera_bake_preserves_document_track_order() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/camera-bake-offset-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let outcome = styk_edit::replay::replay(&reference).unwrap();
    assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{outcome:#?}");
    println!("camera-bake-offset-sheet: {} steps matched", outcome.matched);
}
