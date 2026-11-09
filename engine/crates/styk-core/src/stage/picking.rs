//! Queries borrow already-prepared engine geometry; they never build on hover.
//! Tool policy and editing stay with the later Animate/Draw workspace chunks.
use crate::engine::{eval::Frame, geometry::Scene, picking as engine};

/// Core-only query seam. A view never carries a Scene or imports this module.
pub struct Prepared<'a> {
    pub scene: &'a Scene,
    pub frame: &'a Frame,
    pub handles: &'a [engine::Handle],
}
impl Prepared<'_> {
    /// Same reverse order, preferred-figure handling and strict boundaries as
    /// the browser's numeric query binding. The point is in document coordinates;
    /// the optional projection maps both it and the handles into stage coordinates.
    pub fn handle(&self, point: [f64; 2], options: &engine::PickOptions) -> Option<engine::Hit> {
        engine::pick_handle(self.handles, point, options)
    }
    pub fn hover(
        &self,
        point: [f64; 2],
        matrix: [f64; 6],
        preferred_uid: Option<u32>,
    ) -> Option<engine::Hit> {
        self.handle(
            point,
            &engine::PickOptions {
                nearest: true,
                preferred_uid,
                min_radius: 8.0,
                projection: Some(engine::Projection(matrix)),
                ..Default::default()
            },
        )
    }
    pub fn segment(
        &self,
        point: [f64; 2],
        options: &engine::SegmentPickOptions,
    ) -> Result<Option<engine::Hit>, engine::QueryError> {
        engine::pick_segment(self.scene, self.frame, self.handles, point, options)
    }
}
