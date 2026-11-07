//! A native host prefers Direct3D 12 with FXC on Windows and falls back to the other backends when it cannot have it; an
//! explicit `WGPU_BACKEND` is the only attempt (docs/native/frame-parity.md).

#[path = "support/gpu.rs"]
#[allow(dead_code)]
mod gpu;

use styk_render::native_gpu::{attempts_for, native_gpu, open_attempt, open_first};
use styk_render::wgpu;

#[test]
fn windows_prefers_direct3d_12_with_fxc_then_the_others() {
    let list = attempts_for(true, None, false);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].backends, wgpu::Backends::DX12);
    assert!(list[0].fxc, "FXC is named, never a DXC found on the search path");
    assert!(!list[1].backends.contains(wgpu::Backends::DX12) && list[1].backends.contains(wgpu::Backends::VULKAN), "then the others");
    assert!(!attempts_for(true, None, true)[0].fxc, "WGPU_DX12_COMPILER decides when set");
}

#[test]
fn an_explicit_backend_or_another_platform_is_the_only_attempt() {
    for (windows, env) in [(true, Some(wgpu::Backends::VULKAN)), (true, Some(wgpu::Backends::DX12)), (false, None), (false, Some(wgpu::Backends::GL))] {
        let list = attempts_for(windows, env, false);
        assert_eq!(list.len(), 1, "windows {windows}, backend {env:?}");
        assert!(list[0].from_env);
    }
}

#[test]
fn when_direct3d_12_fails_the_other_backends_give_the_device() {
    // The Direct3D 12 attempt is forced to fail; the others are the real thing.
    let mut tried = Vec::new();
    let opened = open_first(&attempts_for(true, None, false), |attempt| {
        tried.push(attempt.name.clone());
        if attempt.backends == wgpu::Backends::DX12 {
            return Err("forced: the Direct3D 12 device cannot be created".to_string());
        }
        open_attempt(attempt, "fallback test", &|adapter: &wgpu::Adapter| wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()))
    });
    match opened {
        Ok(((_, adapter, _, _), attempt)) => {
            assert_eq!(tried, ["Direct3D 12 with FXC", "the other backends"]);
            assert_eq!(attempt.name, "the other backends");
            assert_ne!(adapter.get_info().backend, wgpu::Backend::Dx12);
        }
        Err(reasons) if reasons.contains("no adapter") => gpu::missing(&format!("no adapter outside Direct3D 12 ({reasons})")),
        Err(reasons) => panic!("{reasons}"),
    }
}

#[test]
fn every_attempt_failing_reports_every_reason() {
    let err = open_first::<()>(&attempts_for(true, None, false), |attempt| Err(format!("{:?} refused", attempt.backends))).unwrap_err();
    assert!(err.contains("Direct3D 12 with FXC: Backends(DX12) refused") && err.contains("the other backends:"), "{err}");
}

#[test]
fn the_host_gets_a_device() {
    match native_gpu(cfg!(windows), "native gpu test", |adapter| wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits())) {
        Ok(gpu) => {
            if cfg!(windows) && std::env::var("WGPU_BACKEND").is_err() {
                eprintln!("{} on {:?}", gpu.attempt.name, gpu.adapter.get_info().backend);
            }
        }
        Err(reason) => gpu::missing(&reason),
    }
}
