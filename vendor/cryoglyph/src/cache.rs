use crate::{GlyphToRender, Params};
use wgpu::{
    BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutEntry,
    BindingResource, BindingType, BlendState, Buffer, BufferBindingType, ColorTargetState,
    ColorWrites, DepthStencilState, Device, FilterMode, FragmentState, MultisampleState,
    PipelineCompilationOptions, PipelineLayout, PipelineLayoutDescriptor, PrimitiveState,
    PrimitiveTopology, RenderPipeline, RenderPipelineDescriptor, Sampler, SamplerBindingType,
    SamplerDescriptor, ShaderModule, ShaderModuleDescriptor, ShaderSource, ShaderStages,
    TextureFormat, TextureSampleType, TextureView, TextureViewDimension, VertexFormat, VertexState,
};

use std::borrow::Cow;
use std::mem;
use std::num::NonZeroU64;
use std::ops::Deref;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct Cache(Arc<Inner>);

#[derive(Debug)]
struct Inner {
    sampler: Sampler,
    shader: ShaderModule,
    /// Whether the device blends with two sources, which subpixel text needs.
    dual_source: bool,
    vertex_buffers: [Option<wgpu::VertexBufferLayout<'static>>; 1],
    atlas_layout: BindGroupLayout,
    uniforms_layout: BindGroupLayout,
    pipeline_layout: PipelineLayout,
    cache: Mutex<
        Vec<(
            TextureFormat,
            MultisampleState,
            Option<DepthStencilState>,
            RenderPipeline,
        )>,
    >,
}

/// The shader with the blocks of the other variant removed (`//@dual:begin` .. `//@dual:end` exist only with two-source
/// blending, `//@single:begin` .. `//@single:end` only without).
fn shader_source(dual_source: bool) -> String {
    let (drop_begin, drop_end) = if dual_source { ("//@single:begin", "//@single:end") } else { ("//@dual:begin", "//@dual:end") };
    let mut dropping = false;
    let mut source = String::new();
    for line in include_str!("shader.wgsl").lines() {
        let trimmed = line.trim();
        if trimmed == drop_begin {
            dropping = true;
        } else if trimmed == drop_end {
            dropping = false;
        } else if !dropping && !trimmed.starts_with("//@") {
            source.push_str(line);
            source.push('\n');
        }
    }
    source
}

impl Cache {
    /// Whether the device can draw subpixel text.
    pub fn subpixel_supported(&self) -> bool {
        self.0.dual_source
    }

    pub fn new(device: &Device) -> Self {
        let sampler = device.create_sampler(&SamplerDescriptor {
            label: Some("glyphon sampler"),
            min_filter: FilterMode::Nearest,
            mag_filter: FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            lod_min_clamp: 0f32,
            lod_max_clamp: 0f32,
            ..Default::default()
        });

        // Subpixel text blends each channel by its own coverage: a second fragment output. Where the device cannot,
        // the shader has no such entry and text is drawn in grayscale, which is correct everywhere.
        let dual_source = device.features().contains(wgpu::Features::DUAL_SOURCE_BLENDING);
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("glyphon shader"),
            source: ShaderSource::Wgsl(Cow::Owned(shader_source(dual_source))),
        });

        let vertex_buffer_layout = wgpu::VertexBufferLayout {
            array_stride: mem::size_of::<GlyphToRender>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &[
                wgpu::VertexAttribute {
                    format: VertexFormat::Sint32x2,
                    offset: 0,
                    shader_location: 0,
                },
                wgpu::VertexAttribute {
                    format: VertexFormat::Uint32,
                    offset: mem::size_of::<u32>() as u64 * 2,
                    shader_location: 1,
                },
                wgpu::VertexAttribute {
                    format: VertexFormat::Uint32,
                    offset: mem::size_of::<u32>() as u64 * 3,
                    shader_location: 2,
                },
                wgpu::VertexAttribute {
                    format: VertexFormat::Uint32,
                    offset: mem::size_of::<u32>() as u64 * 4,
                    shader_location: 3,
                },
                wgpu::VertexAttribute {
                    format: VertexFormat::Uint32,
                    offset: mem::size_of::<u32>() as u64 * 5,
                    shader_location: 4,
                },
                wgpu::VertexAttribute {
                    format: VertexFormat::Float32,
                    offset: mem::size_of::<u32>() as u64 * 6,
                    shader_location: 5,
                },
            ],
        };

