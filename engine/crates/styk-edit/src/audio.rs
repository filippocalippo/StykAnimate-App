//! Audio tracks and clips: track and clip settings changed, tracks
//! and clips deleted, each one `audio` history entry that touches no frame or figure
//! (`publish`). Commands that make new identities (adding, importing, splitting, duplicating,
//! pasting) take them from the values the editor draws (D18).

use std::cell::RefCell;
use std::sync::{Arc, Weak};

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::{EditError, Editor};

/// `AUDIO_RATE`.
const RATE: f64 = 48000.0;
const CHUNK_BYTES: f64 = 192.0 * 1024.0;
const MAX_FILE_BYTES: f64 = 32.0 * 1024.0 * 1024.0;
const MAX_PROJECT_BYTES: f64 = 96.0 * 1024.0 * 1024.0;
const MAX_SECONDS: f64 = 3600.0;
const MAX_TRACKS: usize = 64;
const MAX_CLIPS: usize = 4096;
const MAX_VOICES: i64 = 32;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(format!("errors.audioModel.{key}"))
}

/// `Number.isFinite(value)`: a number, not a coerced one.
fn finite(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `number(value, min, max, name)`.
fn number(value: Option<&Value>, min: f64, max: f64, name: &str) -> Result<f64, EditError> {
    match finite(value) {
        Some(n) if n >= min && n <= max => Ok(n),
        _ => Err(crate::invalid_with("errors.audioModel.mustBeBetweenAnd", vec![("name", crate::label(name)), ("min", Value::Num(min)), ("max", Value::Num(max))])),
    }
}

/// `id(value)`: 1 to 100 letters, digits, `_` or `-`.
fn identity_text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| (1..=100).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}

/// White space as `String.prototype.trim` removes it.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// A name as the model accepts it: text that is not only white space, at most `max`
/// UTF-16 units long.
fn name_ok(value: Option<&Value>, max: usize) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| !text.chars().all(js_space) && text.encode_utf16().count() <= max)
}

/// A strict-equality check (`===`) of two fields: containers by identity.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Num(x)), Some(Value::Num(y))) => x == y,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(x @ (Value::Str(_) | Value::Blob(_))), Some(y @ (Value::Str(_) | Value::Blob(_)))) => x.text() == y.text(),
        (Some(x), Some(y)) => x.same_node(y),
        _ => false,
    }
}

thread_local! {
    /// Recordings already checked, by identity (`checkedAssets`, a `WeakSet` there): a
    /// recording is checked once, not at every edit, and not kept alive by being checked.
    static CHECKED: RefCell<Vec<Weak<Obj>>> = const { RefCell::new(Vec::new()) };
}

/// The load's check of one recording (`validateAudioAssetSteps`).
pub(crate) fn check_asset(asset: &Value) -> Result<(), EditError> {
    validate_asset(asset).map(|_| ()).map_err(load_error)
}

/// The load's check of the audio state (`validateAudioState`).
pub(crate) fn check_state(state: &Value) -> Result<(), EditError> {
    validate_state(state).map_err(load_error)
}

/// A malformed document the JavaScript throws a `TypeError` on, which the commands leave to the editor.
fn load_error(error: EditError) -> EditError {
    match error {
        EditError::Unported(_) => EditError::Invalid(crate::load::TYPE_ERROR.into()),
        other => other,
    }
}

/// `validateAudioAsset(asset)`; returns its size.
fn validate_asset(asset: &Value) -> Result<f64, EditError> {
    let Value::Obj(object) = asset else { return Err(invalid("invalidAudioAsset")) };
    if CHECKED.with(|checked| checked.borrow().iter().any(|known| std::ptr::eq(known.as_ptr(), Arc::as_ptr(object)))) {
        return Ok(finite(asset.get("size")).unwrap_or(f64::NAN));
    }
    if identity_text(asset.get("id")).is_none() || !name_ok(asset.get("name"), 240) {
        return Err(invalid("invalidAudioAssetNameOrIdentity"));
    }
    let size = number(asset.get("size"), 1.0, MAX_FILE_BYTES, "Audio file size")?;
    number(asset.get("duration"), 1.0 / RATE, MAX_SECONDS, "Audio duration")?;
    let chunks = asset.get("chunks").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>());
    let Some(chunks) = chunks.filter(|c| size.fract() == 0.0 && c.len() as f64 <= (MAX_FILE_BYTES / CHUNK_BYTES).ceil()) else {
        return Err(invalid("invalidEmbeddedAudio"));
    };
    let mut total = 0.0;
    for chunk in &chunks {
        total += chunk_bytes(chunk.get("data_base64")).ok_or_else(|| invalid("invalidEmbeddedAudioBytes"))?;
    }
    if total != size {
        return Err(invalid("embeddedAudioIsIncomplete"));
    }
    let peaks = asset.get("peaks").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>());
    if !peaks.is_some_and(|p| !p.is_empty() && p.len() <= 4096 && p.iter().all(|v| finite(Some(v)).is_some_and(|n| (0.0..=1.0).contains(&n)))) {
        return Err(invalid("invalidAudioWaveform"));
    }
    CHECKED.with(|checked| {
        let mut checked = checked.borrow_mut();
        checked.retain(|known| known.strong_count() > 0);
        checked.push(Arc::downgrade(object));
    });
    Ok(size)
}

/// The bytes one chunk's base64 holds, when it is well formed: non-empty, padded,
/// at most one chunk long.
fn chunk_bytes(value: Option<&Value>) -> Option<f64> {
    let text = match value? {
        // A blob is the canonical base64 of its bytes after its prefix.
        Value::Blob(blob) if blob.prefix.is_empty() => {
            let length = blob.bytes.len().div_ceil(3) * 4;
            return (length > 0 && length as f64 <= CHUNK_BYTES * 4.0 / 3.0).then_some(blob.bytes.len() as f64);
        }
        other @ (Value::Str(_) | Value::Blob(_)) => other.text()?.into_owned(),
        _ => return None,
    };
    let body = text.trim_end_matches('=');
    let padding = text.len() - body.len();
    let well_formed = !text.is_empty()
        && text.len() as f64 <= CHUNK_BYTES * 4.0 / 3.0
        && text.len() % 4 == 0
        && !body.is_empty()
        && padding <= 2
        && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
    well_formed.then(|| (text.len() / 4 * 3 - padding) as f64)
}

