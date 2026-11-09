//! The app's own commands are permission-gated: `capabilities/main.json` names each one (`allow-<command>`), and
//! only those are declared here, so a command missing from the capability file cannot be called from the page.
fn main() {
    println!("cargo:rerun-if-changed=capabilities/main.json");
    // Every executable of the crate (the app and its test binaries) gets the app manifest from the linker: test
    // binaries link Tauri too, and Windows will not start them without Common Controls 6 (STATUS_ENTRYPOINT_NOT_FOUND).
    // windows/app.manifest is the manifest tauri-build would embed into the app alone.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if msvc {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir")).join("windows").join("app.manifest");
        println!("cargo:rerun-if-changed=windows/app.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    println!("cargo:rerun-if-changed=../../../src/desktop-bridge.mjs");
    println!("cargo:rerun-if-changed=../../../desktop/release-info.json");
    // Area 3: what scripts/build-telemetry-info.cjs wrote while packaging (the build id and its traffic class), on one
    // line so it fits an environment variable.
    println!("cargo:rerun-if-changed=../../../desktop/telemetry-build.json");
    if let Some(info) = std::fs::read_to_string("../../../desktop/telemetry-build.json")
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    {
        println!("cargo:rustc-env=STYK_TELEMETRY_BUILD={info}");
    }
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
    // `generate_context!` needs `frontendDist` (build/tauri-web) to exist. A development or test build serves the
    // source tree and never reads it, so a fresh checkout (and `npm run engine:test`) gets an empty folder. The packaged
    // app embeds it, so a packaged build refuses to start without the staged page (scripts/tauri-build.mjs stages it).
    let web = std::path::Path::new("../../../build/tauri-web");
    if std::env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_some() {
        assert!(web.join("index.html").is_file(), "build/tauri-web is not staged: package with scripts/tauri-build.mjs");
    } else if !web.exists() {
        std::fs::create_dir_all(web).expect("create build/tauri-web");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands))
            .windows_attributes(if msvc { tauri_build::WindowsAttributes::new_without_app_manifest() } else { tauri_build::WindowsAttributes::new() }),
    )
    .expect("tauri build");
}
