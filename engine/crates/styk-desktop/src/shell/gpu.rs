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

pub fn switches(gpu_unsafe: Option<&str>, background: bool, remote_debugging_port: Option<u16>) -> Switches {
    let dxc = std::env::var("STYK_GPU_DXC").as_deref() == Ok("1");
    let mut out = Switches {
        switches: if cfg!(windows) && !dxc { vec!["--disable-dawn-features=use_dxc".into()] } else { Vec::new() },
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
}
