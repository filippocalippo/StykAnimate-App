//! The documents the screen catalogue's Properties panel screens show (`stykanimate --screen inspector-<context>`):
//! repository fixtures, opened and selected as `engine/crates/styk-app/automation/inspector-reference/contexts.mjs`
//! opens today's app for the references. Keep the two lists equal.
//!
//! A screen's core is prepared before its first frame: the fixture is opened on the calling thread (a catalogue screen
//! has no window to keep responsive yet, as the band's preview has none), its generation published for the facts lane,
//! and the lane started through the host's spawner. The caller refreshes until [`Core::refresh`] has the facts.

#[cfg(feature = "engine")]
use std::collections::HashMap;
#[cfg(feature = "engine")]
use std::sync::{Arc, Mutex};

#[cfg(feature = "engine")]
use styk_services::Spawner;

#[cfg(feature = "engine")]
use crate::app::Core;
#[cfg(feature = "engine")]
use crate::documents::{Documents, HostOptions, PreparedDocument};
#[cfg(feature = "engine")]
use crate::engine::{Budgets, Engine, Value};
#[cfg(feature = "engine")]
use crate::facts::Facts;
#[cfg(feature = "engine")]
use crate::frames::FrameDocument;
#[cfg(feature = "engine")]
use crate::view_state::{InspectorContext, InspectorTab};

#[cfg(feature = "engine")]
const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
#[cfg(feature = "engine")]
const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");
#[cfg(feature = "engine")]
const SPRITE: &[u8] = include_bytes!("../../../tests/edit/sprite-segment-sparse-native.document.json");

/// A context of the Properties panel the catalogue shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InspectorScreen {
    Scene,
    Figure,
    Joint,
    Figures,
    Text,
    Image,
    Camera,
    Layer,
    Frame,
}

impl InspectorScreen {
    pub const ALL: [InspectorScreen; 9] = [
        InspectorScreen::Scene,
        InspectorScreen::Figure,
        InspectorScreen::Joint,
        InspectorScreen::Figures,
        InspectorScreen::Text,
        InspectorScreen::Image,
        InspectorScreen::Camera,
        InspectorScreen::Layer,
        InspectorScreen::Frame,
    ];

    /// The context's name in the screen IDs (`inspector-<name>`, `inspector-<name>-dark`).
    pub const fn name(self) -> &'static str {
        match self {
            InspectorScreen::Scene => "scene",
            InspectorScreen::Figure => "figure",
            InspectorScreen::Joint => "joint",
            InspectorScreen::Figures => "figures",
            InspectorScreen::Text => "text",
            InspectorScreen::Image => "image",
            InspectorScreen::Camera => "camera",
            InspectorScreen::Layer => "layer",
            InspectorScreen::Frame => "frame",
        }
    }
}

/// A document's published generations by revision, from an engine that opened the same file: what K-doc's
/// publication supplies to the workers, for fixtures (the screens, the tests).
#[cfg(feature = "engine")]
pub struct FixturePublication {
    engine: Engine,
    lineage: u64,
    generations: Mutex<HashMap<u64, Arc<styk_engine::Generation>>>,
}

#[cfg(feature = "engine")]
impl FrameDocument for FixturePublication {
    fn snapshot(&self, revision: u64, _: u64) -> Option<Arc<styk_engine::Generation>> {
        self.generations.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&revision).cloned()
    }
}

#[cfg(feature = "engine")]
impl FixturePublication {
    /// Opens `bytes` (named `name`) the way documents are prepared.
    pub fn open(bytes: &[u8], name: &str) -> Result<FixturePublication, String> {
        let engine = Engine::new(|| 0.0, Budgets::for_device(None));
        let opened = engine
            .open_document(styk_engine::document::OpenSource::File { bytes, name }, styk_engine::document::OpenOptions { layer_timeline: true }, &|| false)
            .map_err(|error| error.message)?;
        engine.activate(&opened.typed, &opened.tree, 0).map_err(|error| error.message)?;
        Ok(FixturePublication { lineage: opened.lineage(), engine, generations: Mutex::new(HashMap::new()) })
    }

