//! Module-owned visits of the covered immutable Object/Figure allocations.
use super::*;
use crate::eval::retained::{Reason, Uncovered, Visitor};

pub(crate) fn playback(
    visitor: &mut Visitor<'_>,
    value: &Arc<MovieclipPlayback>,
) -> Result<(), Reason> {
    visitor.check()?;
    if visitor.allocations.arc(value)? {
        visitor.allocations.buffer(&value.restarts)?;
    }
    Ok(())
}

pub(crate) fn object(visitor: &mut Visitor<'_>, value: &Arc<Object>) -> Result<(), Reason> {
    visitor.check()?;
    if !visitor.allocations.arc(value)? {
        return Ok(());
    }
    visitor.allocations.slice(&value.angles)?;
    if let Some(lengths) = &value.lengths {
        visitor.allocations.slice(lengths)?;
    }
    if let Some(bends) = &value.bends {
        visitor.allocations.slice(bends)?;
    }
    if let Some(play) = &value.movieclip {
        playback(visitor, play)?;
    }
    if let Some(style) = &value.style {
        crate::style::observe_allocations(visitor, style)?;
    }
    if let Some(derived) = &value.figure_override {
        figure(visitor, derived)?;
    }
    if let Some(stack) = &value.vfx {
        crate::vfx::retained::stacks(visitor, stack)?;
    }
    if let Some(connected) = &value.vfx_connected {
        crate::vfx::retained::slice(visitor, connected)?;
    }
    if let Some(transition) = &value.color_transition {
        visitor.allocations.arc(transition)?;
    }
    if let Some(spatial) = &value.spatial {
        if visitor.allocations.arc(spatial)? && spatial.shape.is_some() {
            visitor.uncovered.add(Uncovered::SPATIAL_TABLES);
        }
    }
    if value.ik.is_some() {
        visitor.uncovered.add(Uncovered::IK);
    }
    if value.sticknodes_shapes.is_some() || value.sticknodes_sprite.is_some() {
        visitor.uncovered.add(Uncovered::SHAPES);
    }
    if value.origin.is_some() {
        visitor.uncovered.add(Uncovered::ORIGINS);
    }
    Ok(())
}

pub(crate) fn figure(visitor: &mut Visitor<'_>, value: &Arc<Figure>) -> Result<(), Reason> {
    visitor.check()?;
    if !visitor.allocations.arc(value)? {
        return Ok(());
    }
    visitor.allocations.text(&value.name)?;
    visitor.allocations.buffer(&value.segments)?;
    visitor.allocations.buffer(&value.polyfills)?;
    visitor.allocations.buffer(&value.images)?;
    visitor.allocations.buffer(&value.texts)?;
    visitor.allocations.buffer(&value.unsupported)?;
    visitor.allocations.slice(&value.mesh_colors)?;
    for segment in &value.segments {
        visitor.check()?;
        if let Some(name) = &segment.name {
            visitor.allocations.text(name)?;
        }
        if let Some(paint) = &segment.paint {
            visitor.allocations.resolved.paint(paint);
        }
        if segment.sticknodes_shape.is_some() {
            visitor.uncovered.add(Uncovered::SHAPES);
        }
        if segment.rig.is_some() {
            visitor.uncovered.add(Uncovered::RIG);
        }
    }
    for polygon in &value.polyfills {
        visitor.check()?;
        visitor.allocations.buffer(&polygon.joints)?;
        if let Some(surface) = &polygon.surface {
            visitor.allocations.buffer(&surface.depth)?;
        }
    }
    for image in &value.images {
        visitor.check()?;
        if let Some(tiles) = &image.tiles
            && visitor.allocations.arc(tiles)?
        {
            visitor.allocations.buffer(&tiles.tiles)?;
            visitor.allocations.buffer(&tiles.levels)?;
            for (_, _, bytes) in &tiles.tiles {
                visitor.check()?;
                visitor.allocations.slice(bytes)?;
            }
            for level in &tiles.levels {
                visitor.check()?;
                visitor.allocations.buffer(level)?;
            }
        }
    }
    for text in &value.texts {
        visitor.check()?;
        visitor.allocations.buffer(&text.glyphs)?;
        visitor.allocations.buffer(&text.placements)?;
        for glyph in &text.glyphs {
            visitor.check()?;
            if visitor.allocations.arc(glyph)? {
                visitor.allocations.buffer(&glyph.path)?;
            }
        }
    }
    let plan = &value.plan;
    visitor.allocations.buffer(&plan.parent)?;
    visitor.allocations.buffer(&plan.order)?;
    visitor.allocations.buffer(&plan.child_start)?;
    visitor.allocations.buffer(&plan.children)?;
    visitor.allocations.buffer(&plan.polygons)?;
    for polygon in &plan.polygons {
        visitor.check()?;
        visitor.allocations.buffer(&polygon.edges)?;
    }
    if plan.index_of.capacity() != 0 {
        visitor.uncovered.add(Uncovered::MAP_TABLES);
    }
    if plan.rig.is_some() {
        visitor.uncovered.add(Uncovered::RIG);
    }
    if value.movieclip.is_some() {
        visitor.uncovered.add(Uncovered::MOVIECLIPS);
    }
    if value.mesh.is_some() {
        visitor.uncovered.add(Uncovered::MESHES);
    }
    if value.origin.is_some() {
        visitor.uncovered.add(Uncovered::ORIGINS);
    }
    if let Some(base) = &value.base {
        figure(visitor, base)?;
    }
    Ok(())
}
