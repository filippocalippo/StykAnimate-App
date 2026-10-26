//! Editing commands on the document store (docs/engine/editing.md, stage S5).
//!
//! An [`Editor`] holds a document (the JavaScript editor's report, as the mirror
//! receives it), the playhead, the selection, the gesture in progress and the
//! history, and runs the editor's commands on them so that they change the same
//! records into the same bytes, leave the same selection and emit the same change
//! events as the JavaScript editor did. The command-replay harness (`replay`) checks that step by step
//! against the recordings in `engine/tests/edit`.
//!
//! Ported so far: selecting, seeking, moving and transforming figures, posing,
//! rotating and bending joints, and undo and redo of what those record, on native
//! timelines (docs/engine/editing.md lists the calls). Every other call
//! answers [`EditError::Unported`], so a facade knows to run it in JavaScript.

mod audio;
mod authored;
mod builder;
mod drawing_pixels;
mod drawing_structure;
mod disconnect;
mod duplicate_drag;
mod bounds;
mod camera_bake;
mod camera_commands;
mod camera_motion;
mod combine;
mod camera_views;
mod clipboards;
mod figure_clipboard;
mod figure_discard;
mod figure_transform;
pub mod export;
mod args;
mod owner;
mod preview;
mod figures;
mod frame;
mod frame_draft;
mod interface;
mod handle_commands;
mod handle_edit;
mod history;
mod ik;
mod ik_settings;
mod layer_focus;
mod layer_membership;
mod layers;
pub mod load;
pub mod layer_planning;
pub mod movieclip_planning;
mod history_weight;
mod motion_path;
mod movieclips;
mod origin;
mod origin_topology;
mod movieclip_bake;
mod movieclip_commands;
mod movieclip_native;
mod onion_skins;
mod pose;
mod pose_choice;
mod pose_value;
mod palette;
pub mod prof;
pub mod patch;
mod polygons;
mod project;
pub mod publication;
mod property_edit;
mod range;
mod range_plan;
mod recolor;
mod record;
pub mod replay;
mod rig_behavior;
mod rig_drag;
mod scene_backgrounds;
mod select;
pub mod session;
mod sheet;
mod sheet_clipboard;
mod sheet_frames;
mod spatial;
mod spatial_ik;
mod spatial_shape;
mod timeline;
mod topology;
mod trails;
mod transform;
mod tweener;
mod vfx_clips;
mod vfx_stack;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::{Obj, Value};

pub use history::{Command, CommandKind, HistoryLimits};
pub use frame::FrameSlice;
pub use onion_skins::{Ghost, OnionSet, MAX_GHOSTS};
pub use layer_focus::FocusLock;
pub use select::Selection;

/// What a failed call says. `Unported` means "run this in JavaScript": the call
/// changed nothing.
#[derive(Debug, thiserror::Error)]
pub enum EditError {
    #[error("{0} is not ported to the engine yet")]
    Unported(String),
    #[error("{0}")]
    Invalid(String),
}

/// Separates an `Invalid` error's message key from the values its message names (JSON).
const PARAMS: char = '\u{1f}';

/// An `Invalid` error whose message names values (`messageError(error, key, params)`): a text param is
/// shown as it is, `{"@label": text}` is a field label the interface translates, `{"@motionParameter": {key, label}}`
/// a camera-motion parameter and `{"@vfxParameter": {type, param}}` an effect's,`{"@message": key}` a message of the interface.
pub(crate) fn invalid_with(key: &str, params: Vec<(&str, Value)>) -> EditError {
    let params: Obj = params.into_iter().map(|(name, value)| (Arc::from(name), value)).collect();
    EditError::Invalid(format!("{key}{PARAMS}{}", styk_doc::json::to_string(&Value::object(params))))
}

/// A number the message shows as the editor does: finite ones as numbers, the infinite as text.
fn shown(value: f64) -> Value {
    if value.is_finite() { Value::Num(value) } else { Value::str(if value > 0.0 { "Infinity" } else { "-Infinity" }) }
}

/// A value outside `[min, max]`: `{label} must be … between {low} and {high}`, the placeholders named `low` and `high`.
pub(crate) fn out_of_range(key: &str, name: &str, (low, high): (&str, &str), (min, max): (f64, f64)) -> EditError {
    invalid_with(key, vec![("label", label(name)), (low, shown(min)), (high, shown(max))])
}

/// A message the interface shows by its key (`{messageKey, diagnosticValue}`).
pub(crate) fn message(key: &str) -> Value {
    let mut reference = Obj::new();
    reference.set("@message", Value::str(key));
    Value::object(reference)
}

/// A field label the interface translates (`validationLabel(text)`).
pub(crate) fn label(text: &str) -> Value {
    let mut label = Obj::new();
    label.set("@label", Value::str(text));
    Value::object(label)
}

/// The message key of an `Invalid` error.
pub fn error_key(text: &str) -> &str {
    text.split(PARAMS).next().unwrap_or(text)
}

/// The values the message of an `Invalid` error names, if it names any.
pub fn error_params(text: &str) -> Option<Value> {
    let (_, params) = text.split_once(PARAMS)?;
    styk_doc::json::parse(params.as_bytes()).ok()
}

/// The editor's construction options (`new Editor({propertyChannels, layerTimeline})`)
/// and the settings the app gives it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    pub property_channels: bool,
    pub layer_timeline: bool,
    /// `editor.autoKey`: every edited track keys the playhead, held cells included.
    pub auto_key: bool,
}

/// A gesture in progress (`editor._drag`).
#[derive(Clone, Debug)]
pub(crate) struct Drag {
    pub label: String,
    /// `selection` (pose the selected subtrees) or `translation` (whole connected figures).
    pub translation: bool,
    pub index: usize,
    /// The affected objects as they were when the gesture began, in slot order.
    pub before: Vec<Value>,
    pub before_selection: select::SelectionState,
    pub changed: bool,
    /// Where figures detached from a parent outside the gesture were (`detachedOrigins`).
    pub detached: HashMap<u32, [f64; 2]>,
    /// The gesture edits a draft of the frame on show (a layer sheet), not a keyframe.
    pub authored: bool,
    /// A rotation's targets by selected slot, joint and isolation (`rotationTargets`): the
    /// figures' structure does not change during a gesture.
    pub rotation_targets: HashMap<(usize, usize, bool), Vec<(usize, usize)>>,
    /// 3D bone drags by `kind:uid:joint` (`spatialGesture`): each sample is solved from
    /// the gesture's fixed start. And the kind of each bone's drag (`spatialKinds`).
    pub spatial_gestures: HashMap<String, spatial::Gesture>,
    pub spatial_kinds: HashMap<String, &'static str>,
    /// A limb's capture by `uid:handle`, kept when it has a 3D target (`_drag.ikCapture`);
    /// the 3D parts alone (`spatialIKCapture`); where a depth push left a target (`ikResume`).
    pub ik_captures: HashMap<String, spatial_ik::Capture>,
    pub spatial_ik_captures: HashMap<String, spatial_ik::SpatialCapture>,
    pub ik_resume: HashMap<String, Option<[f64; 2]>>,
    /// A Handle Edit Mode gesture (`_drag.handleEdit`).
    pub handle_edit: Option<handle_edit::HandleEdit>,
    /// A whole-figure transform by a handle (`_drag.figureHandle`).
    pub figure_handle: Option<figure_transform::FigureHandle>,
    /// The options of a segment value edit (`_drag.segmentValueOptions`).
    pub segment_value_options: Option<Value>,
    /// A camera drag (`_drag.camera`).
    pub camera: Option<camera_commands::CameraDrag>,
    /// A rig edit by dragging (`_drag.rig`).
    pub rig: Option<rig_drag::RigDrag>,
    /// A motion-path edit (`_drag.motionPath`: the session is the gesture).
    pub motion_path: Option<Box<motion_path::Session>>,
    /// An Alt-drag duplication (`_drag.duplicate`): the copies held back from history until it ends.
    pub duplicate: Option<duplicate_drag::Duplicate>,
    /// The tweener's plan (`_drag.tweener`).
    pub tweener: Option<tweener::Tweener>,
    /// Which gesture this is: every gesture the editor opens has its own (the interface tells one from the next).
    pub serial: u64,
}

/// The draft of a gesture on a layer sheet (`editor._authoredPoseEdit`).
#[derive(Clone, Debug)]
pub(crate) struct Authored {
    /// The frame being edited: the evaluated frame with the gesture's changes.
    pub frame: Value,
    /// The evaluated frame the gesture started from.
    pub source: Value,
    pub tick: f64,
    /// A command's draft of the whole frame (`transaction`): figures may come and go.
    pub transaction: bool,
    /// Appended definitions of an authored transaction (`beforeFigures`).
    pub definitions_start: Option<usize>,
    /// A tween keys the playhead (`keyAtPlayhead`) on these layers (`keyAtPlayheadLayers`), even where nothing else changed.
    pub key_at_playhead: bool,
    pub key_at_playhead_layers: Vec<String>,
}

