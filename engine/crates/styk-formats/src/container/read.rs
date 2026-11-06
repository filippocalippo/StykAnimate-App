//! Reading containers: every check happens before the value it guards is used.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::fanout::Fanout;
use styk_doc::json::{self, Member, StringHook};
use styk_doc::{Blob, JsonError, Nums, Value};

use super::{Codec, ContainerError, HEADER, Kind, MAX_BYTES, MAX_JSON_NUMBER_BYTES, MAX_MATERIALIZED_BYTES, MAX_SKELETON_BYTES, SECTION, sha256, unpack};

/// A decoded file.
pub struct Decoded {
    /// The document, with every marker replaced by the value it stands for.
    pub document: Value,
    /// `0` for a plain JSON project, otherwise the container version.
    pub version: u8,
    /// Length of the JSON the file stores (the skeleton, for version 2).
    pub skeleton_bytes: usize,
}

/// What opening a project container takes beyond its file, from the sizes its header and section table state (nothing is unpacked):
/// the skeleton's text becomes a tree (2.7 times the text, measured) and each section is held as it is and copied once. `None` for a
/// file that is not a skeleton and sections, whose size is all there is to go by.
pub fn open_cost(bytes: &[u8], kind: Kind) -> Option<usize> {
    let Ok(Layout::Sections { raw, records, .. }) = layout(bytes, kind) else { return None };
    let sections = records.iter().fold(0usize, |total, record| total.saturating_add(record.raw));
    Some(raw.saturating_mul(3).saturating_add(sections.saturating_mul(2)))
}

/// The uncompressed, verified pieces of a container.
pub struct Parts {
    pub version: u8,
    /// The JSON text: the whole document, or the version 2 skeleton.
    pub skeleton: Vec<u8>,
    /// Version 2 sections as `(kind, bytes)`: kind 1 numeric arrays, kind 2 payloads.
    pub sections: Vec<(u8, Vec<u8>)>,
}

/// Reads a `.styk`, `.stkz` or `.stykmov` file, or a plain JSON project.
pub fn decode(bytes: &[u8], kind: Kind) -> Result<Decoded, ContainerError> {
    let parts = decode_parts(bytes, kind)?;
    let skeleton_bytes = parts.skeleton.len();
    if parts.version < 2 {
        return Ok(Decoded { document: parse_text::<&[(u8, Vec<u8>)]>(&parts.skeleton, None)?, version: parts.version, skeleton_bytes });
    }
    let mut markers = Markers::new(&parts.sections, parts.skeleton.len());
    let parsed = parse_text(&parts.skeleton, Some(&mut markers));
    // A refused marker surfaces as a parse failure; the container error is the cause.
    if let Some(error) = markers.error.take() {
        return Err(error);
    }
    let document = parsed?;
    // The running bound counts 32 bytes per stored number. Only a document near
    // the limit pays for the exact size.
    if markers.materialized_upper > MAX_MATERIALIZED_BYTES && json_length(&document) > MAX_MATERIALIZED_BYTES {
        return Err(ContainerError::MaterializedTooLarge);
    }
    Ok(Decoded { document, version: 2, skeleton_bytes })
}

/// The smallest skeleton that decode_deferred shares out.
const PIECES_FROM_BYTES: usize = 1 << 20;

/// The check of a skeleton's checksum that [`decode_deferred`] left running beside the rest of the open.
pub struct Deferred {
    check: Option<styk_doc::fanout::Started<[u8; 32]>>,
    expected: [u8; 32],
}

impl Deferred {
    fn done() -> Deferred {
        Deferred { check: None, expected: [0; 32] }
    }

    /// Waits for the check. A skeleton whose checksum is not the file's is the file's error, whatever came of the document built
    /// from it: [`decode`] never builds a document from one. A check that was lost (its worker stopped) has verified nothing: the
    /// open is refused, never accepted.
    pub fn finish(self, fan: &dyn Fanout) -> Result<(), ContainerError> {
        match self.check {
            None => Ok(()),
            Some(check) => match check.wait(fan) {
                Ok(digest) if digest == self.expected => Ok(()),
                Ok(_) => Err(ContainerError::Checksum { what: "skeleton".to_string() }),
                Err(_) => Err(ContainerError::WorkerStopped),
            },
        }
    }
}

