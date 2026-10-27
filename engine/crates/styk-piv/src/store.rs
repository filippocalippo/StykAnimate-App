//! The source cache and its import/export operations (`server.ProjectStore`).
//!
//! An import keeps the uploaded bytes and the encoded document in a bounded LRU
//! cache keyed by content. An open document can also *lease* its original bytes
//! (by an owner identity), which survive cache eviction until the owner lets go:
//! that is what makes "export unchanged" return the original file, and what a
//! native save embeds. Limits, eviction order and error codes are the Python
//! service's.

use std::sync::Arc;

use sha2::{Digest, Sha256};
use styk_doc::Value;

use crate::bridge;
use crate::ctx::Ctx;
use crate::digest::document_digest;
use crate::docjson;
use crate::error::{Class, PyResult, api, piv, type_error};
use crate::native::{self, NativeDocuments};
use crate::piv::frames::{FrameMode, NATIVE_POSE_BUDGET};
use crate::piv::v5::{hex, sha256_hex};
use crate::piv::{self, decode_piv_bytes};
use crate::py;
use crate::pyjson::{self, Origin, Py};
use crate::wire::{self, WireParts};
use crate::write;

const MIB: usize = 1024 * 1024;
/// `server.MAX_SOURCE`: the store's own bound on a Pivot upload.
const MAX_SOURCE: usize = 128 * MIB;
/// `server.MAX_DOCUMENT`: the largest document or file one response carries.
pub(crate) const MAX_DOCUMENT: usize = 256 * MIB;

/// What a file is, by its extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Piv,
    Stk,
    Styk,
    Stkz,
    Stykmov,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Piv => "piv",
            Kind::Stk => "stk",
            Kind::Styk => "styk",
            Kind::Stkz => "stkz",
            Kind::Stykmov => "stykmov",
        }
    }

    /// Whether the original bytes are a Pivot file (the only kind that is leased and re-exported).
    pub fn is_pivot(self) -> bool {
        matches!(self, Kind::Piv | Kind::Stk)
    }
}

/// One cached import (`server.Source`).
pub(crate) struct Source {
    pub source_id: String,
    /// The uploaded bytes; empty for native documents, which embed their own source.
    pub data: Arc<[u8]>,
    pub document_json: Option<Vec<u8>>,
    pub digest: Option<String>,
    pub filename: String,
    pub kind: Kind,
    pub version: f64,
    pub decode_ms: f64,
    pub native_wire: Option<WireParts>,
}

impl Source {
    fn retained_size(&self) -> usize {
        self.data.len() + self.document_json.as_ref().map_or(0, Vec::len) + self.native_wire.as_ref().map_or(0, |w| w.header.len() + w.frames.len())
    }
}

/// Where a source was found.
#[derive(Clone, Copy)]
enum Found {
    Cached(usize),
    Leased(usize),
}

/// Sizes the store enforces (see [`crate::Limits`]).
pub(crate) struct StoreLimits {
    pub max_cache: usize,
    pub max_retained_sources: usize,
    pub max_source_owners: usize,
    pub max_cache_entries: usize,
}

pub(crate) struct Store {
    pub limits: StoreLimits,
    /// Least recently used first.
    sources: Vec<Source>,
    cache_bytes: usize,
    /// `(owner, source id)`.
    source_owners: Vec<(String, String)>,
    retained: Vec<Source>,
    retained_source_bytes: usize,
    pub native: Option<Box<dyn NativeDocuments>>,
    /// Milliseconds from an arbitrary origin; `None` leaves every timing at zero.
    pub clock: Option<Box<dyn Fn() -> f64>>,
}

