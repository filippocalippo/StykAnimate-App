//! Writing containers.
//!
//! [`lift`] makes the same choices, in the same order, as the JavaScript writer
//! this replaced, so that a document read from a file and not changed is written
//! back to the same skeleton text and the same section bytes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use styk_doc::json;
use styk_doc::{Nums, Value, format_number};

use crate::files::{Host, Job};

use super::{ContainerError, HEADER, Kind, LIFT_MIN_ARRAY, LIFT_MIN_STRING, MAX_BYTES, MAX_JSON_NUMBER_BYTES, MAX_SKELETON_BYTES, SECTION, pack_zlib, pack_zstd, sha256, sha256_until};

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
    /// Arrays already stored, by identity: an array shared by several records is stored once. The identity is the address of the array
    /// the document holds (a packed `Nums`, or an ordinary array of numbers), which lives as long as the document does: never the address of
    /// something made here for a moment, that the next one made would take over.
    seen_arrays: HashMap<usize, (String, usize)>,
    /// Payloads already stored, by content.
    seen_payloads: HashMap<Arc<[u8]>, (usize, usize)>,
    /// Payloads the caller reserved at the start of the payload section, by identity.
    reserved: HashMap<usize, (usize, usize)>,
    /// Set when lifting for the interface ([`ViewLifter`]): the pose key sequences several channels share.
    sequences: Option<Sequences>,
    max_bytes: usize,
    /// JSON bytes whose size is known exactly (strings, punctuation, payload text).
    known_json: usize,
    /// Upper bound of the expanded JSON, counting 32 bytes per finite number.
    upper_json: usize,
    /// What a reader allocates beyond the sections: 48 bytes per number, payload text.
    allocation: usize,
    /// Asked every [`CANCEL_EVERY`] values: a lift that is stopped writes nothing.
    cancel: &'a dyn Fn() -> bool,
    visited: u32,
    /// Set while lifting a piece on its own (`lift_piece`): the choices that depend on what came before it in the document (where an array or a
    /// payload is stored, whether it was stored already) are left as holes in `out`, for [`Lifter::splice`] to settle in order.
    holes: Option<Vec<(usize, Hole)>>,
}

/// A choice a piece leaves to be made in document order.
enum Hole {
    /// A numeric array that is stored in the arrays section (or named by the marker of the copy stored before).
    Array(Arc<Nums>),
    /// The same for an ordinary array that holds only numbers.
    Plain(Arc<Vec<Value>>),
    /// A payload (an image or an original source) and the text before its base64 (empty for a bare string).
    Payload { prefix: String, bytes: Arc<[u8]> },
}

/// A run of the elements of an array lifted on its own: the text, the holes in it by position, and what it counted.
struct Piece {
    out: Vec<u8>,
    holes: Vec<(usize, Hole)>,
    known_json: usize,
    upper_json: usize,
    allocation: usize,
}

/// Values lifted between two questions to the cancel: microseconds of work.
const CANCEL_EVERY: u32 = 4096;

