fn replay(names: &[&str]) {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in names {
        let reference = styk_doc::json::parse(
            &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
        )
        .unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(
            outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(),
            "{name}: {outcome:#?}"
        );
        println!(
            "{name}: {} / {} steps matched",
            outcome.matched, outcome.steps
        );
    }
}

#[test]
fn drawing_new_figures_on_native_frames_matches_the_editor() {
    replay(&[
        "draw-new-figure-native",
        "draw-new-figure-active-layer-native",
    ]);
}

#[test]
fn drawing_new_figures_on_the_sheet_matches_the_editor() {
    replay(&[
        "draw-new-figure-sheet",
        "draw-new-figure-locked-sheet",
        "draw-new-figure-active-layer-sheet",
    ]);
}

#[test]
fn identity_capacity_preserves_document_library_history_and_open_gestures() {
    replay(&[
        "draw-identity-capacity-native",
        "draw-identity-capacity-sheet",
    ]);
}

#[test]
fn drawing_keeps_the_open_pose_gesture_and_its_history_order() {
    replay(&[
        "draw-new-figure-live-native",
        "draw-new-figure-live-sheet",
        "draw-new-figure-live-commit-native",
        "draw-new-figure-live-commit-sheet",
        "draw-new-figure-live-unchanged-native",
        "draw-new-figure-live-unchanged-sheet",
    ]);
}

#[test]
fn drawing_into_native_channels_keys_the_layer_pose() {
    replay(&["draw-new-figure-native-channels"]);
}
