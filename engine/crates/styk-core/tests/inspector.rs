//! The Inspector's logic without a window: every context's view model from real sessions, every kind of edit through
//! the session as one history entry with undo and redo, refusals as messages, and the model's cache.
use std::sync::Arc;

use styk_core::app::Core;
use styk_core::commands::{Command, CommandId, Effect};
use styk_core::engine::Value;
use styk_core::i18n::{Label, english};
use styk_core::inspector::model::{Inspector, Kind, Place, Row, Toggle};
use styk_core::inspector::property::PropertyKey;
use styk_core::inspector::{Event, FieldEvent, Scrub};
use styk_core::number::StepKeys;
use styk_core::view_state::{InspectorContext, InspectorTab};
use styk_core::testing;
use styk_doc::json;

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");
const NATIVE: &[u8] = include_bytes!("../../../tests/edit/selection-metadata-plain-native.document.json");
const SPRITE: &[u8] = include_bytes!("../../../tests/edit/sprite-segment-sparse-native.document.json");

include!("support/today_bounds.rs");
const TODAY_PROPERTY_SHEET_BOUNDS: [f64; 4] = TODAY_BOUNDS;


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

/// The startup document with every segment of its figure turned into `primitive` (2 image, 5 text).
fn startup_as(primitive: f64) -> Vec<u8> {
    let mut document = json::parse(STARTUP).unwrap();
    let figures = document.make_obj().unwrap().get_mut("figure_types").unwrap();
    for figure in figures.make_arr().unwrap() {
        for segment in figure.make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap() {
            segment.make_obj().unwrap().set("primitive_code", Value::Num(primitive));
        }
    }
    json::to_string(&document).into_bytes()
}

fn session(core: &mut Core, method: &str, args: &str) -> Value {
    let id = core.documents.active().unwrap().id();
    let args: Vec<Value> = json::parse(args.as_bytes()).unwrap().elements().unwrap().iter().collect();
    let answer = core.documents.call(id, method, &args, &Value::Null).unwrap();
    testing::settle_facts(core).unwrap();
    answer.result.unwrap()
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

fn undo_depth(core: &Core) -> usize {
    core.documents.active().unwrap().view().unwrap().history.undo
}

fn records(core: &Core) -> String {
    json::to_string(core.documents.active().unwrap().records().unwrap())
}

fn section_ids(inspector: &Inspector) -> Vec<&'static str> {
    inspector.sections.iter().map(|section| section.id).collect()
}

fn plain() -> StepKeys {
    StepKeys::default()
}

fn notices(effects: &[Effect]) -> Vec<String> {
    effects.iter().filter_map(|effect| match effect {
        Effect::Notice(notice) => Some(english(&notice.message)),
        _ => None,
    }).collect()
}

#[test]
fn no_selection_shows_the_scene() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[null,-1]");
    let scene = model(&core);
    assert_eq!(scene.kind, Kind::Scene);
    assert_eq!(scene.target.name.english(), "Scene");
    assert_eq!(section_ids(&scene), ["summary", "canvas", "background", "playback"]);
    let Row::Meta(summary) = &scene.section("summary").unwrap().rows[0] else { panic!("a summary line") };
    assert_eq!(english(summary), "1 figure · 10 frames · 0.42 s");
    assert_eq!(value(&core, PropertyKey::CanvasWidth), 960.0);
    assert_eq!(value(&core, PropertyKey::CanvasHeight), 540.0);
    assert_eq!(value(&core, PropertyKey::Fps), 24.0);
    let fps = scene.number(PropertyKey::Fps).unwrap();
    assert_eq!((fps.min, fps.max, fps.precision, fps.display_precision, fps.unit), (1.0, 120.0, 0, 0, "fps"));
    assert_eq!(scene.section("background").unwrap().actions.len(), 1, "Import background as its title action");
}

#[test]
fn a_figure_shows_transform_appearance_arrange_and_its_colours() {
    let core = core_with(STARTUP);
    let figure = model(&core);
    assert_eq!(figure.kind, Kind::Figure);
    assert_eq!(figure.target.name.english(), "Blue");
    assert_eq!(figure.target.kind_label.english(), "Figure");
    assert!(figure.target.rename.is_some(), "a figure renames in the header");
    assert_eq!(section_ids(&figure), ["transform", "appearance", "arrange", "colours"]);
    assert_eq!(value(&core, PropertyKey::RootX), 480.0);
    assert_eq!(value(&core, PropertyKey::RootY), 280.0);
    assert_eq!(value(&core, PropertyKey::Scale), 100.0);
    assert_eq!(value(&core, PropertyKey::Rotation), 0.0, "relative to the first segment");
    assert_eq!(value(&core, PropertyKey::FigureOpacity), 100.0);
    let colours = figure.section("colours").unwrap();
    assert_eq!((colours.place, colours.open), (Place::Titled, false), "titled and closed until opened");
    assert_eq!(figure.quick, Some("figure"));
}

