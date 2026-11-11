//! Replays what the Python codec answered (recorded by `engine/tools/piv/oracle.py`)
//! against this crate and requires identical answers.
//!
//! The recordings are not committed (they reference a private corpus and are
//! large). Point `STYK_PIV_PARITY` at a recording directory to run this test;
//! without it the test says so and passes. `engine/tools/piv/parity.sh` records
//! and replays in one command.
#![cfg(feature = "containers")]

use std::path::Path;
use std::process::Command;

#[test]
fn the_rust_codec_answers_what_the_python_codec_answered() {
    let Some(directory) = std::env::var_os("STYK_PIV_PARITY") else {
        eprintln!("skipped: set STYK_PIV_PARITY to a directory recorded by engine/tools/piv/oracle.py (or run engine/tools/piv/parity.sh)");
        return;
    };
    if !Path::new(&directory).is_dir() {
        eprintln!("skipped: STYK_PIV_PARITY={} is not a directory", Path::new(&directory).display());
        return;
    }
    let mut command = Command::new(env!("CARGO_BIN_EXE_styk-piv"));
    command.arg("replay").arg(&directory);
    if let Ok(only) = std::env::var("STYK_PIV_PARITY_ONLY") {
        for pattern in only.split(',').filter(|pattern| !pattern.is_empty()) {
            command.args(["--only", pattern]);
        }
    }
    let output = command.output().expect("run styk-piv replay");
    let report = String::from_utf8_lossy(&output.stdout);
    eprintln!("{report}{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "the replay found differences (report above)");
}
