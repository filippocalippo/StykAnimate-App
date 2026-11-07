//! A native host draws on the backend that Chromium's WebGPU uses (docs/native/frame-parity.md): Direct3D 12 with the
//! Windows shader compiler on Windows, and wgpu's own choice elsewhere. The environment variables still decide when set.

use styk_render::{native_instance_descriptor, wgpu};

#[test]
fn windows_hosts_get_direct3d_12_with_fxc_unless_the_environment_chooses() {
    let descriptor = native_instance_descriptor();
    if !cfg!(windows) {
        assert_eq!(descriptor.backends, wgpu::Backends::from_env().unwrap_or_default(), "elsewhere wgpu's own choice stands");
        return;
    }
    match wgpu::Backends::from_env() {
        Some(chosen) => assert_eq!(descriptor.backends, chosen, "WGPU_BACKEND decides"),
        None => assert_eq!(descriptor.backends, wgpu::Backends::DX12),
    }
    if wgpu::Dx12Compiler::from_env().is_none() {
        assert!(matches!(descriptor.backend_options.dx12.shader_compiler, wgpu::Dx12Compiler::Fxc), "never a DXC found on the search path");
    }
}