/// [`decode`] with its work shared out on `fan`: the skeleton is read in pieces by every thread while another checks its checksum.
/// The document is the one [`decode`] gives, and so is every error once `Deferred::finish` has been asked (it must be, whatever
/// happens to the document, before the open is believed): anything that is not a good file is decoded in order, as [`decode`] does.
pub fn decode_deferred(bytes: &[u8], kind: Kind, fan: &dyn Fanout) -> Result<(Decoded, Deferred), ContainerError> {
    decode_deferred_owned(bytes.to_vec(), kind, fan)
}

/// [`decode_deferred`] for a caller that has no use for the file afterwards. The sections' tasks share the file instead of copying
/// what they unpack, and the file is let go as soon as the skeleton and the sections are unpacked: a project's file (35 MB for one
/// whose skeleton is 147 MB of text) is not held while the skeleton is read into a tree, which is when the memory is fullest.
pub fn decode_deferred_owned(bytes: Vec<u8>, kind: Kind, fan: &dyn Fanout) -> Result<(Decoded, Deferred), ContainerError> {
    let bytes = Arc::new(bytes);
    let inline = || decode(&bytes, kind).map(|decoded| (decoded, Deferred::done()));
    if fan.threads() <= 1 {
        return inline();
    }
    let Ok(Layout::Sections { codec, raw, digest, skeleton, records }) = layout(&bytes, kind) else { return inline() };
    // A small skeleton is read faster than it is shared out.
    if raw < PIECES_FROM_BYTES {
        return inline();
    }
    if fan.cancelled() {
        return Err(ContainerError::Cancelled);
    }
    // The sections are unpacked and checked beside the skeleton's unpacking; they own the bytes they read.
    let started: Vec<_> = records
        .into_iter()
        .enumerate()
        .map(|(index, record)| {
            let file = bytes.clone();
            styk_doc::fanout::start(fan, move || unpack_section(index, &record, &file[record.offset..record.offset + record.stored]))
        })
        .collect();
    let Ok(skeleton) = unpack(codec, &bytes[skeleton.clone()], raw, &|| "skeleton".to_string()) else { return inline() };
    fan.mark("skeleton unpacked");
    let skeleton = Arc::new(skeleton);
    let mut sections = Vec::with_capacity(started.len());
    for section in started {
        match section.wait(fan) {
            Ok(Ok(section)) => sections.push(section),
            _ => return inline(),
        }
    }
    fan.mark("sections unpacked");
    // Everything the file held is unpacked, and no task holds it any more.
    drop(bytes);
    // The sections are done, so their workers are free for the long check of the skeleton, which runs beside the rest of the open.
    let hashed = {
        let skeleton = skeleton.clone();
        styk_doc::fanout::start(fan, move || sha256(&skeleton))
    };
    if fan.cancelled() {
        return Err(ContainerError::Cancelled);
    }
    let sections: Arc<[(u8, Vec<u8>)]> = sections.into();
    let skeleton_bytes = skeleton.len();
    let shared = Arc::new(SharedMarkers(std::sync::Mutex::new(Markers::new(sections.clone(), skeleton_bytes))));
    let hook: Arc<dyn json::SharedHook> = shared.clone();
    let pieces = json::parse_pieces(&skeleton, &hook, fan).filter(|document| shared.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_sound(document));
    drop(hook);
    fan.mark("skeleton read");
    if fan.cancelled() {
        return Err(ContainerError::Cancelled);
    }
    let document = match pieces {
        Some(document) => document,
        // Not in pieces, or not a document the pieces vouch for: the checks and the errors are those of reading in order.
        None => {
            drop(shared);
            if skeleton_digest(hashed, &skeleton, fan) != digest {
                return Err(ContainerError::Checksum { what: "skeleton".to_string() });
            }
            let mut markers = Markers::new(sections, skeleton_bytes);
            let parsed = parse_text(&skeleton, Some(&mut markers));
            if let Some(error) = markers.error.take() {
                return Err(error);
            }
            let document = parsed?;
            if markers.materialized_upper > MAX_MATERIALIZED_BYTES && json_length(&document) > MAX_MATERIALIZED_BYTES {
                return Err(ContainerError::MaterializedTooLarge);
            }
            return Ok((Decoded { document, version: 2, skeleton_bytes }, Deferred::done()));
        }
    };
    Ok((Decoded { document, version: 2, skeleton_bytes }, Deferred { check: Some(hashed), expected: digest }))
}

