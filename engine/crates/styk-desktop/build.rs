//! The app's own commands are permission-gated: `capabilities/main.json` names each one (`allow-<command>`), and
//! only those are declared here, so a command missing from the capability file cannot be called from the page.
fn main() {
    println!("cargo:rerun-if-changed=capabilities/main.json");
    println!("cargo:rerun-if-changed=../../../src/desktop-bridge.mjs");
    println!("cargo:rerun-if-changed=../../../desktop/release-info.json");
    // Names this build's embedded web assets in their entity tags.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("cargo:rustc-env=STYK_BUILD_STAMP={stamp:x}");
    let text = std::fs::read_to_string("capabilities/main.json").expect("capabilities/main.json");
    let value: serde_json::Value = serde_json::from_str(&text).expect("capabilities/main.json is JSON");
    let mut commands: Vec<String> = value["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .filter_map(|p| p.as_str())
        .filter_map(|p| p.strip_prefix("allow-"))
        .map(|p| p.replace('-', "_"))
        .collect();
    commands.sort();
    commands.dedup();
    let commands: &'static [&'static str] =
        Box::leak(commands.into_iter().map(|c| &*Box::leak(c.into_boxed_str())).collect::<Vec<_>>().into_boxed_slice());
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("tauri build");
}