/// The cancel of a lift nobody stops.
fn never() -> bool {
    false
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

    /// A lifter with nothing lifted yet.
    fn blank<'b>(max_bytes: usize, cancel: &'b dyn Fn() -> bool) -> Lifter<'b> {
        Lifter {
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
            cancel,
            visited: 0,
            holes: None,
        }
    }

    /// Appends a piece lifted on its own: its text, with each hole settled now, in the order the document has them, and its counts
    /// added to this lifter's. The result is what lifting the piece's values here, one after the other, would have written.
    fn splice(&mut self, piece: Piece) -> Result<(), ContainerError> {
        let mut at = 0;
        for (position, hole) in piece.holes {
            self.out.extend_from_slice(&piece.out[at..position]);
            at = position;
            match hole {
                Hole::Array(numbers) => self.numbers(&numbers)?,
                Hole::Plain(items) => self.plain_numbers(&items)?,
                Hole::Payload { prefix, bytes } => self.payload(&prefix, &bytes)?,
            }
        }
        self.out.extend_from_slice(&piece.out[at..]);
        if piece.known_json > (self.max_bytes * 4).saturating_sub(self.known_json) {
            return Err(too_large("its JSON exceeds the materialization limit"));
        }
        self.known_json += piece.known_json;
        self.upper_json = self.upper_json.saturating_add(piece.upper_json);
        self.allocation = self.allocation.saturating_add(piece.allocation);
        self.check_allocation()
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
        if let Some(holes) = &mut self.holes {
            holes.push((self.out.len(), Hole::Payload { prefix: prefix.to_string(), bytes: bytes.clone() }));
            return Ok(());
        }
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
        self.numbers_at(Arc::as_ptr(numbers) as usize, numbers, || Hole::Array(numbers.clone()))
    }

    /// An ordinary array that holds only numbers (a packed one that was unpacked to be edited) follows the numeric rules: it is stored as
    /// the numbers of a packed array are, and it is told apart from the others by its own address, as the arrays of the JavaScript writer
    /// were by theirs. The packed copy made here to write its numbers is gone before the next array is written, so its address says nothing.
    fn plain_numbers(&mut self, items: &Arc<Vec<Value>>) -> Result<(), ContainerError> {
        let packed = Nums::new(&items.iter().map(|v| v.as_f64().unwrap()).collect::<Vec<_>>());
        self.numbers_at(Arc::as_ptr(items) as usize, &packed, || Hole::Plain(items.clone()))
    }

    /// Stores `numbers`, the array that the document holds at `identity`; `hole` is what a piece leaves for the splice to settle in order.
    fn numbers_at(&mut self, identity: usize, numbers: &Nums, hole: impl FnOnce() -> Hole) -> Result<(), ContainerError> {
        if let Some((marker, upper)) = self.seen_arrays.get(&identity) {
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
        if let Some(holes) = &mut self.holes {
            holes.push((self.out.len(), hole()));
            return Ok(());
        }
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
        self.seen_arrays.insert(identity, (marker, upper));
        Ok(())
    }

    fn value(&mut self, value: &Value, key: &str) -> Result<(), ContainerError> {
        self.visited = self.visited.wrapping_add(1);
        if self.visited % CANCEL_EVERY == 0 && (self.cancel)() {
            return Err(ContainerError::Cancelled);
        }
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
                    && let Some(&range) = self.reserved.get(&(data as usize))
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
                    return self.plain_numbers(items);
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
    lift_until(document, reserved, &never)
}

/// [`lift`] on a worker that may be stopped: `cancel` is asked every few thousand values, and a lift it stops is
/// [`ContainerError::Cancelled`].
pub fn lift_until(document: &Value, reserved: &[Arc<[u8]>], cancel: &dyn Fn() -> bool) -> Result<Lifted, ContainerError> {
    lift_checked(document, reserved, MAX_BYTES, cancel)
}

/// [`lift`] with another section limit (the materialization limit is four times it).
/// Hosts with less memory than a desktop lower it; tests use it to reach the limits.
pub fn lift_within(document: &Value, reserved: &[Arc<[u8]>], max_bytes: usize) -> Result<Lifted, ContainerError> {
    lift_checked(document, reserved, max_bytes, &never)
}

fn lift_checked(document: &Value, reserved: &[Arc<[u8]>], max_bytes: usize, cancel: &dyn Fn() -> bool) -> Result<Lifted, ContainerError> {
    let mut lifter = Lifter::blank(max_bytes, cancel);
    let mut reserved_offsets = Vec::with_capacity(reserved.len());
    for bytes in reserved {
        if bytes.len() > max_bytes.saturating_sub(lifter.payloads.len()) {
            return Err(too_large("its reserved payloads exceed the section limit"));
        }
        let offset = lifter.payloads.len();
        lifter.reserved.entry(bytes.as_ptr() as usize).or_insert((offset, bytes.len()));
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

/// The elements of an array lifted on a thread of their own, as a piece to splice: their texts separated by commas.
fn lift_piece(items: &[Value], reserved: &HashMap<usize, (usize, usize)>, max_bytes: usize, cancel: &dyn Fn() -> bool) -> Result<Piece, ContainerError> {
    let mut lifter = Lifter::blank(max_bytes, cancel);
    lifter.reserved = reserved.clone();
    lifter.holes = Some(Vec::new());
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            lifter.out.push(b',');
        }
        lifter.value(item, "")?;
    }
    Ok(Piece { out: lifter.out, holes: lifter.holes.unwrap_or_default(), known_json: lifter.known_json, upper_json: lifter.upper_json, allocation: lifter.allocation })
}

/// Arrays shorter than this are lifted whole on the thread that lifts the document.
const PARALLEL_MIN_ITEMS: usize = 64;
/// How many pieces a thread of the host is given to lift, at least: more keeps them even, fewer keeps the stitching small.
const PIECES_PER_THREAD: usize = 6;

/// [`lift_until`] on a host with threads to spare: the elements of the document's largest top-level array, which is nearly all of a
/// project, are lifted in pieces side by side (a few batches of `host.together` jobs, each batch stitched in order before the next
/// begins, so that only a batch is held twice), and the choices that depend on what came before (where an array or a payload is stored,
/// whether it was stored already) are made in document order when each piece is spliced in. The result is the one [`lift_until`] writes,
/// byte for byte. A host with one thread, or a document with no such array, lifts as [`lift_until`] does. The jobs own what they touch (a
/// clone of a `Value` is a reference count): see [`Job`]. The times are by the host's clock.
pub fn lift_together(document: &Value, reserved: &[Arc<[u8]>], host: &dyn Host) -> Result<(Lifted, LiftTimes), ContainerError> {
    lift_together_within(document, reserved, MAX_BYTES, host)
}

/// Where the lift of a document in pieces spent its time (milliseconds by the host's clock; zero without one).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LiftTimes {
    /// The pieces of the batches serialised side by side, waited for by the thread that lifts.
    pub pieces_ms: f64,
    /// That thread stitching the pieces together in document order: the copying of the text and the choices left as holes.
    pub splice_ms: f64,
}

