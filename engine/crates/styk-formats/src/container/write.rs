//! Writing containers.
//!
//! [`lift`] makes the same choices, in the same order, as the JavaScript writer
//! this replaced, so that a document read from a file and not changed is written
//! back to the same skeleton text and the same section bytes.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::json;
use styk_doc::{Nums, Value, format_number};

use super::{ContainerError, HEADER, Kind, LIFT_MIN_ARRAY, LIFT_MIN_STRING, MAX_BYTES, MAX_JSON_NUMBER_BYTES, MAX_SKELETON_BYTES, SECTION, pack_zlib, pack_zstd, sha256};

/// A document split into its JSON skeleton and binary sections.
pub struct Lifted {
    /// The skeleton's JSON text, with markers where values moved out.
    pub skeleton: Vec<u8>,
    /// Section 0: packed numeric arrays.
    pub arrays: Vec<u8>,
    /// Section 1: payload bytes.
    pub payloads: Vec<u8>,
    /// Where each reserved payload starts in the payload section.
    pub reserved_offsets: Vec<usize>,
}

/// The smallest exact storage of an all-number array, as the format defines it:
/// integers as `u8`, `u16`, `u32` or `i32` (`f64` outside those ranges), other
/// values as `f32` when every one is exactly single precision, else `f64`.
/// `None` when a value is not finite or is an integer JSON cannot hold exactly.
fn array_type(values: &Nums) -> Option<&'static str> {
    let (mut integers, mut single) = (true, true);
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    for v in values.iter() {
        if !v.is_finite() {
            return None;
        }
        if v.fract() == 0.0 {
            if v.abs() >= 9007199254740992.0 {
                return None;
            }
            min = min.min(v);
            max = max.max(v);
        } else {
            integers = false;
        }
        if single && (v as f32) as f64 != v {
            single = false;
        }
    }
    if integers {
        if min >= 0.0 {
            if max <= 255.0 {
                return Some("u8");
            }
            if max <= 65535.0 {
                return Some("u16");
            }
            if max <= 4294967295.0 {
                return Some("u32");
            }
        } else if min >= -2147483648.0 && max <= 2147483647.0 {
            return Some("i32");
        }
        return Some("f64");
    }
    Some(if single { "f32" } else { "f64" })
}

fn type_width(name: &str) -> usize {
    match name {
        "u8" => 1,
        "u16" => 2,
        "u32" | "i32" | "f32" => 4,
        _ => 8,
    }
}

fn too_large(what: &'static str) -> ContainerError {
    ContainerError::DocumentTooLarge(what)
}

struct Lifter<'a> {
    out: Vec<u8>,
    arrays: Vec<u8>,
    payloads: Vec<u8>,
    /// Bytes of each section already handed out ([`ViewLifter`]); markers name absolute offsets.
    arrays_base: usize,
    payloads_base: usize,
    /// Arrays already stored, by identity: an array shared by several records is stored once.
    seen_arrays: HashMap<*const Nums, (String, usize)>,
    /// Payloads already stored, by content.
    seen_payloads: HashMap<Arc<[u8]>, (usize, usize)>,
    /// Payloads the caller reserved at the start of the payload section, by identity.
    reserved: HashMap<*const u8, (usize, usize)>,
    /// Set when lifting for the interface ([`ViewLifter`]): the pose key sequences several channels share.
    sequences: Option<Sequences>,
    max_bytes: usize,
    /// JSON bytes whose size is known exactly (strings, punctuation, payload text).
    known_json: usize,
    /// Upper bound of the expanded JSON, counting 32 bytes per finite number.
    upper_json: usize,
    /// What a reader allocates beyond the sections: 48 bytes per number, payload text.
    allocation: usize,
    _documents: std::marker::PhantomData<&'a Value>,
}

/// The key sequences of pose channels that the document shares between channels (`internPoseSequences`), by the
/// address of the array. The interface keeps one array for every channel that names the same sequence.
#[derive(Default)]
struct Sequences {
    ids: HashMap<*const Vec<Value>, u32>,
    /// Sequences first met in the piece being lifted: their number and their JSON.
    defined: Vec<(u32, Vec<u8>)>,
}

