//! Private head alias controls using existing editor-recorded documents and calls.
use super::*;
use crate::{Options, Selection};
use std::path::Path;
use styk_doc::json;

fn recorded(path: &str) -> (Editor, Value) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/{path}"));
    let reference = json::parse(&std::fs::read(file).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let flag = |key| reference.path(&["editor", key]).is_some_and(Value::truthy);
    let mut editor = Editor::new(report, Options {
        property_channels: flag("propertyChannels"), layer_timeline: flag("layerTimeline"), auto_key: flag("autoKey"),
    });
    let state = first.get("state").unwrap();
    let number = |key| state.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    editor.set_view(number("tick"), number("frameIndex") as usize, Selection {
        uid: state.get("selectedUid").and_then(Value::as_f64).map(|uid| uid as u32),
        uids: state.get("selectedUids").and_then(Value::numbers).unwrap_or_default().into_iter().map(|uid| uid as u32).collect(),
        joint: state.get("selectedJoint").and_then(Value::as_f64).unwrap_or(-1.0) as i64,
    });
    editor.set_counters(number("layerRevision") as u64, number("nextFrameIdentity") as u64, number("nextUid") as u64);
    editor.set_selection_metadata(state).unwrap();
    (editor, reference)
}

fn step(editor: &mut Editor, reference: &Value, index: usize) {
    let call: Vec<_> = reference.get("steps").unwrap().item(index).unwrap().get("call").unwrap().elements().unwrap().iter().collect();
    let name = call[0].as_str().unwrap();
    let method = if name == "@batch" { name } else { name.trim_start_matches('@') };
    editor.call(method, &call[1..]).unwrap();
}

fn observable(editor: &Editor) -> (String, String, String, String) {
    (editor.report_json(), json::to_string(&editor.state_value()), json::to_string(&editor.history_value()), json::to_string(&Value::array(editor.events.clone())))
}

fn contents(head: &Arc<Vec<Entry>>) -> String { format!("{head:?}") }

#[test]
fn snapshots_share_history_and_empty_operations_leave_heads_unchanged() {
    let (mut editor, reference) = recorded("edit/move-native.reference.json");
    let snapshot = editor.snapshot();
    assert!(Arc::ptr_eq(&editor.undo, &snapshot.undo));
    assert!(Arc::ptr_eq(&editor.redo, &snapshot.redo));
    step(&mut editor, &reference, 1); // Actual select has no history write.
    editor.call("undo", &[]).unwrap();
    editor.call("redo", &[]).unwrap();
    assert!(Arc::ptr_eq(&editor.undo, &snapshot.undo));
    assert!(Arc::ptr_eq(&editor.redo, &snapshot.redo));
    step(&mut editor, &reference, 2);
    assert!(!Arc::ptr_eq(&editor.undo, &snapshot.undo));
    assert!(snapshot.undo.is_empty());
    assert!(Arc::ptr_eq(&editor.redo, &snapshot.redo), "recording does not replace or copy an already-empty redo head");
}

#[test]
fn undo_redo_and_new_branch_preserve_snapshot_entries_and_restore_observers() {
    let (mut editor, reference) = recorded("edit/move-native.reference.json");
    for index in 1..=3 { step(&mut editor, &reference, index); }
    for index in [4, 5] { // The actual undo then redo.
        let snapshot = editor.snapshot();
        let heads = (contents(&snapshot.undo), contents(&snapshot.redo));
        let before = observable(&editor);
        step(&mut editor, &reference, index);
        assert_eq!((contents(&snapshot.undo), contents(&snapshot.redo)), heads);
        editor.restore(snapshot);
        assert_eq!(observable(&editor), before);
        step(&mut editor, &reference, index);
    }
    step(&mut editor, &reference, 4);
    let snapshot = editor.snapshot();
    assert!(!snapshot.redo.is_empty());
    let heads = (contents(&snapshot.undo), contents(&snapshot.redo));
    let before = observable(&editor);
    step(&mut editor, &reference, 2); // The same recorded move starts a new branch.
    assert!(editor.redo.is_empty());
    assert!(!Arc::ptr_eq(&editor.redo, &snapshot.redo));
    assert_eq!((contents(&snapshot.undo), contents(&snapshot.redo)), heads);
    editor.restore(snapshot);
    assert_eq!(observable(&editor), before);
}

#[test]
fn trimming_detaches_the_history_head_and_keeps_the_rollback_owner() {
    let (mut editor, reference) = recorded("edit/move-native.reference.json");
    editor.configure_worker_history(HistoryLimits::default()).unwrap();
    for index in 1..=3 { step(&mut editor, &reference, index); }
    editor.configure_worker_history(HistoryLimits { count: 1, bytes: f64::INFINITY }).unwrap();
    let snapshot = editor.snapshot();
    let original = editor.report().clone();
    let before = observable(&editor);
    let heads = (contents(&snapshot.undo), contents(&snapshot.redo));
    editor.trim_worker_history().unwrap();
    assert_eq!(editor.undo.len(), 1);
    assert_eq!(snapshot.undo.len(), 2);
    assert_eq!((contents(&snapshot.undo), contents(&snapshot.redo)), heads);
    editor.restore(snapshot);
    assert!(editor.report().same_node(&original));
    assert_eq!(observable(&editor), before);
}