#[test]
fn text_and_image_figures_are_their_own_kinds() {
    let text = core_with(&startup_as(5.0));
    assert_eq!(model(&text).kind, Kind::Text);
    assert_eq!(model(&text).target.glyph, Some("text"));
    let arrange = model(&text).section("arrange").unwrap().place;
    assert_eq!(arrange, Place::Titled, "a text's Arrange folds");
    assert!(model(&text).section("text").is_some(), "Edit text");
    let image = core_with(&startup_as(2.0));
    assert_eq!(model(&image).kind, Kind::Image);
    assert_eq!(model(&image).target.glyph, Some("image"));
    // A sprite of a real document: the placed sprite is an image.
    let mut sprite = core_with(SPRITE);
    session(&mut sprite, "select", "[3,-1]");
    assert_eq!(model(&sprite).kind, Kind::Image);
}

#[test]
fn a_joint_shows_joint_style_and_its_figure_s_layer() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,1]");
    let joint = model(&core);
    assert_eq!(joint.kind, Kind::Joint);
    assert_eq!(joint.target.name.english(), "Head");
    assert_eq!(section_ids(&joint), ["joint", "ik", "style", "second-colour", "figure"]);
    let frame = core.documents.active().unwrap().frame_records().unwrap();
    let angle = frame.get("objects").unwrap().item(0).unwrap().get("angles").unwrap().item(1).unwrap().as_f64().unwrap();
    assert_eq!(value(&core, PropertyKey::JointAngle), angle * 180.0 / std::f64::consts::PI);
    assert_eq!(value(&core, PropertyKey::JointLength), 44.0);
    assert_eq!(value(&core, PropertyKey::Thickness), 0.0);
    assert_eq!(value(&core, PropertyKey::SegmentOpacity), 100.0);
    let second = joint.section("second-colour").unwrap();
    assert!(second.switch.is_some() && !second.open, "a circle can take a second colour; off, it stays folded");
}

#[test]
fn several_figures_show_their_bounds_align_and_mixed_values() {
    let mut core = core_with(SHEET);
    let gate = testing::hold_facts(&mut core).unwrap();
    testing::call_unsettled(&mut core, "selectMany", "[[1,2,3]]").unwrap();
    let figures = model(&core);
    assert_eq!(figures.kind, Kind::Figures);
    assert_eq!(figures.target.name.english(), "3 figures");
    assert_eq!(section_ids(&figures)[..4], ["selection", "align", "appearance", "arrange"]);
    assert!(figures.section("connection").is_some(), "a joined figure among them offers Combine");
    // The bounds are made on the worker: pending until it has run, never computed by the refresh itself.
    assert!(figures.number(PropertyKey::GroupX).unwrap().pending, "no geometry on the interface thread");
    gate.entered();
    gate.release();
    testing::settle_facts(&mut core).unwrap();
    // Today's app on the same document and selection: the union of `boundsOf` over the three figures
    // (`window.styk.boundsOf`, headless Chromium, captured with the screen references).
    let [min_x, min_y, max_x, max_y] = TODAY_PROPERTY_SHEET_BOUNDS;
    assert!(!model(&core).number(PropertyKey::GroupX).unwrap().pending);
    assert!((value(&core, PropertyKey::GroupX) - min_x).abs() < 1e-9, "{} against today's {min_x}", value(&core, PropertyKey::GroupX));
    assert!((value(&core, PropertyKey::GroupY) - min_y).abs() < 1e-9);
    assert!((value(&core, PropertyKey::GroupWidth) - (max_x - min_x)).abs() < 1e-9);
    assert!((value(&core, PropertyKey::GroupHeight) - (max_y - min_y)).abs() < 1e-9);
    let Row::Actions(align) = &figures.section("align").unwrap().rows[0] else { panic!("the align row") };
    assert_eq!(align.items.len(), 6);
}

