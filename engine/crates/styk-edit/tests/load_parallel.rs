//! Loading with the checks side by side gives the load that loading in order gives: the same document, and for a damaged one the
//! same refusal, whichever frame the damage is in. Every value of some real documents is replaced in turn by values of the
//! wrong kind (as `load_robust` does) and each copy is loaded both ways.
use std::path::Path;

use styk_doc::fanout::StdThreads;
use styk_doc::{Value, json};
use styk_edit::load::{prepare_for_editor, prepare_for_editor_with};

use crate::damage;
use damage::{paths, read, replace, wrong_values};

/// The outcome of a load as something comparable: the document and its indexes as JSON text, or the refusal's text.
fn outcome(result: Result<styk_edit::load::Prepared, styk_edit::EditError>) -> Result<String, String> {
    result.map(|prepared| json::to_string(&prepared.report) + &json::to_string(&prepared.indexes())).map_err(|error| error.to_string())
}

fn both_ways(name: &str, document: Value) -> Result<String, String> {
    let in_order = outcome(prepare_for_editor(document.clone(), true));
    for threads in [2, 5] {
        let beside = outcome(prepare_for_editor_with(document.clone(), true, &StdThreads(threads)));
        assert_eq!(in_order, beside, "{name}: {threads} threads load another document or refuse another way");
    }
    in_order
}

fn run(name: &str, document: &Value, stride: usize) {
    let mut all = Vec::new();
    paths(document, &mut Vec::new(), &mut all);
    let (mut loaded, mut refused) = (0usize, 0usize);
    assert!(both_ways(name, document.clone()).is_ok(), "{name}: the undamaged document loads");
    for at in all.iter().skip(1).step_by(stride) {
        for with in wrong_values().into_iter().map(Some).chain(std::iter::once(None)) {
            let Some(damaged) = replace(document, at, with.clone()) else { continue };
            match both_ways(&format!("{name} at {at:?} with {}", with.as_ref().map_or("the value removed".into(), json::to_string)), damaged) {
                Ok(_) => loaded += 1,
                Err(_) => refused += 1,
            }
        }
    }
    eprintln!("{name}: {} values, {refused} refused, {loaded} loaded", all.len());
    assert!(refused > 0, "{name}: no damaged copy was refused ({loaded} loaded)");
}

#[test]
fn a_damaged_startup_document_loads_and_is_refused_the_same_with_the_checks_side_by_side() {
    run("startup", &read("engine/tests/edit/startup.document.json"), 1);
}

#[test]
fn a_damaged_document_with_many_frames_is_refused_the_same_with_the_checks_side_by_side() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut names: Vec<String> = std::fs::read_dir(directory).unwrap().filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.ends_with(".document.json")).collect();
    names.sort();
    // The documents that have the most frames, where cutting them gives several pieces; a coarse grain of damage: the whole set would take minutes.
    let mut by_frames: Vec<(usize, String)> = names.into_iter().map(|name| (read(&format!("engine/tests/edit/{name}")).get("keyframes").and_then(Value::array_len).unwrap_or(0), name)).collect();
    by_frames.sort_by(|a, b| b.cmp(a));
    for (frames, name) in by_frames.into_iter().take(6) {
        assert!(frames >= 2, "{name} has frames to cut");
        run(&name, &read(&format!("engine/tests/edit/{name}")), 29);
    }
}
