//! Adapters for the tests that draw on a GPU.
//!
//! A test that needs a GPU fails when there is none, with the reason, so a machine without one cannot pass it by checking
//! nothing; `STYK_ALLOW_NO_GPU=1` says on purpose that the run has none and ignores them.

use styk_render::wgpu;

/// Whether the run says it has no GPU on purpose.
pub fn allowed_without() -> bool {
    std::env::var("STYK_ALLOW_NO_GPU").is_ok_and(|v| v == "1")
}

/// A device of the first adapter of `backends` that gives one, or why none did.
pub fn device(instance: &wgpu::Instance, backends: wgpu::Backends) -> Result<(wgpu::Adapter, wgpu::Device, wgpu::Queue), String> {
    let mut reasons = Vec::new();
    for adapter in pollster::block_on(instance.enumerate_adapters(backends)) {
        let info = adapter.get_info();
        if info.device_type == wgpu::DeviceType::Cpu {
            continue;
        }
        match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())) {
            Ok((device, queue)) => return Ok((adapter, device, queue)),
            Err(e) => reasons.push(format!("{:?} {}: {e}", info.backend, info.name)),
        }
    }
    Err(if reasons.is_empty() { format!("no adapter of {backends:?}") } else { reasons.join("; ") })
}

/// Fails the test, or ends it quietly when the run allows no GPU.
pub fn missing(what: &str) {
    if allowed_without() {
        eprintln!("ignored: {what} (STYK_ALLOW_NO_GPU=1)");
    } else {
        panic!("{what}: this test needs a GPU (set STYK_ALLOW_NO_GPU=1 to run without one)");
    }
}
