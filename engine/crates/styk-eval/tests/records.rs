//! The evaluated frame as records against what the editor stored
//! (frozen recordings): byte for byte at every recorded tick.
//! Frames the engine does not produce as records yet are counted, so the test
//! fails when a ported kind of frame stops matching or stops being produced.

use std::path::Path;

use styk_eval::records::{Error, Records};

/// Recorded ticks the engine does not produce yet, by reason. Lower these as
/// frames are ported; they may never rise.
const UNPORTED: &[(&str, usize)] = &[];

#[test]
fn recorded_frames_match() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/records");
    let (mut identical, mut total) = (0, 0);
    let mut unported: std::collections::BTreeMap<String, usize> = Default::default();
    let mut names: Vec<_> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().path()).collect();
    names.sort();
    for path in names {
        let parse = |name: &str| styk_doc::json::parse(&std::fs::read(path.join(name)).unwrap()).unwrap();
        let (tree, reference) = (parse("report.json"), parse("records.json"));
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let records = Records::new(&tree, &prepared).unwrap();
        for entry in reference.get("ticks").unwrap().elements().unwrap().iter() {
            let tick = entry.get("tick").unwrap().as_f64().unwrap();
            total += 1;
            match records.recorded(&entry) {
                Ok(value) => {
                    let (got, want) = (styk_doc::json::to_string(&value), entry.get("json").unwrap().as_str().unwrap().to_string());
                    let at = got.bytes().zip(want.bytes()).position(|(a, b)| a != b).unwrap_or(got.len().min(want.len()));
                    let near = |text: &str| text[text.floor_char_boundary(at.saturating_sub(80))..text.floor_char_boundary((at + 80).min(text.len()))].to_string();
                    assert!(got == want, "{} tick {tick} differs at byte {at}:\n engine …{}…\n editor …{}…", path.display(), near(&got), near(&want));
                    identical += 1;
                }
                Err(Error::Unported(what)) => *unported.entry(what).or_default() += 1,
                Err(error) => panic!("{} tick {tick}: {error}", path.display()),
            }
        }
    }
    let expected: std::collections::BTreeMap<String, usize> = UNPORTED.iter().map(|(what, count)| (what.to_string(), *count)).collect();
    assert_eq!(unported, expected, "{identical} of {total} recorded ticks identical");
    assert!(identical >= 1234, "{identical} identical");
}

/// The property-channel fixtures (`channels-*`, as the app holds them and on their native
/// timeline) and the property edits (`entries-*`, the frame `_sheetPropertyEntries` writes)
/// each need their channels: without them, some recorded tick differs.
#[test]
fn channel_fixtures_need_their_channels() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/records");
    let mut names: Vec<_> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().path()).collect();
    names.sort();
    let mut checked = 0;
    for path in names {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.starts_with("channels-") && !name.starts_with("entries-") {
            continue;
        }
        let parse = |file: &str| styk_doc::json::parse(&std::fs::read(path.join(file)).unwrap()).unwrap();
        let (mut tree, reference) = (parse("report.json"), parse("records.json"));
        if name.starts_with("channels-") {
            // The same document without its channels.
            let styk = tree.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap();
            styk.remove("animation");
            if let Some(sheet) = styk.get_mut("layerSheet").and_then(styk_doc::Value::make_obj) {
                sheet.remove("legacyAnimation");
            }
        }
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let records = Records::new(&tree, &prepared).unwrap();
        let differs = reference.get("ticks").unwrap().elements().unwrap().iter().any(|entry| {
            let tick = entry.get("tick").unwrap().as_f64().unwrap();
            let plain = match entry.get("channels") {
                Some(_) => styk_eval::records::snapshot_pose_frame(&records.evaluated_with(tick, false).unwrap()),
                None => records.snapshot(tick).unwrap(),
            };
            styk_doc::json::to_string(&plain) != entry.get("json").unwrap().as_str().unwrap()
        });
        assert!(differs, "{name}: every recorded tick is the same without its channels");
        checked += 1;
    }
    assert!(checked >= 26, "{checked} channel fixtures");
}
