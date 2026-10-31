//! Where onion skins go in the painter order (`composeSceneGroups`).
//!
//! A ghost is drawn behind the frame being edited, layer by layer: with a layer
//! table, each ghost object sits immediately behind the current artwork of its own
//! layer and above the layers below; without one, ghosts sit behind everything. A
//! ghost shown on top comes after all current artwork.

use std::collections::HashMap;

use crate::doc::Layers;
use crate::drawlist::Layer;
use crate::eval::Frame;
use crate::geometry::Scene;

/// How one ghost takes part in the order.
pub struct GhostPlace<'a> {
    pub frame: &'a Frame,
    pub scene: &'a Scene,
    /// Object slots of the ghost that are not drawn.
    pub hidden: &'a [bool],
    pub show_on_top: bool,
}

/// Object slots of a scene in painter order (each once, with at least one primitive).
fn painted_slots(scene: &Scene) -> Vec<u32> {
    let mut slots = Vec::new();
    for item in &scene.items {
        if slots.last() != Some(&item.slot) {
            slots.push(item.slot);
        }
    }
    slots
}

/// The painter order of `frame` with its `ghosts` (far to near, as supplied).
pub fn compose(layers: Option<&Layers>, frame: &Frame, scene: &Scene, ghosts: &[GhostPlace<'_>]) -> Vec<Layer> {
    let mut groups: Vec<Layer> = Vec::new();
    let mut on_top: Vec<Layer> = Vec::new();
    let mut layer_skins: HashMap<&str, Vec<Layer>> = HashMap::new();
    for (index, ghost) in ghosts.iter().enumerate() {
        let skin = painted_slots(ghost.scene).into_iter().filter(|&slot| !ghost.hidden.get(slot as usize).copied().unwrap_or(false));
        if ghost.show_on_top {
            on_top.extend(skin.map(|slot| Layer::Ghost(index as u32, slot)));
        } else {
            for slot in skin {
                match layers {
                    None => groups.push(Layer::Ghost(index as u32, slot)),
                    Some(layers) => {
                        let uid = ghost.frame.objects.get(slot as usize).map_or(0, |object| object.uid);
                        layer_skins.entry(layers.layer_of(uid)).or_default().push(Layer::Ghost(index as u32, slot));
                    }
                }
            }
        }
    }
    let painted = painted_slots(scene);
    let positions: HashMap<&str, usize> = layers.map(|layers| layers.order.iter().enumerate().map(|(index, id)| (id.as_str(), index)).collect()).unwrap_or_default();
    let mut next_layer = 0;
    for slot in painted {
        let uid = frame.objects.get(slot as usize).map_or(0, |object| object.uid);
        if let Some(layers) = layers
            && let Some(&position) = positions.get(layers.layer_of(uid))
        {
            // A blank current exposure still has a place in the layer stack.
            while next_layer <= position {
                groups.extend(layer_skins.remove(layers.order[next_layer].as_str()).unwrap_or_default());
                next_layer += 1;
            }
        }
        groups.push(Layer::Current(slot));
    }
    if let Some(layers) = layers {
        while next_layer < layers.order.len() {
            groups.extend(layer_skins.remove(layers.order[next_layer].as_str()).unwrap_or_default());
            next_layer += 1;
        }
    }
    groups.extend(on_top);
    groups
}
