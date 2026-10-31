//! Onion skins (docs/onion-skin.md): the poses around the frame on show that the stage draws faintly behind it, which
//! of them, and how.
//!
//! Which poses is the editor's settings applied to the document: the frames either side of the playhead (a pose of the
//! timeline's rows, or every tick), or on a layer sheet the neighbouring keys of each layer by itself. Each is the document
//! evaluated at its tick, so a ghost shows the committed pose, never the draft of a gesture in progress. Which figures of it
//! are drawn is the scope (the selected ones, which the request names, with the figures joined to them), the figures the interface hides and the layers
//! that are hidden, or of another kind than the layer the ghost samples. Opacity and tint are the settings'.
//!
//! The answer is one set of ghosts for the document, the playhead and the request (settings, hidden and selected figures) it was
//! asked for, kept until one of them changes; the evaluated poses are kept longer, for as long as the document is the same.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use styk_doc::Value;

use crate::record::{join_target, num, uid};
use crate::timeline::{rows, total_ticks};
use crate::{EditError, Editor};

/// Ghosts drawn at most, the nearest ones.
pub const MAX_GHOSTS: usize = 48;

/// One onion skin: the document evaluated at `tick`, and how it is drawn.
#[derive(Clone, Debug)]
pub struct Ghost {
    pub tick: f64,
    /// The evaluated frame (`evaluatedFrame`).
    pub record: Value,
    pub opacity: f64,
    pub tint: Option<[u8; 3]>,
    pub show_on_top: bool,
    /// Slots of the frame that are not drawn.
    pub hidden: Vec<u32>,
}

/// The onion skins of a frame, far to near.
#[derive(Debug, Default)]
pub struct OnionSet {
    pub ghosts: Vec<Ghost>,
}

/// What the skins were last made for, and the poses evaluated since the document was last changed.
#[derive(Default)]
pub(crate) struct Cache {
    key: Option<(Value, String, u64, usize)>,
    set: Option<Arc<OnionSet>>,
    /// The document the evaluated poses belong to, and a pose per tick (least recently used first).
    base: Option<Value>,
    frames: Vec<(u64, Value)>,
}

/// The settings of a request (`normalizeEditorSettings`' onion fields, and the figures the interface hides).
pub(crate) struct Settings {
    frames: bool,
    before: f64,
    after: f64,
    step: f64,
    range_before: Option<f64>,
    range_after: Option<f64>,
    selected_only: bool,
    joined: bool,
    opacity: f64,
    fade: bool,
    before_color: Option<[u8; 3]>,
    after_color: Option<[u8; 3]>,
    on_top: bool,
    hidden: HashSet<u32>,
    /// The figures selected (the interface's selection), for the scope of the selected ones.
    selected: Vec<u32>,
}

