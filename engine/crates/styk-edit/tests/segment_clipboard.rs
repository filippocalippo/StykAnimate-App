use std::path::Path;

fn recorded(name: &str) -> usize {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let outcome = styk_edit::replay::replay(&reference).unwrap();
    assert!(outcome.passed() && outcome.unported.is_none() && outcome.matched == outcome.steps,
        "{name}: {}/{} calls matched, unported {:?}; {} mismatches; first: {}",
        outcome.matched, outcome.steps, outcome.unported, outcome.mismatches.len(),
        outcome.mismatches.first().map(|s| s.chars().take(300).collect::<String>()).unwrap_or_default());
    outcome.steps
}

#[test]
fn native_segment_clipboard_distinguishes_omitted_from_explicit_null() {
    assert_eq!(recorded("segment-clipboard-native"), 31);
}

#[test]
fn sheet_segment_clipboard_distinguishes_omitted_from_explicit_null() {
    assert_eq!(recorded("segment-clipboard-sheet"), 31);
}

#[test]
fn existing_handle_segment_value_recordings_remain_exact() {
    for name in ["handle-commands-native", "handle-commands-sheet", "handle-commands-ik-sheet", "handle-commands-camera-native", "handle-commands-camera-sheet"] {
        recorded(name);
    }
}