/// The skeleton's digest from the task that was started for it, or, when that task was lost, worked out here: a digest nobody has
/// verified is not a digest that matched.
fn skeleton_digest(started: styk_doc::fanout::Started<[u8; 32]>, skeleton: &[u8], fan: &dyn Fanout) -> [u8; 32] {
    started.wait(fan).unwrap_or_else(|_| sha256(skeleton))
}

/// [`Markers`] that more than one thread may ask.
struct SharedMarkers(std::sync::Mutex<Markers<Arc<[(u8, Vec<u8>)]>>>);

impl json::SharedHook for SharedMarkers {
    fn string(&self, text: &str) -> Option<Result<Value, JsonError>> {
        // Every marker starts with "S2" and a colon at index 3; the strings that do not are most of them.
        if text.len() < 4 || !text.starts_with("S2") || text.as_bytes()[3] != b':' {
            return None;
        }
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).string(text)
    }
}

impl<S: AsRef<[(u8, Vec<u8>)]>> Markers<S> {
    /// Whether the markers read so far were all good and a document of this size is within the limit that [`decode`] holds it to.
    fn is_sound(&self, document: &Value) -> bool {
        self.error.is_none() && (self.materialized_upper <= MAX_MATERIALIZED_BYTES || json_length(document) <= MAX_MATERIALIZED_BYTES)
    }
}

/// A container that has been read, verified and scanned, with no document built from it.
pub struct Checked {
    /// The container's pieces. A skeleton that was not UTF-8 has had its bad bytes replaced,
    /// as the browser's text decoder replaces them before parsing.
    pub parts: Parts,
    /// Where each member of a root object lies in the skeleton; `None` when the root is not an object.
    pub members: Option<Vec<Member>>,
    /// Whether the cheap bound of the JSON the document stands for is within the limit. When it
    /// is not, only [`decode`] can measure the document exactly.
    pub within_limit: bool,
}

/// Reads a container as [`decode`] does, up to building the document: the same checks, in the same order,
/// with the same errors, on the skeleton and every marker it holds, but nothing is built. A large
/// project costs a scan of its skeleton instead of a tree.
pub fn check(bytes: &[u8], kind: Kind) -> Result<Checked, ContainerError> {
    let mut parts = decode_parts(bytes, kind)?;
    if std::str::from_utf8(&parts.skeleton).is_err() {
        parts.skeleton = String::from_utf8_lossy(&parts.skeleton).into_owned().into_bytes();
    }
    if parts.version < 2 {
        let members = json::scan(&parts.skeleton)?;
        return Ok(Checked { parts, members, within_limit: true });
    }
    let mut markers = Markers::new(&parts.sections, parts.skeleton.len());
    markers.build = false;
    let scanned = json::scan_with(&parts.skeleton, &mut markers);
    if let Some(error) = markers.error.take() {
        return Err(error);
    }
    let within_limit = markers.materialized_upper <= MAX_MATERIALIZED_BYTES;
    let members = scanned?;
    Ok(Checked { parts, members, within_limit })
}

/// The value of one member found by [`check`], built as [`decode`] builds it.
pub fn member_value(checked: &Checked, member: &Member) -> Result<Value, ContainerError> {
    let text = &checked.parts.skeleton[member.value.clone()];
    if checked.parts.version < 2 {
        return Ok(json::parse(text)?);
    }
    let mut markers = Markers::new(&checked.parts.sections, text.len());
    let parsed = json::parse_with(text, &mut markers);
    if let Some(error) = markers.error.take() {
        return Err(error);
    }
    Ok(parsed?)
}

