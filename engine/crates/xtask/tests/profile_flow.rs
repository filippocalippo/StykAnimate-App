//! End-to-end task runner regression; explicitly run under the machine's heavy queue.
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn task(root: &Path, args: &[&str], out: Option<&Path>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_xtask"));
    cmd.current_dir(root)
        .args(args)
        .env("STYK_QUEUE_ACTIVE", "1");
    if let Some(out) = out {
        cmd.arg("--out").arg(out);
    }
    cmd.output().unwrap()
}
#[test]
#[ignore = "builds and measures the CLI; run explicitly in the machine queue"]
fn profile_and_scenario_produce_comparable_release_measurements() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let out = root.join(format!(
        "artifacts/xtask-profile-flow-{}",
        std::process::id()
    ));
    fs::create_dir(&out).unwrap();
    let a = out.join("a");
    let b = out.join("b");
    let c = out.join("scenario");
    for path in [&a, &b] {
        let run = task(
            &root,
            &[
                "profile",
                "engine/tests/edit/startup.document.json",
                "open",
                "--runs",
                "3",
            ],
            Some(path),
        );
        assert!(
            run.status.success(),
            "{}",
            String::from_utf8_lossy(&run.stderr)
        );
    }
    let compare = task(
        &root,
        &[
            "compare",
            a.join("profile.json").to_str().unwrap(),
            b.join("profile.json").to_str().unwrap(),
        ],
        None,
    );
    let stdout = format!(
        "{}{}",
        String::from_utf8_lossy(&compare.stdout),
        String::from_utf8_lossy(&compare.stderr)
    );
    assert!(
        stdout.contains("\"verdict\":"),
        "no comparable verdict: {stdout}\n{}",
        String::from_utf8_lossy(&compare.stderr)
    );
    // A measured regression is a valid verdict too. Never retune/retry to force an improvement.
    assert!(matches!(compare.status.code(), Some(0 | 1)));
    let scenario = task(&root, &["scenario", "open", "--runs", "3"], Some(&c));
    assert!(
        scenario.status.success(),
        "{}",
        String::from_utf8_lossy(&scenario.stderr)
    );
    for path in [&a, &b, &c] {
        let profile = fs::read_to_string(path.join("profile.json")).unwrap();
        assert!(
            profile
                .split_whitespace()
                .collect::<String>()
                .contains("\"build_profile\":\"release\"")
        );
    }
    println!(
        "task-runner comparison: {}",
        stdout.lines().last().unwrap_or("missing")
    );
    // Retain these bounded diagnostics for the handoff; no frozen fixture is modified.
    println!("profile-flow artifacts: {}", out.display());
}
