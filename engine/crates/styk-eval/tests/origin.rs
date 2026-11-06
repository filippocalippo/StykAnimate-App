//! Animation origins against the JavaScript editor.
//!
//! Every fixture in `tests/fixtures/origin/` is a project the editor builds with Set
//! Origin, construction edits and animation, and the editor's own evaluation of it
//! (frozen recordings). The engine must draw the
//! same joints and primitives, within the tolerance `styk compare` uses.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_eval::doc::Document;
use styk_eval::parity::{self, Report};

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/origin")
}

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
fn every_origin_fixture_evaluates_like_the_editor() {
    let names = fixtures();
    assert!(names.len() >= 3, "fixtures are missing: the origin fixtures are frozen recordings (restore them from version control)");
    for name in &names {
        let document = open(name);
        assert!(document.notes.is_empty(), "{name}: read leniently: {:?}", document.notes);
        assert!(document.figures.iter().any(|f| f.origin.is_some()), "{name}: no figure with an origin");
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

/// Without their origins the figures tween their construction trees and keep their
/// stored roots: every fixture must then differ.
#[test]
fn origin_fixtures_depend_on_their_origins() {
    for name in fixtures() {
        let mut document = open(&name);
        for figure in document.figures.iter_mut() {
            Arc::make_mut(figure).origin = None;
        }
        assert!(!compare(&name, document).matches(), "{name}: matches without its origins");
    }
}

/// The support fixture keeps ghost bones in its poses, and the offsets fixture a real
/// local offset: each part matters to the picture.
#[test]
fn origin_fixtures_depend_on_ghosts_and_offsets() {
    let mut support = open("origin-support");
    let mut ghosts = 0;
    for frame in support.frame_sources.values_mut() {
        for object in Arc::make_mut(frame).objects.iter_mut() {
            if let Some(origin) = object.origin.clone() {
                let mut origin = (*origin).clone();
                ghosts += origin.ghosts.len();
                for ghost in origin.ghosts.values_mut() {
                    ghost.angle += 0.5;
                }
                Arc::make_mut(object).origin = Some(Arc::new(origin));
            }
        }
    }
    assert!(ghosts > 0, "no ghost bone in the support fixture");
    assert!(!compare("origin-support", support).matches(), "the support fixture matches with other ghost poses");
    let mut offsets = open("origin-offsets");
    let mut moved = 0;
    for frame in offsets.frame_sources.values_mut() {
        for object in Arc::make_mut(frame).objects.iter_mut() {
            if let Some(origin) = object.origin.clone() {
                let mut origin = (*origin).clone();
                moved += origin.offset[0].is_some_and(|x| x.abs() > 1.0) as usize;
                origin.offset = [None, None];
                Arc::make_mut(object).origin = Some(Arc::new(origin));
            }
        }
    }
    assert!(moved > 0, "no real offset in the offsets fixture");
    assert!(!compare("origin-offsets", offsets).matches(), "the offsets fixture matches without its offsets");
}
