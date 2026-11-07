//! `cargo xtask locales generate | check`: styk-core's language-neutral catalogue (`engine/crates/styk-core/locales/`)
//! from the interface's catalogues (`src/locales/en.mjs`, `src/locales/messages/*.mjs`, `src/locales/locale-index.mjs`).
//!
//! The native build reads only the generated files (styk-core's `build.rs`), so it keeps working when the JavaScript is
//! gone. While the JavaScript exists, `check` fails if the files differ from what its catalogues export; once
//! `src/locales` is removed there is nothing to compare and `check` says so and passes.

use std::path::{Path, PathBuf};
use std::process::Command;

const DIR: &str = "engine/crates/styk-core/locales";

fn files(root: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let script = root.join("engine/crates/xtask/locales.mjs");
    let output = Command::new("node").arg(&script).arg(root).output().map_err(|e| format!("could not run node ({e}): the catalogues come from src/locales/*.mjs, which Node evaluates"))?;
    if !output.status.success() {
        return Err(format!("locales.mjs failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let text = String::from_utf8(output.stdout).map_err(|_| "locales.mjs printed invalid UTF-8".to_string())?;
    let parts: Vec<&str> = text.split('\0').collect();
    if parts.len() % 2 != 0 {
        return Err("locales.mjs printed an odd number of parts".into());
    }
    Ok(parts.chunks(2).map(|pair| (PathBuf::from(pair[0]), pair[1].to_string())).collect())
}

fn stray(root: &Path, files: &[(PathBuf, String)]) -> Result<Vec<PathBuf>, String> {
    let dir = root.join(DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut stray = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        let relative = PathBuf::from(relative.to_string_lossy().replace('\\', "/"));
        if !files.iter().any(|(file, _)| *file == relative) {
            stray.push(path);
        }
    }
    Ok(stray)
}

fn javascript_present(root: &Path) -> bool {
    root.join("src/locales/en.mjs").exists()
}

pub fn generate(root: &Path) -> Result<(), String> {
    let files = files(root)?;
    std::fs::create_dir_all(root.join(DIR)).map_err(|e| e.to_string())?;
    let mut written = 0;
    for (path, content) in &files {
        let full = root.join(path);
        if std::fs::read_to_string(&full).ok().as_deref() != Some(content.as_str()) {
            std::fs::write(&full, content).map_err(|e| format!("{}: {e}", full.display()))?;
            written += 1;
        }
    }
    for path in stray(root, &files)? {
        std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    println!("locales: {} generated files, {written} written", files.len());
    Ok(())
}

pub fn check(root: &Path) -> Result<(), String> {
    if !javascript_present(root) {
        println!("locales: src/locales is gone; the committed catalogue in {DIR} is the source");
        return Ok(());
    }
    let files = files(root)?;
    let mut problems = Vec::new();
    for (path, content) in &files {
        match std::fs::read_to_string(root.join(path)) {
            Ok(found) if found == *content => {}
            Ok(_) => problems.push(format!("stale: {}", path.display())),
            Err(_) => problems.push(format!("missing: {}", path.display())),
        }
    }
    for path in stray(root, &files)? {
        problems.push(format!("stray: {}", path.display()));
    }
    if problems.is_empty() {
        println!("locales: {} catalogue files equal src/locales", files.len());
        Ok(())
    } else {
        Err(format!("locales: the catalogue differs from src/locales (run `cargo xtask locales generate`):\n  {}", problems.join("\n  ")))
    }
}