/// Reads one lifted record: skeleton text whose markers name ranges of the given
/// numeric-array and payload sections, as [`super::lift`] writes them. The interface
/// sends changed records to the engine this way, so pose arrays cross as bytes.
pub fn parse_lifted(skeleton: &[u8], arrays: &[u8], payloads: &[u8]) -> Result<Value, ContainerError> {
    let sections = [(1u8, arrays.to_vec()), (2u8, payloads.to_vec())];
    parse_lifted_sections(skeleton, sections, MAX_MATERIALIZED_BYTES).map(|admitted| admitted.document)
}

/// Consumes assembled worker sections, avoiding another full-section copy.
pub fn parse_lifted_owned(skeleton: Vec<u8>, arrays: Vec<u8>, payloads: Vec<u8>) -> Result<Value, ContainerError> {
    parse_lifted_owned_within(skeleton, arrays, payloads, MAX_MATERIALIZED_BYTES)
}

/// The same marker parser with a tighter materialization admission budget.
/// A stream's completion is not an admission ACK until this succeeds.
pub fn parse_lifted_owned_within(skeleton: Vec<u8>, arrays: Vec<u8>, payloads: Vec<u8>, materialization_limit: usize) -> Result<Value, ContainerError> {
    parse_lifted_owned_admitted_within(skeleton, arrays, payloads, materialization_limit).map(|admitted| admitted.document)
}

/// The single parse result and its conservative retained-allocation admission.
/// Hosts can charge a staged transaction without another traversal or serialization.
pub struct LiftedAdmitted {
    pub document: Value,
    pub retained_bytes: usize,
}

pub fn parse_lifted_owned_admitted_within(skeleton: Vec<u8>, arrays: Vec<u8>, payloads: Vec<u8>, materialization_limit: usize) -> Result<LiftedAdmitted, ContainerError> {
    parse_lifted_sections(&skeleton, [(1, arrays), (2, payloads)], materialization_limit)
}

fn parse_lifted_sections(skeleton: &[u8], sections: [(u8, Vec<u8>); 2], materialization_limit: usize) -> Result<LiftedAdmitted, ContainerError> {
    if skeleton.len() > MAX_SKELETON_BYTES || sections.iter().any(|(_, bytes)| bytes.len() > MAX_BYTES)
        || materialization_limit > MAX_MATERIALIZED_BYTES || sections.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() > materialization_limit {
        return Err(ContainerError::MaterializedTooLarge);
    }
    let mut markers = Markers::new(&sections, skeleton.len());
    markers.materialization_limit = materialization_limit;
    let parsed = parse_text(skeleton, Some(&mut markers));
    if let Some(error) = markers.error.take() {
        return Err(error);
    }
    let document = parsed?;
    if markers.materialized_upper > materialization_limit && json_length(&document) > materialization_limit {
        return Err(ContainerError::MaterializedTooLarge);
    }
    Ok(LiftedAdmitted { document, retained_bytes: markers.allocation.max(markers.materialized_upper) })
}

/// A section as the file lists it.
struct Record {
    kind: u8,
    codec: Codec,
    raw: usize,
    stored: usize,
    offset: usize,
    digest: [u8; 32],
}

/// How a container is laid out, checked against the file's length and limits, and nothing unpacked yet.
enum Layout {
    /// A plain JSON project (version 0).
    Plain,
    /// One zlib block: the document.
    Document { codec: Codec, raw: usize, digest: [u8; 32] },
    /// A skeleton and sections.
    Sections { codec: Codec, raw: usize, digest: [u8; 32], skeleton: std::ops::Range<usize>, records: Vec<Record> },
}

