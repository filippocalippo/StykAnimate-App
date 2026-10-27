//! The Pivot 5 frame table (`backend/fast_decode.py`, `native/piv-frame-scan.cpp`).
//!
//! One pass validates every frame and records where each object's arrays are;
//! what happens next depends on the caller:
//!
//! - [`FrameMode::Build`] turns the records into document values (the JSON import);
//! - [`FrameMode::Validate`] stops there (writers only need the source to be valid);
//! - [`FrameMode::Scan`] also charges the pose budget and reports duplicate object
//!   IDs, which is what the native-frame transport runs before it hands the
//!   original frame bytes to the editor.
//!
//! The checks, their order and their messages are the Python reader's.

use std::collections::HashSet;
use std::sync::Arc;

use styk_doc::{Nums, Obj, Shape, Value};

use crate::ctx::{Ctx, ObjB, int, num, shape};
use crate::error::{PyResult, piv, piv_identity};

/// Estimated editor memory the native-frame transport admits: 2560 MiB.
pub(crate) const NATIVE_POSE_BUDGET: u64 = 2560 * 1024 * 1024;

/// What the frame reader needs to know about a figure definition.
pub(crate) struct FigureInfo {
    pub id: i64,
    pub count: usize,
    pub has_media: bool,
    /// `0` and every segment ID, sorted.
    pub handles: Vec<u16>,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum FrameMode {
    Build,
    Validate,
    Scan { max_pose_bytes: u64 },
}

struct ObjectRecord {
    uid: u32,
    tid: u16,
    start: usize,
    end: usize,
    scale: f32,
    color: u32,
    transparency: u8,
    media: Option<u8>,
    /// Offset of the angle array; the root position follows it.
    pose_at: usize,
    count: usize,
    len_flag: u16,
    lengths_at: usize,
    bend_flag: u16,
    bends_at: usize,
    join: Option<(u16, u16)>,
}

struct FrameRecord {
    start: usize,
    end: usize,
    duration: u16,
    mix: u8,
    background: u16,
    background_b: Option<u16>,
    objects: std::ops::Range<usize>,
    order_at: usize,
    default_camera: u8,
    camera_at: usize,
}

/// One duplicate object ID that recovery renamed.
pub(crate) struct Repair {
    pub keyframe_index: usize,
    pub object_slot: usize,
    pub source_unique_id: u32,
    pub unique_id: u32,
    pub record_offset: usize,
}

/// The validated frame table.
pub(crate) struct Frames {
    pub durations: Vec<u16>,
    /// The frames as document values ([`FrameMode::Build`], and a scan that found duplicates).
    pub values: Option<Vec<Value>>,
    pub repairs: Vec<Repair>,
    /// Offset after the last frame.
    pub end: usize,
}

#[inline]
fn all_finite_f64(bytes: &[u8]) -> bool {
    bytes.as_chunks::<8>().0.iter().all(|c| (c[7] & 0x7f) != 0x7f || (c[6] & 0xf0) != 0xf0)
}

#[inline]
fn all_finite_f32(bytes: &[u8]) -> bool {
    bytes.as_chunks::<4>().0.iter().all(|c| (c[3] & 0x7f) != 0x7f || (c[2] & 0x80) != 0x80)
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    /// The next `size` bytes (one of the reader's `struct` records).
    #[inline]
    fn take(&mut self, size: usize) -> PyResult<&'a [u8]> {
        match self.data.get(self.pos..self.pos.wrapping_add(size)) {
            Some(bytes) => {
                self.pos += size;
                Ok(bytes)
            }
            None => Err(piv(format!("Unexpected EOF at payload offset {:#x}", self.pos))),
        }
    }
}

#[inline]
fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

#[inline]
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

#[inline]
fn f32_at(bytes: &[u8], at: usize) -> f32 {
    f32::from_bits(u32_at(bytes, at))
}

#[inline]
fn f64_at(bytes: &[u8], at: usize) -> f64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    f64::from_le_bytes(word)
}

/// `piv_codec._object_id_error`.
fn object_id_error(uid: u32, first: usize, frame: usize, object: usize, offset: usize) -> Box<crate::error::PyErr> {
    piv_identity(format!(
        "Pivot keyframe {}, object {}: duplicate object ID {} (also used by object {}) at payload offset {:#x}. Identity recovery is required.",
        frame + 1,
        object + 1,
        uid,
        first + 1,
        offset
    ))
}

