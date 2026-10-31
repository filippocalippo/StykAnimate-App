//! Controllers between two poses (`interpolateIK` in src/ik.mjs).
//!
//! Enabling, pinning and chain changes are discrete: a controller tweens only
//! toward a controller of the same handle that is enabled and pinned alike.
//! Target positions, rotations and follower angles then move with the pose.

use std::collections::BTreeMap;

use super::spatial::{interpolate_pole, interpolate_quaternion};
use super::{wrap, Angles, BendReference, Controller, Quaternions, SpatialTarget, Table, Target};

/// A scalar channel of a controller that the timeline's own easing samples
/// (`sample(id, section, key, angular)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    TargetX,
    TargetY,
    TargetRotation,
    /// `followers[handle]`.
    Follower(u32),
}

impl Controller {
    /// The value of a channel, if the controller has it.
    pub fn channel(&self, channel: Channel) -> Option<f64> {
        match channel {
            Channel::TargetX => Some(self.target.x),
            Channel::TargetY => Some(self.target.y),
            Channel::TargetRotation => Some(self.target.rotation),
            Channel::Follower(handle) => self.followers.get(&handle).copied(),
        }
    }
}

fn joined_angles(from: &BTreeMap<u32, Angles>, to: Option<&BTreeMap<u32, Angles>>, t: f64) -> BTreeMap<u32, Angles> {
    from.iter()
        .map(|(uid, children)| {
            let next = to.and_then(|table| table.get(uid));
            let children = children
                .iter()
                .map(|(child, &angle)| {
                    let value = match next.and_then(|table| table.get(child)).filter(|a| a.is_finite()) {
                        Some(&target) => angle + wrap(target - angle) * t,
                        None => angle,
                    };
                    (*child, value)
                })
                .collect();
            (*uid, children)
        })
        .collect()
}

fn quaternions(from: &Quaternions, to: Option<&Quaternions>, t: f64) -> Quaternions {
    from.iter()
        .map(|(id, &q)| {
            (*id, match to.and_then(|table| table.get(id)) {
                Some(&target) => interpolate_quaternion(q, target, t),
                None => q,
            })
        })
        .collect()
}

/// `interpolateIK(a, b, t, sample)`: the table of pose `a` on its way to pose
/// `b`. `sample(handle, channel, angular)` supplies the eased value of target
/// and follower channels; without it they move linearly (angles on the short
/// arc), as the editor's own tweening tools do. Everything else uses `t`.
pub fn interpolate(a: &Table, b: Option<&Table>, t: f64, sample: Option<&dyn Fn(u32, Channel, bool) -> f64>) -> Table {
    let mut table = BTreeMap::new();
    for (&id, c) in &a.controllers {
        let Some(next) = b.and_then(|b| b.get(id)).filter(|next| next.enabled && c.enabled && next.pinned == c.pinned) else {
            table.insert(id, c.clone());
            continue;
        };
        let channel = |channel: Channel, from: f64, to: f64, angular: bool| match sample {
            Some(sample) => sample(id, channel, angular),
            None => from + if angular { wrap(to - from) } else { to - from } * t,
        };
        let target = Target {
            x: channel(Channel::TargetX, c.target.x, next.target.x, false),
            y: channel(Channel::TargetY, c.target.y, next.target.y, false),
            rotation: channel(Channel::TargetRotation, c.target.rotation, next.target.rotation, true),
        };
        let followers: Angles = c
            .followers
            .iter()
            .map(|(&child, &angle)| {
                (child, match next.followers.get(&child).filter(|a| a.is_finite()) {
                    Some(&to) => channel(Channel::Follower(child), angle, to, true),
                    None => angle,
                })
            })
            .collect();
        let bend_reference = match (&c.bend_reference, next.bend_reference.as_ref().and_then(|r| r.shape.as_ref())) {
            (Some(BendReference { shape: Some(shape), .. }), Some(to)) if !shape.is_empty() && shape.len() == to.len() => {
                let shape = shape.iter().zip(to).map(|(&a, &b)| a + wrap(b - a) * t).collect();
                Some(BendReference { shape: Some(shape), ..c.bend_reference.clone().unwrap() })
            }
            _ => c.bend_reference.clone(),
        };
        let spatial_target = match (&c.spatial_target, &next.spatial_target) {
            (Some(from), Some(to)) => Some(SpatialTarget {
                depth: from.depth + (to.depth - from.depth) * t,
                swivel: from.swivel + wrap(to.swivel - from.swivel) * t,
                pole: interpolate_pole(from.pole, to.pole, t),
                normals: match (&from.normals, &to.normals) {
                    (Some(a), Some(b)) => Some([interpolate_pole(a[0], b[0], t), interpolate_pole(a[1], b[1], t)]),
                    _ => from.normals,
                },
            }),
            _ => c.spatial_target.clone(),
        };
        table.insert(id, Controller {
            target,
            followers,
            joined_followers: c.joined_followers.as_ref().map(|from| joined_angles(from, next.joined_followers.as_ref(), t)),
            spatial_followers: c.spatial_followers.as_ref().map(|from| quaternions(from, next.spatial_followers.as_ref(), t)),
            joined_spatial_followers: c.joined_spatial_followers.as_ref().map(|from| {
                from.iter().map(|(uid, children)| (*uid, quaternions(children, next.joined_spatial_followers.as_ref().and_then(|table| table.get(uid)), t))).collect()
            }),
            spatial_target,
            bend_reference,
            ..c.clone()
        });
    }
    Table { controllers: table }
}