/// `validateAudioState(state)`.
fn validate_state(state: &Value) -> Result<(), EditError> {
    let assets = state.get("assets").and_then(Value::as_obj);
    let tracks = state.get("tracks").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>());
    let (Some(assets), Some(tracks)) = (assets, tracks) else { return Err(invalid("unsupportedAudioDocument")) };
    if !matches!(state.get("version"), Some(Value::Num(v)) if *v == 1.0) || tracks.len() > MAX_TRACKS {
        return Err(invalid("unsupportedAudioDocument"));
    }
    let mut ids = std::collections::HashSet::new();
    let mut identity = |value: Option<&Value>| -> Result<(), EditError> {
        match identity_text(value) {
            Some(text) if ids.insert(text.to_string()) => Ok(()),
            _ => Err(invalid("duplicateOrInvalidAudioIdentity")),
        }
    };
    let mut bytes = 0.0;
    for (key, asset) in assets.iter() {
        if asset.is_null() {
            return Err(EditError::Unported("an audio recording that is null".into()));
        }
        if !matches!(asset.get("id"), Some(id) if id.as_str() == Some(&**key)) {
            return Err(invalid("invalidAudioAssetReference"));
        }
        identity(Some(&Value::Str(key.clone())))?;
        bytes += validate_asset(asset)?;
    }
    if bytes > MAX_PROJECT_BYTES {
        return Err(invalid("embeddedAudioExceedsThe96MibProjectLimit"));
    }
    let mut count = 0;
    for track in &tracks {
        // `track.id` of null throws a TypeError, not the model's message.
        if track.is_null() {
            return Err(EditError::Unported("an audio track that is null".into()));
        }
        identity(track.get("id"))?;
        let clips = track.get("clips").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>());
        let flags = matches!(track.get("mute"), Some(Value::Bool(_))) && matches!(track.get("solo"), Some(Value::Bool(_)));
        let (Some(clips), true, true) = (clips, name_ok(track.get("name"), 120), flags) else {
            return Err(invalid("invalidAudioTrack"));
        };
        number(track.get("gain"), 0.0, 4.0, "Track volume")?;
        for clip in clips {
            count += 1;
            if count > MAX_CLIPS {
                return Err(invalid("aProjectSupportsUpTo4096Audio"));
            }
            if clip.is_null() {
                return Err(EditError::Unported("an audio clip that is null".into()));
            }
            identity(clip.get("id"))?;
            let asset = match clip.get("assetId") {
                Some(Value::Str(id)) => assets.get(id),
                None => None,
                Some(_) => return Err(EditError::Unported("an audio clip whose recording is not named by text".into())),
            };
            let Some(duration) = asset.and_then(|a| finite(a.get("duration"))) else {
                return Err(invalid("audioClipReferencesAMissingRecording"));
            };
            let start = number(clip.get("start"), 0.0, MAX_SECONDS, "Clip start")?;
            let offset = number(clip.get("offset"), 0.0, duration, "Source trim")?;
            let length = number(clip.get("duration"), 1.0 / RATE, duration, "Clip duration")?;
            if offset + length > duration + 1e-7 || start + length > MAX_SECONDS {
                return Err(invalid("audioClipExtendsBeyondItsSourceOrThe"));
            }
            number(clip.get("gain"), 0.0, 4.0, "Clip volume")?;
            number(clip.get("fadeIn"), 0.0, length, "Fade in")?;
            number(clip.get("fadeOut"), 0.0, length, "Fade out")?;
        }
    }
    // `audibleClips`: no more than 32 sound at once.
    let truthy = |track: &Value, key: &str| track.get(key).is_some_and(Value::truthy);
    let solo = tracks.iter().any(|track| truthy(track, "solo"));
    let mut boundaries: Vec<(f64, i64)> = Vec::new();
    for track in tracks.iter().filter(|t| !truthy(t, "mute") && (!solo || truthy(t, "solo")) && finite(t.get("gain")).is_some_and(|g| g > 0.0)) {
        for clip in track.get("clips").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            if finite(clip.get("gain")).is_some_and(|g| g > 0.0) {
                let start = finite(clip.get("start")).unwrap_or(0.0);
                boundaries.push((start, 1));
                boundaries.push((start + finite(clip.get("duration")).unwrap_or(0.0), -1));
            }
        }
    }
    boundaries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    let mut voices = 0;
    for (_, delta) in boundaries {
        voices += delta;
        if voices > MAX_VOICES {
            return Err(invalid("upTo32AudioClipsCanSoundAt"));
        }
    }
    Ok(())
}

/// `EMPTY_AUDIO`.
fn empty_audio() -> Value {
    let mut state = Obj::new();
    state.set("version", Value::Num(1.0));
    state.set("assets", Value::object(Obj::new()));
    state.set("tracks", Value::array(Vec::new()));
    Value::object(state)
}

/// A copy of `object` with `key` set (`{...object, key: value}`).
fn with(object: &Value, key: &str, value: Value) -> Value {
    let mut copy = object.as_obj().cloned().unwrap_or_default();
    copy.set(key, value);
    Value::object(copy)
}

fn tracks_of(state: &Value) -> Result<Vec<Value>, EditError> {
    state.get("tracks").and_then(Value::elements).map(|e| e.iter().collect()).ok_or_else(|| EditError::Unported("audio without a track list".into()))
}

fn clips_of(track: &Value) -> Result<Vec<Value>, EditError> {
    track.get("clips").and_then(Value::elements).map(|e| e.iter().collect()).ok_or_else(|| EditError::Unported("an audio track without a clip list".into()))
}

