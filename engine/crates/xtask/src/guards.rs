//! Metadata guards share the design task's existing Node prerequisite.
use std::path::Path;
use std::process::Command;

pub fn check(root: &Path, wasm: bool) -> Result<(), String> {
    let mut command = Command::new("node");
    command.arg(root.join("scripts/native-guards.mjs")).arg(root).current_dir(root);
    if wasm {
        command.arg("--wasm");
    }
    let status = command.status().map_err(|error| format!("native guards: could not start Node: {error}"))?;
    if status.success() { Ok(()) } else { Err(format!("native guards failed ({status})")) }
}