/// The timeline's sampler of one channel: the values at keys index-1 to index+2,
/// whether the channel is an angle, and a reader of the channel at any key.
pub type ChannelSampler<'f> = dyn Fn([Option<f64>; 4], bool, &dyn Fn(usize) -> Option<f64>) -> f64 + 'f;

/// The call in `evaluatedNativeFrame`: `records` are the object's tables at
/// keys index-1, index, index+1 and index+2 (the object itself is `records[1]`),
/// `t` is the interval's progress and `value` the timeline's channel sampler
/// (linear, eased, Auto or Pivot's monotone cubic). A neighbouring key
/// contributes to a channel only while its controller is enabled and pinned
/// like the one being tweened. `at(k)` is the object's table at any key `k`, for
/// samplers that follow a channel along a whole run of keys.
pub fn tween<'a>(table: &Table, records: [Option<&Table>; 4], t: f64, value: &ChannelSampler, at: &dyn Fn(usize) -> Option<&'a Table>) -> Table {
    let sample = |id: u32, channel: Channel, angular: bool| {
        let pinned = table.get(id).map(|c| c.pinned);
        let read = |record: Option<&Table>| record.and_then(|r| r.get(id)).filter(|c| c.enabled && Some(c.pinned) == pinned).and_then(|c| c.channel(channel));
        value(records.map(read), angular, &|key| read(at(key)))
    };
    interpolate(table, records[2], t, Some(&sample))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller(x: f64, rotation: f64, pinned: bool) -> Controller {
        Controller {
            enabled: true,
            pinned,
            allow_stretch: false,
            chain_length: 2,
            bend_direction: 0.0,
            target: Target { x, y: 0.0, rotation },
            followers: [(7, 0.2)].into_iter().collect(),
            attachment_offsets: None,
            joined_followers: None,
            joined_attachment_offsets: None,
            spatial_followers: None,
            joined_spatial_followers: None,
            spatial_target: None,
            bend_reference: None,
        }
    }

    fn table(c: Controller) -> Table {
        Table { controllers: [(5, c)].into_iter().collect() }
    }

    #[test]
    fn compatible_controllers_move_and_rotate_on_the_short_arc() {
        let (a, b) = (table(controller(10.0, 3.0, true)), table(controller(30.0, -3.0, true)));
        let half = interpolate(&a, Some(&b), 0.5, None);
        let c = half.get(5).unwrap();
        assert_eq!(c.target.x, 20.0);
        // 3 → -3 crosses π, it does not sweep back through zero.
        assert!((c.target.rotation - (3.0 + wrap(-6.0) * 0.5)).abs() < 1e-12 && c.target.rotation > 3.0);
    }

    #[test]
    fn pin_changes_are_discrete() {
        let (a, b) = (table(controller(10.0, 0.0, true)), table(controller(30.0, 0.0, false)));
        assert_eq!(interpolate(&a, Some(&b), 0.5, None), a);
        assert_eq!(interpolate(&a, None, 0.5, None), a);
    }
}