/// `{...state, tracks, assets}` with only the recordings the tracks still use.
fn keep_used(state: &Value, tracks: Vec<Value>) -> Value {
    let used: std::collections::HashSet<String> =
        tracks.iter().flat_map(|t| t.get("clips").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default()).filter_map(|c| c.get("assetId").and_then(Value::as_str).map(str::to_string)).collect();
    let mut assets = Obj::new();
    for (key, asset) in state.get("assets").and_then(Value::as_obj).map(|a| a.iter().collect::<Vec<_>>()).unwrap_or_default() {
        if used.contains(&**key) {
            assets.set(key, asset.clone());
        }
    }
    let next = with(state, "tracks", Value::array(tracks));
    with(&next, "assets", Value::object(assets))
}

impl Editor {
    /// `audioState(report)` and whether the document has audio (`hasOwn(_styk, 'audio')`).
    fn audio_state(&self) -> Result<(Value, bool), EditError> {
        let metadata = self.report.get("_styk").and_then(Value::as_obj).ok_or_else(|| EditError::Unported("audio in a document without metadata".into()))?;
        let present = metadata.contains("audio");
        Ok((metadata.get("audio").filter(|a| !a.is_null()).cloned().unwrap_or_else(empty_audio), present))
    }

    /// `publish(editor, next, label)`.
    fn publish_audio(&mut self, next: Value, label: &str) -> Result<bool, EditError> {
        let (before, before_present) = self.audio_state()?;
        validate_state(&next)?;
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if let Some(metadata) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
            metadata.set("audio", next.clone());
        }
        let selection = self.selection_state();
        self.record(Command { kind: CommandKind::Audio { before, after: next, before_present }, label: label.into(), before_selection: selection.clone(), after_selection: selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("audio", Value::Bool(true))]);
        Ok(true)
    }

    /// `applyAudioCommand(editor, command, direction)`: the audio as it was, the
    /// selection as it is.
    pub(crate) fn apply_audio_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::Audio { before, after, before_present } = &command.kind else { return Ok(()) };
        if let Some(metadata) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
            if direction == Direction::Before && !before_present {
                metadata.remove("audio");
            } else {
                metadata.set("audio", if direction == Direction::Before { before.clone() } else { after.clone() });
            }
        }
        self.revision = if direction == Direction::Before { command.before_revision } else { command.after_revision };
        self.emit("history", vec![("label", Value::str(&command.label)), ("audio", Value::Bool(true))]);
        Ok(())
    }

    /// `setAudioTrack(id, patch)`: name, volume, mute or solo.
    pub(crate) fn set_audio_track(&mut self, id: &Value, patch: &Value) -> Result<bool, EditError> {
        let patch = patch.as_obj().ok_or_else(|| EditError::Unported("an audio track change that is not an object".into()))?;
        if patch.keys().any(|key| !["name", "gain", "mute", "solo"].contains(&&**key)) {
            return Err(EditError::Invalid("errors.editorAudio.unsupportedAudioTrackProperty".into()));
        }
        let (state, _) = self.audio_state()?;
        let mut tracks = tracks_of(&state)?;
        let index = tracks.iter().position(|track| strict_eq(track.get("id"), Some(id))).ok_or_else(|| EditError::Invalid("errors.editorAudio.selectAnAudioTrack".into()))?;
        if patch.iter().all(|(key, value)| strict_eq(tracks[index].get(key), Some(value))) {
            return Ok(false);
        }
        let mut track = tracks[index].as_obj().cloned().unwrap_or_default();
        for (key, value) in patch.iter() {
            track.set(key, value.clone());
        }
        tracks[index] = Value::object(track);
        self.publish_audio(with(&state, "tracks", Value::array(tracks)), "Edit audio track")
    }

    /// `deleteAudioTrack(id)`: the track, and the recordings only it used.
    pub(crate) fn delete_audio_track(&mut self, id: &Value) -> Result<bool, EditError> {
        let (state, _) = self.audio_state()?;
        let tracks = tracks_of(&state)?;
        if !tracks.iter().any(|track| strict_eq(track.get("id"), Some(id))) {
            return Ok(false);
        }
        let kept = tracks.into_iter().filter(|track| !strict_eq(track.get("id"), Some(id))).collect();
        self.publish_audio(keep_used(&state, kept), "Delete audio track")
    }

    /// `clipOwner(editor, id)`: the track holding the clip, and the clip.
    fn clip_owner(&self, state: &Value, id: &Value) -> Result<(Value, Value), EditError> {
        for track in tracks_of(state)? {
            if let Some(clip) = clips_of(&track)?.into_iter().find(|clip| strict_eq(clip.get("id"), Some(id))) {
                return Ok((track, clip));
            }
        }
        Err(EditError::Invalid("errors.editorAudio.selectAnAudioClip".into()))
    }

    /// `setAudioClip(id, patch, targetTrackId)`: timing, volume and fades, and the track
    /// it is on. The clip changed goes last on its track.
    pub(crate) fn set_audio_clip(&mut self, id: &Value, patch: &Value, target: &Value) -> Result<bool, EditError> {
        let patch = patch.as_obj().ok_or_else(|| EditError::Unported("an audio clip change that is not an object".into()))?;
        if patch.keys().any(|key| !["start", "offset", "duration", "gain", "fadeIn", "fadeOut"].contains(&&**key)) {
            return Err(EditError::Invalid("errors.editorAudio.unsupportedAudioClipProperty".into()));
        }
        if patch.values().iter().any(|value| finite(Some(value)).is_none()) {
            return Err(EditError::Invalid("errors.editorAudio.audioClipPropertiesMustBeFiniteNumbers".into()));
        }
        let (state, _) = self.audio_state()?;
        let (track, clip) = self.clip_owner(&state, id)?;
        let owner = track.get("id").cloned();
        let target = if target.is_null() { owner.clone() } else { Some(target.clone()) };
        let tracks = tracks_of(&state)?;
        if !tracks.iter().any(|row| strict_eq(row.get("id"), target.as_ref())) {
            return Err(EditError::Invalid("errors.editorAudio.selectADestinationAudioTrack".into()));
        }
        let mut next = clip.as_obj().cloned().unwrap_or_default();
        for (key, value) in patch.iter() {
            next.set(key, value.clone());
        }
        // `Math.min(fade, duration)`.
        let field = |next: &Obj, key: &str| match next.get(key) {
            Some(Value::Num(n)) => Ok(*n),
            None => Ok(f64::NAN),
            Some(_) => Err(EditError::Unported(format!("an audio clip whose {key} is not a number"))),
        };
        let duration = field(&next, "duration")?;
        for key in ["fadeIn", "fadeOut"] {
            let fade = field(&next, key)?;
            next.set(key, Value::Num(if fade.is_nan() || duration.is_nan() { f64::NAN } else { fade.min(duration) }));
        }
        let same_track = strict_eq(target.as_ref(), owner.as_ref());
        if same_track && next.iter().all(|(key, value)| strict_eq(Some(value), clip.get(key))) {
            return Ok(false);
        }
        let next = Value::object(next);
        let without = |row: &Value| -> Result<Vec<Value>, EditError> { Ok(clips_of(row)?.into_iter().filter(|c| !strict_eq(c.get("id"), Some(id))).collect()) };
        let mut rows = Vec::with_capacity(tracks.len());
        for row in tracks {
            rows.push(if strict_eq(row.get("id"), target.as_ref()) {
                let mut clips = without(&row)?;
                clips.push(next.clone());
                with(&row, "clips", Value::array(clips))
            } else if strict_eq(row.get("id"), owner.as_ref()) {
                with(&row, "clips", Value::array(without(&row)?))
            } else {
                row
            });
        }
        self.publish_audio(with(&state, "tracks", Value::array(rows)), "Edit audio clip")
    }

    /// `deleteAudioClip(id)`: the clip, and its recording when nothing else uses it.
    pub(crate) fn delete_audio_clip(&mut self, id: &Value) -> Result<bool, EditError> {
        let (state, _) = self.audio_state()?;
        let (track, _) = self.clip_owner(&state, id)?;
        let owner = track.get("id").cloned();
        let mut rows = Vec::new();
        for row in tracks_of(&state)? {
            rows.push(if strict_eq(row.get("id"), owner.as_ref()) {
                let clips = clips_of(&row)?.into_iter().filter(|c| !strict_eq(c.get("id"), Some(id))).collect();
                with(&row, "clips", Value::array(clips))
            } else {
                row
            });
        }
        self.publish_audio(keep_used(&state, rows), "Delete audio clip")
    }
}

