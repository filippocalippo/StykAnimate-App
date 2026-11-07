//! The toolkit-independent stage host. See `docs/native/stage.md`.
pub mod input;
mod painter;
pub mod picking;
mod view;
use crate::engine::wgpu;
pub use painter::{PaintError, PaintLimits, PaintStatus, Painter};
pub use view::{MAX_ZOOM, MIN_ZOOM, View, Viewport, WheelZoom, ZOOM_STEP};

/// Startup wiring for the toolkit's generic instance-policy hook. The engine
/// remains the sole owner of preferred backends, compiler overrides and fallback.
pub fn gpu_instances() -> Vec<wgpu::InstanceDescriptor> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        styk_render::native_gpu::attempts(
            wgpu::Instance::enabled_backend_features().contains(wgpu::Backends::DX12),
        )
        .iter()
        .map(|attempt| attempt.descriptor())
        .collect()
    }
    #[cfg(target_arch = "wasm32")]
    {
        vec![wgpu::InstanceDescriptor::new_without_display_handle()]
    }
}

use crate::engine::SceneOptions;
use crate::frames::{self, Consumer, Frames};
use std::sync::Arc;

/// One document's stage; document and frame workers keep their existing owners.
pub struct Host {
    frames: Frames,
    canvas: [u32; 2],
    viewport: Viewport,
    view: View,
    fitted_snapshot: View,
    wheel: WheelZoom,
    pan_idle: Option<f64>,
    pub(crate) pan_gesture: Option<(u32, [f64; 2], [f64; 2])>,
}

impl Host {
    pub fn new(
        frames: Frames,
        canvas: [u32; 2],
        viewport: Viewport,
    ) -> Result<Self, frames::Error> {
        if !viewport.valid() || canvas.contains(&0) {
            return Err(frames::Error::InvalidRequest);
        }
        let view = View::fit_canvas(canvas, &viewport);
        Ok(Self {
            frames,
            canvas,
            viewport,
            view,
            fitted_snapshot: view,
            wheel: WheelZoom::default(),
            pan_gesture: None,
            pan_idle: None,
        })
    }
    pub fn view(&self) -> View {
        self.view
    }
    pub fn viewport(&self) -> Viewport {
        self.viewport
    }
    pub fn canvas(&self) -> [u32; 2] {
        self.canvas
    }
    pub fn fitted(&self) -> bool {
        self.view.rotation == 0.0
            && !self.view.flip
            && self.view.zoom == self.fitted_snapshot.zoom
            && (self.view.pan[0] - self.fitted_snapshot.pan[0]).abs() < 0.5
            && (self.view.pan[1] - self.fitted_snapshot.pan[1]).abs() < 0.5
    }
    pub fn interacting(&self) -> bool {
        self.wheel.interacting() || self.pan_gesture.is_some() || self.pan_idle.is_some()
    }
    pub fn frames(&self) -> &Frames {
        &self.frames
    }
    pub fn frames_mut(&mut self) -> &mut Frames {
        &mut self.frames
    }

    fn changed(&mut self) -> Result<(), frames::Error> {
        self.frames.cancel(Consumer::Stage)
    }

