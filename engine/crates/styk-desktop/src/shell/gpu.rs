//! The browser switches that decide whether the editor gets a hardware WebGPU adapter (port of
//! desktop/gpu-switches.cjs). On Windows WebView2 uses Chromium's normal driver allowlist and enables WebGPU through
//! D3D12, so no opt-in is needed (but see the shader compiler below). `STYK_GPU_UNSAFE=1` forces the WebGPU opt-in; `STYK_GPU_UNSAFE=0` leaves the
//! browser's own allowlist untouched (useful when diagnosing a driver problem).
//!
//! The engine keeps its own safety net: no WebGPU adapter selects its WebGL2 backend, so a driver that cannot do
//! WebGPU still edits and plays back correctly.
//!
//! **Shader compiler (Windows).** WebView2's WebGPU (Dawn on D3D12) compiles shaders with DXC, loading
//! `dxcompiler.dll` from the runtime's folder when the first device is made. The WebView2 runtime ships
//! `dxcompiler.dll` without `dxil.dll`, and inside the GPU process's sandbox that load fails ("DynamicLib.Open:
//! dxcompiler.dll Windows Error: 87"): no device, so the engine never starts. Found 2026-11-09 with runtime
//! 157.0.4341.42; turning the sandbox off makes the same load succeed, so it is the sandbox, not our folder or
//! search path. The app therefore asks Dawn for its FXC path (`d3dcompiler_47.dll`, which the runtime ships and
//! loads before the sandbox) with `--disable-dawn-features=use_dxc`, and keeps the sandbox on. The engine's shaders
//! use no DXC-only feature (no `f16`, no subgroups). `STYK_GPU_DXC=1` keeps DXC (to check a newer runtime).
//!
//! WebView2 takes all its switches as one string, and every window sharing a browser profile must pass the same
//! one. Tauri's defaults (`msWebOOUI`, `msPdfOOUI`, `msSmartScreenProtection` off) are kept.

/// What the browser is started with.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Switches {
    pub switches: Vec<String>,
    pub disable_features: Vec<String>,
}

/// Whether Dawn compiles shaders with FXC in this run (Windows, unless `STYK_GPU_DXC=1`).
pub fn fxc() -> bool {
    cfg!(windows) && std::env::var("STYK_GPU_DXC").as_deref() != Ok("1")
}

/// The engine's effects shader (styk-render), which FXC takes seconds to compile the first time on a machine. The
/// bridge compiles it in the background soon after start (`warmEffects`), with the engine's own pipeline descriptor,
/// so the browser's shader cache already holds it when the first frame with an effect needs it. Measured 2026-11-09:
/// about 8 s cold under FXC (0.6 s under Electron's DXC), 20-30 ms from the cache in later launches.
pub const EFFECTS_SHADER: &str = include_str!("../../../styk-render/src/effects/passes.wgsl");

pub fn switches(gpu_unsafe: Option<&str>, background: bool, remote_debugging_port: Option<u16>) -> Switches {
    let mut out = Switches {
        switches: if fxc() { vec!["--disable-dawn-features=use_dxc".into()] } else { Vec::new() },
        disable_features: vec!["msWebOOUI".into(), "msPdfOOUI".into(), "msSmartScreenProtection".into()],
    };
    if gpu_unsafe == Some("1") {
        out.switches.push("--enable-unsafe-webgpu".into());
    }
    // A window driven by scripts opens off-screen; the browser would count it as occluded and stop its frames.
    if background {
        out.disable_features.push("CalculateNativeWinOcclusion".into());
    }
    if let Some(port) = remote_debugging_port {
        out.switches.push(format!("--remote-debugging-port={port}"));
    }
    out
}

impl Switches {
    /// The one argument string WebView2 takes.
    pub fn arguments(&self) -> String {
        let mut all = self.switches.clone();
        if !self.disable_features.is_empty() {
            all.push(format!("--disable-features={}", self.disable_features.join(",")));
        }
        all.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_needs_no_gpu_switch_and_scripts_keep_drawing_off_screen() {
        let plain = switches(None, false, None).arguments();
        assert!(plain.ends_with("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        // The GPU process keeps its sandbox; shaders go through FXC (see the module's notes).
        assert_eq!(plain.contains("--disable-dawn-features=use_dxc"), cfg!(windows));
        assert!(!plain.contains("sandbox"));
        let driven = switches(Some("1"), true, Some(9333)).arguments();
        assert!(driven.contains("--enable-unsafe-webgpu"));
        assert!(driven.contains("CalculateNativeWinOcclusion"));
        assert!(driven.contains("--remote-debugging-port=9333"));
        assert!(!switches(Some("0"), false, None).arguments().contains("webgpu"));
    }

    /// The bridge's warm-up mirrors the engine's effects pipeline (styk-render effects/executor.rs); a change there
    /// must reach the bridge, or the warm-up compiles something the engine never asks for.
    #[test]
    fn the_effects_warm_up_matches_the_engines_pipeline() {
        let executor = include_str!("../../../styk-render/src/effects/executor.rs");
        let bridge = include_str!("../../../../../src/desktop-bridge.mjs");
        assert!(executor.contains("const UNIFORM_SIZE: u64 = 736;"));
        assert!(bridge.contains("minBindingSize: 736"));
        assert!(executor.contains("const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;"));
        assert!(executor.contains(r#"entry_point: Some("vertex")"#) && executor.contains(r#"entry_point: Some("fragment")"#));
        assert!(executor.contains("blend: None") && executor.contains("has_dynamic_offset: true"));
        assert!(EFFECTS_SHADER.contains("@group(0) @binding(4) var<uniform> params: Params;"));
    }
}