pub struct Editor {
    pub(crate) report: Value,
    pub(crate) options: Options,
    pub(crate) tick: f64,
    pub(crate) frame_index: usize,
    pub(crate) selection: Selection,
    pub(crate) selection_metadata: select::SelectionMetadata,
    pub(crate) drag: Option<Drag>,
    /// The serial of the last gesture opened (`Drag::serial`); it only grows.
    pub(crate) drag_serial: u64,
    pub(crate) authored: Option<Authored>,
    /// The draft of the last committed gesture, which the editor goes on showing as
    /// the evaluated frame until a seek, an edit or history invalidates it
    /// (`_authoredCommitPreview` kept in `_evaluated`). Usually equal to evaluating
    /// again; not after editing a movieclip's replaced frame between its keys.
    pub(crate) retained: Option<Value>,
    pub(crate) undo: Arc<Vec<history::Entry>>,
    pub(crate) redo: Arc<Vec<history::Entry>>,
    pub(crate) history_limits: history::HistoryLimits,
    pub(crate) history_size: f64,
    pub(crate) worker_history: bool,
    /// Disabled outside explicit replay: actual records at their owning linear point.
    pub(crate) replay_records: Option<Vec<Value>>,
    pub(crate) revision: u64,
    pub(crate) saved_revision: u64,
    pub(crate) revision_serial: u64,
    /// `editor.layerRevision`: named by the events of layer-sheet commands.
    pub(crate) layer_revision: u64,
    /// `_layerEventPending`: membership changes decorate the next edit/history event.
    pub(crate) layer_event_pending: bool,
    /// `editor._nextFrameIdentity`: the number of the next pose source (`frame-N`).
    pub(crate) next_frame_identity: u64,
    /// `editor._nextUid`: the unique id of the next new figure.
    pub(crate) next_uid: u64,
    /// How many poses hold each figure, over the keyframes and the pose sources
    /// (`_layerUidCounts`), and every figure seen so far (`_layerSeenUids`). Read
    /// from the document when first needed, then kept with every command.
    pub(crate) uid_counts: Option<(HashMap<u32, i64>, std::collections::HashSet<u32>)>,
    /// `auto_key` of [`Options`], which the app may change between calls.
    pub(crate) auto_key: bool,
    /// Pose sources this session captured, in order (`_generatedFrameSources`).
    pub(crate) generated_sources: Vec<String>,
    /// `_pendingSourceLayerChanges` and `_pendingSourceBytes`, consumed by the next record.
    pub(crate) pending_source_layer_changes: Vec<layers::LayerChange>,
    pub(crate) pending_source_bytes: usize,
    /// Whether the document came with a pose-source table (`_sourceTableWasPresent`).
    pub(crate) source_table_was_present: bool,
    /// The layer of each figure in the last published poses (`_newLayerHints`).
    pub(crate) new_layer_hints: HashMap<u32, String>,
    /// `editor._sheetClipboard`: the timeline frames this editor copied.
    pub(crate) sheet_clipboard: Option<sheet_clipboard::Clipboard>,
    /// `editor._selectionClipboard`: the figures this editor copied.
    pub(crate) figure_clipboard: Option<figure_clipboard::FigureClipboard>,
    /// `editor._segmentValuesClipboard`: the last copied `Angle:Bend:Length`.
    pub(crate) segment_values_clipboard: Option<String>,
    /// `editor._cameraClipboard`: the last copied camera.
    pub(crate) camera_clipboard: Option<Value>,
    /// `editor.audioRipple` (the app sets it) and `_audioRippling`: frame edits of every layer move the audio.
    pub(crate) audio_ripple: bool,
    pub(crate) audio_rippling: bool,
    /// The layers Focus and lock holds (`editor.getLayerFocus()` with a lock), as the view of the call in progress has them.
    pub(crate) focus_lock: Option<FocusLock>,
    /// Host-installed connected-selection policy; never supplied by command args/view or restored by history.
    pub(crate) selection_locks: Option<std::sync::Arc<crate::select::SelectionLocks>>,
    /// `editor._audioClipboard`: the last copied audio clip and its recording.
    pub(crate) audio_clipboard: Option<(Value, Value)>,
    /// `editor._cameraMotionClipboard`: the last copied camera motion clip.
    pub(crate) camera_motion_clipboard: Option<Value>,
    /// `editor._vfxClipClipboard` and `_vfxClipClipboardValues`: the last copied effect clip
    /// and its effects as they were at the playhead (`None` where they cannot be sampled here).
    pub(crate) vfx_clip_clipboard: Option<(Value, Option<Value>)>,
    /// What the editor drew at random for the call being made (`[kind, value]` in order:
    /// `uuid`, `seed`, `random`; src/editor-draws.mjs, D18), handed over with the call.
    pub(crate) draws: std::collections::VecDeque<(String, Value)>,
    /// The draws are a pool taken by kind, not the editor's recorded sequence (D19).
    pub(crate) draw_pool: bool,
    /// Drawing cels a call copied, `(old cel, new cel)`: the pixels of the old one belong to the new one too, which the
    /// interface (it holds the pixels) is told with the call's answer.
    pub(crate) drawing_forks: Vec<(String, String)>,
    /// The call retired a history entry that referred to the interface's drawings (pixel commits, cels): the interface lets go of
    /// what no entry refers to any more (`drawing_pixels.rs`).
    pub(crate) drawing_retired: bool,
    /// `editor._vfxClipEdit`: the effect clips before a gizmo edit in progress.
    pub(crate) vfx_edit: Option<Option<Value>>,
    /// `editor._movieclipBatch`: the entries of the batch in progress, recorded as one.
    pub(crate) batch: Option<history::Batch>,
    /// `editor._sheetSelection`: the layer chosen on the timeline.
    pub(crate) sheet_selection: Option<select::SheetSelection>,
    /// `editor._animationEdit` on a layer sheet, with its `_sheetPropertyPreview`.
    pub(crate) property_edit: Option<property_edit::Edit>,
    pub(crate) native_token: Option<builder::native::Token>,
    pub(crate) native_token_serial: u64,
    /// A movieclip being baked in slices (`movieclip_bake.rs`).
    pub(crate) bake: Option<movieclip_bake::Job>,
    /// The document field a live preview set without recording it (`preview.rs`).
    pub(crate) preview: Option<preview::Preview>,
    /// Change events since the last [`Editor::take_events`], as the editor's `change` details.
    pub(crate) events: Vec<Value>,
    /// Typed views and evaluated frames of the current document.
    pub(crate) eval: RefCell<frame::Cache>,
    /// What the interface was last told of the geometry of the frame on show (and of the motion-path display).
    pub(crate) shown: RefCell<[interface::Cache; 2]>,
    /// What the interface reads besides the frame on show: the motion-path trails, the onion skins and the camera's views.
    pub(crate) trails: RefCell<trails::Cache>,
    pub(crate) onions: RefCell<onion_skins::Cache>,
    pub(crate) camera_views: RefCell<camera_views::Cache>,
    /// The host's clock (milliseconds), which a read that is given a time to take is held to; without one it takes what it needs.
    pub(crate) clock: Option<fn() -> f64>,
    /// The last document checked for unported features, and the answer.
    gate: RefCell<Option<(Value, Option<&'static str>)>>,
}

/// What the interface reads after a call (the recordings hold the same).
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub tick: f64,
    pub frame_index: usize,
    pub selected_uid: Option<u32>,
    pub selected_uids: Vec<u32>,
    pub selected_joint: i64,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_label: String,
    pub redo_label: String,
    pub dirty: bool,
    pub layer_revision: u64,
    pub next_frame_identity: u64,
    pub next_uid: u64,
}

