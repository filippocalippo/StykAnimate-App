//! The engine's load normalization (`styk_edit::load`) against the editor's (`prepareEditorLoad`), recorded from it: every project document of the
//! repository and every synthetic case must normalize to the same bytes and the same indexes, and
//! every invalid document must be refused with the editor's message key.
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use styk_doc::{Value, json};
use styk_edit::EditError;
use styk_edit::load::{Prepared, TYPE_ERROR, prepare_editor_load};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn fixtures(name: &str) -> Vec<Value> {
    let bytes = std::fs::read(repo().join("engine/tests/load").join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    let file = json::parse(&bytes).unwrap();
    file.get("cases").and_then(Value::elements).unwrap().iter().collect()
}

/// What the editor refused with, as the text `EditError::Invalid` carries.
fn expected_refusal(error: &Value) -> String {
    if let Some(key) = error.get("key").and_then(Value::as_str) {
        key.to_string()
    } else if let Some(message) = error.get("message").and_then(Value::as_str) {
        message.to_string()
    } else {
        assert_eq!(error.get("exception").and_then(Value::as_str), Some("TypeError"), "a refusal this test does not know: {error}");
        TYPE_ERROR.to_string()
    }
}

fn difference(actual: &str, expected: &str) -> String {
    let at = actual.bytes().zip(expected.bytes()).position(|(a, b)| a != b).unwrap_or(actual.len().min(expected.len()));
    let excerpt = |text: &str| String::from_utf8_lossy(&text.as_bytes()[at.saturating_sub(80)..(at + 120).min(text.len())]).into_owned();
    format!("differs at byte {at} (lengths {} / {}): rust ...{}... / editor ...{}...", actual.len(), expected.len(), excerpt(actual), excerpt(expected))
}

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn outcome(result: Result<Prepared, EditError>, expected: &Value) -> Result<(), String> {
    if let Some(error) = expected.get("error") {
        let wanted = expected_refusal(error);
        return match result {
            Err(EditError::Invalid(got)) if got == wanted => Ok(()),
            Err(other) => Err(format!("refused with {other}, the editor with {wanted}")),
            Ok(_) => Err(format!("accepted, the editor refused with {wanted}")),
        };
    }
    let prepared = match result {
        Ok(prepared) => prepared,
        Err(error) => return Err(format!("refused with {error}, the editor accepted")),
    };
    let output = expected.get("output").expect("a fixture has an output or an error");
    let indexes = json::to_string(&prepared.indexes());
    let document = json::to_string(&prepared.report);
    if let Some(stored) = output.get("document") {
        let wanted = json::to_string(stored);
        if document != wanted {
            return Err(format!("document {}", difference(&document, &wanted)));
        }
        let mut expected_indexes = styk_doc::Obj::new();
        for (key, value) in output.as_obj().unwrap().iter() {
            if &**key != "document" {
                expected_indexes.set(key, value.clone());
            }
        }
        let wanted = json::to_string(&Value::object(expected_indexes));
        if indexes != wanted {
            return Err(format!("indexes {}", difference(&indexes, &wanted)));
        }
    } else {
        let wanted_bytes = output.get("bytes").and_then(Value::as_f64).unwrap() as usize;
        if document.len() != wanted_bytes || sha256(&document) != output.get("sha256").and_then(Value::as_str).unwrap() {
            return Err(format!("document is {} bytes (sha256 {}), the editor's {} bytes (sha256 {})", document.len(), sha256(&document), wanted_bytes, output.get("sha256").unwrap()));
        }
        let wanted = json::to_string(output.get("indexes").unwrap());
        if indexes != wanted {
            return Err(format!("indexes {}", difference(&indexes, &wanted)));
        }
    }
    Ok(())
}

fn run(cases: Vec<Value>, label: impl Fn(&Value) -> String, input: impl Fn(&Value) -> Value) {
    let mut failures = Vec::new();
    let total = cases.len();
    for case in &cases {
        let result = prepare_editor_load(input(case));
        if let Err(why) = outcome(result, case) {
            failures.push(format!("{}: {why}", label(case)));
        }
    }
    if !failures.is_empty() {
        let shown: Vec<&String> = failures.iter().take(25).collect();
        panic!("{} of {total} load cases differ from the editor:\n{}", failures.len(), shown.iter().map(|f| f.as_str()).collect::<Vec<_>>().join("\n"));
    }
}

#[test]
fn repository_documents_load_as_the_editor_loads_them() {
    run(
        fixtures("repository.json"),
        |case| case.get("source").and_then(Value::as_str).unwrap().to_string(),
        |case| {
            let bytes = std::fs::read(repo().join(case.get("source").and_then(Value::as_str).unwrap())).unwrap();
            let file = json::parse(&bytes).unwrap();
            match case.get("field").and_then(Value::as_str) {
                Some(field) => json::parse(file.get(field).and_then(Value::as_str).unwrap().as_bytes()).unwrap(),
                None => file,
            }
        },
    );
}

#[test]
fn synthetic_documents_load_as_the_editor_loads_them() {
    run(fixtures("cases.json"), |case| case.get("name").and_then(Value::as_str).unwrap().to_string(), |case| case.get("input").unwrap().clone());
}
