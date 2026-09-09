/**
 * Matched native/app input benchmark. Preparation is safe by default:
 *   node tests/matched-app-interaction.mjs --plan
 * Run only after obtaining the exclusive GPU slot:
 *   STYK_GPU_SLOT=matched-app-interaction node tests/matched-app-interaction.mjs --run
 * Optional STYK_MATCH_TRAJECTORY is JSON {points:[{x,y,tMs}], view:{x,y}} in world units.
 * A new visible Electron process/profile/backend is used per cold repetition. The
 * second import retains that same process, importer worker and backend source cache.
 * OS file/shader caches are uncontrolled. Original source bytes are never written.
 */
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envNumber = (key, fallback) => {
  const value = process.env[key] === undefined ? fallback : Number(process.env[key]);
  if (!Number.isFinite(value)) throw new Error(`${key} must be finite.`);
  return value;
};
const config = {
  source: path.resolve(process.env.STYK_MATCH_SOURCE || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv'),
  frameIndex: 1478, uid: 460616, joint: 0, width: 1120, height: 652,
  scale: 1.491176486, dpr: 1, cameraEnabled: false, onionCount: 0,
  viewX: process.env.STYK_MATCH_VIEW_X === undefined ? null : envNumber('STYK_MATCH_VIEW_X'),
  viewY: process.env.STYK_MATCH_VIEW_Y === undefined ? null : envNumber('STYK_MATCH_VIEW_Y'),
  samples: envNumber('STYK_MATCH_SAMPLES', 24), intervalMs: envNumber('STYK_MATCH_INTERVAL_MS', 40),
  amplitudeWorld: envNumber('STYK_MATCH_AMPLITUDE_WORLD', 8),
  coldProcesses: envNumber('STYK_MATCH_COLD_PROCESSES', 3), warmImports: envNumber('STYK_MATCH_WARM_IMPORTS', 1),
  trace: process.env.STYK_MATCH_TRACE === '1', expectedElectron: process.env.STYK_MATCH_ELECTRON || '39.8.10',
  profileImport: process.env.STYK_MATCH_PROFILE === '1',
  verifyInitialBatch: process.env.STYK_MATCH_VERIFY_BATCH === '1',
  expectedScanner: process.env.STYK_MATCH_SCANNER || null,
  inheritedBackendSelectors: Object.fromEntries(['STYK_PYTHON', 'STYK_NATIVE_SCAN_LIBRARY', 'STYK_DISABLE_NATIVE_SCAN', 'STYK_DISABLE_FAST_JSON']
    .map(key => [key, process.env[key] ?? null])),
  trajectoryFile: process.env.STYK_MATCH_TRAJECTORY ? path.resolve(process.env.STYK_MATCH_TRAJECTORY) : null,
  output: path.resolve(process.env.STYK_MATCH_OUTPUT || path.join(appRoot, 'artifacts', `matched-app-interaction-${new Date().toISOString().replace(/[:.]/g, '-')}`)),
};
for (const key of ['samples', 'coldProcesses', 'warmImports']) assert.ok(Number.isInteger(config[key]) && config[key] >= (key === 'warmImports' ? 0 : 1), `${key} is invalid`);
assert.ok(config.intervalMs > 0 && config.amplitudeWorld > 0);
const metricDefinitions = {
  importEventToLoadReturnMs: 'File-input change Event.timeStamp to editor.load return or editor.loadAsync resolution, including its listeners; automation file selection excludes native dialog interaction.',
  importEventToEditableStateMs: 'File-input change to first rAF observation of target document loaded, !importing, idle, and a renderer submission. Readiness observation, not a drag or physical presentation.',
  importEventToFirstSubmitMs: 'File-input change to first actual GPUQueue.submit return for the newly loaded document.',
  importEventToFirstQueueCallbackMs: 'File-input change to onSubmittedWorkDone callback associated with first target-document submit; includes GPU work and callback scheduling.',
  importToMatchedLastFrameReadyMs: 'File-input change to first GPU-completion callback for native last key1478 with its background and visible-frame figure image assets decoded. Earlier partial draws remain separate first-submit metrics. If import already opens that key, no redundant seek/render is requested.',
  firstVisibleObservation: 'Screenshot request/return interval after first submitted target document and editable-state observation. Visible-image evidence/upper bound, not first physical display timestamp.',
  inputToMutationMs: 'Real pointermove Event.timeStamp to poseJoint return; capture and poseJoint entry/exit are also recorded.',
  inputToSubmitMs: 'Latest pose-mutating input represented by a viewport render to GPUQueue.submit return. Earlier coalesced inputs are identified separately.',
  inputToQueueCallbackMs: 'Input Event.timeStamp to its associated submit queue-completion callback. Not a pure GPU timestamp or display presentation.',
  chromiumFeedback: 'Optional trace display/presentation API events temporally following a submit marker. Candidate association only unless Chromium supplies a shared frame identifier; no monitor scanout is measured.',
  importViewportNormalization: 'Before the first target-document render, the harness applies the native benchmark view scale/pan to app state and its artboard. This removes the normal app fit command\'s 13px label offset; native benchmarking likewise normalizes zoom before its first draw. Both original and effective initial views/matrices are recorded.',
};
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({status: 'prepared-not-run', config, metricDefinitions,
    launchGuard: 'Requires --run AND STYK_GPU_SLOT=matched-app-interaction after coordinator grants exclusive GPU access.'}, null, 2));
  process.exit(0);
}
assert.equal(process.env.STYK_GPU_SLOT, 'matched-app-interaction', 'Obtain the exclusive GPU slot before setting STYK_GPU_SLOT=matched-app-interaction.');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quantiles = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return {count: a.length, method: 'nearest-rank', p50: a.length ? a[Math.ceil(a.length * .5) - 1] : null,
    p95: a.length ? a[Math.ceil(a.length * .95) - 1] : null, max: a.at(-1) ?? null};
};
const sourceHashBefore = hash(await readFile(config.source));
// Enumerate on both sides of the run so additions/deletions, locale modules,
// preload code and imported decoder dependencies cannot escape the freeze check.
const codeRoots = ['src', 'vendor', 'backend', 'desktop', 'native', '../tools', '../StykAnimate/tools'];
const codeExtensions = new Set(['.mjs', '.cjs', '.js', '.py', '.json', '.css', '.html', '.wgsl', '.cpp', '.h', '.hpp', '.dll', '.so', '.dylib', '.exe']);
async function runtimeFiles(directory) {
  const entries = await readdir(path.join(appRoot, directory), {withFileTypes: true});
  const nested = await Promise.all(entries.filter(entry => !['__pycache__', 'node_modules', '.cache'].includes(entry.name)
    && !(directory === 'backend' && /^(?:test_|benchmark|profile_)/.test(entry.name))).map(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? runtimeFiles(file) : codeExtensions.has(path.extname(file)) ? [file] : [];
  }));
  return nested.flat();
}
const codeHashes = async () => {
  const codeFiles = [...(await Promise.all(codeRoots.map(runtimeFiles))).flat(), 'index.html', 'package.json', 'package-lock.json'].sort();
  return Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, hash(await readFile(path.join(appRoot, file)))])));
};
const sourceCodeHashesBefore = await codeHashes();
const trajectory = config.trajectoryFile ? JSON.parse(await readFile(config.trajectoryFile, 'utf8')) : null;
if (trajectory) {
  assert.ok(Array.isArray(trajectory.points) && trajectory.points.length > 0, 'Trajectory needs points.');
  trajectory.points.forEach((p, i) => {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.tMs) && p.tMs >= 0);
    if (i) assert.ok(p.tMs > trajectory.points[i - 1].tMs, 'Trajectory times must increase.');
  });
}
await mkdir(config.output, {recursive: true});
const report = {startedAt: new Date().toISOString(), config, sourceHashBefore, sourceCodeHashesBefore, metricDefinitions, processes: [], trials: [], errors: [],
  limitations: ['GPU-exclusive scheduling is coordinated externally.', 'Process-cold, OS file/shader caches uncontrolled.',
    'SHA verification reads source bytes before launch and may warm the OS file cache.',
    'Pointer events are trusted browser automation input; no physical mouse hardware timestamp is measured.',
    'CPU submit and queue-completion callbacks are never labelled physical presentation.',
    'Screenshot/independent-render correctness checks run after the measured pointer sequence.',
    'Native editing uses raw view scale/pan; app effective camera transform is recorded and a mismatch prevents an identical-viewport claim.',
    'Autosave is disabled identically in both process/cache conditions to isolate interactive work.']};
