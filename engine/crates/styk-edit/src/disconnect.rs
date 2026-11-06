//! Disconnect segment (Animate's own command): the selected segment and everything hanging
//! from it become a figure of their own in every pose of the figure, posed where they were.
//!
//! One history entry (a batch) holds three: a `disconnect` command that inserts the new figure's poses beside the
//! source instance's (a definition other instances share is forked first, so linked instances keep their rig), then
//! the topology edit of each definition that trims it to its side of the cut. The topology edits own what a trim
//! must repair: IK controllers, styles, effect owners and the validation of the result.

use std::collections::{BTreeMap, HashSet};

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::history::{Command, CommandKind, Direction};
use crate::record::{num, uid};
use crate::topology::{Place, TopologyOptions, frame_at, frame_mut, places};
use crate::{EditError, Editor};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// A handle as a key: signed zeros alike, as `Set` has them.
fn key(id: f64) -> u64 {
    if id == 0.0 { 0 } else { id.to_bits() }
}

fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}


/// What one pose of the figure gets (`changes[i]` of the command): where it lives, the new figure's record there, the
/// drawing order before and after, and the source instance before and after where it changes too (a forked definition,
/// or the displayed solution of its pinned limbs).
#[derive(Clone, Debug)]
pub struct Change {
    pub place: Place,
    pub part: Value,
    pub before_order: Vec<f64>,
    pub after_order: Vec<f64>,
    pub owner: Option<(Value, Value)>,
}

impl Change {
    /// The change as the editor's command lists it, for weighing the entry.
    pub(crate) fn history_value(&self) -> Value {
        let mut change = Obj::new();
        self.place.locate(&mut change);
        change.set("part", self.part.clone());
        change.set("beforeOrder", Value::nums(&self.before_order));
        change.set("afterOrder", Value::nums(&self.after_order));
        if let Some((before, after)) = &self.owner {
            let mut owner = Obj::new();
            owner.set("before", before.clone());
            owner.set("after", after.clone());
            change.set("owner", Value::object(owner));
        }
        Value::object(change)
    }
}

/// What the command splits off and where: the selected figure, its segment and the branch below it, and the poses that show it.
struct Cut {
    /// The figure's definition, the selected segment and the identity of the instance.
    figure: Value,
    segment: Value,
    id: u32,
    /// The handle the segment hangs from, the handles of its branch and their indices in the definition.
    base: f64,
    part: HashSet<u64>,
    indices: Vec<usize>,
    /// Which fills move with the part, and whether the part paints behind the rest.
    moves: Vec<bool>,
    behind: bool,
    /// Whether another instance shares the definition, which is then forked first.
    shared: bool,
    /// Every pose (keyframe or pose source) that shows the instance.
    locations: Vec<Place>,
    /// The name of the new figure: the segment's own, else the figure's with "part".
    name: Option<String>,
}

/// `trimPose(object, keep)`: the pose vectors of the segments kept.
fn trim_pose(object: &mut Value, keep: &[usize]) {
    let Some(record) = object.make_obj() else { return };
    let pick = |value: Option<&Value>| {
        let all = value.and_then(Value::numbers).unwrap_or_default();
        keep.iter().map(|&i| all.get(i).copied().unwrap_or(f64::NAN)).collect::<Vec<f64>>()
    };
    let angles = pick(record.get("angles"));
    record.set("angles", Value::nums(&angles));
    if record.get("len_flag").is_some_and(Value::truthy) {
        let lengths = pick(record.get("lengths"));
        record.set("lengths", Value::nums(&lengths));
    }
    if record.get("bend_flag").is_some_and(Value::truthy) {
        let bends = pick(record.get("bends"));
        record.set("bends", Value::nums(&bends));
    }
    record.remove("runtime_segments");
}

/// `surfaceHandles(polygon)`: its handles and the reference joints of its surface.
fn surface_handles(polygon: &Value) -> Vec<f64> {
    let ids = |value: Option<&Value>| value.and_then(Value::numbers).unwrap_or_default();
    let mut handles = ids(polygon.get("segment_ids"));
    handles.extend(ids(polygon.path(&["_stykSurface", "basis"])));
    handles.extend(ids(polygon.path(&["_stykSurface", "depth"])));
    handles
}

