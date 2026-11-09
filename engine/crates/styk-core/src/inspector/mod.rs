//! The Properties panel's logic (the reference slice of `docs/native/patterns.md`).
//!
//! - [`model`]: the view model, one descriptor per context, plain data the interface draws with a generic kit.
//! - [`contexts`]: builds it from the session's cheap typed reads, the view state and ready facts (a port of
//!   `src/inspector-view.mjs`).
//! - [`property`]: the number properties and the gesture that edits one through the session; [`order`] the draw order.
//! - [`memory`]: which titled sections are open.
//! - [`Panel`]: the panel's own state (the field being edited and its gesture, pages, tabs) and [`Panel::update`], which
//!   turns an [`Event`] from the view into session calls and [`Effect`]s.
//!
//! The view model is rebuilt only when its key changes (the document, its revision, the frame on show, the selection,
//! the playhead, the view state, the section memory, the panel state, the facts shown) and never while a property
//! gesture of the active document is open: today the Inspector defers its refresh during a gesture and never reflows a
//! field being typed in. The refresh reads only what the session holds ready (`Document::frame_records_ready` and
//! friends): the frame on show, the document's views and the selection's bounds, when they need evaluating, come from
//! [`crate::facts`]; until they land the panel is pending (its last model, values cleared and controls disabled), and
//! a fact is shown only under its complete current key.

#[cfg(feature = "engine")]
pub mod contexts;
#[cfg(feature = "engine")]
pub mod facts;
#[cfg(feature = "engine")]
pub mod memory;
pub mod model;
pub mod order;
pub mod property;

use std::sync::Arc;

#[cfg(feature = "engine")]
use styk_doc::{Obj, Value};

#[cfg(feature = "engine")]
use crate::answers::{self, Session};
#[cfg(feature = "engine")]
use crate::app::Lifecycle;
#[cfg(feature = "engine")]
use crate::commands::{Effect, Notice, Severity};
#[cfg(feature = "engine")]
use crate::documents::{DocumentId, Documents};
#[cfg(feature = "engine")]
use crate::facts::{Facts, FactsKey};
#[cfg(feature = "engine")]
use crate::frames::FrameDocument;
#[cfg(feature = "engine")]
use crate::i18n::{Msg, Presentation};
#[cfg(feature = "engine")]
use crate::number::{NumberEdit, Range as FieldRange, Settled, StepKeys};
#[cfg(feature = "engine")]
use crate::range::Range;
#[cfg(feature = "engine")]
use crate::view_state::ViewState;
#[cfg(feature = "engine")]
use memory::SectionMemory;
use model::{Choice, ColorTarget, PanelAction, Segments, TextKey, Toggle};
#[cfg(feature = "engine")]
use model::{Inspector, OrderDirection, Pager, RenameTarget};
#[cfg(feature = "engine")]
use order::DrawKind;
#[cfg(feature = "engine")]
use property::Gesture;
use property::PropertyKey;
#[cfg(not(feature = "engine"))]
use crate::{i18n::Msg, number::StepKeys};

/// What a number field reports (the scrub label's events and the input's).
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

/// What a text row reports (its input's focus, typing and keys).
#[derive(Clone, Debug, PartialEq)]
pub enum TextEvent {
    Focus,
    Input(String),
    /// Enter commits what changed and keeps focus, as an input's `change` on Enter does.
    Enter,
    /// Escape puts the name back.
    Escape,
    /// Leaving the field commits what changed.
    Blur,
}

