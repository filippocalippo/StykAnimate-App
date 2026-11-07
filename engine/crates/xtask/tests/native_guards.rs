//! Exercise the metadata, source, compiler and screenshot rejection fixtures.
//! Uses the same Node prerequisite as xtask's design and native guard commands.
#[test]
fn native_guards_reject_violating_fixtures() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let status = std::process::Command::new("node")
        .args(["--test", "engine/crates/xtask/tests/native-guards.test.mjs", "engine/crates/xtask/tests/review-guards.test.mjs"])
        .current_dir(root)
        .status()
        .expect("Node is required by cargo xtask check");
    assert!(status.success(), "native guard fixtures failed: {status}");
}
