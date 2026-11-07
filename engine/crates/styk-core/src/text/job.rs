//! The text tool's worker: the state of `text-authoring-worker.mjs` and the way a native front end drives it.
//!
//! A draft change becomes a [`CompileRequest`] tagged with a revision. One compile runs at a time on the job's thread;
//! a newer request replaces one still waiting and cancels the one running at its next checkpoint, so the latest draft
//! always wins and a result that arrives for an older revision is the caller's to drop. Nothing here blocks the
//! caller: the only lock is held for a few instructions, never across a compile, a parse or a wait.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use styk_services::{Spawner, SpawnError};

use styk_doc::Value;

use super::compile::compile_text_figure_checked;
use super::embedded::{compile_embedded_text_figure, read_text_figure_options, replace_text_asset_figure};
use super::font::{Font, MAX_FONT_BYTES};
use super::options::{TextOptions, TextSettings};
use super::TextError;

/// A face a session keeps at most this many of; loading another is refused rather than evicting one a dialog may use.
pub const MAX_FACES: usize = 8;
/// Font bytes a session keeps in total.
pub const MAX_RETAINED_FONT_BYTES: usize = 64 * 1024 * 1024;
/// Commands waiting, running and answered-but-not-taken beyond which a caller is told the job is busy.
const MAX_COMMANDS: usize = 16;
/// Bytes of font data and figures those commands and their answers may hold together.
pub const MAX_QUEUED_BYTES: usize = 96 * 1024 * 1024;

/// A flag a running compile polls between glyphs and lines.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> CancelToken {
        CancelToken::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Which outlines a draft is compiled with.
#[derive(Debug, Clone, PartialEq)]
pub enum FontSource {
    /// The four bundled Noto Sans styles, chosen by the draft's bold and italic.
    Bundled,
    /// The outlines already in the source figure (imported text).
    Embedded,
    /// A face loaded into the session (`font-1`, ...).
    Loaded(String),
}

/// What the worker answers to `type: "font"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontInfo {
    pub id: String,
    pub family: String,
    pub style: String,
    pub bold: bool,
    pub italic: bool,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct CompileRequest {
    pub revision: u64,
    pub font: FontSource,
    /// The draft as the dialog holds it: a plain object (`text`, `fontSize`, ..., `assetIndex`).
    pub options: Value,
}

/// The result for one revision.
#[derive(Debug, Clone, PartialEq)]
pub struct CompileOutcome {
    pub revision: u64,
    pub result: Result<Value, TextError>,
}

struct Loaded {
    font: Arc<Font>,
    info: FontInfo,
}

/// Where the bundled fonts' bytes come from (the app embeds them).
pub type BundledFonts = Arc<dyn Fn(usize) -> Option<Arc<[u8]>> + Send + Sync>;

/// The worker's state, usable directly (tests, tools) and by [`TextJob`] on its thread.
pub struct TextCompiler {
    source: Option<Value>,
    fonts: HashMap<String, Loaded>,
    next_font: u32,
    retained: usize,
    bundled: BundledFonts,
    bundled_parsed: [Option<Arc<Font>>; 4],
}

impl TextCompiler {
    pub fn new(bundled: BundledFonts) -> TextCompiler {
        TextCompiler { source: None, fonts: HashMap::new(), next_font: 1, retained: 0, bundled, bundled_parsed: [None, None, None, None] }
    }

    /// `type: "source"`: the figure being edited (or none); answers the options that reproduce it.
    pub fn set_source(&mut self, figure: Option<Value>) -> Result<Option<Value>, TextError> {
        let options = match &figure {
            Some(figure) => Some(read_text_figure_options(figure, None)?),
            None => None,
        };
        self.source = figure;
        Ok(options)
    }

