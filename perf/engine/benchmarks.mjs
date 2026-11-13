/**
 * The engine tier's benchmarks (perf/engine/README.md): what one layer of the engine costs on one workload, measured in
 * Node on one thread, with the same WebAssembly bytes the app ships.
 *
 * A benchmark names the layer it exercises and defines its metrics as a scenario does (perf/lib/metrics.mjs: title, unit,
 * direction, digits; `floor` is the least change that counts, `scale` marks what a scaling run fits). `headline` lists the
 * metrics the summary shows, the first with its spread. The runner (run.mjs) calls, per workload:
 *
 *   setup(context)            once, not measured; returns the benchmark's state;
 *   prepare(context, state)   before every repetition, not measured: puts the engine in the state the benchmark needs;
 *   run(context, state)       the measured repetition: times its own calls and returns its metrics (it may be async);
 *   reset(context, state)     after every repetition, not measured: takes back what `run` changed;
 *   teardown(context, state)  once at the end.
 *
 * Every `prepare` says why its benchmark needs what it asks for: no benchmark relies on what another left behind, because
 * the runner interleaves their rounds. `context.publish(owner)` makes a document the engine's (a new publication, nothing of it
 * prepared yet) and lets the engine finish its queued work, which is where it drops what the previous publication held. Everything heavy (the editor, the engine owner, the export functions) comes in the
 * context (`context.app`), so this module loads nothing and `npm run perf -- list` stays quick.
 */
import {performance} from 'node:perf_hooks';

const MB = 1048576;
const ms = (title, extra = {}) => ({title, unit: 'ms', better: 'lower', digits: 2, floor: .01, ...extra});
const kb = title => ({title, unit: 'KB', better: 'lower', digits: 1});
const mb = title => ({title, unit: 'MB', better: 'lower', digits: 1});
const count = title => ({title, unit: '', better: 'lower', digits: 0});
const at = (list, index) => list[index % list.length];

/** What every benchmark reports besides its own metrics: the most memory a round took above what the engine held when it began (the runner measures it). */
export const COMMON_METRICS = Object.freeze({'memory.peak': {title: 'Engine memory the round added at its peak', unit: 'MB', better: 'lower', digits: 1}});

export const open = {
  id: 'open', layer: 'open', title: 'Open the document',
  description: 'The editor loads the workload\'s JSON as the app opens a document: the engine decodes it, prepares it for evaluation and builds '
    + 'the views the interface reads (`EngineHandle.open_document_now`, the form of the open its workers run that runs on the calling thread), then the interface '
    + 'builds its read view and its own state from them (this part includes encoding the text, which a file\'s bytes do not need).',
  metrics: {ms: ms('Engine open', {scale: true, digits: 1}), decode: ms('decode: JSON to the document tree', {digits: 1}), prepare: ms('prepare: the document for evaluation', {digits: 1}),
    views: ms('views: what the interface reads of it', {digits: 1}), interface: ms('The interface: read view and editor state', {digits: 1})},
  headline: ['ms', 'decode', 'prepare', 'views', 'interface'],
  // A new editor every time, so every open is a first one. An opening changes nothing the engine draws or exports until a
  // session publishes it. The editor is left for the session benchmark, which needs one that has just loaded the document
  // (loading another would double the dearest work of the run); the one it does not take is let go of here.
  run(context, state) {
    const editor = new context.app.Editor(context.editorOptions);
    const taken = context.measure(() => editor.load(context.text, context.name));
    const timings = editor._opening.timings, engine = taken.engine('EngineHandle.open_document_now');
    state.editor = editor;
    return {ms: engine, decode: timings.decode, prepare: timings.prepare, views: timings.views, interface: taken.ms - engine};
  },
  reset(context, state) {
    context.spare.give(state.editor);
    state.editor = null;
  },
};