const saveReport = () => writeFile(path.join(config.output, 'report.json'), JSON.stringify(report, null, 2));

// The probe is installed on existing objects; app/core source is untouched.
async function installProbe({frameIndex, importView}) {
  const {editor, state} = window.styk;
  const {cameraMatrix} = await import('/src/renderer.mjs');
  const renderer = state.renderer, queue = renderer.device?.queue;
  if (!queue) throw new Error('Matched benchmark requires the WebGPU renderer.');
  const probe = window.__matchedInput = {trial: null, nextInput: 0, nextSubmit: 0, generation: 0,
    events: [], mutations: [], renders: [], submits: [], loads: [], imports: [], pending: [], longTasks: [], lastMutation: null};
  window.addEventListener('error', event => {probe.fatalError = event.message || 'An uncaught renderer error occurred.';});
  window.addEventListener('unhandledrejection', event => {probe.fatalError = String(event.reason?.stack || event.reason || 'An unhandled renderer rejection occurred.');});
  const stamp = e => e.timeStamp > 1e12 ? e.timeStamp - performance.timeOrigin : e.timeStamp;
  const mark = (name, detail) => performance.mark(`styk-matched-${name}`, {detail});
  const current = () => probe.imports.find(row => row.id === probe.trial);
  for (const method of ['load', 'loadAsync']) {
    const originalLoad = editor[method];
    if (typeof originalLoad !== 'function') continue;
    editor[method] = function(...args) {
      // An async loader may delegate its final installation to load(). Capture
      // the outer operation once without replacing or bypassing either method.
      if (probe.activeLoad) return originalLoad.apply(this, args);
      const row = {trial: probe.trial, method, start: performance.now(), generation: ++probe.generation};
      probe.activeLoad = row;
      const finish = () => {
        row.end = performance.now(); row.frameCount = this.report.keyframes.length;
        probe.loads.push(row); probe.loadedReport = this.report; probe.lastMutation = null; probe.activeLoad = null;
        const imported = current(); if (imported) {
          const frame = this.report.keyframes[frameIndex];
          const usedTypes = new Set(frame.objects.map(object => object.figure_type_id));
          probe.importFigureAssets = this.report.figure_types.filter(figure => usedTypes.has(figure.figure_type_id)).flatMap(figure => figure.image_assets || []);
          Object.assign(imported, {loadStart: row.start, loadEnd: row.end, generation: row.generation, loadMethod: method,
            loadWasAsync: row.async, loadImmediateReturnMs: row.callReturnedAt - row.start,
            frameFigureImageAssets: probe.importFigureAssets.length,
            rendererStatsAtLoadEnd: structuredClone(renderer.stats),
            loadStages: this.lastLoadTimings ? structuredClone(this.lastLoadTimings) : null});
        }
        mark(`load-${row.trial}`, {at: row.end});
      };
      try {
        const result = originalLoad.apply(this, args); row.callReturnedAt = performance.now(); row.async = Boolean(result?.then);
        if (row.async) return result.then(value => {finish(); return value;}, error => {probe.activeLoad = null; throw error;});
        finish(); return result;
      } catch (error) {probe.activeLoad = null; throw error;}
    };
  }
  document.getElementById('file-input').addEventListener('change', e => {
    const row = current(); if (!row) return;
    row.eventAt = stamp(e); row.captureAt = performance.now(); row.isTrusted = e.isTrusted;
    mark(`import-${row.id}`, {eventAt: row.eventAt});
    requestAnimationFrame(observeReadiness);
  }, {capture: true});
  window.addEventListener('pointerdown', capture, {capture: true});
  window.addEventListener('pointermove', capture, {capture: true});
  window.addEventListener('pointerup', capture, {capture: true});
  function capture(e) {
    if (!probe.measuring || e.target?.id !== 'overlay') return;
    const row = {id: ++probe.nextInput, trial: probe.trial, type: e.type, eventAt: stamp(e), captureAt: performance.now(),
      x: e.clientX, y: e.clientY, buttons: e.buttons, isTrusted: e.isTrusted,
      coalesced: e.getCoalescedEvents?.().map(item => ({eventAt: stamp(item), x: item.clientX, y: item.clientY})) || []};
    probe.events.push(row); probe.currentInput = row;
    mark(`input-${row.id}`, {eventAt: row.eventAt, trial: row.trial});
  }
  const pose = editor.poseJoint;
  editor.poseJoint = function(...args) {
    if (!probe.measuring) return pose.apply(this, args);
    const row = {trial: probe.trial, inputId: probe.currentInput?.id, eventAt: probe.currentInput?.eventAt,
      start: performance.now(), target: {x: args[0], y: args[1]}};
    const result = pose.apply(this, args); row.end = performance.now(); row.result = result;
    row.uid = this.selectedUid; row.joint = this.selectedJoint;
    probe.mutations.push(row); probe.lastMutation = row; mark(`mutation-${row.inputId}`, {at: row.end}); return result;
  };
  const emit = editor._emit;
  editor._emit = function(kind, detail) {
    if (probe.measuring && kind === 'edit') {
      const input = probe.currentInput; if (input) input.editEmissionAt = performance.now();
    }
    return emit.call(this, kind, detail);
  };
  for (const method of ['render', 'renderPrepared']) {
    if (typeof renderer[method] !== 'function') continue;
    const original = renderer[method];
    renderer[method] = function(...args) {
      const options = method === 'render' ? args[0] : args[1];
      const targetDocument = Boolean(current()?.loadEnd && options?.report === probe.loadedReport);
      const viewBeforeNormalization = {...options?.view};
      const normalizeImportView = Boolean(targetDocument && importView && !current().firstSubmit);
      if (normalizeImportView) {
        Object.assign(state.view, importView); options.view = state.view;
        const artboard = document.getElementById('artboard');
        if (artboard) Object.assign(artboard.style, {left: `${state.view.x}px`, top: `${state.view.y}px`,
          width: `${editor.report.canvas_width * state.view.scale}px`, height: `${editor.report.canvas_height * state.view.scale}px`});
      }
      const row = {trial: probe.trial, method, start: performance.now(), generation: probe.generation,
        inputId: probe.measuring ? probe.lastMutation?.inputId : null, eventAt: probe.measuring ? probe.lastMutation?.eventAt : null,
        targetDocument, viewBeforeNormalization, view: {...options?.view}, matrix: cameraMatrix(options),
        normalizeImportView, viewport: [this.width, this.height], dpr: this.dpr,
        frameIndex: editor.frameIndex, tick: editor.tick};
      probe.activeRender = row;
      try { return original.apply(this, args); }
      finally {
        row.end = performance.now(); row.stats = structuredClone(this.stats); probe.renders.push(row); probe.activeRender = null;
        const submitted = probe.submits.at(-1);
        if (submitted?.renderStart === row.start) {
          submitted.rendererStats = row.stats;
          if (submitted.targetDocument && submitted.frameIndex === frameIndex && !current()?.matchedLastFrameFirstSubmit) {
            submitted.backgroundsReady = this.backgroundsReady(options.report, options.frame);
            const backgrounds = this.layout.filter(entry => typeof entry.key === 'string' && entry.key.startsWith('background-'));
            submitted.backgroundLayoutEntries = backgrounds.length;
            submitted.backgroundTextureEntries = backgrounds.filter(entry => Boolean(entry.texture)).length;
            submitted.expectedBackgroundImages = this.backgroundAssets(options.report, options.frame).length;
            submitted.figureImagesReady = (probe.importFigureAssets || []).every(asset => {
              const image = this.resources.image(this.resources.url(asset));
              if (image?.complete && !image.naturalWidth) throw new Error('A matched-frame figure image failed to decode.');
              return Boolean(image?.complete && image.naturalWidth);
            });
            submitted.sceneAssetsReady = submitted.backgroundsReady && submitted.figureImagesReady
              && submitted.backgroundTextureEntries >= submitted.expectedBackgroundImages;
            if (submitted.sceneAssetsReady) current().matchedLastFrameFirstSubmit = submitted;
          }
        }
      }
    };
  }
  const submit = queue.submit.bind(queue);
  queue.submit = function(buffers) {
    const render = probe.activeRender;
    if (!render || !probe.trial) return submit(buffers);
    const row = {id: ++probe.nextSubmit, trial: probe.trial, generation: render.generation, inputId: render.inputId,
      eventAt: render.eventAt, renderStart: render.start, method: render.method, frameIndex: render.frameIndex, tick: render.tick,
      viewBeforeNormalization: render.viewBeforeNormalization, view: render.view, matrix: render.matrix,
      normalizeImportView: render.normalizeImportView, viewport: render.viewport, dpr: render.dpr,
      targetDocument: render.targetDocument, start: performance.now()};
    const result = submit(buffers); row.end = performance.now(); probe.submits.push(row);
    const imported = current();
    if (row.targetDocument && !imported.firstSubmit) imported.firstSubmit = row;
    mark(`submit-${row.id}`, {at: row.end, inputId: row.inputId, trial: row.trial});
    const completed = queue.onSubmittedWorkDone().then(() => {
      row.queueCallbackAt = performance.now(); mark(`queue-${row.id}`, {at: row.queueCallbackAt});
      observeReadiness();
      requestAnimationFrame(at => {row.nextRafAt = at; row.nextRafCallbackAt = performance.now();});
    }).catch(error => {row.queueError = error.message;});
    probe.pending.push(completed); return result;
  };
  const observeReadiness = () => {
    const row = current();
    if (row?.loadEnd && !row.editableObservedAt && !state.importing && !state.playing && row.firstSubmit) {
      row.editableObservedAt = performance.now(); row.frameIndexAtReady = editor.frameIndex;
      mark(`editable-${row.id}`, {at: row.editableObservedAt});
    }
    if (row?.editableObservedAt && row.firstSubmit?.queueCallbackAt && !row.matchedLastFrameRequestedAt) {
      // Keep automation-process pauses out of this readiness boundary.
      row.matchedLastFrameRequestedAt = performance.now();
      row.matchedLastFrameSeekRequired = editor.frameIndex !== frameIndex;
      if (row.matchedLastFrameSeekRequired) {
        row.matchedLastFrameSeekAt = performance.now(); editor.selectFrame(frameIndex);
      } else {
        row.matchedLastFrameSeekAt = null;
        if (row.firstSubmit.frameIndex === frameIndex && row.firstSubmit.sceneAssetsReady) row.matchedLastFrameFirstSubmit ??= row.firstSubmit;
      }
    }
    if (row && !row.matchedLastFrameRequestedAt) requestAnimationFrame(observeReadiness);
  };
  requestAnimationFrame(observeReadiness);
  new PerformanceObserver(list => {for (const item of list.getEntries()) probe.longTasks.push({trial: probe.trial, at: item.startTime, duration: item.duration});}).observe({type: 'longtask'});
  state.onion = false; state.settings.onionCount = 0; state.settings.autosaveSeconds = 0; clearTimeout(state.recoveryTimer);
  return {backend: renderer.stats.backend, adapter: renderer.stats.adapter, rendererType: renderer.constructor.name};
}