/// Everything a call may change, to put back when it turns out not to be ported.
struct Snapshot {
    report: Value,
    tick: f64,
    frame_index: usize,
    selection: Selection,
    selection_metadata: select::SelectionMetadata,
    drag: Option<Drag>,
    authored: Option<Authored>,
    retained: Option<Value>,
    undo: Arc<Vec<history::Entry>>,
    redo: Arc<Vec<history::Entry>>,
    history_size: f64,
    counters: [u64; 6],
    uid_counts: Option<(HashMap<u32, i64>, std::collections::HashSet<u32>)>,
    generated_sources: Vec<String>,
    pending_source_layer_changes: Vec<layers::LayerChange>,
    pending_source_bytes: usize,
    new_layer_hints: HashMap<u32, String>,
    layer_event_pending: bool,
    events: usize,
    sheet_clipboard: Option<sheet_clipboard::Clipboard>,
    figure_clipboard: Option<figure_clipboard::FigureClipboard>,
    segment_values_clipboard: Option<String>,
    camera_clipboard: Option<Value>,
    audio_clipboard: Option<(Value, Value)>,
    camera_motion_clipboard: Option<Value>,
    vfx_clip_clipboard: Option<(Value, Option<Value>)>,
    vfx_edit: Option<Option<Value>>,
    batch: Option<history::Batch>,
    sheet_selection: Option<select::SheetSelection>,
    property_edit: Option<property_edit::Edit>,
    native_token: Option<builder::native::Token>,
    native_token_serial: u64,
    preview: Option<preview::Preview>,
    drag_serial: u64,
}

impl Editor {
    /// An editor over `report`, a document the JavaScript editor has loaded (its
    /// normalization on load is not ported: phase 1 starts from the loaded report).
    pub fn new(report: Value, options: Options) -> Editor {
        let source_table_was_present = report.path(&["_styk", "frameSources"]).is_some();
        let next_frame_identity = next_frame_identity(&report);
        Editor {
            report,
            options,
            tick: 0.0,
            frame_index: 0,
            selection: Selection::default(),
            selection_metadata: select::SelectionMetadata::default(),
            drag: None,
            drag_serial: 0,
            authored: None,
            retained: None,
            undo: Arc::new(Vec::new()),
            redo: Arc::new(Vec::new()),
            history_limits: Default::default(),
            history_size: 0.0,
            worker_history: false,
            replay_records: None,
            revision: 0,
            saved_revision: 0,
            revision_serial: 0,
            layer_revision: 0,
            layer_event_pending: false,
            next_frame_identity,
            next_uid: 1,
            uid_counts: None,
            auto_key: options.auto_key,
            generated_sources: Vec::new(),
            pending_source_layer_changes: Vec::new(),
            pending_source_bytes: 0,
            source_table_was_present,
            new_layer_hints: HashMap::new(),
            sheet_clipboard: None,
            figure_clipboard: None,
            segment_values_clipboard: None,
            camera_clipboard: None,
            audio_clipboard: None,
            audio_ripple: false,
            audio_rippling: false,
            focus_lock: None,
            selection_locks: None,
            camera_motion_clipboard: None,
            vfx_clip_clipboard: None,
            draws: Default::default(),
            draw_pool: false,
            drawing_forks: Vec::new(),
            drawing_retired: false,
            vfx_edit: None,
            batch: None,
            sheet_selection: None,
            property_edit: None,
            native_token: None,
            native_token_serial: 0,
            bake: None,
            preview: None,
            events: Vec::new(),
            eval: RefCell::default(),
            shown: RefCell::default(),
            trails: RefCell::default(),
            onions: RefCell::default(),
            camera_views: RefCell::default(),
            clock: None,
            gate: RefCell::new(None),
        }
    }

    /// Puts the playhead and selection where the JavaScript editor has them (after
    /// loading, the editor selects and seeks on its own; phase 1 starts from there).
    pub fn set_view(&mut self, tick: f64, frame_index: usize, selection: Selection) {
        self.tick = tick;
        self.frame_index = frame_index;
        self.selection = selection;
    }

    /// The editor's counters that the document does not carry: the layer revision
    /// its events name, the number of the next pose source and the next figure identity.
    /// What the editor drew at random for the next call (`draws` of a recording or a session
    /// call: `[[kind, value], …]`); a call that draws takes them in order (D18).
    pub fn set_draws(&mut self, draws: &Value) {
        self.draws = draws
            .elements()
            .map(|e| e.iter().filter_map(|pair| Some((pair.item(0)?.as_str()?.to_string(), pair.item(1)?))).collect())
            .unwrap_or_default();
    }

    /// The next value the editor drew, of `kind`; a call without it is not ported here.
    pub(crate) fn draw(&mut self, kind: &str) -> Result<Value, EditError> {
        // A pool (D19): the owner hands a few values of each kind and the call takes
        // the next one of the kind it draws.
        if self.draw_pool {
            let at = self.draws.iter().position(|(drawn, _)| drawn == kind)
                .ok_or_else(|| EditError::Unported(format!("a call that draws more than the pool's {kind} values")))?;
            return Ok(self.draws.remove(at).expect("found above").1);
        }
        match self.draws.pop_front() {
            Some((drawn, value)) if drawn == kind => Ok(value),
            Some((drawn, _)) => Err(EditError::Unported(format!("a call that draws a {kind} where the editor drew a {drawn}"))),
            None => Err(EditError::Unported(format!("a call that draws a {kind} the editor did not hand over"))),
        }
    }

    /// `editorDraws.uuid()`.
    pub(crate) fn draw_uuid(&mut self) -> Result<String, EditError> {
        self.draw("uuid")?.as_str().map(str::to_string).ok_or_else(|| EditError::Unported("an identity that is not text".into()))
    }

    /// `editorDraws.seed()`.
    pub(crate) fn draw_seed(&mut self) -> Result<f64, EditError> {
        self.draw("seed")?.as_f64().ok_or_else(|| EditError::Unported("a seed that is not a number".into()))
    }

    /// `editorDraws.random()`.
    pub(crate) fn draw_random(&mut self) -> Result<f64, EditError> {
        self.draw("random")?.as_f64().ok_or_else(|| EditError::Unported("a fraction that is not a number".into()))
    }

    pub fn set_counters(&mut self, layer_revision: u64, next_frame_identity: u64, next_uid: u64) {
        self.layer_revision = layer_revision;
        self.next_frame_identity = next_frame_identity;
        self.next_uid = next_uid;
    }

    /// The document's small revision counters when a worker editor adopts the
    /// live owner. Their exact digits are part of enumerable history weights.
    pub fn set_revision_counters(&mut self, revision: u64, serial: u64, saved: u64) {
        self.revision = revision; self.revision_serial = serial; self.saved_revision = saved;
    }

    pub fn report(&self) -> &Value {
        &self.report
    }

    /// The report as the mirror sends it: `JSON.stringify(report)` without `runtime_segments`.
    pub fn report_json(&self) -> String {
        styk_doc::json::to_string(&record::without_runtime(&self.report))
    }

