//! Typed VFX ownership visitor; resolved effect/paint/id accounting stays in Resolved.
use super::{Effect, FrameVfx, Stacks};
use crate::eval::retained::{Reason, Visitor};
use std::sync::Arc;

pub(crate) fn slice(visitor: &mut Visitor<'_>, value: &Arc<[Arc<Effect>]>) -> Result<(), Reason> {
    visitor.check()?;
    if visitor.allocations.slice(value)? {
        for effect in value.iter() {
            visitor.check()?;
            visitor.allocations.resolved.effect(effect);
        }
    }
    Ok(())
}
fn stack(visitor: &mut Visitor<'_>, value: &Vec<Arc<Effect>>) -> Result<(), Reason> {
    visitor.allocations.buffer(value)?;
    for effect in value {
        visitor.check()?;
        visitor.allocations.resolved.effect(effect);
    }
    Ok(())
}
pub(crate) fn stacks(visitor: &mut Visitor<'_>, value: &Arc<Stacks>) -> Result<(), Reason> {
    visitor.check()?;
    if visitor.allocations.arc(value)? {
        visitor.allocations.buffer(&value.entries)?;
        for (_, effects) in &value.entries {
            slice(visitor, effects)?;
        }
    }
    Ok(())
}
pub(crate) fn frame(visitor: &mut Visitor<'_>, value: &Arc<FrameVfx>) -> Result<(), Reason> {
    visitor.check()?;
    if !visitor.allocations.arc(value)? {
        return Ok(());
    }
    stack(visitor, &value.scene)?;
    visitor.allocations.buffer(&value.objects)?;
    visitor.allocations.buffer(&value.roots)?;
    visitor.allocations.buffer(&value.generators)?;
    visitor.allocations.buffer(&value.warnings)?;
    for warning in &value.warnings {
        visitor.check()?;
        visitor.allocations.text(warning)?;
    }
    for object in value.objects.iter().flatten() {
        visitor.check()?;
        stack(visitor, &object.figure)?;
        visitor.allocations.buffer(&object.segments)?;
        for (_, effects) in &object.segments {
            visitor.check()?;
            stack(visitor, effects)?;
        }
        if let Some(attached) = &object.attached {
            visitor.check()?;
            stack(visitor, &attached.stack)?;
            visitor.allocations.buffer(&attached.members)?;
        }
    }
    for generator in &value.generators {
        visitor.check()?;
        visitor.allocations.resolved.effect(&generator.effect);
    }
    Ok(())
}
