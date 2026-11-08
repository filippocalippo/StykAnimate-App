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
    let native = styk_devtools_engine::capture::Capture::read(
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

#[test]
fn export_scenario_matches_two_existing_export_runs_byte_for_byte() {
    let dir = root().join(format!(
        "artifacts/profile/export-scenario-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.png");
    let b = dir.join("b.png");
    for path in [&a, &b] {
        let output = Command::new(env!("CARGO_BIN_EXE_styk"))
            .current_dir(root())
            .args(["export", "engine/tests/edit/startup.document.json", "0"])
            .arg(path)
            .arg("--cpu")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        std::fs::read(&a).unwrap(),
        std::fs::read(&b).unwrap(),
        "old-versus-old baseline must be deterministic"
    );
    let profile = dir.join("profile");
    let output = Command::new(env!("CARGO_BIN_EXE_styk"))
        .current_dir(root())
        .args([
            "profile",
            "engine/tests/edit/startup.document.json",
            "export",
            "--out",
        ])
        .arg(&profile)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(&a).unwrap(),
        std::fs::read(profile.join("export.png")).unwrap(),
        "native scenario must preserve every export byte"
    );
    let report: Value =
        serde_json::from_slice(&std::fs::read(profile.join("profile.json")).unwrap()).unwrap();
    let hashes = report["export_hashes"].as_array().unwrap();
    assert_eq!(hashes.len(), 3);
    assert!(hashes.windows(2).all(|v| v[0] == v[1]));
    for name in [
        "export.png",
        "profile.json",
        "summary.txt",
        "trace.styktrace",
        "trace.perfetto.json",
    ] {
        std::fs::remove_file(profile.join(name)).unwrap();
    }
    std::fs::remove_dir(profile).unwrap();
    std::fs::remove_file(a).unwrap();
    std::fs::remove_file(b).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

#[test]
fn a_budget_miss_is_exit_one_with_a_structured_error() {
    let dir = root().join(format!(
        "artifacts/profile/budget-scenario-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("miss.styk-auto");
    // Zero is deliberately impossible for a measured open, testing exit semantics rather than tuning a performance target.
    std::fs::write(&script, format!("styk-auto/1\nbudget scenario.ms <= 0ms\nopen {}\n", root().join("engine/tests/edit/startup.document.json").display())).unwrap();
    let profile = dir.join("profile");
    let output = Command::new(env!("CARGO_BIN_EXE_styk"))
        .current_dir(root())
        .args(["profile", "engine/tests/edit/startup.document.json"])
        .arg(&script)
        .arg("--out")
        .arg(&profile)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["what"], "BUDGET missed");
    assert_eq!(error["input"]["line"], 2);
    for name in [
        "profile.json",
        "summary.txt",
        "trace.styktrace",
        "trace.perfetto.json",
    ] {
        std::fs::remove_file(profile.join(name)).unwrap();
    }
    std::fs::remove_dir(profile).unwrap();
    std::fs::remove_file(script).unwrap();
    std::fs::remove_dir(dir).unwrap();
}

#[test]
fn shared_scripts_resolve_their_input_and_refuse_a_different_profile_input() {
    let dir = root().join(format!("artifacts/profile/shared-script-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("run.styk-auto");
    std::fs::write(&script, "styk-auto/1\nopen ../../../engine/tests/edit/startup.document.json\nadvance 17\nframe 0\nexport\nbudget scenario.ms >= 0ms\n").unwrap();
    let out = dir.join("result");
    let result = Command::new(env!("CARGO_BIN_EXE_styk")).current_dir(root())
        .args(["profile", "--scenario"]).arg(&script).arg("--out").arg(&out).arg("--full").output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let report: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["budgets"][0]["line"], 6);
    assert_eq!(report["budgets"][0]["met"], true);
    assert_eq!(report["export_hashes"].as_array().unwrap().len(), 3);
    assert!(out.join("export.png").is_file());
    let refused = Command::new(env!("CARGO_BIN_EXE_styk")).current_dir(root())
        .args(["profile", "engine/Cargo.toml"]).arg(&script).arg("--out").arg(dir.join("refused")).output().unwrap();
    assert_eq!(refused.status.code(), Some(2));
    let error: Value = serde_json::from_slice(&refused.stderr).unwrap();
    assert!(error["cause"].as_str().unwrap().contains("line 2: a profile must open only its hashed input"));
    assert!(!dir.join("refused").exists());
    for name in ["profile.json", "summary.txt", "trace.perfetto.json", "trace.styktrace", "export.png"] {
        std::fs::remove_file(out.join(name)).unwrap();
    }
    std::fs::remove_dir(out).unwrap();
    std::fs::remove_file(script).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