impl Lifter<'_> {
    /// A pose channel's `keys`: the first channel to hold a sequence has it written out aside, every channel names it
    /// with a marker (`S2R:<number>`) that the interface resolves to the same array.
    fn sequence(&mut self, value: &Value) -> Result<(), ContainerError> {
        let Value::Arr(items) = value else { unreachable!("only arrays are sequences") };
        let pointer = Arc::as_ptr(items);
        let sequences = self.sequences.as_mut().expect("a view lifter");
        let (id, fresh) = match sequences.ids.get(&pointer) {
            Some(id) => (*id, false),
            None => {
                let id = sequences.ids.len() as u32;
                sequences.ids.insert(pointer, id);
                (id, true)
            }
        };
        if fresh {
            let outer = std::mem::take(&mut self.out);
            let lifted = self.value(value, "");
            let inner = std::mem::replace(&mut self.out, outer);
            lifted?;
            self.sequences.as_mut().expect("a view lifter").defined.push((id, inner));
        }
        let marker = format!("S2R:{id}");
        self.admit(json::string_bytes(&marker))?;
        json::write_string(&marker, &mut self.out);
        Ok(())
    }

    fn admit(&mut self, length: usize) -> Result<(), ContainerError> {
        if length > (self.max_bytes * 4).saturating_sub(self.known_json) {
            return Err(too_large("its JSON exceeds the materialization limit"));
        }
        self.known_json += length;
        self.upper_json = self.upper_json.saturating_add(length);
        Ok(())
    }

    fn admit_estimate(&mut self, length: usize) {
        self.upper_json = self.upper_json.saturating_add(length);
    }

    fn check_allocation(&self) -> Result<(), ContainerError> {
        if self.allocation.saturating_add(self.arrays.len()).saturating_add(self.payloads.len()) > self.max_bytes * 4 {
            return Err(too_large("its arrays and payloads exceed the materialization limit"));
        }
        Ok(())
    }

    fn admit_payload(&mut self, prefix: &str, encoded: usize) -> Result<(), ContainerError> {
        self.admit(json::string_bytes(prefix) + encoded)?;
        self.allocation = self.allocation.saturating_add(encoded);
        self.check_allocation()
    }

    fn payload_marker(&mut self, prefix: &str, range: (usize, usize)) {
        let marker = if prefix.is_empty() { format!("S2S:1:{}:{}", range.0, range.1) } else { format!("S2D:1:{}:{}:{prefix}", range.0, range.1) };
        json::write_string(&marker, &mut self.out);
    }

    /// Moves `bytes` (whose canonical base64 the document holds after `prefix`) into the payload section.
    fn payload(&mut self, prefix: &str, bytes: &Arc<[u8]>) -> Result<(), ContainerError> {
        let encoded = bytes.len().div_ceil(3) * 4;
        if let Some(&range) = self.seen_payloads.get(bytes) {
            self.admit_payload(prefix, encoded)?;
            self.payload_marker(prefix, range);
            return Ok(());
        }
        if bytes.len() > self.max_bytes.saturating_sub(self.payloads.len()) {
            return Err(too_large("its payloads exceed the section limit"));
        }
        self.admit_payload(prefix, encoded)?;
        let range = (self.payloads_base + self.payloads.len(), bytes.len());
        self.payloads.extend_from_slice(bytes);
        self.seen_payloads.insert(bytes.clone(), range);
        self.check_allocation()?;
        self.payload_marker(prefix, range);
        Ok(())
    }

    /// A string value under `key`. Large base64 text in the fields that carry it moves out.
    fn string(&mut self, text: &str, key: &str) -> Result<(), ContainerError> {
        // The threshold is JavaScript's string length (UTF-16 units), never more than the byte length.
        if text.len() >= LIFT_MIN_STRING && text.encode_utf16().count() >= LIFT_MIN_STRING {
            let split = if key == "data_base64" || key == "source_base64" {
                Some(("", text))
            } else if (key == "data_url" || key == "styk_tiles") && text.starts_with("data:") {
                text.find(',').filter(|&comma| comma > 5 && text[..comma].ends_with(";base64")).map(|comma| text.split_at(comma + 1))
            } else {
                None
            };
            if let Some((prefix, base64)) = split
                && let Some(bytes) = json::base64_strict(base64)
            {
                return self.payload(prefix, &Arc::from(bytes));
            }
        }
        self.admit(json::string_bytes(text))?;
        if text.starts_with("S2") && text.len() >= 4 && (matches!(text.as_bytes()[2], b'B' | b'S' | b'E' | b'D') || (self.sequences.is_some() && matches!(text.as_bytes()[2], b'R' | b'P'))) && text.as_bytes()[3] == b':' {
            let mut escaped = String::with_capacity(text.len() + 4);
            escaped.push_str("S2E:");
            escaped.push_str(text);
            json::write_string(&escaped, &mut self.out);
        } else {
            json::write_string(text, &mut self.out);
        }
        Ok(())
    }

    fn numbers(&mut self, numbers: &Arc<Nums>) -> Result<(), ContainerError> {
        if let Some((marker, upper)) = self.seen_arrays.get(&Arc::as_ptr(numbers)) {
            let (marker, upper) = (marker.clone(), *upper);
            self.admit_estimate(upper);
            json::write_string(&marker, &mut self.out);
            return Ok(());
        }
        let count = numbers.len();
        let Some(name) = (if count >= LIFT_MIN_ARRAY { array_type(numbers) } else { None }) else {
            self.admit(2 + count.saturating_sub(1))?;
            self.out.push(b'[');
            for (i, n) in numbers.iter().enumerate() {
                if i > 0 {
                    self.out.push(b',');
                }
                if n.is_finite() {
                    self.admit_estimate(MAX_JSON_NUMBER_BYTES);
                } else {
                    self.admit(4)?;
                }
                format_number(n, &mut self.out);
            }
            self.out.push(b']');
            return Ok(());
        };
        let upper = 2 + (count - 1) + count * MAX_JSON_NUMBER_BYTES;
        self.admit_estimate(upper);
        let width = type_width(name);
        let offset = (self.arrays_base + self.arrays.len()).next_multiple_of(width);
        if count > self.max_bytes.saturating_sub(offset) / width {
            return Err(too_large("its numeric arrays exceed the section limit"));
        }
        self.arrays.resize(offset - self.arrays_base, 0);
        match name {
            "u8" => self.arrays.extend(numbers.iter().map(|v| v as u8)),
            "u16" => numbers.iter().for_each(|v| self.arrays.extend_from_slice(&(v as u16).to_le_bytes())),
            "u32" => numbers.iter().for_each(|v| self.arrays.extend_from_slice(&(v as u32).to_le_bytes())),
            "i32" => numbers.iter().for_each(|v| self.arrays.extend_from_slice(&(v as i32).to_le_bytes())),
            "f32" => numbers.iter().for_each(|v| self.arrays.extend_from_slice(&(v as f32).to_le_bytes())),
            _ => numbers.iter().for_each(|v| self.arrays.extend_from_slice(&v.to_le_bytes())),
        }
        self.allocation = self.allocation.saturating_add(count * 48);
        self.check_allocation()?;
        let marker = format!("S2B:{name}:0:{offset}:{count}");
        json::write_string(&marker, &mut self.out);
        self.seen_arrays.insert(Arc::as_ptr(numbers), (marker, upper));
        Ok(())
    }

    fn value(&mut self, value: &Value, key: &str) -> Result<(), ContainerError> {
        match value {
            Value::Null => {
                self.admit(4)?;
                self.out.extend_from_slice(b"null");
            }
            Value::Bool(flag) => {
                self.admit(if *flag { 4 } else { 5 })?;
                self.out.extend_from_slice(if *flag { b"true" } else { b"false" });
            }
            Value::Num(n) => {
                if n.is_finite() {
                    self.admit_estimate(MAX_JSON_NUMBER_BYTES);
                } else {
                    self.admit(4)?;
                }
                format_number(*n, &mut self.out);
            }
            Value::Str(text) => self.string(text, key)?,
            Value::Blob(blob) => {
                let data = blob.bytes.as_ptr();
                if (key == "data_base64" || key == "source_base64")
                    && blob.prefix.is_empty()
                    && let Some(&range) = self.reserved.get(&data)
                {
                    self.admit_payload("", range.1.div_ceil(3) * 4)?;
                    self.payload_marker("", range);
                    return Ok(());
                }
                let liftable = styk_doc::payload::lifts(blob, key);
                if liftable && self.sequences.is_some() {
                    // The interface's view names the payload and asks for it when something reads it.
                    let marker = format!("{}{}", styk_doc::payload::MARKER, styk_doc::payload::register(blob));
                    self.admit(json::string_bytes(&marker))?;
                    json::write_string(&marker, &mut self.out);
                    return Ok(());
                }
                let prefix: &str = &blob.prefix;
                if liftable {
                    self.payload(prefix, &blob.bytes)?;
                } else {
                    // Not a field or size the format moves out: it is an ordinary string here.
                    let text = value.text().expect("a blob has text");
                    self.string(&text, key)?;
                }
            }
            Value::Nums(numbers) => self.numbers(numbers)?,
            Value::Arr(items) => {
                // An unpacked array that happens to hold only numbers follows the numeric rules.
                if items.len() >= LIFT_MIN_ARRAY && items.iter().all(|v| matches!(v, Value::Num(_))) {
                    let packed = Arc::new(Nums::new(&items.iter().map(|v| v.as_f64().unwrap()).collect::<Vec<_>>()));
                    return self.numbers(&packed);
                }
                self.admit(2 + items.len().saturating_sub(1))?;
                self.out.push(b'[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        self.out.push(b',');
                    }
                    self.value(item, "")?;
                }
                self.out.push(b']');
            }
            Value::Obj(object) => {
                self.admit(2 + object.len().saturating_sub(1))?;
                self.out.push(b'{');
                for (i, (name, item)) in object.iter().enumerate() {
                    if i > 0 {
                        self.out.push(b',');
                    }
                    self.admit(json::string_bytes(name) + 1)?;
                    json::write_string(name, &mut self.out);
                    self.out.push(b':');
                    if self.sequences.is_some() && &**name == "keys" && matches!(item, Value::Arr(_)) && object.get("property").and_then(Value::as_str) == Some("pose") {
                        self.sequence(item)?;
                    } else {
                        self.value(item, name)?;
                    }
                }
                self.out.push(b'}');
            }
        }
        Ok(())
    }
}

