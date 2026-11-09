//! B1: the Inspector's colour rows (the picker's request and commits), the figure's layer select, and their saves.

use std::sync::Arc;
use std::time::Duration;

use styk_core::app::Core;
use styk_core::commands::{Command, CommandId, Effect};
use styk_core::i18n::english;
use styk_core::inspector::model::{Choice, ColorTarget, Paint, Row, Toggle};
use styk_core::inspector::paint::{PaintSpec, PaintType, Stop};
use styk_core::inspector::{Event, PaintEvent};
use styk_core::testing;
use styk_doc::{Value, json};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");
const NATIVE: &[u8] = include_bytes!("../../../tests/edit/selection-metadata-plain-native.document.json");

struct Threads;

impl styk_services::Spawner for Threads {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        std::thread::Builder::new().name(name.to_owned()).spawn(job).map(|_| ()).map_err(|error| styk_services::SpawnError(error.to_string()))
    }
}

fn core_with(bytes: &[u8]) -> Core {
    testing::core_with_document(bytes, "Test.styk", Arc::new(Threads)).unwrap()
}

fn inspector(core: &mut Core, event: Event) -> Vec<Effect> {
    let effects = core.dispatch(Command::Inspector(event));
    testing::settle_facts(core).unwrap();
    effects
}

fn records(core: &Core) -> String {
    json::to_string(core.documents.active().unwrap().records().unwrap())
}