fn color(text: Option<&str>) -> Option<[u8; 3]> {
    let text = text?.strip_prefix('#')?;
    let channel = |at: usize| u8::from_str_radix(text.get(at..at + 2)?, 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

impl Settings {
    pub(crate) fn parse(request: &Value) -> Result<Settings, EditError> {
        let count = |key: &str| num(request, key).filter(|value| !value.is_nan()).map(|value| value.max(0.0).floor());
        let flag = |key: &str| request.get(key).is_some_and(Value::truthy);
        let tint = flag("onionTint");
        let colored = |key: &str| if tint { color(request.get(key).and_then(Value::as_str)) } else { None };
        Ok(Settings {
            frames: request.get("onionMode").and_then(Value::as_str) == Some("frames"),
            before: count("onionBefore").ok_or_else(|| EditError::Invalid("the onion skins need their counts".into()))?,
            after: count("onionAfter").ok_or_else(|| EditError::Invalid("the onion skins need their counts".into()))?,
            step: count("onionStep").unwrap_or(1.0).max(1.0),
            range_before: num(request, "onionRangeBefore").filter(|value| !value.is_nan()),
            range_after: num(request, "onionRangeAfter").filter(|value| !value.is_nan()),
            selected_only: request.get("onionScope").and_then(Value::as_str) == Some("selected"),
            joined: flag("onionJoined"),
            opacity: num(request, "onionOpacity").unwrap_or(0.14),
            fade: flag("onionFade"),
            before_color: colored("onionBeforeColor"),
            after_color: colored("onionAfterColor"),
            on_top: flag("onionShowOnTop"),
            hidden: request.get("hidden").and_then(Value::numbers).unwrap_or_default().into_iter().map(|uid| uid as u32).collect(),
            selected: request.get("selected").and_then(Value::numbers).unwrap_or_default().into_iter().map(|uid| uid as u32).collect(),
        })
    }
}

/// A frame to draw as a ghost: its tick, how far from the playhead it is (in samples), on which side and, for the neighbours
/// of one layer, which layer.
pub(crate) struct Candidate {
    pub(crate) tick: f64,
    pub(crate) distance: f64,
    pub(crate) direction: i32,
    pub(crate) layer: Option<String>,
}

/// `sheetKeyAt(track, tick)`'s index: the last key at or before `tick`, -1 before the first.
fn key_before(keys: &[Value], tick: f64) -> i64 {
    let at = keys.partition_point(|key| num(key, "tick").is_some_and(|at| at <= tick));
    at as i64 - 1
}

impl Editor {
    /// The layers of the document that draw (`layer.drawing`), and the ones that are visible, by id.
    fn layer_flags(&self) -> (HashSet<String>, HashSet<String>) {
        let mut drawing = HashSet::new();
        let mut hidden = HashSet::new();
        if let Some(by_id) = self.report.path(&["_styk", "layers", "byId"]).and_then(Value::as_obj) {
            for (id, layer) in by_id.iter() {
                if layer.get("drawing").is_some_and(Value::truthy) {
                    drawing.insert(id.to_string());
                }
                if matches!(layer.get("visible"), Some(Value::Bool(false))) {
                    hidden.insert(id.to_string());
                }
            }
        }
        (drawing, hidden)
    }

    /// The layers in stacking order with the keys of their exposure tracks: `(id, drawing, visible, end, keys)`.
    fn layer_tracks(&self) -> Vec<(String, bool, bool, f64, Vec<Value>)> {
        let Some(sheet) = self.report.path(&["_styk", "layerSheet"]) else { return Vec::new() };
        let order: Vec<String> = self.report.path(&["_styk", "layers", "order"]).and_then(Value::elements).into_iter().flat_map(|order| order.iter()).filter_map(|id| id.as_str().map(str::to_string)).collect();
        order
            .into_iter()
            .filter_map(|id| {
                let track = sheet.path(&["tracks", &id])?;
                let layer = self.report.path(&["_styk", "layers", "byId", &id])?;
                let keys: Vec<Value> = track.get("keys").and_then(Value::elements).map(|keys| keys.iter().collect()).unwrap_or_default();
                Some((id, layer.get("drawing").is_some_and(Value::truthy), layer.get("visible").is_some_and(Value::truthy), num(track, "end").unwrap_or(0.0), keys))
            })
            .collect()
    }

    /// `layerOnionSamples`: the neighbouring keys of each visible layer that is not a drawing, so that a layer is not
    /// short of its neighbours by the keys of the others.
    fn layer_candidates(&self, settings: &Settings) -> Vec<Candidate> {
        let mut out = Vec::new();
        if settings.frames {
            return out;
        }
        for (id, drawing, visible, _, keys) in self.layer_tracks() {
            if !visible || drawing {
                continue;
            }
            let found = key_before(&keys, self.tick);
            for direction in [-1i32, 1] {
                let span = if direction < 0 { settings.range_before } else { settings.range_after };
                let wanted = if span.is_none() { if direction < 0 { settings.before } else { settings.after } } else { f64::INFINITY };
                let started = found + if direction > 0 { 1 } else if found >= 0 && num(&keys[found as usize], "tick") == Some(self.tick) { -1 } else { 0 };
                let (mut index, mut distance, mut seen) = (started, 0.0, 0.0);
                while index >= 0 && (index as usize) < keys.len() && distance < wanted {
                    let key = &keys[index as usize];
                    let at = num(key, "tick").unwrap_or(f64::NAN);
                    index += direction as i64;
                    if span.is_some_and(|span| f64::from(direction) * (at - self.tick) > span) {
                        break;
                    }
                    if key.get("empty").is_some_and(Value::truthy) || matches!(key.path(&["value", "frameId"]), Some(Value::Null)) {
                        continue;
                    }
                    seen += 1.0;
                    if seen % settings.step != 0.0 {
                        continue;
                    }
                    distance += 1.0;
                    out.push(Candidate { tick: at, distance, direction, layer: Some(id.clone()) });
                }
            }
        }
        out
    }

    /// `drawingOnionSamples`: the nearest drawings before and after the playhead on each drawing layer, never repeating the
    /// drawing on screen; blank exposures are skipped rather than counted.
    pub(crate) fn drawing_candidates(&self, settings: &Settings) -> Vec<Candidate> {
        let mut out = Vec::new();
        if settings.frames {
            return out;
        }
        for (id, drawing, visible, end, keys) in self.layer_tracks() {
            if !drawing || !visible {
                continue;
            }
            let current = key_before(&keys, self.tick) + i64::from(self.tick >= end);
            for direction in [-1i32, 1] {
                let span = if direction < 0 { settings.range_before } else { settings.range_after };
                let wanted = if span.is_none() { if direction < 0 { settings.before } else { settings.after } } else { f64::INFINITY };
                let (mut index, mut distance, mut seen) = (current + direction as i64, 0.0, 0.0);
                while index >= 0 && (index as usize) < keys.len() && distance < wanted {
                    let key = &keys[index as usize];
                    let at = num(key, "tick").unwrap_or(f64::NAN);
                    index += direction as i64;
                    if span.is_some_and(|span| f64::from(direction) * (at - self.tick) > span) {
                        break;
                    }
                    if key.path(&["value", "frameId"]).is_none_or(Value::is_null) {
                        continue;
                    }
                    let skip = seen % settings.step != 0.0;
                    seen += 1.0;
                    if skip {
                        continue;
                    }
                    distance += 1.0;
                    out.push(Candidate { tick: at, distance, direction, layer: Some(id.clone()) });
                }
            }
        }
        out
    }

    /// The frames around the playhead for a document without independent layer exposures: every tick (`frames`), or the stored
    /// poses of the timeline's rows.
    fn row_candidates(&self, settings: &Settings, timeline: &[crate::timeline::Row], total: f64) -> Vec<Candidate> {
        let mut out = Vec::new();
        let index = self.frame_index as i64;
        let past_start = timeline.get(self.frame_index).is_some_and(|row| self.tick > row.start);
        let available = |direction: i32| -> f64 {
            let span = if settings.frames {
                if direction < 0 { self.tick.floor() } else { total - 1.0 - self.tick.floor() }
            } else if direction < 0 {
                (index + i64::from(past_start)) as f64
            } else {
                (timeline.len() as i64 - 1 - index) as f64
            };
            (span / settings.step).floor().max(0.0)
        };
        let before = settings.before.min(available(-1));
        let after = settings.after.min(available(1));
        let mut distance = before.max(after);
        while distance > 0.0 {
            for direction in [-1i32, 1] {
                if distance > if direction < 0 { before } else { after } {
                    continue;
                }
                let tick = if settings.frames {
                    self.tick.floor() + f64::from(direction) * distance * settings.step
                } else {
                    let mut at = index + i64::from(direction) * (distance * settings.step) as i64;
                    if direction < 0 && past_start {
                        at += 1;
                    }
                    match usize::try_from(at).ok().and_then(|at| timeline.get(at)) {
                        Some(row) => row.start,
                        None => continue,
                    }
                };
                if settings.frames && (tick < 0.0 || tick >= total) {
                    continue;
                }
                out.push(Candidate { tick, distance, direction, layer: None });
            }
            distance -= 1.0;
        }
        out
    }

    /// The pose of the document at `tick`, from the ones already evaluated.
    fn ghost_record<'a>(&'a self, cache: &mut Cache, records: &mut Option<styk_eval::records::Records<'a>>, prepared: &'a Arc<styk_eval::eval::Prepared>, tick: f64) -> Result<Value, EditError> {
        if !cache.base.as_ref().is_some_and(|base| base.same_node(&self.report)) {
            cache.base = Some(self.report.clone());
            cache.frames.clear();
        }
        if let Some(at) = cache.frames.iter().position(|(held, _)| *held == tick.to_bits()) {
            let held = cache.frames.remove(at);
            let record = held.1.clone();
            cache.frames.push(held);
            return Ok(record);
        }
        let records = match records {
            Some(records) => records,
            None => records.insert(styk_eval::records::Records::new(&self.report, prepared)?),
        };
        let record = records.evaluated_with(tick, true)?;
        cache.frames.push((tick.to_bits(), record.clone()));
        if cache.frames.len() > MAX_GHOSTS {
            cache.frames.remove(0);
        }
        Ok(record)
    }

    /// The onion skins `request` (the settings and the hidden figures, as JSON) asks for at the playhead, far to near; the set last
    /// made while nothing it depends on changed.
    pub(crate) fn onion_set(&self, request: &str) -> Result<Arc<OnionSet>, EditError> {
        let parsed = styk_doc::json::parse(request.as_bytes()).map_err(|error| EditError::Invalid(error.to_string()))?;
        let settings = Settings::parse(&parsed)?;
        let mut guard = self.onions.borrow_mut();
        let cache = &mut *guard;
        if let (Some((report, held, tick, index)), Some(set)) = (&cache.key, &cache.set)
            && report.same_node(&self.report)
            && held == request
            && *tick == self.tick.to_bits()
            && *index == self.frame_index
        {
            return Ok(set.clone());
        }
        let prepared = self.prepared()?;
        let timeline = rows(&self.report);
        let total = total_ticks(&timeline);
        let sheet = self.report.path(&["_styk", "layerSheet"]).is_some();
        if !sheet && !settings.frames && self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) > 0 {
            return Err(EditError::Unported("onion skins of property channels without a layer timeline".into()));
        }
        let independent = sheet && !settings.frames;
        let mut candidates = if independent { self.layer_candidates(&settings) } else { self.row_candidates(&settings, &timeline, total) };
        candidates.extend(self.drawing_candidates(&settings));
        // Far to near; the farthest are dropped past the limit.
        candidates.sort_by(|a, b| b.distance.total_cmp(&a.distance));
        if candidates.len() > MAX_GHOSTS {
            candidates.drain(..candidates.len() - MAX_GHOSTS);
        }
        let (drawing, invisible) = self.layer_flags();
        let layers: Option<Value> = self.report.path(&["_styk", "layers"]).cloned();
        let layer_of = |uid: u32| crate::frame::layer_of(layers.as_ref(), uid);
        let mut records = None;
        let mut ghosts = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let record = self.ghost_record(cache, &mut records, &prepared, candidate.tick)?;
            let objects: Vec<Value> = record.get("objects").and_then(Value::elements).map(|objects| objects.iter().collect()).unwrap_or_default();
            // The scope, with the figures joined to the selected ones when asked.
            let included: Option<HashSet<u32>> = settings.selected_only.then(|| {
                let mut included: HashSet<u32> = settings.selected.iter().copied().collect();
                if settings.joined {
                    let mut links: HashMap<u32, Vec<u32>> = HashMap::new();
                    for object in &objects {
                        if let (Some(own), Some(parent)) = (uid(object), join_target(object).and_then(|slot| objects.get(slot)).and_then(uid)) {
                            links.entry(own).or_default().push(parent);
                            links.entry(parent).or_default().push(own);
                        }
                    }
                    let mut queue: Vec<u32> = included.iter().copied().collect();
                    let mut at = 0;
                    while at < queue.len() {
                        for &next in links.get(&queue[at]).map(Vec::as_slice).unwrap_or(&[]) {
                            if included.insert(next) {
                                queue.push(next);
                            }
                        }
                        at += 1;
                    }
                }
                included
            });
            let hidden: Vec<u32> = objects
                .iter()
                .enumerate()
                .filter(|(_, object)| {
                    let Some(own) = uid(object) else { return true };
                    let layer = layer_of(own);
                    included.as_ref().is_some_and(|included| !included.contains(&own))
                        || settings.hidden.contains(&own)
                        || invisible.contains(&layer)
                        || (!settings.frames && match &candidate.layer { Some(wanted) => layer != *wanted, None => drawing.contains(&layer) })
                })
                .map(|(slot, _)| slot as u32)
                .collect();
            ghosts.push(Ghost {
                tick: candidate.tick,
                record,
                opacity: settings.opacity * if settings.fade { 1.0 / candidate.distance } else { 1.0 },
                tint: if candidate.direction < 0 { settings.before_color } else { settings.after_color },
                show_on_top: settings.on_top,
                hidden,
            });
        }
        let set = Arc::new(OnionSet { ghosts });
        cache.key = Some((self.report.clone(), request.to_string(), self.tick.to_bits(), self.frame_index));
        cache.set = Some(set.clone());
        Ok(set)
    }
}