/// [`lift_together`] with another section limit.
pub fn lift_together_within(document: &Value, reserved: &[Arc<[u8]>], max_bytes: usize, host: &dyn Host) -> Result<(Lifted, LiftTimes), ContainerError> {
    let clock = host.clock();
    let mut times = LiftTimes::default();
    let threads = host.threads().max(1);
    let big = document.as_obj().and_then(|object| {
        let (index, items) = object.iter().enumerate().filter_map(|(index, (_, value))| value.as_arr().map(|items| (index, items))).max_by_key(|(_, items)| items.len())?;
        let numbers = items.iter().all(|item| matches!(item, Value::Num(_)));
        (threads > 1 && items.len() >= PARALLEL_MIN_ITEMS && !numbers).then_some((index, items))
    });
    let stop = Arc::new(AtomicBool::new(false));
    let Some((big_index, items)) = big else {
        // One thread's lift,.
        let lifted: Arc<Mutex<Option<Result<Lifted, ContainerError>>>> = Arc::new(Mutex::new(None));
        let mut jobs: Vec<Job> = Vec::with_capacity(1);
        {
            let (document, reserved, lifted) = (document.clone(), reserved.to_vec(), lifted.clone());
            jobs.push(Box::new(move |stop_now| {
                *lifted.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(lift_checked(&document, &reserved, max_bytes, stop_now));
            }));
        }
        host.together(jobs, &stop).map_err(|_| ContainerError::WorkerStopped)?;
        if stop.load(Ordering::Relaxed) {
            return Err(ContainerError::Cancelled);
        }
        return lifted.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().unwrap_or(Err(ContainerError::Cancelled)).map(|lifted| (lifted, times));
    };
    let ask = || host.cancelled();
    let mut lifter = Lifter::blank(max_bytes, &ask);
    let mut reserved_offsets = Vec::with_capacity(reserved.len());
    for bytes in reserved {
        if bytes.len() > max_bytes.saturating_sub(lifter.payloads.len()) {
            return Err(too_large("its reserved payloads exceed the section limit"));
        }
        let offset = lifter.payloads.len();
        lifter.reserved.entry(bytes.as_ptr() as usize).or_insert((offset, bytes.len()));
        lifter.payloads.extend_from_slice(bytes);
        reserved_offsets.push(offset);
    }
    let object = document.as_obj().ok_or(ContainerError::Cancelled)?;
    lifter.admit(2 + object.len().saturating_sub(1))?;
    lifter.out.push(b'{');
    for (index, (name, item)) in object.iter().enumerate() {
        if index > 0 {
            lifter.out.push(b',');
        }
        lifter.admit(json::string_bytes(name) + 1)?;
        json::write_string(name, &mut lifter.out);
        lifter.out.push(b':');
        if index != big_index {
            lifter.value(item, name)?;
            continue;
        }
        lifter.admit(2 + items.len().saturating_sub(1))?;
        lifter.out.push(b'[');
        let size = items.len().div_ceil(threads * PIECES_PER_THREAD).max(1);
        let pieces: Vec<&[Value]> = items.chunks(size).collect();
        let reserved_map = Arc::new(lifter.reserved.clone());
        for (batch_number, batch) in pieces.chunks(threads * 2).enumerate() {
            let slots: Vec<Arc<Mutex<Option<Result<Piece, ContainerError>>>>> = batch.iter().map(|_| Arc::new(Mutex::new(None))).collect();
            let jobs: Vec<Job> = batch
                .iter()
                .zip(&slots)
                .map(|(piece_items, slot)| {
                    // The elements are cloned (a reference count each) so that the job owns them: see [`Job`].
                    let (piece_items, slot, reserved_map) = (piece_items.to_vec(), slot.clone(), reserved_map.clone());
                    Box::new(move |stop_now: &dyn Fn() -> bool| {
                        let piece = lift_piece(&piece_items, &reserved_map, max_bytes, stop_now);
                        *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(piece);
                    }) as Job
                })
                .collect();
            let waiting = clock();
            host.together(jobs, &stop).map_err(|_| ContainerError::WorkerStopped)?;
            times.pieces_ms += clock() - waiting;
            if stop.load(Ordering::Relaxed) {
                return Err(ContainerError::Cancelled);
            }
            let splicing = clock();
            for (position, slot) in slots.iter().enumerate() {
                let piece = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().ok_or(ContainerError::Cancelled)??;
                if batch_number > 0 || position > 0 {
                    lifter.out.push(b',');
                }
                lifter.splice(piece)?;
            }
            if batch_number == 0 {
                // The text of the rest is about as long as the text of the first batch said: one allocation of the output, not a doubling.
                let done = (batch.len() * size).min(items.len());
                let estimate = (lifter.out.len() as f64 / done as f64 * (items.len() - done) as f64 * 1.05) as usize;
                lifter.out.reserve_exact(estimate);
            }
            times.splice_ms += clock() - splicing;
        }
        lifter.out.push(b']');
    }
    lifter.out.push(b'}');
    if lifter.upper_json > max_bytes * 4 {
        // The bound counted 32 bytes per number; measure what a reader will really expand.
        let mut expanded = Vec::new();
        json::write(document, &mut expanded);
        if expanded.len() > max_bytes * 4 {
            return Err(too_large("its JSON exceeds the materialization limit"));
        }
    }
    Ok((Lifted { skeleton: lifter.out, arrays: lifter.arrays, payloads: lifter.payloads, reserved_offsets }, times))
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
            cancel: &never,
            visited: 0,
            holes: None,
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

/// One block of a container, ready to store: the SHA-256 of its bytes and the zstd frame they compress to.
pub struct Frame {
    pub digest: [u8; 32],
    pub stored: Vec<u8>,
}

/// Hashes and compresses one block: the digest, then the frame, one `zstd::bulk::compress` call at level 3 (a frame written any
/// other way is another, valid frame, and an unchanged document must save to the bytes it was opened from). `cancel` is asked
/// every few megabytes of hashing and before and after the compression.
pub fn frame(raw: &[u8], cancel: &dyn Fn() -> bool) -> Result<Frame, ContainerError> {
    let digest = sha256_until(raw, cancel).ok_or(ContainerError::Cancelled)?;
    if cancel() {
        return Err(ContainerError::Cancelled);
    }
    let stored = pack_zstd(raw);
    if cancel() {
        return Err(ContainerError::Cancelled);
    }
    Ok(Frame { digest, stored })
}

/// Assembles a version 2 container, compressing with zstd at level 3.
pub fn encode_v2(lifted: &Lifted, kind: Kind) -> Result<Vec<u8>, ContainerError> {
    encode_v2_with([lifted.skeleton.len(), lifted.arrays.len(), lifted.payloads.len()], kind, &mut || {
        let never = || false;
        Ok([frame(&lifted.skeleton, &never)?, frame(&lifted.arrays, &never)?, frame(&lifted.payloads, &never)?])
    })
}

/// Assembles a version 2 container from the lengths of its skeleton text and its two sections (numeric arrays, payloads), whose
/// blocks `frames` turns, in that order, into the frames to store: freshly hashed and compressed ([`frame`]), one after the other or side
/// by side; the caller owns the blocks and decides, and a stop it reports is [`ContainerError::Cancelled`].
pub fn encode_v2_with(lengths: [usize; 3], kind: Kind, frames: &mut dyn FnMut() -> Result<[Frame; 3], ContainerError>) -> Result<Vec<u8>, ContainerError> {
    let [skeleton_len, arrays_len, payloads_len] = lengths;
    let sections = [(1u8, arrays_len), (2u8, payloads_len)];
    let raw_sections: usize = sections.iter().map(|(_, length)| length).sum();
    if skeleton_len > MAX_SKELETON_BYTES || sections.iter().any(|(_, length)| *length > MAX_BYTES) || skeleton_len + raw_sections * 3 > MAX_BYTES * 4 {
        return Err(too_large("the skeleton or a section exceeds its limit"));
    }
    let [skeleton_frame, arrays_frame, payloads_frame] = frames()?;
    let (skeleton_digest, skeleton_stored) = (skeleton_frame.digest, skeleton_frame.stored);
    let packed = [(1u8, arrays_len, arrays_frame.digest, arrays_frame.stored), (2u8, payloads_len, payloads_frame.digest, payloads_frame.stored)];
    let total = HEADER + 4 + skeleton_stored.len() + packed.len() * SECTION + packed.iter().map(|(_, _, _, stored)| stored.len()).sum::<usize>();
    if total > MAX_BYTES {
        return Err(ContainerError::FileTooLarge { size: total });
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(kind.magic());
    out.extend_from_slice(&[2, 2, 0, 0]);
    out.extend_from_slice(&(skeleton_len as u64).to_le_bytes());
    out.extend_from_slice(&(skeleton_stored.len() as u64).to_le_bytes());
    out.extend_from_slice(&skeleton_digest);
    out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
    out.extend_from_slice(&skeleton_stored);
    for (section_kind, raw_length, digest, stored) in &packed {
        let mut record = [0u8; SECTION];
        record[0] = *section_kind;
        record[1] = 2;
        record[8..16].copy_from_slice(&(*raw_length as u64).to_le_bytes());
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
