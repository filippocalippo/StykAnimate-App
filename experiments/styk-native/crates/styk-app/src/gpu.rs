//! Bridges the renderer into egui's wgpu frame: the stage renders into its own
//! MSAA targets during `prepare`, then is copied into egui's pass in `paint`.

use std::sync::Arc;

use eframe::egui_wgpu::{self, CallbackResources, CallbackTrait, ScreenDescriptor};
use eframe::wgpu;
use styk_core::assets::Assets;
use styk_core::drawlist::DrawList;
use styk_render::{DecodedImage, Renderer, ViewParams};

pub struct GpuState {
    pub renderer: Renderer,
    sprites_for: usize,
}

impl GpuState {
    pub fn install(render_state: &egui_wgpu::RenderState) {
        let renderer = Renderer::new(&render_state.device, &render_state.queue, render_state.target_format);
        render_state.renderer.write().callback_resources.insert(GpuState { renderer, sprites_for: 0 });
    }
}

pub struct Stage {
    pub list: Arc<DrawList>,
    pub view: ViewParams,
    pub size: [u32; 2],
    pub sprites: (Arc<Assets>, Arc<Vec<DecodedImage>>),
}

impl CallbackTrait for Stage {
    fn prepare(
        &self,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _screen: &ScreenDescriptor,
        encoder: &mut wgpu::CommandEncoder,
        resources: &mut CallbackResources,
    ) -> Vec<wgpu::CommandBuffer> {
        let Some(state) = resources.get_mut::<GpuState>() else { return Vec::new() };
        let key = Arc::as_ptr(&self.sprites.1) as usize;
        if state.sprites_for != key {
            state.renderer.prepare_sprites(&self.sprites.0);
            state.renderer.upload_images(&self.sprites.0, &self.sprites.1);
            state.sprites_for = key;
        }
        state.renderer.set_list(&self.list);
        state.renderer.render(encoder, &self.view, self.size);
        Vec::new()
    }

    fn paint(&self, _info: egui::PaintCallbackInfo, pass: &mut wgpu::RenderPass<'static>, resources: &CallbackResources) {
        if let Some(state) = resources.get::<GpuState>() {
            state.renderer.present(pass);
        }
    }
}
