//! Regressions of the reference slice's review: each test failed on the code the finding was made on.
use std::sync::Arc;

use styk_core::app::Core;
use styk_core::commands::{Command, CommandId, Effect};
use styk_core::engine::Value;
use styk_core::i18n::english;
use styk_core::inspector::model::Inspector;
use styk_core::inspector::property::PropertyKey;
use styk_core::inspector::model::TextKey;
use styk_core::inspector::{Event, FieldEvent, RenameEvent, TextEvent};
use styk_core::testing;
use styk_core::view_state::InspectorContext;
use styk_doc::json;

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");
const SPRITE: &[u8] = include_bytes!("../../../tests/edit/sprite-segment-sparse-native.document.json");
const NATIVE: &[u8] = include_bytes!("../../../tests/edit/selection-metadata-plain-native.document.json");


/// The facts lane's thread.
struct Threads;

impl styk_services::Spawner for Threads {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        std::thread::Builder::new().name(name.to_owned()).spawn(job).map(|_| ()).map_err(|error| styk_services::SpawnError(error.to_string()))
    }
}

fn core_with(bytes: &[u8]) -> Core {
    testing::core_with_document(bytes, "Test.styk", std::sync::Arc::new(Threads)).unwrap()
}

fn session(core: &mut Core, method: &str, args: &str) {
    testing::call(core, method, args).unwrap();
}

fn model(core: &Core) -> Arc<Inspector> {
    core.inspector().model().unwrap().clone()
}

fn value(core: &Core, key: PropertyKey) -> f64 {
    model(core).number(key).unwrap_or_else(|| panic!("{key:?} is shown")).value
}

/// One event, then what the app does between frames: the new state is published and the facts lane answers.
fn field(core: &mut Core, key: PropertyKey, event: FieldEvent) -> Vec<Effect> {
    let effects = core.dispatch(Command::Inspector(Event::Field(key, event)));
    testing::settle_facts(core).unwrap();
    effects
}

fn run(core: &mut Core, command: CommandId) -> Vec<Effect> {
    let effects = core.dispatch(Command::Run(command));
    testing::settle_facts(core).unwrap();
    effects
}

fn notices(effects: &[Effect]) -> Vec<String> {
    effects.iter().filter_map(|effect| match effect {
        Effect::Notice(notice) => Some(english(&notice.message)),
        _ => None,
    }).collect()
}

fn object_value(core: &Core, uid: f64, field: &str) -> f64 {
    let frame = core.documents.active().unwrap().frame_records().unwrap();
    frame.get("objects").unwrap().elements().unwrap().iter().find(|object| object.get("unique_id").and_then(Value::as_f64) == Some(uid)).unwrap().get(field).unwrap().as_f64().unwrap()
}

/// Finding 2: a commit refused because the selection changed under the field closes the session's gesture.
#[test]
fn a_refused_settlement_leaves_the_session_not_editing() {
    let mut core = core_with(SHEET);
    session(&mut core, "select", "[1,-1]");
    field(&mut core, PropertyKey::RootX, FieldEvent::Focus);
    field(&mut core, PropertyKey::RootX, FieldEvent::Input("250".into()));
    assert!(testing::editing(&core), "the drag is open while typing");
    session(&mut core, "select", "[2,-1]");
    let effects = field(&mut core, PropertyKey::RootX, FieldEvent::Enter);
    assert_eq!(notices(&effects).len(), 1, "the refusal is reported: {:?}", notices(&effects));
    assert!(!testing::editing(&core), "the refused gesture was cancelled, not dropped");
    assert_eq!(testing::undo_depth(&core), 0);
}