#[test]
fn the_camera_layer_and_frame_contexts() {
    let mut core = core_with(STARTUP);
    core.view_state_mut().set_context(InspectorContext::Camera);
    testing::settle_facts(&mut core).unwrap();
    let camera = model(&core);
    assert_eq!(camera.kind, Kind::Camera);
    assert_eq!(section_ids(&camera), ["preview", "tabs", "transform", "framing"]);
    assert_eq!(value(&core, PropertyKey::CameraScale), 100.0);
    assert!(camera.section("transform").unwrap().actions[1].disabled, "Paste waits for a copied pose");
    core.dispatch(Command::Inspector(Event::Segment(styk_core::inspector::model::Segments::CameraTab, "motion")));
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(section_ids(&model(&core)), ["preview", "tabs", "motion"]);

    core.view_state_mut().set_context(InspectorContext::Layer);
    testing::settle_facts(&mut core).unwrap();
    let layer = model(&core);
    assert_eq!((layer.kind, layer.target.name.english()), (Kind::Layer, "Layer 1".to_string()));

    core.view_state_mut().set_context(InspectorContext::Auto);
    core.view_state_mut().set_tab(InspectorTab::Animation);
    testing::settle_facts(&mut core).unwrap();
    let frame = model(&core);
    assert_eq!(frame.kind, Kind::Frame, "a layer sheet's frame");
    assert_eq!(frame.section("exposure").unwrap().title.as_ref().map(Label::english).as_deref(), Some("Layer 1"));
    assert_eq!(value(&core, PropertyKey::Duration), 10.0);

    // A classic document opens on the layer timeline, as today's editor opens it: its frames are a sheet's.
    let mut classic = core_with(NATIVE);
    classic.view_state_mut().set_tab(InspectorTab::Animation);
    classic.refresh();
    assert_eq!(model(&classic).kind, Kind::Frame);
    assert_eq!(value(&classic, PropertyKey::Duration), 6.0);
}

#[test]
fn a_scrub_is_one_history_entry_and_undo_redo_come_back_through_the_model() {
    let mut core = core_with(STARTUP);
    let before = records(&core);
    field(&mut core, PropertyKey::RootX, FieldEvent::Scrub(Scrub::Begin));
    for _ in 0..5 {
        field(&mut core, PropertyKey::RootX, FieldEvent::Scrub(Scrub::Delta { dx: 4.0, keys: plain() }));
    }
    let frame = core.documents.active().unwrap().frame_records().unwrap();
    assert_eq!(frame.get("objects").unwrap().item(0).unwrap().get("root_x").unwrap().as_f64(), Some(500.0), "a live preview");
    assert_eq!(undo_depth(&core), 0, "nothing in history while the scrub is open");
    assert_eq!(core.inspector().field().unwrap().text, "500");
    field(&mut core, PropertyKey::RootX, FieldEvent::Scrub(Scrub::End));
    assert_eq!(undo_depth(&core), 1, "one entry for the whole scrub");
    assert_eq!(value(&core, PropertyKey::RootX), 500.0);
    run(&mut core, CommandId::Undo);
    assert_eq!(value(&core, PropertyKey::RootX), 480.0);
    assert_eq!(records(&core), before, "undo restores the document exactly");
    run(&mut core, CommandId::Redo);
    assert_eq!(value(&core, PropertyKey::RootX), 500.0);
}

#[test]
fn escape_cancels_a_scrub_and_leaves_no_entry() {
    let mut core = core_with(STARTUP);
    let before = records(&core);
    field(&mut core, PropertyKey::Rotation, FieldEvent::Scrub(Scrub::Begin));
    field(&mut core, PropertyKey::Rotation, FieldEvent::Scrub(Scrub::Delta { dx: 30.0, keys: plain() }));
    assert_ne!(json::to_string(&core.documents.active().unwrap().frame_records().unwrap()), "");
    field(&mut core, PropertyKey::Rotation, FieldEvent::Scrub(Scrub::Cancel));
    assert_eq!(undo_depth(&core), 0);
    assert_eq!(records(&core), before);
    assert_eq!(value(&core, PropertyKey::Rotation), 0.0);
    assert!(!core.documents.active().unwrap().view().unwrap().editing, "the session's gesture is closed");
}

