//! The one resolved effect/id/paint accounting owner, shared with encoding.
use super::{arc, buffer};
use crate::doc::Paint;
use crate::vfx::{Effect, ParamKind, ParamValue};
use std::alloc::Layout;
use std::collections::HashSet;
use std::sync::Arc;

/// Arc's two counters followed by its payload, including alignment padding.
/// Requested allocations are observed independently in encoder allocation tests.
pub(crate) fn arc_allocation<T>(elements: usize) -> Option<usize> {
    let data = Layout::array::<T>(elements).ok()?;
    Some(
        Layout::new::<[usize; 2]>()
            .extend(data)
            .ok()?
            .0
            .pad_to_align()
            .size(),
    )
}

/// Sampling may allocate new effects/paints retained only by the scene/list.
/// The finite registry schema and flat paint stops need no shape/effect walk.
#[derive(Default)]
pub(crate) struct Resolved {
    // Keep the original Scene saturating byte contract exact. The encoded
    // checked result additionally includes physical Arc alignment padding.
    pub(crate) bytes: usize,
    padding: usize,
    overflow: bool,
    effects: HashSet<*const Effect>,
    paints: HashSet<*const Paint>,
    ids: HashSet<*const u8>,
}

impl Resolved {
    fn add(&mut self, bytes: usize) {
        self.overflow |= self.bytes.checked_add(bytes).is_none();
        self.bytes = self.bytes.saturating_add(bytes);
    }

    fn layout(&mut self, physical: Option<usize>, logical: usize) {
        let Some(extra) = physical.and_then(|bytes| bytes.checked_sub(logical)) else {
            self.overflow = true;
            return;
        };
        self.overflow |= self.padding.checked_add(extra).is_none();
        self.padding = self.padding.saturating_add(extra);
    }

    pub(crate) fn effect(&mut self, effect: &Arc<Effect>) {
        if !self.effects.insert(Arc::as_ptr(effect)) {
            return;
        }
        self.add(arc::<Effect>());
        self.layout(arc_allocation::<Effect>(1), arc::<Effect>());
        self.string(&effect.id);
        for (index, spec) in effect.kind().specs().iter().enumerate() {
            if spec.kind == ParamKind::Color
                && let ParamValue::Paint(paint) = effect.params.get(index)
            {
                self.paint(&paint);
            }
        }
    }

    pub(crate) fn string(&mut self, value: &Arc<str>) {
        if self.ids.insert(Arc::as_ptr(value) as *const u8) {
            self.add(value.len());
            self.add(2 * std::mem::size_of::<usize>());
            let logical = value.len().checked_add(2 * std::mem::size_of::<usize>());
            match logical {
                Some(bytes) => self.layout(arc_allocation::<u8>(value.len()), bytes),
                None => self.overflow = true,
            }
        }
    }

    pub(crate) fn paint(&mut self, paint: &Arc<Paint>) {
        if self.paints.insert(Arc::as_ptr(paint)) {
            self.add(arc::<Paint>());
            self.layout(arc_allocation::<Paint>(1), arc::<Paint>());
            self.overflow |= paint
                .stops
                .capacity()
                .checked_mul(std::mem::size_of::<crate::doc::PaintStop>())
                .is_none();
            self.add(buffer(&paint.stops));
        }
    }

    pub(crate) fn stack(&mut self, effects: &[Arc<Effect>]) {
        for effect in effects {
            self.effect(effect);
        }
    }

    pub(crate) fn checked_bytes(&self) -> Option<usize> {
        if self.overflow {
            None
        } else {
            self.bytes.checked_add(self.padding)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checked_resolved_overflow_does_not_change_scene_saturation() {
        let mut owner = Resolved::default();
        owner.add(usize::MAX);
        owner.add(1);
        assert_eq!(owner.bytes, usize::MAX);
        assert_eq!(owner.checked_bytes(), None);
        assert_eq!(arc_allocation::<u64>(usize::MAX), None);
    }
}
