//! Effect paints, presets and attached scopes run to completion against the editor's
//! recordings; observable bytes, returns, events, selection and history match every step.

#[test]
fn effect_paints_presets_and_scopes_match_the_editor() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["vfx-presets-sheet", "vfx-paints-sheet", "vfx-scopes-sheet", "vfx-clip-presets-sheet", "vfx-user-presets-sheet", "vfx-clip-paints-sheet", "vfx-scopes-depth-sheet",
        "vfx-clip-presets-native", "vfx-user-presets-native", "vfx-clip-paints-native", "vfx-paint-interpolation-sheet", "vfx-paint-interpolation-native"] {
        let bytes = std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap();
        let reference = styk_doc::json::parse(&bytes).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, outcome.unported), (outcome.steps, None), "{name}");
    }
}
