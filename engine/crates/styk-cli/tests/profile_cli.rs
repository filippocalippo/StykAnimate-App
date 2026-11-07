#![cfg(feature = "app-tools")]
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
#[test]
fn fixture_profile_writes_readable_captures_without_document_contents() {
    let out = root().join(format!("artifacts/profile/cli-test-{}", std::process::id()));
    let output = Command::new(env!("CARGO_BIN_EXE_styk"))
        .current_dir(root())
        .args([
            "profile",
            "engine/tests/edit/startup.document.json",
            "frame",
            "--out",
        ])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["samples_ms"].as_array().unwrap().len(), 3);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("startup.document"));
    let trace: Value =
        serde_json::from_slice(&std::fs::read(out.join("trace.perfetto.json")).unwrap()).unwrap();
    assert!(
        trace["traceEvents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "scenario.frame")
    );
    let native = styk_devtools::capture::Capture::read(
        std::fs::File::open(out.join("trace.styktrace")).unwrap(),
        8 * 1024 * 1024,
    )
    .unwrap();
    assert!(!native.recovered);
    for name in [
        "profile.json",
        "summary.txt",
        "trace.perfetto.json",
        "trace.styktrace",
    ] {
        std::fs::remove_file(out.join(name)).unwrap();
    }
    std::fs::remove_dir(out).unwrap();
}
#[test]
fn comparison_regressions_reach_the_exit_status() {
    let dir = root().join(format!(
        "artifacts/profile/compare-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let profile = |samples: Vec<f64>| json!({"format":"stykprofile/1","scenario":"open","input_hash":"fixture","clock":"real","build_profile":"release","samples_ms":samples});
    let a = dir.join("a.json");
    let b = dir.join("b.json");
    std::fs::write(&a, profile(vec![99., 100., 101.]).to_string()).unwrap();
    std::fs::write(&b, profile(vec![109., 110., 111.]).to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_styk"))
        .arg("compare-profile")
        .arg(&a)
        .arg(&b)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["verdict"], "regression");
    std::fs::remove_file(a).unwrap();
    std::fs::remove_file(b).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
