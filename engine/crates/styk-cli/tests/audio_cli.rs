//! `styk audio` end to end: a project holding the golden recordings and clips is opened by the engine as a saved project is,
//! its soundtrack is mixed by the tool, and the WAV is compared with what today's `src/audio-pcm.mjs` made, byte for byte.
#![cfg(feature = "app-tools")]

use std::path::PathBuf;
use std::process::Command;

use styk_doc::Value;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../styk-core/tests/fixtures/audio")
}

fn base64(bytes: &[u8]) -> String {
    let mut out = Vec::new();
    styk_doc::json::base64_into(bytes, &mut out);
    String::from_utf8(out).unwrap()
}

/// A project: a small saved figure with `_styk.audio` holding `case`'s recordings and clips on one track.
fn project(case: &Value, sources: &Value, peaks: &Value) -> Vec<u8> {
    let base = std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/channels/channels-figure.json")).unwrap();
    let mut document = styk_doc::json::parse(&base).unwrap();
    let mut assets = Vec::new();
    let mut used: Vec<String> = Vec::new();
    let clips = case.get("clips").unwrap().elements().unwrap();
    for clip in clips.iter() {
        let id = clip.get("assetId").and_then(Value::as_str).unwrap().to_string();
        if let Some(file) = sources.get(&id).and_then(Value::as_str) {
            if !used.iter().any(|u| u == file) {
                used.push(file.to_string());
                let bytes = std::fs::read(fixtures().join(file)).unwrap();
                let duration = peaks.get(&id).and_then(|p| p.get("duration")).and_then(Value::as_f64).unwrap();
                assets.push(format!(r#""{id}":{{"id":"{id}","name":"{file}","size":{},"duration":{duration},"chunks":[{{"data_base64":"{}"}}],"peaks":[0.5]}}"#, bytes.len(), base64(&bytes)));
            }
        }
    }
    let clips_json: Vec<String> = clips
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let n = |k: &str| c.get(k).and_then(Value::as_f64).unwrap();
            format!(r#"{{"id":"c{i}","assetId":"{}","start":{},"offset":{},"duration":{},"gain":{},"fadeIn":{},"fadeOut":{}}}"#, c.get("assetId").and_then(Value::as_str).unwrap(), n("start"), n("offset"), n("duration"), n("gain"), n("fadeIn"), n("fadeOut"))
        })
        .collect();
    let audio = format!(r#"{{"version":1,"assets":{{{}}},"tracks":[{{"id":"t1","name":"Track","gain":1,"mute":false,"solo":false,"clips":[{}]}}]}}"#, assets.join(","), clips_json.join(","));
    let audio = styk_doc::json::parse(audio.as_bytes()).unwrap();
    let root = document.make_obj().unwrap();
    if root.get("_styk").is_none() {
        root.set("_styk", Value::object(styk_doc::Obj::new()));
    }
    root.get_mut("_styk").unwrap().make_obj().unwrap().set("audio", audio);
    styk_doc::json::to_string(&document).into_bytes()
}

#[test]
fn a_projects_soundtrack_mixed_by_the_tool_equals_todays_mixer_byte_for_byte() {
    let json = styk_doc::json::parse(&std::fs::read(fixtures().join("cases.json")).unwrap()).unwrap();
    let (cases, sources, peaks) = (json.get("cases").unwrap().elements().unwrap(), json.get("sources").unwrap(), json.get("peaks").unwrap());
    let work = std::env::temp_dir().join(format!("styk-audio-cli-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let mut checked = 0;
    for case in cases.iter() {
        let name = case.get("name").and_then(Value::as_str).unwrap().to_string();
        if ["clip-outside-and-missing"].contains(&name.as_str()) {
            continue;
        }
        let (start, frames) = (case.get("start").and_then(Value::as_f64).unwrap(), case.get("frames").and_then(Value::as_f64).unwrap());
        let input = work.join(format!("{name}.json"));
        std::fs::write(&input, project(&case, sources, peaks)).unwrap();
        let output = work.join(format!("{name}.wav"));
        let run = Command::new(env!("CARGO_BIN_EXE_styk"))
            .arg("audio")
            .arg(&input)
            .arg(&output)
            .args(["--start", &format!("{}", start / 48000.0), "--duration", &format!("{}", frames / 48000.0)])
            .output()
            .expect("run styk audio");
        let stdout = String::from_utf8_lossy(&run.stdout);
        assert!(run.status.success(), "{name}: {stdout} {}", String::from_utf8_lossy(&run.stderr));
        let golden = std::fs::read(fixtures().join(case.get("golden").and_then(Value::as_str).unwrap())).unwrap();
        let made = std::fs::read(&output).unwrap();
        assert!(made == golden, "{name}: the tool's WAV differs from today's mixer ({} against {} bytes)", made.len(), golden.len());
        assert!(stdout.contains("\"sha256\""), "{stdout}");
        checked += 1;
    }
    assert!(checked >= 9, "{checked} cases were checked");
    let _ = std::fs::remove_dir_all(work);
}

#[test]
fn a_project_with_no_audio_after_the_start_is_refused_not_written() {
    let work = std::env::temp_dir().join(format!("styk-audio-cli-none-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let input = work.join("silent.json");
    std::fs::copy(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/channels/channels-figure.json"), &input).unwrap();
    let output = work.join("silent.wav");
    let run = Command::new(env!("CARGO_BIN_EXE_styk")).arg("audio").arg(&input).arg(&output).output().expect("run styk audio");
    assert_eq!(run.status.code(), Some(1), "{} {}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
    assert!(!output.exists());
    let _ = std::fs::remove_dir_all(work);
}