    pub fn set_view(&mut self, view: View) -> Result<(), frames::Error> {
        if !view.valid() {
            return Err(frames::Error::InvalidRequest);
        }
        self.changed()?;
        self.view = view;
        self.wheel.cancel();
        Ok(())
    }
    /// Apply the document service's canvas dimensions after a scene-size edit.
    /// The caller also advances the scheduler revision through `Frames::revise`.
    pub fn set_canvas(&mut self, canvas: [u32; 2]) -> Result<(), frames::Error> {
        if canvas.contains(&0) {
            return Err(frames::Error::InvalidRequest);
        }
        self.changed()?;
        let fitted = self.fitted();
        self.canvas = canvas;
        if fitted {
            self.view = View::fit_canvas(canvas, &self.viewport);
            self.fitted_snapshot = self.view;
        }
        Ok(())
    }
    pub fn resize(&mut self, viewport: Viewport) -> Result<(), frames::Error> {
        if !viewport.valid() {
            return Err(frames::Error::InvalidRequest);
        }
        self.changed()?;
        let fitted = self.fitted();
        self.viewport = viewport;
        if fitted {
            self.view = View::fit_canvas(self.canvas, &self.viewport);
            self.fitted_snapshot = self.view;
        }
        Ok(())
    }
    pub fn fit_canvas(&mut self) -> Result<(), frames::Error> {
        self.changed()?;
        self.wheel.cancel();
        self.view = View::fit_canvas(self.canvas, &self.viewport);
        self.fitted_snapshot = self.view;
        Ok(())
    }
    pub fn fit_selection(
        &mut self,
        bounds: [f64; 4],
        camera: Option<&crate::engine::doc::Camera>,
    ) -> Result<(), frames::Error> {
        self.changed()?;
        self.wheel.cancel();
        if !self
            .view
            .fit_selection(bounds, self.canvas, camera, &self.viewport)
        {
            self.fitted_snapshot = self.view;
        }
        Ok(())
    }
    pub fn zoom_by(&mut self, factor: f64, anchor: Option<[f64; 2]>) -> Result<(), frames::Error> {
        let mut view = self.view;
        if !view.zoom_by(
            factor,
            anchor.unwrap_or(self.viewport.size.map(|x| x / 2.0)),
        ) {
            return Err(frames::Error::InvalidRequest);
        }
        self.set_view(view)
    }
    pub fn pan_by(&mut self, delta: [f64; 2]) -> Result<(), frames::Error> {
        let mut view = self.view;
        view.pan = [view.pan[0] + delta[0], view.pan[1] + delta[1]];
        self.set_view(view)
    }
    pub fn wheel(
        &mut self,
        delta: f64,
        point: [f64; 2],
        now_ms: f64,
        smooth: bool,
        reduced_motion: bool,
    ) -> Result<(), frames::Error> {
        if !delta.is_finite() || !now_ms.is_finite() || !point.iter().all(|x| x.is_finite()) {
            return Err(frames::Error::InvalidRequest);
        }
        self.changed()?;
        self.wheel
            .wheel(&mut self.view, delta, point, now_ms, smooth, reduced_motion);
        Ok(())
    }
    pub fn advance(&mut self, now_ms: f64) -> Result<bool, frames::Error> {
        if !now_ms.is_finite() {
            return Err(frames::Error::InvalidRequest);
        }
        let old = self.view;
        let settled = self.wheel.advance(&mut self.view, now_ms);
        let pan_settled = self.pan_idle.is_some_and(|until| now_ms >= until);
        if pan_settled {
            self.pan_idle = None;
        }
        if old != self.view {
            self.changed()?;
        }
        Ok(settled || pan_settled || old != self.view)
    }

    /// Default wheel gesture, including Shift's horizontal-axis swap. Input
    /// routing chooses this or `wheel` from the settings and Ctrl/Meta state.
    pub fn wheel_pan(
        &mut self,
        delta: [f64; 2],
        shift: bool,
        now_ms: f64,
    ) -> Result<(), frames::Error> {
        if !now_ms.is_finite() {
            return Err(frames::Error::InvalidRequest);
        }
        let delta = if shift {
            [-delta[1], -delta[0]]
        } else {
            delta.map(|x| -x)
        };
        self.pan_by(delta)?;
        self.pan_idle = Some(now_ms + 100.0);
        Ok(())
    }

    /// The only stage frame request path. Pan/zoom/rotation/DPI are all in its key.
    pub fn request(
        &mut self,
        tick: f64,
        quality: f64,
        samples: u8,
        scene: SceneOptions,
    ) -> Result<frames::Key, frames::Error> {
        let size = self
            .viewport
            .backing_size(quality)
            .ok_or(frames::Error::InvalidRequest)?;
        let density = self.viewport.dpr * quality;
        self.frames.request(
            Consumer::Stage,
            tick,
            Arc::new(frames::View {
                size,
                zoom: self.view.zoom * density,
                pan: self.view.pan.map(|x| x * density),
                rotation: self.view.rotation,
                flip: self.view.flip,
                quality,
                samples,
                scene,
            }),
        )
    }
    pub fn close(&mut self) {
        self.frames.close();
    }
}