    /// `type: "font"`: parses a user font and keeps it for the session.
    pub fn load_font(&mut self, bytes: Vec<u8>, name: &str) -> Result<FontInfo, TextError> {
        if bytes.is_empty() || bytes.len() > MAX_FONT_BYTES {
            return Err(TextError::key("errors.textAuthoringWorker.chooseATtfOrOtfFontSmallerThan"));
        }
        if self.fonts.len() >= MAX_FACES || self.retained + bytes.len() > MAX_RETAINED_FONT_BYTES {
            return Err(TextError::key("errors.textAuthoringWorker.thisSessionHasEnoughFontsLoadedCloseAnd"));
        }
        let length = bytes.len();
        let font = Font::parse(bytes).map_err(|_| {
            TextError::with("errors.textAuthoring.couldNotReadChooseATruetypeTtfOr", vec![("name", Value::str(name))])
        })?;
        if font.units_per_em == 0 {
            return Err(TextError::key("errors.textAuthoring.theFontHasNoUsableOutlines"));
        }
        let id = format!("font-{}", self.next_font);
        self.next_font += 1;
        let info = FontInfo { id: id.clone(), family: font.family(), style: font.style(), bold: font.bold(), italic: font.italic(), name: name.to_string() };
        self.fonts.insert(id, Loaded { font: Arc::new(font), info: info.clone() });
        self.retained += length;
        Ok(info)
    }

    /// Drops every loaded face (the dialog closed).
    pub fn clear_fonts(&mut self) {
        self.fonts.clear();
        self.retained = 0;
    }

    fn bundled_font(&mut self, style: usize) -> Result<Arc<Font>, TextError> {
        if let Some(font) = &self.bundled_parsed[style] {
            return Ok(font.clone());
        }
        let bytes = (self.bundled)(style).ok_or_else(|| TextError::key("errors.textAuthoring.couldNotLoadTheBundledFont"))?;
        let font = Arc::new(Font::parse(bytes.to_vec()).map_err(TextError::from)?);
        self.bundled_parsed[style] = Some(font.clone());
        Ok(font)
    }

    /// `type: "compile"`.
    pub fn compile(&mut self, request: &CompileRequest, cancel: &CancelToken) -> Result<Value, TextError> {
        let options = &request.options;
        let assets = options.get("assetIndex").and_then(Value::as_f64);
        let checked = || cancel.is_cancelled();
        match &request.font {
            FontSource::Embedded => {
                let source = self
                    .source
                    .as_ref()
                    .ok_or_else(|| TextError::key("errors.textAuthoringWorker.thereIsNoEmbeddedTextToEdit"))?;
                compile_embedded_text_figure(options, source)
            }
            font => {
                let mut compiled = match font {
                    FontSource::Loaded(id) => {
                        let loaded = self.fonts.get(id).ok_or_else(|| TextError::key("errors.textAuthoringWorker.chooseAFontAgain"))?;
                        let mut draft = TextOptions::from_value(options);
                        draft.font_family = Some(loaded.info.family.clone());
                        draft.bold = loaded.info.bold;
                        draft.italic = loaded.info.italic;
                        compile_text_figure_checked(&draft, &loaded.font, &checked)?
                    }
                    _ => {
                        let mut draft = TextOptions::from_value(options);
                        draft.font_family = Some("Noto Sans".to_string());
                        let validated = TextSettings::validate(&draft, true)?;
                        let style = validated.bold as usize | ((validated.italic as usize) << 1);
                        let bundled = self.bundled_font(style)?;
                        compile_text_figure_checked(&draft, &bundled, &checked)?
                    }
                };
                if let Some(source) = &self.source {
                    compiled = replace_text_asset_figure(source, &compiled, assets)?;
                }
                let origin = if matches!(font, FontSource::Bundled) { "bundled" } else { "custom" };
                set_font_origin(&mut compiled, origin);
                Ok(compiled)
            }
        }
    }
}

/// `value._styk.textAuthoring.fontOrigin = origin`.
fn set_font_origin(figure: &mut Value, origin: &str) {
    let Some(styk) = figure.make_obj().and_then(|f| f.get_mut("_styk")).and_then(Value::make_obj) else { return };
    let Some(authoring) = styk.get_mut("textAuthoring").and_then(Value::make_obj) else { return };
    authoring.set("fontOrigin", Value::str(origin));
}

