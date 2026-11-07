//! The Rust text compiler against fixtures generated from `src/text-authoring.mjs` and `src/native-text-authoring.mjs`
//! (`tests/fixtures/text/generate.mjs`): the figure's JSON text must be identical, which makes every command, every
//! float32 coordinate, placement and bound identical, and the error of every refused draft the same message.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use styk_core::text::{
    compile_embedded_text_figure, read_text_figure_options, CancelToken, CompileRequest, Font,
    FontSource, TextCompiler, TextError,
};
use styk_doc::{json, Obj, Value};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/text")
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn read_json(path: &Path) -> Value {
    json::parse(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("fixture JSON")
}

/// The texts of a fixture folder (`texts.json.zst`: zstd-compressed JSON `{name: text}`).
struct Texts(std::collections::HashMap<String, String>);

fn texts(dir: &Path) -> Texts {
    let packed = std::fs::read(dir.join("texts.json.zst")).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    let raw = zstd::decode_all(&packed[..]).expect("texts.json.zst is zstd");
    let value = json::parse(&raw).expect("texts.json.zst holds JSON");
    Texts(value.as_obj().expect("an object of texts").iter().map(|(k, v)| (k.to_string(), v.as_str().expect("a text").to_string())).collect())
}

impl Texts {
    fn get(&self, name: &str) -> &str {
        self.0.get(name).unwrap_or_else(|| panic!("no text named {name}"))
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn bundled() -> styk_core::text::BundledFonts {
    Arc::new(|style| {
        let name = ["Regular", "Bold", "Italic", "BoldItalic"][style];
        std::fs::read(repo().join(format!("vendor/text/NotoSans-{name}.ttf"))).ok().map(|b| Arc::from(b.into_boxed_slice()))
    })
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

// ---- the font recipes: the same sfnt rewrite the generator does ----------------------------------------------------

fn checksum(bytes: &[u8]) -> u32 {
    let mut sum = 0u32;
    for chunk in bytes.chunks(4) {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
    }
    sum
}

fn patch_sfnt(base: &[u8], replace: &[(String, Vec<u8>)], remove: &[String]) -> Vec<u8> {
    let count = u16::from_be_bytes([base[4], base[5]]) as usize;
    let mut tables: std::collections::BTreeMap<String, Vec<u8>> = std::collections::BTreeMap::new();
    for i in 0..count {
        let at = 12 + i * 16;
        let tag = String::from_utf8_lossy(&base[at..at + 4]).to_string();
        let offset = u32::from_be_bytes(base[at + 8..at + 12].try_into().unwrap()) as usize;
        let length = u32::from_be_bytes(base[at + 12..at + 16].try_into().unwrap()) as usize;
        tables.insert(tag, base[offset..offset + length].to_vec());
    }
    for tag in remove {
        tables.remove(tag);
    }
    for (tag, bytes) in replace {
        tables.insert(tag.clone(), bytes.clone());
    }
    let n = tables.len();
    let power = 1usize << (usize::BITS - 1 - n.leading_zeros());
    let mut out = base[..4].to_vec();
    out.extend((n as u16).to_be_bytes());
    out.extend(((power * 16) as u16).to_be_bytes());
    out.extend(((power.trailing_zeros()) as u16).to_be_bytes());
    out.extend(((n * 16 - power * 16) as u16).to_be_bytes());
    let mut offset = 12 + n * 16;
    let mut body = Vec::new();
    for (tag, bytes) in &tables {
        out.extend(tag.as_bytes());
        out.extend(checksum(bytes).to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((bytes.len() as u32).to_be_bytes());
        let mut padded = bytes.clone();
        padded.resize(bytes.len().div_ceil(4) * 4, 0);
        offset += padded.len();
        body.extend(padded);
    }
    out.extend(body);
    out
}

fn recipe_bytes(name: &str) -> Vec<u8> {
    let recipes = read_json(&fixtures().join("recipes.json"));
    let recipe = recipes.get(name).unwrap_or_else(|| panic!("recipe {name}"));
    let base = std::fs::read(repo().join(recipe.get("base").and_then(Value::as_str).unwrap())).unwrap();
    let replace: Vec<(String, Vec<u8>)> = recipe
        .get("replace")
        .and_then(Value::as_obj)
        .unwrap()
        .iter()
        .map(|(tag, hex)| (tag.to_string(), unhex(hex.as_str().unwrap())))
        .collect();
    let remove: Vec<String> = recipe.get("remove").and_then(Value::elements).unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    let bytes = patch_sfnt(&base, &replace, &remove);
    assert_eq!(sha256(&bytes), recipe.get("sha256").and_then(Value::as_str).unwrap(), "recipe {name} rebuilt different bytes");
    bytes
}

/// Bytes of the font a case names.
fn font_bytes(spec: &str) -> Vec<u8> {
    if let Some(path) = spec.strip_prefix("file:") {
        let path = Path::new(path);
        return std::fs::read(if path.is_absolute() { path.to_path_buf() } else { repo().join(path) }).unwrap();
    }
    if let Some(name) = spec.strip_prefix("recipe:") {
        return recipe_bytes(name);
    }
    if let Some(name) = spec.strip_prefix("fixture:") {
        return std::fs::read(fixtures().join(name)).unwrap();
    }
    assert_eq!(spec, "synthetic-cff");
    std::fs::read(fixtures().join("synthetic-cff.otf")).unwrap()
}

fn font_source(compiler: &mut TextCompiler, spec: &str) -> FontSource {
    if spec.starts_with("noto:") {
        return FontSource::Bundled;
    }
    let info = compiler.load_font(font_bytes(spec), spec).unwrap_or_else(|e| panic!("{spec}: {e:?}"));
    FontSource::Loaded(info.id)
}

// ---- comparing results ---------------------------------------------------------------------------------------------

/// Where two texts first differ, with a little around it.
fn first_difference(a: &str, b: &str) -> String {
    let at = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
    let from = at.saturating_sub(60);
    let show = |s: &str| s.chars().skip(from).take(140).collect::<String>();
    format!("first difference at byte {at} of {} / {}\n  rust: {}\n  js:   {}", a.len(), b.len(), show(a), show(b))
}

fn assert_figure(label: &str, figure: &Value, expected_text: &str) {
    let text = json::to_string(figure);
    assert!(text == expected_text, "{label}: {}", first_difference(&text, expected_text));
    assert_eq!(figure, &json::parse(expected_text.as_bytes()).unwrap(), "{label}: structure");
}

fn params_value(params: &[(&'static str, Value)]) -> Value {
    let mut object = Obj::new();
    for (key, value) in params {
        object.set(key, value.clone());
    }
    Value::object(object)
}

/// Strips the thousands separators `toLocaleString()` put in a number the interface formats itself.
fn without_grouping(value: &Value) -> Value {
    match value {
        Value::Str(s) if s.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.') && s.contains([',', '.']) => Value::str(&s.replace([',', '.'], "")),
        Value::Obj(o) => {
            let mut out = Obj::new();
            for (k, v) in o.iter() {
                out.set(k, without_grouping(v));
            }
            Value::object(out)
        }
        other => other.clone(),
    }
}

fn assert_error(label: &str, error: &TextError, expected: &Value) {
    let key = expected.get("messageKey").and_then(Value::as_str);
    match (error, key) {
        (TextError::Message { key: got, params }, Some(want)) => {
            assert_eq!(*got, want, "{label}: message key");
            let want_params = expected.get("messageParams").filter(|p| !p.is_null()).map(without_grouping).unwrap_or_else(|| Value::object(Obj::new()));
            assert_eq!(params_value(params), want_params, "{label}: message params");
        }
        (TextError::MissingGlyphs { missing, .. }, None) => {
            let want: Vec<String> = expected.get("missing").and_then(Value::elements).unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            assert_eq!(missing, &want, "{label}: missing glyphs");
        }
        (TextError::Font(_), None) => {}
        (got, want) => panic!("{label}: rust gave {got:?}, javascript gave {want:?} / {expected}"),
    }
}

/// Runs every step of `dir/cases.json` and returns how many there were.
fn check_cases(dir: &Path) -> usize {
    let cases = read_json(&dir.join("cases.json"));
    let texts = texts(dir);
    let mut checked = 0;
    for case in cases.get("cases").and_then(Value::elements).unwrap().iter() {
        let id = case.get("id").and_then(Value::as_str).unwrap();
        let mut compiler = TextCompiler::new(bundled());
        let source = font_source(&mut compiler, case.get("font").and_then(Value::as_str).unwrap());
        for (step, entry) in case.get("steps").and_then(Value::elements).unwrap().iter().enumerate() {
            let label = format!("{id} step {step}");
            let request = CompileRequest { revision: step as u64, font: source.clone(), options: entry.get("options").unwrap().clone() };
            if entry.get("superseded").is_some_and(Value::truthy) {
                // A draft the job abandons once it started: the worker of today finishes it, so the font's state moves on anyway.
                let cancelled = CancelToken::new();
                cancelled.cancel();
                assert_eq!(compiler.compile(&request, &cancelled), Err(TextError::Cancelled), "{label}");
                checked += 1;
                continue;
            }
            let result = compiler.compile(&request, &CancelToken::new());
            if let Some(file) = entry.get("expected").and_then(Value::as_str) {
                let figure = result.unwrap_or_else(|e| panic!("{label}: {e:?}"));
                assert_figure(&label, &figure, texts.get(file));
            } else if let Some(digest) = entry.get("digest").and_then(Value::as_str) {
                let figure = result.unwrap_or_else(|e| panic!("{label}: {e:?}"));
                assert_eq!(sha256(json::to_string(&figure).as_bytes()), digest, "{label}: digest of the figure text");
            } else {
                let error = result.expect_err(&format!("{label}: javascript refused this draft"));
                assert_error(&label, &error, entry.get("error").unwrap());
            }
            checked += 1;
        }
    }
    checked
}

#[test]
fn compile_cases_equal_the_javascript_compiler_bit_for_bit() {
    let checked = check_cases(&fixtures());
    assert!(checked >= 70, "only {checked} steps ran");
}

/// `STYK_TEXT_CORPUS`: folders written by `generate.mjs --corpus <fonts> <out>`, separated by `;`. Fonts that cannot be
/// committed (the machine's own, CFF-outline ones included) through the same comparison.
#[test]
#[ignore = "needs a corpus generated on this machine"]
fn installed_fonts_equal_the_javascript_compiler_bit_for_bit() {
    let folders = std::env::var("STYK_TEXT_CORPUS").expect("STYK_TEXT_CORPUS");
    let mut total = 0;
    for folder in folders.split(';') {
        let checked = check_cases(Path::new(folder));
        eprintln!("{folder}: {checked} steps equal");
        total += checked;
    }
    assert!(total > 0);
}

#[test]
fn imported_text_editing_equals_the_javascript_editor() {
    let cases = read_json(&fixtures().join("cases.json"));
    let texts = texts(&fixtures());
    for case in cases.get("native").and_then(Value::elements).unwrap().iter() {
        let id = case.get("id").and_then(Value::as_str).unwrap();
        let source = json::parse(texts.get(case.get("source").and_then(Value::as_str).unwrap()).as_bytes()).unwrap();
        let options = read_text_figure_options(&source, None).unwrap();
        assert_eq!(options, case.get("readOptions").unwrap().clone(), "{id}: the options read from the figure");
        for (step, entry) in case.get("steps").and_then(Value::elements).unwrap().iter().enumerate() {
            let label = format!("{id} step {step}");
            let result = compile_embedded_text_figure(entry.get("options").unwrap(), &source);
            match entry.get("expected").and_then(Value::as_str) {
                Some(file) => assert_figure(&label, &result.unwrap_or_else(|e| panic!("{label}: {e:?}")), texts.get(file)),
                None => assert_error(&label, &result.expect_err(&label), entry.get("error").unwrap()),
            }
        }
        for (step, entry) in case.get("replaceSteps").and_then(Value::elements).unwrap().iter().enumerate() {
            let label = format!("{id} replace {step}");
            // The worker's own path: the source figure set, then a compile with the chosen font.
            let mut compiler = TextCompiler::new(bundled());
            compiler.set_source(Some(source.clone())).unwrap();
            let font = font_source(&mut compiler, entry.get("font").and_then(Value::as_str).unwrap());
            let request = CompileRequest { revision: 0, font, options: entry.get("options").unwrap().clone() };
            let figure = compiler.compile(&request, &CancelToken::new()).unwrap_or_else(|e| panic!("{label}: {e:?}"));
            assert_figure(&label, &figure, texts.get(entry.get("expected").and_then(Value::as_str).unwrap()));
        }
    }
}

#[test]
fn a_cff_font_keeps_the_width_its_charstring_declared_from_one_draft_to_the_next() {
    // `cff` steps 0..: the space of 'A\tB' is the hmtx width on a font whose outlines were never read, the charstring's after.
    let bytes = font_bytes("synthetic-cff");
    let font = Font::parse(bytes).unwrap();
    assert_eq!(font.family(), "Prefam");
    assert!(font.bold() && font.italic());
    let space = font.glyph_index(0x20).unwrap();
    assert_eq!(font.advance_width(space), Some(500.0));
    font.scaled_path(space, 100.0).unwrap();
    assert_eq!(font.advance_width(space), Some(300.0));
}

#[test]
fn faces_report_the_names_and_style_flags_opentype_js_reads() {
    let cases = read_json(&fixtures().join("cases.json"));
    for case in cases.get("cases").and_then(Value::elements).unwrap().iter() {
        let Some(face) = case.get("face").filter(|f| !f.is_null()) else { continue };
        let spec = case.get("font").and_then(Value::as_str).unwrap();
        let font = Font::parse(font_bytes(spec)).unwrap();
        assert_eq!(Some(font.family().as_str()), face.get("family").and_then(Value::as_str), "{spec}: family");
        assert_eq!(Some(font.style().as_str()), face.get("style").and_then(Value::as_str), "{spec}: style");
        assert_eq!(Some(font.bold()), face.get("bold").and_then(Value::as_bool), "{spec}: bold");
        assert_eq!(Some(font.italic()), face.get("italic").and_then(Value::as_bool), "{spec}: italic");
    }
}

#[test]
fn a_font_whose_winning_cmap_mapping_names_a_missing_glyph_is_refused_but_an_overwritten_one_is_not() {
    let cases = read_json(&fixtures().join("cases.json"));
    let rejected: Vec<String> = cases.get("rejected").and_then(Value::elements).unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert!(rejected.len() >= 2);
    for spec in rejected {
        assert!(Font::parse(font_bytes(&spec)).is_err(), "{spec} must be refused as opentype.js refuses it");
    }
    // The accepted ones (cmap4-overwritten, cmap12-overwritten) are compile cases of `cases.json`.
}

/// Reference results of the normalisation of every character of the Basic Multilingual Plane in six contexts, from the
/// runtime of today's app (Unicode 15.1), and the cases that exposed a newer table.
#[test]
fn normalisation_is_the_unicode_version_of_the_reference_runtime() {
    use styk_core::text::{TextOptions, TextSettings};
    let texts = texts(&fixtures());
    let sweep = json::parse(texts.get("nfc-sweep.json").as_bytes()).unwrap();
    assert_eq!(sweep.get("unicode").and_then(Value::as_str), Some("15.1"));
    let changed = sweep.get("changed").and_then(Value::as_obj).unwrap();
    let contexts: [fn(char) -> String; 6] = [
        |c| c.to_string(),
        |c| format!("A{c}"),
        |c| format!("B{c}\u{316}"),
        |c| format!("B\u{316}{c}"),
        |c| format!("B{c}\u{301}"),
        |c| format!("B\u{301}{c}"),
    ];
    let mut wrong = Vec::new();
    for code in 0..0x10000u32 {
        let Some(c) = char::from_u32(code) else { continue };
        for (i, context) in contexts.iter().enumerate() {
            let input = context(c);
            let expected: Value = match changed.get(&format!("{code:x}")) {
                Some(outputs) => outputs.item(i).unwrap(),
                None => Value::str(&input),
            };
            let got = match TextSettings::validate(&TextOptions::new(input.clone()), true) {
                Ok(settings) => Value::str(&settings.text),
                Err(TextError::Message { key, .. }) => {
                    let mut o = Obj::new();
                    o.set("error", Value::str(key));
                    Value::object(o)
                }
                Err(other) => panic!("{other:?}"),
            };
            if got != expected && wrong.len() < 8 {
                wrong.push(format!("U+{code:04X} context {i}: rust {got}, reference {expected}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
    for named in sweep.get("named").and_then(Value::elements).unwrap().iter() {
        let text = named.get("text").and_then(Value::as_str).unwrap();
        let settings = TextSettings::validate(&TextOptions::new(text), true).unwrap();
        assert_eq!(Some(settings.text.as_str()), named.get("nfc").and_then(Value::as_str), "{text:?}");
    }
}

/// A stack of composites that each refer to the one below twice resolves in linear time and memory, and a stack that doubles
/// its points at every level is refused instead of exhausting the machine.
#[test]
fn composite_resolution_is_bounded() {
    let started = std::time::Instant::now();
    let font = Font::parse(font_bytes("fixture:synthetic-composite-bomb.ttf")).unwrap();
    let top = font.glyph_index(0x41).unwrap();
    let error = font.scaled_path(top, 50.0).expect_err("2^24 triangles are not a glyph");
    assert!(matches!(error, styk_core::text::FontError::Invalid(_)), "{error:?}");
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "refusing took {:?}", started.elapsed());
    // The stack that does not double its points is a compile case of `cases.json` (composite-dag) and finishes at once.
    let started = std::time::Instant::now();
    let font = Font::parse(font_bytes("fixture:synthetic-composite.ttf")).unwrap();
    let top = font.glyph_index(0x41).unwrap();
    assert_eq!(font.scaled_path(top, 50.0).unwrap().len(), 5);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "resolving took {:?}", started.elapsed());
}
