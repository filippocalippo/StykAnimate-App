use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use styk_core::documents::*;
use styk_core::engine::Value;
use styk_doc::json;
use styk_engine::{Engine, Budgets};
use styk_services::{Job, SpawnError, Spawner};
use styk_services::files::FileTarget;
use styk_services::files::fake::{Failure, MemoryFiles};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
struct Threads;
impl Spawner for Threads {
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
        std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|error| SpawnError(error.to_string()))
    }
}
struct Rig { docs: Documents, files: Arc<MemoryFiles>, wake: mpsc::Receiver<()> }
impl Rig {
    fn new() -> Self {
        let files = Arc::new(MemoryFiles::default());
        let (send, wake) = mpsc::channel();
        let mut docs = Documents::new();
        docs.attach_host(HostOptions {
            engine: Engine::new(|| 0.0, Budgets::for_device(None)), spawner: Arc::new(Threads), files: files.clone(),
            startup: json::parse(STARTUP).unwrap(), clock: || 0.0, notify: Arc::new(move || { let _ = send.send(()); }),
        }).unwrap();
        Self { docs, files, wake }
    }
    fn dispatch(&mut self, mut request: Request) -> Effect {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop { match self.docs.dispatch(request) {
            Ok(effect) => return effect,
            Err((HostError::Documents(DocumentsError::Busy), returned)) => {
                assert!(Instant::now() < deadline, "exchange must become ready");
                request = returned; std::thread::yield_now();
            }
            Err((error, _)) => panic!("dispatch: {error}"),
        } }
    }
    fn next(&mut self) -> Effect {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(effect) = self.docs.poll() { return effect; }
            assert!(Instant::now() < deadline, "job must terminate");
            let _ = self.wake.recv_timeout(Duration::from_millis(5));
        }
    }
    fn open(&mut self, name: &str) -> DocumentId {
        assert!(matches!(self.dispatch(Request::OpenBytes { bytes: Arc::from(STARTUP), name: name.into() }), Effect::Started(_)));
        let Effect::Opened(id) = self.next() else { panic!("open must complete") };
        id
    }
    fn fps(&mut self, id: DocumentId, fps: f64) { self.docs.call(id, "setFPS", &[Value::Num(fps)], &Value::Null).unwrap().result.unwrap(); }
    fn call(&mut self, id: DocumentId, method: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop { match self.docs.call(id, method, &[], &Value::Null) {
            Ok(answer) => { answer.result.unwrap(); return; }
            Err(DocumentsError::Busy) => { assert!(Instant::now() < deadline); std::thread::yield_now(); }
            Err(error) => panic!("call: {error}"),
        } }
    }
    fn save(&mut self, id: DocumentId, target: &FileTarget) -> Effect {
        let mut effect = self.dispatch(Request::Save { document: id, save_as: true });
        while matches!(effect, Effect::Started(_) | Effect::ScopeChanged(_) | Effect::None) { effect = self.next(); }
        let Effect::SaveDialog { prompt, .. } = effect else { panic!("choose target: {effect:?}") };
        assert!(matches!(self.dispatch(Request::SaveTarget { prompt, target: Some(target.clone()) }), Effect::Started(_)));
        self.next()
    }
}

#[test]
fn asynchronous_save_keeps_history_and_marks_only_the_snapshot_that_committed() {
    let mut rig = Rig::new(); let id = rig.open("Project.styk"); rig.fps(id, 30.0);
    let target = FileTarget::new("project.styk");
    assert!(matches!(rig.save(id, &target), Effect::Saved { current: true, .. }));
    assert!(!rig.docs.get(id).unwrap().dirty());
    let saved = rig.files.get(&target).unwrap();
    let check = Engine::new(|| 0.0, Budgets::for_device(None));
    let reopened = PreparedDocument::open_bytes(&check, saved.clone(), "project.styk", &|| false).unwrap();
    let mut other = Documents::new(); let reopened = other.open(reopened).map_err(|(error, _)| error).unwrap();
    assert_eq!(other.get(reopened).unwrap().with_document(|doc| doc.fps).unwrap(), 30.0);
    rig.docs.undo(id).unwrap().result.unwrap(); assert!(rig.docs.get(id).unwrap().dirty());
    rig.docs.redo(id).unwrap().result.unwrap(); assert!(!rig.docs.get(id).unwrap().dirty());
    assert!(matches!(rig.dispatch(Request::Save { document: id, save_as: false }), Effect::Started(_)));
    rig.fps(id, 60.0);
    assert!(matches!(rig.next(), Effect::Saved { current: false, .. }));
    assert_eq!(&*rig.files.get(&target).unwrap(), &*saved);
    assert!(rig.docs.get(id).unwrap().dirty());
}