async function startTrace(client) {
  await client.send('Tracing.start', {transferMode: 'ReturnAsStream', traceConfig: {recordMode: 'recordContinuously', traceBufferSizeInKb: 131072,
    includedCategories: ['gpu', 'cc', 'viz', 'input', 'latencyInfo', 'blink.user_timing', 'devtools.timeline',
      'benchmark', 'latency', 'disabled-by-default-devtools.timeline.inputs', 'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-viz.surface_id_flow', 'toplevel.flow', 'scheduler.flow',
      'disabled-by-default-gpu.service', 'disabled-by-default-gpu.device']}});
}
async function stopTrace(client, filename, samples) {
  const completed = new Promise(resolve => client.once('Tracing.tracingComplete', resolve));
  await client.send('Tracing.end'); const {stream} = await completed; const chunks = [];
  try {for (;;) {const part = await client.send('IO.read', {handle: stream}); chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8')); if (part.eof) break;}}
  finally {await client.send('IO.close', {handle: stream});}
  const bytes = Buffer.concat(chunks); await writeFile(filename, bytes);
  const events = JSON.parse(bytes.toString()).traceEvents || [];
  const markers = events.filter(e => /^styk-matched-submit-\d+$/.test(e.name) && Number.isFinite(e.args?.data?.startTime));
  if (!markers.length) return {status: 'no-compatible-submit-markers', traceEvents: events.length, candidates: []};
  const offsets = markers.map(e => e.ts - e.args.data.startTime * 1000).sort((a, b) => a - b), offset = offsets[Math.floor(offsets.length / 2)];
  const names = ['DCompPresenter::Present', 'Display::FrameDisplayed', 'DXGISwapChainImageBacking::Present', 'WidgetBase::DidCommitAndDrawCompositorFrame'];
  const feedback = events.filter(e => names.includes(e.name)).map(e => ({name: e.name, at: (e.ts - offset) / 1000,
    durationMs: (e.dur || 0) / 1000, pid: e.pid, tid: e.tid, args: e.args})).sort((a, b) => a.at - b.at);
  return {status: 'temporal-candidates-only', traceEvents: events.length, offsetSpreadMicroseconds: offsets.at(-1) - offsets[0],
    eventCounts: Object.fromEntries(names.map(name => [name, feedback.filter(e => e.name === name).length])),
    candidates: samples.map(sample => ({submitId: sample.id, inputId: sample.inputId, submittedAt: sample.end,
      followingEvents: names.map(name => feedback.find(event => event.name === name && event.at >= sample.end && event.at - sample.end < 1000)).filter(Boolean)})),
    limitation: 'Temporal proximity cannot identify which edited frame was displayed. These events are not physical monitor scanout timestamps.'};
}

async function configureTarget(page) {
  return page.evaluate(async ({config, trajectory}) => {
    const {worldToScreen, screenToWorld, cameraMatrix} = await import('/src/renderer.mjs');
    const e = styk.editor, s = styk.state;
    e.selectFrame(config.frameIndex); e.select(config.uid, config.joint);
    s.onion = false; s.settings.onionCount = 0; s.handles = true; s.settings.showUnselectedHandles = true;
    s.settings.autoSizeHandles = true; s.settings.handleSize = 5; s.settings.outlineHandles = true;
    s.tool = 'select'; s.locked.clear(); s.hidden.clear();
    // Preserve the imported camera. Observe what the current app renderer uses,
    // because native editing draws the saved camera as an overlay only.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const g = e.geometry.objects.get(e.selectedSlot), endpoint = g.segments[config.joint].end;
    const effectiveOptions = {...s.renderer.last, report: e.report, frame: s.renderer.last?.frame || e.evaluatedFrame};
    const zero = worldToScreen(endpoint, {...effectiveOptions, view: {x: 0, y: 0, scale: config.scale}});
    const x = trajectory?.view?.x ?? config.viewX ?? config.width * .5 - zero.x;
    const y = trajectory?.view?.y ?? config.viewY ?? config.height * .5 - zero.y;
    Object.assign(s.view, {x, y, scale: config.scale}); window.dispatchEvent(new Event('resize'));
    e.select(config.uid, config.joint);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const viewport = document.getElementById('viewport').getBoundingClientRect();
    const options = {...s.renderer.last, report: e.report, frame: s.renderer.last?.frame || e.evaluatedFrame, view: s.view};
    const worldPoints = trajectory?.points || Array.from({length: config.samples}, (_, i) => {
      return {x: endpoint.x + config.amplitudeWorld * Math.sin(i / 4), y: endpoint.y + config.amplitudeWorld * Math.cos(i / 4), tMs: i * config.intervalMs};
    });
    const convert = point => {const p = worldToScreen(point, options); return {x: p.x + viewport.x, y: p.y + viewport.y};};
    const pose = geometry => [...geometry.objects].flatMap(([slot, item]) => [...item.joints].map(([vertex, point]) => ({slot, uid: item.obj.unique_id, vertex, x: point.x, y: point.y})));
    window.__matchedPose = pose;
    window.__matchedBefore = {frame: JSON.stringify(e.frame), nodes: pose(e.geometry), states: e.frame.objects.map(o => ({uid: o.unique_id,
      root_x: o.root_x, root_y: o.root_y, scale: o.scale, angles: [...o.angles], join: o.join ? {...o.join} : null}))};
    return {viewport: {x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height}, gpuViewport: [s.renderer.width, s.renderer.height],
      dpr: devicePixelRatio, rendererDpr: s.renderer.dpr, view: {...s.view}, translationSource: trajectory?.view ? 'trajectory' : config.viewX !== null && config.viewY !== null ? 'configured' : 'target-centered-default-needs-native-match',
      camera: structuredClone(e.evaluatedFrame.camera), renderedFrameCamera: structuredClone(options.frame.camera), rendererCameraEnabled: options.cameraEnabled !== false,
      matrix: cameraMatrix(options), nativeEditingMatrix: [config.scale, 0, 0, config.scale, x, y],
      nativeViewportTransformMatched: cameraMatrix(options).every((value, i) => Math.abs(value - [config.scale, 0, 0, config.scale, x, y][i]) < 1e-7),
      uid: e.selectedUid, joint: e.selectedJoint,
      nativeVertex: g.segments[config.joint].seg.segment_id, startWorld: {...endpoint}, start: convert(endpoint),
      points: worldPoints.map(point => ({...convert(point), tMs: point.tMs, world: {x: point.x, y: point.y}})),
      worldRoundTrip: screenToWorld(worldToScreen(endpoint, options), options), before: __matchedBefore};
  }, {config, trajectory});
}

async function verifyFinal(page) {
  return page.evaluate(async () => {
    const {createRenderer} = await import('/src/renderer.mjs'), {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const e = styk.editor, live = styk.state.renderer, options = {...live.last,
      geometry: e.geometry, preparedPacket: undefined, dragTranslations: undefined};
    await live.device.queue.onSubmittedWorkDone();
    // Capture the final interactive canvas before introducing an independent renderer.
    const actual = live.canvas.toDataURL('image/png'), fresh = buildGeometry(e.report, e.evaluatedFrame);
    const nodes = __matchedPose(e.geometry), freshNodes = __matchedPose(fresh), referenceCanvas = document.createElement('canvas');
    const reference = await createRenderer(referenceCanvas, {resources: live.resources});
    let expected;
    try {
      if (!reference.device) throw new Error('Fresh reference renderer did not use WebGPU.');
      reference.resize(live.width, live.height, live.dpr); await reference.prepareBackgrounds(e.report);
      reference.render({...options, geometry: fresh}); await reference.device.queue.onSubmittedWorkDone();
      expected = referenceCanvas.toDataURL('image/png');
    } finally {reference.destroy();}
    const referenceByNode = new Map(freshNodes.map(n => [`${n.uid}:${n.vertex}`, n]));
    let maxNodeDelta = 0; for (const node of nodes) {const n = referenceByNode.get(`${node.uid}:${node.vertex}`); maxNodeDelta = n ? Math.max(maxNodeDelta, Math.hypot(node.x - n.x, node.y - n.y)) : Infinity;}
    const stateAfter = e.frame.objects.map(o => ({uid: o.unique_id, root_x: o.root_x, root_y: o.root_y, scale: o.scale, angles: [...o.angles], join: o.join ? {...o.join} : null}));
    const oldStates = new Map(__matchedBefore.states.map(o => [o.uid, o]));
    const changed = stateAfter.filter(o => JSON.stringify(o) !== JSON.stringify(oldStates.get(o.uid))).map(o => o.uid);
    const freeRootsMoved = stateAfter.filter(o => !o.join && (o.root_x !== oldStates.get(o.uid).root_x || o.root_y !== oldStates.get(o.uid).root_y)).map(o => o.uid);
    return {actual, expected, pngByteIdentical: actual === expected, maxNodeDelta, nodeCount: nodes.length, referenceNodeCount: freshNodes.length,
      nodes, stateAfter, changedUids: changed, freeRootsMoved, selectedUid: e.selectedUid, selectedJoint: e.selectedJoint,
      sourceFrameChanged: JSON.stringify(e.frame) !== __matchedBefore.frame};
  });
}

async function verifyInitialBatch(page) {
  return page.evaluate(async () => {
    const renderer = styk.state.renderer;
    const options = {...renderer.last, geometry: renderer.lastGeometry, preparedPacket: undefined};
    // The preceding compositor screenshot can consume the current WebGPU
    // texture. Each retained render and immediate readback share one task.
    renderer.render(options);
    const initialRetainedStats = structuredClone(renderer.stats);
    const initial = renderer.canvas.toDataURL('image/png');
    await renderer.device.queue.onSubmittedWorkDone();
    const entries = [...renderer.layout];
    let legacyUploadBytes = 0;
    for (const entry of entries) legacyUploadBytes += renderer.uploadEntry(entry);
    renderer.render(options);
    const legacy = renderer.canvas.toDataURL('image/png');
    await renderer.device.queue.onSubmittedWorkDone();
    return {comparison: 'current retained batched layout versus legacy per-object uploads',
      initial, legacy, legacyUploadCalls: entries.length,
      legacyUploadBytes, initialRetainedStats, retainedRenderPreparation: renderer.stats.preparation,
      limitation: 'Correctness-only legacy uploads occur after import readiness, before the diagnostic gesture; disable this option for formal input timing.'};
  });
}

let activeApp;
try {
  for (let processIndex = 0; processIndex < config.coldProcesses; processIndex++) {
    const processDir = path.join(config.output, `process-${processIndex}`); await mkdir(processDir, {recursive: true});
    activeApp = await electron.launch({args: ['--force-device-scale-factor=1', appRoot], cwd: appRoot, timeout: 60000,
      env: {...process.env, STYK_USER_DATA_DIR: path.join(processDir, 'profile')}});
    const app = activeApp, page = await app.firstWindow(); page.setDefaultTimeout(60000);
    page.on('pageerror', error => report.errors.push({processIndex, message: error.message}));
    await page.waitForFunction(() => window.styk?.ready);
    const runtime = await app.evaluate(async ({BrowserWindow, app}) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1600, 1000); window.show(); window.focus();
      return {versions: process.versions, pid: process.pid, platform: process.platform, arch: process.arch,
        gpuInfo: await app.getGPUInfo('basic'), gpuFeatureStatus: app.getGPUFeatureStatus()};
    });
    assert.equal(runtime.versions.electron, config.expectedElectron, 'Electron runtime must match native/app comparison conditions.');
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.waitForTimeout(150);
      const delta = await page.evaluate(({width, height}) => ({width: width - styk.state.renderer.width, height: height - styk.state.renderer.height}), config);
      if (Math.abs(delta.width) < .01 && Math.abs(delta.height) < .01) break;
      await app.evaluate(({BrowserWindow}, delta) => {const w = BrowserWindow.getAllWindows()[0], [width, height] = w.getContentSize(); w.setContentSize(Math.round(width + delta.width), Math.round(height + delta.height));}, delta);
    }
    const importView = trajectory?.view ? {...trajectory.view, scale: config.scale} : config.viewX !== null && config.viewY !== null
      ? {x: config.viewX, y: config.viewY, scale: config.scale} : null;
    await page.waitForTimeout(150); const rendererInfo = await page.evaluate(installProbe, {frameIndex: config.frameIndex, importView});
    const backendHealth = await page.evaluate(async () => (await fetch('/api/health')).json());
    if (config.expectedScanner) assert.equal(backendHealth.nativeFrameScanner, config.expectedScanner, 'Actual desktop backend selected an unexpected native-frame scanner.');
    if (config.expectedScanner === 'cpp') {
      assert.equal(backendHealth.nativeFrameScannerInfo?.abi, 1);
      assert.ok(Object.entries(sourceCodeHashesBefore).some(([file, digest]) => /\.(dll|so|dylib)$/.test(file)
        && digest === backendHealth.nativeFrameScannerInfo.sha256), 'Actual loaded scanner binary does not match the frozen runtime hash inventory.');
    }
    report.processes.push({processIndex, runtime, rendererInfo, backendHealth, freshProfile: path.join(processDir, 'profile'), backendOrigin: new URL(page.url()).origin});
    for (let importIndex = 0; importIndex <= config.warmImports; importIndex++) {
      const id = `p${processIndex}-${importIndex === 0 ? 'cold' : `warm${importIndex}`}`;
      const trial = {id, processIndex, importIndex, condition: importIndex === 0 ? 'fresh-Electron-and-backend-process-OS-cache-uncontrolled' : 'same-Electron-and-backend-process-same-source-cache',
        workersRetainedFromPreviousImport: importIndex > 0}; report.trials.push(trial);
      const client = config.trace || config.profileImport ? await app.context().newCDPSession(page) : null;
      let traceRunning = false, profileRunning = false;
      try {
        if (config.trace) {await startTrace(client); traceRunning = true;}
        if (config.profileImport) {
          await client.send('Profiler.enable'); await client.send('Profiler.start'); profileRunning = true;
          trial.importProfileStartedAt = await page.evaluate(() => performance.now());
        }
        await page.evaluate(id => {
          const b = __matchedInput; b.trial = id; b.measuring = false; b.currentInput = null; b.lastMutation = null;
          b.imports.push({id, armedAt: performance.now()}); styk.editor.markSaved(); clearTimeout(styk.state.recoveryTimer);
          document.getElementById('file-input').value = '';
        }, id);
        await page.locator('#file-input').setInputFiles(config.source);
        await page.waitForFunction(id => {
          if (__matchedInput.fatalError) throw new Error(__matchedInput.fatalError);
          const row = __matchedInput.imports.find(r => r.id === id);
          return row?.editableObservedAt && row.firstSubmit?.queueCallbackAt && styk.editor.report.keyframes.length === 1479;
        }, id, {timeout: 180000});
        trial.import = await page.evaluate(id => {
          const row = __matchedInput.imports.find(r => r.id === id); return {...row, backend: {...styk.state.lastImport}, timeOrigin: performance.timeOrigin,
            importEventToLoadReturnMs: row.loadEnd - row.eventAt, importEventToEditableStateMs: row.editableObservedAt - row.eventAt,
            importEventToFirstSubmitMs: row.firstSubmit.end - row.eventAt, importEventToFirstQueueCallbackMs: row.firstSubmit.queueCallbackAt - row.eventAt};
        }, id);
        assert.equal(trial.import.backend.cache_hit, importIndex > 0, `Unexpected backend cache condition for ${id}`);
        assert.ok(trial.import.firstSubmit.start >= trial.import.loadEnd, 'First target submission preceded load completion; update target-report recognition for the publication order.');
        await page.waitForFunction(id => {
          if (__matchedInput.fatalError) throw new Error(__matchedInput.fatalError);
          return __matchedInput.imports.find(row => row.id === id)?.matchedLastFrameFirstSubmit?.queueCallbackAt;
        }, id);
        Object.assign(trial.import, await page.evaluate(id => {
          const row = __matchedInput.imports.find(value => value.id === id);
          return {matchedLastFrameSeekAt: row.matchedLastFrameSeekAt, matchedLastFrameSeekRequired: row.matchedLastFrameSeekRequired,
            matchedLastFrameRequestedAt: row.matchedLastFrameRequestedAt, matchedLastFrameFirstSubmit: row.matchedLastFrameFirstSubmit};
        }, id));
        trial.import.importToMatchedLastFrameReadyMs = trial.import.matchedLastFrameFirstSubmit.queueCallbackAt - trial.import.eventAt;
        trial.import.loadCallWallMs = trial.import.loadEnd - trial.import.loadStart;
        if (importView) {
          const submitted = trial.import.matchedLastFrameFirstSubmit;
          assert.deepEqual(submitted.viewport, [config.width, config.height]); assert.equal(submitted.dpr, config.dpr);
          const expected = [config.scale, 0, 0, config.scale, importView.x, importView.y];
          assert.ok(submitted.matrix.every((value, index) => Math.abs(value - expected[index]) < 1e-6), 'Initial matched-frame effective transform differs from native.');
          trial.import.nativeViewportTransformMatched = true;
        }
        trial.import.initialFrameIndex = trial.import.frameIndexAtReady;
        trial.import.screenshotFrameIndex = config.frameIndex;
        if (profileRunning) {
          const {profile} = await client.send('Profiler.stop'); profileRunning = false;
          trial.importProfileStoppedAt = await page.evaluate(() => performance.now());
          trial.importProfilePath = path.join(processDir, `${id}-import.cpuprofile.json`);
          await writeFile(trial.importProfilePath, JSON.stringify(profile));
        }
        trial.import.screenshotRequestAt = await page.evaluate(() => performance.now());
        await page.locator('#scene').screenshot({path: path.join(processDir, `${id}-matched-last-frame-visible-observed.png`)});
        trial.import.screenshotReturnedAt = await page.evaluate(() => performance.now());
        if (config.verifyInitialBatch) {
          const proof = await verifyInitialBatch(page);
          proof.pngByteIdentical = proof.initial === proof.legacy;
          for (const key of ['initial', 'legacy']) {
            await writeFile(path.join(processDir, `${id}-batch-${key}.png`), Buffer.from(proof[key].split(',')[1], 'base64'));
            delete proof[key];
          }
          trial.initialBatchCorrectness = proof;
          assert.equal(proof.initialRetainedStats.preparation, 'retained');
          assert.equal(proof.initialRetainedStats.uploadBytes, 0, 'Baseline redraw replaced batched primitive contents before comparison.');
          assert.equal(proof.pngByteIdentical, true, 'Current retained batched layout differs from legacy per-object GPU upload.');
          assert.equal(proof.retainedRenderPreparation, 'retained');
        }
        trial.target = await configureTarget(page);
        assert.deepEqual(trial.target.gpuViewport, [config.width, config.height]); assert.equal(trial.target.dpr, 1); assert.equal(trial.target.rendererDpr, 1);
        assert.equal(trial.target.uid, config.uid); assert.equal(trial.target.joint, config.joint); assert.equal(trial.target.nativeVertex, 1);
        for (const p of [trial.target.start, ...trial.target.points]) assert.ok(p.x >= trial.target.viewport.x && p.y >= trial.target.viewport.y && p.x < trial.target.viewport.x + config.width && p.y < trial.target.viewport.y + config.height, 'Trajectory falls outside matched viewport.');
        await page.keyboard.press('v'); await page.mouse.move(trial.target.start.x, trial.target.start.y);
        await page.evaluate(() => {__matchedInput.measuring = true; __matchedInput.currentInput = null; __matchedInput.lastMutation = null;});
        await page.mouse.down();
        trial.pointerDown = await page.evaluate(() => ({at: performance.now(), route: styk.state.drag?.kind, selectedUid: styk.editor.selectedUid,
          selectedJoint: styk.editor.selectedJoint, input: __matchedInput.events.at(-1)}));
        trial.import.targetPointerAcceptanceObservedAt = trial.pointerDown.at;
        trial.import.targetPointerAcceptanceLimitation = 'Confirms real editability after first-visible screenshot and last-keyframe/view setup; this later observation is not the minimum import-to-editable latency.';
        assert.equal(trial.pointerDown.route, 'pose'); assert.equal(trial.pointerDown.selectedUid, config.uid); assert.equal(trial.pointerDown.selectedJoint, config.joint);
        trial.hostDispatch = [];
        const hostStart = performance.now();
        for (const point of trial.target.points) {
          const wait = point.tMs - (performance.now() - hostStart); if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
          const start = performance.now(); await page.mouse.move(point.x, point.y);
          trial.hostDispatch.push({targetAtMs: point.tMs, actualStartMs: start - hostStart, callReturnedMs: performance.now() - hostStart});
        }
        await page.mouse.up();
        await page.waitForFunction(id => {const b = __matchedInput, mutation = b.mutations.filter(m => m.trial === id).at(-1); return mutation && b.submits.some(s => s.trial === id && s.inputId === mutation.inputId && s.queueCallbackAt);}, id);
        await page.evaluate(async () => {await Promise.all(__matchedInput.pending); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));});
        trial.measurements = await page.evaluate(id => {
          const b = __matchedInput; b.measuring = false;
          return {events: b.events.filter(r => r.trial === id), mutations: b.mutations.filter(r => r.trial === id),
            submits: b.submits.filter(r => r.trial === id), renders: b.renders.filter(r => r.trial === id),
            longTasks: b.longTasks.filter(r => r.trial === id), endedAt: performance.now()};
        }, id);
        trial.import.longTasks = trial.measurements.longTasks.filter(task => task.at < trial.import.matchedLastFrameFirstSubmit.queueCallbackAt
          && task.at + task.duration > trial.import.eventAt);
        trial.import.longTaskDurationMs = quantiles(trial.import.longTasks.map(task => task.duration));
        const mutations = trial.measurements.mutations, seenInputs = new Set();
        const frames = trial.measurements.submits.filter(s => {
          if (!s.inputId || seenInputs.has(s.inputId)) return false;
          seenInputs.add(s.inputId); return true;
        });
        const represented = new Set(frames.map(s => s.inputId));
        trial.summary = {trustedPointerEvents: trial.measurements.events.every(e => e.isTrusted), mutationCount: mutations.length,
          renderedInputCount: represented.size, coalescedMutationInputIds: mutations.filter(m => !represented.has(m.inputId)).map(m => m.inputId),
          inputToMutationMs: quantiles(mutations.map(m => m.end - m.eventAt)),
          inputToSubmitMs: quantiles(frames.map(s => s.end - s.eventAt)),
          inputToQueueCallbackMs: quantiles(frames.map(s => s.queueCallbackAt - s.eventAt)),
          mutationCpuMs: quantiles(mutations.map(m => m.end - m.start)),
          inputToCaptureMs: quantiles(trial.measurements.events.filter(e => e.type === 'pointermove').map(e => e.captureAt - e.eventAt)),
          nativeViewportTransformMatched: trial.target.nativeViewportTransformMatched,
          comparisonStatus: trial.target.nativeViewportTransformMatched && trial.target.translationSource !== 'target-centered-default-needs-native-match'
            ? 'effective-transform-matched-pending-native-trajectory-and-pose-comparison' : 'world-pose-comparable-viewport-transform-or-translation-not-yet-matched'};
        if (traceRunning) {trial.chromiumFeedback = await stopTrace(client, path.join(processDir, `${id}-chrome-trace.json`), frames); traceRunning = false;}
        trial.correctness = await verifyFinal(page);
        for (const key of ['actual', 'expected']) {await writeFile(path.join(processDir, `${id}-${key}.png`), Buffer.from(trial.correctness[key].split(',')[1], 'base64')); delete trial.correctness[key];}
        await page.locator('#viewport').screenshot({path: path.join(processDir, `${id}-viewport-with-handles.png`)});
        await writeFile(path.join(processDir, `${id}-pose-evidence.json`), JSON.stringify({frameIndex: config.frameIndex, sourceSha256: sourceHashBefore,
          before: trial.target.before, afterNodes: trial.correctness.nodes, afterStates: trial.correctness.stateAfter,
          worldTrajectory: trial.target.points.map(p => ({...p.world, tMs: p.tMs})), matrix: trial.target.matrix, view: trial.target.view, camera: trial.target.camera}, null, 2));
        delete trial.target.before; delete trial.correctness.nodes; delete trial.correctness.stateAfter;
        assert.ok(trial.summary.trustedPointerEvents && mutations.length > 0 && frames.length > 0);
        assert.ok(trial.correctness.sourceFrameChanged, 'Actual pointer input did not change the scene.');
        assert.equal(trial.correctness.pngByteIdentical, true, 'Final interactive canvas differs from independent fresh full-geometry render.');
        assert.ok(trial.correctness.maxNodeDelta < 1e-5 && trial.correctness.nodeCount === trial.correctness.referenceNodeCount);
        assert.deepEqual(trial.correctness.freeRootsMoved, [], 'Joined-parent pose translated a free origin.');
        trial.status = 'complete'; await saveReport(); console.log(JSON.stringify({id, import: trial.import, summary: trial.summary, correctness: trial.correctness}));
        await page.evaluate(() => {styk.editor.markSaved(); clearTimeout(styk.state.recoveryTimer);});
      } catch (error) {
        trial.status = 'failed'; trial.failure = error.stack || String(error);
        try {
          trial.failureProbe = await page.evaluate(id => {
            const probe = window.__matchedInput, app = window.styk;
            return {at: performance.now(), fatalError: probe?.fatalError || null,
              importing: app?.state.importing, playing: app?.state.playing,
              frameIndex: app?.editor.frameIndex, frameCount: app?.editor.report?.keyframes?.length,
              import: probe?.imports.find(row => row.id === id),
              backend: app?.state.lastImport ? {...app.state.lastImport} : null,
              submits: probe?.submits.filter(row => row.trial === id).slice(-96),
              renders: probe?.renders.filter(row => row.trial === id).slice(-96),
              longTasks: probe?.longTasks.filter(row => row.trial === id)};
          }, id);
        } catch (snapshotError) {trial.failureProbeError = snapshotError.message;}
        await saveReport(); throw error;
      } finally {
        if (profileRunning) {try {const {profile} = await client.send('Profiler.stop'); await writeFile(path.join(processDir, `${id}-partial-import.cpuprofile.json`), JSON.stringify(profile));} catch {}}
        if (traceRunning) {try {await stopTrace(client, path.join(processDir, `${id}-partial-chrome-trace.json`), []);} catch (error) {report.errors.push({id, traceCleanup: error.message});}}
        await client?.detach();
      }
    }
    await app.close(); activeApp = null;
  }
  report.importSummary = Object.fromEntries(['cold', 'warm'].map(condition => {
    const rows = report.trials.filter(t => (t.importIndex === 0 ? 'cold' : 'warm') === condition);
    return [condition, {trials: rows.length, metrics: Object.fromEntries(['importEventToLoadReturnMs', 'importEventToEditableStateMs',
      'importEventToFirstSubmitMs', 'importEventToFirstQueueCallbackMs', 'importToMatchedLastFrameReadyMs', 'loadCallWallMs', 'loadImmediateReturnMs'].map(key => [key, quantiles(rows.map(t => t.import[key]))])),
      backendStages: Object.fromEntries(['decode_ms', 'total_ms', 'worker_fetch_ms', 'worker_parse_ms', 'worker_transfer_ms',
        'native_materialize_ms', 'native_materialize_max_task_ms', 'native_materialize_tasks', 'wire_bytes', 'document_bytes', 'document_chunks']
        .map(key => [key, quantiles(rows.map(t => t.import.backend[key]))])),
      transports: [...new Set(rows.map(t => t.import.backend.transport ?? 'unreported'))],
      percentileLimitation: 'Only three trials per default condition; tail estimates are descriptive, not stable population estimates.'}];
  }));
  assert.deepEqual(report.errors, [], 'Browser/runtime errors occurred.'); report.status = 'complete';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack; throw error;
} finally {
  if (activeApp) {try {const page = await activeApp.firstWindow(); await page.evaluate(() => {styk.editor.markSaved(); clearTimeout(styk.state.recoveryTimer);});} catch {} await activeApp.close();}
  report.sourceHashAfter = hash(await readFile(config.source)); report.sourceUnchanged = report.sourceHashAfter === sourceHashBefore;
  report.sourceCodeHashesAfter = await codeHashes();
  report.changedCodeFiles = [...new Set([...Object.keys(sourceCodeHashesBefore), ...Object.keys(report.sourceCodeHashesAfter)])]
    .filter(file => report.sourceCodeHashesAfter[file] !== sourceCodeHashesBefore[file]).sort();
  report.sourceCodeStable = report.changedCodeFiles.length === 0;
  if (!report.sourceCodeStable) {report.status = 'diagnostic-source-changed'; report.errors.push({message: 'Runtime files changed during benchmark; this run cannot establish stable-build performance.', files: report.changedCodeFiles});}
  if (!report.sourceUnchanged) {report.status = 'failed'; report.errors.push({message: 'Source file hash changed during benchmark.'});}
  report.completedAt = new Date().toISOString(); await saveReport();
}