export const session = {
  id: 'session', layer: 'edit session', title: 'Start the edit session and publish',
  description: 'The engine owner takes a document the editor has just loaded, as the app does after every open (src/engine/engine-owner.mjs): the '
    + 'session starts from the opening, sharing its tree (`OpenedDocument.start_session`), and publishes it (`EditSession.activate`), so the stage, '
    + 'playback and exports read it from then on. `EditSession.from_document` is not used: a session made from JSON cannot publish.',
  metrics: {ms: ms('Owner installed: session started and published'), start: ms('start_session'), activate: ms('activate (publish)')},
  headline: ['ms', 'start', 'activate'],
  // A session consumes the opening it starts from: every repetition needs an editor that has just loaded the document, the
  // one the open benchmark left when there is one.
  prepare(context, state) {
    state.editor = context.spare.take();
    if (state.editor) return;
    state.editor = new context.app.Editor(context.editorOptions);
    state.editor.load(context.text, context.name);
  },
  run(context, state) {
    const taken = context.measure(() => {
      state.owner = context.app.installEngineOwner(state.editor, {verify: false});
      if (!state.owner.ready()) throw new Error('The engine owner did not start a session on the document.');
    });
    return {ms: taken.ms, start: taken.engine('OpenedDocument.start_session'), activate: taken.engine('EditSession.activate')};
  },
  // The session is let go of and the workload's own document is the engine's again.
  reset(context, state) {
    state.owner.release();
    state.owner = state.editor = null;
    context.publish();
  },
};

export const frame = {
  id: 'frame', layer: 'evaluate and draw list', title: 'Build a frame (what a seek costs the engine)',
  description: 'The engine evaluates a frame and builds its draw list on this thread (`EngineHandle.frame_info`), as a worker prepares one for the stage. '
    + 'Cold is the first frame after the document is published (at a keyframe); the warm frames follow in the same publication, one at another '
    + 'keyframe and one between two keyframes, where every joint is interpolated.',
  metrics: {cold: ms('Cold: first frame after publishing (at a keyframe)', {scale: true}), key: ms('Warm, at a keyframe', {scale: true}),
    between: ms('Warm, between keyframes', {scale: true}), primitives: count('Primitives in the draw list')},
  headline: ['cold', 'key', 'between', 'primitives'],
  // A new publication of the same document every time: the engine keeps the frames it prepared per publication, so the first
  // frame asked for is cold again and none of the ticks below has been prepared.
  prepare(context) { context.publish(); },
  run(context) {
    const {handle} = context.engine, {keys, between} = context.ticks;
    const build = tick => {
      const started = performance.now(), described = handle.frame_info(tick), took = performance.now() - started;
      if (described === undefined) throw new Error(`The document has no tick ${tick}.`);
      return {ms: took, primitives: JSON.parse(described).prims};
    };
    const cold = build(at(keys, 1));
    return {cold: cold.ms, key: build(at(keys, 2)).ms, between: build(at(between, 2)).ms, primitives: cold.primitives};
  },
};

/** The most segments one playback repetition prepares in all: the stress scene's frames take about a tenth of a second each on one thread. */
const PLAYBACK_SEGMENTS = 1000000;

export const playback = {
  id: 'playback', layer: 'evaluate and draw list', title: 'Prepare frames for playback',
  description: 'How many frames a second one thread prepares as playback asks for them: the ticks from the start are requested (`EngineHandle.request`) '
    + 'and the queued work runs here (`EngineHandle.step`, as the engine does without workers). The app spreads this over its worker threads, so one '
    + 'thread\'s rate is what each of them adds. A repetition prepares about a million segments (4 to 48 frames).',
  metrics: {fps: {title: 'Frames prepared a second on one thread', unit: 'fps', better: 'higher', digits: 1, floor: .1}, perFrame: ms('Per frame'),
    frames: count('Frames prepared'), frameMB: {...mb('Frame cache per prepared frame'), digits: 2}},
  headline: ['fps', 'perFrame', 'frames', 'frameMB'],
  setup(context) { return {count: Math.max(1, Math.min(48, context.measured.frames, Math.max(4, Math.round(PLAYBACK_SEGMENTS / context.measured.segmentsPerFrame))))}; },
  // A new publication: nothing is prepared, so every requested tick is work.
  prepare(context) { context.publish(); },
  run(context, state) {
    const {handle} = context.engine, ticks = Uint32Array.from({length: state.count}, (_, tick) => tick);
    const before = JSON.parse(handle.stats()).prepared, started = performance.now();
    handle.request(0, ticks);
    while (handle.step()) { /* one unit of the queued work at a time, as the engine's pump runs it */ }
    const took = performance.now() - started, stats = JSON.parse(handle.stats()), frames = stats.prepared - before;
    if (frames < state.count) throw new Error(`${frames} of the ${state.count} frames asked for were prepared.`);
    return {fps: frames / took * 1000, perFrame: took / frames, frames, frameMB: stats.cached ? stats.cachedBytes / stats.cached / MB : 0};
  },
  // Nothing stays requested.
  reset(context) { context.engine.handle.request(0, new Uint32Array(0)); },
};

