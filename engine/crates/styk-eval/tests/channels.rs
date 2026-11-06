//! Property channels against the JavaScript editor.
//!
//! Every fixture in `tests/fixtures/channels/` is a small project animated with channels
//! on its native timeline, built by the editor (frozen recordings): as saved (`<name>.json`, against the editor's evaluation of its
//! native timeline) and as the app holds it once loaded (`<name>.sheet.json`, a layer sheet
//! whose imported keys sample the channels as `legacyAnimation`, against the app's
//! evaluation). The engine must draw the same joints, primitives, effects, backgrounds,
//! outlines and shots, and each channel kind and curve must matter.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_eval::channels::{Animation, Channel, Key, KeyValue, NativeValue, Property, Target};
use styk_eval::doc::{Document, EasingMode, Movieclip};
use styk_eval::eval::Prepared;
use styk_eval::parity::{self, Report};
use styk_eval::vfx::Field;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/channels")
}

/// Fixture names, from the native references present in the folder.
fn fixtures() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder())
        .expect("fixture folder")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".native.reference.json").map(str::to_string))
        .collect();
    names.sort();
    names
}

/// The two forms of a fixture: the file as saved and its native reference, the app's form
/// and the app's reference.
const FORMS: [(&str, &str); 2] = [("json", "native.reference.json"), ("sheet.json", "reference.json")];

fn open(name: &str, form: &str) -> Document {
    styk_eval::open(&folder().join(format!("{name}.{form}"))).unwrap_or_else(|e| panic!("{name}.{form}: {e}"))
}

fn compare(name: &str, reference: &str, document: Document) -> Report {
    let path = folder().join(format!("{name}.{reference}"));
    let reference = styk_doc::json::parse(&std::fs::read(&path).expect("reference")).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parity::compare(&styk_eval::prepare(document), &reference)
}

fn describe(report: &Report) -> String {
    report.bad_frames.iter().map(|frame| format!("tick {}:\n  {}", frame.tick, frame.problems.join("\n  "))).collect::<Vec<_>>().join("\n")
}

/// Whether a document or a movieclip in it has channels.
fn has_channels(document: &Document) -> bool {
    document.animation.is_some() || document.figures.iter().any(|f| f.movieclip.as_ref().is_some_and(|clip| has_channels(&clip.document)))
}

/// The document without channels, its movieclips' documents included.
fn without_channels(mut document: Document) -> Document {
    document.animation = None;
    for figure in document.figures.iter_mut() {
        let Some(clip) = figure.movieclip.clone() else { continue };
        let inner = Arc::new(without_channels((*clip.document).clone()));
        let bare = Movieclip {
            duration: clip.duration,
            source_start: clip.source_start,
            pivot: clip.pivot,
            meshes: clip.meshes.clone(),
            drawing_sets: clip.drawing_sets.clone(),
            drawing_rotation: clip.drawing_rotation,
            prepared: Arc::new(Prepared::new(inner.clone())),
            document: inner,
            cache: Default::default(),
        };
        Arc::make_mut(figure).movieclip = Some(Arc::new(bare));
    }
    document
}

/// The document with its channels changed by `edit` (the native form).
fn edited(name: &str, edit: &dyn Fn(&mut Vec<Channel>)) -> Document {
    let mut document = open(name, "json");
    let mut channels = document.animation.as_ref().expect("channels").channels.clone();
    edit(&mut channels);
    document.animation = Animation::of(channels);
    document
}

/// Whether the native form still matches the editor after `edit`.
fn matches_after(name: &str, edit: &dyn Fn(&mut Vec<Channel>)) -> bool {
    compare(name, "native.reference.json", edited(name, edit)).matches()
}

/// Every key of every channel through `edit`.
fn keys(channels: &mut [Channel], edit: &dyn Fn(&mut Key)) {
    for channel in channels {
        let mut list = channel.keys.to_vec();
        list.iter_mut().for_each(edit);
        channel.keys = Arc::from(list);
    }
}

/// A channel's kind: its target's kind and what it animates (effect parameters by type).
fn kind(channel: &Channel) -> String {
    let target = match channel.target {
        Target::Figure { .. } => "figure",
        Target::Segment { .. } => "segment",
        Target::Polygon { .. } => "polygon",
        Target::Camera => "camera",
        Target::Scene => "scene",
        Target::Layer { .. } => "layer",
    };
    let property = match &channel.property {
        Property::Vfx { field: Field::Enabled, .. } => "vfx enabled".to_string(),
        Property::Vfx { kind, field: Field::Param(i), .. } => format!("vfx {:?}", kind.specs()[*i].kind),
        other => format!("{other:?}"),
    };
    format!("{target} {property}")
}

#[test]
fn every_fixture_evaluates_like_the_editor() {
    let names = fixtures();
    assert!(names.len() >= 10, "fixtures are missing: the channel fixtures are frozen recordings (restore them from version control)");
    for name in &names {
        for (form, reference) in FORMS {
            let document = open(name, form);
            assert!(has_channels(&document), "{name}.{form}: no channels read");
            let report = compare(name, reference, document);
            assert!(report.frames > 0 && report.joints > 0, "{name}.{form}: an empty reference");
            assert!(report.total_ticks.is_none(), "{name}.{form}: timeline length {:?}", report.total_ticks);
            assert!(
                report.matches(),
                "{name}.{form}: {} of {} primitives and {} of {} joints differ\n{}",
                report.mismatched_primitives,
                report.primitives,
                report.mismatched_joints,
                report.joints,
                describe(&report)
            );
        }
    }
}