#[test]
fn failed_and_cancelled_atomic_writes_preserve_old_bytes_target_and_unsaved_work() {
    for failure in [Failure::ReadOnly, Failure::Full, Failure::CancelBeforeCommit] {
        let mut rig = Rig::new(); let id = rig.open("Project.styk"); rig.fps(id, 30.0);
        let target = FileTarget::new("old.styk"); let old: Arc<[u8]> = Arc::from(&b"old bytes"[..]);
        rig.files.put(target.clone(), old.clone()); rig.files.fail(failure);
        assert!(matches!(rig.save(id, &target), Effect::Failed { .. } | Effect::Cancelled(_)));
        assert_eq!(&*rig.files.get(&target).unwrap(), &*old);
        assert!(rig.docs.get(id).unwrap().dirty()); assert!(rig.docs.get(id).unwrap().target().is_none());
        assert_eq!(rig.docs.get(id).unwrap().with_document(|doc| doc.fps).unwrap(), 30.0);
    }
}

#[test]
fn close_prompts_cancel_save_and_discard_with_recency_and_last_tab_replacement() {
    let mut rig = Rig::new(); let a = rig.open("A.styk"); let b = rig.open("B.styk");
    rig.docs.activate(a).unwrap(); rig.fps(a, 30.0);
    let Effect::ConfirmClose { prompt, document, .. } = rig.dispatch(Request::Close(a)) else { panic!("dirty prompt") };
    assert_eq!(document, a);
    assert!(matches!(rig.dispatch(Request::Respond { prompt, choice: CloseChoice::Cancel }), Effect::None));
    assert_eq!(rig.docs.tabs().len(), 2);
    let Effect::ConfirmClose { prompt, .. } = rig.dispatch(Request::Close(a)) else { panic!("dirty prompt") };
    let Effect::SaveDialog { prompt, .. } = rig.dispatch(Request::Respond { prompt, choice: CloseChoice::Save }) else { panic!("target prompt") };
    rig.dispatch(Request::SaveTarget { prompt, target: Some(FileTarget::new("a.styk")) });
    assert!(matches!(rig.next(), Effect::Closed(closed) if closed == a));
    assert_eq!(rig.docs.active().unwrap().id(), b);
    // Retirements are drained before accepting another request.
    assert!(matches!(rig.dispatch(Request::Close(b)), Effect::Started(_)));
    assert!(matches!(rig.next(), Effect::Closed(closed) if closed == b));
    assert_eq!(rig.docs.tabs().len(), 1); assert!(rig.docs.replaceable());
    assert_eq!(rig.docs.active().unwrap().id(), b);
}

#[test]
fn stale_publications_are_not_reported_as_the_current_stage() {
    let mut rig = Rig::new(); let id = rig.open("A.styk");
    assert!(matches!(rig.dispatch(Request::Publish), Effect::Started(_)));
    rig.fps(id, 30.0);
    assert!(matches!(rig.next(), Effect::Stale(_)));
    assert!(matches!(rig.next(), Effect::Started(_)));
    assert!(matches!(rig.next(), Effect::Published { document, revision, .. } if document == id && revision == rig.docs.get(id).unwrap().revision()));
}

#[test]
fn quit_save_all_preserves_tab_order_and_stops_on_a_cancelled_picker() {
    let mut rig = Rig::new(); let a = rig.open("A.styk"); rig.fps(a, 30.0); let b = rig.open("B.styk"); rig.fps(b, 60.0);
    assert!(rig.docs.reorder(b, 0)); assert_eq!(rig.docs.successor(b), Some(a));
    let Effect::ConfirmQuit { prompt, names } = rig.dispatch(Request::Quit) else { panic!("quit prompt") };
    assert_eq!(names.len(), 2);
    let Effect::SaveDialog { prompt, document, .. } = rig.dispatch(Request::Respond { prompt, choice: CloseChoice::Save }) else { panic!("save first") };
    assert_eq!(document, a);
    assert!(matches!(rig.dispatch(Request::SaveTarget { prompt, target: None }), Effect::None));
    assert_eq!(rig.docs.tabs().len(), 2); assert!(rig.docs.tabs().iter().all(|tab| tab.dirty()));
    let Effect::ConfirmQuit { prompt, .. } = rig.dispatch(Request::Quit) else { panic!("quit prompt") };
    assert!(matches!(rig.dispatch(Request::Respond { prompt, choice: CloseChoice::Discard }), Effect::QuitReady));
}

