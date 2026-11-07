//! A document that holds a text figure compiled natively saves to the same bytes as one that holds the figure the
//! JavaScript compiler made from the same draft (`.styk`, `.piv`, `.stk`).
//!
//! The figures come from `styk-core`'s fixtures: the JavaScript figure is the fixture's JSON text, the native one is
//! compiled here from the same draft. Each is imported into its own edit session by `importFigure`, as the dialog's
//! Apply does, and the open document is saved three ways. Every case pins its outcome: a file that is written must
//! reopen with the text in it (and then equal the other side's bytes); a file that today's exporter refuses must be
//! refused with the same message on both sides. Refusing everything cannot pass.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_core::text::{CancelToken, CompileRequest, FontSource, TextCompiler};
use styk_doc::{json, Value};
use styk_edit::export::{export_document, FigureRequest, Format, Hold, Request};
use styk_edit::session::Session;
use styk_engine::save::{save_project, ProjectRequest};
use styk_eval::eval::Prepared;
use styk_eval::load::Loader;
use styk_formats::{files, Kind};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn fixtures() -> PathBuf {
    repo().join("engine/crates/styk-core/tests/fixtures/text")
}

fn parse(text: &str) -> Value {
    json::parse(text.as_bytes()).unwrap()
}

fn texts() -> HashMap<String, String> {
    let packed = std::fs::read(fixtures().join("texts.json.zst")).unwrap();
    let value = json::parse(&zstd::decode_all(&packed[..]).unwrap()).unwrap();
    value.as_obj().unwrap().iter().map(|(k, v)| (k.to_string(), v.as_str().unwrap().to_string())).collect()
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

fn native_figure(texts: &HashMap<String, String>, case: &str, step: usize) -> (Value, Value) {
    let cases = parse(&std::fs::read_to_string(fixtures().join("cases.json")).unwrap());
    let case = cases.get("cases").unwrap().elements().unwrap().iter().find(|c| c.get("id").and_then(Value::as_str) == Some(case)).unwrap();
    let entry = case.get("steps").unwrap().item(step).unwrap();
    let javascript = parse(&texts[entry.get("expected").and_then(Value::as_str).unwrap()]);
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

/// What today's exporter does with a case in one format.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    /// A file that reopens with the text in it.
    File,
    /// The exporter's refusal, which contains this text.
    Refused(&'static str),
}

use Outcome::{File, Refused};

const GRADIENT: &str = "pivotFilesCannotRepresentTheseGradientFills";

/// `(case, step, .piv, .stk)`.
const CASES: [(&str, usize, Outcome, Outcome); 8] = [
    ("hello-regular", 0, File, File),
    ("kerning-bolditalic", 0, File, File),
    ("lines-italic", 1, File, File),
    ("tab-bold", 0, File, File),
    ("nfc", 0, File, File),
    ("fira", 0, File, File),
    ("paint-and-style", 0, File, File),
    ("paint-and-style", 2, Refused(GRADIENT), Refused(GRADIENT)),
];

/// The texts of every text asset found anywhere in a reopened document.
fn asset_texts(value: &Value, found: &mut Vec<(String, usize)>) {
    match value {
        Value::Obj(object) => {
            for (key, child) in object.iter() {
                if &**key == "text_assets" {
                    for asset in child.elements().into_iter().flat_map(|e| e.iter()) {
                        if let Some(text) = asset.get("text").and_then(Value::as_str) {
                            found.push((text.replace("\r\n", "\n"), asset.get("glyphs").and_then(Value::array_len).unwrap_or(0)));
                        }
                    }
                } else {
                    asset_texts(child, found);
                }
            }
        }
        Value::Arr(items) => items.iter().for_each(|child| asset_texts(child, found)),
        _ => {}
    }
}

fn assert_reopens_with_text(label: &str, document: &Value, text: &str) {
    let mut found = Vec::new();
    asset_texts(document, &mut found);
    assert!(found.iter().any(|(t, glyphs)| t == text && *glyphs > 0), "{label}: no text asset {text:?} with glyphs in {found:?}");
}

#[test]
fn a_natively_compiled_text_figure_saves_to_the_bytes_of_the_javascript_one() {
    let texts = texts();
    let mut files_compared = 0;
    let mut refusals_compared = 0;
    for (case, step, piv, stk) in CASES {
        let (javascript, native) = native_figure(&texts, case, step);
        assert_eq!(json::to_string(&javascript), json::to_string(&native), "{case} {step}: the figure itself");
        let text = javascript.path(&["text_assets"]).and_then(|a| a.item(0)).and_then(|a| a.get("text").and_then(Value::as_str).map(str::to_string)).unwrap();
        let (from_javascript, from_native) = (imported(&javascript), imported(&native));

        let (a, b) = (styk(&from_javascript), styk(&from_native));
        assert!(a == b, "{case} {step}: .styk bytes differ");
        assert_reopens_with_text(&format!("{case} {step} .styk"), &files::open_document(&a, Kind::Styk).unwrap(), &text);
        files_compared += 1;

        for (format, name, kind, expected) in [(Format::Piv, ".piv", "piv", piv), (Format::Stk, ".stk", "stk", stk)] {
            let label = format!("{case} {step} {name}");
            let (a, b) = (exported(&from_javascript, format), exported(&from_native, format));
            match expected {
                File => {
                    let (a, b) = (a.unwrap_or_else(|e| panic!("{label}: refused: {e}")), b.unwrap_or_else(|e| panic!("{label}: refused natively: {e}")));
                    assert!(a == b, "{label}: bytes differ");
                    let decoded = styk_piv::decode_document(&a, &format!("text.{kind}"), &|| false).unwrap_or_else(|e| panic!("{label}: does not reopen: {e}"));
                    assert_reopens_with_text(&label, &decoded.document, &text);
                    files_compared += 1;
                }
                Refused(why) => {
                    let (a, b) = (a.expect_err(&format!("{label}: expected a refusal")), b.expect_err(&format!("{label}: expected a refusal natively")));
                    assert!(a.contains(why), "{label}: refusal {a}");
                    assert_eq!(a, b, "{label}: the two sides refuse differently");
                    refusals_compared += 1;
                }
            }
        }
    }
    assert_eq!((files_compared, refusals_compared), (22, 2));
}
