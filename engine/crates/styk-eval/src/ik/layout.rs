//! Which bones a controller drives and which branches follow its target
//! (`ikChain`, `ikFollowerIndices`, `ikFollowers`, `ikAttachments` in src/ik.mjs).
//!
//! The traversal plan is the figure's own [`FigurePlan`](crate::doc::FigurePlan)
//! (`ikLayout` builds the same ids, children and breadth-first order).

use std::collections::{HashMap, HashSet};

use crate::doc::Segment;
use crate::rig::Spatial;

use super::object::Skeleton;
use super::{Controller, MAX_CHAIN};

/// `spatialBone(segment)`: an articulated joint of a spatial rig.
pub fn spatial_bone(segment: &Segment) -> bool {
    matches!(segment.rig.as_ref().and_then(|r| r.spatial.as_ref()), Some(Spatial::Bone { .. }))
}

/// `derivedRigJoint(segment)`: a joint its rig positions (skin, connector,
/// angle lock, angle path, weighted). IK never drives one, so chains stop here.
pub fn derived_rig_joint(segment: &Segment) -> bool {
    segment.rig.as_ref().is_some_and(|r| {
        matches!(r.spatial, Some(Spatial::Skin { .. })) || r.connector.is_some() || r.lock.is_some() || r.path.is_some() || r.weighted.is_some()
    })
}

/// `ikConstruction(segment)`: static construction artwork.
pub fn construction(segment: &Segment) -> bool {
    segment.is_static
}

impl Skeleton<'_> {
    /// Segment index of a handle id (`layout.ids.get`).
    pub fn index(&self, handle: u32) -> Option<usize> {
        self.plan.index_of.get(&handle).map(|&i| i as usize)
    }

    /// Child segment indices of a segment, in record order (`layout.children.get(id)`).
    pub fn children(&self, index: usize) -> &[u32] {
        &self.plan.children[self.plan.child_start[index] as usize..self.plan.child_start[index + 1] as usize]
    }

    /// `ikChain(figure, handle, length)`: the bones a controller drives, from the
    /// chain's base to its endpoint. It stops at the root, at a derived rig joint
    /// and after `length` bones.
    pub fn chain(&self, handle: u32, length: u32) -> Vec<usize> {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut at = self.index(handle);
        while let Some(i) = at {
            if chain.len() >= (length as usize).min(MAX_CHAIN) || seen.contains(&i) || derived_rig_joint(&self.segments[i]) {
                break;
            }
            seen.insert(i);
            chain.push(i);
            at = self.index(self.segments[i].parent);
        }
        chain.reverse();
        chain
    }

    /// `ikFollowerIndices(figure, handle)`: the next articulated bones at the
    /// endpoint. Static artwork belongs to the incoming bone; a near-zero
    /// construction pivot may sit between an ankle and its foot; branches joined
    /// by a polygon share one space so a filled foot cannot tear apart.
    pub fn follower_indices(&self, handle: u32) -> Vec<usize> {
        let Some(endpoint) = self.index(handle) else { return Vec::new() };
        let direct = self.children(endpoint);
        // Spatial skin belongs to explicit bone bindings, not polygon-connected branches.
        if spatial_bone(&self.segments[endpoint]) && direct.iter().all(|&i| self.segments[i as usize].rig.as_ref().is_some_and(|r| r.spatial.is_some())) {
            return direct.iter().map(|&i| i as usize).filter(|&i| spatial_bone(&self.segments[i]) && !construction(&self.segments[i])).collect();
        }
        let mut candidates: Vec<usize> = Vec::new();
        // Branch (a candidate's segment index) per segment id.
        let mut owners: HashMap<u32, usize> = HashMap::new();
        let mut queue: Vec<(usize, Option<usize>)> = direct.iter().map(|&i| (i as usize, None)).collect();
        let mut q = 0;
        while q < queue.len() {
            let (i, owner) = queue[q];
            let s = &self.segments[i];
            let anchor = owner.is_none() && construction(s) && s.length.abs() <= 0.001;
            let branch = if anchor { None } else { Some(owner.unwrap_or(i)) };
            if let Some(branch) = branch {
                owners.insert(s.id, branch);
                if owner.is_none() {
                    candidates.push(i);
                }
            }
            for &child in self.children(i) {
                queue.push((child as usize, branch));
            }
            q += 1;
        }
        let mut groups: HashMap<usize, usize> = candidates.iter().map(|&i| (i, i)).collect();
        let find = |groups: &HashMap<usize, usize>, i: usize| {
            let mut root = i;
            while groups[&root] != root {
                root = groups[&root];
            }
            root
        };
        for polygon in self.polygons {
            let branches: Vec<usize> = polygon.joints.iter().filter_map(|id| owners.get(id).copied()).collect();
            if branches.len() > 1 {
                for &i in &branches[1..] {
                    let (from, to) = (find(&groups, i), find(&groups, branches[0]));
                    groups.insert(from, to);
                }
            }
        }
        let articulated: HashSet<usize> = candidates.iter().filter(|&&i| !construction(&self.segments[i])).map(|&i| find(&groups, i)).collect();
        candidates.into_iter().filter(|&i| articulated.contains(&find(&groups, i))).collect()
    }

    /// `ikFollowers(figure, object, handle, controller)`: the angle each
    /// outgoing branch keeps relative to the target rotation. A branch the
    /// controller did not capture inherits the rotation of one it did.
    pub fn followers(&self, angles: &[f64], handle: u32, controller: &Controller) -> HashMap<u32, f64> {
        let children = self.follower_indices(handle);
        let captured = |i: usize| controller.followers.get(&self.segments[i].id).copied().filter(|a| a.is_finite());
        let direct = self.index(handle).map(|i| self.children(i)).unwrap_or(&[]);
        let anchor = children.iter().copied().find(|&i| captured(i).is_some()).or_else(|| direct.iter().map(|&i| i as usize).find(|&i| captured(i).is_some()));
        let offset = match anchor {
            None => -controller.target.rotation,
            Some(anchor) => controller.followers[&self.segments[anchor].id] - angles[anchor],
        };
        children
            .into_iter()
            .map(|i| {
                let id = self.segments[i].id;
                (id, controller.followers.get(&id).copied().unwrap_or(angles[i] + offset))
            })
            .collect()
    }

    /// `ikAttachments(figure, object, handle, controller, layout, followers)`:
    /// artwork rooted on the endpoint that stays in the incoming bone's space,
    /// as its angle relative to that bone.
    pub fn attachments(&self, angles: &[f64], handle: u32, controller: &Controller, followers: &HashMap<u32, f64>) -> HashMap<u32, f64> {
        let mut offsets = HashMap::new();
        let Some(endpoint) = self.index(handle) else { return offsets };
        for &i in self.children(endpoint) {
            let i = i as usize;
            let s = &self.segments[i];
            if followers.get(&s.id).is_some_and(|a| a.is_finite()) {
                continue;
            }
            let legacy = controller.followers.get(&s.id).is_some_and(|a| a.is_finite());
            let offset = controller.attachment_offsets.as_ref().and_then(|table| table.get(&s.id).copied()).unwrap_or(if legacy {
                // Old all-child tables may have baked frozen artwork into later
                // poses: recover the attachment from the figure's rest articulation.
                s.angle - self.segments[endpoint].angle
            } else {
                angles[i] - angles[endpoint]
            });
            offsets.insert(s.id, offset);
        }
        offsets
    }
}