fn fixture(relative: &str) -> Arc<[u8]> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)).unwrap().into()
}

#[test]
fn every_native_and_pivot_format_opens_and_figure_files_import_with_undo() {
    for (path, name) in [
        ("../../tests/containers/project-version-1.styk", "old.styk"),
        ("../../tests/containers/project-images.styk", "images.styk"),
        ("../../tests/edit/startup.document.json", "plain.json"),
        ("../styk-piv/tests/fixtures/modern-type-change.piv", "pivot.piv"),
    ] {
        let mut rig = Rig::new();
        rig.dispatch(Request::OpenBytes { bytes: fixture(path), name: name.into() });
        let effect = rig.next(); assert!(matches!(effect, Effect::Opened(_)), "{name}: {effect:?}");
        assert!(rig.docs.active().unwrap().frame_records().is_ok());
    }
    for (path, name) in [
        ("../styk-piv/tests/fixtures/figure-modern.stk", "figure.stk"),
        ("../../tests/containers/figure.stkz", "figure.stkz"),
        ("../../tests/containers/movieclip-motion.stykmov", "movieclip.stykmov"),
    ] {
        let mut rig = Rig::new(); let id = rig.open("Base.styk");
        let before = json::to_string(rig.docs.get(id).unwrap().records());
        rig.dispatch(Request::OpenBytes { bytes: fixture(path), name: name.into() });
        let effect = rig.next(); assert!(matches!(effect, Effect::Imported(found) if found == id), "{name}: {effect:?}");
        assert_eq!(rig.docs.tabs().len(), 1);
        let after = json::to_string(rig.docs.get(id).unwrap().records()); assert_ne!(before, after);
        rig.docs.undo(id).unwrap().result.unwrap(); assert_eq!(json::to_string(rig.docs.get(id).unwrap().records()), before);
        rig.docs.redo(id).unwrap().result.unwrap(); assert_eq!(json::to_string(rig.docs.get(id).unwrap().records()), after);
    }
}

fn movieclip(rig: &mut Rig) -> (DocumentId, f64) {
    let id = rig.open("Clips.styk");
    rig.dispatch(Request::OpenBytes { bytes: fixture("../../tests/containers/movieclip-motion.stykmov"), name: "Clip.stykmov".into() });
    assert!(matches!(rig.next(), Effect::Imported(_)));
    let type_id = rig.docs.get(id).unwrap().records().get("figure_types").unwrap().elements().unwrap().iter()
        .find(|figure| figure.path(&["_styk", "movieclip"]).is_some()).unwrap().get("figure_type_id").unwrap().as_f64().unwrap();
    (id, type_id)
}
fn clip_fps(rig: &Rig, id: DocumentId, type_id: f64) -> f64 {
    rig.docs.get(id).unwrap().records().get("figure_types").unwrap().elements().unwrap().iter()
        .find(|figure| figure.get("figure_type_id").and_then(Value::as_f64) == Some(type_id)).unwrap()
        .path(&["_styk", "movieclip", "document", "fps"]).unwrap().as_f64().unwrap()
}

#[test]
fn scopes_preserve_the_parent_and_publish_one_undo_entry_or_discard_the_child() {
    let mut rig = Rig::new(); let (id, type_id) = movieclip(&mut rig);
    let before = json::to_string(rig.docs.get(id).unwrap().records());
    // A completion's old import owner may still be waiting for reclamation.
    rig.dispatch(Request::EnterMovieclip { document: id, type_id });
    assert!(matches!(rig.next(), Effect::ScopeChanged(_))); rig.fps(id, 17.0);
    rig.dispatch(Request::LeaveMovieclip { document: id, save: true });
    assert!(matches!(rig.next(), Effect::ScopeChanged(_)));
    assert_eq!(clip_fps(&rig, id, type_id), 17.0);
    rig.docs.undo(id).unwrap().result.unwrap(); assert_eq!(json::to_string(rig.docs.get(id).unwrap().records()), before);
    rig.docs.redo(id).unwrap().result.unwrap(); assert_eq!(clip_fps(&rig, id, type_id), 17.0);
}

