//! Today's workspace view (`app.mjs`, `renderer-geometry.mjs`, `canvas-wheel-zoom.mjs`).
#[cfg(feature = "engine")]
use styk_eval::doc::Camera;
#[cfg(feature = "engine")]
use styk_eval::view::{apply, camera_transform, compose, orientation};

pub const MIN_ZOOM: f64 = 0.001;
pub const MAX_ZOOM: f64 = 100.0;
pub const ZOOM_STEP: f64 = 1.2;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    /// Logical window coordinates; input and layout use these, never backing pixels.
    pub origin: [f64; 2],
    pub size: [f64; 2],
    pub dpr: f64,
    /// Top, right, bottom, left: the layout solver's stage clearance.
    pub insets: [f64; 4],
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            origin: [0.0; 2],
            size: [640.0, 480.0],
            dpr: 1.0,
            insets: [24.0, 28.0, 24.0, 28.0],
        }
    }
}

impl Viewport {
    pub fn valid(&self) -> bool {
        self.origin.iter().all(|x| x.is_finite())
            && self.size.iter().all(|x| x.is_finite() && *x > 0.0)
            && self.dpr.is_finite()
            && self.dpr > 0.0
            && self.insets.iter().all(|x| x.is_finite() && *x >= 0.0)
    }

    pub fn backing_size(&self, quality: f64) -> Option<[u32; 2]> {
        let density = self.dpr * quality;
        let size = self.size.map(|x| (x * density).round().max(1.0));
        (self.valid()
            && quality.is_finite()
            && quality > 0.0
            && quality <= 1.0
            && size.iter().all(|x| x.is_finite() && *x <= u32::MAX as f64))
        .then(|| size.map(|x| x as u32))
    }

    pub fn window_to_stage(&self, point: [f64; 2]) -> [f64; 2] {
        [point[0] - self.origin[0], point[1] - self.origin[1]]
    }
    pub fn stage_to_window(&self, point: [f64; 2]) -> [f64; 2] {
        [point[0] + self.origin[0], point[1] + self.origin[1]]
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub zoom: f64,
    pub pan: [f64; 2],
    pub rotation: f64,
    pub flip: bool,
}

impl Default for View {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            pan: [0.0; 2],
            rotation: 0.0,
            flip: false,
        }
    }
}

impl View {
    pub fn valid(&self) -> bool {
        self.zoom.is_finite()
            && (MIN_ZOOM..=MAX_ZOOM).contains(&self.zoom)
            && self.pan.iter().all(|x| x.is_finite())
            && self.rotation.is_finite()
    }

    #[cfg(feature = "engine")]
    pub fn matrix(&self, canvas: [u32; 2], camera: Option<&Camera>) -> [f64; 6] {
        let upright = camera_transform(camera, canvas, self.zoom, self.pan);
        self.orientation(canvas)
            .map_or(upright, |o| compose(o, upright))
    }

    #[cfg(feature = "engine")]
    pub fn orientation(&self, canvas: [u32; 2]) -> Option<[f64; 6]> {
        orientation(
            self.rotation,
            self.flip,
            [
                self.pan[0] + canvas[0] as f64 * self.zoom / 2.0,
                self.pan[1] + canvas[1] as f64 * self.zoom / 2.0,
            ],
        )
    }

    #[cfg(feature = "engine")]
    pub fn document_to_stage(
        &self,
        point: [f64; 2],
        canvas: [u32; 2],
        camera: Option<&Camera>,
    ) -> [f64; 2] {
        apply(self.matrix(canvas, camera), point)
    }

    #[cfg(feature = "engine")]
    pub fn stage_to_document(
        &self,
        point: [f64; 2],
        canvas: [u32; 2],
        camera: Option<&Camera>,
    ) -> [f64; 2] {
        // Preserve screenToWorld's arithmetic order, also used by the drawing input owner.
        let [a, b, c, d, e, f] = self.matrix(canvas, camera);
        let det = a * d - b * c;
        [
            (d * (point[0] - e) - c * (point[1] - f)) / det,
            (-b * (point[0] - e) + a * (point[1] - f)) / det,
        ]
    }