/// Which fills move with the part. A fill using joints on both sides has no exact owner.
fn moving_fills(figure: &Value, part: &HashSet<u64>, base: f64) -> Result<Vec<bool>, EditError> {
    items(figure.get("polyfills"))
        .iter()
        .map(|polygon| {
            let handles = surface_handles(polygon);
            if !handles.iter().any(|&id| part.contains(&key(id))) {
                return Ok(false);
            }
            if handles.iter().all(|&id| part.contains(&key(id)) || id == base) {
                return Ok(true);
            }
            Err(invalid("errors.editorDisconnect.aFillJoinsThisPartToTheRest"))
        })
        .collect()
}

/// The part paints behind the rest when it mostly sat under it inside the figure.
fn paints_behind(figure: &Value, part: &HashSet<u64>, moves: &[bool]) -> bool {
    let mut sums = [[0.0f64, 0.0], [0.0, 0.0]];
    let mut add = |z: f64, in_part: bool| {
        sums[usize::from(in_part)][0] += z;
        sums[usize::from(in_part)][1] += 1.0;
    };
    for (i, segment) in items(figure.get("segments")).iter().enumerate() {
        let z = num(segment, "z_order").filter(|z| z.is_finite()).unwrap_or(i as f64);
        add(z, num(segment, "segment_id").is_some_and(|id| part.contains(&key(id))));
    }
    for (i, polygon) in items(figure.get("polyfills")).iter().enumerate() {
        let z = num(polygon, "z_order").filter(|z| z.is_finite()).unwrap_or(i as f64);
        add(z, moves[i]);
    }
    sums[1][0] / sums[1][1] < sums[0][0] / sums[0][1]
}

/// `remapIKFollowers(copy, uidMap)` for a map from each kept figure to itself: the tables of followers in joined figures keep
/// the figures joined to the part and drop the others.
fn keep_joined_followers(object: &mut Value, kept: &[u32]) {
    let Some(record) = object.make_obj() else { return };
    let Some(table) = record.get("_stykIK").filter(|t| t.truthy()).and_then(Value::as_obj).cloned() else { return };
    let mut next = Obj::new();
    for (handle, controller) in table.iter() {
        let mut controller_record = controller.as_obj().cloned().unwrap_or_default();
        for field in ["joinedFollowers", "joinedAttachmentOffsets", "joinedSpatialFollowers"] {
            let Some(entries) = controller.get(field).filter(|e| e.truthy()).and_then(Value::as_obj) else { continue };
            // Object keys that are whole numbers list in ascending order.
            let mut ordered: BTreeMap<u32, Value> = BTreeMap::new();
            for (id, followers) in entries.iter() {
                if let Ok(id) = id.parse::<u32>()
                    && kept.contains(&id)
                {
                    ordered.insert(id, followers.clone());
                }
            }
            let mut filtered = Obj::new();
            for (id, followers) in ordered {
                filtered.set(&id.to_string(), followers);
            }
            controller_record.set(field, Value::object(filtered));
        }
        next.set(handle, Value::object(controller_record));
    }
    record.set("_stykIK", Value::object(next));
}

/// `String(name).slice(0, 255)`: by UTF-16 code units.
fn first_255(text: &str) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if units > 255 {
            break;
        }
        out.push(c);
    }
    out
}