// ---- the thread ------------------------------------------------------------------------------------------------

/// What the job answers, in order, except that only the newest compile result is kept.
#[derive(Debug, Clone, PartialEq)]
pub enum JobEvent {
    Source(Result<Option<Value>, TextError>),
    Font(Result<FontInfo, TextError>),
    Compiled(CompileOutcome),
}

enum Command {
    Source(Option<Value>),
    Font(Vec<u8>, String),
    ClearFonts,
}

impl Command {
    /// What the command holds while it waits: font bytes, the figure's tree.
    fn cost(&self) -> usize {
        match self {
            Command::Source(Some(figure)) => figure.heap_bytes(),
            Command::Source(None) | Command::ClearFonts => 0,
            Command::Font(bytes, name) => bytes.len() + name.len(),
        }
    }
}

/// What an answer holds while it waits to be taken.
fn reply_cost(event: &JobEvent) -> usize {
    match event {
        JobEvent::Source(Ok(Some(options))) => options.heap_bytes(),
        _ => 256,
    }
}

#[derive(Default)]
struct Shared {
    commands: VecDeque<Command>,
    /// The command the thread is working on, counted until its answer is queued.
    in_flight: bool,
    /// The newest draft not yet started.
    pending: Option<CompileRequest>,
    /// Answers waiting to be taken, each with its cost; only the newest compile result is kept and it is not counted
    /// against the commands (it replaces itself).
    outbox: VecDeque<(JobEvent, usize)>,
    /// Answers to commands in `outbox`.
    replies: usize,
    /// Bytes of the commands waiting or in flight and of the answers waiting.
    queued_bytes: usize,
    running: Option<CancelToken>,
    closed: bool,
}

struct Inner {
    shared: Mutex<Shared>,
    wake: Condvar,
}

/// A text compiler on its own thread.
pub struct TextJob {
    inner: Arc<Inner>,
}

/// The caller could not queue a command: the commands and answers the job holds are at [`MAX_COMMANDS`] or [`MAX_QUEUED_BYTES`].
/// Nothing was dropped silently; try again after taking events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Busy;

impl TextJob {
    /// `notify` is called from the job's thread whenever an event is ready to take; keep it short (request a redraw).
    pub fn spawn(compiler: TextCompiler, notify: impl Fn() + Send + 'static, spawner: &dyn Spawner) -> Result<TextJob, SpawnError> {
        let inner = Arc::new(Inner { shared: Mutex::new(Shared::default()), wake: Condvar::new() });
        let worker = inner.clone();
        spawner.spawn("text-compile", Box::new(move || run(worker, compiler, notify)))?;
        Ok(TextJob { inner })
    }

    fn command(&self, command: Command) -> Result<(), Busy> {
        let cost = command.cost();
        let mut shared = self.inner.shared.lock().expect("text job state");
        // Requests and answers are bounded together: every accepted command yields at most one answer, so the answers
        // nobody has taken can never outgrow the allowance either.
        let held = shared.commands.len() + shared.in_flight as usize + shared.replies;
        if held >= MAX_COMMANDS || shared.queued_bytes.saturating_add(cost) > MAX_QUEUED_BYTES {
            return Err(Busy);
        }
        shared.queued_bytes += cost;
        shared.commands.push_back(command);
        self.inner.wake.notify_one();
        Ok(())
    }

    pub fn set_source(&self, figure: Option<Value>) -> Result<(), Busy> {
        self.command(Command::Source(figure))
    }

    pub fn load_font(&self, bytes: Vec<u8>, name: &str) -> Result<(), Busy> {
        self.command(Command::Font(bytes, name.to_string()))
    }

    pub fn clear_fonts(&self) -> Result<(), Busy> {
        self.command(Command::ClearFonts)
    }