/// `slice(0, max)` by UTF-16 units, as a string method does (a pair split in two is dropped by the encoding).
fn slice_utf16(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

/// A recording's name as the track made from it is named: without its extension, at most 120 units.
fn track_name(asset: &Value) -> String {
    let name = asset.get("name").and_then(Value::as_str).unwrap_or("");
    let stem = match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => &name[..dot],
        _ => name,
    };
    slice_utf16(stem, 120)
}

/// `Math.min`: NaN when either is.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// `Math.max`: NaN when either is.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn num_of(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

impl Editor {
    /// `freshAudioId(prefix)`.
    fn fresh_audio_id(&mut self, prefix: &str) -> Result<String, EditError> {
        Ok(format!("{prefix}-{}", self.draw_uuid()?))
    }

    /// `audioFps(report)`.
    fn audio_fps(&self) -> f64 {
        match self.report.get("frame_delay_ms").and_then(Value::as_f64).filter(|delay| *delay != 0.0) {
            Some(delay) => 1000.0 / delay,
            None => self.report.get("fps").and_then(Value::as_f64).unwrap_or(f64::NAN),
        }
    }

    /// A track of no clips (`{id, name, gain: 1, mute: false, solo: false, clips: []}`).
    fn empty_audio_track(&mut self, name: Value) -> Result<Value, EditError> {
        let mut track = Obj::new();
        track.set("id", Value::str(&self.fresh_audio_id("audio")?));
        track.set("name", name);
        track.set("gain", Value::Num(1.0));
        track.set("mute", Value::Bool(false));
        track.set("solo", Value::Bool(false));
        track.set("clips", Value::array(Vec::new()));
        Ok(Value::object(track))
    }

    /// `modifyTrack(editor, id, operation, label)`: one track replaced, nothing when it comes out the same.
    fn modify_audio_track(&mut self, id: &Value, label: &str, operation: impl FnOnce(&Value) -> Result<Value, EditError>) -> Result<bool, EditError> {
        let (state, _) = self.audio_state()?;
        let mut tracks = tracks_of(&state)?;
        let index = tracks.iter().position(|track| strict_eq(track.get("id"), Some(id))).ok_or_else(|| EditError::Invalid("errors.editorAudio.selectAnAudioTrack".into()))?;
        let next = operation(&tracks[index])?;
        if next.same_node(&tracks[index]) {
            return Ok(false);
        }
        tracks[index] = next;
        self.publish_audio(with(&state, "tracks", Value::array(tracks)), label)
    }

    /// `addAudioTrack(name = 'Audio')`: answers the new track's identity.
    pub(crate) fn add_audio_track(&mut self, name: Option<&Value>) -> Result<Value, EditError> {
        let (state, _) = self.audio_state()?;
        let track = self.empty_audio_track(name.filter(|name| !name.is_null()).cloned().unwrap_or_else(|| Value::str("Audio")))?;
        let id = track.get("id").cloned().unwrap_or(Value::Null);
        let mut tracks = tracks_of(&state)?;
        tracks.push(track);
        self.publish_audio(with(&state, "tracks", Value::array(tracks)), "Add audio track")?;
        Ok(id)
    }