/// Reads the frame table that starts at `start`.
///
/// In [`FrameMode::Scan`], duplicate object IDs are reported as a
/// `PivIdentityError` only after the whole table validated, as the Python
/// scanner does; the caller then asks for [`FrameMode::Build`].
pub(crate) fn read_frames(ctx: &Ctx<'_>, data: &[u8], start: usize, figures: &[FigureInfo], bg_slots: u32, mode: FrameMode) -> PyResult<Frames> {
    let mut by_id: Vec<u32> = vec![u32::MAX; 65536];
    for (index, figure) in figures.iter().enumerate() {
        if (0..65536).contains(&figure.id) {
            by_id[figure.id as usize] = index as u32;
        }
    }
    let mut pose_bytes: u64 = 0;
    let budget = if let FrameMode::Scan { max_pose_bytes } = mode { Some(max_pose_bytes) } else { None };
    let mut reserve = |bytes: u64| -> PyResult<()> {
        if let Some(maximum) = budget {
            pose_bytes += bytes;
            if pose_bytes > maximum {
                return Err(piv(format!("Native scene exceeds the {} MiB pose budget", maximum / (1024 * 1024))));
            }
        }
        Ok(())
    };
    let mut cursor = Cursor { data, pos: start };
    let count = u32_at(cursor.take(4)?, 0);
    if count > 1_000_000 {
        return Err(piv(format!("Implausible keyframe count {} at {:#x}", count, cursor.pos - 4)));
    }
    reserve(count as u64 * 512)?;
    let mut frames: Vec<FrameRecord> = Vec::with_capacity(count as usize);
    let mut objects: Vec<ObjectRecord> = Vec::new();
    let mut identity_error = None;
    let mut seen: Vec<(u32, u32)> = Vec::new();
    let mut checked: Vec<u8> = Vec::new();
    let mut order_seen: Vec<bool> = Vec::new();
    for fi in 0..count as usize {
        ctx.checkpoint()?;
        let frame_start = cursor.pos;
        let head = cursor.take(5)?;
        let (duration, mix, background) = (u16_at(head, 0), head[2], u16_at(head, 3));
        let background_b = if mix != 0 { Some(u16_at(cursor.take(2)?, 0)) } else { None };
        if background as u32 >= bg_slots || background_b.is_some_and(|b| b as u32 >= bg_slots) {
            return Err(piv(format!("Unknown background in frame {} at {:#x}", fi, frame_start)));
        }
        let object_count = u16_at(cursor.take(2)?, 0) as usize;
        reserve(object_count as u64 * 512)?;
        let first_object = objects.len();
        for oi in 0..object_count {
            ctx.checkpoint()?;
            let object_start = cursor.pos;
            let head = cursor.take(15)?;
            let (uid, tid, scale, color, transparency) = (u32_at(head, 0), u16_at(head, 4), f32_at(head, 6), u32_at(head, 10), head[14]);
            let figure = match by_id[tid as usize] {
                u32::MAX => return Err(piv(format!("Unknown figure type {} in frame {}, object {} at {:#x}", tid, fi, oi, object_start))),
                index => &figures[index as usize],
            };
            if !scale.is_finite() {
                return Err(piv(format!("Non-finite /keyframes/{}/objects/{}/scale", fi, oi)));
            }
            let sc = figure.count;
            let media = if figure.has_media { Some(cursor.take(1)?[0]) } else { None };
            reserve(sc as u64 * 24)?;
            let pose_at = cursor.pos;
            let pose = cursor.take(sc * 8 + 10)?;
            if !all_finite_f64(&pose[..sc * 8]) || !all_finite_f32(&pose[sc * 8..sc * 8 + 8]) {
                return Err(piv(format!("Non-finite pose in frame {}, object {}", fi, oi)));
            }
            let len_flag = u16_at(pose, sc * 8 + 8);
            let lengths_at = cursor.pos;
            let bend_flag = if len_flag != 0 {
                reserve(sc as u64 * 24)?;
                let lengths = cursor.take(sc * 4 + 2)?;
                if !all_finite_f32(&lengths[..sc * 4]) {
                    return Err(piv(format!("Non-finite lengths in frame {}, object {}", fi, oi)));
                }
                u16_at(lengths, sc * 4)
            } else {
                u16_at(cursor.take(2)?, 0)
            };
            let bends_at = cursor.pos;
            let join_flag = if bend_flag != 0 {
                reserve(sc as u64 * 24)?;
                let bends = cursor.take(sc * 8 + 1)?;
                if !all_finite_f64(&bends[..sc * 8]) {
                    return Err(piv(format!("Non-finite bends in frame {}, object {}", fi, oi)));
                }
                bends[sc * 8]
            } else {
                cursor.take(1)?[0]
            };
            let join = if join_flag != 0 {
                reserve(64)?;
                let link = cursor.take(4)?;
                let (slot, handle) = (u16_at(link, 0), u16_at(link, 2));
                if slot as usize >= object_count {
                    return Err(piv(format!("Invalid joined object slot {} in frame {}", slot, fi)));
                }
                Some((slot, handle))
            } else {
                None
            };
            objects.push(ObjectRecord {
                uid,
                tid,
                start: object_start,
                end: cursor.pos,
                scale,
                color,
                transparency,
                media,
                pose_at,
                count: sc,
                len_flag,
                lengths_at,
                bend_flag,
                bends_at,
                join,
            });
        }
        let records = &objects[first_object..];
        if budget.is_some() && identity_error.is_none() {
            // The first repeated ID in record order, with the slot that used it first.
            seen.clear();
            seen.extend(records.iter().enumerate().map(|(slot, record)| (record.uid, slot as u32)));
            seen.sort_unstable();
            let repeated = seen.windows(2).filter(|pair| pair[0].0 == pair[1].0).map(|pair| pair[1].1).min();
            if let Some(slot) = repeated {
                let record = &records[slot as usize];
                let first = records.iter().position(|other| other.uid == record.uid).unwrap_or(0);
                identity_error = Some(object_id_error(record.uid, first, fi, slot as usize, record.start));
            }
        }
        for record in records {
            if let Some((slot, handle)) = record.join {
                let target = &figures[by_id[records[slot as usize].tid as usize] as usize];
                if target.handles.binary_search(&handle).is_err() {
                    return Err(piv(format!("Unknown joined target handle in frame {}", fi)));
                }
            }
        }
        // 0 = unseen, 1 = on the current path, 2 = done: each object is visited at most twice.
        checked.clear();
        checked.resize(object_count, 0);
        for oi in 0..object_count {
            let mut at = Some(oi);
            while let Some(index) = at.filter(|&index| checked[index] == 0) {
                checked[index] = 1;
                at = records[index].join.map(|(slot, _)| slot as usize);
            }
            if at.is_some_and(|index| checked[index] == 1) {
                return Err(piv(format!("Cyclic object joins in frame {}", fi)));
            }
            let mut at = Some(oi);
            while let Some(index) = at.filter(|&index| checked[index] == 1) {
                checked[index] = 2;
                at = records[index].join.map(|(slot, _)| slot as usize);
            }
        }
        let order_at = cursor.pos;
        let order = cursor.take(object_count * 2)?;
        order_seen.clear();
        order_seen.resize(object_count, false);
        for pair in order.as_chunks::<2>().0 {
            let slot = u16::from_le_bytes(*pair) as usize;
            if slot >= object_count || order_seen[slot] {
                return Err(piv(format!("Invalid object draw-order permutation in frame {} at {:#x}", fi, cursor.pos)));
            }
            order_seen[slot] = true;
        }
        let default_camera = cursor.take(1)?[0];
        let camera_at = cursor.pos;
        if default_camera == 0 {
            let camera = cursor.take(20)?;
            if !all_finite_f32(&camera[..8]) || !all_finite_f64(&camera[8..16]) || !all_finite_f32(&camera[16..]) {
                return Err(piv(format!("Non-finite camera in frame {}", fi)));
            }
        }
        frames.push(FrameRecord {
            start: frame_start,
            end: cursor.pos,
            duration,
            mix,
            background,
            background_b,
            objects: first_object..objects.len(),
            order_at,
            default_camera,
            camera_at,
        });
    }
    let durations: Vec<u16> = frames.iter().map(|frame| frame.duration).collect();
    let end = cursor.pos;
    if let Some(error) = identity_error {
        return Err(error);
    }
    if mode != FrameMode::Build {
        return Ok(Frames { durations, values: None, repairs: Vec::new(), end });
    }
    let repairs = recover_object_ids(&frames, &mut objects)?;
    let values = build_values(ctx, data, &frames, &objects)?;
    Ok(Frames { durations, values: Some(values), repairs, end })
}