/// Splits `document` into a skeleton and sections.
///
/// `reserved` payloads take the first ranges of the payload section, in order; a
/// blob in a `source_base64` or `data_base64` field that is one of them (the same
/// bytes allocation) is written as a marker to its reserved range. The save path
/// uses this for the original Pivot source, which the app has always stored first.
pub fn lift(document: &Value, reserved: &[Arc<[u8]>]) -> Result<Lifted, ContainerError> {
    lift_within(document, reserved, MAX_BYTES)
}

/// [`lift`] with another section limit (the materialization limit is four times it).
/// Hosts with less memory than a desktop lower it; tests use it to reach the limits.
pub fn lift_within(document: &Value, reserved: &[Arc<[u8]>], max_bytes: usize) -> Result<Lifted, ContainerError> {
    let mut lifter = Lifter {
        out: Vec::new(),
        arrays: Vec::new(),
        payloads: Vec::new(),
        arrays_base: 0,
        payloads_base: 0,
        seen_arrays: HashMap::new(),
        seen_payloads: HashMap::new(),
        reserved: HashMap::new(),
        sequences: None,
        max_bytes,
        known_json: 0,
        upper_json: 0,
        allocation: 0,
        _documents: std::marker::PhantomData,
    };
    let mut reserved_offsets = Vec::with_capacity(reserved.len());
    for bytes in reserved {
        if bytes.len() > max_bytes.saturating_sub(lifter.payloads.len()) {
            return Err(too_large("its reserved payloads exceed the section limit"));
        }
        let offset = lifter.payloads.len();
        lifter.reserved.entry(bytes.as_ptr()).or_insert((offset, bytes.len()));
        lifter.payloads.extend_from_slice(bytes);
        reserved_offsets.push(offset);
    }
    lifter.value(document, "")?;
    if lifter.upper_json > max_bytes * 4 {
        // The bound counted 32 bytes per number; measure what a reader will really expand.
        let mut expanded = Vec::new();
        json::write(document, &mut expanded);
        if expanded.len() > max_bytes * 4 {
            return Err(too_large("its JSON exceeds the materialization limit"));
        }
    }
    Ok(Lifted { skeleton: lifter.out, arrays: lifter.arrays, payloads: lifter.payloads, reserved_offsets })
}