    pub fn take_events(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.events)
    }

    pub fn state(&self) -> State {
        State {
            tick: self.tick,
            frame_index: self.frame_index,
            selected_uid: self.selection.uid,
            selected_uids: self.selection.uids.clone(),
            selected_joint: self.selection.joint,
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            undo_label: self.undo.last().map(|c| c.label.clone()).unwrap_or_default(),
            redo_label: self.redo.last().map(|c| c.label.clone()).unwrap_or_default(),
            dirty: self.revision != self.saved_revision || self.drag.as_ref().is_some_and(|d| d.changed) || self.property_edit.as_ref().is_some_and(|e| e.changed),
            layer_revision: self.layer_revision,
            next_frame_identity: self.next_frame_identity,
            next_uid: self.next_uid,
        }
    }

    /// `editor.autoKey`, which the app sets from its settings.
    pub fn set_auto_key(&mut self, auto_key: bool) {
        self.auto_key = auto_key;
    }

    /// `editor.activeLayerId = id` when it differs (selection sets it in the editor
    /// without a new revision, so a session's document may be behind).
    /// The timeline's layer selection as the facade holds it (`editor._sheetSelection`).
    pub fn set_sheet_selection(&mut self, chosen: Option<(&str, bool)>) {
        self.sheet_selection = chosen.map(|(id, contents)| select::SheetSelection { id: id.to_string(), contents });
    }

    pub fn set_active_layer_id(&mut self, id: &str) {
        if self.report.path(&["_styk", "layers", "activeId"]).and_then(Value::as_str) != Some(id) && self.report.path(&["_styk", "layers"]).is_some() {
            self.set_active_layer(id);
        }
    }

    /// The state as JSON, in the key order the recordings hold it.
    pub fn state_value(&self) -> Value {
        let _scope = crate::prof::scope("editor::state_value");
        let state = self.state();
        // These fixed response keys already are in JavaScript enumeration order.
        // Construct their existing shape once instead of rebuilding it (and its
        // lookup map) for each missing-key assignment on every pointer move.
        let fields = [
            ("tick", Value::Num(state.tick)),
            ("frameIndex", Value::Num(state.frame_index as f64)),
            ("selectedUid", state.selected_uid.map_or(Value::Null, |u| Value::Num(u as f64))),
            ("selectedUids", Value::array(state.selected_uids.iter().map(|&u| Value::Num(u as f64)).collect())),
            ("selectedJoint", Value::Num(state.selected_joint as f64)),
            ("canUndo", Value::Bool(state.can_undo)),
            ("canRedo", Value::Bool(state.can_redo)),
            ("undoLabel", Value::str(&state.undo_label)),
            ("redoLabel", Value::str(&state.redo_label)),
            ("dirty", Value::Bool(state.dirty)),
            ("layerRevision", Value::Num(state.layer_revision as f64)),
            ("nextFrameIdentity", Value::Num(state.next_frame_identity as f64)),
            ("nextUid", Value::Num(state.next_uid as f64)),
        ];
        let (keys, values): (Vec<std::sync::Arc<str>>, Vec<Value>) = fields.into_iter().map(|(key, value)| (std::sync::Arc::from(key), value)).unzip();
        let mut object = styk_doc::Obj::from_shape(styk_doc::Shape::new(keys), values);
        if self.selection_metadata.polygon.is_some() || self.selection_metadata.segments.is_some() || self.selection_metadata.branch.is_some() {
            self.selection_state().write_metadata(&mut object);
        }
        Value::object(object)
    }

    /// The serial of the next gesture the editor opens (`Drag::serial`).
    pub(crate) fn next_drag_serial(&mut self) -> u64 {
        self.drag_serial += 1;
        self.drag_serial
    }

    /// The figures the gesture in progress took, as they are in its draft (without
    /// the clip sample times evaluation adds); `None` outside a gesture on a sheet.
    /// The gesture in progress as a facade needs it: the identities of the figures it
    /// snapshots and whether it moves whole connected figures. `Null` between gestures.
    /// A rig edit or a camera move says so (`rig`, `camera`): the editor runs those by their
    /// own state, which the owner rebuilds by replaying the calls that made them.
    pub fn drag_value(&self) -> Value {
        let Some(drag) = &self.drag else { return Value::Null };
        let mut value = Obj::new();
        value.set("before", Value::array(drag.before.iter().filter_map(record::uid).map(|u| Value::Num(u as f64)).collect()));
        value.set("translation", Value::Bool(drag.translation));
        value.set("label", Value::str(&drag.label));
        value.set("changed", Value::Bool(drag.changed));
        value.set("serial", Value::Num(drag.serial as f64));
        if drag.rig.is_some() {
            value.set("rig", Value::Bool(true));
        }
        if drag.camera.is_some() {
            value.set("camera", Value::Bool(true));
        }
        Value::object(value)
    }

    /// The committed gesture's draft the editor keeps on show until a seek, an edit or
    /// history invalidates it (`_authoredCommitPreview`), if any.
    pub fn retained_frame(&self) -> Option<Value> {
        self.retained.clone()
    }

    pub fn draft_figures(&self) -> Option<Vec<Value>> {
        let (drag, edit) = (self.drag.as_ref()?, self.authored.as_ref()?);
        let taken: Vec<u32> = drag.before.iter().filter_map(record::uid).collect();
        let figures = frame::objects_of(&edit.frame).into_iter().filter(|o| record::uid(o).is_some_and(|u| taken.contains(&u))).map(|figure| {
            let mut figure = figure.as_obj().cloned().unwrap_or_default();
            figure.remove("_movieclipSample");
            Value::object(figure)
        });
        Some(figures.collect())
    }

    /// Runs one editor call by its JavaScript name, with JSON arguments; returns what
    /// the JavaScript method returns.
    pub fn call(&mut self, method: &str, args: &[Value]) -> Result<Value, EditError> {
        self.call_checked_impl(method, args, false, &mut || Ok(()))
    }

    /// Worker-only native projection/authored preparation. The callback is
    /// borrowed into the existing dispatch/owners; never stored on the Editor.
    pub(crate) fn call_worker_checked(
        &mut self,
        method: &str,
        args: &Value,
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<Value, EditError> {
        let args = args
            .elements()
            .map(|items| items.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        if !self.options.property_channels || self.sheet() {
            check()?;
            return self.call(method, &args);
        }
        self.call_checked_impl(method, &args, true, check)
    }

    fn call_checked_impl(
        &mut self,
        method: &str,
        args: &[Value],
        worker: bool,
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<Value, EditError> {
        self.call_checked_layer_publication(method, args, worker, check, None, None)
    }

    /// Opt-in Session capture borrowed through the original checked dispatch.
    /// No publication state is retained on the editor or in history.
    pub(crate) fn call_layer_publication(&mut self, method: &str, args: &[Value], publication: &mut Option<Value>) -> Result<Value, EditError> {
        self.call_checked_layer_publication(method, args, false, &mut || Ok(()), Some(publication), None)
    }

    /// Read duplicate's temporary clipboard before the original owner restores
    /// the saved one. The capture is borrowed only for this checked command.
    pub(crate) fn call_duplicate_pastes_checked(&mut self, method: &str, args: &[Value], worker: bool, check: &mut dyn FnMut() -> Result<(), EditError>, pastes: &mut Option<Value>) -> Result<Value, EditError> {
        if worker && (!self.options.property_channels || self.sheet()) {
            // Same ordinary-call delegation and checks as call_worker_checked.
            check()?;
            return self.call_checked_layer_publication(method, args, false, &mut || Ok(()), None, Some(pastes));
        }
        self.call_checked_layer_publication(method, args, worker, check, None, Some(pastes))
    }

    fn call_checked_layer_publication(
        &mut self,
        method: &str,
        args: &[Value],
        worker: bool,
        check: &mut dyn FnMut() -> Result<(), EditError>,
        publication: Option<&mut Option<Value>>,
        duplicate_pastes: Option<&mut Option<Value>>,
    ) -> Result<Value, EditError> {
        // Policy correction precedes the command snapshot: a refused call must not
        // restore remotely denied IDs imported by a stale Session view.
        if method == "selectConnected" { self.enforce_connected_selection_locks(); }
        let snapshot = self.snapshot();
        let result = check().and_then(|()| self.dispatch_layer_publication(method, args, worker, check, publication, duplicate_pastes));
        let result = result.and_then(|value| check().map(|()| value));
        if matches!(result, Err(EditError::Unported(_))) || (worker && result.is_err()) {
            self.restore(snapshot);
        }
        result
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            report: self.report.clone(),
            tick: self.tick,
            frame_index: self.frame_index,
            selection: self.selection.clone(),
            selection_metadata: self.selection_metadata.clone(),
            drag: self.drag.clone(),
            authored: self.authored.clone(),
            retained: self.retained.clone(),
            undo: self.undo.clone(),
            redo: self.redo.clone(),
            history_size: self.history_size,
            counters: [self.revision, self.saved_revision, self.revision_serial, self.layer_revision, self.next_frame_identity, self.next_uid],
            uid_counts: self.uid_counts.clone(),
            generated_sources: self.generated_sources.clone(),
            pending_source_layer_changes: self.pending_source_layer_changes.clone(),
            pending_source_bytes: self.pending_source_bytes,
            new_layer_hints: self.new_layer_hints.clone(),
            layer_event_pending: self.layer_event_pending,
            events: self.events.len(),
            sheet_clipboard: self.sheet_clipboard.clone(),
            figure_clipboard: self.figure_clipboard.clone(),
            segment_values_clipboard: self.segment_values_clipboard.clone(),
            camera_clipboard: self.camera_clipboard.clone(),
            audio_clipboard: self.audio_clipboard.clone(),
            camera_motion_clipboard: self.camera_motion_clipboard.clone(),
            vfx_clip_clipboard: self.vfx_clip_clipboard.clone(),
            vfx_edit: self.vfx_edit.clone(),
            batch: self.batch.clone(),
            sheet_selection: self.sheet_selection.clone(),
            property_edit: self.property_edit.clone(),
            native_token: self.native_token.clone(),
            native_token_serial: self.native_token_serial,
            preview: self.preview.clone(),
            drag_serial: self.drag_serial,
        }
    }

    fn restore(&mut self, mut snapshot: Snapshot) {
        self.exchange_snapshot(&mut snapshot);
        self.events.truncate(snapshot.events);
    }

    /// Exchanges the existing rollback owner's heads without dropping them.
    /// Prepared worker publication retains the displaced snapshot until ACK.
    fn exchange_snapshot(&mut self, snapshot: &mut Snapshot) {
        macro_rules! swap {
            ($($field:ident),+ $(,)?) => { $(std::mem::swap(&mut self.$field, &mut snapshot.$field);)+ };
        }
        swap!(report, tick, frame_index, selection, selection_metadata, drag, authored, retained, undo,
            redo, history_size, uid_counts, generated_sources,
            pending_source_layer_changes, pending_source_bytes, new_layer_hints,
            layer_event_pending, sheet_clipboard, figure_clipboard,
            segment_values_clipboard, camera_clipboard, audio_clipboard, camera_motion_clipboard,
            vfx_clip_clipboard, vfx_edit, batch, sheet_selection, property_edit,
            native_token, native_token_serial, preview, drag_serial);
        for (actual, captured) in [
            &mut self.revision, &mut self.saved_revision,
            &mut self.revision_serial, &mut self.layer_revision,
            &mut self.next_frame_identity, &mut self.next_uid,
        ].into_iter().zip(&mut snapshot.counters) {
            std::mem::swap(actual, captured);
        }
    }

    fn dispatch_checked(&mut self, method: &str, args: &[Value], worker: bool, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        self.dispatch_layer_publication(method, args, worker, check, None, None)
    }

    fn dispatch_layer_publication(&mut self, method: &str, args: &[Value], worker: bool, check: &mut dyn FnMut() -> Result<(), EditError>, publication: Option<&mut Option<Value>>, duplicate_pastes: Option<&mut Option<Value>>) -> Result<Value, EditError> {
        // The owner's bookkeeping (D19, owner.rs) is not a command: no document gate applies.
        match method {
            "@historyLimits" => return self.configure_history(args),
            "@markSaved" => return self.mark_saved(),
            "@touch" => return self.mark_changed(),
            "@publishCel" => return self.publish_cel(args),
            "@drawingBytes" => return self.set_pixels_bytes(args),
            "@retractDrawing" => return self.retract_pixels(args),
            "@setClipboard" => return self.set_clipboard(args),
            "@revisions" => return self.set_revisions(args),
            // A grouped edit (`movieclipBatch`) is bookkeeping around the edits it holds: no document gate applies.
            "beginBatch" => return self.begin_batch(args.first().and_then(Value::as_str).unwrap_or("")).map(|_| Value::Null),
            "endBatch" => return self.end_batch().map(|_| Value::Null),
            "abortBatch" => return self.abort_batch().map(|_| Value::Null),
            _ => {}
        }
        self.end_preview_for(method);
        let projected_native=worker && self.native_projected_call(method,args);
        if worker && self.options.property_channels && !self.sheet() { self.native_projected_gate(method,args,check)?; }
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        // A JSON argument that is not a number is NaN to the finite checks, as `Number.isFinite` sees it.
        let number = |i: usize| arg(i).as_f64().unwrap_or(f64::NAN);
        self.native_transform_gate(method, args, projected_native)?;
        if let Some(reason) = self.unported_document() {
            // A document with animation origins runs every command: the ones that pose figures synchronize the pivots.
            if !reason.starts_with("with animation origins")
                && !(self.recorded_native_movieclip_call(method, args, reason) || self.recorded_native_transform_call(method) || self.recorded_native_motion_call(method) || projected_native || self.recorded_native_draw_call(method, reason)) {
                return Err(EditError::Unported(format!("{method} {reason}")));
            }
            if method == "moveSelectionInFrames" && !self.sheet() {
                return Err(EditError::Unported("moving animation-origin figures across native keyframes".into()));
            }
            if matches!(method, "joinTo" | "unjoinFigure" | "joinFigure") {
                self.origin_range_gate(&self.selection_frame()?, &self.selection.uids, if method == "unjoinFigure" { None } else { arg(0).as_f64().map(|id| id as u32) })?;
            }
            if origin::choice_call(method) { self.origin_choice_gate()?; }
            if origin::constraint_call(method) { self.origin_constraint_gate(method, args)?; }
            if origin::posing_call(method) || origin::rig_pose_call(method) { self.origin_pose_gate()?; }
            if origin::gesture_call(method) { self.origin_gesture_gate(method)?; }
            if origin::rig_tool_call(method) { self.origin_rig_gate()?; }
            if origin::property_call(method) { self.origin_property_gate(method, args)?; }
        }
        if self.native_movieclip_mutation(method, args) && self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            return Err(EditError::Unported(format!("{method} with a saved working frame")));
        }
        if let Some(reason) = self.ik_gate(method, args)? {
            return Err(EditError::Unported(format!("{method} {reason}")));
        }
        self.native_property_gate(method)?;
        self.property_gate_checked(method,projected_native)?;
        self.camera_gate(method)?;
        self.motion_path_gate(method)?;
        if let Some(result) = self.motion_path_call(method, args) {
            return result;
        }
        if let Some(result) = self.property_call_checked(method, args, check) {
            return result;
        }
        if let Some(result) = self.range_call(method, args) {
            return result;
        }
        if let Some(result) = self.builder_call(method, args) {
            return result;
        }
        if let Some(result) = self.rig_call(method, args) {
            return result;
        }
        if let Some(result) = self.topology_call(method, args) {
            return result;
        }
        match method {
            "select" | "@select" => {
                // `select(uid, {toggle, add})` is `select(uid, -1, {toggle, add})`.
                let (joint, options) = if arg(1).is_object() { (-1, arg(1)) } else { (arg(1).as_f64().unwrap_or(-1.0) as i64, arg(2)) };
                let flag = |key| options.get(key).is_some_and(Value::truthy);
                self.select(arg(0).as_f64().filter(|v| v.fract() == 0.0 && *v >= 0.0).map(|v| v as u32), joint, flag("toggle"), flag("add"))
            }
            "selectConnected" => self.select_connected(args),
            "selectMany" => self.select_many(&arg(0).numbers().unwrap_or_default().into_iter().map(|v| v as u32).collect::<Vec<_>>()),
            "selectPolygon" => self.select_polygon(select::index(args.first()).and_then(|id| u32::try_from(id).ok()), select::index(args.get(1))).map(Value::Bool),
            "toggleSegment" => self.toggle_segment(select::index(args.first()).and_then(|id| u32::try_from(id).ok()), select::index(args.get(1))).map(Value::Bool),
            "selectBranch" => self.select_branch(select::index(args.first()).and_then(|id| u32::try_from(id).ok()), select::index(args.get(1))).map(Value::Bool),
            "seek" | "@seek" => self.seek_checked(arg(0).as_f64().unwrap_or(0.0),check),
            "beginDrag" => {
                let translation = match arg(1).get("scope").and_then(Value::as_str) {
                    None | Some("selection") => false,
                    Some("translation") => true,
                    Some(other) => return Err(EditError::Unported(format!("beginDrag with scope {other}"))),
                };
                self.begin_drag_checked(arg(0).as_str().unwrap_or("Pose figure"), translation, check).map(Value::Bool)
            }
            "commitDrag" => self.commit_drag_checked(check).map(Value::Bool),
            "cancelDrag" => self.cancel_drag().map(Value::Bool),
            "disableFrameDrafts" => self.disable_frame_drafts(),
            // A working frame cannot be open here (the interface never opens one on a layer sheet).
            "beginFrameDraftPreview" | "endFrameDraftPreview" => Ok(Value::Bool(false)),
            "enableFrameDrafts" | "beginFrameDraft" | "commitFrameDraft" | "discardFrameDraft" | "updateDraftFrame" | "addDraftFrame" | "editFrameDraftTimeline" | "editStoredFrames" =>
                Err(EditError::Unported("working frames are not edited by the engine".into())),
            "beginTween" => self.begin_tween(),
            "updateTween" => self.update_tween(&arg(0), args.get(1)).map(Value::Bool),
            "beginDuplicateDrag" => self.begin_duplicate_drag(&arg(0)).map(Value::Bool),
            "finishDuplicateDrag" => self.finish_duplicate_drag(arg(0).truthy()).map(Value::Bool),
            "beginHandleEditDrag" => self.begin_handle_edit_drag(&arg(0)).map(Value::Bool),
            "editHandlePosition" => self.edit_handle_position(number(0), number(1), &arg(2)).map(Value::Bool),
            "commitHandleEditDrag" => self.finish_handle_edit_drag(true).map(Value::Bool),
            "cancelHandleEditDrag" => self.finish_handle_edit_drag(false).map(Value::Bool),
            "beginFigureHandleDrag" => self.begin_figure_handle_drag(arg(0).as_f64(), arg(1).as_f64(), &arg(2)).map(Value::Bool),
            "transformFigureHandle" => self.transform_figure_handle(number(0), number(1), &arg(2)).map(Value::Bool),
            "commitFigureHandleDrag" => self.finish_figure_handle_drag(true).map(Value::Bool),
            "cancelFigureHandleDrag" => self.finish_figure_handle_drag(false).map(Value::Bool),
            "copyCamera" => self.copy_camera(),
            "pasteCamera" => self.paste_camera(&arg(0)),
            "setCameraValues" => self.set_camera_values(&arg(0), &arg(1)),
            "resetCamera" => self.reset_camera(&arg(0)),
            "transformCamera" => self.transform_camera(&arg(0), &arg(1)),
            "centerCamera" => self.center_camera(arg(0).as_str().unwrap_or(if args.is_empty() { "both" } else { "" }), &arg(1), &arg(2)),
            "alignSelection" => self.align_selection(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""), &arg(2)),
            "alignCameraToView" => self.align_camera_to_view(&arg(0), &arg(1)),
            "locateCamera" => self.locate_camera(arg(0).as_f64().unwrap_or(if arg(0).is_null() { -1.0 } else { f64::NAN }), arg(1).as_str().unwrap_or(if arg(1).is_null() { "position" } else { "" }), &arg(2)),
            "locateHandle" => self.locate_handle(arg(0).as_f64().unwrap_or(if arg(0).is_null() { -1.0 } else { f64::NAN }), &arg(1)).map(Value::Bool),
            "applyCameraToFigures" => self.apply_camera_to_figures(&arg(0), &arg(1)),
            "beginCameraDrag" => self.begin_camera_drag(&arg(0)).map(Value::Bool),
            "updateCameraDrag" => self.update_camera_drag(&arg(0), &arg(1)).map(Value::Bool),
            "commitCameraDrag" => self.commit_camera_drag().map(Value::Bool),
            "cancelCameraDrag" => self.cancel_camera_drag().map(Value::Bool),
            "nudgeHandle" => self.nudge_handle(number(0), number(1), &arg(2)).map(Value::Bool),
            "alignHandle" => self.align_handle(number(0), number(1), &arg(2)).map(Value::Bool),
            "locateEditedHandle" => self.locate_edited_handle(arg(0).as_f64().unwrap_or(if arg(0).is_null() { -1.0 } else { f64::NAN }), &arg(1)).map(Value::Bool),
            "segmentValues" => self.segment_values(&arg(0)),
            "beginSegmentValueEdit" => self.begin_segment_value_edit(&arg(0)).map(Value::Bool),
            "setSegmentValues" => self.set_segment_values(&arg(0), &arg(1)).map(Value::Bool),
            "copySegmentValues" => self.copy_segment_values(&arg(0)),
            "pasteSegmentValues" => { let text = args.first().cloned(); self.paste_segment_values(text.as_ref(), &arg(1)).map(Value::Bool) }
            "beginTranslationDrag" => self.begin_drag(arg(0).as_str().unwrap_or("Move figures"), true).map(Value::Bool),
            "moveSelection" => self.move_selection_checked(arg(0).as_f64().unwrap_or(f64::NAN), arg(1).as_f64().unwrap_or(f64::NAN), &arg(2), check).map(Value::Bool),
            "rotateSelection" => self.rotate_selection(number(0), &arg(1)).map(Value::Bool),
            "scaleSelection" => self.scale_selection(number(0), &arg(1), false).map(Value::Bool),
            "scaleSelected" => self.scale_selection(number(0), &arg(1), true).map(Value::Bool),
            "mirrorSelection" => self.mirror_selection(&arg(0), &arg(1)).map(Value::Bool),
            "rotateFigure" => self.rotate_figure(number(0)).map(Value::Bool),
            "centerFigure" => self.center_figure().map(Value::Bool),
            "resetPose" => self.reset_pose().map(Value::Bool),
            "poseJoint" => self.pose_joint(number(0), number(1), &arg(2)).map(Value::Bool),
            "setConnectorPosition" => self.set_connector_position(number(0)).map(Value::Bool),
            "slideConnector" => self.slide_selected_connector(number(0), number(1)).map(Value::Bool),
            "setSpatialPose" => self.set_spatial_pose(&arg(0), &arg(1)).map(Value::Bool),
            "setSpatialIKTarget" => self.set_spatial_ik_target(&arg(0)).map(Value::Bool),
            "importSceneBackground" => self.import_scene_background(&arg(0), &arg(1)),
            "renameSceneBackground" => self.rename_scene_background(&arg(0), &arg(1)).map(Value::Bool),
            "assignFiguresToLayer" => self.assign_figures_to_layer(&arg(0), &arg(1)).map(Value::Bool),
            "deleteLayer" => self.delete_layer(&arg(0), &arg(1)).map(Value::Bool),
            "createDrawingLayer" => self.create_drawing_layer(&arg(0)),
            "addDrawingFrame" => self.add_drawing_frame(&arg(0), &arg(1)),
            "nextDrawing" => self.next_drawing(&arg(0), &arg(1)).map(Value::Bool),
            "extendDrawing" => self.extend_drawing(&arg(0), &arg(1)).map(Value::Bool),
            "drawingKey" => self.drawing_key(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "autoKeyDrawing" => self.auto_key_drawing(&arg(0), &arg(1)).map(Value::Bool),
            "commitDrawingPixels" => self.commit_drawing_pixels(&arg(0), &arg(1), &arg(2)),
            "resampleDrawing" => self.resample_drawing(&arg(0), &arg(1)),
            "bakeCameraMotion" => self.bake_camera_motion(&arg(0)).map(Value::Bool),
            "setSpatialCamera" => self.set_spatial_camera(&arg(0)).map(Value::Bool),
            "setSpatialProportions" => self.set_spatial_proportions(&arg(0)).map(Value::Bool),
            "resetSpatialProportions" => self.reset_spatial_proportions().map(Value::Bool),
            "setAudioTrack" => self.set_audio_track(&arg(0), &arg(1)).map(Value::Bool),
            "deleteAudioTrack" => self.delete_audio_track(&arg(0)).map(Value::Bool),
            "addAudioTrack" => self.add_audio_track(args.first()),
            "importAudio" => self.import_audio(&arg(0), args.get(1)),
            "splitAudioClip" => self.split_audio_clip(&arg(0), args.get(1)),
            "duplicateAudioClip" => self.duplicate_audio_clip(&arg(0)),
            "copyAudioClip" => self.copy_audio_clip(&arg(0)).map(Value::Bool),
            "cutAudioClip" => self.cut_audio_clip(&arg(0)).map(Value::Bool),
            "pasteAudioClip" => self.paste_audio_clip(&arg(0), args.get(1)),
            "rippleAudio" => self.ripple_audio(number(0), number(1), number(2)).map(Value::Bool),
            "setAudioClip" => self.set_audio_clip(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "deleteAudioClip" => self.delete_audio_clip(&arg(0)).map(Value::Bool),
            "addPaletteColor" => self.add_palette_color(&arg(0)).map(Value::Bool),
            "addPaletteColors" => self.add_palette_colors(&arg(0)),
            "removePaletteColor" => self.remove_palette_color(&arg(0)).map(Value::Bool),
            "movePaletteColor" => self.move_palette_color(&arg(0), &arg(1)).map(Value::Bool),
            "setCameraMotion" => self.set_camera_motion(&arg(0), &arg(1)).map(Value::Bool),
            "deleteCameraMotion" => self.delete_camera_motion(&arg(0)).map(Value::Bool),
            "addVfx" => self.add_vfx(&arg(0), &arg(1)),
            "removeVfx" => self.remove_vfx(&arg(0), &arg(1)),
            "resetVfx" => self.reset_vfx(&arg(0), &arg(1)),
            "duplicateVfx" => self.duplicate_vfx(&arg(0), &arg(1)),
            "moveVfx" => self.move_vfx(&arg(0), &arg(1), &arg(2)),
            "reorderVfx" => self.reorder_vfx(&arg(0), &arg(1), &arg(2)),
            "pasteVfx" => self.paste_vfx(&arg(0), &arg(1), &arg(2)),
            "setVfxScope" => self.set_vfx_scope(&arg(0), &arg(1)),
            "applyVfxPreset" => self.apply_vfx_preset(&arg(0), &arg(1)),
            "copyCameraMotion" => Ok(Value::Bool(self.copy_camera_motion(&arg(0)))),
            "pasteCameraMotion" => self.paste_camera_motion(arg(0).as_f64()),
            "duplicateCameraMotion" => self.duplicate_camera_motion(&arg(0), arg(1).as_f64()),
            "addCameraMotion" => self.add_camera_motion(&arg(0), &arg(1)),
            "randomizeCameraMotion" => self.randomize_camera_motion(&arg(0)).map(Value::Bool),
            "updateSegment" => self.update_segment(&arg(0)).map(Value::Bool),
            "updateObject" => self.update_object(&arg(0)).map(Value::Bool),
            "discardNewFigure" => self.discard_new_figure(&arg(0), &arg(1)).map(Value::Bool),
            "updateSelection" => self.update_selection(&arg(0)).map(Value::Bool),
            "addMovieclipToNextKeyframes" if self.sheet() => self.inline_timeline(|editor, worker| editor.extend_sheet_movieclip(number(0), worker)),
            "addMovieclipToNextKeyframes" => self.extend_native_movieclip(number(0)),
            // Samples the whole clip frame by frame and publishes it as one entry: bounded (5000 frames, 250000 poses), run inline.
            "previewCameraMotion" => self.preview_camera_motion(&arg(0), &arg(1)).map(Value::Bool),
            "previewLayerParallax" => self.preview_layer_parallax(&arg(0), &arg(1)).map(Value::Bool),
            "cancelDocumentPreview" => Ok(Value::Bool(self.cancel_document_preview())),
            "bakeMovieclip" => self.inline_timeline(|editor, worker| editor.bake_movieclip_worker(worker)),
            // The same bake in slices, for the interface to give the thread back between them.
            "bakeMovieclipBegin" => self.inline_timeline(|editor, worker| editor.begin_bake(worker)),
            "bakeMovieclipSample" => self.inline_timeline(|editor, worker| editor.sample_bake(number(0), worker)),
            "bakeMovieclipPublish" => self.inline_timeline(|editor, worker| editor.publish_bake(worker)),
            "bakeMovieclipCancel" => Ok(Value::Bool(self.bake.take().is_some())),
            "setFrameDuration" if self.sheet() => self.sheet_set_duration(number(0), &Value::Null, &Value::Null).map(Value::Bool),
            "setFrameDuration" => Err(EditError::Unported("setFrameDuration on a native timeline".into())),
            "addFigure" => self.add_figure((!args.is_empty()).then(|| arg(0)).as_ref()),
            "renameLayer" => self.rename_layer_publication(&arg(0), &arg(1), publication).map(Value::Bool),
            "setLayerColor" => self.set_layer_color(&arg(0), &arg(1), publication).map(Value::Bool),
            "setLayerVisible" => self.set_layer_flag(&arg(0), "visible", &arg(1), publication).map(Value::Bool),
            "setLayerLocked" => self.set_layer_flag(&arg(0), "locked", &arg(1), publication).map(Value::Bool),
            "reorderLayers" => self.reorder_layers(&arg(0), publication).map(Value::Bool),
            "moveLayerTo" => self.move_layer_to(&arg(0), &arg(1), publication).map(Value::Bool),
            "createLayer" => self.create_layer(&arg(0), &arg(1), publication),
            "createLayerFolder" => self.create_layer_folder((!args.is_empty()).then(|| arg(0)).as_ref(), &arg(1), publication),
            "renameLayerFolder" => self.rename_layer_folder(&arg(0), &arg(1), publication).map(Value::Bool),
            "moveLayersToFolder" => self.move_layers_to_folder(&arg(0), &arg(1), publication).map(Value::Bool),
            "arrangeLayers" => self.arrange_layers(&arg(0), (args.len() > 1).then(|| arg(1)).as_ref(), (args.len() > 2).then(|| arg(2)).as_ref(), publication).map(Value::Bool),
            "deleteLayerFolder" => self.delete_layer_folder(&arg(0), publication).map(Value::Bool),
            "rotateIKTarget" => self.rotate_ik_target(number(0)).map(Value::Bool),
            "setSpatialFeetPinned" => self.set_spatial_feet_pinned(&arg(0)).map(Value::Bool),
            "setNodeIK" => self.set_node_ik(&arg(0)).map(Value::Bool),
            "setPoseChoice" => self.set_pose_choice(&arg(0), number(1)).map(Value::Bool),
            "resetSpatialPose" => self.reset_spatial_pose(arg(0).truthy()).map(Value::Bool),
            "setSpatialMotion" => self.set_spatial_motion(number(0), arg(1).get("fraction").is_some_and(Value::truthy)).map(Value::Bool),
            "rotateJoint" => self.rotate_joint(number(0), &arg(1)).map(Value::Bool),
            "bendJoint" => self.bend_joint(number(0), number(1), &arg(2)).map(Value::Bool),
            "selectSheetLayer" => self.select_sheet_layer(&arg(0), &arg(1)).map(Value::Bool),
            "keepSelectionOnSeek" => {
                self.keep_selection_on_seek();
                Ok(Value::Null)
            }
            "setActiveLayer" => self.set_active_layer_command(&arg(0)).map(Value::Bool),
            // A replay step: `movieclipBatch(label, () => steps)`, returning the last step's result.
            "@batch" => {
                let steps: Vec<Value> = arg(1).elements().map(|e| e.iter().collect()).unwrap_or_default();
                self.begin_batch(arg(0).as_str().unwrap_or(""))?;
                let mut last = Value::Null;
                for step in steps {
                    let call: Vec<Value> = step.elements().map(|e| e.iter().collect()).unwrap_or_default();
                    let name = call.first().and_then(Value::as_str).unwrap_or("").to_string();
                    match self.dispatch_checked(&name, call.get(1..).unwrap_or(&[]), worker, check) {
                        Ok(value) => last = value,
                        Err(error) => {
                            if matches!(error, EditError::Invalid(_)) {
                                self.abort_batch()?;
                            }
                            return Err(error);
                        }
                    }
                }
                self.end_batch()?;
                Ok(last)
            }
            "beginVfxClipEdit" => self.begin_vfx_clip_edit(),
            "commitVfxClipEdit" => self.commit_vfx_clip_edit().map(Value::Bool),
            "cancelVfxClipEdit" => self.cancel_vfx_clip_edit().map(Value::Bool),
            "setVfxClip" => self.set_vfx_clip(&arg(0), &arg(1)).map(Value::Bool),
            "trimVfxClipStart" => self.trim_vfx_clip_start(&arg(0), &arg(1)).map(Value::Bool),
            "deleteVfxClip" => self.delete_vfx_clip(&arg(0)).map(Value::Bool),
            "moveVfxClipOrder" => self.move_vfx_clip_order(&arg(0), &arg(1)).map(Value::Bool),
            "reorderVfxGroupEffect" => self.reorder_vfx_group_effect(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "addVfxClip" => self.add_vfx_clip(&arg(0), &arg(1), &arg(2)),
            "addVfxGroup" => self.add_vfx_group(&arg(0), &arg(1), &arg(2)),
            "addVfxUserPreset" => self.add_vfx_user_preset(&arg(0), &arg(1), &arg(2)),
            "copyVfxClip" => self.copy_vfx_clip(&arg(0)).map(Value::Bool),
            "pasteVfxClip" => self.paste_vfx_clip(&arg(0), &arg(1)),
            "duplicateVfxClip" => self.duplicate_vfx_clip(&arg(0)),
            "addVfxGroupEffect" => self.add_vfx_group_effect(&arg(0), &arg(1)),
            "setVfxClipParameter" => {
                let mut values = Obj::new();
                match arg(2).as_str() {
                    Some(param) => values.set(param, arg(3)),
                    None => return Err(EditError::Unported("an effect parameter name that is not text".into())),
                }
                self.set_vfx_clip_parameters(&arg(0), &arg(1), &Value::object(values), &arg(4)).map(Value::Bool)
            }
            "setVfxClipParameters" => self.set_vfx_clip_parameters(&arg(0), &arg(1), &arg(2), &arg(3)).map(Value::Bool),
            "toggleVfxClipKey" => self.toggle_vfx_clip_key(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "moveVfxClipKey" => self.move_vfx_clip_key(&arg(0), &arg(1), &arg(2), &arg(3)).map(Value::Bool),
            "moveVfxClipKeys" => self.move_vfx_clip_keys(&arg(0), &arg(1), &arg(2), &arg(3)).map(Value::Bool),
            "deleteVfxClipKeys" => self.delete_vfx_clip_keys(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "setVfxClipEasing" => self.set_vfx_clip_easing(&arg(0), &arg(1), &arg(2), &arg(3)).map(Value::Bool),
            "createEmptyMovieclip" => self.create_empty_movieclip(&arg(0)),
            "createMovieclip" => self.create_movieclip(&arg(0)),
            "makeMovieclipUnique" => self.make_movieclip_unique(),
            "placeMovieclip" => self.place_native_movieclip(&arg(0), arg(1).get("move").is_some_and(Value::truthy)),
            "splitMovieclip" => self.split_native_movieclip(args.first().map(|v| v.as_f64().unwrap_or(f64::NAN)).unwrap_or(self.tick)),
            "breakApartMovieclip" => self.break_apart_movieclip(),
            "renameMovieclip" => self.rename_movieclip(&arg(0)),
            "publishMovieclipEdit" => self.publish_movieclip_edit(&arg(0), &arg(1), &arg(2)),
            "restartMovieclip" => self.restart_movieclip(),
            "removeMovieclipRestart" => self.remove_movieclip_restart(),
            "setMovieclipPlayback" => self.set_movieclip_playback(&arg(0), &arg(1)),
            "setMovieclipDrawing" => self.set_movieclip_drawing(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "setLayerParallax" => self.set_layer_parallax(&arg(0), &arg(1), publication).map(Value::Bool),
            "setFPS" => self.set_fps(&arg(0), &arg(1)).map(Value::Bool),
            "setCanvasSize" => self.set_canvas_size(&arg(0), &arg(1)).map(Value::Bool),
            "updateProject" => self.update_project(&arg(0), &arg(1)).map(Value::Bool),
            "copySelection" => {
                let flag = |name: &str| args.first().and_then(|o| o.get(name)).is_some_and(Value::truthy);
                self.copy_selection_of(flag("wholeFigures"), flag("inPlace"))
            }
            "cutSelection" => self.cut_selection(),
            "pasteSelection" => self.paste_selection(&arg(0)),
            "importFigure" => self.import_figure(&arg(0), &arg(1)),
            "duplicateSelection" => match duplicate_pastes {
                Some(pastes) => self.duplicate_selection_pastes(&arg(0), Some(pastes)),
                None => self.duplicate_selection(&arg(0)),
            },
            "addPolygon" => self.add_polygon(&arg(0), &arg(1)),
            "updatePolygon" => match args.get(1) {
                None => self.update_polygon(&arg(0), &Value::Null),
                Some(Value::Null) => Err(EditError::Unported("a polygon change that is null".into())),
                Some(patch) => self.update_polygon(&arg(0), patch),
            },
            "removePolygon" => self.remove_polygon(&arg(0)),
            "sheetCopyFrames" => match arg(1).as_f64() {
                Some(start) => self.sheet_copy_frames(&arg(0), start, &arg(2)),
                None => Err(EditError::Unported("copying frames from a frame that is not a number".into())),
            },
            "sheetTransferFrames" => match (arg(2).as_f64(), arg(3).as_f64()) {
                (Some(start), Some(end)) => self.sheet_transfer_frames(&arg(0), &arg(1), start, end, &arg(4), &arg(5)),
                _ => Err(EditError::Unported("transferring frames of a range that is not numbers".into())),
            },
            "sheetPasteFrames" => self.sheet_paste_frames(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "sheetMoveFrames" => self.sheet_move_frames(&arg(0), number(1), number(2), &arg(3), &arg(4)).map(Value::Bool),
            "sheetInsertKey" => self.sheet_insert_key(&arg(0), &arg(1), &arg(2)).map(Value::Bool),
            "sheetDuplicateFrameAfter" => self.sheet_duplicate_frame_after(&arg(0), &arg(1)).map(Value::Bool),
            "sheetSetEasing" => self.sheet_set_easing(&arg(0), number(1), number(2), &arg(3)).map(Value::Bool),
            "sheetClearKeys" => self.sheet_clear_keys(&arg(0), number(1), &arg(2)).map(Value::Bool),
            "sheetClearFrames" => self.sheet_clear_frames(&arg(0), number(1), &arg(2)).map(Value::Bool),
            "sheetInsertFrames" => self.sheet_insert_frames(&arg(0), number(1), &arg(2)).map(Value::Bool),
            "sheetRemoveFrames" => self.sheet_remove_frames(&arg(0), number(1), &arg(2)).map(Value::Bool),
            "sheetSetDuration" => self.sheet_set_duration(number(0), &arg(1), &arg(2)).map(Value::Bool),
            "sheetAppendFrame" => self.sheet_append_frame(&arg(0)),
            "joinTo" => self.join_to(arg(0).as_f64(), &arg(1)).map(Value::Bool),
            "unjoinFigure" => self.unjoin_figure().map(Value::Bool),
            "joinFigure" => if arg(0).is_null() { self.unjoin_figure() } else { self.join_to(arg(0).as_f64(), &arg(1)) }.map(Value::Bool),
            "deleteSelection" | "deleteFigure" => self.delete_selection().map(Value::Bool),
            "duplicateFigure" => self.duplicate_figure(),
            "disconnectSegment" => self.disconnect_segment(),
            "combineJoinedFigure" => self.combine_joined_figure(args.first(), args.get(1)),
            "undo" => self.undo().map(Value::Bool),
            "redo" => self.redo().map(Value::Bool),
            other => Err(EditError::Unported(other.to_string())),
        }
    }

    /// Why the document's commands still run in JavaScript, if they do. The answer
    /// is kept for as long as the document does not change.
    fn unported_document(&self) -> Option<&'static str> {
        if let Some((report, reason)) = self.gate.borrow().as_ref()
            && report.same_node(&self.report)
        {
            return *reason;
        }
        let reason = self.scan_unported();
        *self.gate.borrow_mut() = Some((self.report.clone(), reason));
        reason
    }

    /// What phase 1 has not ported yet, found by reading the whole document.
    fn scan_unported(&self) -> Option<&'static str> {
        let styk = self.report.get("_styk");
        let sheet = styk.and_then(|s| s.get("layerSheet"));
        let list = |value: Option<&Value>| -> Vec<Value> { value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default() };
        if sheet.is_none() && (self.options.property_channels || self.options.layer_timeline) {
            // The app's editor gives every document a layer sheet when it loads it.
            return Some("with property channels on a native timeline");
        }
        if styk.and_then(|s| s.path(&["animation", "channels"])).and_then(Value::array_len).unwrap_or(0) > 0 {
            return Some("with property channels");
        }
        // The editor authors a movieclip's own document through its layer sheet; on a native timeline it edits the
        // keyframes of a document that retains a source differently from the session.
        if sheet.is_none() && styk.and_then(|s| s.get("movieclipSource")).is_some() {
            return Some("inside a movieclip on a native timeline");
        }
        let figures = list(self.report.get("figure_types"));
        if figures.iter().any(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)) {
            if sheet.and_then(|sheet| sheet.path(&["legacyAnimation", "channels"])).and_then(Value::array_len).unwrap_or(0) > 0 {
                return Some("with animation origins and property channels");
            }
            return Some("with animation origins");
        }
        // IK controllers are gated per call, on the frame on show (`ik_gate`).
        None
    }

    /// Emits a change event: `{kind, frameIndex, tick, structural: false, timing: false, ...detail}`.
    pub(crate) fn emit(&mut self, kind: &str, detail: Vec<(&str, Value)>) {
        let mut detail = detail;
        if self.layer_event_pending && ["edit", "history", "document"].contains(&kind) {
            detail.insert(0, ("layers", Value::Bool(true)));
            detail.insert(1, ("layerRevision", Value::Num(self.layer_revision as f64)));
            self.layer_event_pending = false;
        }
        // `_emit`: a seek follows the timeline's layer selection; any other selection drops it.
        if kind == "seek" {
            let _ = self.follow_sheet_selection();
        }
        if kind == "selection" && !detail.iter().any(|(key, value)| *key == "sheetSelection" && value.truthy()) {
            self.sheet_selection = None;
        }
        let mut object = styk_doc::Obj::new();
        object.set("kind", Value::str(kind));
        object.set("frameIndex", Value::Num(self.frame_index as f64));
        object.set("tick", Value::Num(self.tick));
        object.set("structural", Value::Bool(false));
        object.set("timing", Value::Bool(false));
        for (key, value) in detail {
            object.set(key, value);
        }
        self.events.push(Value::object(object));
    }
}

/// `validateFrameIdentitySteps`: one past the largest `frame-N` among the keyframes
/// and the pose sources.
fn next_frame_identity(report: &Value) -> u64 {
    let number = |id: Option<&str>| id.and_then(|id| id.strip_prefix("frame-")).filter(|n| !n.starts_with('0')).and_then(|n| n.parse::<u64>().ok());
    let frames = report.get("keyframes").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
    let keyed = frames.iter().filter_map(|frame| number(frame.path(&["_styk", "frameId"]).and_then(Value::as_str)));
    let sources = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).map(|table| table.keys().filter_map(|id| number(Some(id))).collect::<Vec<_>>()).unwrap_or_default();
    keyed.chain(sources).max().map_or(1, |largest| largest + 1)
}

#[cfg(test)]
mod drawing_pixels_tests;

#[cfg(test)]
mod native_motion_history_tests;

#[cfg(test)]
mod native_projection_tests;

#[cfg(test)]
mod interface_tests;

#[cfg(test)]
mod views_tests;
