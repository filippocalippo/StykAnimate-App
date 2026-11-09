//! The adapter and device a native host draws frames with, so that they equal the ones today's app draws
//! (docs/native/frame-parity.md).
//!
//! Chromium's WebGPU draws on Direct3D 12 on Windows. The same frame drawn through Vulkan differs from it in more pixels
//! than through Direct3D 12 with the Windows shader compiler (FXC), so on Windows Direct3D 12 with FXC is *preferred*: it is
//! tried first, and when its instance, adapter or device cannot be had (a driver that exposes the GPU through Vulkan only, a
//! missing capability) the other backends are tried in turn, so a machine that can draw still draws. FXC is named
//! outright, never a DXC that happens to be on the search path (the copy shipped with Electron crashes wgpu).
//! `WGPU_BACKEND` and `WGPU_DX12_COMPILER` still decide when set: an explicit choice is the only attempt. Elsewhere wgpu's
//! own choice is the only attempt.

use crate::wgpu;

#[path = "../../../shared/native_gpu_policy.rs"]
mod policy;
pub use policy::{Attempt, attempts, attempts_for, descriptors};

/// The first attempt `open` succeeds with, or every attempt's reason.
pub fn open_first<T>(attempts: &[Attempt], mut open: impl FnMut(&Attempt) -> Result<T, String>) -> Result<(T, Attempt), String> {
    let mut reasons = Vec::new();
    for attempt in attempts {
        match open(attempt) {
            Ok(opened) => return Ok((opened, attempt.clone())),
            Err(reason) => reasons.push(format!("{}: {reason}", attempt.name)),
        }
    }
    Err(format!("No GPU device: {}", reasons.join("; ")))
}

/// An adapter and its device.
pub struct NativeGpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// Which attempt gave it.
    pub attempt: Attempt,
}

/// Opens one attempt: an instance, the high-performance adapter and a device with `limits(adapter)`.
pub fn open_attempt(attempt: &Attempt, label: &str, limits: &impl Fn(&wgpu::Adapter) -> wgpu::Limits) -> Result<(wgpu::Instance, wgpu::Adapter, wgpu::Device, wgpu::Queue), String> {
    let instance = wgpu::Instance::new(attempt.descriptor());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| format!("no adapter ({e})"))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some(label), required_limits: limits(&adapter), ..Default::default() })).map_err(|e| format!("no device ({e})"))?;
    Ok((instance, adapter, device, queue))
}

/// The GPU a native host draws with: Direct3D 12 first on Windows, then the other backends (see the module).
pub fn native_gpu(windows: bool, label: &str, limits: impl Fn(&wgpu::Adapter) -> wgpu::Limits) -> Result<NativeGpu, String> {
    let ((instance, adapter, device, queue), attempt) = open_first(&attempts(windows), |attempt| open_attempt(attempt, label, &limits))?;
    Ok(NativeGpu { instance, adapter, device, queue, attempt })
}
