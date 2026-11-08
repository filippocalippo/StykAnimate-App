//! Run explicitly in the heavy queue: this regression links a real optimized negative control.
use std::{path::PathBuf, process::Command};

#[test]
#[ignore = "links a release negative control; run explicitly in the machine queue"]
fn compiled_enabled_trace_is_rejected() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let root = root.canonicalize().unwrap();
    let map = root.join("engine/target/release/examples/release_leak.map");
    let status = Command::new("cargo")
        .current_dir(&root)
        .args([
            "rustc",
            "--manifest-path",
            "engine/Cargo.toml",
            "--locked",
            "-p",
            "styk-trace",
            "--example",
            "release_leak",
            "--features",
            "enabled",
            "--release",
            "--",
            "-C",
        ])
        .arg(format!("link-arg=/MAP:{}", map.display()))
        .status()
        .unwrap();
    assert!(status.success());
    let exe = map.with_extension(std::env::consts::EXE_EXTENSION);
    let output = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["check-release"])
        .arg(&exe)
        .arg(&map)
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "optimized trace code escaped the guard: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("styk_trace"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
