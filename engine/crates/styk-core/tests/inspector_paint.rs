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

/// What a case selects before its edit, as `tests/native-inspector-save-reference.test.mjs` does.
fn prepare(core: &mut Core, case: &str) {
    match case {
        "figure-color" | "figure-opacity" | "figure-range" | "palette" | "polygon" | "layer" => testing::call(core, "select", "[1,-1]").unwrap(),
        "segment-paint" => testing::call(core, "select", "[1,0]").unwrap(),
        _ => {}
    }
}

/// The case's edit on the native panel: the same edit as the oracle's, through the panel's events.
fn apply(core: &mut Core, case: &str, side: &Value) {
    let solid = |rgb, opacity| PaintSpec::solid(rgb, opacity);
    if matches!(case, "figure-range" | "background-range") {
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
        "palette" => {
            let from = side.get("from").and_then(Value::as_str).unwrap().to_owned();
            let model = core.inspector().model().unwrap().clone();
            let swatch = model.sections.iter().flat_map(|section| section.rows.iter()).find_map(|row| match row {
                Row::Swatches { items, .. } => items.iter().find(|item| format!("#{:02x}{:02x}{:02x}", item.rgb[0], item.rgb[1], item.rgb[2]) == from).cloned(),
                _ => None,
            });
            let id = open(core, swatch.expect("the swatch of today's first palette colour").target);
            commit(core, id, solid([0, 128, 0], 1.0));
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
            inspector(core, Event::Choose(Choice::FigureLayer, Arc::from("layer-2")));
        }
        other => panic!("unknown case {other}"),
    }
    if let Some(error) = core.inspector().picker().and_then(|picker| picker.error.clone()) {
        panic!("{case}: refused: {}", english(&error));
    }
}

const CASES: [(&str, &[u8]); 10] = [
    ("figure-color", NATIVE),
    ("figure-opacity", NATIVE),
    ("figure-range", NATIVE),
    ("palette", NATIVE),
    ("polygon", NATIVE),
    ("background-solid", NATIVE),
    ("background-range", NATIVE),
    ("background-gradient", NATIVE),
    ("segment-paint", NATIVE),
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
        assert_eq!(testing::undo_depth(&core), depth + 1, "{case}: one history entry");
        let edited = records(&core);
        assert_ne!(edited, before, "{case}: the edit changed the document");
        core.dispatch(Command::Run(CommandId::Undo));
        testing::settle_facts(&mut core).unwrap();
        same(&records(&core), &before, &format!("{case}: undo restores the document exactly"));
        core.dispatch(Command::Run(CommandId::Redo));
        testing::settle_facts(&mut core).unwrap();
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
    inspector(&mut core, Event::Choose(Choice::FigureLayer, Arc::from("layer-2")));
    assert_eq!(testing::undo_depth(&core), 1, "one history entry");
    assert_eq!(core.view_state().layers(), &["layer-2"]);
    let records = core.documents.active().unwrap().records().unwrap().clone();
    assert_eq!(records.path(&["_styk", "layers", "activeId"]).and_then(Value::as_str), Some("layer-2"));
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
    assert_eq!(count, 40);
    println!("INSPECTOR_SAVE_BYTES: 40 exact comparisons passed");
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
