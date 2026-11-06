//! Actual editor display of unfinalized native channels on the worker.
use styk_doc::Value;
use styk_eval::records::{Records, snapshot_pose_frame};
fn oracle() -> Vec<Value> {
    styk_doc::json::parse(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/edit/origin-motion-draft-records.json"),
        )
        .unwrap(),
    )
    .unwrap()
    .elements()
    .unwrap()
    .iter()
    .collect()
}
#[test]
fn live_native_draft_display_matches_actual_insertion_order_scalar_samples() {
    let entries = oracle();
    assert_eq!(entries.len(), 42);
    let mut finalized_differences = 0;
    for entry in &entries {
        let tree = entry.get("report").unwrap();
        let prepared = styk_eval::prepare(styk_eval::from_value(tree, "").unwrap());
        let channels: Vec<Value> = entry
            .get("channels")
            .unwrap()
            .elements()
            .unwrap()
            .iter()
            .collect();
        let tick = entry.get("tick").unwrap().as_f64().unwrap();
        let expected = entry.get("frame").unwrap().as_str().unwrap();
        let actual = Records::new_native_draft(tree, &prepared, &channels)
            .unwrap()
            .evaluated(tick)
            .unwrap();
        assert_eq!(
            styk_doc::json::to_string(&snapshot_pose_frame(&actual)),
            expected,
            "{:?} step {:?}",
            entry.get("name"),
            entry.get("step")
        );
        let finalized = Records::new(tree, &prepared)
            .unwrap()
            .evaluated(tick)
            .unwrap();
        finalized_differences +=
            usize::from(styk_doc::json::to_string(&snapshot_pose_frame(&finalized)) != expected);
    }
    assert!(
        finalized_differences > 0,
        "the oracle must expose prematurely finalized scalar order"
    );
    println!("42 exact live displays; {finalized_differences} distinguish finalized order");
}
#[test]
fn draft_read_defers_only_key_order_and_persisted_channels_stay_strict() {
    let entries = oracle();
    let entry = entries
        .iter()
        .find(|entry| entry.get("step").unwrap().as_f64() == Some(33.0))
        .unwrap();
    let tree = entry.get("report").unwrap();
    let prepared = styk_eval::prepare(styk_eval::from_value(tree, "").unwrap());
    let channels: Vec<Value> = entry
        .get("channels")
        .unwrap()
        .elements()
        .unwrap()
        .iter()
        .collect();
    assert!(
        Records::new(tree, &prepared)
            .unwrap()
            .bind_channels(&channels)
            .is_err()
    );
    for fault in ["target", "property", "tick", "value"] {
        let mut invalid = channels.clone();
        let scalar = invalid
            .iter_mut()
            .find(|channel| channel.get("property").unwrap().as_str() != Some("pose"))
            .unwrap();
        match fault {
            "target" => scalar.make_obj().unwrap().set("target", Value::Null),
            "property" => scalar
                .make_obj()
                .unwrap()
                .set("property", Value::str("unrecorded")),
            field => {
                let key = &mut scalar
                    .make_obj()
                    .unwrap()
                    .get_mut("keys")
                    .unwrap()
                    .make_arr()
                    .unwrap()[0];
                key.make_obj().unwrap().set(field, Value::Num(f64::NAN));
            }
        }
        assert!(
            Records::new_native_draft(tree, &prepared, &invalid).is_err(),
            "{fault}: schema/finite validation must remain"
        );
    }
    let mut sheet = tree.clone();
    sheet
        .make_obj()
        .unwrap()
        .get_mut("_styk")
        .unwrap()
        .make_obj()
        .unwrap()
        .set("layerSheet", Value::Bool(true));
    assert!(Records::new_native_draft(&sheet, &prepared, &channels).is_err());
}
