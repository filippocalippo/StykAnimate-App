//! A document that holds a text figure compiled natively saves to the same bytes as one that holds the figure the
//! JavaScript compiler made from the same draft (`.styk`, `.piv`, `.stk`).
//!
//! The figures come from `styk-core`'s fixtures: the JavaScript figure is the fixture's JSON text, the native one is
//! compiled here from the same draft. Each is imported into its own edit session by `importFigure`, as the dialog's
//! Apply does, and the open document is saved three ways.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_core::text::{CancelToken, CompileRequest, FontSource, TextCompiler};
use styk_doc::{json, Value};
use styk_edit::export::{export_document, FigureRequest, Format, Hold, Request};
use styk_edit::session::Session;
use styk_engine::save::{save_project, ProjectRequest};
use styk_eval::eval::Prepared;
use styk_eval::load::Loader;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn fixtures() -> PathBuf {
    repo().join("engine/crates/styk-core/tests/fixtures/text")
}

fn parse(text: &str) -> Value {
    json::parse(text.as_bytes()).unwrap()
}

/// A session over the document the `startup-sheet` tape starts from.
fn session() -> Session {
    let reference = parse(&std::fs::read_to_string(repo().join("engine/tests/edit/startup-sheet.reference.json")).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() {
        state.set(key, value.clone());
    }
    let document = parse(steps[0].get("document").unwrap().as_str().unwrap());
    Session::start(document, &json::to_string(&Value::object(state))).unwrap()
}

fn imported(figure: &Value) -> Value {
    let mut session = session();
    let answer = parse(&session.call("importFigure", &json::to_string(&Value::array(vec![figure.clone()])), "null"));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer}");
    session.report().clone()
}

fn styk(tree: &Value) -> Vec<u8> {
    save_project(std::slice::from_ref(tree), &[], ProjectRequest { name: Some("Text".into()), original_first: false, reservation: None }, &|| false)
        .unwrap()
        .bytes
}

fn exported(tree: &Value, format: Format) -> Result<Vec<u8>, String> {
    let mut loader = Loader::new();
    let document = loader.document(tree, "").map_err(|e| format!("{e:?}"))?;
    let prepared = Arc::new(Prepared::new(Arc::new(document)));
    let request = Request {
        format,
        name: Some("Text".into()),
        figure: FigureRequest { figure_type_id: Some(2.0), figure_uid: None, figure_uids: Vec::new(), tick: 0.0 },
    };
    let out = export_document(tree, &loader, &prepared, &request, &Hold { cancel: &|| false }).map_err(|e| format!("{e:?}"))?;
    match format {
        Format::Piv => styk_piv::encode_piv(&out.document, None, &|| false),
        _ => styk_piv::encode_stk(&out.document, out.figure_type_id, &|| false),
    }
    .map_err(|e| e.to_string())
}

fn native_figure(case: &str, step: usize) -> (Value, Value) {
    let cases = parse(&std::fs::read_to_string(fixtures().join("cases.json")).unwrap());
    let case = cases.get("cases").unwrap().elements().unwrap().iter().find(|c| c.get("id").and_then(Value::as_str) == Some(case)).unwrap();
    let entry = case.get("steps").unwrap().item(step).unwrap();
    let javascript = parse(&std::fs::read_to_string(fixtures().join(entry.get("expected").and_then(Value::as_str).unwrap())).unwrap());
    let spec = case.get("font").and_then(Value::as_str).unwrap();
    let mut compiler = TextCompiler::new(Arc::new(|style| {
        let name = ["Regular", "Bold", "Italic", "BoldItalic"][style];
        std::fs::read(repo().join(format!("vendor/text/NotoSans-{name}.ttf"))).ok().map(|b| Arc::from(b.into_boxed_slice()))
    }));
    let font = if spec.starts_with("noto:") {
        FontSource::Bundled
    } else {
        let path = spec.strip_prefix("file:").unwrap_or_else(|| panic!("{spec}"));
        FontSource::Loaded(compiler.load_font(std::fs::read(repo().join(path)).unwrap(), path).unwrap().id)
    };
    let native = compiler
        .compile(&CompileRequest { revision: 0, font, options: entry.get("options").unwrap().clone() }, &CancelToken::new())
        .unwrap();
    (javascript, native)
}

#[test]
fn a_natively_compiled_text_figure_saves_to_the_bytes_of_the_javascript_one() {
    let mut compared = 0;
    for (case, step) in [("hello-regular", 0), ("kerning-bolditalic", 0), ("lines-italic", 1), ("tab-bold", 0), ("nfc", 0), ("fira", 0), ("paint-and-style", 0), ("paint-and-style", 2)] {
        let (javascript, native) = native_figure(case, step);
        assert_eq!(json::to_string(&javascript), json::to_string(&native), "{case} {step}: the figure itself");
        let (from_javascript, from_native) = (imported(&javascript), imported(&native));
        assert!(styk(&from_javascript) == styk(&from_native), "{case} {step}: .styk");
        for (format, name) in [(Format::Piv, ".piv"), (Format::Stk, ".stk")] {
            let (a, b) = (exported(&from_javascript, format), exported(&from_native, format));
            assert!(a == b, "{case} {step}: {name}");
            if let Ok(bytes) = &a {
                assert!(bytes.len() > 100, "{case} {step}: {name} is a real file");
            }
            compared += 1;
        }
    }
    assert_eq!(compared, 16);
}
