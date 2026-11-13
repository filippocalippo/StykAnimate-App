//! Which graphics device the browser gives: WebGPU where it has an adapter, else WebGL2 (wgpu's GL backend).
//!
//! wgpu's `new_instance_with_webgpu_detection` asks the browser for an adapter to decide, drops it, and the stage then
//! asks again: two round trips to the browser's graphics process before the device's, and the start of the app waited
//! for each (docs/APP-START.md). Here the adapter is asked for once and kept. A browser without `navigator.gpu`, or
//! one that answers "no adapter" (a driver it does not trust), gets WebGL2, as with the detection.

use styk_render::wgpu;

/// The adapter every device of the engine asks for: the fast card where there are two.
pub(crate) fn adapter_options<'a, 'b>(surface: Option<&'a wgpu::Surface<'b>>) -> wgpu::RequestAdapterOptions<'a, 'b> {
    wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: surface, ..Default::default() }
}

/// The browser's WebGPU adapter and the instance it belongs to, or `None` where it gives none. The browser's WebGPU
/// takes no surface to choose an adapter, so the surface is made on the instance afterwards.
pub(crate) async fn webgpu_adapter() -> Option<(wgpu::Instance, wgpu::Adapter)> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    // Without `navigator.gpu` this is wgpu-core with no backend: it has no adapter to give.
    let instance = wgpu::Instance::new(descriptor);
    let adapter = instance.request_adapter(&adapter_options(None)).await.ok()?;
    (adapter.get_info().backend == wgpu::Backend::BrowserWebGpu).then_some((instance, adapter))
}

/// The WebGL2 instance: its adapter comes from a surface (`adapter_options(Some(&surface))`).
pub(crate) fn webgl_instance() -> wgpu::Instance {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::GL;
    wgpu::Instance::new(descriptor)
}

/// A surface over `target` (a page's or a worker's canvas) and the adapter that draws it: WebGPU where the browser
/// gives an adapter, else WebGL2. A canvas keeps the first kind of context it gives, so the surface is made once the
/// backend is known. The instance is returned for the caller to hold as long as it held it before.
pub(crate) async fn surface_and_adapter(target: wgpu::SurfaceTarget<'static>) -> Result<(wgpu::Instance, wgpu::Surface<'static>, wgpu::Adapter), String> {
    if let Some((instance, adapter)) = webgpu_adapter().await {
        let surface = instance.create_surface(target).map_err(|e| e.to_string())?;
        return Ok((instance, surface, adapter));
    }
    let instance = webgl_instance();
    let surface = instance.create_surface(target).map_err(|e| e.to_string())?;
    let adapter = instance.request_adapter(&adapter_options(Some(&surface))).await.map_err(|e| e.to_string())?;
    Ok((instance, surface, adapter))
}
