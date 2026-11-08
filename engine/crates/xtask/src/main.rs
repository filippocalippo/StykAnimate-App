//! The task runner for the native app (`cargo xtask <task>`; the alias lives in the repository's `.cargo/config.toml`).
//!
//! | Task | What it does |
//! | --- | --- |
//! | `design generate` | Writes `styk-design`'s tokens, icon files and icon table from `src/styles/tokens.css` and `src/icons.mjs` (needs Node). |
//! | `design check` | Fails if any of those files is stale, missing or stray. |
//! | `deps` | Fails if the engine or the core depends, even through other crates, on iced, `styk-ui` or `styk-devtools`. |
//! | `lock` | Fails if `engine/Cargo.lock` holds a git source. |
//! | `locales generate` | Writes styk-core's language-neutral catalogue (`engine/crates/styk-core/locales/`) from `src/locales/*.mjs` (needs Node). |
//! | `locales check` | Fails if that catalogue differs from `src/locales`; passes once the JavaScript is gone. |
//! | `check` | Design, locales, metadata direction, platform isolation, interface Clippy, dependency allow-list and screenshot limits. `--wasm` adds the library portability gate. |
//! | `package` | The Windows Setup: builds the program, runs `makensis`, writes `latest.yml`, its signature and `SHA256SUMS.txt` (`docs/native/shell.md`). Signs nothing, publishes nothing. |
//! | `fonts` | The typography check: the type matrix in Chromium and natively, widths, fallback fonts and pixels compared (needs Playwright's Chromium and a GPU; not part of `check`). `fonts verify` checks the bundled TrueType files against the shipped WOFF2 subsets; `fonts surfaces` measures which CSS surfaces Chromium draws ClearType text on. |
//!
//! It depends on `std` alone, so it builds in seconds and can never become a way for a toolkit to reach the engine.

mod dev_reads;
mod dev_tasks;
mod dev_trace;
mod dev_features;
mod dev_release;
mod dev_resolution;
mod css;
mod deps;
mod design;
mod expr;
mod fonts;
mod locales;
mod guards;
mod package;
mod tokens;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask <design generate | design check | deps | lock | locales generate | locales check | check [--wasm] | fonts | fonts verify | fonts surfaces | package>";

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
        ["read-apis"] => dev_reads::run(&root,false),
        ["check-read-apis"] => dev_reads::run(&root,true),
        ["check-features"] => dev_features::check(&root),
        ["check-release", ..] => dev_release::run(&args[1..]),
        ["check-shipping-features"] => dev_resolution::check(&root),
        ["fonts"] => fonts::check(&root),
        ["fonts", "verify"] => fonts::verify(&root),
        ["fonts", "surfaces"] => fonts::surfaces(&root),
        ["package", options @ ..] => package::package(&root, options),
        ["locales", "generate"] => locales::generate(&root),
        ["locales", "check"] => locales::check(&root),
        ["check"] => design::check(&root).and_then(|()| locales::check(&root)).and_then(|()| deps::deps(&root)).and_then(|()| deps::lock(&root)).and_then(|()| guards::check(&root, false)),
        ["check", "--wasm"] => design::check(&root).and_then(|()| locales::check(&root)).and_then(|()| deps::deps(&root)).and_then(|()| deps::lock(&root)).and_then(|()| guards::check(&root, true)),
        ["build" | "test" | "scenario" | "profile" | "compare" | "screenshot" | "doctor" | "check-trace" | "check-schema" | "flags" | "design-export" | "renderdoc" | "serve-web", ..] => dev_tasks::run(&root,args),
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--json") {
        return if dev_tasks::run_json(&root(), &args) { ExitCode::SUCCESS } else { ExitCode::FAILURE };
    }
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