/// Without their channels, neither form of any fixture matches.
#[test]
fn every_fixture_depends_on_its_channels() {
    for name in fixtures() {
        for (form, reference) in FORMS {
            let document = without_channels(open(&name, form));
            assert!(!compare(&name, reference, document).matches(), "{name}.{form}: matches without its channels");
        }
    }
}

/// Each kind of channel in a fixture changes what is drawn: removing the channels of that
/// kind alone breaks the match. The table names the kinds each fixture must exercise, so
/// that a kind cannot quietly drop out of a regenerated fixture.
#[test]
fn every_channel_kind_matters() {
    let required: &[(&str, &[&str])] = &[
        ("channels-figure", &["figure Scale", "figure Rotation", "figure Opacity", "figure Color", "figure ZIndex", "figure X", "figure Y"]),
        ("channels-outline", &["figure OutlineColor", "figure OutlineWidth", "figure OutlineOpacity"]),
        (
            "channels-style",
            &["segment Color", "segment Opacity", "segment Thickness", "segment GradientColor", "segment GradientOpacity", "segment Paint", "segment ZIndex", "polygon Color", "polygon Opacity", "polygon ZIndex"],
        ),
        ("channels-camera-scene", &["camera X", "camera Y", "camera Scale", "camera Rotation", "scene Color", "scene BackgroundId"]),
        ("channels-pose", &["figure Pose", "layer Pose", "camera Pose", "scene Pose"]),
        ("channels-movieclip", &["figure Pose"]),
        ("channels-vfx", &["figure VfxStack", "segment VfxStack", "scene VfxStack", "figure vfx Number", "segment vfx Color", "figure vfx enabled", "figure vfx Choice", "figure VfxScope", "scene vfx Number"]),
        ("channels-curves", &["figure Scale", "figure Rotation"]),
    ];
    let mut quiet = Vec::new();
    for (name, kinds) in required {
        let present: Vec<String> = open(name, "json").animation.expect("channels").channels.iter().map(kind).collect();
        for wanted in *kinds {
            assert!(present.iter().any(|k| k == wanted), "{name}: no {wanted} channel");
            if matches_after(name, &|channels| channels.retain(|c| kind(c) != *wanted)) {
                quiet.push(format!("{name}: {wanted}"));
            }
        }
    }
    assert!(quiet.is_empty(), "removing these changes nothing:\n  {}", quiet.join("\n  "));
}

/// A change to a fixture's channels.
type Edit = dyn Fn(&mut Vec<Channel>);

/// A key's curve made linear.
fn linear(key: &mut Key) {
    if let Some(easing) = key.easing.as_mut() {
        easing.mode = EasingMode::Linear;
    }
}

/// Each curve the fixtures use changes what is drawn when it is taken away.
#[test]
fn every_curve_matters() {
    let checks: &[(&str, &str, &Edit)] = &[
        ("channels-figure", "Bézier, ease-in and ease-out keys", &|c| keys(c, &|k| if k.easing.is_some_and(|e| matches!(e.mode, EasingMode::Bezier | EasingMode::EaseIn | EasingMode::EaseOut)) { linear(k) })),
        ("channels-figure", "Pivot's colour and opacity resampling", &|c| keys(c, &|k| k.native_value = None)),
        ("channels-camera-scene", "Auto curves", &|c| keys(c, &|k| if k.easing.is_some_and(|e| e.mode == EasingMode::Auto) { linear(k) })),
        ("channels-camera-scene", "held keys", &|c| keys(c, &|k| if k.easing.is_some_and(|e| e.mode == EasingMode::Constant) && k.value != KeyValue::Null { linear(k) })),
        ("channels-curves", "Pivot's monotone cubic", &|c| keys(c, &|k| k.pchip = false)),
        ("channels-curves", "angles along the shortest turn", &|c| keys(c, &|k| k.native_rotation = false)),
        ("channels-curves", "a passthrough interval", &|c| keys(c, &|k| k.passthrough = false)),
        ("channels-pose", "a hidden pose key", &|c| keys(c, &|k| k.hidden = false)),
        ("channels-movieclip", "masked pose ranges", &|c| c.iter_mut().for_each(|c| c.masked = Arc::from(Vec::new()))),
        ("channels-movieclip", "the stacking anchor", &|c| c.iter_mut().for_each(|c| c.order_anchor = None)),
        ("channels-pose", "native appearance", &|c| c.iter_mut().for_each(|c| c.native_properties = false)),
    ];
    let mut quiet = Vec::new();
    for (name, what, edit) in checks {
        if matches_after(name, *edit) {
            quiet.push(format!("{name}: {what}"));
        }
    }
    assert!(quiet.is_empty(), "taking these away changes nothing:\n  {}", quiet.join("\n  "));
    // The fixtures hold what these checks take away.
    let flagged = |name: &str, test: &dyn Fn(&Key) -> bool| open(name, "json").animation.unwrap().channels.iter().any(|c| c.keys.iter().any(test));
    assert!(flagged("channels-figure", &|k| k.native_value == Some(NativeValue::Opacity)) && flagged("channels-figure", &|k| k.native_value == Some(NativeValue::Color)));
    assert!(flagged("channels-curves", &|k| k.pchip) && flagged("channels-curves", &|k| k.native_rotation) && flagged("channels-curves", &|k| k.passthrough));
}
