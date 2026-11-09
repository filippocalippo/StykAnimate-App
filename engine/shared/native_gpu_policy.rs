//! Native host GPU policy, shared as source by the engine renderer and engine-free catalogue host.
//! This module depends only on the host's wgpu re-export; it opens no device and reads no document.
use crate::wgpu;

/// One way of asking wgpu for a device.
#[derive(Clone, Debug)]
pub struct Attempt {
    /// What the attempt is, for messages.
    pub name: String,
    pub backends: wgpu::Backends,
    /// Direct3D 12 shaders go through FXC (rather than whatever wgpu would pick).
    pub fxc: bool,
    /// The attempt follows the environment's choice (`WGPU_BACKEND`, `WGPU_DX12_COMPILER`) alone.
    pub from_env: bool,
}

impl Attempt {
    pub fn descriptor(&self) -> wgpu::InstanceDescriptor {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
        if !self.from_env {
            descriptor.backends = self.backends;
            if self.fxc {
                descriptor.backend_options.dx12.shader_compiler = wgpu::Dx12Compiler::Fxc;
            }
        }
        descriptor
    }
}

/// The attempts, in order, for a platform and the environment's choices.
pub fn attempts_for(windows: bool, backend_env: Option<wgpu::Backends>, compiler_env: bool) -> Vec<Attempt> {
    if backend_env.is_some() || !windows {
        return vec![Attempt { name: if backend_env.is_some() { "the backend WGPU_BACKEND names".into() } else { "wgpu's own choice".into() }, backends: wgpu::Backends::all(), fxc: false, from_env: true }];
    }
    vec![
        Attempt { name: "Direct3D 12 with FXC".into(), backends: wgpu::Backends::DX12, fxc: !compiler_env, from_env: false },
        Attempt { name: "the other backends".into(), backends: wgpu::Backends::all().difference(wgpu::Backends::DX12), fxc: false, from_env: false },
    ]
}

/// The attempts for this process.
pub fn attempts(windows: bool) -> Vec<Attempt> {
    attempts_for(windows, wgpu::Backends::from_env(), wgpu::Dx12Compiler::from_env().is_some())
}

/// The descriptors installed in a toolkit host, with the same ordered fallback as the engine.
pub fn descriptors() -> Vec<wgpu::InstanceDescriptor> {
    attempts(wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12))
        .iter().map(Attempt::descriptor).collect()
}
