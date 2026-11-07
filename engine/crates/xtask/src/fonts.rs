//! `cargo xtask fonts`: the typography check (`docs/native/typography.md`).
//!
//! It draws the type matrix twice, in Chromium with today's stylesheets (Playwright from `node_modules`) and in the
//! native interface (`styk-text-check`, an iced window opened off-screen), for light and dark at 100 % and 150 %, and
//! compares widths, the fonts picked for the scripts Inter lacks, and pixels. Everything goes to `artifacts/fonts/`
//! (git-ignored); the table of each run is `report-<theme>-<scale>.txt` there and on the screen.
//!
//! The command fails when a width is out of tolerance or a fallback font differs. Pixel numbers are reported, not
//! gated: the doc records what they were when the rendering decisions were made.

use std::path::{Path, PathBuf};
use std::process::Command;

const COMBINATIONS: [(&str, &str); 4] = [("light", "1"), ("dark", "1"), ("light", "1.5"), ("dark", "1.5")];

fn run(command: &mut Command, what: &str) -> Result<(), String> {
    let status = command.status().map_err(|error| format!("could not run {what}: {error}"))?;
    if status.success() { Ok(()) } else { Err(format!("{what} failed ({status})")) }
}

fn checker(root: &Path) -> Command {
    let mut command = Command::new("cargo");
    command
        .current_dir(root)
        .args(["run", "--quiet", "--manifest-path", "engine/Cargo.toml", "--profile", "quick", "-p", "styk-text-check", "--"]);
    command
}

/// `cargo xtask fonts verify`: the bundled TrueType files against the WOFF2 subsets the web build ships.
pub fn verify(root: &Path) -> Result<(), String> {
    run(Command::new("node").current_dir(root).arg("engine/crates/xtask/fonts-verify.mjs"), "the bundled-font verification")
}

pub fn check(root: &Path) -> Result<(), String> {
    verify(root)?;
    let out: PathBuf = root.join("artifacts/fonts");
    std::fs::create_dir_all(&out).map_err(|error| error.to_string())?;
    let matrix = out.join("matrix.tsv");
    run(checker(root).arg("matrix").arg(&matrix), "styk-text-check matrix")?;

    let mut failures = Vec::new();
    for (theme, scale) in COMBINATIONS {
        for grayscale in [false, true] {
            let mut node = Command::new("node");
            node.current_dir(root).arg("engine/crates/xtask/fonts-chromium.mjs").arg(&matrix).arg(&out).arg(theme).arg(scale);
            if grayscale {
                node.arg("--grayscale");
            }
            run(&mut node, "the Chromium capture")?;
        }
        run(checker(root).env("STYK_BACKGROUND_WINDOW", "1").arg("sheet").arg(&matrix).arg(&out).arg(theme).arg(scale), "the native sheet")?;
        let mut tables = String::new();
        for chromium in ["chromium", "chromium-gray"] {
            let output = checker(root).arg("compare").arg(&matrix).arg(&out).arg(chromium).arg(theme).arg(scale).output().map_err(|error| format!("could not run the comparison: {error}"))?;
            let table = String::from_utf8_lossy(&output.stdout).into_owned();
            tables.push_str(&table);
            if chromium == "chromium" {
                print!("{table}");
                if !output.status.success() {
                    let error = String::from_utf8_lossy(&output.stderr);
                    failures.push(format!("{theme} at {scale}: widths or fallback fonts out of tolerance (see the table) {}", error.trim()));
                }
            }
        }
        std::fs::write(out.join(format!("report-{theme}-{scale}.txt")), tables).map_err(|error| error.to_string())?;
    }
    if failures.is_empty() { Ok(()) } else { Err(failures.join("\n")) }
}
