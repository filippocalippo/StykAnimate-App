//! The task runner for the native app (`cargo xtask <task>`; the alias lives in the repository's `.cargo/config.toml`).
//!
//! | Task | What it does |
//! | --- | --- |
//! | `design generate` | Writes `styk-design`'s tokens, icon files and icon table from `src/styles/tokens.css` and `src/icons.mjs` (needs Node). |
//! | `design check` | Fails if any of those files is stale, missing or stray. |
//! | `deps` | Fails if the engine or the core depends, even through other crates, on iced, `styk-ui` or `styk-devtools`. |
//! | `lock` | Fails if `engine/Cargo.lock` holds a git source. |
//! | `check` | `design check`, `deps` and `lock`. |
//! | `fonts` | The typography check: the type matrix in Chromium and natively, widths, fallback fonts and pixels compared (needs Playwright's Chromium and a GPU; not part of `check`). |
//!
//! It depends on `std` alone, so it builds in seconds and can never become a way for a toolkit to reach the engine.

mod css;
mod deps;
mod design;
mod expr;
mod fonts;
mod tokens;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask <design generate | design check | deps | lock | check | fonts | fonts verify>";

fn root() -> PathBuf {
    // engine/crates/xtask -> the repository root.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("the repository root exists");
    // Windows canonicalizes to a `\\?\` path that Node cannot run a script from.
    match root.to_str().and_then(|path| path.strip_prefix(r"\\?\")) {
        Some(plain) => PathBuf::from(plain),
        None => root,
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let root = root();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["design", "generate"] => design::generate(&root),
        ["design", "check"] => design::check(&root),
        ["deps"] => deps::deps(&root),
        ["lock"] => deps::lock(&root),
        ["fonts"] => fonts::check(&root),
        ["fonts", "verify"] => fonts::verify(&root),
        ["check"] => design::check(&root).and_then(|()| deps::deps(&root)).and_then(|()| deps::lock(&root)),
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