/// Finding 3: switching documents finishes the open edit first, and the model follows the new document; a switch that
/// bypasses the lifecycle still abandons the old document's gesture on that document.
#[test]
fn switching_documents_finishes_the_edit_and_shows_the_new_document() {
    let mut core = core_with(STARTUP);
    let first = core.documents.active().unwrap().id();
    let mut thirty = json::parse(STARTUP).unwrap();
    thirty.make_obj().unwrap().set("fps", Value::Num(30.0));
    let second = testing::open_document(&mut core, json::to_string(&thirty).as_bytes(), "Thirty.styk").unwrap();
    core.dispatch(Command::Activate(first));
    testing::settle_facts(&mut core).unwrap();
    session(&mut core, "select", "[null,-1]");
    assert_eq!(value(&core, PropertyKey::Fps), 24.0);
    field(&mut core, PropertyKey::Fps, FieldEvent::Focus);
    field(&mut core, PropertyKey::Fps, FieldEvent::Input("25".into()));
    core.dispatch(Command::Activate(second));
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(core.documents.active().unwrap().id(), second);
    session(&mut core, "select", "[null,-1]");
    assert_eq!(value(&core, PropertyKey::Fps), 30.0, "the new document's model");
    assert!(core.inspector().field().is_none(), "no draft of the old document remains");
    assert_eq!(core.documents.get(first).unwrap().with_document(|typed| typed.fps).unwrap(), 25.0, "the edit was finished on its own document");

    // An open pose gesture is finished (one entry on its own document) before the switch, which then succeeds.
    core.dispatch(Command::Activate(first));
    testing::settle_facts(&mut core).unwrap();
    session(&mut core, "select", "[1,-1]");
    field(&mut core, PropertyKey::RootX, FieldEvent::Focus);
    field(&mut core, PropertyKey::RootX, FieldEvent::Input("300".into()));
    assert!(core.documents.get(first).unwrap().view().unwrap().editing);
    let effects = core.dispatch(Command::Activate(second));
    testing::settle_facts(&mut core).unwrap();
    assert!(notices(&effects).is_empty(), "{:?}", notices(&effects));
    assert_eq!(core.documents.active().unwrap().id(), second);
    assert!(!core.documents.get(first).unwrap().view().unwrap().editing);
    assert_eq!(core.documents.get(first).unwrap().view().unwrap().history.undo, 2, "the frame rate and the move");
}

/// Finding 4: on a layer sheet Edit together reaches the chosen ticks and the playhead's own (`rangeFrames()`:
/// `[...new Set([...ticks, editor.tick])]`).
#[test]
fn edit_together_keys_the_chosen_ticks_and_the_playhead() {
    let mut core = core_with(STARTUP);
    // A pose of its own at tick 3, so what an edit writes there is visible (equal neighbouring keys merge on a sheet).
    session(&mut core, "seek", "[3]");
    field(&mut core, PropertyKey::RootX, FieldEvent::Focus);
    field(&mut core, PropertyKey::RootX, FieldEvent::Input("300".into()));
    field(&mut core, PropertyKey::RootX, FieldEvent::Blur);
    core.view_state_mut().set_range(vec![0, 6]);
    core.view_state_mut().set_apply_range(true);
    testing::settle_facts(&mut core).unwrap();
    let range = styk_core::range::Range::of(core.view_state(), core.documents.active().unwrap()).unwrap();
    assert_eq!(range.sheet_ticks, Some(vec![0.0, 6.0, 3.0]), "the chosen ticks, then the playhead's");
    field(&mut core, PropertyKey::Scale, FieldEvent::Focus);
    field(&mut core, PropertyKey::Scale, FieldEvent::Input("150".into()));
    field(&mut core, PropertyKey::Scale, FieldEvent::Blur);
    assert_eq!(testing::undo_depth(&core), 2);
    for tick in [0.0, 3.0, 6.0] {
        session(&mut core, "seek", &format!("[{tick}]"));
        assert_eq!(object_value(&core, 1.0, "scale"), 1.5, "the scale at tick {tick}");
    }
}