    /// `importAudio(asset, {trackId, start})`: a clip of the whole recording on the track (a new one
    /// named after the recording when there is none), at `start` seconds (the playhead). Answers the clip's identity.
    pub(crate) fn import_audio(&mut self, asset: &Value, options: Option<&Value>) -> Result<Value, EditError> {
        validate_asset(asset)?;
        let (state, _) = self.audio_state()?;
        let mut tracks = tracks_of(&state)?;
        let wanted = options.and_then(|options| options.get("trackId"));
        let mut index = tracks.iter().position(|track| wanted.is_some_and(|id| strict_eq(track.get("id"), Some(id))));
        if index.is_none() {
            let track = self.empty_audio_track(Value::str(&track_name(asset)))?;
            tracks.push(track);
            index = Some(tracks.len() - 1);
        }
        let index = index.unwrap_or(0);
        let start = match options.and_then(|options| options.get("start")).filter(|start| !start.is_null()) {
            Some(start) => start.clone(),
            None => Value::Num(self.tick / self.audio_fps()),
        };
        let mut clip = Obj::new();
        let id = self.fresh_audio_id("clip")?;
        clip.set("id", Value::str(&id));
        clip.set("assetId", asset.get("id").cloned().unwrap_or(Value::Null));
        clip.set("start", start);
        clip.set("offset", Value::Num(0.0));
        clip.set("duration", asset.get("duration").cloned().unwrap_or(Value::Null));
        clip.set("gain", Value::Num(1.0));
        clip.set("fadeIn", Value::Num(0.0));
        clip.set("fadeOut", Value::Num(0.0));
        let mut clips = clips_of(&tracks[index])?;
        clips.push(Value::object(clip));
        tracks[index] = with(&tracks[index], "clips", Value::array(clips));
        let mut assets = state.get("assets").and_then(Value::as_obj).cloned().unwrap_or_default();
        assets.set(asset.get("id").and_then(Value::as_str).unwrap_or(""), asset.clone());
        let next = with(&with(&state, "assets", Value::object(assets)), "tracks", Value::array(tracks));
        self.publish_audio(next, "Import audio")?;
        Ok(Value::str(&id))
    }

    /// `splitAudioClip(id, time)`: the clip cut in two at `time` seconds (the playhead). Answers the right part's identity.
    pub(crate) fn split_audio_clip(&mut self, id: &Value, time: Option<&Value>) -> Result<Value, EditError> {
        let (state, _) = self.audio_state()?;
        let (track, clip) = self.clip_owner(&state, id)?;
        let time = match time.filter(|time| !time.is_null()) {
            Some(time) => time.as_f64().unwrap_or(f64::NAN),
            None => self.tick / self.audio_fps(),
        };
        let cut = time - num_of(&clip, "start");
        let duration = num_of(&clip, "duration");
        if cut < 1.0 / RATE || duration - cut < 1.0 / RATE {
            return Err(EditError::Invalid("errors.editorAudio.placeThePlayheadInsideTheAudioClipTo".into()));
        }
        let right_id = self.fresh_audio_id("clip")?;
        let mut right = clip.as_obj().cloned().unwrap_or_default();
        right.set("id", Value::str(&right_id));
        right.set("start", Value::Num(time));
        right.set("offset", Value::Num(num_of(&clip, "offset") + cut));
        right.set("duration", Value::Num(duration - cut));
        right.set("fadeIn", Value::Num(0.0));
        right.set("fadeOut", Value::Num(js_min(num_of(&clip, "fadeOut"), duration - cut)));
        let right = Value::object(right);
        let mut left = clip.as_obj().cloned().unwrap_or_default();
        left.set("duration", Value::Num(cut));
        left.set("fadeIn", Value::Num(js_min(num_of(&clip, "fadeIn"), cut)));
        left.set("fadeOut", Value::Num(0.0));
        let left = Value::object(left);
        let owner = track.get("id").cloned().unwrap_or(Value::Null);
        self.modify_audio_track(&owner, "Split audio clip", |row| {
            let mut clips = Vec::new();
            for item in clips_of(row)? {
                if strict_eq(item.get("id"), Some(id)) {
                    clips.push(left.clone());
                    clips.push(right.clone());
                } else {
                    clips.push(item);
                }
            }
            Ok(with(row, "clips", Value::array(clips)))
        })?;
        Ok(Value::str(&right_id))
    }

    /// `duplicateAudioClip(id)`: a copy of the clip right after it. Answers the copy's identity.
    pub(crate) fn duplicate_audio_clip(&mut self, id: &Value) -> Result<Value, EditError> {
        let (state, _) = self.audio_state()?;
        let (track, clip) = self.clip_owner(&state, id)?;
        let copy_id = self.fresh_audio_id("clip")?;
        let mut copy = clip.as_obj().cloned().unwrap_or_default();
        copy.set("id", Value::str(&copy_id));
        copy.set("start", Value::Num(num_of(&clip, "start") + num_of(&clip, "duration")));
        let copy = Value::object(copy);
        let owner = track.get("id").cloned().unwrap_or(Value::Null);
        self.modify_audio_track(&owner, "Duplicate audio clip", |row| {
            let mut clips = clips_of(row)?;
            clips.push(copy.clone());
            Ok(with(row, "clips", Value::array(clips)))
        })?;
        Ok(Value::str(&copy_id))
    }

    /// `copyAudioClip(id)`: the clip and its recording, for `pasteAudioClip`.
    pub(crate) fn copy_audio_clip(&mut self, id: &Value) -> Result<bool, EditError> {
        let (state, _) = self.audio_state()?;
        let (_, clip) = self.clip_owner(&state, id)?;
        let asset = clip.get("assetId").and_then(Value::as_str).and_then(|asset| state.path(&["assets", asset])).cloned().unwrap_or(Value::Null);
        self.audio_clipboard = Some((clip, asset));
        Ok(true)
    }

    /// `cutAudioClip(id)`.
    pub(crate) fn cut_audio_clip(&mut self, id: &Value) -> Result<bool, EditError> {
        self.copy_audio_clip(id)?;
        self.delete_audio_clip(id)
    }