export const reads = {
  id: 'reads', layer: 'interface reads', title: 'The interface reads the frame after a seek',
  description: 'What the interface thread reads of the frame on show after a seek (src/engine/engine-shown.mjs): the frame record (`editor.evaluatedFrame`: '
    + 'the session evaluates the frame and sends it as text, its numbers as words) and the geometry (`editor.geometry`: every figure\'s joints and shapes '
    + 'as a packet the interface builds groups from). Each read is timed whole and inside the engine; the rest is the interface decoding it.',
  metrics: {frame: ms('Frame record, whole'), 'frame.engine': ms('Frame record, inside the engine'), geometry: ms('Geometry, whole'), 'geometry.engine': ms('Geometry, inside the engine')},
  headline: ['frame', 'frame.engine', 'geometry', 'geometry.engine'],
  setup() { return {next: 0}; },
  // Every repetition moves the playhead to a tick between keyframes that the one before did not show (the editor's seek alone,
  // which is not measured): the session evaluates the frame for the new playhead, and the geometry comes whole, every figure having moved.
  prepare(context, state) { context.editor.seek(at(context.ticks.between, state.next++), {evaluate: false}); },
  run(context) {
    const frame = context.measure(() => context.editor.evaluatedFrame), geometry = context.measure(() => context.editor.geometry);
    if (!frame.calls.length || !geometry.calls.length) throw new Error('The reads did not reach the engine: the editor answered from what it held.');
    return {frame: frame.ms, 'frame.engine': frame.engineMs, geometry: geometry.ms, 'geometry.engine': geometry.engineMs};
  },
  teardown(context) { context.editor.seek(0); },
};

/**
 * Steps of a drag (about a second of pointer moves at 60 a second), and how often the geometry is read after one: the canvas
 * reads it after every step to draw the handles, but a read costs the same whichever step it follows (only the dragged figure
 * changed), and reading after every one would double the dearest benchmarks of a dense scene.
 */
const STEPS = 60, READ_EVERY = 5;

/** The calls of a drag and what each reports: the engine's time, the whole call (the engine and the interface adopting the answer), the answer's size. */
const dragMetrics = verb => ({
  begin: ms(`Begin the ${verb}, in the engine`), step: ms('A step, in the engine', {scale: true}), 'step.whole': ms('A step, whole', {scale: true}),
  'step.read': ms('The geometry read after a step'), commit: ms('Commit, in the engine', {scale: true}), 'commit.whole': ms('Commit, whole'),
  undo: ms('Undo, in the engine', {scale: true}), 'undo.whole': ms('Undo, whole'), redo: ms('Redo, in the engine', {scale: true}), 'redo.whole': ms('Redo, whole'),
  'step.answer': kb('Answer of a step'), 'commit.answer': kb('Answer of the commit'), 'undo.answer': kb('Answer of the undo'), 'redo.answer': kb('Answer of the redo'),
});

/**
 * One repetition of a drag through the editor (`begin`, then `step(index)` for each step): every call timed whole and inside the
 * engine, the geometry read after every fifth step as the canvas reads it to draw the handles, then commit, undo and redo.
 */
