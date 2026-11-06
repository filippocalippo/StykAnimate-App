//! Private, partial worker allocation observation. No runtime caller/admission.
#![allow(dead_code)] // Deliberate worker prerequisite; activation is separately reviewed.
use super::{Frame, FrameRef};
use crate::doc::Document;
use crate::drawlist::{AllocationObservation, DrawList, RetainedBytesError};
use std::sync::Arc;

/// Strong source owners must outlive the entire call. Their visited allocations
/// seed the one transient identity set and are excluded from the additional
/// result. This is not a complete Document/Prepared/Generation/Assets traversal.
/// Glyph slices are optional known strongly held Assets resources, not a read of
/// mutable fine-glyph caches. No raw Value walk or cross-call address registry.
pub(crate) struct SourceBaseline<'a> {
    pub(crate) document: &'a Arc<Document>,
    pub(crate) glyphs: &'a [Arc<[[f32; 2]]>],
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct Uncovered(u32);
impl Uncovered {
    pub(crate) const SOURCE_OWNERS: u32 = 1;
    pub(crate) const MAP_TABLES: u32 = 2;
    pub(crate) const IK: u32 = 4;
    pub(crate) const RIG: u32 = 8;
    pub(crate) const SHAPES: u32 = 16;
    pub(crate) const ORIGINS: u32 = 32;
    pub(crate) const MESHES: u32 = 64;
    pub(crate) const MOVIECLIPS: u32 = 128;
    pub(crate) const PARALLAX: u32 = 256;
    pub(crate) const SPATIAL_TABLES: u32 = 512;
    pub(crate) const MUTABLE_ASSETS: u32 = 1024;
    pub(crate) fn contains(self, bit: u32) -> bool {
        self.0 & bit != 0
    }
    pub(crate) fn add(&mut self, bit: u32) {
        self.0 |= bit;
    }
}

/// Opaque scalars only; it retains no payload, identities or leases. Covered
/// bytes are requested allocations, excluding the strongly held visited source
/// baseline. Unvisited source branches may share an additional allocation;
/// therefore the result never claims all additions are newly allocated.
/// No whole Frame/Generation total, physical cap or policy change is implied.
pub(crate) struct Descriptor {
    source_covered_bytes: usize,
    additional_covered_bytes: usize,
    uncovered: Uncovered,
}
impl Descriptor {
    pub(crate) fn source_covered_bytes(&self) -> usize {
        self.source_covered_bytes
    }
    pub(crate) fn additional_covered_bytes(&self) -> usize {
        self.additional_covered_bytes
    }
    pub(crate) fn uncovered(&self) -> Uncovered {
        self.uncovered
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Reason {
    Cancelled,
    Accounting(RetainedBytesError),
}
impl From<RetainedBytesError> for Reason {
    fn from(error: RetainedBytesError) -> Self {
        Self::Accounting(error)
    }
}
#[derive(Debug)]
pub(crate) struct Refusal {
    pub(crate) reason: Reason,
    pub(crate) uncovered: Uncovered,
}

pub(crate) struct Visitor<'a> {
    pub(crate) allocations: AllocationObservation,
    pub(crate) uncovered: Uncovered,
    check: &'a mut dyn FnMut() -> bool,
}
impl Visitor<'_> {
    pub(crate) fn check(&mut self) -> Result<(), Reason> {
        if (self.check)() {
            Ok(())
        } else {
            Err(Reason::Cancelled)
        }
    }
    fn frame(&mut self, frame: &Arc<Frame>) -> Result<(), Reason> {
        self.check()?;
        if !self.allocations.arc(frame)? {
            return Ok(());
        }
        self.allocations.buffer(&frame.objects)?;
        self.allocations.buffer(&frame.draw_order)?;
        self.allocations.buffer(&frame.export_vfx)?;
        self.allocations.buffer(&frame.origins)?;
        self.allocations.buffer(&frame.continuations)?;
        for object in &frame.objects {
            crate::doc::retained::object(self, object)?;
        }
        for origin in &frame.origins {
            self.check()?;
            if let Some((FrameRef::Source(id), _)) = origin {
                self.allocations.resolved.string(id);
            }
        }
        for (_, playback) in &frame.continuations {
            crate::doc::retained::playback(self, playback)?;
        }
        if let Some(stack) = &frame.pose_vfx {
            crate::vfx::retained::stacks(self, stack)?;
        }
        if let Some(vfx) = &frame.vfx {
            crate::vfx::retained::frame(self, vfx)?;
        }
        if frame.parallax.is_some() {
            self.uncovered.add(Uncovered::PARALLAX);
        }
        Ok(())
    }
}

/// Explicitly invoked worker-only observation; evaluation and readiness paths
/// never call this. Sparse cancellation checks do not mutate any source/caches.
/// Refusal preserves encountered uncovered bits but returns no usable charge.
pub(crate) fn observe(
    source: SourceBaseline<'_>,
    frames: &[Arc<Frame>],
    lists: &[Arc<DrawList>],
    mut check: impl FnMut() -> bool,
) -> Result<Descriptor, Refusal> {
    let mut visitor = Visitor {
        allocations: AllocationObservation::default(),
        uncovered: Uncovered(Uncovered::SOURCE_OWNERS | Uncovered::MUTABLE_ASSETS),
        check: &mut check,
    };
    let result = (|| -> Result<Descriptor, Reason> {
        visitor.check()?;
        for figure in &source.document.figures {
            crate::doc::retained::figure(&mut visitor, figure)?;
        }
        for key in source
            .document
            .keyframes
            .iter()
            .chain(source.document.frame_sources.values())
        {
            visitor.check()?;
            for object in &key.objects {
                crate::doc::retained::object(&mut visitor, object)?;
            }
            for (_, playback) in &key.continuations {
                crate::doc::retained::playback(&mut visitor, playback)?;
            }
            if let Some(vfx) = &key.vfx {
                crate::vfx::retained::stacks(&mut visitor, vfx)?;
            }
            if let Some(id) = &key.frame_id {
                visitor.allocations.resolved.string(id);
            }
        }
        for image in &source.document.images {
            visitor.check()?;
            visitor.allocations.slice(&image.bytes)?;
        }
        for glyphs in source.glyphs {
            visitor.check()?;
            visitor.allocations.slice(glyphs)?;
        }
        let baseline = visitor.allocations.checked_bytes()?;
        for frame in frames {
            visitor.frame(frame)?;
        }
        for list in lists {
            visitor.check()?;
            if visitor.allocations.arc(list)?
                && !visitor
                    .allocations
                    .list_payload(list, &mut || (visitor.check)())?
            {
                return Err(Reason::Cancelled);
            }
        }
        visitor.check()?;
        let total = visitor.allocations.checked_bytes()?;
        let additional = total
            .checked_sub(baseline)
            .ok_or(RetainedBytesError::Overflow)?;
        Ok(Descriptor {
            source_covered_bytes: baseline,
            additional_covered_bytes: additional,
            uncovered: visitor.uncovered,
        })
    })();
    result.map_err(|reason| Refusal {
        reason,
        uncovered: visitor.uncovered,
    })
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