/// Finding 5: alignment over Edit together's frames is one entry that moves the figures in every chosen frame.
#[test]
fn align_reaches_every_chosen_frame_in_one_entry() {
    // Figures 1 and 3 are not joined and both shown through ticks 0 to 5; a pose of figure 1 of its own at tick 3 makes
    // what an edit writes there visible.
    let mut core = core_with(SPRITE);
    session(&mut core, "select", "[1,-1]");
    session(&mut core, "seek", "[3]");
    field(&mut core, PropertyKey::RootX, FieldEvent::Focus);
    field(&mut core, PropertyKey::RootX, FieldEvent::Input("200".into()));
    field(&mut core, PropertyKey::RootX, FieldEvent::Blur);
    let at = |core: &mut Core, tick: f64| {
        session(core, "seek", &format!("[{tick}]"));
        object_value(core, 1.0, "root_x")
    };
    let before = (at(&mut core, 0.0), at(&mut core, 3.0));
    assert_eq!(before.1, 200.0);
    session(&mut core, "seek", "[0]");
    session(&mut core, "selectMany", "[[1,3]]");
    core.view_state_mut().set_range(vec![0, 3]);
    core.view_state_mut().set_apply_range(true);
    testing::settle_facts(&mut core).unwrap();
    let effects = run(&mut core, CommandId::AlignRight);
    assert!(notices(&effects).is_empty(), "{:?}", notices(&effects));
    assert_eq!(testing::undo_depth(&core), 2, "the move, then one entry for the alignment");
    let after = (at(&mut core, 0.0), at(&mut core, 3.0));
    assert_ne!(after.0, before.0, "aligned on the frame on show");
    assert_ne!(after.1, before.1, "and on the other chosen frame");
}

/// Finding 6: a fill's delete and order steps, and the joint's draw order, through the session.
#[test]
fn fill_actions_and_draw_orders_are_one_entry_each() {
    use styk_core::inspector::model::{OrderDirection, PanelAction};
    use styk_core::inspector::order::DrawKind;
    let mut core = core_with(NATIVE);
    session(&mut core, "select", "[1,-1]");
    let polygons = |core: &Core| core.documents.active().unwrap().with_document(|typed| typed.figure(1).map(|figure| figure.polyfills.len())).unwrap().unwrap();
    let fills = polygons(&core);
    assert!(fills > 1);
    let order = value(&core, PropertyKey::PolygonZOrder(0));
    core.dispatch(Command::Inspector(Event::Act(PanelAction::Order { kind: DrawKind::Polygon, index: 0, direction: OrderDirection::Front })));
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(testing::undo_depth(&core), 1);
    assert!(value(&core, PropertyKey::PolygonZOrder(0)) > order, "sent to the front");
    core.dispatch(Command::Inspector(Event::Act(PanelAction::DeletePolygon(0))));
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(testing::undo_depth(&core), 2);
    assert_eq!(polygons(&core), fills - 1);
    run(&mut core, CommandId::Undo);
    run(&mut core, CommandId::Undo);
    assert_eq!(polygons(&core), fills);
    assert_eq!(value(&core, PropertyKey::PolygonZOrder(0)), order);
    session(&mut core, "select", "[1,1]");
    assert!(!model(&core).number(PropertyKey::SegmentZOrder).unwrap().disabled, "the joint's Order is editable");
}

/// Findings 12 and 13: the camera's pose is the session's own clipboard, and paste pastes it into the frame.
#[test]
fn camera_copy_and_paste_use_the_session_clipboard() {
    let mut core = core_with(STARTUP);
    core.view_state_mut().set_context(InspectorContext::Camera);
    testing::settle_facts(&mut core).unwrap();
    assert!(model(&core).section("transform").unwrap().actions[1].disabled);
    run(&mut core, CommandId::CameraCopy);
    assert!(!model(&core).section("transform").unwrap().actions[1].disabled, "the session holds a pose");
    field(&mut core, PropertyKey::CameraX, FieldEvent::Focus);
    field(&mut core, PropertyKey::CameraX, FieldEvent::Input("40".into()));
    field(&mut core, PropertyKey::CameraX, FieldEvent::Blur);
    assert_eq!(value(&core, PropertyKey::CameraX), 40.0);
    let effects = run(&mut core, CommandId::CameraPaste);
    assert!(notices(&effects).is_empty(), "{:?}", notices(&effects));
    assert_eq!(value(&core, PropertyKey::CameraX), 0.0, "the copied pose is back");
}

