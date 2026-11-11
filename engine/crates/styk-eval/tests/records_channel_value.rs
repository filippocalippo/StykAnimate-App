//! The already-bound channel sampler exposes the saved curve before composition.
use styk_doc::Value;
use styk_eval::records::Records;

#[test]
fn saved_scalar_samples_match_the_editor_without_rebinding() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/edit/native-transform-channels.samples.json");
    let cases = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let mut count = 0;
    let mut absent = 0;
    for case in cases.elements().unwrap().iter() {
        let tree = case.get("document").unwrap();
        let prepared = styk_eval::prepare(styk_eval::from_value(tree, "").unwrap());
        let records = Records::new(tree, &prepared).unwrap();
        for row in case.get("rows").unwrap().elements().unwrap().iter() {
            let got = records
                .sample_channel_value(
                    row.get("target").unwrap(),
                    row.get("property").unwrap().as_str().unwrap(),
                    row.get("tick").unwrap().as_f64().unwrap(),
                )
                .unwrap();
            absent += usize::from(got.is_none());
            assert_eq!(
                styk_doc::json::to_string(&got.unwrap_or(Value::Null)),
                styk_doc::json::to_string(row.get("value").unwrap()),
                "{}: {row:?}",
                case.get("name").unwrap().as_str().unwrap()
            );
            count += 1;
        }
    }
    assert_eq!(count, 1344);
    assert!(absent > 100, "missing/empty channels must sample as absent");
}