#[test]
fn a_typed_value_commits_once_on_enter_and_escape_restores() {
    let mut core = core_with(STARTUP);
    field(&mut core, PropertyKey::Scale, FieldEvent::Focus);
    field(&mut core, PropertyKey::Scale, FieldEvent::Input("1".into()));
    field(&mut core, PropertyKey::Scale, FieldEvent::Input("15".into()));
    field(&mut core, PropertyKey::Scale, FieldEvent::Input("150".into()));
    assert_eq!(undo_depth(&core), 0);
    let effects = field(&mut core, PropertyKey::Scale, FieldEvent::Enter);
    assert!(effects.contains(&Effect::Blur), "Enter commits and leaves the field");
    field(&mut core, PropertyKey::Scale, FieldEvent::Blur);
    assert_eq!(undo_depth(&core), 1, "one entry for the typed value");
    assert_eq!(value(&core, PropertyKey::Scale), 150.0);

    field(&mut core, PropertyKey::Scale, FieldEvent::Focus);
    field(&mut core, PropertyKey::Scale, FieldEvent::Input("40".into()));
    field(&mut core, PropertyKey::Scale, FieldEvent::Escape);
    assert_eq!(core.inspector().field().unwrap().text, "150", "Escape restores and keeps focus");
    field(&mut core, PropertyKey::Scale, FieldEvent::Blur);
    assert_eq!(undo_depth(&core), 1);
    assert_eq!(value(&core, PropertyKey::Scale), 150.0);
    run(&mut core, CommandId::Undo);
    assert_eq!(value(&core, PropertyKey::Scale), 100.0);
    run(&mut core, CommandId::Redo);
    assert_eq!(value(&core, PropertyKey::Scale), 150.0);
}

#[test]
fn invalid_text_never_reaches_the_document() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[null,-1]");
    let before = records(&core);
    field(&mut core, PropertyKey::Fps, FieldEvent::Focus);
    field(&mut core, PropertyKey::Fps, FieldEvent::Input("abc".into()));
    assert_eq!(english(&core.inspector().field().unwrap().invalid.unwrap()), english(&styk_core::i18n::Msg::new("propertyControls.enterAFiniteNumber")));
    field(&mut core, PropertyKey::Fps, FieldEvent::Input("500".into()));
    assert!(core.inspector().field().unwrap().invalid.is_some(), "out of the field's range");
    field(&mut core, PropertyKey::Fps, FieldEvent::Blur);
    assert_eq!(records(&core), before);
    assert_eq!(undo_depth(&core), 0);
}

#[test]
fn held_arrow_keys_are_one_gesture() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,1]");
    for _ in 0..3 {
        field(&mut core, PropertyKey::JointLength, FieldEvent::KeyStep { direction: 1, keys: plain() });
    }
    field(&mut core, PropertyKey::JointLength, FieldEvent::KeyEnd);
    assert_eq!(undo_depth(&core), 1);
    assert_eq!(value(&core, PropertyKey::JointLength), 47.0);
    field(&mut core, PropertyKey::JointLength, FieldEvent::KeyStep { direction: -1, keys: StepKeys { shift: true, alt: false } });
    field(&mut core, PropertyKey::JointLength, FieldEvent::KeyEnd);
    assert_eq!(value(&core, PropertyKey::JointLength), 46.9, "Shift steps a tenth");
    run(&mut core, CommandId::Undo);
    run(&mut core, CommandId::Undo);
    assert_eq!(value(&core, PropertyKey::JointLength), 44.0);
}