impl Editor {
    /// `disconnectSegment()`: the selected segment's branch becomes a new, unjoined figure across the whole animation.
    pub(crate) fn disconnect_segment(&mut self) -> Result<Value, EditError> {
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let select = "errors.editorDisconnect.selectASegmentThatIsOnlyPartOf";
        let Some((_, object)) = self.object()? else { return Err(invalid(select)) };
        let figure = self.figure_value(&object);
        let segment = usize::try_from(self.selection.joint).ok().and_then(|joint| figure.get("segments").and_then(|s| s.item(joint)));
        let Some(segment) = segment.filter(|_| self.selection.uids.len() == 1) else { return Err(invalid(select)) };
        // A movieclip or a drawing cel is not split.
        if figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy) || figure.path(&["_styk", "drawing"]).is_some_and(Value::truthy) {
            return Err(invalid(select));
        }
        let segment_count = figure.get("segments").and_then(Value::array_len).unwrap_or(0);
        let joint = self.selection.joint as usize;
        let indices = crate::builder::branch(&figure, joint, true, false).indices;
        if indices.len() >= segment_count {
            return Err(invalid(select));
        }
        let id = uid(&object).ok_or_else(|| invalid(select))?;
        let type_id = num(&figure, "figure_type_id").unwrap_or(f64::NAN);
        if self.report.path(&["_styk", "movieclipSource"]).is_some() {
            return Err(invalid("errors.editorDisconnect.disconnectIsNotAvailableInsideThisMovieclip"));
        }
        if self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            return Err(invalid("errors.editorDisconnect.updateOrDiscardTheWorkingFrameFirst"));
        }
        if self.layer_locked(id) {
            return Err(invalid("errors.editorDisconnect.unlockTheFigureBeforeDisconnectingASegment"));
        }
        let segments = items(figure.get("segments"));
        if segments.iter().any(|s| s.get("_stykRig").is_some_and(Value::truthy)) || figure.path(&["_styk", "spatialMesh"]).is_some_and(Value::truthy) {
            return Err(invalid("errors.editorDisconnect.figuresWithRigRelationshipsCannotBeSplit"));
        }
        let part: HashSet<u64> = indices.iter().filter_map(|&i| num(&segments[i], "segment_id")).map(key).collect();
        let base = num(&segment, "parent_id").unwrap_or(f64::NAN);
        // The animation pivot stays with the figure that keeps it: a part that holds it (or the rotation reference) cannot leave.
        if let Some(origin) = figure.path(&["_styk", "animationOrigin"]).filter(|origin| origin.truthy()) {
            let held = |name: &str| num(origin, name).is_some_and(|handle| part.contains(&key(handle)));
            if origin.get("support").is_some_and(Value::truthy) || held("handleId") || held("rotationHandleId") {
                return Err(invalid("errors.editorDisconnect.moveTheFigureOriginOffThisPartFirst"));
            }
        }
        let curves = |value: Option<&Value>| items(value).iter().any(|channel| channel.path(&["target", "uid"]).and_then(Value::as_f64) == Some(id as f64));
        if curves(self.report.path(&["_styk", "animation", "channels"])) || curves(self.report.path(&["_styk", "layerSheet", "legacyAnimation", "channels"])) {
            return Err(invalid("errors.editorDisconnect.thisFigureKeepsOlderAnimationCurves"));
        }
        let moves = moving_fills(&figure, &part, base)?;
        let behind = paints_behind(&figure, &part, &moves);
        // Every pose that shows the instance, and whether another instance shares its definition: linked instances keep the whole rig.
        let holds = |frame: &Value| objects_of(frame).iter().any(|o| uid(o) == Some(id) && num(o, "figure_type_id") == Some(type_id));
        let locations: Vec<Place> = places(&self.report).into_iter().filter(|place| frame_at(&self.report, place).is_some_and(holds)).collect();
        let shared = places(&self.report).iter().any(|place| {
            frame_at(&self.report, place).is_some_and(|frame| objects_of(frame).iter().any(|o| num(o, "figure_type_id") == Some(type_id) && uid(o) != Some(id)))
        });
        let name = segment.get("name").filter(|n| n.truthy()).and_then(Value::as_str).map(str::to_string);
        let cut = Cut { figure, segment, id, base, part, indices, moves, behind, shared, locations, name };
        self.movieclip_batch("Disconnect segment", |editor| editor.disconnect_in_batch(&cut))
    }

    fn disconnect_in_batch(&mut self, cut: &Cut) -> Result<Value, EditError> {
        const LABEL: &str = "Disconnect segment";
        let Cut { figure, segment, id, base, part, indices, moves, behind, shared, locations, name } = cut;
        let (id, base, behind, shared) = (*id, *base, *behind, *shared);
        if self.next_uid > 0x7fff_fffe {
            return Err(invalid("errors.editorLayerSheet.objectIdentityCapacityReached"));
        }
        let piece_uid = self.next_uid as u32;
        self.next_uid += 1;
        let type_id = num(figure, "figure_type_id").unwrap_or(f64::NAN);
        let definitions = items(self.report.get("figure_types"));
        let mut next_type = definitions.iter().filter_map(|f| num(f, "figure_type_id")).fold(0.0f64, f64::max) + 1.0;
        let owner_figure = if shared {
            let mut owner = figure.as_obj().cloned().unwrap_or_default();
            owner.set("figure_type_id", Value::Num(next_type));
            next_type += 1.0;
            Value::object(owner)
        } else {
            figure.clone()
        };
        let mut piece = figure.as_obj().cloned().unwrap_or_default();
        piece.set("figure_type_id", Value::Num(next_type));
        let title = match name {
            Some(name) => name.clone(),
            None => {
                let figure_name = figure.get("name").filter(|n| n.truthy()).and_then(Value::as_str).unwrap_or("Figure");
                format!("{figure_name} part")
            }
        };
        piece.set("name", Value::str(&first_255(&title)));
        if piece.get("_styk").and_then(|s| s.get("animationOrigin")).is_some_and(Value::truthy) {
            let mut styk = piece.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            styk.remove("animationOrigin");
            piece.set("_styk", Value::object(styk));
        }
        let piece_type = next_type;
        let owner_type = num(&owner_figure, "figure_type_id").unwrap_or(f64::NAN);
        let piece_figure = Value::object(piece);

        // The pose of the part in every frame that shows the instance: the displayed pose, where the part's joints are.
        let mut changes = Vec::with_capacity(locations.len());
        let mut bases = Vec::with_capacity(locations.len());
        for place in locations {
            let record = frame_at(&self.report, place).cloned().unwrap_or(Value::Null);
            let objects = objects_of(&record);
            let slot = objects.iter().position(|o| uid(o) == Some(id)).ok_or_else(|| EditError::Unported("a pose without the instance".into()))?;
            let source = objects[slot].clone();
            let (prepared, frame, scene) = self.posed_scene(&record)?;
            let Some(geometry) = scene.objects.iter().find(|g| g.uid == id && g.resolved) else { return Err(EditError::Unported("disconnecting a figure the engine does not draw".into())) };
            let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
            bases.push(self.joint_point(&prepared, &frame, &scene, slot, base).ok_or_else(|| EditError::Unported("disconnecting at a joint the engine does not place".into()))?);
            let root = geometry.root;
            let mut displayed = source.clone();
            let solution = solved.get(&id);
            if let Some(solution) = solution
                && let Some(record) = displayed.make_obj()
            {
                record.set("angles", Value::nums(&solution.solution.angles));
                if let Some(lengths) = &solution.solution.lengths {
                    record.set("len_flag", Value::Num(1.0));
                    record.set("lengths", Value::nums(lengths));
                }
            }
            let mut part_record = displayed.clone();
            if let Some(copy) = part_record.make_obj() {
                copy.set("unique_id", Value::Num(f64::from(piece_uid)));
                copy.set("figure_type_id", Value::Num(piece_type));
                copy.set("join", Value::Null);
                copy.set("root_x", Value::Num(root[0]));
                copy.set("root_y", Value::Num(root[1]));
                copy.remove("_stykAnimationOrigin");
                styk_eval::vfx::remap_owner(copy, piece_type, None, type_id);
            }
            // Figures joined to the part keep their followers in the part's limbs.
            let children: Vec<u32> = objects
                .iter()
                .filter(|o| crate::record::join_target(o) == Some(slot) && o.path(&["join", "target_handle_id"]).and_then(Value::as_f64).is_some_and(|h| part.contains(&key(h))))
                .filter_map(uid)
                .collect();
            keep_joined_followers(&mut part_record, &children);
            let order = match record.as_obj() {
                Some(frame_record) => crate::figures::frame_order(frame_record),
                None => Vec::new(),
            };
            let at = order.iter().position(|&o| o == f64::from(id)).map_or(0, |p| p + usize::from(!behind));
            let mut after_order = order.clone();
            after_order.insert(at.min(after_order.len()), f64::from(piece_uid));
            if shared
                && let Some(record) = displayed.make_obj()
            {
                record.set("figure_type_id", Value::Num(owner_type));
                styk_eval::vfx::remap_owner(record, owner_type, None, type_id);
            }
            let owner = (shared || solution.is_some()).then(|| (source.clone(), displayed.clone()));
            changes.push(Change { place: place.clone(), part: part_record, before_order: order, after_order, owner });
        }

        let figure_index = self.report.get("figure_types").and_then(Value::array_len).unwrap_or(0);
        let added: Vec<Value> = if shared { vec![owner_figure.clone(), piece_figure.clone()] } else { vec![piece_figure.clone()] };
        let command = Command {
            kind: CommandKind::Disconnect { piece: piece_uid, figure_index, figures: added.clone(), changes },
            label: LABEL.into(),
            before_selection: self.selection_state(),
            after_selection: self.selection_state(),
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers: false,
        };
        self.ensure_counts();
        let CommandKind::Disconnect { changes, .. } = &command.kind else { unreachable!() };
        let previous: Vec<Value> = changes.iter().filter_map(|change| frame_at(&self.report, &change.place).cloned()).collect();
        self.apply_disconnect_poses(&command, Direction::After);
        if let Some(list) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr) {
            list.extend(added);
        }
        self.new_layer_hints.insert(piece_uid, self.layer_of(id));
        let next: Vec<Value> = changes.iter().filter_map(|change| frame_at(&self.report, &change.place).cloned()).collect();
        let layers = self.track_frames(&previous, &next, true)?;
        let mut command = command;
        command.layers = layers;
        command.after_selection = self.selection_state();
        self.record(command)?;
        self.retained = None;

        // The piece keeps its side of the cut.
        let keep: Vec<usize> = indices.to_vec();
        let piece_index = figure_index + usize::from(shared);
        let segment_id = num(segment, "segment_id").unwrap_or(f64::NAN);
        let moves_piece: Vec<bool> = moves.to_vec();
        let locations_piece: Vec<Place> = locations.to_vec();
        self.topology_edit_of(Some(piece_index), LABEL, TopologyOptions::default(), |editor, index| {
            for (place, base_point) in locations_piece.iter().zip(&bases) {
                if let Some(objects) = frame_mut(&mut editor.report, place).and_then(|frame| frame.get_mut("objects")).and_then(Value::make_arr)
                    && let Some(copy) = objects.iter_mut().find(|o| uid(o) == Some(piece_uid))
                {
                    if let Some(record) = copy.make_obj() {
                        record.set("root_x", Value::Num(base_point[0]));
                        record.set("root_y", Value::Num(base_point[1]));
                    }
                    trim_pose(copy, &keep);
                }
            }
            let definition = editor.figure_at(index);
            let kept: Vec<Value> = keep.iter().filter_map(|&i| definition.get("segments").and_then(|s| s.item(i))).collect();
            let remap = |handle: f64| if handle == base { 0.0 } else { handle };
            let mut polygons = Vec::new();
            for (i, polygon) in items(definition.get("polyfills")).into_iter().enumerate() {
                if !moves_piece.get(i).copied().unwrap_or(false) {
                    continue;
                }
                polygons.push(remap_polygon(polygon, &remap));
            }
            if let Some(record) = editor.edit_figure(index) {
                let mut segments = Vec::with_capacity(kept.len());
                for mut segment in kept {
                    if num(&segment, "segment_id") == Some(segment_id)
                        && let Some(record) = segment.make_obj()
                    {
                        record.set("parent_id", Value::Num(0.0));
                    }
                    segments.push(segment);
                }
                record.set("segments", Value::array(segments));
                record.set("polyfills", Value::array(polygons));
            }
            Ok(())
        })?;

        // The owner keeps the rest: figures joined to the part stay joined to the same joint, now on the new figure.
        let owner_index = if shared { figure_index } else { definitions.iter().position(|f| num(f, "figure_type_id") == Some(type_id)).unwrap_or(0) };
        let part_keys = part.clone();
        let moves_owner: Vec<bool> = moves.to_vec();
        let locations_owner: Vec<Place> = locations.to_vec();
        self.topology_edit_of(Some(owner_index), LABEL, TopologyOptions::default(), |editor, index| {
            let definition = editor.figure_at(index);
            let segments = items(definition.get("segments"));
            let keep: Vec<usize> = (0..segments.len()).filter(|&i| !num(&segments[i], "segment_id").is_some_and(|handle| part_keys.contains(&key(handle)))).collect();
            for place in &locations_owner {
                let Some(objects) = frame_mut(&mut editor.report, place).and_then(|frame| frame.get_mut("objects")).and_then(Value::make_arr) else { continue };
                let (slot, piece_slot) = (objects.iter().position(|o| uid(o) == Some(id)), objects.iter().position(|o| uid(o) == Some(piece_uid)));
                let (Some(slot), Some(piece_slot)) = (slot, piece_slot) else { continue };
                for child in objects.iter_mut() {
                    let joined = child.path(&["join", "target_object_slot"]).and_then(Value::as_f64) == Some(slot as f64)
                        && child.path(&["join", "target_handle_id"]).and_then(Value::as_f64).is_some_and(|h| part_keys.contains(&key(h)));
                    if joined
                        && let Some(record) = child.make_obj()
                        && let Some(mut join) = record.get("join").and_then(Value::as_obj).cloned()
                    {
                        join.set("target_object_slot", Value::Num(piece_slot as f64));
                        join.set("target_unique_id", Value::Num(f64::from(piece_uid)));
                        record.set("join", Value::object(join));
                    }
                }
                trim_pose(&mut objects[slot], &keep);
            }
            let kept: Vec<Value> = keep.iter().map(|&i| segments[i].clone()).collect();
            let polygons: Vec<Value> = items(definition.get("polyfills")).into_iter().enumerate().filter(|(i, _)| !moves_owner.get(*i).copied().unwrap_or(false)).map(|(_, polygon)| polygon).collect();
            if let Some(record) = editor.edit_figure(index) {
                record.set("segments", Value::array(kept));
                record.set("polyfills", Value::array(polygons));
            }
            Ok(())
        })?;
        self.select_ids(vec![piece_uid]);
        Ok(self.object()?.map(|(_, o)| o).unwrap_or(Value::Null))
    }

    /// `applyDisconnectFrames(editor, command, direction)`: the part inserted in each pose (and the instance as the command
    /// changed it), or taken out again, with the drawing order and the slots following.
    fn apply_disconnect_poses(&mut self, command: &Command, direction: Direction) {
        let CommandKind::Disconnect { piece, changes, .. } = &command.kind else { return };
        let after = direction == Direction::After;
        for change in changes {
            let Some(frame) = frame_mut(&mut self.report, &change.place) else { continue };
            let mut objects = items(frame.get("objects"));
            if after {
                if let Some((_, owner)) = &change.owner
                    && let Some(at) = objects.iter().position(|o| uid(o) == uid(owner))
                {
                    objects[at] = owner.clone();
                }
                objects.push(change.part.clone());
            } else {
                if let Some(at) = objects.iter().position(|o| uid(o) == Some(*piece)) {
                    objects.remove(at);
                }
                if let Some((owner, _)) = &change.owner
                    && let Some(at) = objects.iter().position(|o| uid(o) == uid(owner))
                {
                    objects[at] = owner.clone();
                }
            }
            frame.set("objects", Value::array(objects));
            crate::figures::set_order(frame, if after { &change.after_order } else { &change.before_order });
            crate::figures::normalize_frame(frame);
        }
    }

    /// Undo or redo of a `disconnect` entry: the part and its definitions out of or into the poses and the library.
    pub(crate) fn apply_disconnect(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::Disconnect { figure_index, figures, changes, .. } = &command.kind else { return Ok(()) };
        let after = direction == Direction::After;
        self.ensure_counts();
        let previous: Vec<Value> = changes.iter().filter_map(|change| frame_at(&self.report, &change.place).cloned()).collect();
        self.apply_disconnect_poses(command, direction);
        if let Some(list) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr) {
            let at = (*figure_index).min(list.len());
            if after {
                list.splice(at..at, figures.iter().cloned());
            } else {
                list.drain(at..(at + figures.len()).min(list.len()));
            }
        }
        let current: Vec<Value> = changes.iter().filter_map(|change| frame_at(&self.report, &change.place).cloned()).collect();
        self.track_frames(&previous, &current, false)?;
        self.apply_attached_layer_changes(&command.layer_changes, direction);
        self.retained = None;
        let (selection, revision) = if after { (&command.after_selection, command.after_revision) } else { (&command.before_selection, command.before_revision) };
        self.restore_selection(selection)?;
        self.revision = revision;
        self.emit("history", vec![("label", Value::str(&command.label)), ("structural", Value::Bool(true)), ("timing", Value::Bool(false)), ("definition", Value::Bool(true)), ("animation", Value::Bool(false))]);
        Ok(())
    }
}

