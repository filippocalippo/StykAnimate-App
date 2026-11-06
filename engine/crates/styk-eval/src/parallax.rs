//! Layer parallax (`parallaxResolver` in src/layer-parallax.mjs).
//!
//! While the scene camera is shown, a layer whose parallax is on moves against the
//! camera's travel: by `(1 - response) × (camera - reference)` on each axis, so a
//! response of 1 keeps the layer where it was drawn and 0 pins it to the screen.
//! Travel is where the camera is (`cameraTravelAt`: the authored camera and follow
//! clips), less the screen impulse a camera-motion bake folded into it
//! (`_parallaxMotionOffset`). A figure joined to another moves with the layer of
//! the figure at the root of its join chain.
//!
//! The offset is a translation of the whole object, artwork, effects and movieclip
//! contents alike, which the editor's painters apply after a drag's: the draw list
//! takes it as one more per-object translation. Geometry, records and editing never
//! see it. The editor shows onion skins only with the camera off, where every
//! offset is zero, so ghosts take none.

use std::collections::HashMap;
use std::sync::Arc;

use crate::doc::{Camera, Document};
use crate::eval::Frame;

/// The parallax offsets of one evaluated frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Parallax {
    /// World-space offset of each object, by slot.
    pub slots: Vec<[f64; 2]>,
    /// The offset of each layer whose parallax is on.
    layers: Vec<(String, [f64; 2])>,
    /// The uid at the root of each joined object's chain, by the object's uid.
    roots: HashMap<u32, u32>,
}

impl Parallax {
    /// The offset of the object `uid` (`parallax(uid)`): the layer of its join chain's root
    /// in this frame, or its own layer when it is not in the frame (generated effects look
    /// their targets up by identity).
    pub fn of_uid(&self, layers: &crate::doc::Layers, uid: u32) -> [f64; 2] {
        let layer = layers.layer_of(self.roots.get(&uid).copied().unwrap_or(uid));
        self.layers.iter().find(|(id, _)| id == layer).map_or([0.0, 0.0], |&(_, d)| d)
    }

    /// `drag` (the session's per-slot translations) with every object's parallax
    /// offset added, as one translation per moved slot.
    pub fn translations(&self, drag: &[(u32, [f64; 2])]) -> Vec<(u32, [f64; 2])> {
        let mut out: Vec<(u32, [f64; 2])> = self.slots.iter().enumerate().filter(|(_, d)| d[0] != 0.0 || d[1] != 0.0).map(|(slot, &d)| (slot as u32, d)).collect();
        for &(slot, delta) in drag {
            match out.iter_mut().find(|(s, _)| *s == slot) {
                Some((_, d)) => *d = [delta[0] + d[0], delta[1] + d[1]],
                None => out.push((slot, delta)),
            }
        }
        out
    }
}

/// `parallaxResolver(report, frame)` with the camera shown: `travel` is where the
/// camera is (`cameraTravelAt`). `None` when no object moves.
pub fn resolve(doc: &Document, frame: &Frame, travel: Option<&Camera>) -> Option<Arc<Parallax>> {
    let layers = doc.layers.as_deref()?;
    if !layers.camera_visible || layers.parallax.is_empty() {
        return None;
    }
    // A default camera counts as none: at the origin, without a baked impulse.
    let (x, y, impulse) = match travel {
        Some(c) if !c.is_default => (c.x, c.y, c.motion_offset.unwrap_or([0.0, 0.0])),
        _ => (0.0, 0.0, [0.0, 0.0]),
    };
    let offsets: Vec<(&str, [f64; 2])> = layers
        .parallax
        .iter()
        .map(|(id, p)| (id.as_str(), [(1.0 - p.x) * (x - impulse[0] - p.reference[0]), (1.0 - p.y) * (y - impulse[1] - p.reference[1])]))
        .collect();
    if offsets.iter().all(|(_, d)| d[0] == 0.0 && d[1] == 0.0) {
        return None;
    }
    let roots = join_roots(frame);
    let slots = frame
        .objects
        .iter()
        .map(|object| {
            let uid = roots.get(&object.uid).copied().unwrap_or(object.uid);
            let layer = layers.layer_of(uid);
            offsets.iter().find(|(id, _)| *id == layer).map_or([0.0, 0.0], |&(_, d)| d)
        })
        .collect();
    let layers = offsets.into_iter().map(|(id, d)| (id.to_string(), d)).collect();
    Some(Arc::new(Parallax { slots, layers, roots }))
}

/// The uid at the root of each joined object's chain, by the joined object's uid.
/// Chains are followed as the editor does: a dangling join ends a chain at the first
/// object, and a cycle stops once it is longer than the frame.
fn join_roots(frame: &Frame) -> HashMap<u32, u32> {
    let objects = &frame.objects;
    let mut out = HashMap::new();
    if !objects.iter().any(|o| o.join.is_some()) {
        return out;
    }
    let n = objects.len();
    let mut root_of: Vec<Option<u32>> = vec![None; n];
    let mut chain: Vec<usize> = Vec::new();
    for i in 0..n {
        if objects[i].join.is_none() || root_of[i].is_some() {
            continue;
        }
        chain.clear();
        let mut slot = i;
        while let Some(join) = objects.get(slot).and_then(|o| o.join) {
            if root_of[slot].is_some() || chain.len() > n {
                break;
            }
            chain.push(slot);
            slot = join.slot as usize;
        }
        let uid = root_of.get(slot).copied().flatten().or_else(|| objects.get(slot).map(|o| o.uid)).unwrap_or(objects[i].uid);
        for &part in &chain {
            root_of[part] = Some(uid);
            out.insert(objects[part].uid, uid);
        }
    }
    out
}