/// Reads the header of a container and the table of its sections, with every check that needs no unpacking.
fn layout(bytes: &[u8], kind: Kind) -> Result<Layout, ContainerError> {
    if bytes.len() > MAX_BYTES {
        return Err(ContainerError::FileTooLarge { size: bytes.len() });
    }
    if kind == Kind::Styk {
        // Projects saved before the container existed are plain JSON, possibly after a
        // byte-order mark or whitespace.
        let lead = bytes.iter().position(|b| !matches!(b, 0xef | 0xbb | 0xbf | b' ' | b'\t' | b'\r' | b'\n'));
        if lead.is_some_and(|at| bytes[at] == b'{') {
            return Ok(Layout::Plain);
        }
    }
    if bytes.len() < HEADER {
        return Err(ContainerError::Truncated("no room for the 56-byte header"));
    }
    if &bytes[..4] != kind.magic() {
        return Err(ContainerError::WrongMagic {
            found: [bytes[0], bytes[1], bytes[2], bytes[3]],
            expected: std::str::from_utf8(kind.magic()).unwrap(),
            kind: kind.name(),
        });
    }
    let version = bytes[4];
    let codec = Codec::from_byte(bytes[5]);
    let flags = u16::from_le_bytes([bytes[6], bytes[7]]);
    let (Some(codec), true, 0) = (codec, version == 1 || version == 2, flags) else {
        return Err(ContainerError::Unsupported("unknown version, compression or flags in the header"));
    };
    if version == 1 && codec != Codec::Zlib {
        return Err(ContainerError::Unsupported("a version 1 file must use zlib"));
    }
    let raw = u64_at(bytes, 8);
    let stored = u64_at(bytes, 16);
    let raw_limit = if version == 2 { MAX_SKELETON_BYTES } else { MAX_BYTES } as u64;
    if raw == 0 || raw > raw_limit || stored > MAX_BYTES as u64 {
        return Err(ContainerError::DeclaredTooLarge { what: "document", size: raw });
    }
    let (raw, stored) = (raw as usize, stored as usize);
    let digest: [u8; 32] = bytes[24..56].try_into().unwrap();

    if version == 1 {
        if HEADER + stored != bytes.len() {
            return Err(ContainerError::LengthMismatch("a payload length that does not match the file"));
        }
        return Ok(Layout::Document { codec, raw, digest });
    }

    if bytes.len() < HEADER + 4 {
        return Err(ContainerError::Truncated("no room for the section count"));
    }
    let count = u32::from_le_bytes(bytes[HEADER..HEADER + 4].try_into().unwrap()) as usize;
    let skeleton_end = HEADER + 4 + stored;
    if count > 64 || skeleton_end + count * SECTION > bytes.len() {
        return Err(ContainerError::Truncated("no room for the skeleton and the section table"));
    }
    let mut records = Vec::with_capacity(count);
    let mut position = skeleton_end + count * SECTION;
    // Upper bound of the JSON the file stands for: base64 grows payloads by a third,
    // and the app has always charged three bytes per stored byte.
    let mut expected = raw as u64;
    for index in 0..count {
        let at = skeleton_end + index * SECTION;
        let record = &bytes[at..at + SECTION];
        let section_kind = record[0];
        if section_kind != 1 && section_kind != 2 {
            return Err(ContainerError::UnknownSectionKind { index, kind: section_kind });
        }
        let reserved = record[2..8].iter().chain(&record[56..64]).any(|&b| b != 0);
        let (Some(section_codec), false) = (Codec::from_byte(record[1]), reserved) else {
            return Err(ContainerError::Unsupported("unknown compression or reserved bytes in a section record"));
        };
        let section_raw = u64_at(record, 8);
        let section_stored = u64_at(record, 16);
        if section_raw > MAX_BYTES as u64 || section_stored > (bytes.len() - position) as u64 || (section_codec == Codec::Stored && section_raw != section_stored) {
            return Err(ContainerError::SectionBounds { index, what: "its lengths exceed the file or the section limit" });
        }
        expected += section_raw * 3;
        records.push(Record {
            kind: section_kind,
            codec: section_codec,
            raw: section_raw as usize,
            stored: section_stored as usize,
            offset: position,
            digest: record[24..56].try_into().unwrap(),
        });
        position += section_stored as usize;
    }
    if position != bytes.len() {
        return Err(ContainerError::LengthMismatch("bytes after its last section"));
    }
    if expected > MAX_MATERIALIZED_BYTES as u64 {
        return Err(ContainerError::DeclaredTooLarge { what: "document with its sections", size: expected });
    }
    Ok(Layout::Sections { codec, raw, digest, skeleton: HEADER + 4..skeleton_end, records })
}