/// Each route of `native-property-edit.mjs` and `propertyChannel`: one entry per commit, undo back to the start.
#[test]
fn every_kind_of_edit_is_one_entry_that_undoes_and_redoes() {
    // (fixture, selection, context, field, value)
    type Case<'a> = (&'a [u8], &'a str, Option<InspectorContext>, PropertyKey, f64);
    let cases: &[Case] = &[
        (STARTUP, "[1,-1]", None, PropertyKey::RootY, 300.0),
        (STARTUP, "[1,-1]", None, PropertyKey::Rotation, 30.0),
        (STARTUP, "[1,-1]", None, PropertyKey::FigureOpacity, 50.0),
        (STARTUP, "[1,-1]", None, PropertyKey::FigureZOrder, 3.0),
        (STARTUP, "[1,1]", None, PropertyKey::JointAngle, 10.0),
        (STARTUP, "[1,1]", None, PropertyKey::JointBend, 12.0),
        (STARTUP, "[1,1]", None, PropertyKey::Thickness, 6.0),
        (STARTUP, "[1,1]", None, PropertyKey::SegmentOpacity, 40.0),
        (STARTUP, "[null,-1]", None, PropertyKey::Fps, 30.0),
        (STARTUP, "[null,-1]", None, PropertyKey::CanvasWidth, 1280.0),
        (STARTUP, "[1,-1]", Some(InspectorContext::Camera), PropertyKey::CameraX, 25.0),
        (STARTUP, "[1,-1]", Some(InspectorContext::Camera), PropertyKey::CameraScale, 150.0),
        (STARTUP, "[1,-1]", Some(InspectorContext::Camera), PropertyKey::CameraAngle, 15.0),
        (STARTUP, "[1,-1]", Some(InspectorContext::Frame), PropertyKey::Duration, 4.0),
        (SHEET, "[[1,2]]", None, PropertyKey::GroupX, 40.0),
        (SHEET, "[[1,2]]", None, PropertyKey::GroupWidth, 200.0),
        (STARTUP, "[1,1]", None, PropertyKey::SegmentZOrder, 1.0),
        (NATIVE, "[1,-1]", None, PropertyKey::PolygonOpacity(0), 40.0),
        (NATIVE, "[1,-1]", None, PropertyKey::PolygonZOrder(1), 1.0),
    ];
    for (bytes, selection, context, key, target) in cases {
        let mut core = core_with(bytes);
        let select = if selection.starts_with("[[") { "selectMany" } else { "select" };
        session(&mut core, select, selection);
        if let Some(context) = context {
            core.view_state_mut().set_context(*context);
            testing::settle_facts(&mut core).unwrap();
        }
        testing::settle_facts(&mut core).unwrap();
        let before = records(&core);
        let initial = value(&core, *key);
        field(&mut core, *key, FieldEvent::Focus);
        let effects = field(&mut core, *key, FieldEvent::Input(target.to_string()));
        assert!(notices(&effects).is_empty(), "{key:?}: {:?}", notices(&effects));
        assert_eq!(undo_depth(&core), 0, "{key:?}: nothing in history while typing");
        let effects = field(&mut core, *key, FieldEvent::Blur);
        assert!(notices(&effects).is_empty(), "{key:?}: {:?}", notices(&effects));
        assert_eq!(undo_depth(&core), 1, "{key:?}: one entry");
        // Facts made on the worker (a selection's bounds) follow once it has run.
        testing::settle_facts(&mut core).unwrap();
        // Opacity is stored as a transparency byte: 50 % is kept as 128 and reads back as (1 - 128/255) * 100.
        let stored = if *key == PropertyKey::FigureOpacity { (1.0 - ((1.0 - target / 100.0) * 255.0).round() / 255.0) * 100.0 } else { *target };
        let shown = value(&core, *key);
        assert!((shown - stored).abs() < 1e-9, "{key:?}: shows {shown}, wanted {stored}");
        run(&mut core, CommandId::Undo);
        testing::settle_facts(&mut core).unwrap();
        assert_eq!(records(&core), before, "{key:?}: undo restores the document");
        assert!((value(&core, *key) - initial).abs() < 1e-9, "{key:?}: the model follows undo");
        run(&mut core, CommandId::Redo);
        testing::settle_facts(&mut core).unwrap();
        assert!((value(&core, *key) - stored).abs() < 1e-9, "{key:?}: and redo");
    }
}

#[test]
fn a_refused_edit_reaches_the_person_as_a_message() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,1]");
    let before = records(&core);
    let effects = core.dispatch(Command::Inspector(Event::Choose(styk_core::inspector::model::Choice::SegmentShape, Arc::from("no-such-shape"))));
    let shown = notices(&effects);
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert!(!shown[0].contains("no-such-shape") || !shown[0].is_empty());
    assert_eq!(undo_depth(&core), 0);
    assert_eq!(records(&core), before);
}