/// What the Properties panel's view sends.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Field(PropertyKey, FieldEvent),
    Toggle(Toggle, bool),
    Choose(Choice, Arc<str>),
    /// An arrow key on a closed select: the next (+1) or previous (-1) option that can be chosen.
    ChooseStep(Choice, i32),
    Section { id: &'static str, open: bool },
    Act(PanelAction),
    Segment(Segments, &'static str),
    Color(ColorTarget),
    Rename(RenameEvent),
    Text(TextKey, TextEvent),
}

/// Where the panel asks focus to go (the interface maps each to its focus target).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FocusRequest {
    /// The header's rename field, which takes focus as renaming begins.
    Rename,
    /// The header's name, where focus returns when renaming ends.
    TargetName,
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
#[cfg(feature = "engine")]
#[derive(Clone, Debug, Default)]
pub struct PanelState {
    pub camera_tab: CameraTab,
    pub connector_part: ConnectorPart,
    pub palette_page: usize,
    pub fills_page: usize,
    version: u64,
}

/// The facts the model shows, as of the last refresh: only facts made for the state on show (document, revision,
/// playhead, selection); anything else is not shown, and the rows built from it are pending.
#[cfg(feature = "engine")]
#[derive(Clone, Debug, Default)]
pub struct Shown {
    /// The selection's bounds; `None` while none are ready for exactly this state.
    pub bounds: Option<[f64; 4]>,
    key: Option<FactsKey>,
    pub(crate) figures: Arc<std::collections::HashMap<u32, Arc<crate::engine::doc::Figure>>>,
}

/// The number field being edited: its model (typed text, the open gesture's value) and its session gesture.
#[cfg(feature = "engine")]
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

/// Where a name is being typed.
#[cfg(feature = "engine")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NamePlace {
    Header,
    Text(TextKey),
}

/// What a name renames, fixed when typing began.
#[cfg(feature = "engine")]
#[derive(Clone, Debug, PartialEq)]
enum NameTarget {
    /// The selected figure's definition (`updateFigureStyle({name})`).
    Figure,
    /// A layer, by its id (`renameLayer(id, name)`).
    Layer(Arc<str>),
}

/// A name being typed, in the header or in a text row. It keeps the document and the target it began on, so whatever
/// ends it (Enter, leaving the field, a command, another document becoming active) settles it there, as the input's
/// `change` event does today when it loses focus.
#[cfg(feature = "engine")]
#[derive(Clone, Debug)]
struct NameDraft {
    document: DocumentId,
    target: NameTarget,
    place: NamePlace,
    original: String,
    text: String,
    max_chars: Option<usize>,
}

#[cfg(feature = "engine")]
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
    facts: Option<FactsKey>,
    paste: bool,
}

/// The Properties panel.
#[cfg(feature = "engine")]
#[derive(Debug, Default)]
pub struct Panel {
    state: PanelState,
    memory: SectionMemory,
    field: Option<Field>,
    name: Option<NameDraft>,
    hinted: bool,
    model: Option<Arc<Inspector>>,
    key: Option<Key>,
    shown: Shown,
    /// The frame on show or the views are being made on a worker: the model is the pending copy of the last one.
    pending: bool,
    /// How many times the model was built (tests and the timing read it).
    pub builds: u64,
}

#[cfg(feature = "engine")]
fn warn(message: Msg) -> Effect {
    Effect::Notice(Notice { message, severity: Severity::Warning })
}

#[cfg(feature = "engine")]
fn object(pairs: &[(&str, Value)]) -> Value {
    let mut obj = Obj::new();
    for (key, value) in pairs {
        obj.set(key, value.clone());
    }
    Value::object(obj)
}

#[cfg(feature = "engine")]
impl Lifecycle for Panel {
    fn finish(&mut self, documents: &mut Documents, session: &mut Session, effects: &mut Vec<Effect>) {
        Panel::finish(self, documents, session, effects);
    }
}