function drag(context, begin, step) {
  const {editor, measure} = context;
  const started = measure(begin);
  if (started.value === false) throw new Error('The drag did not begin.');
  let engine = 0, whole = 0, read = 0, bytes = 0;
  for (let index = 1; index <= STEPS; index++) {
    const taken = measure(() => step(index));
    engine += taken.engineMs; whole += taken.ms; bytes += taken.bytes;
    if (index % READ_EVERY === 0) read += measure(() => editor.geometry).ms;
  }
  const commit = measure(() => editor.commitDrag());
  if (commit.value !== true) throw new Error('The drag did not commit.');
  const undo = measure(() => editor.undo()), redo = measure(() => editor.redo());
  if (!editor.canUndo || editor.canRedo) throw new Error('Undo and redo did not bring the drag back.');
  return {begin: started.engineMs, step: engine / STEPS, 'step.whole': whole / STEPS, 'step.read': read / (STEPS / READ_EVERY), commit: commit.engineMs, 'commit.whole': commit.ms,
    undo: undo.engineMs, 'undo.whole': undo.ms, redo: redo.engineMs, 'redo.whole': redo.ms,
    'step.answer': bytes / STEPS / 1024, 'commit.answer': commit.bytes / 1024, 'undo.answer': undo.bytes / 1024, 'redo.answer': redo.bytes / 1024};
}

/** The figure a drag takes (the middle one) and where it stands at the first tick: its root, and a joint in the middle of its second limb with that joint's parent. */
function dragTarget(context) {
  const {editor, spec} = context;
  if (editor.tick !== 0) editor.seek(0);
  const uid = Math.floor(spec.figures / 2) + 1, group = [...editor.geometry.objects.values()].find(found => found?.obj?.unique_id === uid);
  if (!group) throw new Error(`Figure ${uid} is not in the frame on show.`);
  const joint = Math.min(group.fig.segments.length - 1, spec.chain + Math.floor(spec.chain / 2)), segment = group.fig.segments[joint];
  const point = group.joints.get(Number(segment.segment_id)), parent = group.joints.get(Number(segment.parent_id));
  if (!point || !parent) throw new Error(`Joint ${joint} of figure ${uid} has no place in the geometry.`);
  return {uid, joint, point, parent};
}

/**
 * Where a drag starts: the edited document is the engine's, as in the app (a commit publishes its change; the export
 * benchmark publishes a document of its own), the first tick is on show with the interface having read its frame and
 * geometry, as after any seek (otherwise the drag's first call would pay for that), and the figure is selected as the press
 * selects it. Another benchmark moves the playhead between rounds; the drag's own reset (an undo) leaves the document as it was opened.
 */
function dragReady(context, uid, joint) {
  const {editor} = context;
  context.publish();
  if (editor.tick !== 0) editor.seek(0);
  void editor.geometry;
  editor.select(uid, joint);
}

export const pose = {
  id: 'edit.pose', layer: 'edit session', title: 'Pose a joint: drag, commit, undo, redo',
  description: 'A pose drag as the canvas makes it, through the engine owner: `beginDrag`, 60 `poseJoint` steps swinging a joint of the middle '
    + 'figure out and back, `commitDrag`, `undo`, `redo`. Each call is timed inside the engine (the session call) and whole (the engine and the '
    + 'interface adopting its answer, src/engine/engine-owner.mjs); the answers\' sizes are what crosses to the interface.',
  metrics: dragMetrics('pose'),
  headline: ['step', 'step.whole', 'step.read', 'commit', 'undo', 'redo', 'step.answer', 'commit.answer'],
  setup: dragTarget,
  prepare(context, state) { dragReady(context, state.uid, state.joint); },
  run(context, {point, parent}) {
    const {editor} = context, radius = Math.hypot(point.x - parent.x, point.y - parent.y), from = Math.atan2(point.y - parent.y, point.x - parent.x);
    return drag(context, () => editor.beginDrag('Pose joint'), index => {
      const angle = from + Math.sin(index / STEPS * Math.PI) * .6;
      return editor.poseJoint(parent.x + Math.cos(angle) * radius, parent.y + Math.sin(angle) * radius,
        {stretch: false, isolate: false, snapTolerance: 6, alternate: false, depth: false, pixel: 1, anchor: point});
    });
  },
  // The redone pose is undone: the document is the one opened again (the redo entry left goes with the next commit).
  reset(context) { context.editor.undo(); },
};

