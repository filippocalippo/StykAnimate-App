//! Regressions of the reference slice's review: each test failed on the code the finding was made on.
use std::sync::Arc;

use styk_core::app::Core;
use styk_core::commands::{Command, CommandId, Effect};
use styk_core::documents::Value;
use styk_core::i18n::english;
use styk_core::inspector::model::Inspector;
use styk_core::inspector::property::PropertyKey;
use styk_core::inspector::{Event, FieldEvent};
use styk_core::testing;
use styk_core::view_state::InspectorContext;
use styk_doc::json;

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");
const NATIVE: &[u8] = include_bytes!("../../../tests/edit/selection-metadata-plain-native.document.json");

fn core_with(bytes: &[u8]) -> Core {
    testing::core_with_document(bytes, "Test.styk").unwrap()
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

fn field(core: &mut Core, key: PropertyKey, event: FieldEvent) -> Vec<Effect> {
    let effects = core.dispatch(Command::Inspector(Event::Field(key, event)));
    core.refresh();
    effects
}

fn run(core: &mut Core, command: CommandId) -> Vec<Effect> {
    let effects = core.dispatch(Command::Run(command));
    core.refresh();
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
    let engine = styk_engine::Engine::new(|| 0.0, styk_engine::Budgets::for_device(None));
    let prepared = styk_core::documents::PreparedDocument::open_bytes(&engine, Arc::from(json::to_string(&thirty).into_bytes()), "Thirty.styk", &|| false).unwrap();
    let second = core.documents.open(prepared).map_err(|(error, _)| error).unwrap();
    core.dispatch(Command::Activate(first));
    core.refresh();
    session(&mut core, "select", "[null,-1]");
    assert_eq!(value(&core, PropertyKey::Fps), 24.0);
    field(&mut core, PropertyKey::Fps, FieldEvent::Focus);
    field(&mut core, PropertyKey::Fps, FieldEvent::Input("25".into()));
    core.dispatch(Command::Activate(second));
    core.refresh();
    assert_eq!(core.documents.active().unwrap().id(), second);
    session(&mut core, "select", "[null,-1]");
    assert_eq!(value(&core, PropertyKey::Fps), 30.0, "the new document's model");
    assert!(core.inspector().field().is_none(), "no draft of the old document remains");
    assert_eq!(core.documents.get(first).unwrap().with_document(|typed| typed.fps).unwrap(), 25.0, "the edit was finished on its own document");

    // An open pose gesture is finished (one entry on its own document) before the switch, which then succeeds.
    core.dispatch(Command::Activate(first));
    core.refresh();
    session(&mut core, "select", "[1,-1]");
    field(&mut core, PropertyKey::RootX, FieldEvent::Focus);
    field(&mut core, PropertyKey::RootX, FieldEvent::Input("300".into()));
    assert!(core.documents.get(first).unwrap().view().editing);
    let effects = core.dispatch(Command::Activate(second));
    core.refresh();
    assert!(notices(&effects).is_empty(), "{:?}", notices(&effects));
    assert_eq!(core.documents.active().unwrap().id(), second);
    assert!(!core.documents.get(first).unwrap().view().editing);
    assert_eq!(core.documents.get(first).unwrap().view().history.undo, 2, "the frame rate and the move");
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
    core.refresh();
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
    // Two figures that are in both keyframes and not joined (a joined assembly aligns as one).
    let mut document = json::parse(SHEET).unwrap();
    for frame in document.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap() {
        for object in frame.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap() {
            object.make_obj().unwrap().set("join", Value::Null);
        }
    }
    let mut core = core_with(json::to_string(&document).as_bytes());
    session(&mut core, "selectMany", "[[1,2]]");
    let rows = styk_edit::timeline_rows(core.documents.active().unwrap().records());
    let (first, second) = (rows[0].0, rows[1].0);
    let at = |core: &mut Core, tick: f64| {
        session(core, "seek", &format!("[{tick}]"));
        object_value(core, 1.0, "root_x")
    };
    let before = (at(&mut core, first), at(&mut core, second));
    session(&mut core, "seek", &format!("[{first}]"));
    core.view_state_mut().set_range(vec![first as usize, second as usize]);
    core.view_state_mut().set_apply_range(true);
    core.refresh();
    let effects = run(&mut core, CommandId::AlignRight);
    assert!(notices(&effects).is_empty(), "{:?}", notices(&effects));
    assert_eq!(testing::undo_depth(&core), 1);
    let after = (at(&mut core, first), at(&mut core, second));
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
    core.refresh();
    assert_eq!(testing::undo_depth(&core), 1);
    assert!(value(&core, PropertyKey::PolygonZOrder(0)) > order, "sent to the front");
    core.dispatch(Command::Inspector(Event::Act(PanelAction::DeletePolygon(0))));
    core.refresh();
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
    core.refresh();
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

/// Finding 1: bounds come from the worker, stamped with what they were made for; the last ready value is shown while a
/// newer one is pending.
#[test]
fn bounds_are_made_on_the_worker_and_shown_until_newer_ones_land() {
    let mut core = core_with(SHEET);
    session(&mut core, "selectMany", "[[1,2,3]]");
    assert!(core.inspector().shown().bounds.is_none(), "nothing ready before the worker ran");
    testing::settle_facts(&mut core).unwrap();
    let first = core.inspector().shown().bounds.unwrap();
    assert!(!core.inspector().shown().stale);
    // Move the figures: the revision changes; until the worker runs the old bounds stay, marked stale.
    field(&mut core, PropertyKey::GroupX, FieldEvent::Focus);
    field(&mut core, PropertyKey::GroupX, FieldEvent::Input(format!("{}", first[0] + 50.0)));
    field(&mut core, PropertyKey::GroupX, FieldEvent::Blur);
    testing::publish(&mut core).unwrap();
    core.refresh();
    assert_eq!(core.inspector().shown().bounds, Some(first));
    assert!(core.inspector().shown().stale);
    testing::settle_facts(&mut core).unwrap();
    let moved = core.inspector().shown().bounds.unwrap();
    assert!((moved[0] - (first[0] + 50.0)).abs() < 1e-6, "{moved:?}");
    assert!(!core.inspector().shown().stale);
}