#[test]
fn edit_together_reaches_every_chosen_frame_in_one_entry() {
    let mut core = core_with(NATIVE);
    session(&mut core, "select", "[1,-1]");
    // On a layer sheet the chosen frames are ticks: the two keyframes start at 0 and 6.
    core.view_state_mut().set_range(vec![0, 6]);
    core.dispatch(Command::Inspector(Event::Toggle(Toggle::ApplyRange, true)));
    testing::settle_facts(&mut core).unwrap();
    let inspector = model(&core);
    // Ticks 0 and 6 are not consecutive: the scope line counts them (`scopeLine`).
    assert_eq!(inspector.scope.as_ref().map(|scope| english(&scope.label)).as_deref(), Some("Editing 2 frames"));
    field(&mut core, PropertyKey::RootX, FieldEvent::Focus);
    field(&mut core, PropertyKey::RootX, FieldEvent::Input("123".into()));
    field(&mut core, PropertyKey::RootX, FieldEvent::Blur);
    assert_eq!(undo_depth(&core), 1);
    // Every chosen frame shows the value where it starts on the timeline.
    let starts: Vec<f64> = styk_edit::timeline_rows(core.documents.active().unwrap().records().unwrap()).iter().take(2).map(|row| row.0).collect();
    for tick in starts {
        session(&mut core, "seek", &format!("[{tick}]"));
        let frame = core.documents.active().unwrap().frame_records().unwrap();
        let object = frame.get("objects").unwrap().elements().unwrap().iter().find(|object| object.get("unique_id").and_then(Value::as_f64) == Some(1.0)).unwrap();
        assert_eq!(object.get("root_x").unwrap().as_f64(), Some(123.0), "the frame at tick {tick}");
    }
    run(&mut core, CommandId::ToggleRangeEdit);
    assert!(model(&core).scope.is_none(), "Stop ends Edit together");
}

#[test]
fn panel_commands_run_through_the_session() {
    let mut core = core_with(STARTUP);
    let before = records(&core);
    let effects = run(&mut core, CommandId::Rotate);
    assert!(notices(&effects).is_empty(), "{:?}", notices(&effects));
    assert_eq!(undo_depth(&core), 1);
    assert!((value(&core, PropertyKey::Rotation) - 15.0).abs() < 1e-9);
    run(&mut core, CommandId::Undo);
    assert_eq!(records(&core), before);
    assert!(matches!(run(&mut core, CommandId::CombineFigures).as_slice(), [Effect::NotAvailable(CommandId::CombineFigures)]), "a later chunk's command says so");

    core.view_state_mut().set_context(InspectorContext::Camera);
    testing::settle_facts(&mut core).unwrap();
    run(&mut core, CommandId::CameraCopy);
    assert!(!model(&core).section("transform").unwrap().actions[1].disabled, "a copied pose enables Paste");

    // Two figures that are not joined (a joined assembly aligns as one).
    let mut figures = core_with(SPRITE);
    session(&mut figures, "selectMany", "[[1,3]]");
    testing::settle_facts(&mut figures).unwrap();
    let x = value(&figures, PropertyKey::GroupX);
    run(&mut figures, CommandId::AlignRight);
    testing::settle_facts(&mut figures).unwrap();
    assert_eq!(undo_depth(&figures), 1);
    assert_ne!(value(&figures, PropertyKey::GroupX), x, "aligned to the right edge");
    run(&mut figures, CommandId::Undo);
    testing::settle_facts(&mut figures).unwrap();
    assert_eq!(value(&figures, PropertyKey::GroupX), x);
}

#[test]
fn switches_and_selects_are_one_entry_each() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,1]");
    core.dispatch(Command::Inspector(Event::Toggle(Toggle::StaticJoint, true)));
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(undo_depth(&core), 1);
    let Some(Row::Grid { rows, .. }) = model(&core).section("joint").map(|section| section.rows[0].clone()) else { panic!("joint grid") };
    assert!(rows.iter().any(|row| matches!(row, Row::Switch(switch) if switch.toggle == Toggle::StaticJoint && switch.checked)));
    core.dispatch(Command::Inspector(Event::Choose(styk_core::inspector::model::Choice::SegmentShape, Arc::from("circle"))));
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(undo_depth(&core), 2);
    run(&mut core, CommandId::Undo);
    run(&mut core, CommandId::Undo);
    assert_eq!(undo_depth(&core), 0);
}

#[test]
fn renaming_in_the_header_is_one_entry_and_a_blank_name_keeps_the_old() {
    use styk_core::inspector::RenameEvent;
    let mut core = core_with(STARTUP);
    let rename = |core: &mut Core, event| {
        core.dispatch(Command::Inspector(Event::Rename(event)));
        testing::settle_facts(core).unwrap();
    };
    rename(&mut core, RenameEvent::Begin);
    assert_eq!(core.inspector().rename().unwrap().text, "Blue");
    rename(&mut core, RenameEvent::Input("   ".into()));
    rename(&mut core, RenameEvent::Commit);
    assert_eq!(undo_depth(&core), 0);
    rename(&mut core, RenameEvent::Begin);
    rename(&mut core, RenameEvent::Input("Walker".into()));
    rename(&mut core, RenameEvent::Commit);
    assert_eq!(undo_depth(&core), 1);
    assert_eq!(model(&core).target.name.english(), "Walker");
}

