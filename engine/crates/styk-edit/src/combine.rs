//! Combine connected figures: a figure and everything joined to it become one native figure in the
//! keyframe at the playhead, drawn as they were drawn (curves, circles, fills, colours, paint order) with the root's identity.
//! One `figure-splice` history entry holds the new definition and the keyframe before and after.
//!
//! Every segment and fill is combined as the frame draws it (`build_shapes`: pinned limbs as solved, colour transitions mixed,
//! the paint order of surfaces), with media (images, text) moved into the new figure's tables, rig relationships kept on their
//! authored angles and lengths, and surfaces renamed to the new handles. Groups with Stick Nodes shapes, 3D meshes, movieclips,
//! drawings or origins, and a document with saved animation channels (`authored`), answer `Unported`: the editor combines those.

use std::collections::{HashMap, HashSet};

use styk_doc::{Obj, Value};
use styk_eval::geometry::{Item, ItemKind, Scene};

use crate::figures::{frame_order, normalize_frame, set_order};
use crate::history::{Command, CommandKind};
use crate::record::{num, uid};
use crate::sheet::items;
use crate::{EditError, Editor};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn unported(what: &str) -> EditError {
    EditError::Unported(format!("combining figures {what}"))
}

/// `value ?? fallback`: neither absent nor `null`.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

fn truthy(value: &Value, name: &str) -> bool {
    value.get(name).is_some_and(Value::truthy)
}

/// A handle as a key: signed zeros alike, as `Map` has them.
fn key(id: f64) -> u64 {
    if id == 0.0 { 0 } else { id.to_bits() }
}

/// `alphaByte(alpha)`: the transparency byte an opacity is, when it is exactly one.
fn alpha_byte(alpha: f64) -> Result<f64, EditError> {
    let byte = crate::range_plan::js_round((1.0 - alpha) * 255.0);
    if !(0.0..=255.0).contains(&byte) || (1.0 - byte / 255.0 - alpha).abs() > 1e-10 {
        return Err(invalid("errors.editorCombine.thisOpacityCannotBeRepresentedExactlyInA"));
    }
    Ok(byte)
}

/// `joinedGroup(editor, uid)`: the slot of the figure and of everything joined to it, breadth first.
fn joined_group(objects: &[Value], id: u32) -> Result<Vec<usize>, EditError> {
    let Some(root) = objects.iter().position(|o| uid(o) == Some(id)) else { return Err(invalid("errors.editorCombine.selectAFigureWithAttachedChildren")) };
    let mut children: HashMap<u64, Vec<usize>> = HashMap::new();
    for (slot, object) in objects.iter().enumerate() {
        if let Some(parent) = object.get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_object_slot")) {
            children.entry(key(parent)).or_default().push(slot);
        }
    }
    let mut queue = vec![root];
    let mut taken: HashSet<usize> = HashSet::from([root]);
    let mut at = 0;
    while at < queue.len() {
        for &child in children.get(&key(queue[at] as f64)).map(Vec::as_slice).unwrap_or(&[]) {
            if taken.insert(child) {
                queue.push(child);
            }
        }
        at += 1;
    }
    Ok(queue)
}

fn rgb_value(rgb: [u8; 3]) -> Value {
    styk_eval::records::paint::rgb_value(rgb.map(f64::from))
}

/// The segment and fill primitives of each member as the frame draws them, by index (`geometry.segments`, `geometry.polys`).
struct Drawn<'a> {
    segments: Vec<Option<&'a Item>>,
    fills: Vec<Option<&'a Item>>,
}

fn drawn_of(scene: &Scene, slot: usize, segments: usize, fills: usize) -> Drawn<'_> {
    let mut drawn = Drawn { segments: vec![None; segments], fills: vec![None; fills] };
    for item in scene.measured.iter().filter(|item| item.slot as usize == slot) {
        let place = match item.kind {
            ItemKind::Mesh => continue,
            ItemKind::Poly => drawn.fills.get_mut(item.index as usize),
            _ => drawn.segments.get_mut(item.index as usize),
        };
        if let Some(place) = place {
            *place = Some(item);
        }
    }
    drawn
}