        let atlas_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            entries: &[
                BindGroupLayoutEntry {
                    binding: 0,
                    visibility: ShaderStages::VERTEX | ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        multisampled: false,
                        view_dimension: TextureViewDimension::D2,
                        sample_type: TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 1,
                    visibility: ShaderStages::VERTEX | ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        multisampled: false,
                        view_dimension: TextureViewDimension::D2,
                        sample_type: TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 2,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering),
                    count: None,
                },
            ],
            label: Some("glyphon atlas bind group layout"),
        });

        let uniforms_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            entries: &[BindGroupLayoutEntry {
                binding: 0,
                visibility: ShaderStages::VERTEX | ShaderStages::FRAGMENT,
                ty: BindingType::Buffer {
                    ty: BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: NonZeroU64::new(mem::size_of::<Params>() as u64),
                },
                count: None,
            }],
            label: Some("glyphon uniforms bind group layout"),
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&atlas_layout), Some(&uniforms_layout)],
            immediate_size: 0,
        });

        Self(Arc::new(Inner {
            sampler,
            shader,
            dual_source,
            vertex_buffers: [Some(vertex_buffer_layout)],
            uniforms_layout,
            atlas_layout,
            pipeline_layout,
            cache: Mutex::new(Vec::new()),
        }))
    }

    pub(crate) fn create_atlas_bind_group(
        &self,
        device: &Device,
        color_atlas: &TextureView,
        mask_atlas: &TextureView,
    ) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            layout: &self.0.atlas_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(color_atlas),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::TextureView(mask_atlas),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::Sampler(&self.0.sampler),
                },
            ],
            label: Some("glyphon atlas bind group"),
        })
    }

    pub(crate) fn create_uniforms_bind_group(&self, device: &Device, buffer: &Buffer) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            layout: &self.0.uniforms_layout,
            entries: &[BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
            label: Some("glyphon uniforms bind group"),
        })
    }

    pub(crate) fn get_or_create_pipeline(
        &self,
        device: &Device,
        format: TextureFormat,
        multisample: MultisampleState,
        depth_stencil: Option<DepthStencilState>,
    ) -> RenderPipeline {
        let Inner {
            cache,
            pipeline_layout,
            shader,
            vertex_buffers,
            dual_source,
            ..
        } = self.0.deref();

        let mut cache = cache.lock().expect("Write pipeline cache");

        cache
            .iter()
            .find(|(fmt, ms, ds, _)| fmt == &format && ms == &multisample && ds == &depth_stencil)
            .map(|(_, _, _, p)| p.clone())
            .unwrap_or_else(|| {
                let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
                    label: Some("glyphon pipeline"),
                    layout: Some(pipeline_layout),
                    vertex: VertexState {
                        module: shader,
                        entry_point: Some("vs_main"),
                        buffers: vertex_buffers,
                        compilation_options: PipelineCompilationOptions::default(),
                    },
                    fragment: Some(FragmentState {
                        module: shader,
                        entry_point: Some("fs_main"),
                        targets: &[Some(ColorTargetState {
                            format,
                            blend: Some(if *dual_source {
                                // Each channel blends by its own coverage: out = text * coverage + destination * (1 - coverage).
                                // A grayscale glyph gives the same coverage on every channel, which is ordinary alpha blending.
                                BlendState {
                                    color: wgpu::BlendComponent {
                                        src_factor: wgpu::BlendFactor::Src1,
                                        dst_factor: wgpu::BlendFactor::OneMinusSrc1,
                                        operation: wgpu::BlendOperation::Add,
                                    },
                                    alpha: BlendState::ALPHA_BLENDING.alpha,
                                }
                            } else {
                                BlendState::ALPHA_BLENDING
                            }),
                            write_mask: ColorWrites::default(),
                        })],
                        compilation_options: PipelineCompilationOptions::default(),
                    }),
                    primitive: PrimitiveState {
                        topology: PrimitiveTopology::TriangleStrip,
                        ..PrimitiveState::default()
                    },
                    depth_stencil: depth_stencil.clone(),
                    multisample,
                    multiview_mask: None,
                    cache: None,
                });

                cache.push((format, multisample, depth_stencil, pipeline.clone()));

                pipeline
            })
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::shader_source;

    #[test]
    fn each_variant_of_the_shader_has_only_its_own_blocks() {
        let (dual, single) = (shader_source(true), shader_source(false));
        assert!(dual.starts_with("enable dual_source_blending;") && dual.contains("@blend_src(1)") && dual.contains("case 2u"));
        assert!(!single.contains("dual_source_blending") && !single.contains("blend_src") && !single.contains("case 2u"));
        for source in [&dual, &single] {
            assert!(source.contains("fn fs_main") && !source.contains("//@"), "markers must not survive");
        }
    }
}