/// Equal records, or the place they first differ.
fn same(left: &str, right: &str, what: &str) {
    if left != right {
        let at = left.bytes().zip(right.bytes()).position(|(a, b)| a != b).unwrap_or(left.len().min(right.len()));
        let around = |text: &str| text[at.saturating_sub(120).min(text.len())..(at + 120).min(text.len())].to_owned();
        panic!("{what}: differ at {at}:
{}
{}", around(left), around(right));
    }
}

/// Opens the picker on `target` and returns its request id.
fn open(core: &mut Core, target: ColorTarget) -> u64 {
    let effects = inspector(core, Event::Color(target));
    assert!(effects.contains(&Effect::PickColor(target)), "{effects:?}");
    let request = core.inspector().picker().expect("the picker's request").clone();
    assert_eq!(request.target, target);
    request.id
}

fn commit(core: &mut Core, request: u64, paint: PaintSpec) -> Vec<Effect> {
    inspector(core, Event::Paint(PaintEvent::Commit { request, paint }))
}

fn gradient() -> PaintSpec {
    PaintSpec { kind: PaintType::Linear, angle: 45.0, stops: vec![Stop::new(0.0, [255, 0, 0], 1.0), Stop::new(0.4, [0, 128, 255], 0.5), Stop::new(1.0, [10, 20, 30], 1.0)] }
}

fn edit_together(core: &mut Core) {
    // On a layer sheet the chosen frames are ticks: this fixture's two keyframes start at 0 and 6.
    core.view_state_mut().set_range(vec![0, 6]);
    inspector(core, Event::Toggle(Toggle::ApplyRange, true));
}

/// Lets the documents host answer through the app's real adapter (`Core::poll_document`) until the panel's layer
/// move has ended. A hang guard, not a timing bound.
fn finish_move(core: &mut Core) {
    for _ in 0..15_000 {
        while core.poll_document().is_some() {}
        core.refresh();
        if core.inspector().layer_move().is_none() {
            testing::settle_facts(core).unwrap();
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("the layer move did not end");
}

/// What a case selects and sets up before its edit, as `tests/native-inspector-save-reference.test.mjs` does.
fn prepare(core: &mut Core, case: &str) {
    match case {
        "figure-color" | "figure-opacity" | "figure-range" | "palette" | "palette-repeat" | "polygon" | "layer" => testing::call(core, "select", "[1,-1]").unwrap(),
        "segment-paint" => testing::call(core, "select", "[1,0]").unwrap(),
        "second-colour" => testing::call(core, "select", "[1,2]").unwrap(),
        "segment-gradient" => {
            testing::call(core, "select", "[1,2]").unwrap();
            testing::call(core, "updateBuilderSegmentStyle", r##"[{"gradient":{"color":"#ffffff"}},{"branch":false}]"##).unwrap();
        }
        "palette-range" => {
            testing::call(core, "select", "[1,-1]").unwrap();
            testing::call(core, "seek", "[6]").unwrap();
            testing::call(core, "setFigureColor", r##"["#ff0000",{"opacity":1}]"##).unwrap();
            testing::call(core, "seek", "[0]").unwrap();
        }
        _ => {}
    }
}

/// The history entries a case's edit makes (a picker opened once and committed twice makes two).
fn entries(case: &str) -> usize {
    if case == "palette-repeat" { 2 } else { 1 }
}

/// The swatch of the palette colour `from` (`#rrggbb`).
fn swatch_of(core: &Core, from: &str) -> ColorTarget {
    let model = core.inspector().model().unwrap().clone();
    model.sections.iter().flat_map(|section| section.rows.iter()).find_map(|row| match row {
        Row::Swatches { items, .. } => items.iter().find(|item| format!("#{:02x}{:02x}{:02x}", item.rgb[0], item.rgb[1], item.rgb[2]) == from).map(|item| item.target),
        _ => None,
    }).expect("the swatch of today's first palette colour")
}

/// The case's edit on the native panel: the same edit as the oracle's, through the panel's events.
fn apply(core: &mut Core, case: &str, side: &Value) {
    let solid = |rgb, opacity| PaintSpec::solid(rgb, opacity);
    if matches!(case, "figure-range" | "background-range" | "palette-range") {
        edit_together(core);
    }
    let shown = |core: &Core| core.inspector().picker().unwrap().paint.stops[0].rgb();
    match case {
        "figure-color" => {
            let id = open(core, ColorTarget::Figure);
            commit(core, id, solid([255, 0, 0], 0.5));
        }
        "figure-opacity" => {
            let id = open(core, ColorTarget::Figure);
            let rgb = shown(core);
            commit(core, id, solid(rgb, 0.25));
        }
        "figure-range" => {
            let id = open(core, ColorTarget::Figure);
            commit(core, id, solid([0, 255, 0], 1.0));
        }
        "palette" | "palette-range" | "palette-repeat" => {
            let from = side.get("from").and_then(Value::as_str).unwrap().to_owned();
            let target = swatch_of(core, &from);
            let id = open(core, target);
            commit(core, id, solid([0, 128, 0], 1.0));
            if case == "palette-repeat" {
                commit(core, id, solid([0, 0, 255], 1.0));
            }
        }
        "second-colour" => {
            inspector(core, Event::Toggle(Toggle::SecondaryColor, true));
        }
        "segment-gradient" => {
            let id = open(core, ColorTarget::SegmentGradient);
            commit(core, id, solid([0x12, 0x34, 0x56], 1.0));
        }
        "polygon" => {
            let id = open(core, ColorTarget::Polygon(0));
            commit(core, id, solid([10, 20, 30], 0.25));
        }
        "background-solid" | "background-range" | "background-gradient" => {
            let id = open(core, ColorTarget::Background);
            let paint = match case {
                "background-solid" => solid([1, 2, 3], 1.0),
                "background-range" => solid([9, 8, 7], 0.5),
                _ => gradient(),
            };
            commit(core, id, paint);
        }
        "segment-paint" => {
            let id = open(core, ColorTarget::Segment);
            commit(core, id, gradient());
        }
        "layer" => {
            core.dispatch(Command::Inspector(Event::Choose(Choice::FigureLayer, Arc::from("layer-2"))));
            finish_move(core);
        }
        other => panic!("unknown case {other}"),
    }
    if let Some(error) = core.inspector().picker().and_then(|picker| picker.error.clone()) {
        panic!("{case}: refused: {}", english(&error));
    }
}

const CASES: [(&str, &[u8]); 14] = [
    ("figure-color", NATIVE),
    ("figure-opacity", NATIVE),
    ("figure-range", NATIVE),
    ("palette", NATIVE),
    ("polygon", NATIVE),
    ("background-solid", NATIVE),
    ("background-range", NATIVE),
    ("background-gradient", NATIVE),
    ("segment-paint", NATIVE),
    ("second-colour", NATIVE),
    ("segment-gradient", NATIVE),
    ("palette-repeat", NATIVE),
    ("palette-range", NATIVE),
    ("layer", SHEET),
];

#[test]
fn every_colour_row_and_the_layer_select_commit_one_entry_that_undoes_and_redoes() {
    for (case, bytes) in CASES {
        let mut core = core_with(bytes);
        // The fixture's most used colour, today's first palette entry (the oracle records it).
        let side = json::parse(br##"{"from":"#2b2b2b"}"##).unwrap();
        prepare(&mut core, case);
        let before = records(&core);
        let depth = testing::undo_depth(&core);
        apply(&mut core, case, &side);
        assert_eq!(testing::undo_depth(&core), depth + entries(case), "{case}: one history entry per commit");
        let edited = records(&core);
        assert_ne!(edited, before, "{case}: the edit changed the document");
        for _ in 0..entries(case) {
            core.dispatch(Command::Run(CommandId::Undo));
            testing::settle_facts(&mut core).unwrap();
        }
        same(&records(&core), &before, &format!("{case}: undo restores the document exactly"));
        for _ in 0..entries(case) {
            core.dispatch(Command::Run(CommandId::Redo));
            testing::settle_facts(&mut core).unwrap();
        }
        // The active layer is not history (setActiveLayer, as today: the oracle's redo save matches): undo restores the
        // earlier one with the document and redo does not make the moved-to layer active again.
        let redone = records(&core);
        let expected = if case == "layer" { edited.replace(r#""activeId":"layer-2""#, r#""activeId":"layer-1""#) } else { edited.clone() };
        same(&redone, &expected, &format!("{case}: redo brings the edit back exactly"));
    }
}

#[test]
fn the_segment_paint_shows_in_its_row_and_its_picker_opens_on_it() {
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,0]").unwrap();
    let id = open(&mut core, ColorTarget::Segment);
    let request = core.inspector().picker().unwrap().clone();
    assert!(request.gradients && request.alpha, "the segment's paint picker offers gradients and opacity");
    commit(&mut core, id, gradient());
    assert!(core.inspector().picker().unwrap().error.is_none(), "{:?}", core.inspector().picker().unwrap().error);
    let model = core.inspector().model().unwrap().clone();
    let row = model.color(ColorTarget::Segment).unwrap();
    let Paint::Gradient(paint) = &row.paint else { panic!("a gradient swatch: {:?}", row.paint) };
    assert_eq!((paint.kind, paint.angle, paint.stops.len()), (PaintType::Linear, 45.0, 3));
    assert_eq!((paint.stops[1].offset, paint.stops[1].opacity), (0.4, 0.5), "the stops as stored, with their opacity");
    assert_eq!(row.caption.as_ref().map(|caption| styk_core::i18n::english(&match caption {
        styk_core::i18n::Label::Msg(msg) => msg.clone(),
        styk_core::i18n::Label::Plain(text) => styk_core::i18n::Msg::owned(text.to_string()),
    })).as_deref(), Some("Linear gradient"));
    // Reopened, the picker starts from the paint now stored.
    open(&mut core, ColorTarget::Segment);
    let reopened = core.inspector().picker().unwrap();
    assert_eq!(reopened.paint.kind, PaintType::Linear);
    assert_eq!(reopened.paint.stops.len(), 3);
}

#[test]
fn each_row_opens_with_what_it_allows() {
    let mut core = core_with(NATIVE);
    let allows = |core: &mut Core, target| {
        open(core, target);
        let request = core.inspector().picker().unwrap();
        (request.gradients, request.alpha)
    };
    assert_eq!(allows(&mut core, ColorTarget::Background), (true, true));
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    assert_eq!(allows(&mut core, ColorTarget::Figure), (false, true));
    assert_eq!(allows(&mut core, ColorTarget::Polygon(0)), (false, true));
    assert_eq!(allows(&mut core, ColorTarget::Palette(0)), (false, false));
    // A fill that does not exist opens nothing (today's resolver returns false).
    let effects = inspector(&mut core, Event::Color(ColorTarget::Polygon(99)));
    assert!(!effects.iter().any(|effect| matches!(effect, Effect::PickColor(_))));
}

#[test]
fn a_commit_for_another_request_or_after_close_changes_nothing() {
    let mut core = core_with(NATIVE);
    let first = open(&mut core, ColorTarget::Background);
    let second = open(&mut core, ColorTarget::Background);
    assert_ne!(first, second, "every opening has its own identity");
    let before = records(&core);
    commit(&mut core, first, PaintSpec::solid([1, 2, 3], 1.0));
    assert_eq!(records(&core), before, "a stale picker's commit is ignored");
    inspector(&mut core, Event::Paint(PaintEvent::Close { request: first }));
    assert!(core.inspector().picker().is_some(), "closing a stale request keeps the open one");
    inspector(&mut core, Event::Paint(PaintEvent::Close { request: second }));
    assert!(core.inspector().picker().is_none());
    commit(&mut core, second, PaintSpec::solid([1, 2, 3], 1.0));
    assert_eq!(records(&core), before, "a closed picker's commit is ignored");
    assert_eq!(testing::undo_depth(&core), 0);
}

#[test]
fn the_picker_stays_open_for_several_commits_each_one_entry() {
    let mut core = core_with(NATIVE);
    let id = open(&mut core, ColorTarget::Background);
    commit(&mut core, id, PaintSpec::solid([1, 2, 3], 1.0));
    commit(&mut core, id, PaintSpec::solid([4, 5, 6], 1.0));
    assert_eq!(testing::undo_depth(&core), 2);
    assert!(core.inspector().picker().is_some_and(|picker| picker.error.is_none()));
}

#[test]
fn a_palette_commit_after_the_playhead_moved_is_refused_inline() {
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let id = open(&mut core, ColorTarget::Palette(0));
    testing::call(&mut core, "seek", "[6]").unwrap();
    let before = records(&core);
    commit(&mut core, id, PaintSpec::solid([0, 128, 0], 1.0));
    assert_eq!(records(&core), before);
    let picker = core.inspector().picker().expect("the picker stays open");
    assert_eq!(picker.error.as_ref().map(|error| error.key.as_ref()), Some("errors.app.selectionChangedReopenThePalette"));
    // A figure colour picker checks the selection: a different one is refused too.
    let id = open(&mut core, ColorTarget::Figure);
    testing::call(&mut core, "select", "[null]").unwrap();
    commit(&mut core, id, PaintSpec::solid([0, 128, 0], 1.0));
    assert_eq!(core.inspector().picker().and_then(|picker| picker.error.as_ref()).map(|error| error.key.as_ref()), Some("errors.app.selectionChangedReopenTheColorPicker"));
    assert_eq!(testing::undo_depth(&core), 0);
}

#[test]
fn an_invalid_paint_is_refused_inline_and_a_later_commit_clears_it() {
    let mut core = core_with(NATIVE);
    let id = open(&mut core, ColorTarget::Background);
    let bad = PaintSpec { kind: PaintType::Linear, angle: 0.0, stops: vec![Stop::new(0.0, [0, 0, 0], 1.0)] };
    commit(&mut core, id, bad);
    assert_eq!(core.inspector().picker().and_then(|picker| picker.error.as_ref()).map(|error| error.key.as_ref()), Some("errors.paint.useBetween2And32GradientStops"));
    commit(&mut core, id, PaintSpec::solid([1, 2, 3], 1.0));
    assert!(core.inspector().picker().is_some_and(|picker| picker.error.is_none()));
    assert_eq!(testing::undo_depth(&core), 1);
}

#[test]
fn the_picker_closes_when_another_document_becomes_active() {
    let mut core = core_with(NATIVE);
    let id = open(&mut core, ColorTarget::Background);
    testing::open_document(&mut core, STARTUP, "Other.styk").unwrap();
    assert!(core.inspector().picker().is_none());
    let before = records(&core);
    commit(&mut core, id, PaintSpec::solid([1, 2, 3], 1.0));
    assert_eq!(records(&core), before, "nothing reaches the other document");
}

#[test]
fn moving_figures_to_a_layer_makes_it_active_and_selects_its_track() {
    let mut core = core_with(SHEET);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    core.dispatch(Command::Inspector(Event::Choose(Choice::FigureLayer, Arc::from("layer-2"))));
    finish_move(&mut core);
    assert_eq!(testing::undo_depth(&core), 1, "one history entry");
    assert_eq!(core.view_state().layers(), &["layer-2"]);
    let records = core.documents.active().unwrap().records().unwrap().clone();
    assert_eq!(records.path(&["_styk", "layers", "activeId"]).and_then(Value::as_str), Some("layer-2"));
}

#[test]
fn a_palette_picker_reaches_the_same_targets_on_every_commit() {
    // Review finding 1: the second commit of one opening found no row of the old colour and changed nothing.
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let target = swatch_of(&core, "#2b2b2b");
    let id = open(&mut core, target);
    commit(&mut core, id, PaintSpec::solid([0, 128, 0], 1.0));
    let green = records(&core);
    commit(&mut core, id, PaintSpec::solid([0, 0, 255], 1.0));
    assert!(core.inspector().picker().is_some_and(|picker| picker.error.is_none()));
    assert_eq!(testing::undo_depth(&core), 2, "each commit is one entry");
    assert_ne!(records(&core), green, "the second commit recolours what the first did");
    assert!(records(&core).contains("[0,0,255]"), "the targets now show the second colour");
}

#[test]
fn moving_figures_to_a_layer_runs_on_the_session_worker_with_a_timed_dialog() {
    // Review finding 2: the move never runs on the interface thread; the synchronous seam refuses it.
    let mut core = core_with(SHEET);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let id = core.documents.active().unwrap().id();
    let refused = core.documents.call(id, "assignFiguresToLayer", &[json::parse(b"[1]").unwrap(), Value::str("layer-2")], &Value::Null);
    assert!(matches!(refused, Err(styk_core::documents::DocumentsError::AsyncRequired { .. })), "{refused:?}");
    core.dispatch(Command::Wake { now: 1_000 });
    core.dispatch(Command::Inspector(Event::Choose(Choice::FigureLayer, Arc::from("layer-2"))));
    let moving = core.inspector().layer_move().expect("the move runs on the worker");
    assert!(!moving.dialog);
    assert_eq!(core.inspector().deadline(), Some(1_150), "the dialog is due 150 ms after the move began");
    assert!(core.next_deadline().is_some_and(|due| due <= 1_150), "the core wakes for it");
    core.dispatch(Command::Wake { now: 1_149 });
    assert!(!core.inspector().layer_move().unwrap().dialog);
    core.dispatch(Command::Wake { now: 1_150 });
    assert!(core.inspector().layer_move().unwrap().dialog, "today's dialog shows after 150 ms");
    finish_move(&mut core);
    assert_eq!(testing::undo_depth(&core), 1);
    assert_eq!(core.view_state().layers(), &["layer-2"]);
}

#[test]
fn a_cancelled_layer_move_leaves_the_document_as_it_was() {
    let mut core = core_with(SHEET);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let before = records(&core);
    core.dispatch(Command::Inspector(Event::Choose(Choice::FigureLayer, Arc::from("layer-2"))));
    assert!(core.inspector().layer_move().is_some());
    core.dispatch(Command::Inspector(Event::CancelLayerMove));
    finish_move(&mut core);
    // The worker may have committed before the cancel reached it; either way the outcome is whole.
    if testing::undo_depth(&core) == 0 {
        same(&records(&core), &before, "a cancelled move changes nothing");
        assert_ne!(core.view_state().layers(), &["layer-2"]);
    } else {
        assert_eq!(testing::undo_depth(&core), 1);
        assert_eq!(core.view_state().layers(), &["layer-2"]);
    }
}

#[test]
fn a_restyled_instance_waits_for_its_resolution_from_the_facts_lane() {
    // Review finding 3: refresh never resolves a style overlay; the rows wait for the lane's, made for this state.
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,0]").unwrap();
    let id = open(&mut core, ColorTarget::Segment);
    core.dispatch(Command::Inspector(Event::Paint(PaintEvent::Commit { request: id, paint: gradient() })));
    testing::publish(&mut core).unwrap();
    core.refresh();
    assert!(core.inspector().pending() || core.inspector().shown().subject.is_some(), "never built before the lane's facts for this state");
    testing::settle_facts(&mut core).unwrap();
    let shown = core.inspector().shown();
    let subject = shown.subject.as_ref().expect("the lane made the selected figure's facts");
    assert!(subject.restyled && subject.instance.is_some(), "restyled {}, resolved {}", subject.restyled, subject.instance.is_some());
    let model = core.inspector().model().unwrap().clone();
    assert!(matches!(model.color(ColorTarget::Segment).map(|row| &row.paint), Some(Paint::Gradient(_))), "the lane's resolution shows");
}

#[test]
fn a_fill_group_heads_with_its_list_row() {
    // Review finding 4: the core supplies the fill's list row; the view searches for nothing.
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    inspector(&mut core, Event::Section { id: "colours", open: true });
    let model = core.inspector().model().unwrap().clone();
    let (head, rows) = model.section("colours").unwrap().rows.iter().find_map(|row| match row {
        Row::Group { head, rows, .. } => Some((head.clone(), rows.clone())),
        _ => None,
    }).expect("a fill group");
    assert_eq!(head.glyph, "polygon");
    assert_eq!(head.swatch.as_ref().map(|swatch| swatch.target), Some(ColorTarget::Polygon(0)));
    assert_eq!(head.actions.len(), 1, "its delete");
    assert!(!rows.iter().any(|row| matches!(row, Row::Color(_))), "the colour is the head's chip, not a row");
}

#[test]
fn a_pending_panel_disables_its_swatches_and_opens_no_picker() {
    // Review finding 6: stale swatches can be neither pressed nor focused while facts are pending.
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    inspector(&mut core, Event::Section { id: "colours", open: true });
    testing::call_unsettled(&mut core, "seek", "[6]").unwrap();
    assert!(core.inspector().pending(), "the frame on show is being made");
    let model = core.inspector().model().unwrap().clone();
    for row in &model.section("colours").unwrap().rows {
        match row {
            Row::Swatches { items, .. } => assert!(items.iter().all(|item| item.disabled)),
            Row::Group { head, .. } => assert!(head.swatch.as_ref().is_some_and(|swatch| swatch.disabled) && head.actions.iter().all(|action| action.disabled)),
            _ => {}
        }
    }
    let effects = core.dispatch(Command::Inspector(Event::Color(ColorTarget::Palette(0))));
    assert!(!effects.iter().any(|effect| matches!(effect, Effect::PickColor(_))) && core.inspector().picker().is_none());
}

/// Native saves after each edit, its undo and its redo equal today's byte for byte: run
/// `tests/native-inspector-save-reference.test.mjs` against today's app first (it compares two runs of today's
/// code), then point `STYK_NATIVE_SAVE_ORACLE` at its output.
#[test]
#[ignore = "explicit byte oracle; first run tests/native-inspector-save-reference.test.mjs against the pinned app, then set STYK_NATIVE_SAVE_ORACLE"]
fn saves_equal_today() {
    let oracle = std::path::PathBuf::from(std::env::var_os("STYK_NATIVE_SAVE_ORACLE").expect("the old-versus-old baseline's directory"));
    let mut count = 0;
    for (case, bytes) in CASES {
        let side = json::parse(&std::fs::read(oracle.join(format!("{case}.json"))).unwrap()).unwrap();
        let mut rig = SaveRig::open(bytes);
        prepare(&mut rig.core, case);
        for phase in 0..4 {
            match phase {
                1 => apply(&mut rig.core, case, &side),
                2 => {
                    rig.core.dispatch(Command::Run(CommandId::Undo));
                    testing::settle_facts(&mut rig.core).unwrap();
                }
                3 => {
                    rig.core.dispatch(Command::Run(CommandId::Redo));
                    testing::settle_facts(&mut rig.core).unwrap();
                }
                _ => {}
            }
            let saved = rig.save(&format!("{case}-{phase}.styk"));
            let expected = std::fs::read(oracle.join(format!("{case}-{phase}.styk"))).unwrap();
            if saved.as_ref() != expected {
                std::fs::write(oracle.join(format!("actual-{case}-{phase}.styk")), &saved).unwrap();
            }
            assert!(saved.as_ref() == expected, "{case}/{phase}: all bytes ({} vs {} bytes)", saved.len(), expected.len());
            count += 1;
        }
    }
    assert_eq!(count, 56);
    println!("INSPECTOR_SAVE_BYTES: 56 exact comparisons passed");
}

/// A core whose document saves through the documents host (`Request::Save`) into memory, as the app saves.
struct SaveRig {
    core: Core,
    files: Arc<styk_services::files::fake::MemoryFiles>,
}

impl SaveRig {
    fn open(bytes: &[u8]) -> SaveRig {
        let files = Arc::new(styk_services::files::fake::MemoryFiles::default());
        let core = testing::core_with_files(bytes, "Parity.styk", Arc::new(Threads), files.clone()).unwrap();
        SaveRig { core, files }
    }

    fn save(&mut self, name: &str) -> Arc<[u8]> {
        use styk_core::documents::{Effect as Saved, Request};
        let id = self.core.documents.active().unwrap().id();
        let mut effect = self.request(Request::Save { document: id, save_as: true });
        while matches!(effect, Saved::Started(_) | Saved::None | Saved::Published { .. }) {
            effect = self.completion();
        }
        let Saved::SaveDialog { prompt, .. } = effect else { panic!("save target: {effect:?}") };
        let target = styk_services::files::FileTarget::new(name.to_owned());
        assert!(matches!(self.request(Request::SaveTarget { prompt, target: Some(target.clone()) }), Saved::Started(_)));
        loop {
            let effect = self.completion();
            if matches!(effect, Saved::Saved { current: true, .. }) {
                break;
            }
            assert!(matches!(effect, Saved::None | Saved::Published { .. }), "{effect:?}");
        }
        testing::settle_facts(&mut self.core).unwrap();
        self.files.get(&target).unwrap()
    }

    fn request(&mut self, mut request: styk_core::documents::Request) -> styk_core::documents::Effect {
        for _ in 0..3000 {
            match self.core.dispatch_document(request) {
                Ok(effect) => return effect,
                Err((styk_core::documents::HostError::Documents(styk_core::documents::DocumentsError::Busy), returned)) => {
                    request = returned;
                    while self.core.poll_document().is_some() {}
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err((error, _)) => panic!("request failed: {error}"),
            }
        }
        panic!("the document stayed busy")
    }

    /// The host's next answer; its worker has no wake of ours here, so this polls (a hang guard, not a timing bound).
    fn completion(&mut self) -> styk_core::documents::Effect {
        for _ in 0..3000 {
            if let Some(effect) = self.core.poll_document() {
                return effect;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the save did not answer")
    }
}

/// A spawner whose documents worker waits at a gate before it takes its first job, so a test decides when the layer
/// move runs (every other lane starts at once).
struct Gated(Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>);

impl Gated {
    fn new() -> (Arc<Gated>, Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>) {
        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        (Arc::new(Gated(gate.clone())), gate)
    }
}

fn release(gate: &(std::sync::Mutex<bool>, std::sync::Condvar)) {
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
}

impl styk_services::Spawner for Gated {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        let gate = (name == "styk-documents").then(|| self.0.clone());
        std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                if let Some(gate) = gate {
                    let mut open = gate.0.lock().unwrap();
                    while !*open {
                        open = gate.1.wait(open).unwrap();
                    }
                }
                job()
            })
            .map(|_| ())
            .map_err(|error| styk_services::SpawnError(error.to_string()))
    }
}

/// A sheet with figure 1 selected, focus on a control of the page, the clock at 1000, and the move to layer 2 started
/// on a held worker.
fn held_move() -> (Core, Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>, String) {
    use styk_core::focus::{FocusArea, FocusId, FocusTarget, ScopeId, TargetKind};
    let (spawner, gate) = Gated::new();
    let mut core = testing::core_with_document(SHEET, "Test.styk", spawner).unwrap();
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let before = records(&core);
    core.focus_mut().register(ScopeId::ROOT, vec![FocusTarget::new(7, FocusArea::Panels, TargetKind::Control)]);
    core.focus_mut().focus(FocusId(7));
    core.dispatch(Command::Wake { now: 1_000 });
    core.dispatch(Command::Inspector(Event::Choose(Choice::FigureLayer, Arc::from("layer-2"))));
    assert!(core.inspector().layer_move().is_some(), "the move waits on the worker");
    (core, gate, before)
}

#[test]
fn a_layer_move_longer_than_150_ms_opens_its_dialog_and_focus_returns_when_it_ends() {
    use styk_core::focus::FocusId;
    use styk_core::inspector::ids;
    let (mut core, gate, _) = held_move();
    core.dispatch(Command::Wake { now: 1_149 });
    assert!(core.inspector().layer_dialog().is_none(), "not before 150 ms");
    core.dispatch(Command::Wake { now: 1_150 });
    let (overlay, view) = core.inspector().layer_dialog().expect("the dialog opens on the overlay host");
    assert!(view.dialog);
    assert!(core.overlays().stack().entries().iter().any(|entry| entry.id == overlay));
    assert_eq!(core.focus().focused(), Some(ids::CANCEL), "Cancel takes focus");
    assert!(core.overlays().phase(ids::PROGRESS) < 1.0, "the bar's loop runs");
    release(&gate);
    finish_move(&mut core);
    assert!(core.inspector().layer_dialog().is_none() && core.overlays().stack().entries().is_empty(), "it closes when the move ends");
    assert_eq!(core.focus().focused(), Some(FocusId(7)), "focus returns where it was");
    assert_eq!(testing::undo_depth(&core), 1);
    assert_eq!(core.view_state().layers(), &["layer-2"]);
}

#[test]
fn cancel_through_the_dialog_leaves_the_document_as_it_was() {
    use styk_core::focus::FocusId;
    for escape in [false, true] {
        let (mut core, gate, before) = held_move();
        core.dispatch(Command::Wake { now: 1_150 });
        assert!(core.inspector().layer_dialog().is_some());
        if escape {
            // Escape closes the dialog on the host: today's dialog's `close` cancels the move.
            core.dispatch(Command::Overlay { event: styk_core::overlay::host::Event::Escape, now: 1_160 });
            core.refresh();
        } else {
            core.dispatch(Command::Inspector(Event::CancelLayerMove));
        }
        release(&gate);
        finish_move(&mut core);
        same(&records(&core), &before, &format!("a cancelled move changes nothing (escape: {escape})"));
        assert_eq!(testing::undo_depth(&core), 0);
        assert!(core.inspector().layer_dialog().is_none() && core.overlays().stack().entries().is_empty());
        assert_eq!(core.focus().focused(), Some(FocusId(7)));
    }
}

#[test]
fn a_layer_move_shorter_than_150_ms_never_shows_the_dialog() {
    let (mut core, gate, _) = held_move();
    release(&gate);
    finish_move(&mut core);
    assert_eq!(testing::undo_depth(&core), 1, "it landed");
    core.dispatch(Command::Wake { now: 1_150 });
    core.dispatch(Command::Wake { now: 2_000 });
    assert!(core.inspector().layer_dialog().is_none() && core.overlays().stack().entries().is_empty(), "no dialog after it ended");
    assert_eq!(core.inspector().deadline(), None);
}

#[test]
fn a_dialog_opened_during_a_layer_move_takes_over_and_cancels_it() {
    // Review finding 1: a held move starts at 1000 ms; another dialog opens at 1100; at 1150 the progress dialog must
    // not show over it, and the move ends with no edit (today's `changeFigureLayer` aborts).
    use styk_core::focus::{FocusArea, FocusId, FocusTarget, TargetKind};
    let (mut core, gate, before) = held_move();
    let newer = FocusId(77);
    core.dispatch(Command::Overlay { event: styk_core::overlay::host::Event::OpenOverlay { kind: styk_core::overlay::Kind::Dialog, guarded: false, targets: vec![FocusTarget::new(newer.0, FocusArea::Panels, TargetKind::Control)], initial: Some(newer) }, now: 1_100 });
    let newer_overlay = core.overlays().stack().entries().last().map(|entry| entry.id).expect("the newer dialog opened");
    core.dispatch(Command::Wake { now: 1_150 });
    assert!(core.inspector().layer_dialog().is_none(), "the progress dialog never shows over the newer dialog");
    assert_eq!(core.overlays().stack().entries().last().map(|entry| entry.id), Some(newer_overlay), "the newer dialog is still on top");
    assert_eq!(core.focus().focused(), Some(newer), "and keeps focus");
    release(&gate);
    finish_move(&mut core);
    same(&records(&core), &before, "the move was cancelled by its job: nothing changed");
    assert_eq!(testing::undo_depth(&core), 0, "no history entry");
    assert!(core.overlays().stack().entries().iter().any(|entry| entry.id == newer_overlay), "the newer dialog stays");
}

#[test]
fn unchanged_refreshes_walk_nothing() {
    // Review finding 3: whether the pose restyles its figure is the lane's fact; a refresh with nothing changed reads it.
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let (walks, builds) = (styk_core::inspector::facts::walks(), core.inspector().builds);
    for _ in 0..8 {
        core.refresh();
    }
    assert_eq!(styk_core::inspector::facts::walks(), walks, "no frame walk on an unchanged refresh");
    assert_eq!(core.inspector().builds, builds, "and no rebuild");
}

#[test]
fn a_palette_picker_opens_on_the_lanes_row_without_walking_the_document() {
    // Review finding 2: the swatch's row (its targets) is made on the facts lane; opening captures the ready row.
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[1,-1]").unwrap();
    let subject = core.inspector().shown().subject.clone().expect("the lane made the figure's facts");
    assert!(subject.palette.iter().any(|(color, _)| color == "#2b2b2b"), "its palette rows");
    let target = swatch_of(&core, "#2b2b2b");
    let walks = styk_core::inspector::facts::walks();
    let effects = core.dispatch(Command::Inspector(Event::Color(target)));
    assert!(effects.contains(&Effect::PickColor(target)));
    assert_eq!(styk_core::inspector::facts::walks(), walks, "opening walks nothing");
    // Before the lane's facts for a new state land, the swatches are pending and open nothing.
    testing::call_unsettled(&mut core, "seek", "[6]").unwrap();
    let model = core.inspector().model().unwrap().clone();
    let swatches: Vec<bool> = model.sections.iter().flat_map(|section| section.rows.iter()).filter_map(|row| match row {
        Row::Swatches { items, .. } => Some(items.iter().map(|item| item.disabled).collect::<Vec<_>>()),
        _ => None,
    }).flatten().collect();
    assert!(!swatches.is_empty() && swatches.iter().all(|disabled| *disabled), "pending swatches: {swatches:?}");
}

/// A frame source that holds the facts lane inside its first step until released, and says when it got there.
struct Held {
    publication: Arc<styk_core::screens::FixturePublication>,
    gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    entered: std::sync::Mutex<std::sync::mpsc::Sender<()>>,
}

impl styk_core::frames::FrameDocument for Held {
    fn snapshot(&self, revision: u64, epoch: u64) -> Option<Arc<styk_engine::Generation>> {
        let _ = self.entered.lock().unwrap().send(());
        let mut open = self.gate.0.lock().unwrap();
        while !*open {
            open = self.gate.1.wait(open).unwrap();
        }
        drop(open);
        self.publication.snapshot(revision, epoch)
    }
}

#[test]
fn a_replaced_facts_request_stops_and_its_results_are_retired_on_the_lane() {
    // Review finding 4: selecting B while A's facts are being made stops A (by its own cancellation) before it
    // evaluates or resolves anything; replaced facts are handed to the lane to be dropped there.
    use styk_core::frames::FrameDocument as _;
    let mut core = core_with(NATIVE);
    testing::call(&mut core, "select", "[2,-1]").unwrap();
    let id = core.documents.active().unwrap().id();
    let publication = Arc::new(styk_core::screens::FixturePublication::open(NATIVE, "Test.styk").unwrap());
    let publish = |core: &Core| {
        let document = core.documents.active().unwrap();
        publication.publish(document.records().unwrap().clone(), document.revision()).unwrap();
    };
    publish(&core);
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let (entered, reached) = std::sync::mpsc::channel();
    core.set_source(id, Arc::new(Held { publication: publication.clone(), gate: gate.clone(), entered: std::sync::Mutex::new(entered) }));
    assert!(publication.snapshot(core.documents.active().unwrap().revision(), 0).is_some(), "the held source is published");
    let cancelled = core.facts().unwrap().cancelled;
    // A: figure 1. The lane takes its request and is held in its first step.
    let documents_id = id;
    core.documents.call(documents_id, "select", &[Value::Num(1.0), Value::Num(-1.0)], &Value::Null).unwrap();
    publish(&core);
    core.refresh();
    reached.recv_timeout(Duration::from_secs(30)).expect("the lane is making A's facts");
    // B: figure 3, while A is being made: A is superseded.
    core.documents.call(documents_id, "select", &[Value::Num(3.0), Value::Num(-1.0)], &Value::Null).unwrap();
    publish(&core);
    core.refresh();
    release(&gate);
    for _ in 0..15_000 {
        core.refresh();
        if !core.facts().unwrap().in_flight() && core.inspector().shown().subject.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(core.facts().unwrap().cancelled, cancelled + 1, "A stopped at its next step");
    assert_eq!(core.inspector().shown().subject.as_ref().map(|subject| subject.uid), Some(3), "B's facts are shown");
    core.refresh();
    assert_eq!(core.facts().unwrap().retiring(), 0, "replaced facts went to the lane to be dropped");
    drop(core);
}
