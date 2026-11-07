//! The font-readiness rule, end to end: a window whose view sets text, opened while the font system is built late.
//!
//! The warm-up worker is delayed (`STYK_FONT_WARMUP_DELAY_MS`) as on a cold start with thousands of fonts. The gated
//! view shows no text until the fonts are ready, the event loop keeps drawing, and the run passes. The same run with
//! the gate removed (`--no-font-gate`) lays text out on the interface thread, which builds the font system and waits
//! for the scan: the check must catch it. Windows only: it needs a window the run can open off-screen and capture.

#![cfg(windows)]

use std::process::Command;

fn run(name: &str, extra: &[&str]) -> (bool, String) {
    let exe = env!("CARGO_BIN_EXE_styk-text-check");
    let dir = std::env::temp_dir().join(format!("styk-font-gate-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let matrix = dir.join("matrix.tsv");
    assert!(Command::new(exe).arg("matrix").arg(&matrix).status().unwrap().success());
    let output = Command::new(exe)
        .args(["sheet"])
        .arg(&matrix)
        .arg(&dir)
        .args(["light", "1"])
        .args(extra)
        .env("STYK_BACKGROUND_WINDOW", "1")
        .env("STYK_FONT_WARMUP_DELAY_MS", "1200")
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    (output.status.success(), String::from_utf8_lossy(&output.stderr).into_owned())
}

#[test]
fn a_view_that_waits_for_the_fonts_keeps_the_event_loop_running() {
    let (passed, stderr) = run("gated", &[]);
    assert!(passed, "{stderr}");
    assert!(stderr.contains("frames drawn before the fonts were ready"), "{stderr}");
}

#[test]
fn a_view_that_lays_out_text_before_the_fonts_are_ready_is_caught() {
    let (passed, stderr) = run("ungated", &["--no-font-gate"]);
    assert!(!passed, "the ungated run must fail: {stderr}");
    assert!(stderr.contains("built the font system"), "{stderr}");
}
