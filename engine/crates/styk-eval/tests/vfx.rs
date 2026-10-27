//! Visual-effect evaluation against the JavaScript editor.
//!
//! Every fixture in `tests/fixtures/vfx/` is a small project and the editor's
//! own evaluation of it, effects included (frozen recordings). The engine must resolve the same stacks, connected
//! groups and generated effects, parameter by parameter, and the pure
//! functions must return what the JavaScript returns for the recorded inputs
//! (`vectors.json`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_doc::Value;
use styk_eval::doc::{Document, Keyframe};
use styk_eval::parity::{self, Report};
use styk_eval::vfx::{self, clips::sample_keys, parse, Clip, Effect, Field, Key, ParamValue};

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vfx")
}

fn json(path: &Path) -> Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Fixture names, from the reference dumps present in the folder.
fn fixtures() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder())
        .expect("fixture folder")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".reference.json").map(str::to_string))
        .collect();
    names.sort();
    names
}

fn open(name: &str) -> Document {
    styk_eval::open(&folder().join(format!("{name}.json"))).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn compare(name: &str, document: Document) -> Report {
    parity::compare(&styk_eval::prepare(document), &json(&folder().join(format!("{name}.reference.json"))))
}

fn describe(report: &Report) -> String {
    report.bad_frames.iter().map(|frame| format!("tick {}:\n  {}", frame.tick, frame.problems.join("\n  "))).collect::<Vec<_>>().join("\n")
}

#[test]
fn every_fixture_resolves_effects_like_the_editor() {
    let names = fixtures();
    assert!(names.len() >= 9, "fixtures are missing: the effect fixtures are frozen recordings (restore them from version control)");
    let mut effects = 0;
    for name in &names {
        let document = open(name);
        assert!(document.notes.is_empty(), "{name}: read leniently: {:?}", document.notes);
        assert!(vfx::document_has_vfx(&document), "{name}: no effects");
        let report = compare(name, document);
        assert!(report.frames > 0 && report.joints > 0 && report.vfx.frames == report.frames, "{name}: an empty reference");
        assert!(report.vfx.effects > 0, "{name}: no effect compared");
        assert!(report.total_ticks.is_none(), "{name}: timeline length {:?}", report.total_ticks);
        assert!(
            report.matches(),
            "{name}: {} of {} effects, {} other effect results, {} of {} primitives and {} of {} joints differ\n{}",
            report.vfx.mismatched_effects,
            report.vfx.effects,
            report.vfx.other,
            report.mismatched_primitives,
            report.primitives,
            report.mismatched_joints,
            report.joints,
            describe(&report)
        );
        effects += report.vfx.effects;
    }
    assert!(effects >= 400, "only {effects} effects were compared");
}

/// The document without its effect clips, or without its per-pose stacks.
fn without(mut document: Document, clips: bool, stacks: bool) -> Document {
    if clips {
        document.vfx_clips = None;
    }
    if stacks {
        let strip = |frame: &mut Arc<Keyframe>| {
            let frame = Arc::make_mut(frame);
            frame.vfx = None;
            for object in frame.objects.iter_mut() {
                Arc::make_mut(object).vfx = None;
            }
        };
        document.keyframes.iter_mut().for_each(strip);
        document.frame_sources.values_mut().for_each(strip);
    }
    document
}

/// A fixture that passed without its clips or without its stacks would prove nothing.
#[test]
fn fixtures_depend_on_their_effects() {
    for name in fixtures() {
        let document = open(&name);
        let clips = document.vfx_clips.is_some();
        let stacks = document.keyframes.iter().chain(document.frame_sources.values()).any(|f| f.vfx.is_some() || f.objects.iter().any(|o| o.vfx.is_some()));
        assert!(clips || stacks, "{name}: neither clips nor stacks");
        if clips {
            let report = compare(&name, without(open(&name), true, false));
            assert!(!report.matches(), "{name}: matches without its clips");
        }
        if stacks {
            let report = compare(&name, without(document, false, true));
            assert!(!report.matches(), "{name}: matches without its per-pose stacks");
        }
    }
}

/// Tweening matters: holding every pose stack at its key changes what the
/// fixtures with tweened stacks resolve.
#[test]
fn pose_fixtures_depend_on_tweening() {
    for name in ["pose-sheet", "pose-native"] {
        let mut document = open(name);
        // A copy of each pose's stacks per key, with every effect given a new identity: nothing matches the next key.
        let rename = |frame: &mut Arc<Keyframe>, index: usize| {
            let frame = Arc::make_mut(frame);
            for object in frame.objects.iter_mut() {
                let Some(stacks) = object.vfx.clone() else { continue };
                let mut stacks = (*stacks).clone();
                for (_, stack) in stacks.entries.iter_mut() {
                    *stack = stack.iter().map(|e| Arc::new(Effect { id: format!("{}-{index}", e.id).into(), ..(**e).clone() })).collect();
                }
                Arc::make_mut(object).vfx = Some(Arc::new(stacks));
            }
        };
        document.keyframes.iter_mut().enumerate().for_each(|(i, f)| rename(f, i));
        document.frame_sources.values_mut().enumerate().for_each(|(i, f)| rename(f, i));
        let report = compare(name, document);
        assert!(report.vfx.mismatched_effects > 0, "{name}: matches without tweening");
    }
}

#[test]
fn documents_without_effects_resolve_none() {
    let eval = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/eval");
    for entry in std::fs::read_dir(&eval).expect("eval fixtures") {
        let path = entry.expect("entry").path();
        if !path.to_str().is_some_and(|p| p.ends_with(".json") && !p.ends_with(".reference.json")) {
            continue;
        }
        let document = styk_eval::open(&path).expect("fixture");
        assert!(!vfx::document_has_vfx(&document), "{}", path.display());
        let prepared = styk_eval::prepare(document);
        assert!(!prepared.has_vfx);
        for tick in 0..prepared.total_ticks {
            assert!(prepared.evaluate(tick as f64).vfx.is_none());
        }
    }
}

// ------------------------------------------------------------ pure functions

fn vectors() -> Value {
    json(&folder().join("vectors.json"))
}

fn color(v: &Value) -> ParamValue {
    match v {
        Value::Num(n) => ParamValue::Num(*n),
        _ => ParamValue::Paint(Arc::new(vfx::paint::normalize(v).expect("a paint"))),
    }
}

fn same_color(ours: &ParamValue, theirs: &Value, what: &str) {
    let expected = color(theirs);
    match (ours, &expected) {
        (ParamValue::Num(a), ParamValue::Num(b)) => assert_eq!(a, b, "{what}"),
        (ParamValue::Paint(a), ParamValue::Paint(b)) => {
            assert_eq!(a.kind, b.kind, "{what}");
            near(a.angle, b.angle, what);
            assert_eq!(a.stops.len(), b.stops.len(), "{what}");
            for (x, y) in a.stops.iter().zip(&b.stops) {
                near(x.offset, y.offset, what);
                near(x.opacity, y.opacity, what);
                assert_eq!(x.rgb, y.rgb, "{what}");
            }
        }
        _ => panic!("{what}: {ours:?} vs {expected:?}"),
    }
}

fn near(a: f64, b: f64, what: &str) {
    assert!((a - b).abs() <= 1e-9 * (1.0 + b.abs()), "{what}: {a} != {b}");
}

#[test]
fn colours_interpolate_like_the_editor() {
    let cases = vectors();
    let cases = cases.get("colors").and_then(Value::as_arr).expect("colours");
    assert!(cases.len() >= 200);
    for (i, case) in cases.iter().enumerate() {
        let (a, b) = (color(case.get("a").unwrap()), color(case.get("b").unwrap()));
        let t = case.get("t").and_then(Value::as_f64).unwrap();
        same_color(&vfx::paint::interpolate(&a, &b, t), case.get("value").unwrap(), &format!("colour case {i}"));
    }
}

#[test]
fn keys_sample_like_the_editor() {
    let cases = vectors();
    let cases = cases.get("keys").and_then(Value::as_arr).expect("keys");
    assert!(cases.len() >= 80);
    for (i, case) in cases.iter().enumerate() {
        let property = case.get("property").and_then(Value::as_str).unwrap();
        let (kind, _, field) = parse::property(property).expect("a property");
        let spec = match field {
            Field::Param(p) => kind.specs()[p],
            Field::Enabled => unreachable!(),
        };
        let keys: Vec<Key> = case
            .get("keys")
            .and_then(Value::as_arr)
            .unwrap()
            .iter()
            .map(|k| Key {
                tick: k.get("tick").and_then(Value::as_f64).unwrap(),
                value: parse::value(&spec, k.get("value").unwrap()).expect("a key value"),
                easing: styk_eval::load::easing(Some(k)).unwrap(),
            })
            .collect();
        let tick = case.get("tick").and_then(Value::as_f64).unwrap();
        let ours = sample_keys(&keys, tick, spec.kind.discrete(), spec.kind == vfx::ParamKind::Color);
        let what = format!("key case {i} ({property} at {tick})");
        match (&ours, case.get("value").unwrap()) {
            (ParamValue::Num(a), Value::Num(b)) if spec.kind == vfx::ParamKind::Number => near(*a, *b, &what),
            (_, theirs) => same_color(&ours, theirs, &what),
        }
    }
}

fn stack(v: &Value) -> Vec<Arc<Effect>> {
    let mut notes = Vec::new();
    let stack = parse::stack(v, &mut notes);
    assert!(notes.is_empty(), "{notes:?}");
    stack
}

#[test]
fn padding_and_slots_match_the_editor() {
    let cases = vectors();
    let cases = cases.get("padding").and_then(Value::as_arr).expect("padding");
    assert!(cases.len() >= 40);
    for (i, case) in cases.iter().enumerate() {
        let effects = stack(case.get("stack").unwrap());
        let (scale, extent) = (case.get("scale").and_then(Value::as_f64).unwrap(), case.get("extent").and_then(Value::as_f64).unwrap());
        let active: Vec<Arc<Effect>> = vfx::active(&effects).cloned().collect();
        let ids: Vec<&str> = active.iter().map(|e| &*e.id).collect();
        let theirs: Vec<&str> = case.get("active").and_then(Value::as_arr).unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(ids, theirs, "padding case {i}: active effects");
        assert_eq!(Some(vfx::padding(&effects, scale, extent)), case.get("padding").and_then(Value::as_f64), "padding case {i}");
        assert_eq!(Some(vfx::sampling_padding(&effects, scale, extent)), case.get("sampling").and_then(Value::as_f64), "padding case {i}: sampling");
        let slots: Vec<f64> = vfx::working_slots(&effects).into_iter().map(f64::from).collect();
        assert_eq!(Some(slots), case.get("slots").and_then(Value::numbers), "padding case {i}: slots");
    }
}

#[test]
fn neutral_effects_match_the_editor() {
    let cases = vectors();
    let cases = cases.get("neutral").and_then(Value::as_arr).expect("neutral");
    assert_eq!(cases.len(), vfx::Kind::ALL.len() + 11);
    for case in cases {
        let effect = parse::effect(case.get("effect").unwrap()).expect("an effect");
        assert_eq!(Some(effect.params.neutral()), case.get("neutral").and_then(Value::as_bool), "{:?}", effect);
    }
}

#[test]
fn clips_fade_and_contain_like_the_editor() {
    // `vfxFadeAt` and `clipContains` at the edges of a timed clip.
    let clip = Clip {
        id: "c".into(),
        target: vfx::Target::Scene,
        start: 10.0,
        duration: Some(8.0),
        offset: 3.0,
        enabled: true,
        strength: 0.5,
        fade_in: 4.0,
        fade_out: 2.0,
        include_attached: false,
        effects: vec![],
        channels: vec![],
    };
    assert!(!clip.contains(9.999) && clip.contains(10.0) && clip.contains(17.5) && !clip.contains(18.0));
    assert_eq!(clip.time(12.0), 5.0);
    assert_eq!(clip.time(0.0), 0.0);
    assert_eq!(clip.fade(0.0), 0.0);
    assert_eq!(clip.fade(2.0), 0.5);
    assert_eq!(clip.fade(7.0), 0.5);
    assert_eq!(clip.fade(8.0), 0.0);
    assert_eq!(Clip { duration: None, start: 0.0, offset: 0.0, ..clip }.fade(1.0), 1.0);
}