    /// `pasteAudioClip(trackId, start)`: the copied clip on the track (a new one when there is none) at `start`
    /// seconds (the playhead). Answers the new clip's identity, `false` with nothing copied.
    pub(crate) fn paste_audio_clip(&mut self, track_id: &Value, start: Option<&Value>) -> Result<Value, EditError> {
        let Some((saved_clip, saved_asset)) = self.audio_clipboard.clone() else { return Ok(Value::Bool(false)) };
        let (state, _) = self.audio_state()?;
        let mut tracks = tracks_of(&state)?;
        let mut asset = saved_asset;
        let mut index = tracks.iter().position(|track| strict_eq(track.get("id"), Some(track_id)));
        let asset_id = asset.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let held = state.path(&["assets", &asset_id]).cloned();
        if held.as_ref().is_some_and(|held| held.truthy() && !held.same_node(&asset)) {
            asset = with(&asset, "id", Value::str(&self.fresh_audio_id("sound")?));
        }
        if index.is_none() {
            let track = self.empty_audio_track(Value::str("Audio"))?;
            tracks.push(track);
            index = Some(tracks.len() - 1);
        }
        let index = index.unwrap_or(0);
        let start = match start.filter(|start| !start.is_null()) {
            Some(start) => start.clone(),
            None => Value::Num(self.tick / self.audio_fps()),
        };
        let clip_id = self.fresh_audio_id("clip")?;
        let mut clip = saved_clip.as_obj().cloned().unwrap_or_default();
        clip.set("id", Value::str(&clip_id));
        clip.set("assetId", asset.get("id").cloned().unwrap_or(Value::Null));
        clip.set("start", start);
        let mut clips = clips_of(&tracks[index])?;
        clips.push(Value::object(clip));
        tracks[index] = with(&tracks[index], "clips", Value::array(clips));
        let id = asset.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let same = state.path(&["assets", &id]).is_some_and(|held| held.same_node(&asset));
        let assets = if same {
            state.get("assets").cloned().unwrap_or(Value::Null)
        } else {
            let mut assets = state.get("assets").and_then(Value::as_obj).cloned().unwrap_or_default();
            assets.set(&id, asset);
            Value::object(assets)
        };
        let next = with(&with(&state, "assets", assets), "tracks", Value::array(tracks));
        self.publish_audio(next, "Paste audio clip")?;
        Ok(Value::str(&clip_id))
    }