#[test]
fn the_model_is_rebuilt_only_when_its_inputs_change_and_held_during_a_gesture() {
    let mut core = core_with(STARTUP);
    let builds = core.inspector().builds;
    testing::settle_facts(&mut core).unwrap();
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(core.inspector().builds, builds, "nothing changed");
    core.dispatch(Command::Inspector(Event::Section { id: "colours", open: true }));
    testing::settle_facts(&mut core).unwrap();
    assert!(model(&core).section("colours").unwrap().open, "the section opened");
    assert_eq!(core.inspector().memory().saved().get("figure").map(|open| open.contains("colours")), Some(true));
    let builds = core.inspector().builds;
    field(&mut core, PropertyKey::RootX, FieldEvent::Scrub(Scrub::Begin));
    field(&mut core, PropertyKey::RootX, FieldEvent::Scrub(Scrub::Delta { dx: 10.0, keys: plain() }));
    field(&mut core, PropertyKey::RootX, FieldEvent::Scrub(Scrub::Delta { dx: 10.0, keys: plain() }));
    assert_eq!(core.inspector().builds, builds, "held while the gesture is open");
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::RootX, FieldEvent::Scrub(Scrub::End))));
    assert_eq!(core.inspector().builds, builds + 1, "the committed value is published before derived facts land");
    let committed = model(&core);
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(model(&core), committed, "derived facts preserve the authoritative committed model");
    let builds = core.inspector().builds;
    core.refresh();
    assert_eq!(core.inspector().builds, builds, "unchanged inputs still build nothing");
}

#[test]
fn every_message_the_inspector_shows_is_in_today_s_catalogue() {
    fn walk(rows: &[Row], out: &mut Vec<String>) {
        for row in rows {
            match row {
                Row::Grid { rows, .. } => walk(rows, out),
                Row::Group { head, rows, .. } => {
                    out.push(head.label.key.to_string());
                    out.extend(head.swatch.iter().map(|swatch| swatch.description.key.to_string()));
                    out.extend(head.actions.iter().map(|item| item.label.key.to_string()));
                    walk(rows, out);
                }
                Row::Swatches { items, .. } => out.extend(items.iter().map(|item| item.description.key.to_string())),
                Row::Number(number) => out.extend(label_key(&number.label)),
                Row::Select(select) => out.push(select.label.key.to_string()),
                Row::Switch(switch) => out.push(switch.label.key.to_string()),
                Row::Color(color) => out.push(color.label.key.to_string()),
                Row::Actions(actions) => out.extend(actions.items.iter().map(|item| item.label.key.to_string())),
                Row::Meta(meta) => out.push(meta.key.to_string()),
                _ => {}
            }
        }
    }
    fn label_key(label: &Label) -> Option<String> {
        match label {
            Label::Msg(msg) => Some(msg.key.to_string()),
            Label::Plain(_) => None,
        }
    }
    let mut keys = Vec::new();
    let mut collect = |core: &Core| {
        let inspector = model(core);
        keys.extend(label_key(&inspector.target.name));
        keys.extend(label_key(&inspector.target.kind_label));
        for section in &inspector.sections {
            keys.extend(section.title.as_ref().and_then(label_key));
            keys.extend(section.actions.iter().map(|action| action.label.key.to_string()));
            walk(&section.rows, &mut keys);
        }
    };
    let mut core = core_with(STARTUP);
    collect(&core);
    session(&mut core, "select", "[1,1]");
    collect(&core);
    session(&mut core, "select", "[null,-1]");
    collect(&core);
    for context in [InspectorContext::Camera, InspectorContext::Layer, InspectorContext::Frame] {
        core.view_state_mut().set_context(context);
        testing::settle_facts(&mut core).unwrap();
        collect(&core);
    }
    let mut sheet = core_with(SHEET);
    session(&mut sheet, "selectMany", "[[1,2,3]]");
    collect(&sheet);
    let missing: Vec<&String> = keys.iter().filter(|key| !styk_core::i18n::has(key)).collect();
    assert!(missing.is_empty(), "keys missing from src/locales/en.mjs: {missing:?}");
}

