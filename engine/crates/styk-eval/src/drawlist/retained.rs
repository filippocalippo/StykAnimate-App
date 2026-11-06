//! Worker-only accounting of the encoder's retained CPU allocations.
use super::DrawList;
use crate::geometry::{Resolved, arc_allocation};
use crate::vfx::Effect;
use std::any::TypeId;
use std::collections::HashSet;
use std::mem::size_of;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RetainedBytesError {
    #[error("draw-list retained allocation size overflow")]
    Overflow,
    #[error("draw-list layer {layer} contains an unknown effect payload")]
    UnknownEffects { layer: usize },
}

/// One transient identity set for an immutable worker observation. Owners stay
/// strongly held during the walk; addresses are never registered across calls.
#[derive(Default)]
pub(crate) struct AllocationObservation {
    bytes: usize,
    seen: HashSet<(TypeId, *const ())>,
    pub(crate) resolved: Resolved,
}
impl AllocationObservation {
    pub(crate) fn add(&mut self, bytes: usize) -> Result<(), RetainedBytesError> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or(RetainedBytesError::Overflow)?;
        Ok(())
    }
    pub(crate) fn buffer<T>(&mut self, values: &Vec<T>) -> Result<(), RetainedBytesError> {
        self.add(
            values
                .capacity()
                .checked_mul(size_of::<T>())
                .ok_or(RetainedBytesError::Overflow)?,
        )
    }
    pub(crate) fn text(&mut self, text: &String) -> Result<(), RetainedBytesError> {
        self.add(text.capacity())
    }
    fn erased_arc<T: 'static>(
        &mut self,
        pointer: *const (),
        elements: usize,
    ) -> Result<bool, RetainedBytesError> {
        if !self.seen.insert((TypeId::of::<T>(), pointer)) {
            return Ok(false);
        }
        self.add(arc_allocation::<T>(elements).ok_or(RetainedBytesError::Overflow)?)?;
        Ok(true)
    }
    pub(crate) fn arc<T: 'static>(&mut self, value: &Arc<T>) -> Result<bool, RetainedBytesError> {
        self.erased_arc::<T>(Arc::as_ptr(value) as *const (), 1)
    }
    pub(crate) fn slice<T: 'static>(
        &mut self,
        value: &Arc<[T]>,
    ) -> Result<bool, RetainedBytesError> {
        // Slice and sized domains are distinct even for a one-element slice.
        if !self
            .seen
            .insert((TypeId::of::<[T]>(), Arc::as_ptr(value) as *const ()))
        {
            return Ok(false);
        }
        self.add(arc_allocation::<T>(value.len()).ok_or(RetainedBytesError::Overflow)?)?;
        Ok(true)
    }
    pub(crate) fn checked_bytes(&self) -> Result<usize, RetainedBytesError> {
        self.bytes
            .checked_add(
                self.resolved
                    .checked_bytes()
                    .ok_or(RetainedBytesError::Overflow)?,
            )
            .ok_or(RetainedBytesError::Overflow)
    }
    /// The DrawList header is handled by the caller: standalone eventual Arc,
    /// or an actual Arc visited once in a multi-owner observation.
    pub(crate) fn list_payload(
        &mut self,
        list: &DrawList,
        check: &mut impl FnMut() -> bool,
    ) -> Result<bool, RetainedBytesError> {
        self.buffer(&list.prims)?;
        self.buffer(&list.paints)?;
        self.buffer(&list.points)?;
        self.buffer(&list.groups)?;
        self.buffer(&list.passes)?;
        self.buffer(&list.layers)?;
        self.buffer(&list.glyphs)?;
        for (layer, value) in list.layers.iter().enumerate() {
            if !check() {
                return Ok(false);
            }
            let Some(effects) = &value.effects else {
                continue;
            };
            let Some(stack) = effects.downcast_ref::<Vec<Arc<Effect>>>() else {
                return Err(RetainedBytesError::UnknownEffects { layer });
            };
            if self.erased_arc::<Vec<Arc<Effect>>>(Arc::as_ptr(effects) as *const (), 1)? {
                self.buffer(stack)?;
                for effect in stack {
                    if !check() {
                        return Ok(false);
                    }
                    self.resolved.effect(effect);
                }
            }
        }
        for glyph in &list.glyphs {
            if !check() {
                return Ok(false);
            }
            self.slice(&glyph.triangles)?;
        }
        Ok(true)
    }
}

/// Requested retained CPU allocation bytes for an immutable encoder result.
/// Run once on its worker, never on readiness/presentation paths. Vec capacities
/// (including passes), Arc headers/alignment, typed stack containers, resolved
/// effects/paints/ids and glyph triangle slices are counted. Shared allocations
/// inside this list count once; separate retained payloads may charge them again.
/// Includes the eventual DrawList Arc allocation. No Arc is retained; the
/// existing parameter accessor may briefly clone a paint Arc while inspecting it.
/// Unknown public Any payloads and overflow refuse an accounting result.
///
/// Scratch HashSets are transient worker work. Authored documents, Frame/Scene,
/// Generation/Assets, renderer/GPU resources and allocator overhead are outside
/// this charge. This neither reserves memory nor changes logical `bytes()` or
/// cache admission. Native callers changing public buffers must recompute it.
pub fn retained_bytes_checked(list: &DrawList) -> Result<usize, RetainedBytesError> {
    let mut owner = AllocationObservation::default();
    owner.add(arc_allocation::<DrawList>(1).ok_or(RetainedBytesError::Overflow)?)?;
    owner.list_payload(list, &mut || true)?;
    owner.checked_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checked_outer_charge_cannot_wrap() {
        let mut bytes = AllocationObservation::default();
        bytes.add(usize::MAX).unwrap();
        assert_eq!(bytes.add(1), Err(RetainedBytesError::Overflow));
        assert_eq!(bytes.bytes, usize::MAX);
    }
}