    /// Queues a draft. It replaces any draft still waiting and cancels the one running.
    pub fn compile(&self, request: CompileRequest) {
        let mut shared = self.inner.shared.lock().expect("text job state");
        if let Some(running) = &shared.running {
            running.cancel();
        }
        shared.pending = Some(request);
        self.inner.wake.notify_one();
    }

    /// Cancels the running compile and forgets the waiting one (the dialog closed).
    pub fn cancel(&self) {
        let mut shared = self.inner.shared.lock().expect("text job state");
        shared.pending = None;
        if let Some(running) = &shared.running {
            running.cancel();
        }
    }

    /// Takes every event that is ready. The lock is held only to swap the queue out; the events are handed over outside it.
    pub fn take_events(&self) -> Vec<JobEvent> {
        let taken = {
            let mut shared = self.inner.shared.lock().expect("text job state");
            let freed: usize = shared.outbox.iter().filter(|(e, _)| !matches!(e, JobEvent::Compiled(_))).map(|(_, cost)| *cost).sum();
            shared.queued_bytes = shared.queued_bytes.saturating_sub(freed);
            shared.replies = 0;
            std::mem::take(&mut shared.outbox)
        };
        taken.into_iter().map(|(event, _)| event).collect()
    }

    /// Signals shutdown. The host spawner owns worker reclamation; closing never joins.
    pub fn close(self) {
        self.signal_close();
    }

    fn signal_close(&self) {
        let mut shared = self.inner.shared.lock().expect("text job state");
        shared.closed = true;
        shared.pending = None;
        shared.commands.clear();
        if let Some(running) = &shared.running {
            running.cancel();
        }
        self.inner.wake.notify_all();
    }
}

impl Drop for TextJob {
    /// Signals the thread and lets go of it. The interface thread never waits for the worker: the worker may be inside a
    /// parse, a compile, or the caller's own notification. It ends as soon as the one step it is in returns.
    fn drop(&mut self) {
        self.signal_close();
    }
}

fn run(inner: Arc<Inner>, mut compiler: TextCompiler, notify: impl Fn()) {
    loop {
        enum Work {
            Command(Command, usize),
            Compile(CompileRequest, CancelToken),
        }
        let work = {
            let mut shared = inner.shared.lock().expect("text job state");
            loop {
                if shared.closed {
                    return;
                }
                if let Some(command) = shared.commands.pop_front() {
                    shared.in_flight = true;
                    let cost = command.cost();
                    break Work::Command(command, cost);
                }
                if let Some(request) = shared.pending.take() {
                    let token = CancelToken::new();
                    shared.running = Some(token.clone());
                    break Work::Compile(request, token);
                }
                shared = inner.wake.wait(shared).expect("text job state");
            }
        };
        match work {
            Work::Command(command, cost) => {
                let reply = match command {
                    Command::Source(figure) => Some(JobEvent::Source(compiler.set_source(figure))),
                    Command::Font(bytes, name) => Some(JobEvent::Font(compiler.load_font(bytes, &name))),
                    Command::ClearFonts => {
                        compiler.clear_fonts();
                        None
                    }
                };
                let mut shared = inner.shared.lock().expect("text job state");
                shared.in_flight = false;
                shared.queued_bytes = shared.queued_bytes.saturating_sub(cost);
                if let Some(event) = reply {
                    let cost = reply_cost(&event);
                    shared.replies += 1;
                    shared.queued_bytes += cost;
                    shared.outbox.push_back((event, cost));
                    drop(shared);
                    notify();
                }
            }
            Work::Compile(request, token) => {
                let revision = request.revision;
                let result = compiler.compile(&request, &token);
                let mut shared = inner.shared.lock().expect("text job state");
                shared.running = None;
                if token.is_cancelled() {
                    // A newer draft (or a close) took over: this result is for a revision nobody waits for.
                    continue;
                }
                shared.outbox.retain(|(e, _)| !matches!(e, JobEvent::Compiled(_)));
                shared.outbox.push_back((JobEvent::Compiled(CompileOutcome { revision, result }), 0));
                drop(shared);
                notify();
            }
        }
    }
}