/// `piv_codec._recover_object_ids`: gives every extra occurrence of an object
/// ID within a keyframe a fresh ID unused anywhere in the animation.
fn recover_object_ids(frames: &[FrameRecord], objects: &mut [ObjectRecord]) -> PyResult<Vec<Repair>> {
    let mut duplicates: Vec<(usize, usize)> = Vec::new();
    let mut seen: Vec<(u32, u32)> = Vec::new();
    for (fi, frame) in frames.iter().enumerate() {
        let records = &objects[frame.objects.clone()];
        seen.clear();
        seen.extend(records.iter().enumerate().map(|(slot, record)| (record.uid, slot as u32)));
        seen.sort_unstable();
        // Every occurrence after the first of each ID, in slot order.
        let mut repeated: Vec<u32> = seen.windows(2).filter(|pair| pair[0].0 == pair[1].0).map(|pair| pair[1].1).collect();
        repeated.sort_unstable();
        duplicates.extend(repeated.into_iter().map(|slot| (fi, slot as usize)));
    }
    if duplicates.is_empty() {
        return Ok(Vec::new());
    }
    let mut reserved: HashSet<u32> = objects.iter().map(|record| record.uid).collect();
    let mut repairs = Vec::with_capacity(duplicates.len());
    let mut candidate: u64 = 1;
    for (fi, slot) in duplicates {
        while candidate <= u32::MAX as u64 && reserved.contains(&(candidate as u32)) {
            candidate += 1;
        }
        if candidate > u32::MAX as u64 {
            return Err(piv("No unused object identity remains for PIV recovery"));
        }
        let record = &mut objects[frames[fi].objects.start + slot];
        repairs.push(Repair { keyframe_index: fi, object_slot: slot, source_unique_id: record.uid, unique_id: candidate as u32, record_offset: record.start });
        record.uid = candidate as u32;
        reserved.insert(candidate as u32);
    }
    Ok(repairs)
}

