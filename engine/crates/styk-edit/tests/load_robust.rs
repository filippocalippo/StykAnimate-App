//! A damaged document is refused, never a panic: the load runs inside WebAssembly, where a panic aborts the
//! page. Every value of some real documents is replaced in turn by values of the wrong kind, and each
//! result is loaded.
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use styk_doc::{Value, json};
use styk_edit::load::prepare_for_editor;

mod damage;
use damage::{paths, read, replace, wrong_values};

fn run(name: &str, document: &Value, stride: usize) {
    let mut all = Vec::new();
    paths(document, &mut Vec::new(), &mut all);
    let mut loaded = 0usize;
    let mut refused = 0usize;
    for at in all.iter().skip(1).step_by(stride) {
        let wrong = wrong_values().into_iter().map(Some).chain(std::iter::once(None));
        for with in wrong {
            let Some(damaged) = replace(document, at, with.clone()) else { continue };
            let outcome = catch_unwind(AssertUnwindSafe(|| prepare_for_editor(damaged, true).is_ok()));
            match outcome {
                Ok(true) => loaded += 1,
                Ok(false) => refused += 1,
                Err(_) => panic!("{name}: loading panicked with {} at {at:?}", with.as_ref().map_or("the value removed".into(), json::to_string)),
            }
        }
    }
    eprintln!("{name}: {} values, {refused} refused, {loaded} loaded", all.len());
    assert!(refused > 0, "{name}: no damaged copy was refused ({loaded} loaded)");
}

#[test]
fn a_damaged_startup_document_is_refused_not_a_panic() {
    run("startup", &read("engine/tests/edit/startup.document.json"), 1);
}

#[test]
fn a_damaged_document_with_effects_movieclips_and_animation_is_refused_not_a_panic() {
    let names = std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit")).unwrap().filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.ends_with(".document.json")).collect::<Vec<_>>();
    let mut names = names;
    names.sort();
    // Every few documents, each at a coarse grain: the whole set would take minutes.
    for name in names.iter().step_by(23) {
        run(name, &read(&format!("engine/tests/edit/{name}")), 17);
    }
}