export const move = {
  id: 'edit.move', layer: 'edit session', title: 'Move a figure: drag, commit, undo, redo',
  description: 'A move drag through the engine owner: `beginTranslationDrag`, 60 `moveSelection` steps from the start (as the canvas sends them '
    + 'for a figure the engine must solve while it moves; an ordinary move sends one at the release), `commitDrag`, `undo`, `redo`.',
  metrics: dragMetrics('move'),
  headline: ['step', 'step.whole', 'step.read', 'commit', 'undo', 'redo', 'step.answer', 'commit.answer'],
  setup: dragTarget,
  prepare(context, state) { dragReady(context, state.uid, -1); },
  run(context) {
    const {editor} = context;
    return drag(context, () => editor.beginTranslationDrag('Move connected figures'), index => editor.moveSelection(index, index / 2, {fromStart: true, movePins: false}));
  },
  reset(context) { context.editor.undo(); },
};

export const save = {
  id: 'save', layer: 'files', title: 'Save the project (.styk)',
  description: 'The project file as the app saves it (`save_project` through src/engine/engine-document-export.mjs): the session hands its document '
    + 'over without a copy (`snapshot`) and the engine writes the container, reporting its phases. In the app this runs on a worker that may share the '
    + 'sections with others; here every phase runs on this thread.',
  metrics: {ms: ms('Save, whole', {digits: 1}), prepare: ms('prepare', {digits: 1}), lift: ms('lift: the tree to its stored form', {digits: 1}), check: ms('check: the scene', {digits: 1}),
    sections: ms('sections: hash and compress', {digits: 1}), assemble: ms('assemble the container', {digits: 1}), written: {...mb('File written'), digits: 2}},
  headline: ['ms', 'lift', 'check', 'sections', 'assemble', 'written'],
  // A save copies nothing and changes nothing: each one writes the document as it is.
  run(context) {
    const started = performance.now(), token = context.app.snapshotDocument(context.editor.report);
    if (token === undefined) throw new Error('No session holds the document.');
    const made = context.app.makeProjectFile({join: null, request: {snapshots: [token], scopes: [], name: context.name}, cancelled: () => false});
    const took = performance.now() - started, timings = made.timings;
    return {ms: took, prepare: timings.prepare_ms, lift: timings.lift_ms, check: timings.check_ms, sections: timings.frames_ms, assemble: timings.assemble_ms, written: made.bytes.length / MB};
  },
};

/** The most segment-frames one Pivot export repetition writes: every tick is a stored frame, about 70 ms of the stress scene each. */
const EXPORT_SEGMENT_FRAMES = 1000000;

export const pivot = {
  id: 'export', layer: 'files', title: 'Export as Pivot (.piv)',
  description: 'The Pivot export as the app makes it (`export_document` with the codec\'s request as its output): every tick baked into a stored frame, '
    + 'Pivot having no interpolation, written as the JSON the codec encodes (the codec\'s own encoding is not part of the engine). The engine reports no '
    + 'phases for it. A document of more than a million segment-frames is exported cut to as many ticks as make that many (the same figures and '
    + 'segments over two keyframes): the time per exported frame is what carries over to the whole document.',
  metrics: {ms: ms('Export, whole', {digits: 1}), perFrame: ms('Per exported frame'), frames: count('Frames exported'), written: mb('Written (the codec\'s request)')},
  headline: ['ms', 'perFrame', 'frames', 'written'],
  setup(context) {
    const {spec, measured} = context, ticks = Math.min(measured.frames, Math.max(2, Math.floor(EXPORT_SEGMENT_FRAMES / measured.segmentsPerFrame)));
    if (ticks >= measured.frames) return {editor: context.editor, owner: context.owner, ticks};
    // Opened in an editor of its own, which the runner releases with the workload.
    return {...context.open({...spec, id: `${spec.id}-cut`, keyframes: 2, hold: ticks - 1}), ticks};
  },
  // An export reads the engine's document at the editor's revision, not a session's: the exported one is published first.
  prepare(context, state) { context.publish(state.owner); },
  run(context, state) {
    const started = performance.now();
    const made = context.app.makeExportDocument({join: null, address: context.engine.handle.address(), revision: state.editor.revision,
      request: {format: 'piv', name: context.name, output: 'codec'}, cancelled: () => false});
    const took = performance.now() - started;
    return {ms: took, perFrame: took / state.ticks, frames: state.ticks, written: made.bytes.length / MB};
  },
  teardown(context) { context.publish(); },
};

