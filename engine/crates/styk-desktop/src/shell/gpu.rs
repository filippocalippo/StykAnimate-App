//! The browser switches that decide whether the editor gets a hardware WebGPU adapter (port of
//! desktop/gpu-switches.cjs). On Windows WebView2 uses Chromium's normal driver allowlist and enables WebGPU through
//! D3D12, so nothing is needed. `STYK_GPU_UNSAFE=1` forces the WebGPU opt-in; `STYK_GPU_UNSAFE=0` leaves the
//! browser's own allowlist untouched (useful when diagnosing a driver problem).
//!
//! The engine keeps its own safety net: no WebGPU adapter selects its WebGL2 backend, so a driver that cannot do
//! WebGPU still edits and plays back correctly.
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
    let mut out = Switches {
        switches: Vec::new(),
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
        assert_eq!(switches(None, false, None).arguments(), "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
        let driven = switches(Some("1"), true, Some(9333)).arguments();
        assert!(driven.contains("--enable-unsafe-webgpu"));
        assert!(driven.contains("CalculateNativeWinOcclusion"));
        assert!(driven.contains("--remote-debugging-port=9333"));
        assert!(!switches(Some("0"), false, None).arguments().contains("webgpu"));
    }
}