/// `sourceAssetIndex(segment)`: the entry of the figure's media table a segment draws.
fn asset_index(segment: &Value) -> f64 {
    let first = |value: Option<&Value>| present(value).and_then(Value::as_f64);
    first(segment.get("extra_u16"))
        .or_else(|| first(segment.get("extra").and_then(|extra| extra.item(0)).as_ref()))
        .or_else(|| first(segment.get("image_asset_index")))
        .or_else(|| first(segment.get("sprite_index")))
        .unwrap_or(0.0)
}

/// The decoded media a segment draws (`render.asset`): its entry in the figure's table, with the anchor a pivot and an
/// endpoint make when it has none.
fn media_of(figure: &Value, segment: &Value) -> Option<Obj> {
    let table = match segment.get("segment_type").and_then(Value::as_str)? {
        "text" => figure.get("text_assets"),
        "image" => figure.get("image_assets"),
        _ => return None,
    };
    let wanted = asset_index(segment);
    let number = |asset: &Value| ["asset_index", "table_index", "image_index", "sprite_index"].iter().find_map(|name| present(asset.get(name))).and_then(Value::as_f64);
    let asset = items(table).into_iter().find(|asset| number(asset) == Some(wanted))?;
    let mut asset = asset.as_obj().cloned().unwrap_or_default();
    let point = |name: &str| asset.get(name).filter(|p| p.truthy()).map(|p| [num(p, "x").unwrap_or(f64::NAN), num(p, "y").unwrap_or(f64::NAN)]);
    if !asset.get("anchor_length").is_some_and(Value::truthy)
        && let (Some(pivot), Some(end)) = (point("pivot"), point("endpoint"))
    {
        let (pivot_value, end_value) = (asset.get("pivot").cloned().unwrap_or(Value::Null), asset.get("endpoint").cloned().unwrap_or(Value::Null));
        asset.set("anchor_start", pivot_value);
        asset.set("anchor_end", end_value);
        asset.set("anchor_length", Value::Num(styk_math::hypot(end[0] - pivot[0], end[1] - pivot[1])));
        asset.set("anchor_angle_rad", Value::Num(styk_math::atan2(end[1] - pivot[1], end[0] - pivot[0])));
    }
    Some(asset)
}