/** The sizes a frame is exported at: what most exports ask for. */
const RASTER_SIZES = [['720p', 1280, 720], ['1080p', 1920, 1080]];

export const raster = {
  id: 'raster', layer: 'CPU rasterizer', title: 'Draw an export frame on the CPU',
  description: 'One frame between keyframes drawn by the CPU rasterizer (styk-raster, through `ExportRenderer.create_cpu`), as exports and thumbnails '
    + 'are drawn on a computer without usable graphics: the frame is prepared (evaluated), drawn tile by tile and read out as RGBA, at 1280×720 and 1920×1080.',
  metrics: {'720p': ms('1280×720, the whole frame', {digits: 1}), '1080p': ms('1920×1080, the whole frame', {digits: 1}), evaluate: ms('1920×1080: prepare (evaluate) the frame', {digits: 1}),
    draw: ms('1920×1080: draw the tiles', {digits: 1}), read: ms('1920×1080: read the pixels out', {digits: 1})},
  headline: ['720p', '1080p', 'evaluate', 'draw', 'read'],
  // The renderer draws the engine's document at the editor's revision: the workload's document is published first.
  prepare(context) { context.publish(); },
  async run(context) {
    const {handle} = context.engine, {ExportRenderer, EXPORT_MAX_PIXELS, ENGINE_TILE_SIDE} = context.app, tick = at(context.ticks.between, 1), values = {};
    for (const [name, width, height] of RASTER_SIZES) {
      const renderer = ExportRenderer.create_cpu(handle.address(), context.editor.revision, width, height, 'edges', EXPORT_MAX_PIXELS, ENGINE_TILE_SIDE);
      try {
        const started = performance.now();
        while (renderer.upload_images() > 0) handle.step();
        while (!renderer.prepare(tick, tick)) if (!handle.step()) throw new Error(`The engine has no work left and tick ${tick} is not prepared.`);
        const prepared = performance.now(), [, , , , tileWidth, tileHeight] = renderer.tile_rect(0), out = new Uint8ClampedArray(tileWidth * tileHeight * 4);
        let draw = 0, read = 0;
        for (let index = 0, slots = renderer.slots(); index < renderer.tiles(); index++) {
          const drawing = performance.now();
          await renderer.draw_tile(index, index % slots);
          const reading = performance.now();
          renderer.resolve_tile(index, index % slots, false, out);
          draw += reading - drawing; read += performance.now() - reading;
        }
        values[name] = performance.now() - started;
        if (name === '1080p') Object.assign(values, {evaluate: prepared - started, draw, read});
      } finally { renderer.dispose(); renderer.free(); }
    }
    return values;
  },
};

/** Every benchmark, in the order a workload runs them. */
export const BENCHMARKS = Object.freeze([open, session, frame, playback, reads, pose, move, save, pivot, raster]);

/** What a scaling run measures at every size: how opening, a frame and an edit grow with the scene. */
export const SCALING_BENCHMARKS = Object.freeze([open, frame, pose]);

/** The benchmarks named in `wanted` (ids or layers), all when it is empty; throws naming what matched nothing. */
export function select(wanted, from = BENCHMARKS) {
  if (!wanted?.length) return [...from];
  const chosen = from.filter(benchmark => wanted.some(word => benchmark.id === word || benchmark.layer === word || benchmark.id.startsWith(`${word}.`)));
  const unknown = wanted.filter(word => !from.some(benchmark => benchmark.id === word || benchmark.layer === word || benchmark.id.startsWith(`${word}.`)));
  if (unknown.length) throw new Error(`No engine benchmark matches ${unknown.map(word => JSON.stringify(word)).join(', ')}: one of ${from.map(benchmark => benchmark.id).join(', ')}.`);
  return chosen;
}