struct Shapes {
    object: Arc<Shape>,
    object_media: Arc<Shape>,
    join: Arc<Shape>,
    camera: Arc<Shape>,
    frame: Arc<Shape>,
}

/// A packed array straight from the file's doubles: single precision when
/// every value is exactly a 32-bit float (what `Nums::new` decides), in one pass each.
fn nums_f64(bytes: &[u8], empty: &Value) -> Value {
    if bytes.is_empty() {
        return empty.clone();
    }
    let values = bytes.as_chunks::<8>().0.iter().map(|c| f64::from_le_bytes(*c));
    let packed = if values.clone().all(|v| (v as f32) as f64 == v) { Nums::F32(values.map(|v| v as f32).collect()) } else { Nums::F64(values.collect()) };
    Value::Nums(Arc::new(packed))
}

fn nums_f32(bytes: &[u8], empty: &Value) -> Value {
    if bytes.is_empty() {
        return empty.clone();
    }
    Value::Nums(Arc::new(Nums::F32(bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect())))
}

fn build_values(ctx: &Ctx<'_>, data: &[u8], frames: &[FrameRecord], objects: &[ObjectRecord]) -> PyResult<Vec<Value>> {
    let object_keys = [
        "object_slot",
        "unique_id",
        "figure_type_id",
        "scale",
        "color_override_raw",
        "field28",
        "angles",
        "root_x",
        "root_y",
        "color_override_rgb",
        "color_override_mix",
        "transparency",
        "opacity",
        "len_flag",
        "lengths",
        "bend_flag",
        "bends",
        "join",
        "record_offset",
        "record_end",
    ];
    let mut media_keys = object_keys.to_vec();
    media_keys.insert(6, "image_text_flags");
    let shapes = Shapes {
        object: shape(&object_keys),
        object_media: shape(&media_keys),
        join: shape(&["target_object_slot", "target_handle_id", "target_unique_id"]),
        camera: shape(&["is_default", "x", "y", "angle_rad", "scale"]),
        frame: shape(&[
            "keyframe_index",
            "duration_raw",
            "inbetweens",
            "hidden",
            "background_mix",
            "background_id",
            "background_id_b",
            "objects",
            "object_draw_order",
            "object_draw_order_unique_ids",
            "camera",
            "record_offset",
            "record_end",
        ]),
    };
    let empty = Value::Arr(Arc::new(Vec::new()));
    // Most objects have no colour override: their `[0, 0, 0]` is one shared array.
    let black = Value::Nums(Arc::new(Nums::F32(Box::new([0.0, 0.0, 0.0]))));
    let mut out = Vec::with_capacity(frames.len());
    for (fi, frame) in frames.iter().enumerate() {
        ctx.checkpoint()?;
        let records = &objects[frame.objects.clone()];
        let mut items = Vec::with_capacity(records.len());
        for (oi, record) in records.iter().enumerate() {
            let sc = record.count;
            let pose = &data[record.pose_at..record.pose_at + sc * 8 + 8];
            let lengths = if record.len_flag != 0 { &data[record.lengths_at..record.lengths_at + sc * 4] } else { &[][..] };
            let bends = if record.bend_flag != 0 { &data[record.bends_at..record.bends_at + sc * 8] } else { &[][..] };
            let color = record.color;
            let join = match record.join {
                None => Value::Null,
                Some((slot, handle)) => Value::Obj(Arc::new(Obj::from_shape(
                    shapes.join.clone(),
                    vec![num(slot), num(handle), num(records[slot as usize].uid)],
                ))),
            };
            let mut values = Vec::with_capacity(21);
            values.push(int(oi));
            values.push(num(record.uid));
            values.push(num(record.tid));
            values.push(num(record.scale));
            values.push(num(color));
            values.push(num(record.transparency));
            if let Some(flags) = record.media {
                values.push(num(flags));
            }
            values.push(nums_f64(&pose[..sc * 8], &empty));
            values.push(num(f32_at(pose, sc * 8)));
            values.push(num(f32_at(pose, sc * 8 + 4)));
            values.push(if color & 0xff_ffff == 0 {
                black.clone()
            } else {
                Value::Nums(Arc::new(Nums::F32(Box::new([(color & 255) as f32, ((color >> 8) & 255) as f32, ((color >> 16) & 255) as f32]))))
            });
            values.push(num(color >> 24));
            values.push(num(record.transparency));
            values.push(num(1.0 - record.transparency as f64 / 255.0));
            values.push(num(record.len_flag));
            values.push(nums_f32(lengths, &empty));
            values.push(num(record.bend_flag));
            values.push(nums_f64(bends, &empty));
            values.push(join);
            values.push(int(record.start));
            values.push(int(record.end));
            let layout = if record.media.is_some() { &shapes.object_media } else { &shapes.object };
            items.push(Value::Obj(Arc::new(Obj::from_shape(layout.clone(), values))));
        }
        let order_bytes = &data[frame.order_at..frame.order_at + records.len() * 2];
        let order: Vec<u16> = order_bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        let order_value = if order.is_empty() { empty.clone() } else { Value::Nums(Arc::new(Nums::F32(order.iter().map(|&slot| slot as f32).collect()))) };
        let order_ids: Vec<f64> = order.iter().map(|&slot| records[slot as usize].uid as f64).collect();
        let camera = if frame.default_camera != 0 {
            vec![Value::Bool(true), num(0.0), num(0.0), num(0.0), num(1.0)]
        } else {
            let at = frame.camera_at;
            vec![Value::Bool(false), num(f32_at(data, at)), num(f32_at(data, at + 4)), num(f64_at(data, at + 8)), num(f32_at(data, at + 16))]
        };
        let values = vec![
            int(fi),
            num(frame.duration),
            num(frame.duration as f64 - 1.0),
            Value::Bool(frame.duration == 0),
            num(frame.mix),
            num(frame.background),
            frame.background_b.map(num).unwrap_or(Value::Null),
            if items.is_empty() { empty.clone() } else { Value::Arr(Arc::new(items)) },
            order_value,
            Value::nums(&order_ids),
            Value::Obj(Arc::new(Obj::from_shape(shapes.camera.clone(), camera))),
            int(frame.start),
            int(frame.end),
        ];
        out.push(Value::Obj(Arc::new(Obj::from_shape(shapes.frame.clone(), values))));
    }
    Ok(out)
}

/// The `piv_identity_recovery.objects` entries.
pub(crate) fn repairs_value(repairs: &[Repair]) -> Value {
    let items = repairs
        .iter()
        .map(|repair| {
            let mut object = ObjB::new();
            object.set("keyframe_index", int(repair.keyframe_index));
            object.set("object_slot", int(repair.object_slot));
            object.num("source_unique_id", repair.source_unique_id);
            object.num("unique_id", repair.unique_id);
            object.set("record_offset", int(repair.record_offset));
            object.build()
        })
        .collect();
    Value::Arr(Arc::new(items))
}

#[cfg(test)]
#[path = "frames_tests.rs"]
mod tests;