    /// `rippleAudio(startTick, removedTicks, insertedTicks)`: clips after a frame edit move with it,
    /// those it cuts through are cut.
    pub(crate) fn ripple_audio(&mut self, start: f64, removed: f64, inserted: f64) -> Result<bool, EditError> {
        let (state, _) = self.audio_state()?;
        let tracks = tracks_of(&state)?;
        if tracks.is_empty() {
            return Ok(false);
        }
        let fps = self.audio_fps();
        let (start, removed, inserted) = (start / fps, removed / fps, inserted / fps);
        let (end, delta) = (start + removed, inserted - removed);
        let mut rows = Vec::with_capacity(tracks.len());
        for track in &tracks {
            let mut clips = Vec::new();
            for clip in clips_of(track)? {
                let (clip_start, duration) = (num_of(&clip, "start"), num_of(&clip, "duration"));
                let finish = clip_start + duration;
                if finish <= start {
                    clips.push(clip);
                } else if clip_start >= end {
                    clips.push(with(&clip, "start", Value::Num(clip_start + delta)));
                } else {
                    let mut parts = 0;
                    if clip_start < start {
                        let mut part = clip.as_obj().cloned().unwrap_or_default();
                        part.set("duration", Value::Num(start - clip_start));
                        part.set("fadeIn", Value::Num(js_min(num_of(&clip, "fadeIn"), start - clip_start)));
                        part.set("fadeOut", Value::Num(0.0));
                        clips.push(Value::object(part));
                        parts += 1;
                    }
                    if finish > end {
                        let cut = js_max(0.0, end - clip_start);
                        let remaining = duration - cut;
                        let mut part = clip.as_obj().cloned().unwrap_or_default();
                        if parts > 0 {
                            part.set("id", Value::str(&self.fresh_audio_id("clip")?));
                        }
                        part.set("start", Value::Num(js_max(end, clip_start) + delta));
                        part.set("offset", Value::Num(num_of(&clip, "offset") + cut));
                        part.set("duration", Value::Num(remaining));
                        part.set("fadeIn", Value::Num(0.0));
                        part.set("fadeOut", Value::Num(js_min(num_of(&clip, "fadeOut"), remaining)));
                        clips.push(Value::object(part));
                    }
                }
            }
            rows.push(with(track, "clips", Value::array(clips)));
        }
        self.publish_audio(with(&state, "tracks", Value::array(rows)), "Ripple audio")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

    fn editor() -> Editor {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/audio.document.json");
        let mut editor = Editor::new(parse(&std::fs::read_to_string(file).unwrap()), crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
        editor.set_view(0.0, 0, crate::Selection::default());
        editor
    }

    fn draws(editor: &mut Editor, ids: &[&str]) {
        let pairs: Vec<Value> = ids.iter().map(|id| Value::array(vec![Value::str("uuid"), Value::str(id)])).collect();
        editor.set_draws(&Value::array(pairs));
    }

    fn call(editor: &mut Editor, method: &str, args: &[Value]) -> Value {
        editor.call(method, args).unwrap_or_else(|error| panic!("{method}: {error:?}"))
    }

    fn state(editor: &Editor) -> Value { editor.report.path(&["_styk", "audio"]).cloned().unwrap() }

    fn track(editor: &Editor, id: &str) -> Value {
        state(editor).get("tracks").and_then(Value::elements).unwrap().iter().find(|track| track.get("id").and_then(Value::as_str) == Some(id)).unwrap()
    }

    fn clip(editor: &Editor, id: &str) -> Option<Value> {
        state(editor).get("tracks").and_then(Value::elements).unwrap().iter().flat_map(|track| track.get("clips").and_then(Value::elements).unwrap().iter().collect::<Vec<_>>()).find(|clip| clip.get("id").and_then(Value::as_str) == Some(id))
    }

    fn number(value: &Value, key: &str) -> f64 { value.get(key).and_then(Value::as_f64).unwrap() }

    #[test]
    fn a_track_added_takes_its_identity_from_the_draws_and_undo_removes_it() {
        let mut editor = editor();
        draws(&mut editor, &["one"]);
        assert_eq!(call(&mut editor, "addAudioTrack", &[Value::str("Foley")]), Value::str("audio-one"));
        let added = track(&editor, "audio-one");
        assert_eq!(styk_doc::json::to_string(&added), r#"{"id":"audio-one","name":"Foley","gain":1,"mute":false,"solo":false,"clips":[]}"#);
        assert_eq!(editor.state().undo_label, "Add audio track");
        call(&mut editor, "undo", &[]);
        assert_eq!(state(&editor).get("tracks").and_then(Value::array_len), Some(3));
        // Nothing drawn: the call is not the engine's to make up an identity for.
        editor.set_draws(&Value::array(Vec::new()));
        assert!(matches!(editor.call("addAudioTrack", &[]), Err(EditError::Unported(_))));
        draws(&mut editor, &["two"]);
        call(&mut editor, "addAudioTrack", &[]);
        assert_eq!(track(&editor, "audio-two").get("name").and_then(Value::as_str), Some("Audio"));
    }

    #[test]
    fn importing_puts_a_clip_of_the_whole_recording_at_the_playhead_on_a_track_named_after_it() {
        let mut editor = editor();
        let mut asset = state(&editor).path(&["assets", "sound-a"]).cloned().unwrap().as_obj().cloned().unwrap();
        asset.set("id", Value::str("sound-new"));
        asset.set("name", Value::str("Voice take.final.wav"));
        let asset = Value::object(asset);
        call(&mut editor, "seek", &[Value::Num(6.0)]);
        draws(&mut editor, &["t", "c"]);
        assert_eq!(call(&mut editor, "importAudio", &[asset.clone()]), Value::str("clip-c"));
        let made = track(&editor, "audio-t");
        assert_eq!(made.get("name").and_then(Value::as_str), Some("Voice take.final"));
        let clip = clip(&editor, "clip-c").unwrap();
        assert_eq!(styk_doc::json::to_string(&clip), r#"{"id":"clip-c","assetId":"sound-new","start":0.25,"offset":0,"duration":2,"gain":1,"fadeIn":0,"fadeOut":0}"#);
        assert!(state(&editor).path(&["assets", "sound-new"]).is_some());
        // Onto a track that is there, at a time.
        draws(&mut editor, &["d"]);
        let mut options = Obj::new();
        options.set("trackId", Value::str("audio-b"));
        options.set("start", Value::Num(3.0));
        assert_eq!(call(&mut editor, "importAudio", &[asset, Value::object(options)]), Value::str("clip-d"));
        assert_eq!(track(&editor, "audio-b").get("clips").and_then(Value::array_len), Some(2));
        assert_eq!(number(&clip_of(&editor, "clip-d"), "start"), 3.0);
        call(&mut editor, "undo", &[]);
        assert!(editor.report.path(&["_styk", "audio", "assets", "sound-new"]).is_some(), "the first import is still there");
        call(&mut editor, "undo", &[]);
        assert!(editor.report.path(&["_styk", "audio", "assets", "sound-new"]).is_none());
    }

    fn clip_of(editor: &Editor, id: &str) -> Value { clip(editor, id).unwrap() }

    #[test]
    fn splitting_cuts_a_clip_in_two_and_keeps_the_fades_on_their_ends() {
        let mut editor = editor();
        draws(&mut editor, &["right"]);
        assert_eq!(call(&mut editor, "splitAudioClip", &[Value::str("clip-1"), Value::Num(0.4)]), Value::str("clip-right"));
        let (left, right) = (clip_of(&editor, "clip-1"), clip_of(&editor, "clip-right"));
        assert_eq!((number(&left, "duration"), number(&left, "fadeOut"), number(&left, "start")), (0.4, 0.0, 0.0));
        assert_eq!((number(&right, "start"), number(&right, "offset"), number(&right, "duration"), number(&right, "fadeIn"), number(&right, "fadeOut")), (0.4, 0.4, 0.6, 0.0, 0.25));
        assert_eq!(editor.state().undo_label, "Split audio clip");
        // Outside the clip there is nothing to cut.
        draws(&mut editor, &["x"]);
        for time in [0.0, 1.0, 5.0] {
            assert!(matches!(editor.call("splitAudioClip", &[Value::str("clip-2"), Value::Num(time)]), Err(EditError::Invalid(key)) if key == "errors.editorAudio.placeThePlayheadInsideTheAudioClipTo"), "{time}");
        }
        assert!(matches!(editor.call("splitAudioClip", &[Value::str("nope")]), Err(EditError::Invalid(key)) if key == "errors.editorAudio.selectAnAudioClip"));
    }

    #[test]
    fn duplicating_puts_a_copy_right_after_the_clip() {
        let mut editor = editor();
        draws(&mut editor, &["copy"]);
        assert_eq!(call(&mut editor, "duplicateAudioClip", &[Value::str("clip-1")]), Value::str("clip-copy"));
        let copy = clip_of(&editor, "clip-copy");
        assert_eq!((number(&copy, "start"), number(&copy, "duration"), number(&copy, "fadeOut")), (1.0, 1.0, 0.25));
        assert_eq!(editor.state().undo_label, "Duplicate audio clip");
    }

    #[test]
    fn copy_cut_and_paste_carry_the_clip_and_its_recording() {
        let mut editor = editor();
        assert_eq!(call(&mut editor, "pasteAudioClip", &[Value::str("audio-a")]), Value::Bool(false), "nothing copied");
        assert_eq!(call(&mut editor, "copyAudioClip", &[Value::str("clip-3")]), Value::Bool(true));
        draws(&mut editor, &["pasted"]);
        call(&mut editor, "seek", &[Value::Num(6.0)]);
        assert_eq!(call(&mut editor, "pasteAudioClip", &[Value::str("audio-a")]), Value::str("clip-pasted"));
        let pasted = clip_of(&editor, "clip-pasted");
        assert_eq!((number(&pasted, "start"), pasted.get("assetId").and_then(Value::as_str)), (0.25, Some("sound-b")));
        assert_eq!(editor.state().undo_label, "Paste audio clip");
        // Cutting takes the clip out; pasting it on a track that is not there makes the track.
        assert_eq!(call(&mut editor, "cutAudioClip", &[Value::str("clip-pasted")]), Value::Bool(true));
        assert!(clip(&editor, "clip-pasted").is_none());
        assert_eq!(editor.state().undo_label, "Delete audio clip");
        draws(&mut editor, &["x", "b"]);
        assert_eq!(call(&mut editor, "pasteAudioClip", &[Value::str("missing"), Value::Num(7.0)]), Value::str("clip-b"));
        let made = track(&editor, "audio-x");
        assert_eq!(made.get("name").and_then(Value::as_str), Some("Audio"));
        assert_eq!(number(&clip_of(&editor, "clip-b"), "start"), 7.0);
        assert_eq!(state(&editor).get("tracks").and_then(Value::array_len), Some(4));
    }

    #[test]
    fn a_pasted_recording_that_differs_from_the_project_s_own_gets_a_new_identity() {
        let mut editor = editor();
        call(&mut editor, "copyAudioClip", &[Value::str("clip-3")]);
        // The project's recording of that name is changed by an edit meanwhile: the copy is another recording.
        let mut other = state(&editor).path(&["assets", "sound-b"]).cloned().unwrap().as_obj().cloned().unwrap();
        other.set("duration", Value::Num(1.6));
        let mut assets = state(&editor).get("assets").and_then(Value::as_obj).cloned().unwrap();
        assets.set("sound-b", Value::object(other));
        let next = with(&state(&editor), "assets", Value::object(assets));
        editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("audio", next);
        draws(&mut editor, &["fresh", "clip"]);
        assert_eq!(call(&mut editor, "pasteAudioClip", &[Value::str("audio-a"), Value::Num(3.0)]), Value::str("clip-clip"));
        assert_eq!(clip_of(&editor, "clip-clip").get("assetId").and_then(Value::as_str), Some("sound-fresh"));
        assert!(state(&editor).path(&["assets", "sound-fresh"]).is_some());
    }

    #[test]
    fn a_ripple_moves_what_follows_and_cuts_through_what_it_crosses() {
        let mut editor = editor();
        // Six frames removed at frame 6 (24 fps): the quarter second from 0.25 s to 0.5 s. clip-1 (0 to 1 s)
        // loses it, clip-2 (2 to 3 s) moves up by a quarter second.
        // (The crowd track's clips are cut too, and each part that is new takes an identity.)
        let ids: Vec<String> = std::iter::once("rest".to_string()).chain((0..100).map(|n| format!("r{n}"))).collect();
        draws(&mut editor, &ids.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(call(&mut editor, "rippleAudio", &[Value::Num(6.0), Value::Num(6.0), Value::Num(0.0)]), Value::Bool(true));
        let (first, rest, second) = (clip_of(&editor, "clip-1"), clip_of(&editor, "clip-rest"), clip_of(&editor, "clip-2"));
        assert_eq!((number(&first, "start"), number(&first, "duration"), number(&first, "fadeOut")), (0.0, 0.25, 0.0));
        assert_eq!((number(&rest, "start"), number(&rest, "offset"), number(&rest, "duration"), number(&rest, "fadeIn"), number(&rest, "fadeOut")), (0.25, 0.5, 0.5, 0.0, 0.25));
        assert_eq!(number(&second, "start"), 1.75);
        assert_eq!(editor.state().undo_label, "Ripple audio");
        // Inserting frames moves everything after them.
        assert_eq!(call(&mut editor, "rippleAudio", &[Value::Num(0.0), Value::Num(0.0), Value::Num(24.0)]), Value::Bool(true));
        assert_eq!(number(&clip_of(&editor, "clip-2"), "start"), 2.75);
    }

    #[test]
    fn frame_edits_of_every_layer_move_the_audio_when_asked_to_and_undo_as_one() {
        let mut editor = editor();
        let order = editor.report.path(&["_styk", "layers", "order"]).cloned().unwrap();
        let mut layers = vec![Value::str("scene"), Value::str("camera")];
        layers.extend(order.elements().unwrap().iter());
        let layers = Value::array(layers);
        let frames = editor.report.path(&["_styk", "layerSheet", "duration"]).and_then(Value::as_f64).unwrap();
        call(&mut editor, "sheetInsertFrames", &[layers.clone(), Value::Num(6.0), Value::Num(6.0)]);
        assert_eq!(number(&clip_of(&editor, "clip-2"), "start"), 2.0, "off: the audio stays");
        call(&mut editor, "undo", &[]);
        editor.audio_ripple = true;
        let ids: Vec<String> = (0..100).map(|n| format!("r{n}")).collect();
        draws(&mut editor, &ids.iter().map(String::as_str).collect::<Vec<_>>());
        call(&mut editor, "sheetInsertFrames", &[layers.clone(), Value::Num(6.0), Value::Num(6.0)]);
        assert_eq!(number(&clip_of(&editor, "clip-2"), "start"), 2.25);
        assert_eq!(editor.state().undo_label, "Insert scene frames with audio");
        call(&mut editor, "undo", &[]);
        assert_eq!(number(&clip_of(&editor, "clip-2"), "start"), 2.0, "one undo takes both back");
        assert_eq!(editor.report.path(&["_styk", "layerSheet", "duration"]).and_then(Value::as_f64), Some(frames));
        assert!(!editor.state().can_undo);
        // Not every layer: the audio stays.
        call(&mut editor, "sheetInsertFrames", &[Value::array(vec![Value::str("scene")]), Value::Num(6.0), Value::Num(6.0)]);
        assert_eq!(number(&clip_of(&editor, "clip-2"), "start"), 2.0);
    }
}