impl Editor {
    /// `combineJoinedFigure(uid, {name})` on the keyframe at the playhead.
    pub(crate) fn combine_joined_figure(&mut self, requested: Option<&Value>, options: Option<&Value>) -> Result<Value, EditError> {
        let id = match present(requested) {
            None => self.selection.uid.ok_or_else(|| invalid("errors.editorCombine.selectAFigureWithAttachedChildren"))?,
            Some(Value::Num(n)) if n.fract() == 0.0 && *n >= 0.0 && *n <= f64::from(u32::MAX) => *n as u32,
            Some(_) => return Err(unported("of an identity that is not a number")),
        };
        let name = match options.and_then(|o| present(o.get("name"))) {
            None => None,
            Some(Value::Str(_)) => options.and_then(|o| o.get("name")).and_then(Value::as_str).map(str::to_string),
            Some(_) => return Err(unported("with a name that is not text")),
        };
        if options.is_some_and(|o| truthy(o, "authored")) {
            return Err(unported("inside an authored transaction"));
        }
        let index = self.frame_index;
        let frame = self.report.get("keyframes").and_then(|k| k.item(index)).ok_or_else(|| unported("without a keyframe"))?;
        let objects = items(frame.get("objects"));
        let slots = joined_group(&objects, id)?;
        let definitions = items(self.report.get("figure_types"));
        let figure_of = |object: &Value| definitions.iter().find(|f| num(f, "figure_type_id") == num(object, "figure_type_id")).cloned().unwrap_or(Value::Null);
        let segments_of = |figure: &Value| items(figure.get("segments"));
        if slots.iter().any(|&slot| segments_of(&figure_of(&objects[slot])).iter().any(|s| s.path(&["_stykRig", "spatial"]).is_some_and(Value::truthy))) {
            return Err(invalid("errors.editorCombine.keepSpatialRigsJoinedToPreserveTheirSkin"));
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) > 0 {
            return Err(unported("of a document with saved animation channels"));
        }
        if slots.len() < 2 {
            return Err(invalid("errors.editorCombine.joinAtLeastTwoFiguresBeforeCombining"));
        }
        let members: HashSet<u32> = slots.iter().filter_map(|&slot| uid(&objects[slot])).collect();
        if members.iter().any(|&member| self.layer_locked(member)) {
            return Err(invalid("errors.editorCombine.unlockEveryConnectedFigureBeforeCombining"));
        }
        let order = frame_order(frame.as_obj().ok_or_else(|| unported("without a keyframe"))?);
        let places: Vec<usize> = order.iter().enumerate().filter(|(_, member)| members.contains(&(**member as u32))).map(|(i, _)| i).collect();
        let first = places.first().copied().unwrap_or(0);
        if places.last().copied().unwrap_or(0) + 1 - first != places.len() {
            return Err(invalid("errors.editorCombine.moveTheJoinedFiguresToAdjacentLayersBefore"));
        }
        let (mut segment_total, mut polygon_total) = (0usize, 0usize);
        // Text is drawn at the scale of its figure: the combined figure keeps one for all of it.
        let mut scale: Option<f64> = None;
        for &slot in &slots {
            let (object, figure) = (&objects[slot], figure_of(&objects[slot]));
            // The editor combines a Stick Nodes shape, a 3D mesh, a movieclip, a drawing or an origin as it happens to leave them.
            if segments_of(&figure).iter().any(|s| truthy(s, "_sticknodes"))
                || ["spatialMesh", "movieclip", "drawing", "animationOrigin"].iter().any(|k| figure.path(&["_styk", k]).is_some_and(Value::truthy))
                || ["_sticknodesShapes", "_sticknodesSprite", "_stykAnimationOrigin"].iter().any(|k| truthy(object, k))
            {
                return Err(unported("with Stick Nodes shapes, a 3D mesh, a movieclip, a drawing or an origin"));
            }
            if truthy(object, "_stykVfx") {
                return Err(invalid("errors.editorCombine.combineCannotPreserveSeparateEffectStacksConvertThe"));
            }
            if present(object.get("field28")).or_else(|| present(object.get("transparency"))).and_then(Value::as_f64).unwrap_or(0.0) != 0.0 {
                return Err(invalid("errors.editorCombine.resetFigureOpacityTo100BeforeCombiningPer"));
            }
            let style = figure.path(&["segment_decode", "global_style"]);
            let outline = match style.and_then(|s| present(s.get("outline_thickness"))).and_then(Value::as_f64) {
                Some(thickness) => thickness,
                None => f64::from(f32::from_bits(style.and_then(|s| present(s.get("u28"))).and_then(Value::as_f64).unwrap_or(0.0) as u32)),
            };
            if outline > 0.0 {
                return Err(invalid("errors.editorCombine.removeFigureOutlinesBeforeCombiningSeparateOutlinePasses"));
            }
            segment_total += segments_of(&figure).len();
            polygon_total += items(figure.get("polyfills")).len();
            let object_scale = object.get("scale").and_then(Value::as_f64).unwrap_or(f64::NAN);
            if object_scale > 0.0 && segments_of(&figure).iter().any(|s| s.get("segment_type").and_then(Value::as_str) == Some("text")) {
                if scale.is_some_and(|known| (known - object_scale).abs() > 1e-10) {
                    return Err(invalid("errors.editorCombine.textFiguresMustHaveTheSameScaleBefore"));
                }
                scale = Some(object_scale);
            }
        }
        let scale = scale.unwrap_or(1.0);
        if segment_total > 30000 || polygon_total > 20000 {
            return Err(invalid("errors.editorCombine.theCombinedFigureExceedsTheSupported30000"));
        }
        // The figures' world positions are the root's: only the root figure's origin is kept.
        let (_, _, scene) = self.posed_shapes(&frame)?;
        let geometry_of = |slot: usize| scene.objects.get(slot).filter(|g| g.resolved && Some(g.uid) == uid(&objects[slot]));
        if slots.iter().any(|&slot| geometry_of(slot).is_none()) {
            return Err(unported("of a figure the engine does not draw"));
        }
        let root_point = geometry_of(slots[0]).map(|g| g.root).unwrap_or([f64::NAN; 2]);
        let constrained = slots.iter().any(|&slot| segments_of(&figure_of(&objects[slot])).iter().any(|s| truthy(s, "_stykRig")));
        let type_id = definitions.iter().filter_map(|f| num(f, "figure_type_id")).fold(0.0f64, f64::max) + 1.0;
        let title = name.unwrap_or_else(|| format!("{} combined", figure_of(&objects[slots[0]]).get("name").filter(|n| n.truthy()).and_then(Value::as_str).unwrap_or("Figure")));

        // The new handles, figure by figure; a figure's origin is the joint of its parent it hangs from.
        let mut handles: HashMap<u32, HashMap<u64, f64>> = HashMap::new();
        let mut next_handle = 1.0;
        for &slot in &slots {
            let mut map = HashMap::new();
            for segment in segments_of(&figure_of(&objects[slot])) {
                map.insert(key(num(&segment, "segment_id").unwrap_or(f64::NAN)), next_handle);
                next_handle += 1.0;
            }
            handles.insert(uid(&objects[slot]).unwrap_or(0), map);
        }
        for &slot in &slots {
            let object = &objects[slot];
            let member = uid(object).unwrap_or(0);
            let origin = if member == id {
                0.0
            } else {
                let join = object.get("join").cloned().unwrap_or(Value::Null);
                let parent = num(&join, "target_object_slot").and_then(|s| objects.get(s as usize)).and_then(uid).unwrap_or(0);
                handles.get(&parent).and_then(|m| m.get(&key(num(&join, "target_handle_id").unwrap_or(f64::NAN)))).copied().unwrap_or(f64::NAN)
            };
            handles.get_mut(&member).expect("every member has handles").insert(0, origin);
        }
        let mapped = |member: u32, handle: Option<&Value>| handles.get(&member).and_then(|m| m.get(&key(handle.and_then(Value::as_f64).unwrap_or(f64::NAN)))).map_or(Value::Null, |h| Value::Num(*h));

        let mut segments: Vec<Value> = Vec::with_capacity(segment_total);
        let mut polygons: Vec<Value> = Vec::with_capacity(polygon_total);
        // The media tables of the new figure, and which entry holds the media a figure's segment draws.
        let (mut image_assets, mut text_assets): (Vec<Value>, Vec<Value>) = (Vec::new(), Vec::new());
        let mut installed: HashMap<(u32, bool, u64), f64> = HashMap::new();
        // Where the segments and fills of each member begin in the new figure.
        let mut starts: HashMap<usize, (usize, usize)> = HashMap::new();
        for &slot in &slots {
            let object = &objects[slot];
            let member = uid(object).unwrap_or(0);
            let figure = figure_of(object);
            let originals = segments_of(&figure);
            let fills = items(figure.get("polyfills"));
            let drawn = drawn_of(&scene, slot, originals.len(), fills.len());
            let raw = crate::recolor::to_uint32(crate::recolor::override_raw(object));
            let rigged = originals.iter().any(|s| truthy(s, "_stykRig"));
            let object_scale = object.get("scale").and_then(Value::as_f64).unwrap_or(f64::NAN);
            starts.insert(slot, (segments.len(), polygons.len()));
            for (i, original) in originals.iter().enumerate() {
                let Some(item) = drawn.segments[i] else { return Err(unported("of a segment the engine does not draw")) };
                let alpha = item.alpha;
                let mut segment = original.as_obj().cloned().unwrap_or_default();
                segment.remove("_logical_segment_id");
                segment.remove("z_order_runtime_raw");
                segment.set("segment_id", mapped(member, original.get("segment_id")));
                segment.set("parent_id", mapped(member, original.get("parent_id")));
                segment.set("length", Value::Num(item.length / scale));
                segment.set("thickness", Value::Num(item.thickness / scale));
                segment.set("angle_rad", Value::Num(item.angle));
                segment.set("bend_rad", Value::Num(item.bend));
                segment.set("color_rgb", rgb_value(item.rgb));
                segment.set("transparency", Value::Num(alpha_byte(alpha)?));
                segment.set("color_alpha", Value::Num(alpha));
                segment.set("z_order", Value::Num(0.0));
                if rigged {
                    // A rig draws from the angles and lengths the figure was authored with: the new figure evaluates it again.
                    let factor = object_scale.abs() / scale;
                    let authored = |name: &str| object.get(name).and_then(|values| values.item(i)).and_then(|value| value.as_f64()).unwrap_or(f64::NAN);
                    let angle = match scene.objects[slot].solution.as_ref() {
                        Some(solution) => solution.angles.get(i).copied().unwrap_or(f64::NAN),
                        None => authored("angles"),
                    };
                    let connector = original.path(&["_stykRig", "connector"]).is_some_and(Value::truthy);
                    segment.set("angle_rad", Value::Num(angle + if object_scale < 0.0 { std::f64::consts::PI } else { 0.0 }));
                    let length = if truthy(object, "len_flag") { authored("lengths") } else { num(original, "length").unwrap_or(f64::NAN) };
                    segment.set("length", Value::Num(length * if connector { 1.0 } else { factor }));
                    segment.set("thickness", Value::Num(num(original, "thickness").unwrap_or(f64::NAN) * factor));
                    if let Some(mut rig) = segment.get("_stykRig").filter(|rig| rig.truthy()).and_then(Value::as_obj).cloned() {
                        for kind in ["connector", "stretch"] {
                            if let Some(mut relation) = rig.get(kind).filter(|relation| relation.truthy()).and_then(Value::as_obj).cloned() {
                                let rest = relation.get("restLength").and_then(Value::as_f64).unwrap_or(f64::NAN);
                                relation.set("restLength", Value::Num(rest * factor));
                                rig.set(kind, Value::object(relation));
                            }
                        }
                        segment.set("_stykRig", Value::object(rig));
                    }
                    let mut renamed = Value::object(segment);
                    let pairs: Vec<(f64, f64)> = handles.get(&member).map(|m| m.iter().map(|(from, to)| (f64::from_bits(*from), *to)).collect()).unwrap_or_default();
                    crate::topology::remap_rig_references(&mut renamed, &pairs)?;
                    segment = renamed.as_obj().cloned().unwrap_or_default();
                }
                // Parts of a rig that hung from the root's origin keep their orientation in the world.
                if constrained && num(original, "parent_id") == Some(0.0) && member != id {
                    let mut rig = segment.get("_stykRig").filter(|rig| rig.truthy()).and_then(Value::as_obj).cloned().unwrap_or_default();
                    rig.set("orientation", Value::str("world"));
                    segment.set("_stykRig", Value::object(rig));
                }
                if segment.get("secondary").is_some_and(Value::truthy) {
                    if raw >> 24 == 255 {
                        segment.set("secondary", Value::Null);
                    } else if raw >> 24 != 0
                        && segment.get("segment_type").and_then(Value::as_str) != Some("text")
                        && let Some(mut secondary) = segment.get("secondary").and_then(Value::as_obj).cloned()
                    {
                        if let Some(base) = styk_eval::records::paint::rgb_of_value(secondary.get("rgb")) {
                            secondary.set("rgb", styk_eval::records::paint::rgb_value(crate::recolor::mix_color(base, f64::from(raw))));
                        }
                        segment.set("secondary", Value::object(secondary));
                    }
                }
                if let Some(kind) = original.get("segment_type").and_then(Value::as_str).filter(|kind| matches!(*kind, "image" | "text")) {
                    let is_image = kind == "image";
                    let wanted = asset_index(original);
                    let at = match installed.get(&(member, is_image, wanted.to_bits())) {
                        Some(at) => *at,
                        None => {
                            let Some(mut asset) = media_of(&figure, original) else { return Err(invalid("errors.editorCombine.anAttachedMediaSegmentIsMissingItsDecoded")) };
                            let table = if is_image { &mut image_assets } else { &mut text_assets };
                            let next = table.len() as f64;
                            asset.set("kind", Value::str(kind));
                            asset.set("asset_index", Value::Num(next));
                            asset.set("table_index", Value::Num(next));
                            for alias in ["image_index", "sprite_index"] {
                                if asset.contains(alias) {
                                    asset.set(alias, Value::Num(next));
                                }
                            }
                            table.push(Value::object(asset));
                            installed.insert((member, is_image, wanted.to_bits()), next);
                            next
                        }
                    };
                    segment.set("extra_u16", Value::Num(at));
                    let flag = |name: &str, place: usize| match present(segment.get(name)) {
                        Some(value) => value.truthy(),
                        None => present(segment.get("extra").and_then(|extra| extra.item(place)).as_ref()).is_some_and(Value::truthy),
                    };
                    let first = flag("extra_u8_a", 1);
                    let second = flag("extra_u8_b", 2) != truthy(object, "image_text_flags");
                    segment.set("extra_u8_a", Value::Num(f64::from(u8::from(first))));
                    segment.set("extra_u8_b", Value::Num(f64::from(u8::from(second))));
                    segment.set("extra", Value::nums(&[at, f64::from(u8::from(first)), f64::from(u8::from(second))]));
                }
                segments.push(Value::object(segment));
            }
            for (i, original) in fills.iter().enumerate() {
                let Some(item) = drawn.fills[i] else { return Err(unported("of a fill the engine does not draw")) };
                let alpha = item.alpha;
                let mut polygon = original.as_obj().cloned().unwrap_or_default();
                polygon.set("polyfill_id", Value::Num((polygons.len() + 1) as f64));
                let ids: Vec<Value> = items(original.get("segment_ids")).iter().map(|handle| mapped(member, Some(handle))).collect();
                polygon.set("segment_ids", Value::array(ids.clone()));
                polygon.set("segment_ids_raw", Value::array(ids));
                if let Some(surface) = polygon.get("_stykSurface").filter(|surface| surface.truthy()).and_then(Value::as_obj).cloned() {
                    let renamed = |list: Option<&Value>| Value::array(items(list).iter().map(|handle| mapped(member, Some(handle))).collect());
                    let mut next = surface.clone();
                    next.set("basis", renamed(surface.get("basis")));
                    if surface.get("depth").is_some_and(Value::truthy) {
                        next.set("depth", renamed(surface.get("depth")));
                    }
                    polygon.set("_stykSurface", Value::object(next));
                }
                polygon.set("color_rgb", rgb_value(item.rgb));
                polygon.set("alpha_raw", Value::Num(alpha_byte(alpha)?));
                polygon.set("color_alpha", Value::Num(alpha));
                polygon.set("z_order", Value::Num(0.0));
                polygon.remove("z_order_runtime_raw");
                polygons.push(Value::object(polygon));
            }
        }
        // Paint order: what the frame draws of the members, figure by figure in its drawing order.
        let mut rank = 1.0;
        for item in scene.items.iter().filter(|item| starts.contains_key(&(item.slot as usize))) {
            let (first_segment, first_fill) = starts[&(item.slot as usize)];
            let (list, at) = match item.kind {
                ItemKind::Mesh => continue,
                ItemKind::Poly => (&mut polygons, first_fill + item.index as usize),
                _ => (&mut segments, first_segment + item.index as usize),
            };
            if let Some(record) = list.get_mut(at).and_then(Value::make_obj) {
                record.set("z_order", Value::Num(rank));
                record.set("z_order_runtime_raw", Value::Num(rank - 1.0));
            }
            rank += 1.0;
        }

        let angles: Vec<f64> = segments.iter().map(|s| num(s, "angle_rad").unwrap_or(f64::NAN)).collect();
        let mut figure = Obj::new();
        figure.set("figure_type_id", Value::Num(type_id));
        figure.set("name", Value::str(&title.chars().scan(0usize, |units, c| { *units += c.len_utf16(); (*units <= 255).then_some(c) }).collect::<String>()));
        figure.set("segments", Value::array(segments));
        figure.set("polyfills", Value::array(polygons));
        figure.set("image_assets", Value::array(image_assets));
        figure.set("text_assets", Value::array(text_assets));
        figure.set("segment_count", Value::Num(segment_total as f64));
        let mut styk = Obj::new();
        styk.set("colorMode", Value::str("segments"));
        figure.set("_styk", Value::object(styk));
        let figure = Value::object(figure);
        crate::topology::validate_definition(&figure)?;

        // The keyframe with the group replaced by the one figure, at the group's place in the drawing order; every join follows by identity.
        let mut combined = objects[slots[0]].as_obj().cloned().unwrap_or_default();
        combined.set("scale", Value::Num(scale));
        combined.set("figure_type_id", Value::Num(type_id));
        combined.set("root_x", Value::Num(root_point[0]));
        combined.set("root_y", Value::Num(root_point[1]));
        combined.set("color_override_raw", Value::Num(0.0));
        combined.set("field28", Value::Num(0.0));
        combined.set("image_text_flags", Value::Num(0.0));
        combined.set("angles", Value::nums(&angles));
        combined.set("len_flag", Value::Num(0.0));
        combined.set("lengths", Value::array(Vec::new()));
        combined.set("bend_flag", Value::Num(0.0));
        combined.set("bends", Value::array(Vec::new()));
        combined.remove("runtime_segments");
        let by_identity = |record: &mut Obj| {
            if let Some(mut join) = record.get("join").filter(|j| j.truthy()).and_then(Value::as_obj).cloned() {
                let target = num(&Value::object(join.clone()), "target_object_slot").and_then(|s| objects.get(s as usize)).and_then(|o| o.get("unique_id").cloned());
                join.set("target_unique_id", target.unwrap_or(Value::Null));
                record.set("join", Value::object(join));
            }
        };
        let mut kept: Vec<Obj> = Vec::with_capacity(objects.len());
        for object in &objects {
            let mut record = object.as_obj().cloned().unwrap_or_default();
            by_identity(&mut record);
            if !uid(object).is_some_and(|member| members.contains(&member)) {
                kept.push(record);
            }
        }
        by_identity(&mut combined);
        kept.push(combined);
        let slot_by_uid: HashMap<u32, usize> = kept.iter().enumerate().filter_map(|(i, o)| o.get("unique_id").and_then(Value::as_f64).map(|u| (u as u32, i))).collect();
        let renumbered: Vec<Value> = kept
            .into_iter()
            .enumerate()
            .map(|(i, mut record)| {
                record.set("object_slot", Value::Num(i as f64));
                if let Some(mut join) = record.get("join").filter(|j| j.truthy()).and_then(Value::as_obj).cloned() {
                    let target = join.get("target_unique_id").and_then(Value::as_f64).and_then(|u| slot_by_uid.get(&(u as u32)));
                    join.set("target_object_slot", target.map_or(Value::Null, |slot| Value::Num(*slot as f64)));
                    record.set("join", Value::object(join));
                }
                Value::object(record)
            })
            .collect();
        let mut next_order: Vec<f64> = order.iter().copied().filter(|member| !members.contains(&(*member as u32))).collect();
        next_order.insert(first.min(next_order.len()), f64::from(id));
        let mut after_frame = frame.as_obj().cloned().unwrap_or_default();
        after_frame.set("objects", Value::array(renumbered));
        set_order(&mut after_frame, &next_order);
        normalize_frame(&mut after_frame);
        let after_frame = Value::object(after_frame);

        self.ensure_counts();
        let before_selection = self.selection_state();
        let figure_index = definitions.len();
        if let Some(list) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr) {
            list.push(figure.clone());
        }
        if let Some(frames) = self.report.make_obj().and_then(|r| r.get_mut("keyframes")).and_then(Value::make_arr)
            && let Some(slot) = frames.get_mut(index)
        {
            *slot = after_frame.clone();
        }
        self.select_ids(vec![id]);
        let layers = self.track_frames(std::slice::from_ref(&frame), std::slice::from_ref(&after_frame), true)?;
        let side = |figures: Vec<Value>, frame: Value| {
            let mut side = Obj::new();
            side.set("figures", Value::array(figures));
            side.set("frame", frame);
            Value::object(side)
        };
        self.retained = None;
        self.record(Command {
            kind: CommandKind::FigureSplice { index, figure_index, before: side(Vec::new(), frame), after: side(vec![figure], after_frame) },
            label: "Combine joined figures".into(),
            before_selection,
            after_selection: self.selection_state(),
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers,
        })?;
        self.emit("edit", vec![("label", Value::str("Combine joined figures")), ("structural", Value::Bool(true)), ("definition", Value::Bool(true))]);
        Ok(self.object()?.map(|(_, o)| o).unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        styk_doc::json::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn the_group_is_the_figure_and_everything_joined_below_it_breadth_first() {
        // 0 root; 1 and 2 hang from it; 3 from 1; 4 hangs from nothing.
        let objects: Vec<Value> = [
            r#"{"unique_id":10}"#,
            r#"{"unique_id":11,"join":{"target_object_slot":0}}"#,
            r#"{"unique_id":12,"join":{"target_object_slot":0}}"#,
            r#"{"unique_id":13,"join":{"target_object_slot":1}}"#,
            r#"{"unique_id":14}"#,
        ].iter().map(|text| parse(text)).collect();
        assert_eq!(joined_group(&objects, 10).unwrap(), vec![0, 1, 2, 3]);
        assert_eq!(joined_group(&objects, 11).unwrap(), vec![1, 3]);
        assert_eq!(joined_group(&objects, 14).unwrap(), vec![4]);
        assert!(matches!(joined_group(&objects, 99), Err(EditError::Invalid(key)) if key == "errors.editorCombine.selectAFigureWithAttachedChildren"));
    }

    #[test]
    fn an_opacity_is_a_transparency_byte_only_when_it_is_exactly_one() {
        assert_eq!(alpha_byte(1.0).unwrap(), 0.0);
        assert_eq!(alpha_byte(1.0 - 128.0 / 255.0).unwrap(), 128.0);
        assert_eq!(alpha_byte(0.0).unwrap(), 255.0);
        // Half is not a byte of 255.
        assert!(alpha_byte(0.5).is_err());
        assert!(alpha_byte(f64::NAN).is_err());
    }

    #[test]
    fn a_segment_draws_the_media_its_index_names_with_the_anchor_its_pivot_and_endpoint_make() {
        let figure = parse(r#"{"image_assets":[{"asset_index":0},{"table_index":3,"pivot":{"x":1,"y":1},"endpoint":{"x":4,"y":5}}],"text_assets":[{"image_index":2}]}"#);
        let image = parse(r#"{"segment_type":"image","extra":[3,1,0]}"#);
        assert_eq!(asset_index(&image), 3.0);
        let asset = media_of(&figure, &image).unwrap();
        // A 3-4-5 triangle: the anchor runs from the pivot to the endpoint.
        assert_eq!(asset.get("anchor_length").and_then(Value::as_f64), Some(5.0));
        assert_eq!(asset.get("anchor_angle_rad").and_then(Value::as_f64), Some(styk_math::atan2(4.0, 3.0)));
        // The text table is another table, and an index nothing names has no media.
        let text = parse(r#"{"segment_type":"text","extra_u16":2}"#);
        assert!(media_of(&figure, &text).is_some());
        assert!(media_of(&figure, &parse(r#"{"segment_type":"text","extra_u16":0}"#)).is_none());
        assert!(media_of(&figure, &parse(r#"{"segment_type":"line"}"#)).is_none());
    }
}