    /// Publishes `tree` as the generation of `revision`.
    pub fn publish(&self, tree: Value, revision: u64) -> Result<(), String> {
        self.engine.publish_tree(self.lineage, tree, revision).map_err(|error| error.message)?.ok_or("the publication holds another document")?;
        let generation = self.engine.generation().ok_or("nothing was published")?;
        self.generations.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(revision, generation);
        Ok(())
    }
}

/// A core with `bytes` open in one tab, the documents services attached, a facts lane started through `spawner`
/// (`wake` is called when facts land), and the document's first revision published. Returns the publication, which
/// publishes later revisions.
#[cfg(feature = "engine")]
pub fn core_with_document(bytes: &[u8], name: &str, spawner: Arc<dyn Spawner>, wake: crate::frames::Wake) -> Result<(Core, Arc<FixturePublication>), String> {
    let opener = Engine::new(|| 0.0, Budgets::for_device(None));
    let prepared = PreparedDocument::open_bytes(&opener, Arc::from(bytes), name, &|| false).map_err(|error| error.message)?;
    let mut documents = Documents::new();
    let id = documents.open(prepared).map_err(|(error, _)| error.to_string())?;
    let startup = styk_doc::json::parse(STARTUP).map_err(|error| error.to_string())?;
    documents
        .attach_host(HostOptions { engine: opener, spawner: spawner.clone(), files: Arc::new(styk_services::files::fake::MemoryFiles::default()), startup, clock: || 0.0, notify: Arc::new(|| {}) })
        .map_err(|error| format!("{error:?}"))?;
    let mut core = Core::new(documents);
    core.set_facts(Facts::start(spawner.as_ref(), wake).map_err(|error| error.0)?);
    let publication = Arc::new(FixturePublication::open(bytes, name)?);
    core.set_source(id, publication.clone());
    let document = core.documents.active().ok_or("no document is open")?;
    publication.publish(document.records().map_err(|error| error.to_string())?.clone(), document.revision())?;
    core.refresh();
    Ok((core, publication))
}

/// The core a Properties panel screen shows.
#[cfg(feature = "engine")]
pub fn inspector(screen: InspectorScreen, spawner: Arc<dyn Spawner>, wake: crate::frames::Wake) -> Result<Core, String> {
    let text;
    let (bytes, select): (&[u8], &str) = match screen {
        InspectorScreen::Scene => (STARTUP, "[null,-1]"),
        InspectorScreen::Figure | InspectorScreen::Camera | InspectorScreen::Layer | InspectorScreen::Frame => (STARTUP, "[1,-1]"),
        InspectorScreen::Joint => (STARTUP, "[1,1]"),
        InspectorScreen::Figures => (SHEET, ""),
        InspectorScreen::Text => {
            // The startup document with every segment a text segment (primitive 5).
            let mut document = styk_doc::json::parse(STARTUP).map_err(|error| error.to_string())?;
            for figure in document.make_obj().and_then(|document| document.get_mut("figure_types")).and_then(Value::make_arr).into_iter().flatten() {
                for segment in figure.make_obj().and_then(|figure| figure.get_mut("segments")).and_then(Value::make_arr).into_iter().flatten() {
                    if let Some(segment) = segment.make_obj() {
                        segment.set("primitive_code", Value::Num(5.0));
                    }
                }
            }
            text = styk_doc::json::to_string(&document).into_bytes();
            (text.as_slice(), "[1,-1]")
        }
        InspectorScreen::Image => (SPRITE, "[3,-1]"),
    };
    let (mut core, _) = core_with_document(bytes, "Reference.styk", spawner, wake)?;
    let id = core.documents.active().ok_or("no document is open")?.id();
    let (method, args) = if screen == InspectorScreen::Figures { ("selectMany", "[[1,2,3]]") } else { ("select", select) };
    let args: Vec<Value> = styk_doc::json::parse(args.as_bytes()).map_err(|error| error.to_string())?.elements().map(|items| items.iter().collect()).unwrap_or_default();
    core.documents.call(id, method, &args, &Value::Null).map_err(|error| error.to_string())?.result.map_err(|error| error.to_string())?;
    match screen {
        InspectorScreen::Camera => core.view_state_mut().set_context(InspectorContext::Camera),
        InspectorScreen::Layer => core.view_state_mut().set_context(InspectorContext::Layer),
        InspectorScreen::Frame => core.view_state_mut().set_tab(InspectorTab::Animation),
        _ => {}
    }
    core.refresh();
    Ok(core)
}
