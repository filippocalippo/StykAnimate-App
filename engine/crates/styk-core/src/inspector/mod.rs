//! The Properties panel's logic (the reference slice of `docs/native/patterns.md`).
//!
//! - [`model`]: the view model, one descriptor per context, plain data the interface draws with a generic kit.
//! - [`contexts`]: builds it from the session's reads and the view state (a port of `src/inspector-view.mjs`).
//! - [`property`]: the number properties and the gesture that edits one through the session.
//! - [`memory`]: which titled sections are open.
//! - [`Panel`]: the panel's own state (the field being edited, its gesture, pages, tabs) and [`Panel::update`], which
//!   turns an [`Event`] from the view into session calls and [`Effect`]s.
//!
//! The view model is rebuilt only when its key changes (the document, its revision, the frame on show, the selection,
//! the playhead, the view state, the section memory, the panel state) and never while a property gesture is open: today
//! the Inspector defers its refresh during a gesture and never reflows a field being typed in.

pub mod contexts;
pub mod facts;
pub mod memory;
pub mod model;
pub mod property;

use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::commands::{Effect, Notice, Severity};
use crate::documents::{CallAnswer, DocumentId, Documents, DocumentsError};
use crate::i18n::Msg;
use crate::number::{NumberEdit, Range, Settled, StepKeys};
use crate::view_state::ViewState;
use memory::SectionMemory;
use model::{Choice, ColorTarget, Inspector, Pager, RenameTarget, Segments, Toggle};
use property::{Gesture, PropertyKey, Reach};