/// `server.filename_only`: the sanitized base name of an upload.
pub(crate) fn filename_only(filename: &str) -> PyResult<String> {
    let name = filename.replace('\\', "/");
    let name = name.rsplit('/').next().unwrap_or("");
    let cleaned: String = name.chars().map(|c| if (c as u32) < 0x20 || matches!(c, '\u{7f}' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let trimmed: String = cleaned.trim_matches(|c| c == ' ' || c == '.').chars().take(220).collect();
    let supported = extension(&trimmed).is_some_and(|ext| matches!(ext.as_str(), "piv" | "stk" | "styk" | "stkz" | "stykmov" | "json"));
    if trimmed.is_empty() || !supported {
        return Err(api(415, "unsupported_file", "Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file."));
    }
    Ok(trimmed)
}

/// `Path(name).suffix[1:].lower()` of a name without directories.
fn extension(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 == name.len() {
        return None;
    }
    // `str.lower` also maps the Kelvin sign to `k`; no other letter lowers to ASCII.
    Some(name[dot + 1..].chars().map(|c| if c == '\u{212a}' { 'k' } else { c.to_ascii_lowercase() }).collect())
}

/// `Path(name).stem` of a name without directories.
pub(crate) fn stem(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => &name[..dot],
        _ => name,
    }
}

/// `PurePosixPath(text).stem`.
fn posix_stem(text: &str) -> &str {
    let name = text.split('/').rfind(|part| !part.is_empty() && *part != ".").unwrap_or("");
    stem(name)
}

/// The download name's base: unsafe characters replaced, trimmed, at most 180 characters.
fn export_base(text: &str, fallback: &str) -> String {
    let cleaned: String = text.chars().map(|c| if (c as u32) < 0x20 || matches!(c, '\u{7f}' | '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let base: String = cleaned.trim_matches(|c| c == ' ' || c == '.').chars().take(180).collect();
    if base.is_empty() { fallback.to_string() } else { base }
}

fn kind_of(name: &str) -> Kind {
    match extension(name).as_deref() {
        Some("stk") => Kind::Stk,
        Some("styk" | "json") => Kind::Styk,
        Some("stkz") => Kind::Stkz,
        Some("stykmov") => Kind::Stykmov,
        _ => Kind::Piv,
    }
}

fn expired() -> Box<crate::error::PyErr> {
    api(410, "source_expired", "The original source expired from memory. Reopen the original file before exporting.")
}

/// `ProjectStore._source_owner`: owners are 32 lowercase hexadecimal characters.
fn check_owner(owner: Option<&Value>) -> PyResult<&str> {
    match owner.and_then(Value::as_str) {
        Some(text) if text.len() == 32 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => Ok(text),
        _ => Err(api(400, "invalid_source_owner", "Invalid original source owner.")),
    }
}

/// What an import decoded, before it is cached.
pub(crate) struct Imported {
    pub document: Value,
    /// The inflated payload of a Pivot 5 file read for the native-frame transport.
    pub payload: Option<Vec<u8>>,
}

impl Store {
    pub fn new(limits: StoreLimits, native: Option<Box<dyn NativeDocuments>>) -> Store {
        Store { limits, sources: Vec::new(), cache_bytes: 0, source_owners: Vec::new(), retained: Vec::new(), retained_source_bytes: 0, native, clock: None }
    }

    fn now(&self) -> f64 {
        self.clock.as_ref().map_or(0.0, |clock| clock())
    }

    /// `_find_source`: a cached entry (refreshed in the LRU order) or a leased original.
    fn find_source(&mut self, source_id: &str) -> Option<Found> {
        if let Some(at) = self.sources.iter().position(|entry| entry.source_id == source_id) {
            let entry = self.sources.remove(at);
            self.sources.push(entry);
            return Some(Found::Cached(self.sources.len() - 1));
        }
        self.retained.iter().position(|entry| entry.source_id == source_id).map(Found::Leased)
    }

    fn entry(&self, found: Found) -> &Source {
        match found {
            Found::Cached(at) => &self.sources[at],
            Found::Leased(at) => &self.retained[at],
        }
    }

    fn entry_mut(&mut self, found: Found) -> &mut Source {
        match found {
            Found::Cached(at) => &mut self.sources[at],
            Found::Leased(at) => &mut self.retained[at],
        }
    }

    /// `_retain_source`: leases the entry's original bytes to `owner`.
    fn lease(&mut self, found: Found, owner: &str) -> PyResult<bool> {
        let (source_id, data, digest, filename, kind, version, decode_ms) = {
            let entry = self.entry(found);
            (entry.source_id.clone(), entry.data.clone(), entry.digest.clone(), entry.filename.clone(), entry.kind, entry.version, entry.decode_ms)
        };
        if !kind.is_pivot() || data.is_empty() {
            // Native projects already contain their original bytes.
            return Ok(false);
        }
        let old_id = self.source_owners.iter().find(|(o, _)| o == owner).map(|(_, id)| id.clone());
        if old_id.as_deref() == Some(source_id.as_str()) {
            return Ok(true);
        }
        if old_id.is_none() && self.source_owners.len() >= self.limits.max_source_owners {
            return Err(api(503, "source_owner_limit", "Too many original sources are active. Close unused documents and try again."));
        }
        // The previous lease stays if the new one cannot fit; when this owner is
        // its last reference, the replacement can reuse its budget.
        let remove_old = old_id.as_ref().is_some_and(|old| self.source_owners.iter().filter(|(_, id)| id == old).count() == 1);
        let old_size = match (&old_id, remove_old) {
            (Some(old), true) => self.retained.iter().find(|entry| &entry.source_id == old).map_or(0, |entry| entry.data.len()),
            _ => 0,
        };
        let already = self.retained.iter().any(|entry| entry.source_id == source_id);
        let added_size = if already { 0 } else { data.len() };
        if self.retained_source_bytes - old_size + added_size > self.limits.max_retained_sources {
            return Err(api(413, "source_retention_limit", "Active original sources exceed the retention limit. Close unused documents and try again."));
        }
        if let (Some(old), true) = (&old_id, remove_old) {
            self.retained_source_bytes -= old_size;
            self.retained.retain(|entry| &entry.source_id != old);
        }
        if added_size != 0 {
            self.retained.push(Source { source_id: source_id.clone(), data, document_json: None, digest, filename, kind, version, decode_ms, native_wire: None });
            self.retained_source_bytes += added_size;
        }
        match self.source_owners.iter_mut().find(|(o, _)| o == owner) {
            Some(slot) => slot.1 = source_id,
            None => self.source_owners.push((owner.to_string(), source_id)),
        }
        Ok(true)
    }

    /// `retain_source`: keeps an active document's original beyond cache eviction.
    pub fn retain_source(&mut self, source_id: Option<&Value>, owner: Option<&Value>) -> PyResult<bool> {
        let owner = check_owner(owner)?.to_string();
        let found = source_id.and_then(Value::as_str).and_then(|id| self.find_source(id));
        let Some(found) = found else { return Err(expired()) };
        self.lease(found, &owner)
    }

    /// `release_source`: drops the owner's lease, and the bytes with its last owner.
    pub fn release_source(&mut self, owner: Option<&Value>) -> PyResult<()> {
        let owner = check_owner(owner)?;
        let Some(at) = self.source_owners.iter().position(|(o, _)| o == owner) else { return Ok(()) };
        let (_, source_id) = self.source_owners.remove(at);
        if !self.source_owners.iter().any(|(_, id)| *id == source_id)
            && let Some(at) = self.retained.iter().position(|entry| entry.source_id == source_id)
        {
            let entry = self.retained.remove(at);
            self.retained_source_bytes -= entry.data.len();
        }
        Ok(())
    }

    /// `_decode_canonical`: the complete document of a cached Pivot source.
    fn decode_canonical(&self, ctx: &Ctx<'_>, found: Found) -> PyResult<Value> {
        ctx.checkpoint()?;
        let entry = self.entry(found);
        let mut document = if entry.kind == Kind::Stk {
            bridge::stk_document(ctx, &entry.filename, &entry.data)?
        } else {
            decode_piv_bytes(ctx, &entry.data, &entry.filename, FrameMode::Build)?.report
        };
        strip_transport_keys(&mut document);
        bridge::compact_media_aliases(&mut document);
        Ok(document)
    }

    /// `_canonical_json`: the encoded document, built on demand for an entry
    /// first opened through the native-frame transport.
    fn canonical_json(&self, ctx: &Ctx<'_>, found: Found) -> PyResult<std::borrow::Cow<'_, [u8]>> {
        if let Some(json) = &self.entry(found).document_json {
            return Ok(std::borrow::Cow::Borrowed(json));
        }
        let packed = docjson::to_bytes(&self.decode_canonical(ctx, found)?);
        if packed.len() > MAX_DOCUMENT {
            return Err(api(413, "document_too_large", "The decoded project exceeds the JSON transport limit."));
        }
        Ok(std::borrow::Cow::Owned(packed))
    }

    /// `_source_digest`: the fingerprint of the document as imported, computed once.
    fn source_digest(&mut self, ctx: &Ctx<'_>, found: Found) -> PyResult<String> {
        ctx.checkpoint()?;
        if let Some(digest) = &self.entry(found).digest {
            return Ok(digest.clone());
        }
        let digest = document_digest(ctx, &self.decode_canonical(ctx, found)?, true, Origin::Decoded)?;
        let source_id = self.entry(found).source_id.clone();
        self.entry_mut(found).digest = Some(digest.clone());
        if let Some(leased) = self.retained.iter_mut().find(|entry| entry.source_id == source_id) {
            leased.digest = Some(digest.clone());
        }
        Ok(digest)
    }

    /// `source_record`: the original bytes of an imported Pivot file and the
    /// provenance a native save embeds with them.
    pub fn source_record(&mut self, ctx: &Ctx<'_>, source_id: &str) -> PyResult<(Arc<[u8]>, Vec<u8>)> {
        let Some(found) = self.find_source(source_id) else { return Err(expired()) };
        let (kind, data, version) = {
            let entry = self.entry(found);
            (entry.kind, entry.data.clone(), entry.version)
        };
        if !kind.is_pivot() || data.is_empty() {
            return Err(api(422, "no_source", "The cached import has no binary source."));
        }
        let digest = self.source_digest(ctx, found)?;
        let meta = pyjson::to_bytes(&Py::Dict(vec![
            ("kind", Py::str(kind.name())),
            ("version", version_py(version)),
            ("sha256", Py::Str(sha256_hex(&data))),
            ("document_sha256", Py::Str(digest)),
            ("document_digest_version", Py::Int(3)),
        ]));
        Ok((data, meta))
    }

    /// Decodes an upload into its editable document (the uncached part of `import_bytes`).
    fn decode_upload(&self, ctx: &Ctx<'_>, data: &[u8], name: &str, canonical_name: &str, kind: Kind, prefer_native: bool) -> PyResult<Imported> {
        decode_upload(ctx, self.native.as_deref(), data, name, canonical_name, kind, prefer_native)
    }
}

/// What a file's name says it is.
pub(crate) fn kind_of_name(name: &str) -> Kind {
    kind_of(name)
}

/// Decodes a file into its editable document: the reader of its kind, then the
/// checks every import runs before the document may be edited.
pub(crate) fn decode_upload(ctx: &Ctx<'_>, native: Option<&dyn NativeDocuments>, data: &[u8], name: &str, canonical_name: &str, kind: Kind, prefer_native: bool) -> PyResult<Imported> {
    let mut payload = None;
    let mut document = match kind {
        Kind::Piv if prefer_native => {
            // `fast_decode.decode_for_native_wire`: validate the frames without
            // building them; duplicate object IDs select the complete decode.
            let scan = FrameMode::Scan { max_pose_bytes: NATIVE_POSE_BUDGET };
            let decoded = match decode_piv_bytes(ctx, data, canonical_name, scan) {
                Err(error) if error.exc == crate::error::Exc::PivIdentity => decode_piv_bytes(ctx, data, canonical_name, FrameMode::Build)?,
                other => other?,
            };
            if decoded.version == 5 {
                payload = Some(decoded.payload.into_owned());
            }
            decoded.report
        }
        Kind::Piv => decode_piv_bytes(ctx, data, canonical_name, FrameMode::Build)?.report,
        Kind::Stk => bridge::stk_document(ctx, name, data)?,
        _ => {
            let Some(reader) = native else {
                return Err(api(415, "unsupported_file", "Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file."));
            };
            native::unwrap_early_wrapper(reader.decode(data, name).map_err(native::native_error)?)?
        }
    };
    if !document.is_object() {
        return Err(api(400, "invalid_document", "Project data must be a JSON object."));
    }
    if matches!(kind, Kind::Stkz | Kind::Stykmov) {
        native::validate_native_figure(&document, kind.name())?;
    }
    strip_transport_keys(&mut document);
    if kind.is_pivot() {
        bridge::compact_media_aliases(&mut document);
    }
    let verified_v5 = kind == Kind::Piv && document.get("version").is_some_and(|v| py::eq(v, &Value::Num(5.0)));
    if verified_v5 {
        // The binary grammar already validated everything `validate_document` checks.
        if !document.get("keyframes").is_some_and(py::is_list) {
            return Err(piv("Invalid keyframe table"));
        }
    } else {
        bridge::validate_document(ctx, &document)?;
    }
    // Validate any embedded source before editing.
    bridge::source_bytes(&document)?;
    Ok(Imported { document, payload })
}

impl Store {
    /// `import_bytes(data, filename, as_json=True, prefer_native, source_owner)`:
    /// the response body, JSON or native-frame.
    pub fn import_bytes(&mut self, ctx: &Ctx<'_>, data: &[u8], filename: &str, prefer_native: bool, source_owner: Option<&str>) -> PyResult<Vec<u8>> {
        ctx.checkpoint()?;
        if let Some(owner) = source_owner {
            check_owner(Some(&Value::str(owner)))?;
        }
        let started = self.now();
        let name = filename_only(filename)?;
        let kind = kind_of(&name);
        if data.len() > (if kind.is_pivot() { MAX_SOURCE } else { MAX_DOCUMENT }) {
            return Err(api(413, "file_too_large", "This file exceeds the import size limit."));
        }
        if data.is_empty() {
            return Err(api(400, "empty_file", "This file is empty."));
        }
        // STK names become editable figure names, so the name is part of the key.
        let mut hasher = Sha256::new();
        hasher.update(kind.name().as_bytes());
        hasher.update([0u8]);
        hasher.update(data);
        if kind == Kind::Stk {
            hasher.update(name.as_bytes());
        }
        let source_id = hex(&hasher.finalize());
        let mut found = self.find_source(&source_id).filter(|found| matches!(found, Found::Cached(_)));
        let leased = self.retained.iter().find(|entry| entry.source_id == source_id).map(|entry| (entry.filename.clone(), entry.data.clone(), entry.digest.clone()));
        // PIV cache identity depends on bytes, not the display name: keep the
        // name (and bytes) of an active lease across eviction.
        let canonical_name = leased.as_ref().map_or(name.clone(), |(filename, _, _)| filename.clone());
        let source_bytes = leased.as_ref().map_or(data.len(), |(_, bytes, _)| bytes.len());
        let cache_hit = found.is_some();
        if found.is_none() {
            ctx.checkpoint()?;
            let decode_started = self.now();
            let Imported { document, payload } = self.decode_upload(ctx, data, &name, &canonical_name, kind, prefer_native)?;
            let wire_parts = match (&payload, prefer_native && kind == Kind::Piv) {
                (Some(payload), true) => wire::native_frame_wire(&document, payload)?,
                (None, true) => {
                    // A legacy file, or a document whose payload was not kept: `native_frame_wire` inflates it itself.
                    match document.get("version").is_some_and(|v| py::eq(v, &Value::Num(5.0))) {
                        true => wire::native_frame_wire(&document, &piv::unpack_source(data)?.0)?,
                        false => None,
                    }
                }
                _ => None,
            };
            let packed = if wire_parts.is_some() { None } else { Some(docjson::to_bytes(&document)) };
            if packed.as_ref().is_some_and(|packed| packed.len() > MAX_DOCUMENT) {
                return Err(api(413, "document_too_large", "The decoded project exceeds the transport limit."));
            }
            // A native document embeds its original source: keeping the upload too would double it.
            let retained_source: Arc<[u8]> = match (kind.is_pivot(), &leased) {
                (false, _) => Arc::from(&[][..]),
                (true, Some((_, bytes, _))) => bytes.clone(),
                (true, None) => Arc::from(data),
            };
            let version = match document.get("version") {
                Some(Value::Num(n)) => *n,
                _ => return Err(crate::error::key_error("version")),
            };
            let entry = Source {
                source_id: source_id.clone(),
                data: retained_source,
                document_json: packed,
                digest: leased.as_ref().and_then(|(_, _, digest)| digest.clone()),
                filename: canonical_name.clone(),
                kind,
                version,
                decode_ms: self.now() - decode_started,
                native_wire: wire_parts,
            };
            if entry.retained_size() > self.limits.max_cache {
                return Err(api(413, "cache_limit", "The decoded project exceeds the source cache limit."));
            }
            self.cache_bytes += entry.retained_size();
            self.sources.push(entry);
            while self.cache_bytes > self.limits.max_cache || self.sources.len() > self.limits.max_cache_entries {
                let old = self.sources.remove(0);
                self.cache_bytes -= old.retained_size();
            }
            found = Some(Found::Cached(self.sources.len() - 1));
        }
        let Some(found) = found else { return Err(expired()) };
        let needs_wire = {
            let entry = self.entry(found);
            prefer_native && entry.kind == Kind::Piv && entry.version == 5.0 && entry.native_wire.is_none()
        };
        if needs_wire {
            // A JSON-first entry asked for natively: derive the transport from the cached document.
            let document = {
                let json = self.canonical_json(ctx, found)?;
                parse_cached(&json)?
            };
            let payload = piv::unpack_source(&self.entry(found).data)?.0.into_owned();
            if let Some(parts) = wire::native_frame_wire(&document, &payload)? {
                let added = parts.header.len() + parts.frames.len();
                if self.entry(found).retained_size() + added <= self.limits.max_cache {
                    self.entry_mut(found).native_wire = Some(parts);
                    self.cache_bytes += added;
                    while self.cache_bytes > self.limits.max_cache && self.sources.len() > 1 {
                        let old = self.sources.remove(0);
                        self.cache_bytes -= old.retained_size();
                    }
                }
            }
        }
        // Eviction above only removes older entries: this one is the newest.
        let found = Found::Cached(self.sources.len() - 1);
        let retained = match source_owner {
            Some(owner) => self.lease(found, owner)?,
            None => false,
        };
        let entry = self.entry(found);
        let round3 = |value: f64| (value * 1000.0).round_ties_even() / 1000.0;
        let mut timings = vec![
            ("decode_ms", Py::Float(round3(entry.decode_ms))),
            ("cache_hit", Py::Bool(cache_hit)),
            ("total_ms", Py::Float(round3(self.now() - started))),
            ("source_bytes", Py::Int(source_bytes as i64)),
            ("document_bytes", entry.document_json.as_ref().map_or(Py::Null, |json| Py::Int(json.len() as i64))),
        ];
        let metadata = |timings: Vec<(&'static str, Py)>| {
            let mut metadata = vec![
                ("ok", Py::Bool(true)),
                ("sourceId", Py::Str(source_id.clone())),
                ("filename", Py::Str(name.clone())),
                ("kind", Py::str(kind.name())),
                ("version", version_py(entry.version)),
                ("timings", Py::Dict(timings)),
            ];
            if retained {
                metadata.push(("sourceOwner", Py::str(source_owner.unwrap_or(""))));
            }
            metadata
        };
        if prefer_native && let Some(parts) = &entry.native_wire {
            timings.push(("transport", Py::str("native-v5-frames")));
            let result = wire::response_bytes(parts, metadata(timings.clone()));
            if result.len() <= MAX_DOCUMENT {
                return Ok(result);
            }
        }
        // The encoded document is transported as it is: no parse, no second serialization.
        let packed = self.canonical_json(ctx, found)?;
        timings[4].1 = Py::Int(packed.len() as i64);
        timings[2].1 = Py::Float(round3(self.now() - started));
        let tail = pyjson::to_bytes(&Py::Dict(metadata(timings)));
        let mut out = Vec::with_capacity(12 + packed.len() + tail.len());
        out.extend_from_slice(b"{\"document\":");
        out.extend_from_slice(&packed);
        out.push(b',');
        out.extend_from_slice(&tail[1..]);
        Ok(out)
    }

    /// Keeps an uploaded Pivot project for saving a document that was read from it elsewhere (the engine decodes
    /// the file itself, in the page): the original is leased to `owner` like an import's, under the id an import
    /// of the same bytes would have, and nothing is decoded. Answers what an import answers about the source.
    pub fn keep_upload(&mut self, ctx: &Ctx<'_>, data: &[u8], filename: &str, owner: Option<&str>) -> PyResult<Py> {
        ctx.checkpoint()?;
        let owner = check_owner(owner.map(Value::str).as_ref())?.to_string();
        let name = filename_only(filename)?;
        if kind_of(&name) != Kind::Piv {
            return Err(api(415, "unsupported_file", "Only a Pivot project has an original source to keep."));
        }
        if data.is_empty() {
            return Err(api(400, "empty_file", "This file is empty."));
        }
        if data.len() > MAX_SOURCE {
            return Err(api(413, "file_too_large", "This file exceeds the import size limit."));
        }
        let version = f64::from(piv::payload_version(data)?);
        let mut hasher = Sha256::new();
        hasher.update(Kind::Piv.name().as_bytes());
        hasher.update([0u8]);
        hasher.update(data);
        let source_id = hex(&hasher.finalize());
        let found = match self.find_source(&source_id) {
            Some(found) => found,
            None => {
                let entry = Source { source_id: source_id.clone(), data: Arc::from(data), document_json: None, digest: None, filename: name.clone(), kind: Kind::Piv, version, decode_ms: 0.0, native_wire: None };
                if entry.retained_size() > self.limits.max_cache {
                    return Err(api(413, "cache_limit", "The project exceeds the source cache limit."));
                }
                self.cache_bytes += entry.retained_size();
                self.sources.push(entry);
                while self.cache_bytes > self.limits.max_cache || self.sources.len() > self.limits.max_cache_entries {
                    let old = self.sources.remove(0);
                    self.cache_bytes -= old.retained_size();
                }
                Found::Cached(self.sources.len() - 1)
            }
        };
        let retained = self.lease(found, &owner)?;
        Ok(Py::Dict(vec![
            ("ok", Py::Bool(true)),
            ("sourceId", Py::Str(source_id)),
            ("filename", Py::Str(name)),
            ("kind", Py::str(Kind::Piv.name())),
            ("version", version_py(version)),
            ("sourceOwner", Py::Str(owner)),
            ("retained", Py::Bool(retained)),
        ]))
    }

    /// `export(request)`: the file bytes and the download name.
    pub fn export(&mut self, ctx: &Ctx<'_>, request: &Value, timings: &mut Vec<(&'static str, f64)>) -> PyResult<(Vec<u8>, String)> {
        ctx.checkpoint()?;
        let mut stage_started = self.now();
        let mut mark = |store: &Store, stage: &'static str, timings: &mut Vec<(&'static str, f64)>| -> PyResult<()> {
            ctx.checkpoint()?;
            let now = store.now();
            timings.push((stage, now - stage_started));
            stage_started = now;
            Ok(())
        };
        let Some(document) = py::get(request, "document")?.filter(|d| d.is_object()) else {
            return Err(api(400, "invalid_document", "Export requires an editable document."));
        };
        let format_name = match py::get(request, "format")? {
            None => "piv",
            Some(value) => match value.as_str() {
                Some(name @ ("piv" | "stk" | "styk" | "stkz" | "stykmov")) => name,
                _ => return Err(api(415, "unsupported_export", "Export as piv, stk, styk, stkz, or stykmov.")),
            },
        };
        bridge::validate_document(ctx, document)?;
        mark(self, "validate", timings)?;
        let filename = py::get(request, "filename")?.filter(|name| py::truthy(name));
        if matches!(format_name, "stkz" | "stykmov") {
            native::validate_native_figure(document, format_name)?;
            let mut output = document.clone();
            if let Some(object) = output.make_obj() {
                object.remove("_stykSource");
                object.set("_styk", native::saved_metadata(document)?);
            }
            let bytes = self.encode_native(&output, format_name, &[])?;
            let base = export_base(&filename.map(py::str_of).unwrap_or_else(|| "Figure".to_string()), "Figure");
            mark(self, "encode", timings)?;
            return Ok((bytes, format!("{base}.{format_name}")));
        }
        let source_id = py::get(request, "sourceId")?;
        let found = source_id.and_then(Value::as_str).and_then(|id| self.find_source(id));
        if py::truthy_opt(source_id) && found.is_none() {
            return Err(expired());
        }
        let pivot_entry = found.filter(|&found| self.entry(found).kind.is_pivot());
        if let Some(found) = pivot_entry {
            self.source_digest(ctx, found)?;
        }
        mark(self, "source_digest", timings)?;
        let empty = Value::object(styk_doc::Obj::new());
        let metadata = py::get(document, "_stykSource")?.unwrap_or(&empty);
        let embedded_source = bridge::source_bytes(document)?;
        let (source, source_kind, original_digest): (Option<Arc<[u8]>>, Option<String>, Option<String>) = match pivot_entry {
            Some(found) => {
                let entry = self.entry(found);
                (Some(entry.data.clone()), Some(entry.kind.name().to_string()), entry.digest.clone())
            }
            None => (
                embedded_source,
                py::get(metadata, "kind")?.and_then(Value::as_str).map(str::to_string),
                py::get(metadata, "document_sha256")?.and_then(Value::as_str).map(str::to_string),
            ),
        };
        // A native save always keeps the edited document: comparing it with the
        // source only matters for binary PIV/STK exports.
        let compare_binary = format_name != "styk";
        mark(self, "provenance", timings)?;
        let current_digest = if compare_binary { Some(document_digest(ctx, document, true, Origin::Client)?) } else { None };
        let mut unchanged = compare_binary && current_digest.is_some() && current_digest == original_digest;
        let digest_version = |metadata: &Value| -> PyResult<Value> { Ok(py::get(metadata, "document_digest_version")?.cloned().unwrap_or(Value::Num(1.0))) };
        if compare_binary && !unchanged && pivot_entry.is_none() && py::eq(&digest_version(metadata)?, &Value::Num(1.0)) {
            // Native files written before numeric canonicalization used the previous hash.
            unchanged = Some(document_digest(ctx, document, false, Origin::Client)?) == original_digest;
        }
        let version = match py::item(document, "version")? {
            Value::Num(n) => *n,
            _ => 5.0,
        };
        if compare_binary
            && !unchanged
            && source.is_some()
            && source_kind.as_deref() == Some("piv")
            && version < 5.0
            && py::cmp(&digest_version(metadata)?, &Value::Num(3.0), "<")? == std::cmp::Ordering::Less
        {
            // Older native saves dropped the legacy pose cache but fingerprinted it:
            // rebuild the source's document once to compare authoritative data.
            let source_path = py::get(document, "source_path")?.map(py::str_of).unwrap_or_default();
            let bytes = source.clone().unwrap_or_else(|| Arc::from(&[][..]));
            let mut original = decode_piv_bytes(ctx, &bytes, &source_path, FrameMode::Build)?.report;
            strip_transport_keys(&mut original);
            bridge::compact_media_aliases(&mut original);
            unchanged = current_digest == Some(document_digest(ctx, &original, true, Origin::Decoded)?);
        }
        mark(self, "document_digest", timings)?;
        let pivot_source = source.as_ref().filter(|_| source_kind.as_deref() == Some("piv"));
        let output: Vec<u8> = if format_name == "styk" {
            let mut output = document.clone();
            let mut reserved: Vec<Arc<[u8]>> = Vec::new();
            let saved = native::saved_metadata(document)?;
            let provenance = pivot_entry.map(|found| {
                let entry = self.entry(found);
                reserved.push(entry.data.clone());
                let mut object = crate::ctx::ObjB::new();
                object.set("kind", crate::ctx::text(entry.kind.name()));
                object.num("version", entry.version);
                object.set("source_base64", crate::piv::side_tables::blob("", &entry.data));
                object.set("sha256", crate::ctx::text(&sha256_hex(&entry.data)));
                object.set("document_sha256", entry.digest.as_deref().map(crate::ctx::text).unwrap_or(Value::Null));
                object.num("document_digest_version", 3.0);
                object.build()
            });
            if let Some(object) = output.make_obj() {
                object.set("_styk", saved);
                if let Some(provenance) = provenance {
                    object.set("_stykSource", provenance);
                }
            }
            self.encode_native(&output, "styk", &reserved)?
        } else if format_name == "stk" {
            let selected = py::get(request, "figureTypeId")?;
            let selection_matches = selected.is_none_or(|s| s.is_null() || py::eq(s, &Value::Num(2.0)));
            match (&source, source_kind.as_deref() == Some("stk") && unchanged && selection_matches) {
                (Some(source), true) => source.to_vec(),
                _ => {
                    let mut output = document.clone();
                    if let (Some(selected), Some(object)) = (selected.filter(|s| !s.is_null()), output.make_obj()) {
                        object.set("_exportFigureTypeId", selected.clone());
                    }
                    bridge::export_stk(ctx, &output)?
                }
            }
        } else if let (Some(source), true) = (pivot_source, unchanged) {
            source.to_vec()
        } else if version < 5.0 {
            let Some(source) = pivot_source else {
                return Err(api(422, "missing_legacy_source", "Legacy PIV export requires its imported source."));
            };
            write::migrate::migrate_legacy_bytes(ctx, source, Some(document))?
        } else if let Some(source) = pivot_source {
            // An explicit upgrade makes the editable schema version 5 while the
            // original legacy bytes stay for provenance: never hand those to the
            // version 5 writer, and never trust the editable metadata's version.
            let mut source_version = pivot_entry.filter(|&found| self.entry(found).kind == Kind::Piv).map(|found| self.entry(found).version as i64);
            if source_version.is_none() {
                let (payload, _) = piv::unpack_source(source)?;
                source_version = payload.first().map(|&v| v as i64);
                if matches!(source_version, Some(2..=4)) {
                    // A matching SHA is not evidence of a valid Pivot file.
                    decode_piv_bytes(ctx, &payload, "", FrameMode::Build)?;
                }
            }
            if matches!(source_version, Some(2..=4)) {
                let source_digest = sha256_hex(source);
                let recorded = py::get(document, "source_sha256")?;
                if recorded.is_some_and(|recorded| recorded.as_str() != Some(source_digest.as_str())) {
                    return Err(piv("Edited document belongs to a different original source"));
                }
                write::full::encode_piv_project(ctx, &bridge::scaffold(document)?, document, true)?
            } else {
                write::full::encode_piv_project(ctx, source, document, false)?
            }
        } else {
            write::full::encode_piv_project(ctx, &bridge::scaffold(document)?, document, true)?
        };
        if output.len() > MAX_DOCUMENT {
            return Err(api(413, "export_too_large", "The exported project exceeds the transport limit."));
        }
        mark(self, "encode", timings)?;
        let base = match (filename, found) {
            (Some(name), _) => match name.as_str() {
                Some(text) => posix_stem(text).to_string(),
                None => {
                    return Err(type_error(format!(
                        "argument should be a str or an os.PathLike object where __fspath__ returns a str, not '{}'",
                        py::type_name(name)
                    )));
                }
            },
            (None, Some(found)) => stem(&self.entry(found).filename).to_string(),
            (None, None) => "Untitled".to_string(),
        };
        Ok((output, format!("{}.{}", export_base(&base, "Untitled"), format_name)))
    }

    fn encode_native(&self, document: &Value, kind: &str, reserved: &[Arc<[u8]>]) -> PyResult<Vec<u8>> {
        let Some(writer) = &self.native else {
            return Err(api(415, "unsupported_export", "Export as piv, stk, styk, stkz, or stykmov."));
        };
        writer.encode(document, kind, reserved).map_err(native::native_error)
    }
}

/// Fields only older builds or the browser wrote, dropped on every import.
fn strip_transport_keys(document: &mut Value) {
    let present = ["editable_paths", "_codec", "_stykWeb"].iter().any(|key| document.get(key).is_some());
    if present && let Some(object) = document.make_obj() {
        for key in ["editable_paths", "_codec", "_stykWeb"] {
            object.remove(key);
        }
    }
}

fn version_py(version: f64) -> Py {
    if version.fract() == 0.0 && version.abs() < 9.0e15 { Py::Int(version as i64) } else { Py::Float(version) }
}

/// Reads back a cached encoded document.
fn parse_cached(json: &[u8]) -> PyResult<Value> {
    styk_doc::json::parse(json).map_err(|error| crate::error::value_error(error.to_string()))
}

/// The classes the service reported as an invalid project (used by tests of the mapping).
#[allow(dead_code)]
pub(crate) fn is_invalid_project(error: &crate::error::PyErr) -> bool {
    error.is_any(&[Class::Value, Class::Type, Class::Key, Class::Index, Class::Struct])
}
