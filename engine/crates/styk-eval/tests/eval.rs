//! Evaluation against the JavaScript editor.
//!
//! Every fixture in `tests/fixtures/eval/` is a small project and the editor's
//! own evaluation of it (frozen recordings). The engine must draw the same joints and primitives, within the
//! tolerance `styk compare` uses.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_eval::doc::{Document, SheetTrack};
use styk_eval::parity::{self, Report};

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/eval")
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
    let path = folder().join(format!("{name}.reference.json"));
    let reference = styk_doc::json::parse(&std::fs::read(&path).expect("reference")).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parity::compare(&styk_eval::prepare(document), &reference)
}

fn describe(report: &Report) -> String {
    report.bad_frames.iter().map(|frame| format!("tick {}:\n  {}", frame.tick, frame.problems.join("\n  "))).collect::<Vec<_>>().join("\n")
}

#[test]
fn every_fixture_evaluates_like_the_editor() {
    let names = fixtures();
    assert!(names.len() >= 3, "fixtures are missing: the evaluation fixtures are frozen recordings (restore them from version control)");
    for name in &names {
        let document = open(name);
        let report = compare(name, document);
        assert!(report.frames > 0 && report.joints > 0, "{name}: an empty reference");
        assert!(report.total_ticks.is_none(), "{name}: timeline length {:?}", report.total_ticks);
        assert!(
            report.matches(),
            "{name}: {} of {} primitives and {} of {} joints differ\n{}",
            report.mismatched_primitives,
            report.primitives,
            report.mismatched_joints,
            report.joints,
            describe(&report)
        );
    }
}

/// The movieclip fixtures would prove nothing if they passed without the
/// replacements their layer keys carry.
#[test]
fn movieclip_fixtures_depend_on_their_replacements() {
    for name in fixtures().into_iter().filter(|name| name.starts_with("movieclip-")) {
        let mut document = open(&name);
        let sheet = Arc::make_mut(document.sheet.as_mut().unwrap_or_else(|| panic!("{name}: no layer sheet")));
        let mut replacements = 0;
        for track in sheet.tracks.values_mut() {
            let mut bare: SheetTrack = (**track).clone();
            for key in &mut bare.keys {
                replacements += key.movieclip_patches.len();
                key.movieclip_patches.clear();
            }
            *track = Arc::new(bare);
        }
        assert!(replacements > 0, "{name}: no replacement in the fixture");
        assert!(!compare(&name, document).matches(), "{name}: matches without its replacements");
    }
}

/// The parallax fixtures would prove nothing if they matched without their layers'
/// parallax, and the baked one without the offsets its camera keys keep apart.
#[test]
fn parallax_fixtures_depend_on_parallax() {
    let names: Vec<String> = fixtures().into_iter().filter(|name| name.starts_with("parallax-")).collect();
    assert!(names.len() >= 2, "parallax fixtures are missing");
    for name in &names {
        let mut document = open(name);
        let layers = Arc::make_mut(document.layers.as_mut().unwrap_or_else(|| panic!("{name}: no layers")));
        assert!(!layers.parallax.is_empty(), "{name}: no layer with parallax");
        layers.parallax.clear();
        let report = compare(name, document);
        assert!(report.shots > 0, "{name}: the reference has no shots");
        assert!(!report.matches(), "{name}: matches without parallax");
    }
    let mut document = open("parallax-baked-motion");
    let mut offsets = 0;
    for frame in document.frame_sources.values_mut().chain(document.keyframes.iter_mut()) {
        if let Some(camera) = Arc::make_mut(frame).camera.as_mut() {
            offsets += camera.motion_offset.take().is_some_and(|o| o != [0.0, 0.0]) as usize;
        }
    }
    assert!(offsets > 0, "no baked offset in the fixture");
    assert!(!compare("parallax-baked-motion", document).matches(), "matches without its baked offsets");
}

/// The colour-transition fixture would prove nothing if it matched without its transitions.
#[test]
fn color_fixture_depends_on_its_transitions() {
    let mut document = open("color-transitions");
    let mut transitions = 0;
    for frame in document.frame_sources.values_mut().chain(document.keyframes.iter_mut()) {
        for object in Arc::make_mut(frame).objects.iter_mut() {
            transitions += Arc::make_mut(object).color_transition.take().is_some() as usize;
        }
    }
    assert!(transitions > 0, "no colour transition in the fixture");
    assert!(!compare("color-transitions", document).matches(), "matches without its colour transitions");
}

/// The sprite fixture would prove nothing if its pictures sat where they do without the
/// sprites' stretch and pivot.
#[test]
fn sprite_fixture_depends_on_its_sprites() {
    let text = std::fs::read_to_string(folder().join("sticknodes-sprites.json")).expect("fixture");
    let count = text.matches("\"_sticknodesSprite\"").count();
    assert!(count > 0, "no Stick Nodes sprite in the fixture");
    let bare = text.replace("\"_sticknodesSprite\"", "\"_withoutSprite\"");
    let tree = styk_doc::json::parse(bare.as_bytes()).expect("json");
    let document = styk_eval::from_value(&tree, "sticknodes-sprites").expect("document");
    assert!(!compare("sticknodes-sprites", document).matches(), "matches without its sprites");
}

/// The follow fixtures would prove nothing if their shots matched without the follow
/// clips (their figures dropped, the clips' spans kept).
#[test]
fn follow_fixtures_depend_on_their_clips() {
    let names: Vec<String> = fixtures().into_iter().filter(|name| name.starts_with("follow-")).collect();
    assert!(names.len() >= 2, "follow fixtures are missing");
    for name in &names {
        let mut document = open(name);
        let mut follows = 0;
        for clip in document.camera_motion.iter_mut().filter(|clip| clip.kind == "follow") {
            follows += !clip.targets.is_empty() as usize;
            clip.targets.clear();
        }
        assert!(follows > 0, "{name}: no follow clip");
        let report = compare(name, document);
        assert!(report.shots > 0, "{name}: the reference has no shots");
        assert!(!report.matches(), "{name}: matches without its follow clips");
    }
}