#[test]
fn saved_movieclip_is_not_lost_when_leaving_and_undo_tracks_the_saved_root() {
    let mut rig = Rig::new(); let (id, type_id) = movieclip(&mut rig);
    rig.dispatch(Request::EnterMovieclip { document: id, type_id });
    assert!(matches!(rig.next(), Effect::ScopeChanged(_))); rig.fps(id, 17.0);
    assert!(matches!(rig.save(id, &FileTarget::new("scoped.styk")), Effect::Saved { current: true, .. }));
    assert!(!rig.docs.get(id).unwrap().dirty(), "the save contains the child and all its parents");
    assert_eq!(rig.docs.get(id).unwrap().scope_depth(), 0, "Save leaves the scopes, as performNativeSave does");
    assert_eq!(clip_fps(&rig, id, type_id), 17.0, "leaving cannot restore the old clip over a saved edit");
    assert!(!rig.docs.get(id).unwrap().dirty());
    rig.docs.undo(id).unwrap().result.unwrap(); assert!(rig.docs.get(id).unwrap().dirty());
    rig.docs.redo(id).unwrap().result.unwrap(); assert!(!rig.docs.get(id).unwrap().dirty());
}

#[test]
fn copied_figures_survive_switching_and_closing_the_source_tab() {
    let mut rig = Rig::new(); let source = rig.open("Source.styk");
    rig.call(source, "copySelection");
    let destination = rig.open("Destination.styk");
    let before = json::to_string(rig.docs.get(destination).unwrap().records());
    rig.call(destination, "pasteSelection");
    assert_ne!(json::to_string(rig.docs.get(destination).unwrap().records()), before);
    rig.docs.undo(destination).unwrap().result.unwrap(); assert_eq!(json::to_string(rig.docs.get(destination).unwrap().records()), before);
    assert!(matches!(rig.dispatch(Request::Close(source)), Effect::Closed(_)));
    rig.call(destination, "pasteSelection");
    assert_ne!(json::to_string(rig.docs.get(destination).unwrap().records()), before);
}

#[test]
fn blank_replacement_names_save_all_and_close_saved_follow_tab_order() {
    let mut rig = Rig::new();
    rig.dispatch(Request::New);
    let Effect::Opened(blank) = rig.next() else { panic!("new") };
    let first = rig.open("First.styk"); assert_eq!(first, blank);
    let second = rig.open("Second.styk");
    rig.fps(second, 30.0);
    assert!(matches!(rig.dispatch(Request::CloseSaved), Effect::ClosedSaved(ids) if ids == vec![first]));
    let third = rig.open("Third.styk"); rig.fps(third, 40.0);
    assert!(matches!(rig.dispatch(Request::Rename { document: third, name: "  Renamed  ".into() }), Effect::Renamed(found) if found == third));
    assert_eq!(rig.docs.get(third).unwrap().name(), "Renamed");
    let order: Vec<_> = rig.docs.tabs().iter().map(|tab| tab.id()).collect();
    let Effect::SaveDialog { prompt, document, .. } = rig.dispatch(Request::SaveAll) else { panic!("save all") };
    assert_eq!(document, second); assert!(rig.docs.saving(second));
    rig.dispatch(Request::SaveTarget { prompt, target: Some(FileTarget::new("second.styk")) });
    let Effect::SaveDialog { prompt, document, .. } = rig.next() else { panic!("save second") };
    assert_eq!(document, third);
    rig.dispatch(Request::SaveTarget { prompt, target: Some(FileTarget::new("third.styk")) });
    assert!(matches!(rig.next(), Effect::SavedAll));
    assert_eq!(rig.docs.active().unwrap().id(), third);
    assert_eq!(rig.docs.tabs().iter().map(|tab| tab.id()).collect::<Vec<_>>(), order);
    assert!(rig.docs.tabs().iter().all(|tab| !tab.dirty() && tab.saved_at() == Some(0.0)));
    assert!(matches!(rig.dispatch(Request::Quit), Effect::QuitReady));
}

#[test]
fn decoded_stick_nodes_imports_use_the_same_owner_and_save_path() {
    let mut rig = Rig::new();
    let document = json::parse(&fixture("../../tests/edit/sticknodes.document.json")).unwrap();
    rig.dispatch(Request::OpenDocument { document, name: "Decoded.stknds".into() });
    let Effect::Opened(id) = rig.next() else { panic!("decoded import") };
    assert_eq!(rig.docs.get(id).unwrap().name(), "Decoded");
    rig.fps(id, 30.0);
    assert!(matches!(rig.save(id, &FileTarget::new("decoded.styk")), Effect::Saved { current: true, .. }));
}