    pub fn zoom_by(&mut self, factor: f64, anchor: [f64; 2]) -> bool {
        if !factor.is_finite() || !anchor.iter().all(|x| x.is_finite()) {
            return false;
        }
        let zoom = (self.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        let k = zoom / self.zoom;
        let pan = [
            anchor[0] - (anchor[0] - self.pan[0]) * k,
            anchor[1] - (anchor[1] - self.pan[1]) * k,
        ];
        if !pan.iter().all(|x| x.is_finite()) {
            return false;
        }
        self.pan = pan;
        self.zoom = zoom;
        true
    }

    pub fn fit_canvas(canvas: [u32; 2], viewport: &Viewport) -> Self {
        let [top, right, bottom, left] = viewport.insets;
        let width = viewport.size[0] - left - right;
        let height = viewport.size[1] - top - bottom;
        let zoom = (width / canvas[0].max(1) as f64)
            .min(height / canvas[1].max(1) as f64)
            .clamp(0.01, 2.0);
        // Math.round rounds negative ties towards +infinity too.
        let round = |x: f64| (x + 0.5).floor();
        Self {
            zoom,
            pan: [
                round(left + (width - canvas[0] as f64 * zoom) / 2.0),
                round(top + (height - canvas[1] as f64 * zoom) / 2.0),
            ],
            ..Self::default()
        }
    }

    /// Bounds are the engine's conservative artwork bounds, in document coordinates.
    #[cfg(feature = "engine")]
    pub fn fit_selection(
        &mut self,
        bounds: [f64; 4],
        canvas: [u32; 2],
        camera: Option<&Camera>,
        viewport: &Viewport,
    ) -> bool {
        if !bounds.iter().all(|x| x.is_finite()) {
            *self = Self::fit_canvas(canvas, viewport);
            return false;
        }
        let [x0, y0, x1, y1] = bounds;
        let corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
            .map(|p| self.document_to_stage(p, canvas, camera));
        let left = corners.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
        let right = corners
            .iter()
            .map(|p| p[0])
            .fold(f64::NEG_INFINITY, f64::max);
        let top = corners.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
        let bottom = corners
            .iter()
            .map(|p| p[1])
            .fold(f64::NEG_INFINITY, f64::max);
        let center = [(left + right) / 2.0, (top + bottom) / 2.0];
        self.zoom_by(
            ((viewport.size[0] - 120.0) / (right - left).max(1.0))
                .min((viewport.size[1] - 150.0) / (bottom - top).max(1.0)),
            center,
        );
        self.pan[0] += viewport.size[0] / 2.0 - center[0];
        self.pan[1] += viewport.size[1] / 2.0 - 15.0 - center[1];
        true
    }
}

/// Wheel easing uses the injected event time in milliseconds. No timer or system clock.
#[derive(Default)]
pub struct WheelZoom {
    target: Option<f64>,
    anchor: [f64; 2],
    applied: f64,
    last: f64,
    idle_until: Option<f64>,
}

impl WheelZoom {
    pub fn amount(delta: f64) -> f64 {
        -delta.signum() * (delta.abs().min(30.0) * 0.005).max(delta.abs() * 0.003)
    }
    pub fn cancel(&mut self) {
        self.target = None;
        self.idle_until = None;
    }
    pub fn interacting(&self) -> bool {
        self.target.is_some() || self.idle_until.is_some()
    }
    pub fn wheel(
        &mut self,
        view: &mut View,
        delta: f64,
        anchor: [f64; 2],
        now_ms: f64,
        smooth: bool,
        reduced_motion: bool,
    ) {
        if !delta.is_finite() || !now_ms.is_finite() || !anchor.iter().all(|x| x.is_finite()) {
            return;
        }
        if self.target.is_some() && view.zoom != self.applied {
            self.cancel();
        }
        self.idle_until = Some(now_ms + 100.0);
        self.target = Some(
            (self.target.unwrap_or(view.zoom) * Self::amount(delta).exp())
                .clamp(MIN_ZOOM, MAX_ZOOM),
        );
        self.anchor = anchor;
        self.last = now_ms;
        if delta.abs() < 30.0 || !smooth || reduced_motion {
            if let Some(target) = self.target.take() {
                view.zoom_by(target / view.zoom, anchor);
            }
        } else {
            self.step(view, 16.0);
        }
    }
    fn step(&mut self, view: &mut View, elapsed: f64) {
        let Some(target) = self.target else {
            return;
        };
        let remaining = (target / view.zoom).ln();
        let left = (-elapsed / 40.0).exp();
        let settled = remaining.abs() * left < 0.004;
        view.zoom_by(
            if settled {
                target / view.zoom
            } else {
                (remaining * (1.0 - left)).exp()
            },
            self.anchor,
        );
        self.applied = view.zoom;
        if settled {
            self.target = None;
        }
    }
    /// Returns true once a gesture settles, so the host requests its full-detail frame.
    pub fn advance(&mut self, view: &mut View, now_ms: f64) -> bool {
        if !now_ms.is_finite() {
            return false;
        }
        let active = self.interacting();
        if self.target.is_some() && view.zoom != self.applied {
            self.cancel();
            return active;
        }
        if self.idle_until.is_some_and(|deadline| now_ms >= deadline) {
            self.idle_until = None;
        }
        self.step(view, (now_ms - self.last).clamp(0.0, 64.0));
        self.last = now_ms;
        active && !self.interacting()
    }
}