/// `figureJoinAction`: Join… is offered whenever one figure is selected, though the frame holds no other figure yet (the
/// join tool then asks for a joint); several figures selected leave it off. The library footer shows under any
/// selection (`user-library.mjs` `syncSelection`).
#[test]
fn join_follows_the_selection_and_the_library_footer_shows_under_one() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[null,-1]");
    assert!(!model(&core).library, "nothing selected: no footer");
    session(&mut core, "select", "[1,-1]");
    let figure = model(&core);
    let join = &figure.section("arrange").unwrap().actions[0];
    assert_eq!(join.label.key, "inspectorView.join");
    assert!(!join.disabled, "one figure selected: Join… is offered");
    assert!(figure.library, "a selection shows the Library's footer");
}

#[test]
fn bounds_are_prepared_on_the_facts_thread() {
    let mut core = core_with(SHEET);
    let interface = std::thread::current().id();
    let gate = testing::hold_facts(&mut core).unwrap();
    testing::call_unsettled(&mut core, "selectMany", "[[1,2,3]]").unwrap();
    assert_ne!(gate.entered(), interface);
    assert!(model(&core).number(PropertyKey::GroupWidth).unwrap().pending);
    gate.release();
    testing::settle_facts(&mut core).unwrap();
    assert!(value(&core, PropertyKey::GroupWidth) > 0.0);
}

#[test]
fn a_committed_number_and_unaffected_rows_stay_authoritative_while_facts_wait() {
    let mut core = core_with(STARTUP);
    let gate = testing::hold_facts(&mut core).unwrap();
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::RootX, FieldEvent::Scrub(Scrub::Begin))));
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::RootX, FieldEvent::Scrub(Scrub::Delta { dx: 4.0, keys: plain() }))));
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::RootX, FieldEvent::Scrub(Scrub::End))));
    core.refresh();
    let shown = model(&core);
    for (key, expected) in [(PropertyKey::RootX, 484.0), (PropertyKey::RootY, 280.0), (PropertyKey::Scale, 100.0), (PropertyKey::FigureOpacity, 100.0)] {
        let row = shown.number(key).unwrap();
        assert_eq!(row.value, expected, "{key:?}");
        assert!(!row.pending && !row.disabled, "{key:?} remains editable: {row:?}");
    }
    gate.release();
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(model(&core).number(PropertyKey::RootX).unwrap().value, 484.0);
}

#[test]
fn clearing_selection_with_ready_records_withdraws_older_facts() {
    let mut core = core_with(SHEET);
    let gate = testing::hold_facts(&mut core).unwrap();
    testing::call_unsettled(&mut core, "selectMany", "[[1,2,3]]").unwrap();
    gate.entered();
    testing::call_unsettled(&mut core, "selectMany", "[[]]").unwrap();
    gate.release();
    testing::settle_facts(&mut core).unwrap();
    assert!(core.facts().unwrap().cancelled > 0);
    assert!(!core.facts().unwrap().in_flight());
}

#[test]
fn a_committed_segment_value_stays_enabled_while_appearance_facts_wait() {
    let mut core = core_with(STARTUP);
    session(&mut core, "select", "[1,1]");
    let gate = testing::hold_facts(&mut core).unwrap();
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::Thickness, FieldEvent::Scrub(Scrub::Begin))));
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::Thickness, FieldEvent::Scrub(Scrub::Delta { dx: 4.0, keys: plain() }))));
    core.dispatch(Command::Inspector(Event::Field(PropertyKey::Thickness, FieldEvent::Scrub(Scrub::End))));
    core.refresh();
    for key in [PropertyKey::Thickness, PropertyKey::JointLength, PropertyKey::JointAngle] {
        let shown = model(&core);
        let row = shown.number(key).unwrap();
        assert!(!row.disabled && !row.pending, "{key:?}: {row:?}");
    }
    assert_eq!(value(&core, PropertyKey::Thickness), 4.0);
    fn colours(rows: &[Row]) {
        for row in rows {
            match row {
                Row::Grid { rows, .. } | Row::Group { rows, .. } => colours(rows),
                Row::Color(row) => assert!(!row.disabled, "an unchanged colour remains editable"),
                _ => {}
            }
        }
    }
    for section in &model(&core).sections { colours(&section.rows); }
    gate.release();
    testing::settle_facts(&mut core).unwrap();
    assert_eq!(value(&core, PropertyKey::Thickness), 4.0);
}