#[test]
fn an_edit_during_open_rejects_the_result_without_replacing_the_active_project() {
    let mut rig = Rig::new(); let id = rig.open("Current.styk");
    rig.dispatch(Request::OpenBytes { bytes: Arc::from(STARTUP), name: "Incoming.styk".into() });
    rig.fps(id, 31.0);
    assert!(matches!(rig.next(), Effect::Stale(_)));
    assert_eq!(rig.docs.tabs().len(), 1);
    assert_eq!(rig.docs.active().unwrap().id(), id);
    assert_eq!(rig.docs.active().unwrap().with_document(|document| document.fps).unwrap(), 31.0);
    assert!(rig.docs.active().unwrap().dirty());
}

#[test]
#[ignore = "requires the explicit old-versus-old oracle generated by native-documents-save-reference.test.mjs"]
fn native_saved_bytes_equal_todays_after_edit_undo_and_redo() {
    let directory = std::env::var_os("STYK_NATIVE_SAVE_ORACLE").expect("set the oracle directory");
    for (case, source, name) in [
        ("startup", "../../tests/edit/startup.document.json", "Parity.styk"),
        ("channels", "../../tests/containers/project-channels.styk", "Parity.styk"),
        ("drawing", "../../tests/containers/project-drawing.styk", "Parity.styk"),
        ("pivot", "../styk-piv/tests/fixtures/modern-type-change.piv", "Parity.piv"),
        ("movieclip", "../../tests/edit/sheet-movieclip.document.json", "Parity.styk"),
        ("stick", "../styk-piv/tests/fixtures/figure-modern.stk", "figure.stk"),
        ("figure", "../../tests/containers/figure.stkz", "figure.stkz"),
        ("clip-import", "../../tests/containers/movieclip-motion.stykmov", "clip.stykmov"),
    ] {
        let mut rig = Rig::new();
        let imported = matches!(case, "stick" | "figure" | "clip-import");
        if imported { rig.open("Parity.styk"); }
        rig.dispatch(Request::OpenBytes { bytes: fixture(source), name: name.into() });
        let id = match rig.next() { Effect::Opened(id) if !imported => id, Effect::Imported(id) if imported => id, effect => panic!("open {case}: {effect:?}") };
        for phase in 0..4 {
            match phase {
                1 => {
                    if case == "movieclip" {
                        let type_id = rig.docs.get(id).unwrap().records().get("figure_types").unwrap().elements().unwrap().iter()
                            .find(|figure| figure.path(&["_styk", "movieclip", "document"]).is_some()).unwrap().get("figure_type_id").unwrap().as_f64().unwrap();
                        rig.dispatch(Request::EnterMovieclip { document: id, type_id });
                        assert!(matches!(rig.next(), Effect::ScopeChanged(_)));
                    }
                    rig.fps(id, 30.0);
                },
                2 => { rig.docs.undo(id).unwrap().result.unwrap(); },
                3 => { rig.docs.redo(id).unwrap().result.unwrap(); }, _ => {}
            }
            let target = FileTarget::new("Parity.styk");
            assert!(matches!(rig.save(id, &target), Effect::Saved { current: true, .. }));
            let expected = std::fs::read(std::path::Path::new(&directory).join(format!("{case}-{phase}.styk"))).expect("oracle must exist; never silently skip");
            assert_eq!(&*rig.files.get(&target).unwrap(), expected, "{case}/{phase}: every saved byte");
            let engine = Engine::new(|| 0.0, Budgets::for_device(None));
            let prepared = PreparedDocument::open_bytes(&engine, rig.files.get(&target).unwrap(), "Parity.styk", &|| false).unwrap();
            let mut reopened = Documents::new();
            let reopened_id = reopened.open(prepared).map_err(|(error, _)| error).unwrap();
            let tab = reopened.get(reopened_id).unwrap();
            assert!(tab.frame_records().is_ok(), "{case}/{phase}: reopened frame");
            assert_eq!(tab.with_document(|doc| doc.fps).unwrap(), rig.docs.get(id).unwrap().with_document(|doc| doc.fps).unwrap());
        }
    }
}