/// One piece of a document lifted for the interface: the skeleton of the value, and the bytes the
/// sections gained while lifting it. Markers name absolute offsets in the sections of every piece so far;
/// `arrays_base` and `payloads_base` say where this piece's bytes start in them.
pub struct ViewPart {
    pub skeleton: Vec<u8>,
    /// The pose key sequences first met in this piece, as JSON: `[{"id":0,"v":[…]},…]` (empty for none). The skeleton
    /// names a sequence `S2R:<id>` wherever a channel holds it.
    pub sequences: Vec<u8>,
    pub arrays: Vec<u8>,
    pub arrays_base: usize,
    pub payloads: Vec<u8>,
    pub payloads_base: usize,
}

/// Lifts a document one value at a time, as [`lift`] would lift it whole: an array or an image that
/// several values share is written once, by the first value that holds it, and every later value names it
/// with the same marker. The interface restores each piece as it arrives and keeps what the markers named,
/// so a document too large to hand over at once reaches it in bounded pieces with its sharing intact.
///
/// The values lifted must stay alive as long as the lifter does (arrays are told apart by their address).
pub struct ViewLifter(Lifter<'static>);

impl Default for ViewLifter {
    fn default() -> Self {
        ViewLifter(Lifter {
            out: Vec::new(),
            arrays: Vec::new(),
            payloads: Vec::new(),
            arrays_base: 0,
            payloads_base: 0,
            seen_arrays: HashMap::new(),
            seen_payloads: HashMap::new(),
            reserved: HashMap::new(),
            sequences: Some(Sequences::default()),
            // Nothing here is a file: the interface decides how much of the document it takes.
            max_bytes: usize::MAX / 8,
            known_json: 0,
            upper_json: 0,
            allocation: 0,
            _documents: std::marker::PhantomData,
        })
    }
}

impl ViewLifter {
    pub fn new() -> ViewLifter {
        ViewLifter::default()
    }

    /// The piece for `value`, held under `key` in its parent (the field names decide which strings move out as payloads).
    pub fn part(&mut self, value: &Value, key: &str) -> Result<ViewPart, ContainerError> {
        let lifter = &mut self.0;
        lifter.out.clear();
        lifter.value(value, key)?;
        let defined = std::mem::take(&mut lifter.sequences.as_mut().expect("a view lifter").defined);
        let mut sequences = Vec::new();
        for (id, text) in defined {
            sequences.extend_from_slice(if sequences.is_empty() { b"[" } else { b"," });
            sequences.extend_from_slice(format!("{{\"id\":{id},\"v\":").as_bytes());
            sequences.extend_from_slice(&text);
            sequences.push(b'}');
        }
        if !sequences.is_empty() {
            sequences.push(b']');
        }
        let part = ViewPart {
            skeleton: std::mem::take(&mut lifter.out),
            sequences,
            arrays_base: lifter.arrays_base,
            arrays: std::mem::take(&mut lifter.arrays),
            payloads_base: lifter.payloads_base,
            payloads: std::mem::take(&mut lifter.payloads),
        };
        lifter.arrays_base += part.arrays.len();
        lifter.payloads_base += part.payloads.len();
        Ok(part)
    }
}

/// Assembles a version 2 container, compressing with zstd at level 3.
pub fn encode_v2(lifted: &Lifted, kind: Kind) -> Result<Vec<u8>, ContainerError> {
    encode_v2_with(&lifted.skeleton, &lifted.arrays, &lifted.payloads, kind, &mut |raw, _| pack_zstd(raw))
}

/// Assembles a version 2 container from its skeleton text and its two sections
/// (numeric arrays, payloads). `pack` turns one block, given its bytes and their
/// SHA-256, into the zstd frame to store: a fresh compression, or a frame the
/// caller kept from compressing the same bytes before.
pub fn encode_v2_with(skeleton: &[u8], arrays: &[u8], payloads: &[u8], kind: Kind, pack: &mut dyn FnMut(&[u8], &[u8; 32]) -> Vec<u8>) -> Result<Vec<u8>, ContainerError> {
    let sections: [(u8, &[u8]); 2] = [(1, arrays), (2, payloads)];
    let raw_sections: usize = sections.iter().map(|(_, bytes)| bytes.len()).sum();
    if skeleton.len() > MAX_SKELETON_BYTES || sections.iter().any(|(_, bytes)| bytes.len() > MAX_BYTES) || skeleton.len() + raw_sections * 3 > MAX_BYTES * 4 {
        return Err(too_large("the skeleton or a section exceeds its limit"));
    }
    let skeleton_digest = sha256(skeleton);
    let skeleton_stored = pack(skeleton, &skeleton_digest);
    let packed: Vec<(u8, &[u8], [u8; 32], Vec<u8>)> = sections
        .iter()
        .map(|&(section_kind, raw)| {
            let digest = sha256(raw);
            let stored = pack(raw, &digest);
            (section_kind, raw, digest, stored)
        })
        .collect();
    let total = HEADER + 4 + skeleton_stored.len() + packed.len() * SECTION + packed.iter().map(|(_, _, _, stored)| stored.len()).sum::<usize>();
    if total > MAX_BYTES {
        return Err(ContainerError::FileTooLarge { size: total });
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(kind.magic());
    out.extend_from_slice(&[2, 2, 0, 0]);
    out.extend_from_slice(&(skeleton.len() as u64).to_le_bytes());
    out.extend_from_slice(&(skeleton_stored.len() as u64).to_le_bytes());
    out.extend_from_slice(&skeleton_digest);
    out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
    out.extend_from_slice(&skeleton_stored);
    for (section_kind, raw, digest, stored) in &packed {
        let mut record = [0u8; SECTION];
        record[0] = *section_kind;
        record[1] = 2;
        record[8..16].copy_from_slice(&(raw.len() as u64).to_le_bytes());
        record[16..24].copy_from_slice(&(stored.len() as u64).to_le_bytes());
        record[24..56].copy_from_slice(digest);
        out.extend_from_slice(&record);
    }
    for (_, _, _, stored) in &packed {
        out.extend_from_slice(stored);
    }
    Ok(out)
}

/// Assembles a version 1 container around a JSON payload (kept for compatibility tests).
pub fn encode_v1(payload: &[u8], kind: Kind) -> Vec<u8> {
    let stored = pack_zlib(payload);
    let mut out = Vec::with_capacity(HEADER + stored.len());
    out.extend_from_slice(kind.magic());
    out.extend_from_slice(&[1, 1, 0, 0]);
    out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    out.extend_from_slice(&(stored.len() as u64).to_le_bytes());
    out.extend_from_slice(&sha256(payload));
    out.extend_from_slice(&stored);
    out
}
