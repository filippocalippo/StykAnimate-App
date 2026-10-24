use crate::{Editor, Options};
use styk_doc::{Obj, Value};

fn oracle() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/edit/native-transform-projection-oracle.json");
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn entries(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::elements)
        .map(|e| e.iter().collect())
        .unwrap_or_default()
}

#[test]
fn first_missing_scalar_write_adopts_native_markers() {
    let mut comparisons = 0;
    for case in entries(Some(&oracle())) {
        let tree = styk_doc::json::parse(
            case.get("documentJSON")
                .unwrap()
                .as_str()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let editor = Editor::new(
            tree,
            Options {
                property_channels: true,
                ..Options::default()
            },
        );
        for channel in entries(case.get("channels")) {
            let expected = styk_doc::json::parse(
                channel
                    .get("channelJSON")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .as_bytes(),
            )
            .unwrap();
            let Some(first) = expected.get("keys").and_then(|keys| keys.item(0)) else {
                continue;
            };
            let target = channel.get("target").unwrap();
            let property = channel.get("property").unwrap();
            let mut entry = Obj::new();
            entry.set("target", target.clone());
            entry.set("property", property.clone());
            entry.set("tick", first.get("tick").unwrap().clone());
            entry.set("value", first.get("value").unwrap().clone());
            let mut draft = crate::property_edit::NativeAnimationDraft::new(&editor);
            draft.put(&editor, &Value::object(entry)).unwrap();
            let projected = draft.project_report(editor.report());
            let actual = entries(projected.path(&["_styk", "animation", "channels"]))
                .into_iter()
                .find(|c| c.get("id") == expected.get("id"))
                .unwrap();
            let mut expected = expected.as_obj().unwrap().clone();
            expected.set("source", Value::str("authored"));
            assert_eq!(
                styk_doc::json::to_string(&actual),
                styk_doc::json::to_string(&Value::object(expected)),
                "{} {} {}",
                case.get("name").unwrap().as_str().unwrap(),
                styk_doc::json::to_string(target),
                property.as_str().unwrap()
            );
            comparisons += 1;
        }
    }
    assert_eq!(comparisons, 200);
}

#[test]
fn projection_curves_and_samples_match_editor_at_every_tick() {
    let (mut curves, mut samples) = (0, 0);
    for case in entries(Some(&oracle())) {
        let tree = styk_doc::json::parse(
            case.get("documentJSON")
                .unwrap()
                .as_str()
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let editor = Editor::new(
            tree,
            Options {
                property_channels: true,
                ..Options::default()
            },
        );
        for channel in entries(case.get("channels")) {
            let target = channel.get("target").unwrap();
            let property = channel.get("property").unwrap().as_str().unwrap();
            let actual = editor
                .native_property_channel_checked(target, property, &mut || Ok(()))
                .unwrap();
            let mut animation = Obj::new();
            animation.set("channels", Value::array(vec![actual.clone()]));
            let mut notes = Vec::new();
            let typed =
                styk_eval::channels::parse(Some(&Value::object(animation)), &mut notes).unwrap();
            assert!(notes.is_empty(), "{notes:?}");
            for sample in entries(channel.get("samples")) {
                let tick = sample.get("tick").unwrap().as_f64().unwrap();
                let native = match typed.channels[0].sample(tick) {
                    Some(styk_eval::channels::KeyValue::Num(number)) => Value::Num(number),
                    None => Value::Null,
                    other => panic!("unexpected transform sample {other:?}"),
                };
                assert_eq!(
                    styk_doc::json::to_string(&native),
                    styk_doc::json::to_string(sample.get("native").unwrap()),
                    "{} {property} native sample {tick}",
                    case.get("name").unwrap().as_str().unwrap()
                );
                let visible = editor
                    .animation_value(target, property, sample.get("tick").unwrap())
                    .unwrap();
                let exact = if visible.is_some() {
                    editor
                        .with_records(|records| {
                            Ok(records
                                .sample_channel_value(target, property, tick)?
                                .or(visible.clone()))
                        })
                        .unwrap()
                } else {
                    None
                };
                assert_eq!(
                    styk_doc::json::to_string(visible.as_ref().unwrap_or(&Value::Null)),
                    styk_doc::json::to_string(sample.get("displayed").unwrap()),
                    "{} {property} displayed {tick}",
                    case.get("name").unwrap().as_str().unwrap()
                );
                assert_eq!(
                    styk_doc::json::to_string(exact.as_ref().unwrap_or(&Value::Null)),
                    styk_doc::json::to_string(sample.get("exactTarget").unwrap()),
                    "{} {property} exactTarget {tick}",
                    case.get("name").unwrap().as_str().unwrap()
                );
                samples += 1;
            }
            assert_eq!(
                styk_doc::json::to_string(&actual),
                channel.get("channelJSON").unwrap().as_str().unwrap(),
                "{} {property} descriptor",
                case.get("name").unwrap().as_str().unwrap()
            );
            assert_eq!(
                styk_doc::json::to_string(&actual),
                channel.get("markersJSON").unwrap().as_str().unwrap(),
                "{} {property} markers",
                case.get("name").unwrap().as_str().unwrap()
            );
            curves += 1;
        }
    }
    assert_eq!((curves, samples), (204, 1620));
}

#[test]
fn projection_cancellation_preserves_canonical_heads_and_command_gates() {
    let case = entries(Some(&oracle()))
        .into_iter()
        .find(|case| {
            case.get("name").unwrap().as_str()
                == Some("native-transform-channels-support-projection-auto")
        })
        .unwrap();
    let tree = styk_doc::json::parse(
        case.get("documentJSON")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let mut editor = Editor::new(
        tree.clone(),
        Options {
            property_channels: true,
            ..Options::default()
        },
    );
    let target = styk_doc::json::parse(br#"{"kind":"figure","uid":2}"#).unwrap();
    let before = editor.state();
    let mut checks = 0;
    editor
        .native_property_channel_checked(&target, "rotation", &mut || {
            checks += 1;
            Ok(())
        })
        .unwrap();
    assert!(checks > 6);
    for stop in 1..=checks {
        let mut count = 0;
        let result = editor.native_property_channel_checked(&target, "rotation", &mut || {
            count += 1;
            if count == stop {
                Err(crate::EditError::Invalid("cancelled projection".into()))
            } else {
                Ok(())
            }
        });
        assert!(
            matches!(result, Err(crate::EditError::Invalid(ref why)) if why == "cancelled projection"),
            "cancel point {stop}"
        );
        assert!(tree.same_node(editor.report()));
        assert_eq!(editor.state(), before);
        assert!(editor.take_events().is_empty());
    }
    assert!(matches!(
        editor.call("select", &[Value::Num(1.0)]),
        Err(crate::EditError::Unported(_))
    ));
    assert!(tree.same_node(editor.report()));
    assert_eq!(editor.state(), before);
}

#[test]
fn source_hints_preserve_identity_retained_precedence_and_unknown_fields() {
    let case = entries(Some(&oracle())).into_iter().next().unwrap();
    let tree = styk_doc::json::parse(
        case.get("documentJSON")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let editor = Editor::new(tree.clone(), Options::default());
    editor
        .with_records(|records| {
            let ordinary = records.pose_source_frame("frame-1", None).unwrap();
            assert!(ordinary.same_node(&tree.get("keyframes").unwrap().item(0).unwrap()));
            for hint in [Some(0), Some(1), Some(usize::MAX), None] {
                assert!(
                    records
                        .pose_source_frame("frame-1", hint)
                        .unwrap()
                        .same_node(&ordinary)
                );
                assert!(records.pose_source_frame("missing", hint).is_none());
            }
            Ok(())
        })
        .unwrap();
    let mut retained = tree
        .get("keyframes")
        .unwrap()
        .item(1)
        .unwrap()
        .as_obj()
        .unwrap()
        .clone();
    retained.set("futureRetained", Value::nums(&[7.0, 2.0]));
    let retained = Value::object(retained);
    let mut updated = tree.clone();
    let mut sources = Obj::new();
    sources.set("frame-1", retained.clone());
    updated
        .make_obj()
        .unwrap()
        .get_mut("_styk")
        .unwrap()
        .make_obj()
        .unwrap()
        .set("frameSources", Value::object(sources));
    let editor = Editor::new(updated, Options::default());
    editor
        .with_records(|records| {
            for hint in [Some(0), Some(1), Some(usize::MAX), None] {
                assert!(
                    records
                        .pose_source_frame("frame-1", hint)
                        .unwrap()
                        .same_node(&retained)
                );
            }
            Ok(())
        })
        .unwrap();
}
