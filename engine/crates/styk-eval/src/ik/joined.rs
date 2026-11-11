//! IK across joined figures.
//!
//! A join aliases a child's origin to a vertex of its parent, so a chain may
//! run through several figures. Each connected assembly that has a pinned
//! controller is compiled into one temporary skeleton, solved once, and the
//! derived poses are scattered back to the figures' own slots. Nothing of the
//! temporary skeleton outlives the scene build.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::doc::{plan_figure, Figure, Object, Polyfill, Segment};
use crate::eval::Frame;
use crate::rig::{Rig, Spatial, Weighted};

use super::object::{solve_object, Outcome, Pose, Skeleton, Solution};
use super::rig::{plain_plan, RigGroup, RigSources};
use super::{has_pinned, Angles, Controller, Table};

/// `ikComponents(frame)`: object slots grouped by the joins that connect them,
/// each group in breadth-first order from its lowest slot.
pub fn components(frame: &Frame) -> Vec<Vec<usize>> {
    components_of(&frame.objects.iter().map(|o| o.join.map(|join| join.slot as usize)).collect::<Vec<_>>())
}

/// [`components`] from each slot's join target.
pub fn components_of(joins: &[Option<usize>]) -> Vec<Vec<usize>> {
    let count = joins.len();
    let mut neighbors: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (slot, join) in joins.iter().enumerate() {
        if let Some(target) = *join
            && target < count
        {
            neighbors[slot].push(target);
            neighbors[target].push(slot);
        }
    }
    let mut seen = vec![false; count];
    let mut groups = Vec::new();
    for slot in 0..count {
        if seen[slot] {
            continue;
        }
        seen[slot] = true;
        let mut group = vec![slot];
        let mut i = 0;
        while i < group.len() {
            for &next in &neighbors[group[i]] {
                if !seen[next] {
                    seen[next] = true;
                    group.push(next);
                }
            }
            i += 1;
        }
        groups.push(group);
    }
    groups
}

/// A bone of the temporary skeleton: where it came from (`entries`).
#[derive(Clone, Copy, Debug)]
pub struct Entry {
    /// The object slot of the figure it belongs to.
    pub slot: usize,
    /// Its index among that figure's segments.
    pub index: usize,
    /// Its handle id in that figure.
    pub handle: u32,
    /// The figure's identity.
    pub uid: u32,
    pub scale: f64,
}

/// `remapRigReferences`: a rig relationship with its handle references moved
/// into the temporary skeleton's ids (a figure's root becomes the joint it
/// hangs from).
fn remap_rig(rig: &Rig, remap: &HashMap<u32, u32>) -> Rig {
    let map = |id: u32| remap.get(&id).copied().unwrap_or(id);
    fn weighted(w: &Weighted, map: &dyn Fn(u32) -> u32) -> Weighted {
        Weighted { origin: map(w.origin), anchors: w.anchors.iter().map(|&(joint, weight)| (map(joint), weight)).collect(), depth: w.depth.as_ref().map(|d| Box::new(weighted(d, map))) }
    }
    let mut out = rig.clone();
    out.spatial = rig.spatial.as_ref().map(|spatial| match spatial {
        Spatial::Skin { point, bindings, view_points } => {
            Spatial::Skin { point: *point, bindings: bindings.iter().map(|&(joint, weight)| (map(joint), weight)).collect(), view_points: view_points.clone() }
        }
        Spatial::Bone { parent, turn, pitch, origin, tip, motion } => {
            let mut motion = motion.clone();
            if let Some(driver) = motion.as_mut().and_then(|m| m.driver.as_mut()) {
                driver.0 = map(driver.0);
            }
            Spatial::Bone { parent: map(*parent), turn: map(*turn), pitch: map(*pitch), origin: *origin, tip: *tip, motion }
        }
    });
    out.weighted = rig.weighted.as_ref().map(|w| weighted(w, &map));
    if let Some(path) = out.path.as_mut() {
        path.driver = map(path.driver);
        path.origin = map(path.origin);
        path.pitch = path.pitch.map(map);
        path.source = path.source.map(map);
    }
    if let Some(connector) = out.connector.as_mut() {
        connector.start = map(connector.start);
        connector.end = map(connector.end);
    }
    if let Some(follow) = out.follow.as_mut() {
        follow.driver = map(follow.driver);
    }
    if let Some(lock) = out.lock.as_mut() {
        lock.reference = map(lock.reference);
        if let Some(secondary) = lock.secondary.as_mut() {
            secondary.0 = map(secondary.0);
        }
    }
    out
}