/// Finding 1, and the re-check's finding 2: bounds come from the worker, stamped with what they were made for, and are
/// shown only for exactly the state on show. A moved selection or a new revision clears them and leaves their rows
/// pending: empty, disabled, and never the origin or denominator of a gesture.
#[test]
fn bounds_are_shown_only_for_the_state_they_were_made_for() {
    let mut core = core_with(SHEET);
    session(&mut core, "selectMany", "[[1,2,3]]");
    let first = core.inspector().shown().bounds.expect("the worker measured the selection");
    assert!(!model(&core).number(PropertyKey::GroupX).unwrap().pending);

    // Sol's reproduction: the selection moves; the lane has not answered for it yet.
    testing::call_unsettled(&mut core, "selectMany", "[[1,2]]").unwrap();
    assert_eq!(core.inspector().shown().bounds, None, "bounds of another selection are not shown");
    let row = model(&core).number(PropertyKey::GroupX).unwrap().clone();
    assert!(row.pending, "the row is pending: {row:?}");
    for event in [FieldEvent::Focus, FieldEvent::Input("10".into())] {
        core.dispatch(Command::Inspector(Event::Field(PropertyKey::GroupX, event)));
        core.refresh();
    }
    assert!(core.inspector().field().is_none(), "a pending row never opens a gesture");
    assert_eq!(testing::undo_depth(&core), 0);
    testing::settle_facts(&mut core).unwrap();
    let two = core.inspector().shown().bounds.expect("the worker measured the new selection");
    assert_ne!(two, first);

    // A new revision: the bounds of the old one are not shown either, until the worker measured the new one.
    session(&mut core, "selectMany", "[[1,2,3]]");
    field(&mut core, PropertyKey::GroupX, FieldEvent::Focus);
    field(&mut core, PropertyKey::GroupX, FieldEvent::Input(format!("{}", first[0] + 50.0)));
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::GroupX, FieldEvent::Blur)));
    core.refresh();
    assert_eq!(core.inspector().shown().bounds, None, "the old revision's bounds are not shown");
    assert!(model(&core).number(PropertyKey::GroupX).unwrap().pending);
    testing::settle_facts(&mut core).unwrap();
    let moved = core.inspector().shown().bounds.unwrap();
    assert!((moved[0] - (first[0] + 50.0)).abs() < 1e-6, "{moved:?}");
}

/// The re-check's finding 1: the refresh never evaluates. A project setting changes the document, so the session holds
/// no evaluation of it; refreshing leaves it so and shows the panel pending (values cleared, controls disabled) until
/// the facts lane has made the frame on show from the published generation, which the session then adopts.
#[test]
fn the_refresh_never_evaluates_and_the_panel_is_pending_until_the_worker_answers() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,-1]");
    assert!(!core.inspector().pending());
    assert_eq!(value(&core, PropertyKey::RootX), 480.0);
    testing::call_unsettled(&mut core, "setFPS", "[30]").unwrap();
    for _ in 0..3 {
        core.refresh();
    }
    let document = core.documents.active().unwrap();
    assert!(document.frame_records_ready().is_none() || document.with_document_ready(|_| ()).is_none(), "the refresh evaluated or converted the document");
    assert!(core.inspector().pending());
    let row = model(&core).number(PropertyKey::RootX).unwrap().clone();
    assert!(row.pending, "a pending panel shows no value of the frame on show: {row:?}");
    assert!(model(&core).sections.iter().all(|section| section.actions.iter().all(|action| action.disabled)), "and edits nothing");
    testing::settle_facts(&mut core).unwrap();
    assert!(!core.inspector().pending());
    assert!(core.documents.active().unwrap().frame_records_ready().is_some(), "the worker's frame was adopted");
    assert_eq!(value(&core, PropertyKey::RootX), 480.0);
    assert_eq!(core.documents.active().unwrap().with_document_ready(|typed| typed.fps), Some(30.0));
}

fn open_second(core: &mut Core) -> styk_core::documents::DocumentId {
    testing::open_document(core, STARTUP, "Second.styk").unwrap()
}

fn figure_name(core: &Core, document: styk_core::documents::DocumentId) -> String {
    let records = core.documents.get(document).unwrap().records().unwrap().clone();
    records.get("figure_types").unwrap().item(0).unwrap().get("name").unwrap().as_str().unwrap().to_string()
}

fn layer_name(core: &Core) -> String {
    let records = core.documents.active().unwrap().records().unwrap().clone();
    records.path(&["_styk", "layers", "byId", "layer-1", "name"]).unwrap().as_str().unwrap().to_string()
}