/// The polygon with its handles through `remap`, and its surface's (`remapSurface`).
fn remap_polygon(polygon: Value, remap: &dyn Fn(f64) -> f64) -> Value {
    let Some(source) = polygon.as_obj() else { return polygon };
    let mut next = source.clone();
    let mapped = |value: Option<&Value>| -> Option<Vec<f64>> { value.and_then(Value::numbers).map(|ids| ids.into_iter().map(remap).collect()) };
    if let Some(ids) = mapped(source.get("segment_ids")) {
        next.set("segment_ids", Value::nums(&ids));
        if source.get("segment_ids_raw").is_some_and(Value::truthy) {
            next.set("segment_ids_raw", Value::nums(&ids));
        }
    }
    if let Some(surface) = source.get("_stykSurface").filter(|s| s.truthy()).and_then(Value::as_obj) {
        let mut surface = surface.clone();
        if let Some(basis) = mapped(surface.get("basis")) {
            surface.set("basis", Value::nums(&basis));
        }
        if surface.get("depth").is_some_and(Value::truthy)
            && let Some(depth) = mapped(surface.get("depth"))
        {
            surface.set("depth", Value::nums(&depth));
        }
        next.set("_stykSurface", Value::object(surface));
    }
    Value::object(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        styk_doc::json::parse(text.as_bytes()).unwrap()
    }

    fn json(value: &Value) -> String {
        styk_doc::json::to_string(value)
    }

    fn handles(ids: &[f64]) -> HashSet<u64> {
        ids.iter().copied().map(key).collect()
    }

    #[test]
    fn a_fill_moves_with_its_part_unless_it_joins_both_sides() {
        let figure = parse(r#"{"polyfills":[{"segment_ids":[3,4]},{"segment_ids":[0,3,4]},{"segment_ids":[1,2]},{"segment_ids":[2,3,4]}]}"#);
        // The part is 3 and 4, hanging from 2; a fill may also use the joint it hangs from.
        let part = handles(&[3.0, 4.0]);
        let error = moving_fills(&figure, &part, 2.0).unwrap_err();
        assert!(matches!(&error, EditError::Invalid(key) if key == "errors.editorDisconnect.aFillJoinsThisPartToTheRest"), "{error:?}");
        let figure = parse(r#"{"polyfills":[{"segment_ids":[3,4]},{"segment_ids":[2,3]},{"segment_ids":[1,2]}]}"#);
        assert_eq!(moving_fills(&figure, &part, 2.0).unwrap(), vec![true, true, false]);
    }

    #[test]
    fn the_part_paints_behind_when_it_sat_under_the_rest() {
        let figure = parse(r#"{"segments":[{"segment_id":1,"z_order":5},{"segment_id":2,"z_order":6},{"segment_id":3,"z_order":1},{"segment_id":4}],"polyfills":[{"z_order":0}]}"#);
        let part = handles(&[3.0, 4.0]);
        // The part averages (1 + index 3 + the fill's 0) / 3, the rest (5 + 6) / 2.
        assert!(paints_behind(&figure, &part, &[true]));
        assert!(!paints_behind(&figure, &handles(&[1.0, 2.0]), &[false]));
    }

    #[test]
    fn a_pose_keeps_the_values_of_the_segments_kept() {
        let mut object = parse(r#"{"angles":[0.5,1,2,3],"len_flag":1,"lengths":[10,20,30,40],"bend_flag":0,"bends":[0,0,0,0],"runtime_segments":[1]}"#);
        trim_pose(&mut object, &[1, 3]);
        assert_eq!(json(&object), r#"{"angles":[1,3],"len_flag":1,"lengths":[20,40],"bend_flag":0,"bends":[0,0,0,0]}"#);
    }

    #[test]
    fn the_part_keeps_the_followers_of_the_figures_joined_to_it() {
        let mut object = parse(r#"{"_stykIK":{"4":{"enabled":true,"joinedFollowers":{"9":{"5":0.1},"7":{"5":0.2}},"joinedSpatialFollowers":{"7":{"5":[0,0,0,1]}},"followers":{"5":0.3}}}}"#);
        keep_joined_followers(&mut object, &[7]);
        assert_eq!(json(&object), r#"{"_stykIK":{"4":{"enabled":true,"joinedFollowers":{"7":{"5":0.2}},"joinedSpatialFollowers":{"7":{"5":[0,0,0,1]}},"followers":{"5":0.3}}}}"#);
    }

    #[test]
    fn a_name_is_cut_at_255_code_units() {
        assert_eq!(first_255(&"é".repeat(300)).chars().count(), 255);
        assert_eq!(first_255(&"😀".repeat(200)).chars().count(), 127);
    }
}
