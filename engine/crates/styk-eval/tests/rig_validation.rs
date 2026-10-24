//! JavaScript compiler and Editor.load classifications, recorded before the port.
use styk_doc::Value;

fn fixture() -> (Value, Value) {
    let oracle = styk_doc::json::parse(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/origin-invalid-rig.json")).unwrap()).unwrap();
    let document = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit").join(oracle.get("document").unwrap().as_str().unwrap());
    let report = styk_doc::json::parse(&std::fs::read(document).unwrap()).unwrap();
    (oracle, report.get("figure_types").unwrap().item(0).unwrap())
}

fn mutated(mut figure: Value, test: &Value) -> Value {
    if test.get("removeFollowers") == Some(&Value::Bool(true)) {
        for segment in figure.make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap() {
            if let Some(rig) = segment.make_obj().unwrap().get_mut("_stykRig").and_then(Value::make_obj) { rig.remove("follow"); }
        }
    }
    let path: Vec<_> = test.get("path").unwrap().elements().unwrap().iter().collect();
    let mut at = &mut figure;
    for key in &path[..path.len() - 1] {
        at = if let Some(key) = key.as_str() { at.make_obj().unwrap().get_mut(key).unwrap() }
            else { &mut at.make_arr().unwrap()[key.as_f64().unwrap() as usize] };
    }
    let key = path.last().unwrap().as_str().unwrap();
    if test.get("remove") == Some(&Value::Bool(true)) { at.make_obj().unwrap().remove(key); }
    else {
        let raw = test.get("value").unwrap();
        let value = match raw.get("specialNumber").and_then(Value::as_str) {
            Some("NaN") => Value::Num(f64::NAN), Some("Infinity") => Value::Num(f64::INFINITY), Some("-Infinity") => Value::Num(f64::NEG_INFINITY), _ => raw.clone(),
        };
        at.make_obj().unwrap().set(key, value);
    }
    figure
}

#[test]
fn strict_2d_rig_validation_matches_the_recorded_editor_cases_without_rewriting_metadata() {
    let (oracle, figure) = fixture();
    assert!(styk_eval::rig::validate_2d(&figure).is_ok());
    let mut refused = 0;let mut accepted = 0;
    for test in oracle.get("cases").unwrap().elements().unwrap().iter() {
        let figure = mutated(figure.clone(), &test);let bytes = styk_doc::json::to_string(&figure);
        let result = std::panic::catch_unwind(|| styk_eval::rig::validate_2d(&figure));
        assert!(result.is_ok(), "{}: validator panicked", test.get("name").unwrap().as_str().unwrap());
        let result = result.unwrap();
        if test.get("refused") == Some(&Value::Bool(true)) {
            assert_eq!(result, Err(test.get("key").unwrap().as_str().unwrap()), "{}", test.get("name").unwrap().as_str().unwrap());refused += 1;
        } else { assert!(result.is_ok(), "{}: {result:?}", test.get("name").unwrap().as_str().unwrap());accepted += 1; }
        assert_eq!(styk_doc::json::to_string(&figure), bytes);
    }
    assert_eq!((refused, accepted), (102, 27));
    println!("{refused} rejected and {accepted} accepted: exact JS validation keys, raw metadata unchanged");
}

#[test]
fn inactive_relationship_descriptors_use_the_editors_truthiness_in_the_existing_parser() {
    let (oracle, figure) = fixture();let mut count = 0;
    for test in oracle.get("cases").unwrap().elements().unwrap().iter().filter(|test| test.get("refused") == Some(&Value::Bool(false)) && test.get("name").unwrap().as_str().unwrap().contains("descriptor")) {
        let figure = mutated(figure.clone(), &test);
        for segment in figure.get("segments").unwrap().elements().unwrap().iter() {
            let Some(raw) = segment.get("_stykRig") else { continue };
            let rig = styk_eval::rig::parse(raw).unwrap();
            assert_eq!(rig.connector.is_some(), raw.get("connector").is_some_and(Value::truthy), "{} connector", test.get("name").unwrap().as_str().unwrap());
            assert_eq!(rig.stretch.is_some(), raw.get("stretch").is_some_and(Value::truthy), "{} stretch", test.get("name").unwrap().as_str().unwrap());
            assert_eq!(rig.follow.is_some(), raw.get("follow").is_some_and(Value::truthy), "{} follow", test.get("name").unwrap().as_str().unwrap());
        }
        count += 1;
    }
    assert_eq!(count, 10);
}