/// A section unpacked and checked against its checksum.
fn unpack_section(index: usize, record: &Record, stored: &[u8]) -> Result<(u8, Vec<u8>), ContainerError> {
    let name = || format!("section {index}");
    let payload = unpack(record.codec, stored, record.raw, &name)?;
    if sha256(&payload) != record.digest {
        return Err(ContainerError::Checksum { what: name() });
    }
    Ok((record.kind, payload))
}

/// Verifies a container and returns its uncompressed pieces without building a document.
pub fn decode_parts(bytes: &[u8], kind: Kind) -> Result<Parts, ContainerError> {
    match layout(bytes, kind)? {
        Layout::Plain => Ok(Parts { version: 0, skeleton: bytes.to_vec(), sections: Vec::new() }),
        Layout::Document { codec, raw, digest } => {
            let payload = unpack(codec, &bytes[HEADER..], raw, &|| "document".to_string())?;
            if sha256(&payload) != digest {
                return Err(ContainerError::Checksum { what: "document".to_string() });
            }
            Ok(Parts { version: 1, skeleton: payload, sections: Vec::new() })
        }
        Layout::Sections { codec, raw, digest, skeleton, records } => {
            let skeleton = unpack(codec, &bytes[skeleton], raw, &|| "skeleton".to_string())?;
            if sha256(&skeleton) != digest {
                return Err(ContainerError::Checksum { what: "skeleton".to_string() });
            }
            let mut sections = Vec::with_capacity(records.len());
            for (index, record) in records.iter().enumerate() {
                sections.push(unpack_section(index, record, &bytes[record.offset..record.offset + record.stored])?);
            }
            Ok(Parts { version: 2, skeleton, sections })
        }
    }
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

/// Parses the JSON text. Bytes that are not UTF-8 are replaced, as the browser's
/// text decoder replaced them before parsing.
fn parse_text<S: AsRef<[(u8, Vec<u8>)]>>(text: &[u8], markers: Option<&mut Markers<S>>) -> Result<Value, ContainerError> {
    let lossy;
    let text = match std::str::from_utf8(text) {
        Ok(_) => text,
        Err(_) => {
            lossy = String::from_utf8_lossy(text).into_owned();
            lossy.as_bytes()
        }
    };
    Ok(match markers {
        Some(markers) => json::parse_with(text, markers)?,
        None => json::parse(text)?,
    })
}

/// Length of `JSON.stringify(value)`.
fn json_length(value: &Value) -> usize {
    // Rare (documents near 1 GiB of JSON): building the text is acceptable.
    let mut out = Vec::new();
    json::write(value, &mut out);
    out.len()
}

/// Turns marker strings into the values they stand for while the tree is built.
struct Markers<S: AsRef<[(u8, Vec<u8>)]>> {
    sections: S,
    /// One array per distinct marker text (equal markers are the same array), with its length.
    arrays: HashMap<String, (Value, usize)>,
    /// Whether to build the arrays and payloads the markers name. A checking pass (see [`check`])
    /// admits and validates them exactly the same way and keeps nothing.
    build: bool,
    /// One copy of each payload range, however many markers name it.
    payloads: HashMap<(usize, usize, usize), Arc<[u8]>>,
    /// Bytes the JavaScript reader would allocate: sections, 48 per restored number,
    /// base64 text per payload reference.
    allocation: usize,
    /// Upper bound of the expanded document's JSON length.
    materialized_upper: usize,
    materialization_limit: usize,
    /// The container error behind a refused string (the JSON layer only carries its own).
    error: Option<ContainerError>,
}

impl<S: AsRef<[(u8, Vec<u8>)]>> Markers<S> {
    fn new(sections: S, skeleton_bytes: usize) -> Self {
        let allocation = sections.as_ref().iter().map(|(_, bytes)| bytes.len()).sum();
        Markers {
            sections,
            arrays: HashMap::new(),
            build: true,
            payloads: HashMap::new(),
            allocation,
            materialized_upper: skeleton_bytes,
            materialization_limit: MAX_MATERIALIZED_BYTES,
            error: None,
        }
    }

    fn fail(&mut self, error: ContainerError) -> Option<Result<Value, JsonError>> {
        self.error.get_or_insert(error);
        // The parser stops at the first error; the stored container error is the one reported.
        Some(Err(JsonError::Syntax { offset: 0, message: "invalid section marker" }))
    }

    /// Charges `bytes` to the allocation, or refuses them. Takes the fields it needs, not `self`: the section being read is borrowed.
    fn admit(allocation: &mut usize, limit: usize, bytes: usize) -> Result<(), ContainerError> {
        if bytes > limit.saturating_sub(*allocation) {
            return Err(ContainerError::MaterializedTooLarge);
        }
        *allocation += bytes;
        Ok(())
    }

    fn array(&mut self, text: &str, fields: &[&str]) -> Result<(Value, usize), ContainerError> {
        let invalid = || ContainerError::InvalidArraySection { marker: text.to_string() };
        let type_name = fields[0];
        let width = match type_name {
            "u8" => 1,
            "u16" => 2,
            "u32" | "i32" | "f32" => 4,
            _ => 8,
        };
        let [section, offset, count] = [safe_integer(fields[1]), safe_integer(fields[2]), safe_integer(fields[3])];
        let (Some(section), Some(offset), Some(count)) = (section, offset, count) else { return Err(invalid()) };
        let bytes = match self.sections.as_ref().get(section) {
            Some((1, bytes)) => bytes.as_slice(),
            _ => return Err(invalid()),
        };
        if offset % width != 0 || offset > bytes.len() || count > (bytes.len() - offset) / width {
            return Err(invalid());
        }
        Self::admit(&mut self.allocation, self.materialization_limit, count.saturating_mul(48))?;
        let data = &bytes[offset..offset + count * width];
        let non_finite = || ContainerError::NonFinite { marker: text.to_string() };
        if !self.build {
            let finite = match type_name {
                "f32" => data.as_chunks::<4>().0.iter().all(|&c| f32::from_le_bytes(c).is_finite()),
                "f64" => data.as_chunks::<8>().0.iter().all(|&c| f64::from_le_bytes(c).is_finite()),
                _ => true,
            };
            return if finite { Ok((Value::Null, count)) } else { Err(non_finite()) };
        }
        let numbers = match type_name {
            "u8" => Nums::F32(data.iter().map(|&b| b as f32).collect()),
            "u16" => Nums::F32(data.as_chunks::<2>().0.iter().map(|&c| u16::from_le_bytes(c) as f32).collect()),
            "u32" => Nums::new(&data.as_chunks::<4>().0.iter().map(|&c| u32::from_le_bytes(c) as f64).collect::<Vec<_>>()),
            "i32" => Nums::new(&data.as_chunks::<4>().0.iter().map(|&c| i32::from_le_bytes(c) as f64).collect::<Vec<_>>()),
            "f32" => {
                let values: Box<[f32]> = data.as_chunks::<4>().0.iter().map(|&c| f32::from_le_bytes(c)).collect();
                if values.iter().any(|v| !v.is_finite()) {
                    return Err(non_finite());
                }
                Nums::F32(values)
            }
            _ => {
                let values: Vec<f64> = data.as_chunks::<8>().0.iter().map(|&c| f64::from_le_bytes(c)).collect();
                if values.iter().any(|v| !v.is_finite()) {
                    return Err(non_finite());
                }
                Nums::new(&values)
            }
        };
        Ok((if count == 0 { Value::Arr(Arc::new(Vec::new())) } else { Value::Nums(Arc::new(numbers)) }, count))
    }

    fn payload(&mut self, text: &str, fields: &[&str], prefix: &str) -> Result<Value, ContainerError> {
        let invalid = || ContainerError::InvalidPayloadSection { marker: text.to_string() };
        let [section, offset, count] = [safe_integer(fields[0]), safe_integer(fields[1]), safe_integer(fields[2])];
        let (Some(section), Some(offset), Some(count)) = (section, offset, count) else { return Err(invalid()) };
        let bytes = match self.sections.as_ref().get(section) {
            Some((2, bytes)) => bytes.as_slice(),
            _ => return Err(invalid()),
        };
        if offset > bytes.len() || count > bytes.len() - offset {
            return Err(invalid());
        }
        let encoded = count.div_ceil(3) * 4;
        Self::admit(&mut self.allocation, self.materialization_limit, encoded)?;
        self.materialized_upper = self.materialized_upper.saturating_add(encoded);
        if !self.build {
            return Ok(Value::Null);
        }
        let data = self.payloads.entry((section, offset, count)).or_insert_with(|| Arc::from(&bytes[offset..offset + count])).clone();
        Ok(Value::Blob(Arc::new(Blob { prefix: Arc::from(prefix), bytes: data })))
    }
}

/// A run of ASCII digits as a JavaScript safe integer.
fn safe_integer(text: &str) -> Option<usize> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok().filter(|&n| n < (1 << 53)).map(|n| n as usize)
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

impl<S: AsRef<[(u8, Vec<u8>)]>> StringHook for Markers<S> {
    fn string(&mut self, text: &str) -> Option<Result<Value, JsonError>> {
        // Every marker starts with "S2" and a colon at index 3.
        if text.len() < 4 || !text.starts_with("S2") || text.as_bytes()[3] != b':' {
            return None;
        }
        let rest = &text[4..];
        match text.as_bytes()[2] {
            b'B' => {
                let fields: Vec<&str> = rest.split(':').collect();
                let well_formed = fields.len() == 4 && matches!(fields[0], "u8" | "u16" | "u32" | "i32" | "f32" | "f64") && fields[1..].iter().all(|f| digits(f));
                if !well_formed {
                    return self.fail(ContainerError::MalformedMarker { marker: text.to_string() });
                }
                if let Some((shared, count)) = self.arrays.get(text) {
                    self.materialized_upper = self.materialized_upper.saturating_add(count * (MAX_JSON_NUMBER_BYTES + 1) + 2);
                    return Some(Ok(shared.clone()));
                }
                match self.array(text, &fields) {
                    Ok((value, count)) => {
                        self.materialized_upper = self.materialized_upper.saturating_add(count * (MAX_JSON_NUMBER_BYTES + 1) + 2);
                        self.arrays.insert(text.to_string(), (value.clone(), count));
                        Some(Ok(value))
                    }
                    Err(error) => self.fail(error),
                }
            }
            b'S' => {
                let fields: Vec<&str> = rest.split(':').collect();
                if fields.len() != 3 || !fields.iter().all(|f| digits(f)) {
                    return self.fail(ContainerError::MalformedMarker { marker: text.to_string() });
                }
                Some(self.payload(text, &fields, "").or_else(|error| self.fail(error).unwrap()))
            }
            b'D' => {
                let mut fields = rest.splitn(4, ':');
                let (Some(a), Some(b), Some(c), Some(prefix)) = (fields.next(), fields.next(), fields.next(), fields.next()) else {
                    return self.fail(ContainerError::MalformedMarker { marker: text.to_string() });
                };
                if ![a, b, c].iter().all(|f| digits(f)) {
                    return self.fail(ContainerError::MalformedMarker { marker: text.to_string() });
                }
                Some(self.payload(text, &[a, b, c], prefix).or_else(|error| self.fail(error).unwrap()))
            }
            b'E' => Some(Ok(Value::str(rest))),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_doc::fanout::{StdThreads, start};

    #[test]
    fn a_lost_check_is_worked_out_in_place_not_taken_for_a_match() {
        let skeleton = b"{\"keyframes\":[]}".to_vec();
        let fan = StdThreads(2);
        // The task ends without a result, as one whose worker stopped does.
        let lost = start(&fan, || -> [u8; 32] { panic!("the worker that had the check stopped") });
        assert_eq!(skeleton_digest(lost, &skeleton, &fan), sha256(&skeleton), "the digest of the skeleton, worked out here");
        let kept = start(&fan, {
            let skeleton = skeleton.clone();
            move || sha256(&skeleton)
        });
        assert_eq!(skeleton_digest(kept, &skeleton, &fan), sha256(&skeleton));
        // A check whose result never came is an open refused, not accepted.
        let lost = start(&fan, || -> [u8; 32] { panic!("lost") });
        let deferred = Deferred { check: Some(lost), expected: sha256(&skeleton) };
        assert_eq!(deferred.finish(&fan), Err(ContainerError::WorkerStopped));
    }
}
