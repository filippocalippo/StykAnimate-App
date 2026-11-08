use super::{
    projection::{Projection, project},
    transport::{Audio, Demand, State, Transport},
    *,
};
use crate::{
    answers,
    commands::{Effect, Notice, Severity},
    documents::Documents,
    i18n::Msg,
    settings::{Settings, TimelineMode},
    stage::Surface,
    view_state::ViewState,
};
use std::sync::Arc;
use styk_doc::{Obj, Value};
use styk_services::{SpawnError, Spawner, worker::Worker};

struct Request {
    identity: Identity,
    records: Value,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct RangeKey {
    document: Identity,
    epoch: u64,
}
struct RangeRequest {
    key: RangeKey,
    records: Value,
    chosen: Selection,
    layers: Arc<[String]>,
    mode: TimelineMode,
}
fn resolve_range(request: RangeRequest) -> (RangeKey, Selection) {
    let chosen = if request.mode == TimelineMode::Advanced {
        if let (Selection::Span { first, last }, Some(tracks)) = (&request.chosen, request.records.path(&["_styk", "layerSheet", "tracks"]))
        {
            let mut ticks = std::collections::BTreeSet::from([*first]);
            if first < last {
                for id in request.layers.iter() {
                    if let Some(keys) = tracks.get(id).and_then(|track| track.get("keys")).and_then(Value::elements) {
                        ticks.extend(
                            keys.iter()
                                .filter_map(|key| key.get("tick").and_then(Value::as_f64))
                                .map(|tick| tick as usize)
                                .filter(|tick| first < tick && tick <= last),
                        );
                    }
                }
            }
            Selection::Items(ticks.into_iter().collect())
        } else {
            request.chosen
        }
    } else {
        request.chosen
    };
    (request.key, chosen)
}
#[derive(Default)]
pub struct Panel {
    model: Model,
    worker: Option<Worker<Request, Projection>>,
    range_worker: Option<Worker<RangeRequest, (RangeKey, Selection)>>,
    range_asked: Option<RangeKey>,
    range_ready: Option<RangeKey>,
    range_current: Selection,
    range_pending: bool,
    asked: Option<Identity>,
    projection: Option<Projection>,
    retired: Vec<Box<dyn Send>>,
    transport: Transport,
    anchor: Option<(usize, usize)>,
    scrub: Option<(f64, u64, f64)>,
    pending_seek: Option<f64>,
    seek_flight: Option<f64>,
    raster_export: bool,
    audio: Option<crate::audio::AudioTransport>,
    audio_job: Option<u64>,
    audio_plan: Option<Arc<crate::audio::MixPlan>>,
    audio_failed: bool,
    audio_error: bool,
    audio_start_on_submit: bool,
    calls: Vec<Value>,
    flight: Option<crate::documents::JobId>,
    call_identity: Option<(crate::identity::DocumentId, u64)>,
    presentation: Option<Demand>,
    seek_requested: Option<f64>,
    quality: transport::Quality,
    automatic_quality: bool,
}
fn warning(message: Msg) -> Effect {
    Effect::Notice(Notice { message, severity: Severity::Warning })
}
fn invalid() -> Msg {
    Msg::new("errors.editorSessions.finishTheCurrentOperationFirst")
}
fn options(key: &str, value: bool) -> Value {
    let mut out = Obj::new();
    out.set(key, Value::Bool(value));
    Value::object(out)
}
impl Panel {
    pub fn start(&mut self, spawner: &dyn Spawner, wake: Arc<dyn Fn() + Send + Sync>) -> Result<(), SpawnError> {
        self.worker =
            Some(Worker::start(spawner, "styk timeline", |request: Request| project(request.identity, &request.records), wake.clone())?);
        self.range_worker = Some(Worker::start(spawner, "styk timeline range", resolve_range, wake)?);
        self.asked = None;
        Ok(())
    }
    pub fn set_audio(&mut self, audio: Result<crate::audio::AudioTransport, String>) {
        match audio {
            Ok(audio) => {
                self.audio = Some(audio);
                self.audio_failed = false;
            }
            Err(_) => {
                self.audio_failed = true;
                self.audio_error = true;
            }
        }
    }
    pub fn model(&self) -> &Model {
        &self.model
    }
    pub(crate) fn quality_changed(&mut self, quality: crate::settings::PlaybackQuality, stage: Option<&Surface>) {
        self.quality = Default::default();
        self.automatic_quality = quality == crate::settings::PlaybackQuality::Auto;
        if self.playing()
            && let Some(stage) = stage
        {
            stage.playback_quality(quality);
        }
    }
    pub fn playing(&self) -> bool {
        self.transport.playing()
    }
    pub fn deadline(&self) -> Option<u64> {
        [
            self.transport.deadline(),
            self.scrub.filter(|(x, _, origin)| self.model.geometry.edge_active(*x, *origin)).map(|(_, at, _)| at.saturating_add(16)),
        ]
        .into_iter()
        .flatten()
        .min()
    }
    pub fn refresh(&mut self, documents: &Documents, view: &mut ViewState, settings: &Settings) {
        let identity = documents.active().map(|d| Identity { document: d.id(), lineage: d.lineage(), revision: d.revision() });
        if identity.map(|id| (id.document, id.lineage)) != self.model.identity.map(|id| (id.document, id.lineage)) {
            self.pause();
            self.pending_seek = None;
            self.seek_flight = None;
            self.anchor = None;
            self.scrub = None;
            self.transport.range(None, 0);
            view.set_timeline_selection(Selection::Empty);
            view.set_layers(Vec::new());
            self.model.geometry = Default::default();
        }
        self.model.identity = identity;
        self.model.mode = settings.animation().timeline_mode;
        self.transport.model.looping = settings.animation().loop_playback;
        let range_key = identity.map(|document| RangeKey { document, epoch: view.range_epoch() });
        if let Some(worker) = &self.range_worker {
            if let Some((key, chosen)) = worker.take() {
                self.range_asked = None;
                if Some(key) == range_key {
                    self.retired.push(Box::new(std::mem::replace(&mut self.range_current, chosen.clone())));
                    self.retired.push(Box::new(view.resolve_range(chosen)));
                    self.range_ready = Some(key);
                } else {
                    self.retired.push(Box::new(chosen));
                }
            }
            if self.range_ready != range_key {
                if !view.edit_range().is_empty() {
                    self.retired.push(Box::new(view.resolve_range(Selection::Empty)));
                }
                if view.range().is_empty() {
                    self.retired.push(Box::new(std::mem::take(&mut self.range_current)));
                    self.range_ready = range_key;
                } else if self.range_asked.is_none() {
                    if let (Some(key), Some(records)) = (range_key, documents.active().and_then(|d| d.records().ok())) {
                        let request = RangeRequest {
                            key,
                            records: records.clone(),
                            chosen: view.range().clone(),
                            layers: view.layer_selection(),
                            mode: self.model.mode,
                        };
                        if worker.submit(request).is_ok() {
                            self.range_asked = Some(key);
                        }
                    }
                }
            }
            self.range_pending = self.range_ready != range_key;
        }
        if let Some(worker) = &self.worker {
            if !self.retired.is_empty() {
                self.retired = worker.retire(std::mem::take(&mut self.retired)).err().unwrap_or_default();
            }
            if self.retired.is_empty() {
                if let Some(ready) = worker.take() {
                    self.asked = None;
                    if Some(ready.identity) == identity {
                        if let Some(old) = self.projection.replace(ready) {
                            self.retired.push(Box::new(old));
                        }
                    } else {
                        self.retired.push(Box::new(ready));
                    }
                }
            }
        }
        self.model.pending = identity.is_none()
            || self.range_pending
            || self.projection.as_ref().map(|p| p.identity) != identity
            || documents.active().is_none_or(|d| d.view().is_err())
            || self.flight.is_some()
            || !self.calls.is_empty();
        if self.projection.as_ref().map(|p| p.identity) != identity && self.asked.is_none() && self.retired.is_empty() {
            if let (Some(worker), Some(identity), Some(records)) =
                (&self.worker, identity, documents.active().and_then(|d| d.records().ok()))
            {
                if worker.submit(Request { identity, records: records.clone() }).is_ok() {
                    self.asked = Some(identity);
                }
            }
        }
        self.model.disabled = self.model.pending.then(|| Msg::new("app.preparing"));
        if self.model.pending {
            self.model.layers.clear();
            self.model.cards.clear();
        }
        if let Some(document) = documents.active() {
            if let Ok(current) = document.view() {
                self.model.tick = current.tick;
            }
            self.model.active_layer = document
                .records()
                .ok()
                .and_then(|r| r.path(&["_styk", "layers", "activeId"]))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        if let Some(p) = self.projection.as_ref().filter(|_| !self.model.pending) {
            self.model.total = p.total;
            self.model.fps = p.fps;
            self.transport.range(self.transport.model.range, p.total);
            self.model.row_count = p.rows.len();
            self.model.card_count = p.cards.len();
            let visible = self.model.geometry.rows(p.rows.len());
            let ticks = self.model.geometry.ticks();
            self.model.first_row = visible.first().copied().unwrap_or(0);
            self.model.layers = visible
                .into_iter()
                .map(|index| {
                    let layer = &p.rows[index];
                    let mut visible = Layer {
                        index,
                        id: layer.id.clone(),
                        name: layer.name.clone(),
                        depth: layer.depth,
                        locked: layer.locked,
                        hidden: layer.hidden,
                        folder: layer.folder,
                        exposures: Vec::new(),
                    };
                    let from = layer.exposures.partition_point(|e| e.end <= ticks.start);
                    let to = layer.exposures.partition_point(|e| e.tick < ticks.end);
                    visible.exposures = layer.exposures[from..to.max(from)].to_vec();
                    visible
                })
                .collect();
            let visible = self.model.geometry.cards(p.cards.len());
            self.model.first_card = visible.start;
            self.model.cards = p.cards[visible].to_vec();
        }
        self.model.selected = view.range().clone();
        self.model.selected_layers = view.layer_selection();
        self.model.transport = self.transport.model.clone();
    }
    pub fn mode_changed(
        &mut self,
        documents: &mut Documents,
        view: &mut ViewState,
        session: &mut answers::Session,
        settings: &Settings,
    ) -> Result<(), Msg> {
        documents
            .set_auto_key(settings.animation().timeline_mode == TimelineMode::Advanced && settings.view().auto_key)
            .map_err(|e| Msg::owned(e.message_key().to_owned()))?;
        self.pause();
        self.anchor = None;
        self.scrub = None;
        self.pending_seek = None;
        self.seek_flight = None;
        if let Some(document) = documents.active() {
            answers::call(documents, document.id(), "keepSelectionOnSeek", &[], session)?;
        }
        if documents.active().is_some() && settings.animation().timeline_mode == TimelineMode::Advanced {
            self.call("disableFrameDrafts", &[]);
        }
        view.set_timeline_selection(Selection::Empty);
        view.set_layers(Vec::new());
        view.set_apply_range(false);
        Ok(())
    }
    fn pause(&mut self) {
        self.transport.pause();
        self.audio_job = None;
        self.audio_start_on_submit = false;
        if let Some(audio) = &mut self.audio {
            audio.stop();
        }
        if let Some(plan) = self.audio_plan.take() {
            self.retired.push(Box::new(plan));
        }
        self.presentation = None;
    }
    fn call(&mut self, method: &str, args: &[Value]) {
        let mut value = Obj::new();
        value.set("method", Value::str(method));
        value.set("args", Value::array(args.to_vec()));
        self.calls.push(Value::object(value));
    }
    fn flush_calls(&mut self, documents: &mut Documents) -> Result<(), Msg> {
        if self.calls.is_empty() || self.flight.is_some() {
            return Ok(());
        }
        let document = documents.active().ok_or_else(invalid)?;
        let identity = (document.id(), document.lineage());
        if self.call_identity.is_some_and(|wanted| wanted != identity) {
            self.calls.clear();
            self.seek_requested = None;
            return Err(invalid());
        }
        self.call_identity = Some(identity);
        let request = crate::documents::Request::Call {
            document: identity.0,
            method: "@timeline".into(),
            args: std::mem::take(&mut self.calls),
            view: Value::Null,
        };
        match documents.dispatch(request) {
            Ok(crate::documents::Effect::Started(job)) => {
                self.flight = Some(job);
                Ok(())
            }
            Err((
                crate::documents::HostError::Documents(crate::documents::DocumentsError::Busy),
                crate::documents::Request::Call { args, .. },
            )) => {
                self.calls = args;
                Ok(())
            }
            Err((error, _)) => {
                self.call_identity = None;
                self.seek_requested = None;
                Err(Msg::new("native.timeline.operationFailed").with("detail", error.to_string()))
            }
            Ok(_) => Err(invalid()),
        }
    }
    pub(crate) fn completed(&mut self, documents: &Documents, stage: Option<&Surface>, success: bool) {
        if self.flight.take().is_none() {
            return;
        }
        let current = documents.active().map(|d| (d.id(), d.lineage()));
        if !success || current != self.call_identity {
            self.pause();
            self.pending_seek = None;
            self.seek_flight = None;
            self.seek_requested = None;
            self.call_identity = None;
            return;
        }
        if let Some(tick) = self.seek_requested.take() {
            self.model.tick = documents.active().and_then(|d| d.view().ok()).map_or(tick, |v| v.tick);
            if self.scrub.is_some()
                && let (Some(audio), Some(p)) = (&mut self.audio, &self.projection)
            {
                audio.scrub(&p.audio, self.model.tick / p.fps);
            }
            if let Some(stage) = stage {
                if let Some(demand) = self.presentation.take() {
                    stage.transport_frame(demand);
                } else {
                    let _ = stage.event(crate::stage::Event::Frame(self.model.tick));
                }
            }
        }
        self.call_identity = None;
    }
    pub fn finish(&mut self, documents: &mut Documents, session: &mut answers::Session, stage: Option<&Surface>) -> Result<(), Msg> {
        if self.range_pending {
            return Err(Msg::new("app.preparing"));
        }
        let was_playing = self.playing();
        self.pause();
        self.scrub = None;
        if was_playing {
            if let Some(stage) = stage {
                stage.end_transport();
            }
        }
        // Busy keeps the final scrub target and the initiating command in Core's deferred slot.
        self.flush_seek(documents, session, stage)?;
        self.flush_calls(documents)?;
        if self.pending_seek.is_some() || self.flight.is_some() || !self.calls.is_empty() {
            return Err(Msg::new("app.preparing"));
        }
        if let Some(document) = documents.active() {
            if document.view().is_err() {
                return Err(Msg::new("app.preparing"));
            }
            if was_playing {
                answers::call(documents, document.id(), "endFrameDraftPreview", &[], session)?;
            }
        }
        Ok(())
    }
    fn seek(&mut self, tick: f64, documents: &mut Documents, session: &mut answers::Session, stage: Option<&Surface>) -> Result<(), Msg> {
        if !tick.is_finite() {
            return Err(invalid());
        }
        let _ = (documents, session, stage);
        if self.model.mode == TimelineMode::Simple {
            self.call("keepSelectionOnSeek", &[]);
        }
        self.call("seek", &[Value::Num(tick), options("allowBeyondEnd", self.model.mode == TimelineMode::Advanced)]);
        self.seek_requested = Some(tick);
        self.model.geometry.reveal(tick, None, self.model.row_count, self.model.total);
        Ok(())
    }
    fn flush_seek(&mut self, documents: &mut Documents, session: &mut answers::Session, stage: Option<&Surface>) -> Result<(), Msg> {
        if self.flight.is_some() || !self.calls.is_empty() || (self.seek_flight.is_some() && stage.is_some_and(|stage| !stage.ready())) {
            return Ok(());
        }
        self.seek_flight = None;
        if let Some(tick) = self.pending_seek {
            self.seek(tick, documents, session, stage)?;
            self.pending_seek = None;
            self.seek_flight = stage.map(|_| self.model.tick);
        }
        Ok(())
    }
    fn select_layer(
        &mut self,
        id: String,
        modifiers: Modifiers,
        documents: &mut Documents,
        view: &mut ViewState,
        session: &mut answers::Session,
    ) -> Result<usize, Msg> {
        let p = self.projection.as_ref().ok_or_else(invalid)?;
        let index = *p.row_index.get(&id).ok_or_else(invalid)?;
        if p.rows[index].folder {
            return Err(invalid());
        } // Folder interactions belong to part 2.
        let _ = session;
        let mut selected = if modifiers.toggle { view.layers().to_vec() } else { Vec::new() };
        if modifiers.extend {
            let first = self.anchor.map_or(index, |(row, _)| row).min(p.rows.len().saturating_sub(1));
            selected.extend(p.rows[first.min(index)..=first.max(index)].iter().filter(|r| !r.folder).map(|r| r.id.clone()));
        } else if let Some(at) = selected.iter().position(|s| *s == id) {
            selected.remove(at);
        } else {
            selected.push(id.clone());
        }
        view.set_layers(selected);
        self.model.geometry.reveal(self.model.tick, Some(index), p.rows.len(), p.total);
        let contents = self.model.mode == TimelineMode::Advanced && id != "camera";
        let same = documents.active().and_then(|d| d.view().ok()).is_some_and(|v| v.sheet_selection == Some((id.as_str(), contents)));
        if !same {
            self.call("selectSheetLayer", &[Value::str(&id), options("contents", contents)]);
        }
        Ok(index)
    }
    pub fn update(
        &mut self,
        event: Event,
        documents: &mut Documents,
        view: &mut ViewState,
        session: &mut answers::Session,
        settings: &Settings,
        stage: Option<&Surface>,
    ) -> Vec<Effect> {
        let mut effects = Vec::new();
        let result = match event {
            Event::Viewport { width, height } => {
                self.model.geometry.viewport(width, height);
                Ok(())
            }
            Event::Scroll { x, y } => {
                if self.model.mode == TimelineMode::Simple {
                    self.model.geometry.scroll_cards(x, self.model.card_count);
                } else {
                    self.model.geometry.scroll(x, y, self.model.row_count, self.model.total);
                }
                Ok(())
            }
            Event::RasterExport(active) => {
                self.raster_export = active;
                if active { self.finish(documents, session, stage) } else { Ok(()) }
            }
            Event::Wake { now } => self.wake(now, documents, session, stage),
            Event::Action { id, payload, now } => self.action(id, payload, now, documents, view, session, settings, stage),
        };
        if let Err(message) = result {
            effects.push(warning(message));
        }
        if let Err(message) = self.flush_calls(documents) {
            effects.push(warning(message));
        }
        if self.audio_error && self.playing() {
            self.audio_error = false;
            effects.push(warning(Msg::new("native.timeline.audioUnavailable")));
        }
        effects.push(Effect::RequestFrame);
        effects
    }
    #[allow(clippy::too_many_arguments)]
    fn action(
        &mut self,
        id: CommandId,
        payload: Payload,
        now: u64,
        documents: &mut Documents,
        view: &mut ViewState,
        session: &mut answers::Session,
        settings: &Settings,
        stage: Option<&Surface>,
    ) -> Result<(), Msg> {
        use CommandId::*;
        if documents.active().is_none() {
            return Err(invalid());
        }
        if (id == TimelineSelectCell && self.model.mode != TimelineMode::Advanced)
            || (id == TimelineSelectCard && self.model.mode != TimelineMode::Simple)
        {
            return Err(invalid());
        }
        if self.model.pending && !matches!(id, TimelineSeek | TimelineGoToFrame | TimelineSetFps | TimelineScrub) {
            return Err(Msg::new("app.preparing"));
        }
        let modifiers = if let Payload::Modifiers(modifiers) = &payload { *modifiers } else { Modifiers::default() };
        match (id, payload) {
            (Play | PlayPan, _) => {
                if self.playing() {
                    return self.finish(documents, session, stage);
                }
                if self.raster_export {
                    return Err(Msg::new("app.finishOrCancelTheExportBeforePlaying"));
                }
                let Some(stage) = stage else {
                    return Err(Msg::new("app.preparing"));
                };
                if self.transport.start(self.model.tick, self.model.total, now) {
                    self.quality = Default::default();
                    self.automatic_quality = settings.animation().playback_quality == crate::settings::PlaybackQuality::Auto;
                    if settings.animation().fit_view_on_playback {
                        let _ = stage.event(crate::stage::Event::FitCanvas);
                    }
                    stage.playback_quality(settings.animation().playback_quality);
                    if let (Some(audio), Some(p)) = (&mut self.audio, &self.projection) {
                        if p.audible {
                            let (first, end) = transport::normalize(self.transport.model.range, p.total);
                            self.audio_job =
                                Some(audio.prepare(&p.audio, first as f64 / p.fps, end as f64 / p.fps, crate::audio::Then::Hold));
                        }
                    }
                }
                self.wake(now, documents, session, Some(stage))
            }
            (TimelineSetFps, Payload::Number(fps)) => {
                if !fps.is_finite() {
                    return Err(invalid());
                }
                self.call("setFPS", &[Value::Num(fps)]);
                Ok(())
            }
            (TimelineSeek | TimelineGoToFrame, Payload::Number(value)) => {
                self.seek(if id == TimelineGoToFrame { value.round() - 1. } else { value }, documents, session, stage)
            }
            (TimelinePlaybackRange, Payload::Range { first, last }) => {
                if !first.is_finite() || !last.is_finite() {
                    return Err(invalid());
                }
                self.transport
                    .range(Some(((first.min(last).round() - 1.).max(0.) as u32, first.max(last).round().max(0.) as u32)), self.model.total);
                Ok(())
            }
            (TimelineGoToFrame | TimelineSetFps | TimelinePlaybackRange, Payload::None) => {
                self.model.editor = Some(id);
                Ok(())
            }
            (TimelineSelectLayer, Payload::Layer { id, modifiers }) => {
                let index = self.select_layer(id, modifiers, documents, view, session)?;
                if !modifiers.extend {
                    self.anchor = Some((index, self.model.tick as usize));
                }
                Ok(())
            }
            (TimelineSelectCell, Payload::Cell { point, modifiers }) => {
                let row = self.model.geometry.row(point[1], self.model.row_count).ok_or_else(invalid)?;
                let tick = self.model.geometry.tick(point[0]).ok_or_else(invalid)? as usize;
                if self.projection.as_ref().is_some_and(|p| p.rows[row].folder) {
                    return Ok(());
                }
                let id = self.projection.as_ref().ok_or_else(invalid)?.rows[row].id.clone();
                self.select_layer(id, modifiers, documents, view, session)?;
                let first = if modifiers.extend { self.anchor.map_or(tick, |(_, tick)| tick) } else { tick };
                view.set_timeline_selection(Selection::Span { first: first.min(tick), last: first.max(tick) });
                if !modifiers.extend {
                    self.anchor = Some((row, tick));
                }
                self.seek(tick as f64, documents, session, stage)
            }
            (TimelineSelectCard, Payload::Card { index, modifiers }) => {
                let p = self.projection.as_ref().ok_or_else(invalid)?;
                let tick = p.cards.get(index).ok_or_else(invalid)?.tick;
                let chosen = if modifiers.extend {
                    let from = self.anchor.map_or(index, |(_, index)| index).min(p.cards.len() - 1);
                    Selection::items(
                        p.cards[from.min(index)..=from.max(index)]
                            .iter()
                            .map(|card| if p.sheet { card.tick as usize } else { card.index })
                            .collect(),
                    )
                } else {
                    let at = if p.sheet { tick as usize } else { index };
                    Selection::Span { first: at, last: at }
                };
                view.set_timeline_selection(chosen);
                if !modifiers.extend {
                    self.anchor = Some((0, index));
                }
                self.model.geometry.reveal_card(index, p.cards.len());
                self.seek(tick as f64, documents, session, stage)
            }
            (TimelineScrub, Payload::Scrub { phase, x }) => {
                if phase == Phase::Cancel {
                    self.scrub = None;
                    self.pending_seek = None;
                    if let Some(audio) = &mut self.audio {
                        audio.end_scrub();
                    }
                    return Ok(());
                }
                let tick = self.model.geometry.tick(x).ok_or_else(invalid)?;
                self.pending_seek = Some(tick as f64);
                let origin = if phase == Phase::Begin {
                    self.model.geometry.reset_edge();
                    x
                } else {
                    self.scrub.map_or(x, |(_, _, origin)| origin)
                };
                self.scrub = (phase != Phase::End).then_some((x, now, origin));
                if phase == Phase::End {
                    if let Some(audio) = &mut self.audio {
                        audio.end_scrub();
                    }
                }
                self.flush_seek(documents, session, stage)
            }
            (SelectAll, _) => {
                let p = self.projection.as_ref().ok_or_else(invalid)?;
                view.set_layers(p.rows.iter().filter(|r| !r.folder).map(|r| r.id.clone()).collect());
                view.set_timeline_selection(if self.model.mode == TimelineMode::Simple {
                    Selection::items(p.cards.iter().map(|c| if p.sheet { c.tick as usize } else { c.index }).collect())
                } else {
                    Selection::Span { first: 0, last: p.total.saturating_sub(1) as usize }
                });
                Ok(())
            }
            (Cancel, _) => {
                self.pending_seek = None;
                self.scrub = None;
                self.model.editor = None;
                self.finish(documents, session, stage)
            }
            (
                FirstFrame | PreviousFrame | NextFrame | LastFrame | PreviousKeyframe | NextKeyframe | PreviousExposure | NextExposure
                | TimelineLayerUp | TimelineLayerDown,
                _,
            ) => {
                let p = self.projection.as_ref().ok_or_else(invalid)?;
                let tick = self.model.tick;
                if self.model.mode == TimelineMode::Simple {
                    let at = p.cards.partition_point(|card| card.tick as f64 <= tick).saturating_sub(1);
                    // Today's shared hotkey adapter treats both layer arrows as +1 in Simple mode.
                    let index = match id {
                        FirstFrame => 0,
                        LastFrame => p.cards.len().saturating_sub(1),
                        PreviousFrame | PreviousExposure | PreviousKeyframe => at.saturating_sub(1),
                        _ => (at + 1).min(p.cards.len().saturating_sub(1)),
                    };
                    return self.action(
                        TimelineSelectCard,
                        Payload::Card { index, modifiers },
                        now,
                        documents,
                        view,
                        session,
                        settings,
                        stage,
                    );
                }
                let at = p.row_index.get(&self.model.active_layer).copied().unwrap_or(0);
                if matches!(id, PreviousKeyframe | NextKeyframe) {
                    let keys = &p.rows.get(at).ok_or_else(invalid)?.exposures;
                    let next = if id == PreviousKeyframe {
                        keys.partition_point(|k| (k.tick as f64) < tick).checked_sub(1).and_then(|i| keys.get(i))
                    } else {
                        keys.get(keys.partition_point(|k| k.tick as f64 <= tick))
                    };
                    return self.seek(next.map_or(tick, |key| key.tick as f64), documents, session, stage);
                }
                let row = match id {
                    TimelineLayerUp => p.neighbors[at].0,
                    TimelineLayerDown => p.neighbors[at].1,
                    _ => at,
                };
                let next = match id {
                    FirstFrame => 0.,
                    LastFrame => p.total.saturating_sub(1) as f64,
                    PreviousFrame | PreviousExposure => (tick - 1.).max(0.),
                    NextFrame | NextExposure => tick + 1.,
                    _ => tick,
                };
                let layer = p.rows.get(row).ok_or_else(invalid)?.id.clone();
                self.select_layer(layer, modifiers, documents, view, session)?;
                let first = if modifiers.extend { self.anchor.map_or(next as usize, |(_, tick)| tick) } else { next as usize };
                view.set_timeline_selection(Selection::Span { first: first.min(next as usize), last: first.max(next as usize) });
                if !modifiers.extend {
                    self.anchor = Some((row, next as usize));
                }
                self.seek(next, documents, session, stage)
            }
            _ => Err(invalid()),
        }
    }
    fn wake(&mut self, now: u64, documents: &mut Documents, session: &mut answers::Session, stage: Option<&Surface>) -> Result<(), Msg> {
        self.transport.observe(now);
        if let Some((x, at, origin)) = self.scrub {
            if self.model.geometry.edge_active(x, origin)
                && self.model.geometry.scrub_edge(x, now.saturating_sub(at), self.model.row_count, self.model.total)
            {
                self.pending_seek = self.model.geometry.tick(x).map(f64::from);
            }
            self.scrub = Some((x, now, origin));
        }
        self.flush_seek(documents, session, stage)?;
        let Some(stage) = stage else {
            return Ok(());
        };
        if self.automatic_quality
            && self.quality.update(self.transport.model.measured_fps, self.model.fps, now, self.transport.model.state == State::Buffering)
        {
            stage.playback_quality(match self.quality.index {
                1 => crate::settings::PlaybackQuality::Medium,
                2 => crate::settings::PlaybackQuality::Low,
                _ => crate::settings::PlaybackQuality::Normal,
            });
        }
        if let Some(demand) = stage.take_submission() {
            // Preparation/submission may have stalled since the earlier clock read. Match today's 1.5-frame re-anchor.
            if self.audio.as_ref().is_some_and(|audio| matches!(audio.reading(), styk_services::audio::clock::Reading::Running { sample, .. } if sample / crate::audio::RATE as f64 > (demand.tick + 1.5) / self.model.fps)) {
                self.audio_start_on_submit = true;
            }
            if self.transport.submitted(demand, now, self.model.fps) && self.audio_start_on_submit {
                self.audio_start_on_submit = false;
                if !self.audio_failed {
                    if let (Some(audio), Some(plan)) = (&mut self.audio, &self.audio_plan) {
                        let (_, end) = transport::normalize(self.transport.model.range, self.model.total);
                        audio.play(
                            plan.clone(),
                            (demand.tick / self.model.fps * crate::audio::RATE as f64).round() as u64,
                            (end as f64 / self.model.fps * crate::audio::RATE as f64).round() as u64,
                        );
                    }
                }
            }
        }
        let mut preparation_failed = false;
        if let Some(audio) = &mut self.audio {
            for event in audio.poll() {
                match event {
                    crate::audio::Event::Ready { job, plan } if self.audio_job == Some(job) => {
                        if let Some(old) = self.audio_plan.replace(plan) {
                            self.retired.push(Box::new(old));
                        }
                        self.audio_job = None;
                    }
                    crate::audio::Event::DeviceLost => {
                        self.audio_failed = true;
                        self.audio_error = true;
                        self.audio_job = None;
                        audio.stop();
                    }
                    crate::audio::Event::Failed { job, .. } if self.audio_job == Some(job) => {
                        self.audio_job = None;
                        audio.stop();
                        preparation_failed = true;
                    }
                    crate::audio::Event::Failed { .. } => {}
                    crate::audio::Event::Ready { plan, .. } => self.retired.push(Box::new(plan)),
                    crate::audio::Event::Started { .. } => {}
                }
            }
        }
        if preparation_failed {
            self.pause();
            stage.end_transport();
            return Err(Msg::new("native.timeline.audioPreparationFailed"));
        }
        if self.model.pending || !self.playing() {
            return Ok(());
        }
        if matches!(stage.status(), crate::stage::PaintStatus::Failed(_) | crate::stage::PaintStatus::Closed) {
            self.pause();
            stage.end_transport();
            return Err(Msg::new("native.timeline.frameUnavailable"));
        }
        if !self.audio_failed && self.audio_job.is_none() && self.audio_plan.is_none() {
            if let (Some(audio), Some(p)) = (&mut self.audio, &self.projection) {
                if p.audible {
                    let (first, end) = transport::normalize(self.transport.model.range, p.total);
                    self.audio_job = Some(audio.prepare(&p.audio, first as f64 / p.fps, end as f64 / p.fps, crate::audio::Then::Hold));
                }
            }
        }
        let next = self.transport.next(self.model.tick, self.model.total);
        let range = transport::normalize(self.transport.model.range, self.model.total);
        let startup = self.transport.model.state == State::Starting;
        let ready = match next
            .map(|next| stage.prepare_playback(next as u32, range.0..range.1, self.transport.model.looping, startup, self.model.fps))
        {
            None => true,
            Some(Ok(ready)) => ready,
            Some(Err(_)) => {
                self.pause();
                stage.end_transport();
                return Err(Msg::new("native.timeline.frameUnavailable"));
            }
        };
        let audible = self.projection.as_ref().is_some_and(|p| p.audible);
        let audio = if self.audio_failed || !audible {
            Audio::Silent
        } else if self.audio_job.is_some() || self.audio.is_none() {
            Audio::Preparing
        } else if self.transport.model.state == State::Starting && self.audio_plan.is_some() {
            Audio::Silent
        } else {
            use styk_services::audio::clock::Reading;
            match self.audio.as_ref().map(|audio| audio.reading()) {
                Some(Reading::Pending | Reading::Starting) => Audio::Starting,
                Some(Reading::Running { sample, .. }) => Audio::Running(sample / crate::audio::RATE as f64),
                _ => Audio::Silent,
            }
        };
        if let Some(demand) = self.transport.tick(now, self.model.tick, self.model.fps, self.model.total, audio, ready) {
            let previous = self.model.tick;
            self.seek(demand.tick, documents, session, None)?;
            if !self.audio_failed {
                if let (Some(audio), Some(_plan)) = (&mut self.audio, &self.audio_plan) {
                    if !matches!(audio.reading(), styk_services::audio::clock::Reading::Running { .. }) || demand.tick < previous {
                        audio.stop();
                        self.audio_start_on_submit = true;
                    }
                }
            }
            self.presentation = Some(demand);
        } else if self.transport.model.state == State::Buffering {
            if let Some(audio) = &mut self.audio {
                audio.stop();
            }
        } else if !self.playing() {
            self.pause();
            stage.end_transport();
        }
        Ok(())
    }
}
impl Drop for Panel {
    fn drop(&mut self) {
        if let Some(worker) = self.range_worker.take() {
            worker.shutdown(Box::new(std::mem::take(&mut self.range_current)));
        }
        if let Some(worker) = self.worker.take() {
            worker.shutdown(Box::new((self.projection.take(), std::mem::take(&mut self.retired), self.audio_plan.take())));
        }
    }
}