/// What a number field reports (the scrub label's [`ScrubLabel`] events and the input's).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scrub {
    Begin,
    Delta { dx: f64, keys: StepKeys },
    End,
    Cancel,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FieldEvent {
    Focus,
    Blur,
    Input(String),
    Enter,
    Escape,
    Scrub(Scrub),
    /// An arrow key (+1 up, -1 down) with its modifiers; holding it repeats inside one gesture.
    KeyStep { direction: i32, keys: StepKeys },
    KeyEnd,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RenameEvent {
    Begin,
    Input(String),
    Commit,
    Cancel,
}

/// What the Properties panel's view sends.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Field(PropertyKey, FieldEvent),
    Toggle(Toggle, bool),
    Choose(Choice, Arc<str>),
    Section { id: &'static str, open: bool },
    Page(Pager, i32),
    Segment(Segments, &'static str),
    Color(ColorTarget),
    Rename(RenameEvent),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CameraTab {
    #[default]
    Transform,
    Motion,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ConnectorPart {
    Segment,
    #[default]
    Slider,
}

/// The panel's own state that its view model depends on.
#[derive(Clone, Debug, Default)]
pub struct PanelState {
    pub camera_tab: CameraTab,
    pub connector_part: ConnectorPart,
    pub palette_page: usize,
    pub fills_page: usize,
    /// The camera pose `camera-copy` copied, which `camera-paste` pastes.
    pub camera_clipboard: Option<Value>,
    /// The selection's bounds, read with the model (several figures' X, Y, W, H).
    pub bounds: Option<[f64; 4]>,
    version: u64,
}

/// The number field being edited: its model (typed text, the open gesture's value) and its session gesture.
#[derive(Debug)]
struct Field {
    key: PropertyKey,
    edit: NumberEdit,
    gesture: Option<Gesture>,
    /// The input holds focus (a scrub does not focus it).
    focused: bool,
    /// Several figures with different values: leaving without an edit keeps "Mixed".
    mixed: bool,
}

/// What the view shows of the field being edited.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldView {
    pub key: PropertyKey,
    pub text: String,
    pub invalid: Option<Msg>,
}

/// The name being typed in the header (rename in place).
#[derive(Clone, Debug, PartialEq)]
pub struct RenameView {
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
struct Key {
    document: DocumentId,
    revision: u64,
    frame: Value,
    selection: (Option<u32>, Vec<u32>, i64),
    tick: u64,
    view: u64,
    memory: u64,
    panel: u64,
}

/// The Properties panel.
#[derive(Debug, Default)]
pub struct Panel {
    state: PanelState,
    memory: SectionMemory,
    field: Option<Field>,
    rename: Option<String>,
    hinted: bool,
    model: Option<Arc<Inspector>>,
    key: Option<Key>,
    /// How many times the model was built (tests and the timing read it).
    pub builds: u64,
}

fn call(documents: &mut Documents, id: DocumentId, method: &str, args: &[Value]) -> Result<CallAnswer, Msg> {
    match documents.call(id, method, args, &Value::Null) {
        Ok(answer) => match &answer.result {
            Ok(_) => Ok(answer),
            Err(error) => Err(crate::commands::refusal(error)),
        },
        Err(error) => Err(documents_refusal(error)),
    }
}

fn documents_refusal(error: DocumentsError) -> Msg {
    Msg::owned(error.message_key().to_owned())
}

fn warn(message: Msg) -> Effect {
    Effect::Notice(Notice { message, severity: Severity::Warning })
}

fn object(pairs: &[(&str, Value)]) -> Value {
    let mut obj = Obj::new();
    for (key, value) in pairs {
        obj.set(key, value.clone());
    }
    Value::object(obj)
}

impl Panel {
    pub fn new(memory: SectionMemory) -> Panel {
        Panel { memory, ..Panel::default() }
    }

    pub fn memory(&self) -> &SectionMemory {
        &self.memory
    }

    /// The current view model (as of the last [`Panel::refresh`]).
    pub fn model(&self) -> Option<&Arc<Inspector>> {
        self.model.as_ref()
    }

    /// The field being edited, as the view shows it.
    pub fn field(&self) -> Option<FieldView> {
        let field = self.field.as_ref()?;
        let text = if field.mixed && !field.edit.gesture_open() { String::new() } else { field.edit.text() };
        let invalid = field.edit.invalid().map(|invalid| match invalid {
            crate::number::Invalid::NotANumber => Msg::new("propertyControls.enterAFiniteNumber"),
            crate::number::Invalid::OutOfRange(range) => Msg::new("propertyControls.enterValueBetween").with("min", range.min).with("max", range.max),
        });
        Some(FieldView { key: field.key, text, invalid })
    }

    pub fn rename(&self) -> Option<RenameView> {
        self.rename.as_ref().map(|text| RenameView { text: text.clone() })
    }

    /// Whether a property gesture is open (the model is not refreshed meanwhile).
    pub fn gesture_open(&self) -> bool {
        self.field.as_ref().is_some_and(|field| field.gesture.is_some())
    }

    fn bump(&mut self) {
        self.state.version = self.state.version.wrapping_add(1);
    }

    /// Rebuilds the view model if anything it is built from changed. Cheap when nothing did: a key comparison.
    pub fn refresh(&mut self, documents: &Documents, view: &ViewState) {
        if self.gesture_open() && self.model.is_some() {
            return;
        }
        let Some(document) = documents.active() else {
            self.model = None;
            self.key = None;
            return;
        };
        let frame = document.frame_records().unwrap_or(Value::Null);
        let selection = document.selection();
        let session = document.view();
        let key = Key {
            document: document.id(),
            revision: document.revision(),
            frame: frame.clone(),
            selection: (selection.uid, selection.uids.clone(), selection.joint),
            tick: session.tick.to_bits(),
            view: view.version(),
            memory: self.memory.version(),
            panel: self.state.version,
        };
        let same = self.key.as_ref().is_some_and(|old| old.frame.same_node(&key.frame) && Key { frame: Value::Null, ..old.clone() } == Key { frame: Value::Null, ..key.clone() });
        if same && self.model.is_some() {
            return;
        }
        self.state.bounds = if selection.uids.len() > 1 { document.selection_bounds().ok().flatten() } else { None };
        let built = contexts::build(document, &contexts::Inputs { view, memory: &self.memory, panel: &self.state });
        for section in &built.sections {
            if section.place == model::Place::Titled && !section.auto {
                self.memory.rule_released(built.kind.id(), section.id);
            }
        }
        self.builds += 1;
        if self.model.as_deref() != Some(&built) {
            self.model = Some(Arc::new(built));
        }
        self.key = Some(key);
    }

    fn row(&self, key: PropertyKey) -> Option<&model::NumberRow> {
        self.model.as_ref()?.number(key)
    }

    /// The frames an edit reaches (Edit together): their indices, and the ticks they start at.
    pub(crate) fn reach(documents: &Documents, id: DocumentId, view: &ViewState) -> Reach {
        let Some(frames) = view.range_frames() else { return Reach::default() };
        let Some(document) = documents.get(id) else { return Reach::default() };
        let mut indices = frames.to_vec();
        let current = document.view().frame_index;
        if !indices.contains(&current) {
            indices.push(current);
            indices.sort_unstable();
        }
        let rows = styk_edit::timeline_rows(document.records());
        let ticks = indices.iter().filter_map(|index| rows.get(*index).map(|row| row.0)).collect();
        Reach { ticks: Some(ticks), indices: Some(indices) }
    }

    /// Ends the field's session gesture with the field model's outcome: a commit is one history entry, anything else
    /// cancels. A refused commit puts the field back to where the gesture began and tells the person why.
    fn settle(&mut self, documents: &mut Documents, settled: Settled, effects: &mut Vec<Effect>) {
        let Some(field) = self.field.as_mut() else { return };
        let Some(mut gesture) = field.gesture.take() else { return };
        match settled {
            Settled::Committed(value) => {
                let initial = gesture.initial;
                match gesture.preview(documents, value).and_then(|_| gesture.commit(documents)) {
                    Ok(true) => effects.push(Effect::RequestFrame),
                    Ok(false) => {}
                    Err(message) => {
                        field.edit.set_value(initial);
                        effects.push(warn(message));
                        effects.push(Effect::RequestFrame);
                    }
                }
            }
            Settled::Cancelled(_) | Settled::Unchanged => {
                gesture.cancel(documents);
                effects.push(Effect::RequestFrame);
            }
        }
    }

    /// Opens the session gesture of the field when it has none yet (`_begin` runs on every input until one begins).
    fn ensure_gesture(&mut self, documents: &mut Documents, id: DocumentId, view: &ViewState, effects: &mut Vec<Effect>) -> bool {
        let Some(field) = self.field.as_mut() else { return false };
        if field.gesture.is_some() {
            return true;
        }
        match Gesture::begin(documents, id, field.key, field.edit.value(), Self::reach(documents, id, view)) {
            Ok(gesture) => {
                field.gesture = Some(gesture);
                true
            }
            Err(message) => {
                effects.push(warn(message));
                false
            }
        }
    }

    fn preview(&mut self, documents: &mut Documents, effects: &mut Vec<Effect>) {
        let Some(field) = self.field.as_mut() else { return };
        let value = field.edit.value();
        if let Some(gesture) = field.gesture.as_mut() {
            match gesture.preview(documents, value) {
                Ok(true) => effects.push(Effect::RequestFrame),
                Ok(false) => {}
                Err(message) => {
                    // A refused preview ends the gesture where it began (`assertCurrent` cancels; a bad value is refused).
                    if let Some(gesture) = field.gesture.take() {
                        field.edit.set_value(gesture.initial);
                        gesture.cancel(documents);
                    }
                    effects.push(warn(message));
                    effects.push(Effect::RequestFrame);
                }
            }
        }
    }

    /// Makes `key` the field being edited, ending another field's gesture first (a second gesture commits the first).
    fn take_field(&mut self, documents: &mut Documents, key: PropertyKey, effects: &mut Vec<Effect>) -> bool {
        if self.field.as_ref().is_some_and(|field| field.key == key) {
            return true;
        }
        self.finish(documents, effects);
        let Some(row) = self.row(key) else { return false };
        if row.disabled {
            return false;
        }
        let edit = NumberEdit::new(row.value, Range { min: row.min, max: row.max }, 1.0, row.precision);
        self.field = Some(Field { key, edit, gesture: None, focused: false, mixed: row.mixed });
        true
    }

    /// Commits whatever the panel has open (`propertyControls.commit()` before another edit, undo, a tab switch).
    pub fn finish(&mut self, documents: &mut Documents, effects: &mut Vec<Effect>) {
        let Some(field) = self.field.as_mut() else { return };
        // Whichever of the field's gestures is open ends committed: typing (or a held key), else a scrub.
        let settled = match field.edit.blur() {
            Settled::Unchanged => field.edit.scrub_end(),
            other => other,
        };
        self.settle(documents, settled, effects);
        self.field = None;
    }

    /// Abandons whatever the panel has open (the document changed under it, Escape in a scrub).
    pub fn cancel(&mut self, documents: &mut Documents) {
        if let Some(gesture) = self.field.take().and_then(|field| field.gesture) {
            gesture.cancel(documents);
        }
    }

    /// Runs one event of the panel's view against the active document.
    pub fn update(&mut self, documents: &mut Documents, view: &mut ViewState, event: Event) -> Vec<Effect> {
        let mut effects = Vec::new();
        let Some(id) = documents.active().map(|document| document.id()) else { return effects };
        match event {
            Event::Field(key, event) => self.field_event(documents, view, id, key, event, &mut effects),
            Event::Toggle(toggle, on) => {
                self.finish(documents, &mut effects);
                let result = match toggle {
                    Toggle::ApplyRange => {
                        view.set_apply_range(on);
                        Ok(())
                    }
                    Toggle::StaticJoint => call(documents, id, "updateBuilderSegmentStyle", &[object(&[("static", Value::Bool(on))]), object(&[("branch", Value::Bool(false))])]).map(|_| ()),
                    Toggle::SecondaryColor => {
                        let gradient = if on { object(&[("color", Value::str("#ffffff"))]) } else { Value::Null };
                        call(documents, id, "updateBuilderSegmentStyle", &[object(&[("gradient", gradient)]), object(&[("branch", Value::Bool(false))])]).map(|_| ())
                    }
                    Toggle::BuilderBranch => Err(Msg::new("errors.engineOwner.notSupported")),
                };
                Self::report(result, &mut effects);
            }
            Event::Choose(choice, value) => {
                self.finish(documents, &mut effects);
                let result = match choice {
                    Choice::SegmentShape => call(documents, id, "convertSegment", &[Value::str(&value)]).map(|_| ()),
                    Choice::FigureLayer => {
                        let uids = documents.get(id).map(|document| document.selection().uids.iter().map(|uid| Value::Num(f64::from(*uid))).collect()).unwrap_or_default();
                        call(documents, id, "assignFiguresToLayer", &[Value::array(uids), Value::str(&value)]).and_then(|answer| {
                            if answer.result.as_ref().is_ok_and(Value::truthy) {
                                call(documents, id, "setActiveLayer", &[Value::str(&value)])?;
                            }
                            Ok(())
                        })
                    }
                };
                Self::report(result, &mut effects);
            }
            Event::Section { id: section, open } => {
                if let Some(model) = &self.model {
                    let auto = model.section(section).is_some_and(|section| section.auto);
                    self.memory.toggle(model.kind.id(), section, open, auto);
                }
            }
            Event::Page(pager, step) => {
                let page = match pager {
                    Pager::Palette => &mut self.state.palette_page,
                    Pager::Fills => &mut self.state.fills_page,
                };
                *page = page.saturating_add_signed(step as isize);
                self.bump();
            }
            Event::Segment(Segments::CameraTab, value) => {
                self.finish(documents, &mut effects);
                self.state.camera_tab = if value == "motion" { CameraTab::Motion } else { CameraTab::Transform };
                self.bump();
            }
            Event::Segment(Segments::ConnectorPart, value) => {
                self.state.connector_part = if value == "segment" { ConnectorPart::Segment } else { ConnectorPart::Slider };
                self.bump();
            }
            Event::Color(target) => {
                self.finish(documents, &mut effects);
                effects.push(Effect::PickColor(target));
            }
            Event::Rename(event) => self.rename_event(documents, id, event, &mut effects),
        }
        effects
    }

    fn report(result: Result<(), Msg>, effects: &mut Vec<Effect>) {
        match result {
            Ok(()) => effects.push(Effect::RequestFrame),
            Err(message) => effects.push(warn(message)),
        }
    }

    fn rename_event(&mut self, documents: &mut Documents, id: DocumentId, event: RenameEvent, effects: &mut Vec<Effect>) {
        let Some(rename) = self.model.as_ref().and_then(|model| model.target.rename.clone()) else {
            self.rename = None;
            return;
        };
        match event {
            RenameEvent::Begin => {
                self.finish(documents, effects);
                self.rename = Some(self.model.as_ref().map(|model| model.target.name.english()).unwrap_or_default());
            }
            RenameEvent::Input(text) => {
                if self.rename.is_some() {
                    let text = match rename.max_chars {
                        Some(limit) => text.chars().take(limit).collect(),
                        None => text,
                    };
                    self.rename = Some(text);
                }
            }
            RenameEvent::Cancel => self.rename = None,
            RenameEvent::Commit => {
                // Enter or leaving the field commits; a blank name keeps the old one.
                let Some(text) = self.rename.take() else { return };
                if text.trim().is_empty() {
                    return;
                }
                let result = match rename.target {
                    RenameTarget::Figure => call(documents, id, "updateFigureStyle", &[object(&[("name", Value::str(&text))])]),
                    RenameTarget::Layer => {
                        let layer = documents.get(id).map(|document| facts::active_layer(document.records())).unwrap_or_else(|| Arc::from("layer-1"));
                        call(documents, id, "renameLayer", &[Value::str(&layer), Value::str(&text)])
                    }
                };
                Self::report(result.map(|_| ()), effects);
            }
        }
    }

    fn field_event(&mut self, documents: &mut Documents, view: &ViewState, id: DocumentId, key: PropertyKey, event: FieldEvent, effects: &mut Vec<Effect>) {
        match event {
            FieldEvent::Focus => {
                if !self.take_field(documents, key, effects) {
                    return;
                }
                if !self.hinted {
                    self.hinted = true;
                    effects.push(Effect::ScrubHint(Msg::new("inspector.scrubHint")));
                }
                if let Some(field) = self.field.as_mut() {
                    field.focused = true;
                    field.edit.focus();
                }
                self.ensure_gesture(documents, id, view, effects);
            }
            FieldEvent::Blur => {
                if let Some(field) = self.field.as_mut().filter(|field| field.key == key) {
                    let settled = field.edit.blur();
                    field.focused = false;
                    // A scrub of the label owns the field until it ends.
                    if field.edit.gesture_open() {
                        return;
                    }
                    self.settle(documents, settled, effects);
                    self.field = None;
                }
            }
            FieldEvent::Input(text) => {
                if !self.take_field(documents, key, effects) {
                    return;
                }
                // The session gesture begins from the value before this edit (`_typed` begins, then previews).
                let began = self.ensure_gesture(documents, id, view, effects);
                if let Some(field) = self.field.as_mut() {
                    field.mixed = false;
                    field.edit.input(text);
                    if field.edit.invalid().is_some() {
                        return;
                    }
                }
                if began {
                    self.preview(documents, effects);
                }
            }
            FieldEvent::Enter => {
                if let Some(field) = self.field.as_mut().filter(|field| field.key == key) {
                    let settled = field.edit.enter();
                    self.settle(documents, settled, effects);
                    effects.push(Effect::Blur);
                }
            }
            FieldEvent::Escape => {
                if let Some(field) = self.field.as_mut().filter(|field| field.key == key) {
                    let settled = if field.focused { field.edit.escape() } else { field.edit.scrub_cancel() };
                    self.settle(documents, settled, effects);
                    if !self.field.as_ref().is_some_and(|field| field.focused) {
                        self.field = None;
                    }
                }
            }
            FieldEvent::Scrub(Scrub::Begin) => {
                if !self.take_field(documents, key, effects) {
                    return;
                }
                if let Some(field) = self.field.as_mut() {
                    // A press on the label commits the open input gesture and begins the scrub's.
                    let settled = field.edit.scrub_begin();
                    field.mixed = false;
                    self.settle(documents, settled, effects);
                }
                self.ensure_gesture(documents, id, view, effects);
            }
            FieldEvent::Scrub(Scrub::Delta { dx, keys }) => {
                if let Some(field) = self.field.as_mut().filter(|field| field.key == key) {
                    field.edit.scrub_move(dx, keys);
                    self.preview(documents, effects);
                }
            }
            FieldEvent::Scrub(Scrub::End) => {
                if let Some(field) = self.field.as_mut().filter(|field| field.key == key) {
                    let settled = field.edit.scrub_end();
                    self.settle(documents, settled, effects);
                    if !self.field.as_ref().is_some_and(|field| field.focused) {
                        self.field = None;
                    }
                }
            }
            FieldEvent::Scrub(Scrub::Cancel) => {
                if let Some(field) = self.field.as_mut().filter(|field| field.key == key) {
                    let settled = field.edit.scrub_cancel();
                    self.settle(documents, settled, effects);
                    if !self.field.as_ref().is_some_and(|field| field.focused) {
                        self.field = None;
                    }
                }
            }
            FieldEvent::KeyStep { direction, keys } => {
                if !self.take_field(documents, key, effects) {
                    return;
                }
                let began = self.ensure_gesture(documents, id, view, effects);
                if let Some(field) = self.field.as_mut() {
                    field.mixed = false;
                    field.edit.key_step(direction, keys);
                }
                if began {
                    self.preview(documents, effects);
                }
            }
            FieldEvent::KeyEnd => {
                if let Some(field) = self.field.as_mut().filter(|field| field.key == key) {
                    let settled = field.edit.key_release();
                    self.settle(documents, settled, effects);
                    if !self.field.as_ref().is_some_and(|field| field.focused) {
                        self.field = None;
                    }
                }
            }
        }
    }

    /// The camera pose `camera-copy` put on the panel's clipboard.
    pub(crate) fn set_camera_clipboard(&mut self, pose: Option<Value>) {
        self.state.camera_clipboard = pose;
        self.bump();
    }

    pub(crate) fn camera_clipboard(&self) -> Option<&Value> {
        self.state.camera_clipboard.as_ref()
    }
}