#[cfg(feature = "engine")]
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

    /// The evaluated instance (style overlays included) of the selected figure `uid`, from the facts the worker made for
    /// exactly this document, lineage, revision, playhead and selection (V0's resolved instance facts); `None` while they are
    /// pending or were made for another state. Reading it is a key comparison: nothing is evaluated or scanned.
    pub fn instance_of(&self, document: &crate::documents::Document, uid: u32) -> Option<&Arc<crate::engine::doc::Figure>> {
        let shown = self.shown.key.as_ref()?;
        let selection = facts::selection(document);
        let current = FactsKey::new(document.id().get(), document.lineage(), document.revision(), facts::tick(document), &selection.uids);
        (shown == &current).then(|| self.shown.figures.get(&uid)).flatten()
    }

    /// The facts the model shows.
    pub fn shown(&self) -> &Shown {
        &self.shown
    }

    /// Whether the panel waits for the frame on show or the document's views from a worker.
    pub fn pending(&self) -> bool {
        self.pending
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

    /// The header's name while it is renamed in place.
    pub fn rename(&self) -> Option<RenameView> {
        self.name.as_ref().filter(|draft| draft.place == NamePlace::Header).map(|draft| RenameView { text: draft.text.clone() })
    }

    /// The text row being typed in and its text.
    pub fn text_draft(&self) -> Option<(TextKey, String)> {
        let draft = self.name.as_ref()?;
        match draft.place {
            NamePlace::Text(key) => Some((key, draft.text.clone())),
            NamePlace::Header => None,
        }
    }

    /// Whether a property gesture is open.
    pub fn gesture_open(&self) -> bool {
        self.field.as_ref().is_some_and(|field| field.gesture.is_some())
    }

    fn bump(&mut self) {
        self.state.version = self.state.version.wrapping_add(1);
    }

    /// Takes what the facts lane made and asks it for what the active document's state needs: the frame on show and the
    /// views when the session lacks them (`ready` false), and the bounds of two or more selected figures. A landed
    /// evaluation is adopted by the document it was made for while it is still at that revision. Never waits.
    fn facts(&mut self, documents: &Documents, facts: Option<&mut Facts>, source: Option<Arc<dyn FrameDocument>>) {
        let Some(document) = documents.active() else { return };
        let Some(facts) = facts else {
            self.shown = Shown::default();
            return;
        };
        let selection = facts::selection(document);
        let key = FactsKey::new(document.id().get(), document.lineage(), document.revision(), facts::tick(document), &selection.uids);
        // Take what landed first. An unpublished key waits for its publication receipt.
        if let Some(landed) = facts.latest()
            && landed.key.document == key.document && landed.key.lineage == key.lineage
            && let Some((views, frame)) = &landed.evaluation
        {
            document.adopt_evaluation(landed.key.revision, views.clone(), f64::from_bits(landed.key.tick), frame.clone());
        }
        let ready = document.frame_records_ready().is_some() && document.with_document_ready(|_| ()).is_some();
        if (!ready || !selection.uids.is_empty()) && let Some(source) = source {
            let publication = source.publication_receipt().or_else(|| documents.published().map(|(_, _, generation)| generation));
            facts.request(key.clone(), source, facts::records(document).clone(), publication);
        }
        facts.flush();
        // A fact is shown only for exactly this state; otherwise nothing is, and its rows are pending.
        self.shown = match facts.latest() {
            Some(landed) if landed.key == key => Shown { bounds: landed.bounds, figures: landed.figures.clone(), key: Some(landed.key.clone()) },
            _ => Shown::default(),
        };
    }

    /// Rebuilds the view model if anything it is built from changed. It reads only what the session holds ready and
    /// never evaluates, converts or measures (D7): until the frame on show and the views are ready the model is the
    /// pending copy of the last one.
    pub fn refresh(&mut self, documents: &mut Documents, view: &ViewState, facts: Option<&mut Facts>, source: Option<Arc<dyn FrameDocument>>, session: &mut Session) {
        let active = documents.active().map(|document| document.id());
        // A field whose gesture belongs to a document that is no longer active (a switch that bypassed the lifecycle, a
        // closed tab) is abandoned on its own document before anything is deferred.
        let orphaned = self.field.as_ref().and_then(|field| field.gesture.as_ref()).is_some_and(|gesture| Some(gesture.document) != active);
        if orphaned && let Some(gesture) = self.field.take().and_then(|field| field.gesture) {
            gesture.cancel(documents, session);
        }
        if self.key.as_ref().map(|key| key.document) != active {
            // The lifecycle settles a name before another document becomes active; one left here belongs to a document
            // that went away.
            if self.name.as_ref().is_some_and(|draft| Some(draft.document) != active) {
                self.name = None;
            }
            if self.field.as_ref().is_some_and(|field| field.gesture.is_none()) {
                self.field = None;
            }
        }
        if self.gesture_open() && self.model.is_some() {
            return;
        }
        // A session that is busy (an open or a save in progress) keeps the model it had.
        if self.model.is_some() && documents.active().is_some_and(|document| document.view().is_err()) {
            return;
        }
        let resolving = facts.is_some() && source.is_some();
        self.facts(documents, facts, source);
        let Some(document) = documents.active() else {
            self.model = None;
            self.key = None;
            self.pending = false;
            return;
        };
        let selection = facts::selection(document);
        let needed = FactsKey::new(document.id().get(), document.lineage(), document.revision(), facts::tick(document), &selection.uids);
        let instances_ready = !resolving || selection.uids.is_empty() || self.shown.key.as_ref() == Some(&needed);
        let Some(frame) = document.frame_records_ready().filter(|_| document.with_document_ready(|_| ()).is_some()) else {
            // Not ready: the facts lane makes them; nothing is evaluated here.
            if !self.pending {
                self.model = self.model.as_deref().map(|model| Arc::new(contexts::pending(model)));
                self.pending = true;
            }
            self.key = None;
            return;
        };
        // Selection context is available before instance facts. Show its current layout immediately,
        // with pending controls, instead of leaving the previous figure's layout on show.
        self.pending = !instances_ready;
        let selection = facts::selection(document);
        let key = Key {
            document: document.id(),
            revision: document.revision(),
            frame: frame.clone(),
            selection: (selection.uid, selection.uids.clone(), selection.joint),
            tick: facts::tick(document).to_bits(),
            view: view.version(),
            memory: self.memory.version(),
            panel: self.state.version,
            facts: self.shown.key.clone(),
            paste: crate::camera_actions::can_paste(documents),
        };
        let same = self.key.as_ref().is_some_and(|old| old.frame.same_node(&key.frame) && Key { frame: Value::Null, ..old.clone() } == Key { frame: Value::Null, ..key.clone() });
        if same && self.model.is_some() {
            return;
        }
        let built = contexts::build(document, &frame, &contexts::Inputs { view, memory: &self.memory, panel: &self.state, shown: &self.shown, can_paste: key.paste });
        let built = if self.pending { contexts::pending(&built) } else { built };
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

    /// Ends the field's session gesture with the field model's outcome: a commit is one history entry; anything else,
    /// and any refusal, cancels the session's gesture explicitly before the panel lets go of it.
    fn settle(&mut self, documents: &mut Documents, session: &mut Session, settled: Settled, effects: &mut Vec<Effect>) {
        let Some(field) = self.field.as_mut() else { return };
        let Some(gesture) = field.gesture.take() else { return };
        match settled {
            Settled::Committed(value) => {
                let initial = gesture.initial;
                match gesture.commit(documents, value, session) {
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
                gesture.cancel(documents, session);
                effects.push(Effect::RequestFrame);
            }
        }
    }

    /// Opens the session gesture of the field when it has none yet (`_begin` runs on every input until one begins).
    fn ensure_gesture(&mut self, documents: &mut Documents, session: &mut Session, id: DocumentId, view: &ViewState, effects: &mut Vec<Effect>) -> bool {
        let Some(field) = self.field.as_mut() else { return false };
        if field.gesture.is_some() {
            return true;
        }
        let range = documents.get(id).and_then(|document| Range::of(view, document));
        match Gesture::begin(documents, id, field.key, field.edit.value(), range, session) {
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

    fn preview(&mut self, documents: &mut Documents, session: &mut Session, effects: &mut Vec<Effect>) {
        let Some(field) = self.field.as_mut() else { return };
        let value = field.edit.value();
        let Some(gesture) = field.gesture.as_mut() else { return };
        match gesture.preview(documents, value, session) {
            Ok(true) => effects.push(Effect::RequestFrame),
            Ok(false) => {}
            Err(message) => {
                // A refused preview ends the gesture where it began (`assertCurrent` cancels; a bad value is refused).
                if let Some(gesture) = field.gesture.take() {
                    field.edit.set_value(gesture.initial);
                    gesture.cancel(documents, session);
                }
                effects.push(warn(message));
                effects.push(Effect::RequestFrame);
            }
        }
    }

    /// Makes `key` the field being edited, ending another field's gesture first (a second gesture commits the first).
    fn take_field(&mut self, documents: &mut Documents, session: &mut Session, key: PropertyKey, effects: &mut Vec<Effect>) -> bool {
        if self.field.as_ref().is_some_and(|field| field.key == key) {
            return true;
        }
        self.finish(documents, session, effects);
        let Some(row) = self.row(key) else { return false };
        if row.disabled || row.pending {
            return false;
        }
        let edit = NumberEdit::new(row.value, FieldRange { min: row.min, max: row.max }, 1.0, row.precision);
        self.field = Some(Field { key, edit, gesture: None, focused: false, mixed: row.mixed });
        true
    }

    /// Commits whatever the panel has open (`propertyControls.commit()` before another edit, a command, a tab switch):
    /// the number field's gesture, then a name being typed, on the document it began on.
    pub fn finish(&mut self, documents: &mut Documents, session: &mut Session, effects: &mut Vec<Effect>) {
        self.finish_field(documents, session, effects);
        if let Some(draft) = self.name.take() {
            Self::commit_name(documents, session, draft, effects);
        }
    }

    fn finish_field(&mut self, documents: &mut Documents, session: &mut Session, effects: &mut Vec<Effect>) {
        let Some(field) = self.field.as_mut() else { return };
        // Whichever of the field's gestures is open ends committed: typing (or a held key), else a scrub.
        let settled = match field.edit.blur() {
            Settled::Unchanged => field.edit.scrub_end(),
            other => other,
        };
        self.settle(documents, session, settled, effects);
        // A gesture the field model had already settled still has its session side to close.
        if let Some(gesture) = self.field.take().and_then(|field| field.gesture) {
            gesture.cancel(documents, session);
        }
    }

    /// Runs one event of the panel's view against the active document.
    pub fn update(&mut self, documents: &mut Documents, view: &mut ViewState, session: &mut Session, presentation: &Presentation, event: Event) -> Vec<Effect> {
        let mut effects = Vec::new();
        let Some(id) = documents.active().map(|document| document.id()) else { return effects };
        let event = match event {
            Event::ChooseStep(choice, step) => match self.stepped_choice(choice, step) {
                Some(value) => Event::Choose(choice, value),
                None => return effects,
            },
            other => other,
        };
        match event {
            Event::Field(key, event) => self.field_event(documents, session, view, id, key, event, &mut effects),
            Event::Toggle(toggle, on) => {
                self.finish(documents, session, &mut effects);
                let result = match toggle {
                    Toggle::ApplyRange => {
                        view.set_apply_range(on);
                        Ok(())
                    }
                    Toggle::StaticJoint => answers::call(documents, id, "updateBuilderSegmentStyle", &[object(&[("static", Value::Bool(on))]), object(&[("branch", Value::Bool(false))])], session).map(|_| ()),
                    Toggle::SecondaryColor => {
                        let gradient = if on { object(&[("color", Value::str("#ffffff"))]) } else { Value::Null };
                        answers::call(documents, id, "updateBuilderSegmentStyle", &[object(&[("gradient", gradient)]), object(&[("branch", Value::Bool(false))])], session).map(|_| ())
                    }
                    Toggle::BuilderBranch => Err(Msg::new("errors.engineOwner.notSupported")),
                };
                Self::report(result, &mut effects);
            }
            Event::Choose(choice, value) => {
                self.finish(documents, session, &mut effects);
                let result = match choice {
                    Choice::SegmentShape => answers::call(documents, id, "convertSegment", &[Value::str(&value)], session).map(|_| ()),
                    Choice::FigureLayer => {
                        let uids = documents.get(id).map(|document| facts::selection(document).uids.iter().map(|uid| Value::Num(f64::from(*uid))).collect()).unwrap_or_default();
                        answers::call(documents, id, "assignFiguresToLayer", &[Value::array(uids), Value::str(&value)], session).and_then(|changed| {
                            if changed.truthy() {
                                answers::call(documents, id, "setActiveLayer", &[Value::str(&value)], session)?;
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
            Event::Act(action) => self.act(documents, session, id, action, &mut effects),
            Event::Segment(Segments::CameraTab, value) => {
                self.finish(documents, session, &mut effects);
                self.state.camera_tab = if value == "motion" { CameraTab::Motion } else { CameraTab::Transform };
                self.bump();
            }
            Event::Segment(Segments::ConnectorPart, value) => {
                self.state.connector_part = if value == "segment" { ConnectorPart::Segment } else { ConnectorPart::Slider };
                self.bump();
            }
            Event::Color(target) => {
                self.finish(documents, session, &mut effects);
                effects.push(Effect::PickColor(target));
            }
            Event::Rename(event) => self.rename_event(documents, session, presentation, id, event, &mut effects),
            Event::Text(key, event) => self.text_event(documents, session, id, key, event, &mut effects),
            Event::ChooseStep(..) => {}
        }
        effects
    }

    /// The option an arrow key moves a select to, from the model's options: the next enabled one, none past the ends.
    fn stepped_choice(&self, choice: Choice, step: i32) -> Option<Arc<str>> {
        fn find(rows: &[model::Row], choice: Choice) -> Option<&model::SelectRow> {
            rows.iter().find_map(|row| match row {
                model::Row::Select(select) if select.choice == choice => Some(select),
                model::Row::Grid { rows, .. } | model::Row::Group { rows, .. } => find(rows, choice),
                _ => None,
            })
        }
        let model = self.model.as_ref()?;
        let select = model.sections.iter().find_map(|section| find(&section.rows, choice))?;
        if select.disabled {
            return None;
        }
        let enabled: Vec<&Arc<str>> = select.options.iter().filter(|option| !option.disabled).map(|option| &option.value).collect();
        let current = select.value.as_ref().and_then(|value| enabled.iter().position(|option| *option == value));
        let next = match current {
            Some(at) => at.checked_add_signed(step as isize).filter(|next| *next < enabled.len())?,
            None if step > 0 => 0,
            None => enabled.len().checked_sub(1)?,
        };
        Some(enabled[next].clone())
    }

    fn act(&mut self, documents: &mut Documents, session: &mut Session, id: DocumentId, action: PanelAction, effects: &mut Vec<Effect>) {
        match action {
            PanelAction::Page(pager, step) => {
                let page = match pager {
                    Pager::Palette => &mut self.state.palette_page,
                    Pager::Fills => &mut self.state.fills_page,
                };
                *page = page.saturating_add_signed(step as isize);
                self.bump();
            }
            PanelAction::DeletePolygon(index) => {
                self.finish(documents, session, effects);
                Self::report(answers::call(documents, id, "removePolygon", &[Value::Num(f64::from(index))], session).map(|_| ()), effects);
            }
            PanelAction::Order { kind, index, direction } => {
                // `builder-order`: `moveBuilderOrder({kind, index}, direction, {branch})`, after the open edit finishes.
                self.finish(documents, session, effects);
                let kind = match kind {
                    DrawKind::Polygon => "polygon",
                    DrawKind::Segment => "segment",
                };
                let direction = match direction {
                    OrderDirection::Back => "back",
                    OrderDirection::Down => "down",
                    OrderDirection::Up => "up",
                    OrderDirection::Front => "front",
                };
                let target = object(&[("kind", Value::str(kind)), ("index", Value::Num(f64::from(index)))]);
                let result = answers::call(documents, id, "moveBuilderOrder", &[target, Value::str(direction), object(&[("branch", Value::Bool(false))])], session);
                Self::report(result.map(|_| ()), effects);
            }
        }
    }

    fn report(result: Result<(), Msg>, effects: &mut Vec<Effect>) {
        match result {
            Ok(()) => effects.push(Effect::RequestFrame),
            Err(message) => effects.push(warn(message)),
        }
    }

    /// Commits a name where it began: once, when it changed and is not blank (a blank name keeps the old one).
    fn commit_name(documents: &mut Documents, session: &mut Session, draft: NameDraft, effects: &mut Vec<Effect>) {
        let text = draft.text;
        if text.trim().is_empty() || text == draft.original || documents.get(draft.document).is_none() {
            return;
        }
        let result = match draft.target {
            NameTarget::Figure => answers::call(documents, draft.document, "updateFigureStyle", &[object(&[("name", Value::str(&text))])], session),
            NameTarget::Layer(layer) => answers::call(documents, draft.document, "renameLayer", &[Value::str(&layer), Value::str(&text)], session),
        };
        Self::report(result.map(|_| ()), effects);
    }

    fn begin_name(&mut self, documents: &Documents, id: DocumentId, target: RenameTarget, place: NamePlace, original: String, max_chars: Option<usize>) {
        let target = match target {
            RenameTarget::Figure => NameTarget::Figure,
            RenameTarget::Layer => NameTarget::Layer(documents.get(id).map(|document| facts::active_layer(facts::records(document))).unwrap_or_else(|| Arc::from("layer-1"))),
        };
        self.name = Some(NameDraft { document: id, target, place, text: original.clone(), original, max_chars });
    }

    fn type_name(&mut self, place: NamePlace, text: String) {
        if let Some(draft) = self.name.as_mut().filter(|draft| draft.place == place) {
            draft.text = match draft.max_chars {
                Some(limit) => text.chars().take(limit).collect(),
                None => text,
            };
        }
    }

    fn rename_event(&mut self, documents: &mut Documents, session: &mut Session, presentation: &Presentation, id: DocumentId, event: RenameEvent, effects: &mut Vec<Effect>) {
        let Some(rename) = self.model.as_ref().and_then(|model| model.target.rename.clone()) else {
            self.name = None;
            return;
        };
        let header = self.name.as_ref().is_some_and(|draft| draft.place == NamePlace::Header);
        match event {
            RenameEvent::Begin => {
                if header {
                    return;
                }
                self.finish(documents, session, effects);
                let original = self.model.as_ref().map(|model| presentation.label(&model.target.name)).unwrap_or_default();
                self.begin_name(documents, id, rename.target, NamePlace::Header, original, rename.max_chars);
                effects.push(Effect::Focus(FocusRequest::Rename));
            }
            RenameEvent::Input(text) => self.type_name(NamePlace::Header, text),
            RenameEvent::Cancel => {
                if header {
                    self.name = None;
                    effects.push(Effect::Focus(FocusRequest::TargetName));
                }
            }
            RenameEvent::Commit => {
                // Enter or leaving the field commits; a blank or unchanged name keeps the old one.
                if !header {
                    return;
                }
                effects.push(Effect::Focus(FocusRequest::TargetName));
                if let Some(draft) = self.name.take() {
                    Self::commit_name(documents, session, draft, effects);
                }
            }
        }
    }

    fn text_event(&mut self, documents: &mut Documents, session: &mut Session, id: DocumentId, key: TextKey, event: TextEvent, effects: &mut Vec<Effect>) {
        let place = NamePlace::Text(key);
        let typing = self.name.as_ref().is_some_and(|draft| draft.place == place);
        let begin = |panel: &mut Panel, documents: &mut Documents, session: &mut Session, effects: &mut Vec<Effect>| {
            panel.finish(documents, session, effects);
            let Some(row) = panel.model.as_ref().and_then(|model| model.text(key)).cloned() else { return };
            let target = match key {
                TextKey::LayerName => RenameTarget::Layer,
            };
            panel.begin_name(documents, id, target, place, row.value.to_string(), row.max_chars);
        };
        match event {
            TextEvent::Focus if !typing => begin(self, documents, session, effects),
            TextEvent::Input(text) => {
                if !typing {
                    begin(self, documents, session, effects);
                }
                self.type_name(place, text);
            }
            TextEvent::Enter | TextEvent::Blur if typing => {
                if let Some(draft) = self.name.take() {
                    Self::commit_name(documents, session, draft, effects);
                }
            }
            TextEvent::Escape if typing => self.name = None,
            TextEvent::Focus | TextEvent::Enter | TextEvent::Escape | TextEvent::Blur => {}
        }
    }

    #[allow(clippy::too_many_arguments)] // One field event, with the owners it reaches.
    fn field_event(&mut self, documents: &mut Documents, session: &mut Session, view: &ViewState, id: DocumentId, key: PropertyKey, event: FieldEvent, effects: &mut Vec<Effect>) {
        let editing = self.field.as_ref().is_some_and(|field| field.key == key);
        match event {
            FieldEvent::Focus => {
                if !self.take_field(documents, session, key, effects) {
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
                self.ensure_gesture(documents, session, id, view, effects);
            }
            FieldEvent::Blur if editing => {
                let Some(field) = self.field.as_mut() else { return };
                let settled = field.edit.blur();
                field.focused = false;
                // A scrub of the label owns the field until it ends.
                if field.edit.gesture_open() {
                    return;
                }
                self.settle(documents, session, settled, effects);
                self.field = None;
            }
            FieldEvent::Input(text) => {
                if !self.take_field(documents, session, key, effects) {
                    return;
                }
                // The session gesture begins from the value before this edit (`_typed` begins, then previews).
                let began = self.ensure_gesture(documents, session, id, view, effects);
                if let Some(field) = self.field.as_mut() {
                    field.mixed = false;
                    field.edit.input(text);
                    if field.edit.invalid().is_some() {
                        return;
                    }
                }
                if began {
                    self.preview(documents, session, effects);
                }
            }
            FieldEvent::Enter if editing => {
                if let Some(field) = self.field.as_mut() {
                    let settled = field.edit.enter();
                    self.settle(documents, session, settled, effects);
                }
                effects.push(Effect::Blur);
            }
            FieldEvent::Escape if editing => {
                if let Some(field) = self.field.as_mut() {
                    let settled = if field.focused { field.edit.escape() } else { field.edit.scrub_cancel() };
                    self.settle(documents, session, settled, effects);
                }
                if !self.field.as_ref().is_some_and(|field| field.focused) {
                    self.field = None;
                }
            }
            FieldEvent::Scrub(Scrub::Begin) => {
                if !self.take_field(documents, session, key, effects) {
                    return;
                }
                if let Some(field) = self.field.as_mut() {
                    // A press on the label commits the open input gesture and begins the scrub's.
                    let settled = field.edit.scrub_begin();
                    field.mixed = false;
                    self.settle(documents, session, settled, effects);
                }
                self.ensure_gesture(documents, session, id, view, effects);
            }
            FieldEvent::Scrub(Scrub::Delta { dx, keys }) if editing => {
                if let Some(field) = self.field.as_mut() {
                    field.edit.scrub_move(dx, keys);
                }
                self.preview(documents, session, effects);
            }
            FieldEvent::Scrub(Scrub::End | Scrub::Cancel) | FieldEvent::KeyEnd if editing => {
                if let Some(field) = self.field.as_mut() {
                    let settled = match event {
                        FieldEvent::Scrub(Scrub::End) => field.edit.scrub_end(),
                        FieldEvent::Scrub(_) => field.edit.scrub_cancel(),
                        _ => field.edit.key_release(),
                    };
                    self.settle(documents, session, settled, effects);
                }
                if !self.field.as_ref().is_some_and(|field| field.focused) {
                    self.field = None;
                }
            }
            FieldEvent::KeyStep { direction, keys } => {
                if !self.take_field(documents, session, key, effects) {
                    return;
                }
                let began = self.ensure_gesture(documents, session, id, view, effects);
                if let Some(field) = self.field.as_mut() {
                    field.mixed = false;
                    field.edit.key_step(direction, keys);
                }
                if began {
                    self.preview(documents, session, effects);
                }
            }
            // An end, Enter or Escape of a field that is not the one being edited changes nothing.
            FieldEvent::Blur | FieldEvent::Enter | FieldEvent::Escape | FieldEvent::Scrub(_) | FieldEvent::KeyEnd => {}
        }
    }
}
