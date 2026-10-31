//! Malformed support descriptors recorded from the JavaScript validator.
use std::path::Path;
use styk_doc::Value;

#[test]
fn retained_support_compiler_refuses_the_editors_malformed_cases() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let oracle = styk_doc::json::parse(&std::fs::read(folder.join("origin-invalid-support.json")).unwrap()).unwrap();
    let report = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit").join(oracle.get("document").unwrap().as_str().unwrap())).unwrap()).unwrap();
    let raw = report.get("figure_types").unwrap().item(0).unwrap();
    let document = styk_eval::from_value(&report, "").unwrap();
    assert!(document.notes.is_empty());
    let segments = &document.figures[0].segments;
    let origin = raw.path(&["_styk", "animationOrigin"]).unwrap();
    assert!(styk_eval::origin::compile(origin, segments).is_ok());
    for test in oracle.get("cases").unwrap().elements().unwrap().iter() {
        let name = test.get("name").unwrap().as_str().unwrap();
        assert_eq!(test.get("refused"), Some(&Value::Bool(true)), "{name}: JS oracle");
        let mut origin = origin.clone();
        let mut at = &mut origin;
        let path: Vec<_> = test.get("path").unwrap().elements().unwrap().iter().collect();
        for key in &path[..path.len() - 1] {
            at = match key.as_str() {
                Some(key) => at.make_obj().unwrap().get_mut(key).unwrap(),
                None => &mut at.make_arr().unwrap()[key.as_f64().unwrap() as usize],
            };
        }
        let key = path.last().unwrap();
        let value = test.get("value").unwrap();
        let value = match value.get("specialNumber").and_then(Value::as_str) {
            Some("NaN") => Value::Num(f64::NAN),
            Some("Infinity") => Value::Num(f64::INFINITY),
            Some("-Infinity") => Value::Num(f64::NEG_INFINITY),
            _ => value.clone(),
        };
        match key.as_str() {
            Some(key) => {
                if test.get("remove") == Some(&Value::Bool(true)) { at.make_obj().unwrap().remove(key); }
                else { at.make_obj().unwrap().set(key, value); }
            }
            None => at.make_arr().unwrap()[key.as_f64().unwrap() as usize] = value,
        }
        let before = styk_doc::json::to_string(&origin);
        let result = std::panic::catch_unwind(|| styk_eval::origin::compile(&origin, segments));
        assert!(result.is_ok(), "{name}: compiler panicked");
        assert!(result.unwrap().is_err(), "{name}: compiler admitted a descriptor the editor rejects");
        assert_eq!(styk_doc::json::to_string(&origin), before, "{name}: compilation modified raw metadata");
    }
}