#[test]
fn preparing_weights_does_not_mutate_aliased_entry_metadata() {
    let (mut editor, reference) = recorded("history-readiness/warm-dense.json");
    for index in 1..=3 { step(&mut editor, &reference, index); }
    let checkpoint = reference.get("steps").unwrap().item(4).unwrap().get("call").unwrap().item(3).unwrap().as_f64().unwrap();
    let snapshot = editor.snapshot();
    let heads = (contents(&snapshot.undo), contents(&snapshot.redo));
    assert!(snapshot.undo.iter().all(|entry| entry.weight.bytes == 0.0));
    editor.prepare_worker_history(HistoryLimits::default(), checkpoint, || Ok(())).unwrap();
    assert!(editor.undo.iter().all(|entry| entry.weight.bytes > 0.0));
    assert!(!Arc::ptr_eq(&editor.undo, &snapshot.undo));
    assert!(Arc::ptr_eq(&editor.redo, &snapshot.redo));
    assert_eq!((contents(&snapshot.undo), contents(&snapshot.redo)), heads);
    editor.restore(snapshot);
    assert!(editor.undo.iter().all(|entry| entry.weight.bytes == 0.0));
    assert_eq!(editor.history_size, 0.0);
    // Readiness/settings retain their existing separate publication Heads owner;
    // ordinary Snapshot restoration has never replaced these fields.
    assert!(editor.worker_history);
}

#[test]
fn recorded_batch_revision_and_sheet_after_selection_do_not_change_prior_entries() {
    for (path, prefix, operation) in [
        ("history/native-fields-batch.json", 2, 3),
        ("edit/pinned-ik-sheet.reference.json", 3, 4),
    ] {
        let (mut editor, reference) = recorded(path);
        for index in 1..=prefix { step(&mut editor, &reference, index); }
        let snapshot = editor.snapshot();
        assert!(!snapshot.undo.is_empty());
        let heads = (contents(&snapshot.undo), contents(&snapshot.redo));
        let before = observable(&editor);
        let revision = editor.revision;
        step(&mut editor, &reference, operation);
        assert_eq!((contents(&snapshot.undo), contents(&snapshot.redo)), heads);
        let last = editor.undo.last().unwrap();
        assert_eq!(last.before_revision, revision);
        assert_eq!(last.after_selection, editor.selection_state());
        if path.contains("batch") { assert!(matches!(last.kind, CommandKind::Batch { .. })); }
        editor.restore(snapshot);
        assert_eq!(observable(&editor), before);
    }
}

#[test]
fn pruning_live_sheet_sources_preserves_imported_sources_and_current_heads() {
    let (mut editor, reference) = recorded("edit/channels-figure-sheet.reference.json");
    let imported = editor.report.path(&["_styk", "frameSources"]).unwrap().clone();
    step(&mut editor, &reference, 1);
    step(&mut editor, &reference, 2);
    assert_eq!(editor.generated_sources.len(), 1);
    let report = editor.report.clone();
    let before = observable(&editor);
    let generated = editor.generated_sources.clone();
    let counts = editor.uid_counts.clone();
    editor.prune_frame_sources();
    assert!(editor.report.same_node(&report));
    assert_eq!(observable(&editor), before);
    assert_eq!(editor.generated_sources, generated);
    assert_eq!(editor.uid_counts, counts);
    for (id, source) in imported.as_obj().unwrap().iter() {
        assert!(editor.report.path(&["_styk", "frameSources", id]).unwrap().same_node(source));
    }
}

#[test]
fn pruning_nested_redo_captures_keeps_history_sources_and_collects_a_discarded_leaf() {
    let (mut editor, reference) = recorded("edit/move-sheet.reference.json");
    for index in 1..=4 { step(&mut editor, &reference, index); }
    editor.call("undo", &[]).unwrap();
    editor.call("undo", &[]).unwrap();
    assert_eq!(editor.generated_sources.len(), 2);
    assert!(editor.undo.is_empty());
    assert_eq!(editor.redo.len(), 2);
    assert!(editor.report.path(&["_styk", "frameSources"]).is_none());
    let discarded = match &editor.redo[0].kind {
        CommandKind::LayerSheet { sources, .. } => sources[0].0.clone(),
        _ => panic!("the recorded move must capture a sheet source"),
    };
    // Wrap the actual captured commands, preserving their complete before/after
    // and source values, to exercise recursive undo/redo history retention.
    for entry in Arc::make_mut(&mut editor.redo) {
        let leaf = entry.command.clone();
        let mut inner = leaf.clone();
        inner.kind = CommandKind::Batch { commands: vec![leaf] };
        entry.command.kind = CommandKind::Batch { commands: vec![inner] };
    }
    let report = editor.report.clone();
    let before = observable(&editor);
    let generated = editor.generated_sources.clone();
    let counts = editor.uid_counts.clone();
    editor.prune_frame_sources();
    assert!(editor.report.same_node(&report));
    assert_eq!(observable(&editor), before);
    assert_eq!(editor.generated_sources, generated);
    assert_eq!(editor.uid_counts, counts);

    // Removing the farthest redo leaf makes its captured ID genuinely orphaned;
    // the remaining nested capture must still survive the full cleanup path.
    Arc::make_mut(&mut editor.redo).remove(0);
    let before = observable(&editor);
    let aliased = editor.report.clone();
    let remaining: Vec<_> = generated.into_iter().filter(|id| id != &discarded).collect();
    editor.prune_frame_sources();
    assert_eq!(editor.generated_sources, remaining);
    assert_eq!(observable(&editor), before);
    assert_eq!(editor.uid_counts, counts);
    assert!(editor.report.path(&["_styk", "frameSources"]).is_none());
    assert_eq!(editor.report_json(), styk_doc::json::to_string(&crate::record::without_runtime(&aliased)));
}