/// `joinedIKGraph(report, frame, slots)`: the temporary skeleton of one
/// assembly, its pose, and the bookkeeping to scatter a solution back.
struct Graph<'a> {
    segments: Vec<Segment>,
    polygons: Vec<Polyfill>,
    angles: Vec<f64>,
    lengths: Vec<f64>,
    bends: Vec<f64>,
    entries: Vec<Entry>,
    /// Per object slot: segment id in its figure → id in the skeleton.
    maps: HashMap<usize, HashMap<u32, u32>>,
    /// Per object slot: the skeleton joint it hangs from (0 = the assembly's root).
    roots: HashMap<usize, u32>,
    figures: HashMap<usize, &'a Figure>,
    root: [f64; 2],
}

impl<'a> Graph<'a> {
    fn new(frame: &'a Frame, slots: &[usize], figure_of: &dyn Fn(usize) -> Option<&'a Arc<Figure>>) -> Option<Graph<'a>> {
        // An assembly with a movieclip (or a missing figure) is not compiled.
        let mut figures: HashMap<usize, &'a Figure> = HashMap::new();
        for &slot in slots {
            let figure = figure_of(slot).filter(|f| f.movieclip.is_none())?;
            figures.insert(slot, figure);
        }
        let mut graph = Graph {
            segments: Vec::new(),
            polygons: Vec::new(),
            angles: Vec::new(),
            lengths: Vec::new(),
            bends: Vec::new(),
            entries: Vec::new(),
            maps: HashMap::new(),
            roots: HashMap::new(),
            figures,
            root: [0.0, 0.0],
        };
        for &slot in slots {
            let source = &frame.objects[slot];
            let figure = graph.figures[&slot];
            let mut ids = HashMap::new();
            for (index, s) in figure.segments.iter().enumerate() {
                let id = graph.entries.len() as u32 + 1;
                let scale = source.scale;
                ids.insert(s.id, id);
                graph.entries.push(Entry { slot, index, handle: s.id, uid: source.uid, scale });
                // Parents and rig references are filled in once every figure has its ids.
                graph.segments.push(Segment { id, parent: 0, length: s.length * scale, bend: 0.0, rig: None, ..s.clone() });
                graph.angles.push(source.angles.get(index).copied().unwrap_or(s.angle));
                graph.lengths.push(source.lengths.as_ref().map(|l| l.get(index).copied().unwrap_or(s.length)).unwrap_or(s.length) * scale);
                graph.bends.push(match &source.bends {
                    Some(bends) => bends.get(index).copied().unwrap_or(0.0),
                    None => s.bend,
                });
            }
            graph.maps.insert(slot, ids);
        }
        for &slot in slots {
            graph.root_id(frame, slot, &mut Vec::new())?;
        }
        for &slot in slots {
            let figure = graph.figures[&slot];
            let ids = &graph.maps[&slot];
            let root_id = graph.roots[&slot];
            // `new Map([[0, rootId], ...ids])`: the figure's root is the joint it hangs from.
            let mut remap: HashMap<u32, u32> = ids.clone();
            remap.entry(0).or_insert(root_id);
            for s in &figure.segments {
                let i = ids[&s.id] as usize - 1;
                graph.segments[i].parent = if s.parent != 0 { ids.get(&s.parent).copied().unwrap_or(root_id) } else { root_id };
                graph.segments[i].rig = s.rig.as_ref().map(|rig| Arc::new(remap_rig(rig, &remap)));
            }
            for polygon in &figure.polyfills {
                // A handle the figure does not have maps to no bone (u32::MAX never owns a branch).
                let joints = polygon.joints.iter().map(|&id| if id != 0 { ids.get(&id).copied().unwrap_or(u32::MAX) } else { root_id }).collect();
                graph.polygons.push(Polyfill { joints, ..polygon.clone() });
            }
        }
        let root_slot = slots.iter().copied().find(|&slot| frame.objects[slot].join.is_none())?;
        graph.root = frame.objects[root_slot].root;
        Some(graph)
    }

    /// `rootId(slot)`: the skeleton joint an object hangs from. `None` where
    /// the JavaScript throws (a cyclic join, a join to a missing handle).
    fn root_id(&mut self, frame: &Frame, slot: usize, seen: &mut Vec<usize>) -> Option<u32> {
        if let Some(&id) = self.roots.get(&slot) {
            return Some(id);
        }
        if seen.contains(&slot) {
            return None;
        }
        seen.push(slot);
        let id = match frame.objects.get(slot)?.join {
            None => 0,
            Some(join) if join.handle != 0 => *self.maps.get(&(join.slot as usize))?.get(&join.handle)?,
            Some(join) => self.root_id(frame, join.slot as usize, seen)?,
        };
        self.roots.insert(slot, id);
        Some(id)
    }
}