impl Editor {
    /// The onion skins of [`Editor::onion_set`] as JSON, without their poses but for where each figure's origin is:
    /// `{ghosts: [{tick, opacity, tint, showOnTop, hidden, roots: [uid, x, y, …]}]}`, far to near. For the interface to say what it draws (tests and
    /// diagnostics); the stage takes the set itself.
    pub(crate) fn onion_summary(&self, request: &str) -> Result<String, EditError> {
        let set = self.onion_set(request)?;
        let ghosts = set
            .ghosts
            .iter()
            .map(|ghost| {
                let mut out = styk_doc::Obj::new();
                out.set("tick", Value::Num(ghost.tick));
                out.set("opacity", Value::Num(ghost.opacity));
                out.set("tint", ghost.tint.map_or(Value::Null, |rgb| Value::nums(&rgb.map(f64::from))));
                out.set("showOnTop", Value::Bool(ghost.show_on_top));
                out.set("hidden", Value::nums(&ghost.hidden.iter().map(|&slot| f64::from(slot)).collect::<Vec<_>>()));
                let roots: Vec<f64> = ghost.record.get("objects").and_then(Value::elements).into_iter().flat_map(|objects| objects.iter()).flat_map(|object| [num(&object, "unique_id"), num(&object, "root_x"), num(&object, "root_y")]).map(|value| value.unwrap_or(f64::NAN)).collect();
                out.set("roots", Value::nums(&roots));
                Value::object(out)
            })
            .collect();
        let mut summary = styk_doc::Obj::new();
        summary.set("ghosts", Value::array(ghosts));
        Ok(styk_doc::json::to_string(&Value::object(summary)))
    }
}
