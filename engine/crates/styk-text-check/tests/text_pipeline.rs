//! The text pipeline on a device with and without two-source blending, which subpixel text needs.
//!
//! cryoglyph builds its shader in one of two variants by what the device can do. Each must validate and build the
//! pipeline, and the atlas must say whether subpixel text is on. A machine without a suitable adapter skips the
//! variant it cannot test.

use cryoglyph::{Cache, TextAtlas, TextRenderer};
use wgpu::{DeviceDescriptor, ErrorFilter, Features, Instance, InstanceDescriptor, MultisampleState, RequestAdapterOptions, TextureFormat};

/// Builds the pipeline on a device with exactly `features`; what the atlas says about subpixel text, or `None` where the
/// machine has no such device.
fn build(features: Features) -> Option<bool> {
    let instance = Instance::new(InstanceDescriptor { backends: wgpu::Backends::PRIMARY, ..InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&RequestAdapterOptions::default())).ok()?;
    if !adapter.features().contains(features) {
        return None;
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&DeviceDescriptor { required_features: features, ..DeviceDescriptor::default() })).ok()?;
    let scope = device.push_error_scope(ErrorFilter::Validation);
    let cache = Cache::new(&device);
    let mut atlas = TextAtlas::new(&device, &queue, &cache, TextureFormat::Bgra8UnormSrgb);
    let _renderer = TextRenderer::new(&mut atlas, &device, MultisampleState::default(), None);
    let error = pollster::block_on(scope.pop());
    assert!(error.is_none(), "the pipeline for {features:?} does not validate: {error:?}");
    Some(atlas.subpixel_supported())
}

#[test]
fn without_two_source_blending_the_pipeline_builds_and_text_stays_grayscale() {
    if let Some(subpixel) = build(Features::empty()) {
        assert!(!subpixel);
    }
}

#[test]
fn with_two_source_blending_the_pipeline_builds_and_subpixel_text_is_on() {
    if let Some(subpixel) = build(Features::DUAL_SOURCE_BLENDING) {
        assert!(subpixel);
    }
}