/// `mapController(slot, handle, controller)`: a controller in the skeleton's
/// ids. Tables of the owner's own handles and of joined figures' handles merge
/// into one, and follower and attachment angles are completed for the
/// skeleton's branches.
fn map_controller(graph: &Graph, skeleton: &Skeleton, by_uid: &HashMap<u32, usize>, slot: usize, id: u32, c: &Controller) -> Controller {
    let own = &graph.maps[&slot];
    fn merge<T: Clone>(graph: &Graph, own: &HashMap<u32, u32>, by_uid: &HashMap<u32, usize>, local: Option<&BTreeMap<u32, T>>, joined: Option<&BTreeMap<u32, BTreeMap<u32, T>>>) -> BTreeMap<u32, T> {
        let mut offsets = BTreeMap::new();
        for (child, value) in local.into_iter().flatten() {
            if let Some(&mapped) = own.get(child) {
                offsets.insert(mapped, value.clone());
            }
        }
        for (uid, children) in joined.into_iter().flatten() {
            let Some(ids) = by_uid.get(uid).and_then(|slot| graph.maps.get(slot)) else { continue };
            for (child, value) in children {
                if let Some(&mapped) = ids.get(child) {
                    offsets.insert(mapped, value.clone());
                }
            }
        }
        offsets
    }
    let mut mapped = Controller {
        followers: merge(graph, own, by_uid, Some(&c.followers), c.joined_followers.as_ref()),
        attachment_offsets: Some(merge(graph, own, by_uid, c.attachment_offsets.as_ref(), c.joined_attachment_offsets.as_ref())),
        spatial_followers: Some(merge(graph, own, by_uid, c.spatial_followers.as_ref(), c.joined_spatial_followers.as_ref())),
        ..c.clone()
    };
    let followers = skeleton.followers(&graph.angles, id, &mapped);
    let attachments = skeleton.attachments(&graph.angles, id, &mapped, &followers);
    mapped.followers = followers.into_iter().collect();
    mapped.attachment_offsets = Some(attachments.into_iter().collect());
    mapped
}

/// `joinedIKGraph(report, frame, slots)`: one assembly compiled into a temporary
/// skeleton, with its pose and its controllers in the skeleton's ids, and the way
/// back to the figures (`scatter`). Geometry solves it once; editing also maps a
/// controller of its own into it and solves with that (`poseGraph`).
pub struct Assembly<'a> {
    frame: &'a Frame,
    /// The assembly's object slots, as given.
    pub slots: Vec<usize>,
    graph: Graph<'a>,
    plan: crate::doc::FigurePlan,
    sources: Option<RigSources<'a>>,
    by_uid: HashMap<u32, usize>,
    /// `graph.object._stykIK`: every controller of the assembly, mapped.
    pub controllers: Table,
    /// Skeleton id → the slot and handle of the controller's owner.
    owners: HashMap<u32, (usize, u32)>,
}

/// The followers of one controller's solve: by the owner's handles, and by the
/// identity and handles of the figures joined to it.
pub type Followers = (Angles, BTreeMap<u32, Angles>);

