//! Source-only generators retain the editor census; local generators pack exact batches.
use std::path::Path;
use styk_doc::Value;
use styk_eval::{
    parity,
    vfx::generated::{self, Evaluate},
};
fn json(path: &Path) -> Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn remove_sources(tree: &mut Value) {
    if let Some(styk) = tree.make_obj().and_then(|o| o.get_mut("_styk")).and_then(Value::make_obj) {
        styk.remove("movieclipSource");
    }
    if let Some(figures) = tree.make_obj().and_then(|o| o.get_mut("figure_types")).and_then(Value::make_arr) {
        for figure in figures {
            if let Some(document) =
                figure.make_obj().and_then(|o| o.get_mut("_styk")).and_then(Value::make_obj).and_then(|s| s.get_mut("movieclip")).and_then(Value::make_obj).and_then(|c| c.get_mut("document"))
            {
                remove_sources(document);
            }
        }
    }
}
#[test]
fn retained_generator_census_and_local_batches_match_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-source-generators");
    let mut failures = Vec::new();
    let mut batches = 0;
    let mut absent = 0;
    for name in ["only-native", "inherited-native", "inherited-app", "local-native", "local-app", "inherited-timed", "inherited-presence", "local-timed", "local-presence"] {
        let tree = json(&folder.join(format!("{name}.json")));
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let suffix = if name.ends_with("native") { "native.reference" } else { "reference" };
        let reference = json(&folder.join(format!("{name}.{suffix}.json")));
        let report = parity::compare(&prepared, &reference);
        if !report.matches() {
            failures.push(format!("{name} effects/geometry: {:?}", report.bad_frames));
        }
        let inherited = name.starts_with("inherited") || name.starts_with("only");
        if generated::has_generators(&prepared.doc) == inherited {
            failures.push(format!("{name}: incorrect generator census"));
        }
        let records = json(&folder.join(format!("{name}.batches.json")));
        for record in records.get("frames").unwrap().elements().unwrap().iter() {
            let tick = record.get("tick").unwrap().as_f64().unwrap();
            let frame = prepared.evaluate(tick);
            if name == "only-native" && frame.vfx.is_some() {
                failures.push(format!("{name} tick {tick}: source-only generators retained an empty filter owner"));
            }
            let scene = styk_eval::geometry::build(&prepared.doc, &frame);
            let batch = generated::build(&prepared, &frame, &scene, record.get("clock").and_then(Value::as_f64), Some(&Evaluate), 1.0);
            let expected = record.get("batch").filter(|b| !b.is_null());
            match (batch, expected) {
                (None, None) => {
                    absent += 1;
                }
                (Some(_), None) | (None, Some(_)) => failures.push(format!("{name} tick {tick}: generator batch presence differs")),
                (Some(batch), Some(expected)) => {
                    batches += 1;
                    if expected.get("tick").and_then(Value::as_f64) != Some(batch.tick) || expected.get("particles").and_then(Value::as_f64) != Some(batch.particles as f64) {
                        failures.push(format!("{name} tick {tick}: batch tick/particle count differs"));
                    }
                    for (key, ours) in [("records", &batch.records), ("table", &batch.table)] {
                        let theirs = expected.get(key).unwrap().numbers().unwrap();
                        if theirs.len() != ours.len() || theirs.iter().zip(ours).any(|(&a, &b)| (a as f32).to_bits() != b.to_bits()) {
                            failures.push(format!("{name} tick {tick}: packed {key} differs"));
                        }
                    }
                    let draws = Value::array(
                        batch
                            .draws
                            .iter()
                            .map(|d| {
                                Value::array(vec![
                                    Value::Num(d.record as f64),
                                    Value::Num(d.count as f64),
                                    Value::Num(d.shape as f64),
                                    Value::Num(d.blend as f64),
                                    d.uid.map_or(Value::Null, |id| Value::Num(id as f64)),
                                    Value::Num((d.placement == generated::layers::Placement::Behind) as u8 as f64),
                                    Value::Num(d.scene as u8 as f64),
                                    Value::Num(d.material as f64),
                                ])
                            })
                            .collect(),
                    );
                    if expected.get("draws") != Some(&draws) {
                        failures.push(format!("{name} tick {tick}: packed draws differ"));
                    }
                }
            }
        }
        let mut mutant = tree.clone();
        remove_sources(&mut mutant);
        if parity::compare(&styk_eval::prepare(styk_eval::from_value(&mutant, "").unwrap()), &reference).matches() {
            failures.push(format!("{name}: source-removal dependency mutant matched"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!((batches, absent), (39, 62), "positive/absent batch census changed");
}
