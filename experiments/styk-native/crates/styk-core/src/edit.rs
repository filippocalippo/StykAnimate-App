//! Posing commands with undo. A pose lives in a keyframe (native timelines) or
//! a pose source (layer sheets); edits replace exactly one object record through
//! copy-on-write `Arc`s, so the previous document revision stays valid for any
//! thread still evaluating it.

use std::sync::Arc;

use crate::doc::{Document, Keyframe, Object};
use crate::eval::FrameRef;

/// The authored record an evaluated object came from.
#[derive(Clone, Debug, PartialEq)]
pub struct PoseRef {
    pub frame: FrameRef,
    pub slot: u32,
}

#[derive(Clone, Debug)]
pub struct Change {
    pub at: PoseRef,
    pub before: Arc<Object>,
    pub after: Arc<Object>,
}

pub fn object(doc: &Document, at: &PoseRef) -> Option<Arc<Object>> {
    let frame = match &at.frame {
        FrameRef::Keyframe(i) => doc.keyframes.get(*i)?,
        FrameRef::Source(id) => doc.frame_sources.get(id)?,
    };
    frame.objects.get(at.slot as usize).cloned()
}

fn frame_mut<'a>(doc: &'a mut Document, at: &PoseRef) -> Option<&'a mut Keyframe> {
    match &at.frame {
        FrameRef::Keyframe(i) => doc.keyframes.get_mut(*i).map(Arc::make_mut),
        FrameRef::Source(id) => doc.frame_sources.get_mut(id).map(Arc::make_mut),
    }
}

/// Replaces one authored object, returning the new document.
pub fn replace(doc: &Document, at: &PoseRef, object: Arc<Object>) -> Option<Document> {
    let mut next = doc.clone();
    let frame = frame_mut(&mut next, at)?;
    let slot = at.slot as usize;
    if slot >= frame.objects.len() || frame.objects[slot].uid != object.uid {
        return None;
    }
    frame.objects[slot] = object;
    Some(next)
}

/// Rotates segment `index` to `angle` (absolute radians); its descendants turn with it.
pub fn rotate(doc: &Document, original: &Object, index: usize, angle: f64) -> Option<Object> {
    let fig = doc.figure(original.figure)?;
    let n = fig.segments.len();
    if index >= n {
        return None;
    }
    let mut angles: Vec<f64> = (0..n).map(|i| original.angles.get(i).copied().unwrap_or(fig.segments[i].angle)).collect();
    let delta = angle - angles[index];
    let mut stack = vec![index];
    while let Some(i) = stack.pop() {
        angles[i] += delta;
        let plan = &fig.plan;
        stack.extend(plan.children[plan.child_start[i] as usize..plan.child_start[i + 1] as usize].iter().map(|&c| c as usize));
    }
    let mut out = original.clone();
    out.angles = angles.into();
    Some(out)
}

/// Sets segment `index`'s unscaled length (Pivot's stretch).
pub fn stretch(doc: &Document, original: &Object, index: usize, length: f64) -> Option<Object> {
    let fig = doc.figure(original.figure)?;
    let n = fig.segments.len();
    if index >= n || !length.is_finite() {
        return None;
    }
    let mut lengths: Vec<f64> = match &original.lengths {
        Some(l) => l.to_vec(),
        None => fig.segments.iter().map(|s| s.length).collect(),
    };
    lengths[index] = length as f32 as f64;
    let mut out = original.clone();
    out.lengths = Some(lengths.into());
    Some(out)
}

pub fn translate(original: &Object, dx: f64, dy: f64) -> Object {
    let mut out = original.clone();
    out.root = [(original.root[0] + dx) as f32 as f64, (original.root[1] + dy) as f32 as f64];
    out
}

/// Bounded undo history of object replacements.
#[derive(Default)]
pub struct History {
    undo: Vec<Change>,
    redo: Vec<Change>,
}

impl History {
    const LIMIT: usize = 200;

    pub fn record(&mut self, change: Change) {
        if Arc::ptr_eq(&change.before, &change.after) {
            return;
        }
        self.undo.push(change);
        if self.undo.len() > Self::LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn undo(&mut self, doc: &Document) -> Option<Document> {
        let change = self.undo.pop()?;
        let next = replace(doc, &change.at, change.before.clone());
        self.redo.push(change);
        next
    }

    pub fn redo(&mut self, doc: &Document) -> Option<Document> {
        let change = self.redo.pop()?;
        let next = replace(doc, &change.at, change.after.clone());
        self.undo.push(change);
        next
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}