/// What [`Assembly::scatter`] returns for one figure: its derived pose, and per
/// controller it owns the followers of the solve, in its own handles and in those of
/// the figures joined to it (`followers`, `joinedFollowers`).
pub struct Scattered {
    pub slot: usize,
    pub solution: Solution,
    pub followers: BTreeMap<u32, Followers>,
}

impl<'a> Assembly<'a> {
    /// `None` when the assembly cannot be compiled (a movieclip, a missing figure,
    /// a cyclic join or a join to a missing handle).
    pub fn new(frame: &'a Frame, slots: &[usize], figure_of: &dyn Fn(usize) -> Option<&'a Arc<Figure>>) -> Option<Assembly<'a>> {
        let graph = Graph::new(frame, slots, figure_of)?;
        let plan = plan_figure(&graph.segments, &graph.polygons);
        // With rig relationships anywhere in the assembly, every bone evaluates
        // through the figure it came from (`figure._rigSources`).
        let sources = plan.rig.is_some().then(|| RigSources {
            groups: slots
                .iter()
                .map(|&slot| {
                    let figure = graph.figures[&slot];
                    RigGroup {
                        figure,
                        object: &frame.objects[slot],
                        ids: graph.maps[&slot].clone(),
                        root_id: graph.roots[&slot],
                        plan: figure.plan.rig.clone().unwrap_or_else(|| Arc::new(plain_plan(figure.segments.len()))),
                    }
                })
                .collect(),
            of: {
                let group_of: HashMap<usize, u32> = slots.iter().enumerate().map(|(g, &slot)| (slot, g as u32)).collect();
                graph.entries.iter().map(|e| (group_of[&e.slot], e.index as u32)).collect()
            },
        });
        let by_uid: HashMap<u32, usize> = slots.iter().map(|&slot| (frame.objects[slot].uid, slot)).collect();
        let mut assembly = Assembly { frame, slots: slots.to_vec(), graph, plan, sources, by_uid, controllers: Table::default(), owners: HashMap::new() };
        let mut controllers = BTreeMap::new();
        for &slot in slots {
            for (&handle, c) in frame.objects[slot].ik.iter().flat_map(|table| table.controllers.iter()) {
                let Some(id) = assembly.id(slot, handle) else { continue };
                controllers.insert(id, assembly.map_controller(slot, id, c));
                assembly.owners.insert(id, (slot, handle));
            }
        }
        assembly.controllers = Table { controllers };
        Some(assembly)
    }

    /// The temporary skeleton.
    pub fn skeleton(&self) -> Skeleton<'_> {
        Skeleton { segments: &self.graph.segments, plan: &self.plan, polygons: &self.graph.polygons, sources: self.sources.as_ref() }
    }

    /// The skeleton id of `handle` of the figure in `slot` (`graph.maps.get(slot).get(handle)`).
    pub fn id(&self, slot: usize, handle: u32) -> Option<u32> {
        self.graph.maps.get(&slot)?.get(&handle).copied()
    }

    /// Where the skeleton's bone `index` came from (`graph.entries[index]`).
    pub fn entry(&self, index: usize) -> Entry {
        self.graph.entries[index]
    }

    /// The pose's scaled lengths (`graph.object.lengths`), which `poseGraph` resets to
    /// those the gesture started with.
    pub fn lengths_mut(&mut self) -> &mut [f64] {
        &mut self.graph.lengths
    }

    /// `graph.chain(slot, handle, length)`: skeleton indices, base first.
    pub fn chain(&self, slot: usize, handle: u32, length: u32) -> Vec<usize> {
        self.id(slot, handle).map(|id| self.skeleton().chain(id, length)).unwrap_or_default()
    }

    /// `graph.mapController(slot, handle, controller)`, with `id` the handle's skeleton id.
    pub fn map_controller(&self, slot: usize, id: u32, c: &Controller) -> Controller {
        map_controller(&self.graph, &self.skeleton(), &self.by_uid, slot, id, c)
    }

    /// `graph.object`: the assembly's pose (unit scale, scaled lengths).
    fn pose(&self) -> Pose<'_> {
        let graph = &self.graph;
        Pose {
            scale: 1.0,
            angles: &graph.angles,
            lengths: Some(&graph.lengths),
            bends: Some(&graph.bends),
            mirror: false,
            figure_angle: graph.angles.first().copied().unwrap_or(0.0) - graph.segments.first().map(|s| s.angle).unwrap_or(0.0),
            shape: None,
        }
    }

    /// The pose's angles by skeleton index (`graph.object.angles`).
    pub fn angles(&self) -> &[f64] {
        &self.graph.angles
    }

    /// `graph.solve(controllers)`.
    pub fn solve(&self, controllers: &Table) -> Option<Solution> {
        solve_object(&self.skeleton(), &self.pose(), self.graph.root, controllers)
    }

    /// `graph.scatter(solution)`: each figure's derived pose in its own slots, ids and
    /// scale, with the results of the controllers it owns. `controllers` are those the
    /// solution was solved with: a result's followers are theirs (`ikFollowers`).
    pub fn scatter(&self, solution: &Solution, controllers: &Table) -> Vec<Scattered> {
        let graph = &self.graph;
        let mut output: Vec<Scattered> = self
            .slots
            .iter()
            .map(|&slot| {
                let object: &Object = &self.frame.objects[slot];
                let angles = graph.figures[&slot].segments.iter().enumerate().map(|(i, s)| object.angles.get(i).copied().unwrap_or(s.angle)).collect();
                Scattered { slot, solution: Solution { angles, lengths: None, results: Vec::new() }, followers: BTreeMap::new() }
            })
            .collect();
        let at: HashMap<usize, usize> = self.slots.iter().enumerate().map(|(k, &slot)| (slot, k)).collect();
        for (i, entry) in graph.entries.iter().enumerate() {
            let result = &mut output[at[&entry.slot]].solution;
            result.angles[entry.index] = solution.angles[i];
            if let Some(lengths) = &solution.lengths
                && entry.scale != 0.0
            {
                let own = result.lengths.get_or_insert_with(|| vec![f64::NAN; graph.figures[&entry.slot].segments.len()]);
                own[entry.index] = lengths[i] / entry.scale;
            }
        }
        let skeleton = self.skeleton();
        for (id, outcome) in &solution.results {
            let Some(&(slot, handle)) = self.owners.get(id) else { continue };
            let chain = outcome.chain.iter().map(|&i| graph.entries[i].index).collect();
            if !outcome.conflict
                && let Some(c) = controllers.get(*id)
            {
                let (mut own, mut joined) = (Angles::new(), BTreeMap::<u32, Angles>::new());
                for (child, angle) in skeleton.followers(&graph.angles, *id, c) {
                    let entry = graph.entries[child as usize - 1];
                    if entry.slot == slot {
                        own.insert(entry.handle, angle);
                    } else {
                        joined.entry(entry.uid).or_default().insert(entry.handle, angle);
                    }
                }
                output[at[&slot]].followers.insert(handle, (own, joined));
            }
            output[at[&slot]].solution.results.push((handle, Outcome { chain, ..outcome.clone() }));
        }
        output
    }
}

/// `solveJoinedIK(report, frame)`: the derived pose of every object that
/// belongs to a joined assembly with a pinned controller, by object slot.
/// `figure_of` resolves a slot's figure (with its style overlay, if any).
pub fn solve<'a>(frame: &'a Frame, figure_of: &dyn Fn(usize) -> Option<&'a Arc<Figure>>) -> HashMap<usize, Solution> {
    let mut output = HashMap::new();
    if !frame.objects.iter().any(|o| o.join.is_some()) || !frame.objects.iter().any(|o| has_pinned(o)) {
        return output;
    }
    for slots in components(frame) {
        if slots.len() < 2 || !slots.iter().any(|&slot| has_pinned(&frame.objects[slot])) {
            continue;
        }
        let Some(assembly) = Assembly::new(frame, &slots, figure_of) else { continue };
        let Some(solution) = assembly.solve(&assembly.controllers) else { continue };
        output.extend(assembly.scatter(&solution, &assembly.controllers).into_iter().map(|s| (s.slot, s.solution)));
    }
    output
}