fn panel(core: &mut Core, event: Event) {
    core.dispatch(Command::Inspector(event));
    testing::settle_facts(core).unwrap();
}

/// Re-check finding 3: a name being typed in the header when another document becomes active is committed on the
/// document it began on, as today's field commits when it loses focus (`inspector-header.mjs` `finish(true)` on blur).
#[test]
fn a_rename_being_typed_is_committed_on_its_own_document_before_another_becomes_active() {
    let mut core = core_with(STARTUP);
    let first = core.documents.active().unwrap().id();
    let second = open_second(&mut core);
    core.dispatch(Command::Activate(first));
    testing::settle_facts(&mut core).unwrap();
    session(&mut core, "select", "[1,-1]");
    let before = figure_name(&core, first);
    panel(&mut core, Event::Rename(RenameEvent::Begin));
    panel(&mut core, Event::Rename(RenameEvent::Input("Ink".into())));
    assert_eq!(core.inspector().rename().unwrap().text, "Ink");
    core.dispatch(Command::Activate(second));
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(core.documents.active().unwrap().id(), second);
    assert!(core.inspector().rename().is_none(), "no draft follows into the other document");
    assert_eq!(figure_name(&core, first), "Ink", "committed on the document it began on");
    assert_eq!(figure_name(&core, second), before, "the other document is untouched");
    assert_eq!(core.documents.get(first).unwrap().view().unwrap().history.undo, 1, "one entry");
}

/// Re-check finding 3: a command finishes a name being typed first (commits it), so Undo then takes the new name back.
#[test]
fn a_rename_being_typed_is_committed_before_a_command() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,-1]");
    let id = core.documents.active().unwrap().id();
    let before = figure_name(&core, id);
    panel(&mut core, Event::Rename(RenameEvent::Begin));
    panel(&mut core, Event::Rename(RenameEvent::Input("Ink".into())));
    run(&mut core, CommandId::Undo);
    assert!(core.inspector().rename().is_none());
    assert_eq!(figure_name(&core, id), before, "the rename was one entry, and Undo took it back");
    run(&mut core, CommandId::Redo);
    assert_eq!(figure_name(&core, id), "Ink");
}

/// The layer's Name field (today's `#inspector-layer-name`, `renameLayer` on `change`): typing is a draft the field
/// shows; leaving the field renames the layer once; Escape keeps the name; undo and redo restore it.
#[test]
fn the_layer_name_field_renames_the_layer_once_when_focus_leaves() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,-1]");
    core.view_state_mut().set_context(InspectorContext::Layer);
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(model(&core).text(TextKey::LayerName).unwrap().value.as_ref(), "Layer 1");
    panel(&mut core, Event::Text(TextKey::LayerName, TextEvent::Focus));
    panel(&mut core, Event::Text(TextKey::LayerName, TextEvent::Input("Ink".into())));
    assert_eq!(core.inspector().text_draft(), Some((TextKey::LayerName, "Ink".to_string())));
    assert_eq!(layer_name(&core), "Layer 1", "typing is a draft");
    panel(&mut core, Event::Text(TextKey::LayerName, TextEvent::Blur));
    assert_eq!(layer_name(&core), "Ink");
    assert_eq!(testing::undo_depth(&core), 1);
    assert_eq!(model(&core).text(TextKey::LayerName).unwrap().value.as_ref(), "Ink");

    panel(&mut core, Event::Text(TextKey::LayerName, TextEvent::Focus));
    panel(&mut core, Event::Text(TextKey::LayerName, TextEvent::Input("Wash".into())));
    panel(&mut core, Event::Text(TextKey::LayerName, TextEvent::Escape));
    panel(&mut core, Event::Text(TextKey::LayerName, TextEvent::Blur));
    assert_eq!(layer_name(&core), "Ink", "Escape keeps the name");
    assert_eq!(testing::undo_depth(&core), 1);

    run(&mut core, CommandId::Undo);
    assert_eq!(layer_name(&core), "Layer 1");
    run(&mut core, CommandId::Redo);
    assert_eq!(layer_name(&core), "Ink");
}
