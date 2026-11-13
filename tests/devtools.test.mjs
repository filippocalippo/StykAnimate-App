// The developer tools' pure parts (docs/DEVTOOLS.md): the span ring's reads, summaries and Perfetto export, the frame
// recorder's reads, the engine boundary meter, the log filter, the shipping check, and the instrumentation layer doing
// nothing without the developer build.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {meterBoundary} from '../src/devtools/boundary.mjs';
import {analyze, Capture, perfettoTrace, preparationSince, recentEvents, ringEvents, summarize} from '../src/devtools/capture.mjs';
import {filterLogs} from '../src/devtools/control.mjs';
import {frameBounds, frameCountAt, frameSeries, frameWindow, inputWindow, summarizeFrames} from '../src/devtools/frames.mjs';
import {grade, GRADES, judgeCapture, LIMITS} from '../src/devtools/grades.mjs';
import {elementName, unchangedWrites} from '../src/devtools/mutations.mjs';
import {steadyOrder} from '../src/devtools/panels/rank.mjs';
import {Sampler} from '../src/devtools/sampler.mjs';
import * as perfMetrics from '../perf/lib/metrics.mjs';
import {distribution, median, quantile, spread} from '../src/devtools/stats.mjs';
import {treePage, preview} from '../src/devtools/inspector.mjs';
import {MARKERS, isDeveloperPath, scanBinary, scanCapabilities, scanWeb} from '../scripts/check-devtools-shipping.mjs';
import {selectFiles} from '../scripts/build-web.mjs';

/** A ring shaped as src/devtools/early.js makes it. */
function ring(capacity) {
  return {capacity, head: 0, total: 0, start: new Float64Array(capacity), duration: new Float64Array(capacity), value: new Float64Array(capacity),
    name: new Uint16Array(capacity), thread: new Uint8Array(capacity), depth: new Uint8Array(capacity), args: new Array(capacity).fill(null), names: [], ids: new Map(), threads: ['interface', 'display']};
}
function push(r, name, start, duration, {thread = 0, depth = 0, value = 0, args = null} = {}) {
  let id = r.ids.get(name);
  if (id === undefined) { id = r.names.push(name) - 1; r.ids.set(name, id); }
  const at = r.head;
  Object.assign(r, {head: (at + 1) % r.capacity, total: r.total + 1});
  r.start[at] = start; r.duration[at] = duration; r.value[at] = value; r.name[at] = id; r.thread[at] = thread; r.depth[at] = depth; r.args[at] = args;
}

test('the ring reads oldest first and counts what it overwrote', () => {
  const r = ring(4);
  for (let i = 0; i < 6; i++) push(r, `s${i}`, i, 1);
  const {events, dropped} = ringEvents(r, 0);
  assert.deepEqual(events.map(event => event.name), ['s2', 's3', 's4', 's5']);
  assert.equal(dropped, 2);
  assert.deepEqual(ringEvents(r, 5).events.map(event => event.name), ['s5']);
});

test('a look at the last seconds reads the ring from its newest event back and stops once events ended well before', () => {
  const r = ring(256);
  for (let i = 0; i < 50; i++) push(r, 'old', i, 1);
  push(r, 'a', 5000, 2);
  // An event reported after it ended (a long task, by the browser's observer) does not end the walk on its own.
  push(r, 'reported late', 100, 50, {thread: 1});
  push(r, 'counter', 5050, -2, {value: 4});
  push(r, 'c', 5100, 1);
  assert.deepEqual(recentEvents(r, 4000).map(event => event.name), ['a', 'counter', 'c']);
  assert.deepEqual(recentEvents(r, 4000, 5060).map(event => event.name), ['a', 'counter']);
  // Events come in the ring's order, the order they were recorded in.
  assert.deepEqual(recentEvents(r, 0).map(event => event.name).filter(name => name !== 'old'), ['a', 'reported late', 'counter', 'c']);
});

test('a capture takes only what was recorded while it ran', () => {
  const r = ring(16), capture = new Capture(r);
  push(r, 'before', 0, 1);
  capture.start('x');
  assert.throws(() => capture.start('again'), /already running/);
  push(r, 'during', 1, 2);
  const taken = capture.stop();
  assert.deepEqual(taken.events.map(event => event.name), ['during']);
  assert.throws(() => capture.stop(), /No capture/);
});

/**
 * A frame recorder shaped as src/devtools/early.js makes it. `add` records one frame of [interval, handlers, script,
 * render] after the last one (the first begins at time 100).
 */
function recorder(rows = [], capacity = 8) {
  const frames = {intervals: new Float32Array(capacity), at: new Float64Array(capacity), handlers: new Float32Array(capacity), script: new Float32Array(capacity), render: new Float32Array(capacity),
    head: 0, total: 0, watching: 1, inputs: {latency: new Float32Array(4), at: new Float64Array(4), head: 0, total: 0}};
  let at = 100;
  frames.add = ([interval, handlers, script, render]) => {
    at += interval;
    const slot = frames.head;
    frames.intervals[slot] = interval; frames.at[slot] = at; frames.handlers[slot] = handlers; frames.script[slot] = script; frames.render[slot] = render;
    frames.head = (slot + 1) % capacity; frames.total++;
  };
  rows.forEach(frames.add);
  return frames;
}

test('summaries group spans (edit calls by method, interface updates by surface), name their thread and keep counters; display frames are not spans to rank', () => {
  const r = ring(64);
  for (const ms of [10, 12, 40, 16]) push(r, 'display frame', 0, ms, {thread: 1});
  push(r, 'interface update', 0, 2, {args: {surface: 'inspector'}});
  push(r, 'edit session call', 1, 3, {args: {method: 'poseJoint'}});
  push(r, 'edit session call', 2, 5, {args: {method: 'poseJoint'}});
  push(r, 'edit session call', 3, 1, {args: {method: 'beginDrag'}});
  push(r, 'queue', 4, -2, {value: 3});
  push(r, 'queue', 5, -2, {value: 1});
  push(r, 'opened', 6, -1);
  const summary = summarize(ringEvents(r).events);
  assert.equal(summary.frames, undefined);
  assert.ok(!summary.spans.some(row => row.name === 'display frame'));
  const pose = summary.spans.find(row => row.name === 'edit session call poseJoint');
  assert.deepEqual([pose.count, pose.totalMs, pose.worst, pose.thread], [2, 8, 5, 'interface']);
  assert.equal(summary.spans.find(row => row.name === 'interface update inspector').count, 1);
  assert.deepEqual(summary.counters.queue, {last: 1, min: 1, max: 3, samples: 2});
  assert.equal(summary.instants.opened, 1);
  assert.equal(summary.slowest[0].name, 'edit session call poseJoint');
  // The slowest spans of many are the same ten a full sort gives, ties in the order they were recorded.
  const many = ring(512), durations = Array.from({length: 400}, (_, index) => (index * 37) % 101 / 10);
  durations.forEach((ms, index) => push(many, `s${index}`, index, ms));
  const expected = durations.map((ms, index) => ({name: `s${index}`, ms})).sort((x, y) => y.ms - x.ms).slice(0, 10).map(row => row.name);
  assert.deepEqual(summarize(ringEvents(many).events).slowest.map(row => row.name), expected);
});

test('one percentile everywhere: nearest rank, a median that averages the middle pair, and a spread one stray run does not move', () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  assert.deepEqual([quantile(list, .5), quantile(list, .95), quantile(list, 1), quantile([], .5)], [5, 100, 100, null]);
  assert.deepEqual([median([4, 1, 3, 2]), median([3, 1, 2]), median([NaN])], [2.5, 2, null]);
  assert.deepEqual(distribution([10, 20, NaN, 30]), {count: 3, mean: 20, p50: 20, p95: 30, p99: 30, worst: 30});
  assert.deepEqual(spread([10, 11, 12, 500]), {n: 4, median: 11.5, mad: 1, min: 10, max: 500});
});

test('frames are read by window, oldest first, and the newest one waits until its rendering was measured', () => {
  const frames = recorder([[7, 0, 1, 1], [7, 1, 2, 1], [30, 20, 5, 2], [7, 0, 1, 0]]);
  const settled = frameWindow(frames, 0);
  assert.deepEqual([settled.interval, settled.handlers, settled.dropped], [[7, 7, 30], [0, 1, 20], 0]);
  assert.deepEqual(frameWindow(frames, 0, {settled: false}).interval, [7, 7, 30, 7]);
  assert.deepEqual(frameWindow(frames, 2).interval, [30]);
  // The frames began at 107, 114, 144 and 151: a window from time 120 starts at the third.
  assert.equal(frameCountAt(frames, 120), 2);
  // A ring that wrapped says how many frames it no longer holds.
  const kept = frameWindow(recorder(Array.from({length: 12}, (_, index) => [index + 1, 0, 0, 0])), 0);
  assert.deepEqual([kept.dropped, kept.interval[0], kept.interval.length], [4, 5, 7]);
});

test('a frame summary judges frames against the display period and says what the interface thread spent, by phase', () => {
  const window = frameWindow(recorder([[7, 0, 1, 1], [7, 1, 2, 1], [30, 20, 5, 2], [7, 0, 2, 0], [7, 0, 0, 0]]), 0);
  const summary = summarizeFrames(window, {periodMs: 7, seconds: .051});
  assert.deepEqual([summary.count, summary.late, summary.lateShare, summary.over16, summary.over33, summary.worst, summary.lateOverMs], [4, 1, .25, 1, 0, 30, 10.5]);
  // Work per frame: 2, 4, 27 and 2 ms; handlers took 21 of those 35 ms.
  assert.deepEqual([summary.work.worst, summary.work.p50, summary.phases.handlers.worst, summary.phases.script.mean, summary.phases.handlers.share], [27, 2, 20, 2.5, .6]);
  // Without a measured period the frames' own median is the period.
  assert.equal(summarizeFrames(frameWindow(recorder(Array.from({length: 10}, () => [8, 0, 0, 0]), 16), 0)).periodMs, 8);
  // A chart series keeps the worst frame of each bucket.
  assert.deepEqual(frameSeries(window, 2).interval, [7, 30]);
});

test('a chart series ends at the newest frame, says which frame each column shows, and a frame\'s work spans from the frame before to its rendering', () => {
  const window = frameWindow(recorder([[7, 0, 1, 1], [30, 2, 3, 1], [7, 0, 1, 0], [7, 1, 1, 0], [9, 0, 1, 1], [7, 0, 0, 0]]), 0);
  // Five settled frames in columns of two: the oldest column holds the one frame left over.
  assert.deepEqual(frameSeries(window, 3, {indices: true}), {bucket: 2, interval: [7, 30, 9], handlers: [0, 2, 0], script: [1, 3, 1], render: [1, 1, 1], index: [0, 1, 4]});
  assert.equal(frameSeries(window, 3).index, undefined, 'a stored series carries no indices unless asked');
  // The second frame began at 137 after 30 ms on screen, and its script and rendering took 4 ms after it.
  assert.deepEqual(frameBounds(window, 1), {from: 107, to: 141});
});

test('a capture takes its frames, its inputs and the calls into the engine, and analyze turns them into one summary', () => {
  const r = ring(16), frames = recorder([[7, 0, 1, 1]]);
  const calls = [{name: 'Stage.draw', calls: 3, totalMs: 1.23456, worstMs: .9}];
  let counters = {prepared: 40, totalMs: 400, inline: 1};
  const capture = new Capture(r, {frames, boundary: {reset() { calls[0].calls = 0; }, rows: () => calls}, preparation: () => counters});
  capture.start('drag');
  assert.equal(calls[0].calls, 0, 'the meter starts afresh with the capture');
  // Three frames and two inputs arrive while it runs.
  for (const row of [[7, 1, 2, 1], [9, 0, 3, 1], [7, 0, 0, 0]]) frames.add(row);
  for (const ms of [12, 20]) { frames.inputs.latency[frames.inputs.head++] = ms; frames.inputs.total++; }
  push(r, 'paint', 1, 2);
  counters = {prepared: 50, totalMs: 430, inline: 3};
  const taken = capture.stop();
  assert.deepEqual([taken.frames.interval, inputWindow(frames, 0).latency], [[7, 9], [12, 20]]);
  const summary = analyze(taken, {periodMs: 7});
  assert.deepEqual([summary.frames.count, summary.inputs.count, summary.inputs.worst, summary.spans[0].name], [2, 2, 20, 'paint']);
  assert.deepEqual(summary.boundary, [{name: 'Stage.draw', calls: 0, totalMs: 1.235, worstMs: .9}]);
  // What the engine's threads prepared while it ran: the same summary the control channel and the panel report.
  assert.deepEqual(summary.preparation, {frames: 10, msPerFrame: 3, inline: 2});
});

test('the engine boundary meter counts every call of the generated classes while something watches, by method name for session calls, and costs nothing otherwise', () => {
  class EditSession { call(method) { return `ran ${method}`; } query() { return 1; } free() {} static from_document() { return new EditSession(); } get revision() { return 7; } }
  const early = {frames: {watching: 0}}, spans = [];
  const meter = meterBoundary({EditSession}, early, {nested: name => spans.push(name)});
  const session = EditSession.from_document();
  assert.equal(session.call('poseJoint'), 'ran poseJoint');
  assert.deepEqual(meter.rows(), [], 'nothing is counted while nothing watches');
  early.frames.watching = 1;
  session.call('poseJoint'); session.call('poseJoint'); session.call('commitDrag'); session.query(); session.free();
  EditSession.from_document();
  // The tools' own reads of the engine are not the app's calls.
  meter.unmetered(() => session.query());
  assert.equal(session.revision, 7);
  assert.deepEqual(Object.fromEntries(meter.rows().map(row => [row.name, row.calls])),
    {'EditSession.call(poseJoint)': 2, 'EditSession.call(commitDrag)': 1, 'EditSession.query': 1, 'EditSession.from_document': 1});
  assert.deepEqual(spans, [], 'calls shorter than a quarter of a millisecond leave no span');
  // The live window holds the same calls, by half second, and a capture's reset leaves it alone.
  const now = performance.now();
  assert.deepEqual(Object.fromEntries(meter.recent(2000, now).map(row => [row.name, row.calls])), Object.fromEntries(meter.rows().map(row => [row.name, row.calls])));
  meter.reset();
  assert.deepEqual(meter.rows(), []);
  assert.equal(meter.recent(2000, now).length, 4);
  assert.deepEqual(meter.recent(2000, now + 20000), [], 'calls older than the window are not in it');
  assert.doesNotThrow(() => meterBoundary(undefined, early, {}), 'a page whose engine is not loaded has no boundary to meter');
});

test('what the engine prepared between two reads survives its counters starting afresh for a new document', () => {
  assert.deepEqual(preparationSince({prepared: 10, totalMs: 100, inline: 1}, {prepared: 14, totalMs: 120, inline: 1}), {frames: 4, msPerFrame: 5, inline: 0});
  assert.deepEqual(preparationSince({prepared: 90, totalMs: 900, inline: 4}, {prepared: 3, totalMs: 6, inline: 0}), {frames: 3, msPerFrame: 2, inline: 0});
  assert.equal(preparationSince(null, {prepared: 1, totalMs: 1, inline: 0}), null);
});

test('an interface write is named by its element, and a write that put back the value already there is told apart', () => {
  const panel = {nodeType: 1, id: 'timeline', localName: 'div', className: '', parentElement: null};
  const playhead = {nodeType: 1, id: '', localName: 'div', className: 'sheet-playhead  active extra', parentElement: {nodeType: 1, id: '', localName: 'div', className: '', parentElement: panel}};
  assert.deepEqual([elementName(panel), elementName(playhead), elementName({nodeType: 1, id: '', localName: 'span', className: '', parentElement: null}), elementName({nodeType: 3})],
    ['#timeline', '#timeline div.sheet-playhead.active', 'span', '(text)']);
  // Three writes to one attribute, in order: a → b, b → b (nothing changed), b → c (the value it holds now); and a text put back as it was.
  const element = {getAttribute: () => 'c'}, text = {data: 'same'};
  const records = [{type: 'attributes', target: element, attributeName: 'style', oldValue: 'a'}, {type: 'attributes', target: element, attributeName: 'style', oldValue: 'b'},
    {type: 'attributes', target: element, attributeName: 'style', oldValue: 'b'}, {type: 'characterData', target: text, oldValue: 'same'}, {type: 'childList', target: element}];
  assert.deepEqual(unchangedWrites(records), [false, true, false, true, false]);
});

test('one grading for the panel and the runner: four grades from fixed limits, and a recorded gesture is as good as the worse of its frames and its input delay', () => {
  assert.equal(perfMetrics.grade, grade, 'perf/lib/metrics.mjs grades with the developer tools\' copy');
  assert.equal(perfMetrics.LIMITS, LIMITS);
  assert.deepEqual([grade(16, LIMITS.frame), grade(30, LIMITS.frame), grade(99, LIMITS.frame), grade(101, LIMITS.frame), grade(NaN, LIMITS.frame)], [...GRADES, null]);
  assert.equal(grade(50, [60, 30, 10], 'higher'), 'fair');
  const judged = judgeCapture({frames: {felt: 12}, inputs: {count: 5, p95: 80}});
  assert.deepEqual([judged.grade, judged.decided, judged.value, judged.criteria.map(row => row.grade)], ['poor', 'input.p95', 80, ['good', 'poor']]);
  assert.deepEqual([judgeCapture({frames: {felt: 25}, inputs: {count: 0, p95: null}}).grade, judgeCapture({frames: null, inputs: null}).grade], ['fair', null]);
});

test('a live list keeps its order while values move, until a row clearly passes the one above it', () => {
  let state = steadyOrder([], [{key: 'paint', value: 10}, {key: 'update', value: 9}, {key: 'drag', value: 3}]);
  assert.deepEqual(state.order, ['paint', 'update', 'drag']);
  // A small overtake keeps the order; a clear one (beyond a quarter) climbs; a row at zero leaves; a new row enters by weight.
  state = steadyOrder(state.order, [{key: 'paint', value: 10}, {key: 'update', value: 11}, {key: 'drag', value: 3}]);
  assert.deepEqual(state.order, ['paint', 'update', 'drag']);
  state = steadyOrder(state.order, [{key: 'paint', value: 10}, {key: 'update', value: 9}, {key: 'drag', value: 30}, {key: 'wheel', value: 5}]);
  assert.deepEqual(state.order, ['drag', 'paint', 'update', 'wheel']);
  state = steadyOrder(state.order, [{key: 'paint', value: 10}, {key: 'drag', value: 0}, {key: 'wheel', value: 5}], {limit: 1});
  assert.deepEqual([state.order, state.rows.map(row => row.key)], [['paint', 'wheel'], ['paint']]);
});

test('the sampler writes its counters and keeps the same numbers as a short history, from one read of the engine', () => {
  let stats = {prepared: 10, totalMs: 50, worstMs: 9, inline: 1, cached: 4, cachedBytes: 2097152, imagesPending: 2, busy: false}, reads = 0;
  const engine = {threaded: true, workers: 3, memoryBytes: 64 * 1048576, memory: () => ({liveBytes: 10 * 1048576, heapBytes: 64 * 1048576, peakBytes: 0, frameCacheBytes: 0}),
    handle: {stats: () => { reads++; return JSON.stringify(stats); }, workers_lost: () => 0, generation: () => 1}};
  const early = {frames: recorder(), workers: {rows: [], sequence: 0}, browser: {longTasks: 0, longTaskMs: 0, slowInputs: 0, worstInputMs: 0}};
  // The stage's own GPU figure leaves its render targets and sprite pages out; the total adds them.
  const sampler = new Sampler({app: {state: {renderer: {stats: {gpuBytes: 5 * 1048576, engine: {targetBytes: 3 * 1048576, spriteBytes: 1048576}}}}}, early, engine});
  const counters = [];
  sampler.sample({counter: (name, value) => counters.push([name, value])});
  stats = {...stats, prepared: 30, totalMs: 90, inline: 2};
  sampler.sample(null);
  assert.equal(reads, 2, 'one read of the engine\'s statistics per sample');
  assert.deepEqual(Object.fromEntries(counters.filter(([name]) => name.startsWith('memory'))), {'memory jsHeap MB': NaN, 'memory engine live MB': 10, 'memory engine heap MB': 64, 'memory gpu MB': 5, 'memory gpu total MB': 9});
  const series = sampler.series(60000, ['engineLiveBytes', 'prepared']);
  assert.deepEqual([series.at.length, series.engineLiveBytes[0], series.prepared], [2, 10 * 1048576, [10, 30]]);
  const rate = sampler.preparationRate(60000);
  assert.deepEqual([rate.frames, rate.msPerFrame, rate.inline], [20, 2, 1]);
  assert.equal(sampler.last.jobs.engine.cachedFrames, 4);
});

test('the environment a profiling run asks for reaches the page only as the three keys it may set', () => {
  const {profilingEnvironment} = createRequire(import.meta.url)('../desktop/devtools.cjs');
  assert.deepEqual(profilingEnvironment(JSON.stringify({deviceMemoryGiB: 4, hardwareConcurrency: 4, parameters: {'engine.workers': 2, 'bad name!': 1, nested: {}}, other: 'dropped'})),
    {deviceMemoryGiB: 4, hardwareConcurrency: 4, parameters: {'engine.workers': 2}});
  for (const text of [undefined, '', 'not json', '[]', '{}', '{"deviceMemoryGiB": -1}']) assert.equal(profilingEnvironment(text), null);
});

test('a dialog answer given over the control channel answers one dialog of its kind, and an unanswered dialog is cancelled only when asked', async () => {
  const {createDialogAnswers, answerDialogs} = createRequire(import.meta.url)('../desktop/devtools.cjs');
  const shown = [];
  const dialog = {showSaveDialog: async (_window, options) => { shown.push(['save', options.title]); return {canceled: true, filePath: ''}; },
    showOpenDialog: async options => { shown.push(['open', options.title]); return {canceled: true, filePaths: []}; },
    showErrorBox: title => { shown.push(['error', title]); }};
  const answers = createDialogAnswers({now: () => 7});
  const restore = answerDialogs(dialog, answers);
  const file = path.resolve(os.tmpdir(), 'styk-answer.styk');
  assert.deepEqual(answers.answer({kind: 'save', path: file}).pending, {save: 1, open: 0});
  answers.answer({kind: 'open', path: file});
  answers.answer({kind: 'save', cancel: true});
  // Answers are used in the order given, each once, by the dialog of their own kind; the window and its options pass as Electron gives them.
  assert.deepEqual(await dialog.showSaveDialog({}, {title: 'Save', defaultPath: 'a.styk'}), {canceled: false, filePath: file});
  assert.deepEqual(await dialog.showOpenDialog({title: 'Open'}), {canceled: false, filePaths: [file]});
  assert.deepEqual(await dialog.showSaveDialog({}, {title: 'Save'}), {canceled: true, filePath: ''});
  assert.deepEqual(shown, []);
  // With nothing queued the real dialog shows, until the driver asks for unanswered dialogs to be cancelled.
  await dialog.showSaveDialog({}, {title: 'Shown'});
  assert.deepEqual(shown, [['save', 'Shown']]);
  answers.answer({unanswered: 'cancel'});
  assert.deepEqual(await dialog.showOpenDialog({}, {title: 'Refused'}), {canceled: true, filePaths: []});
  // An error box holds the main process: it is recorded with its message instead of shown.
  dialog.showErrorBox('Unable to open file', 'The file is damaged.');
  assert.equal(shown.length, 1);
  const status = answers.status();
  assert.deepEqual(status.asked.map(row => row.answer), [file, file, 'cancelled', 'shown', 'cancelled (unanswered)', 'not shown']);
  assert.equal(status.asked.at(-1).message, 'The file is damaged.');
  assert.deepEqual([status.asked[0].title, status.asked[0].defaultPath, status.asked[0].at], ['Save', 'a.styk', 7]);
  // Wrong arguments are refused with a sentence; clear drops what waits.
  for (const args of [{kind: 'print', path: file}, {kind: 'save', path: 'relative.styk'}, {kind: 'save'}, {unanswered: 'maybe'}]) assert.throws(() => answers.answer(args), /kind|absolute path|unanswered/);
  answers.answer({kind: 'save', path: file});
  assert.deepEqual(answers.answer({clear: true}).pending, {save: 0, open: 0});
  restore();
  await dialog.showSaveDialog({}, {title: 'Restored'});
  assert.deepEqual(shown.at(-1), ['save', 'Restored']);
});

test('the Perfetto export is Chrome trace JSON with named threads', () => {
  const r = ring(8);
  push(r, 'paint', 10, 2.5, {args: {playing: false}});
  push(r, 'display frame', 10, 16, {thread: 1});
  push(r, 'queue', 11, -2, {value: 4});
  push(r, 'opened', 12, -1);
  const trace = perfettoTrace(ringEvents(r).events, {origin: 10});
  const paint = trace.traceEvents.find(event => event.name === 'paint');
  assert.deepEqual([paint.ph, paint.ts, paint.dur, paint.args.playing], ['X', 0, 2500, false]);
  assert.equal(trace.traceEvents.find(event => event.name === 'queue').ph, 'C');
  assert.equal(trace.traceEvents.find(event => event.name === 'opened').ph, 'i');
  assert.deepEqual(trace.traceEvents.filter(event => event.name === 'thread_name').map(event => event.args.name), ['interface', 'display']);
  JSON.parse(JSON.stringify(trace));
});

test('logs filter by least level, module and text', () => {
  const levels = ['debug', 'info', 'warn', 'error'];
  const rows = [{seq: 1, level: 'info', module: 'engine', message: 'opened'}, {seq: 2, level: 'warn', module: 'engine', message: 'slow frame'},
    {seq: 3, level: 'error', module: 'save', message: 'disk full'}];
  assert.deepEqual(filterLogs(rows, {least: 2, levels}).map(row => row.seq), [2, 3]);
  assert.deepEqual(filterLogs(rows, {module: 'ENG', levels}).map(row => row.seq), [1, 2]);
  assert.deepEqual(filterLogs(rows, {text: 'disk', levels}).map(row => row.seq), [3]);
  assert.deepEqual(filterLogs(rows, {since: 2, levels}).map(row => row.seq), [3]);
});

test('the inspector pages a tree and previews values without expanding them', () => {
  const root = {name: 'doc', list: Array.from({length: 120}, (_, i) => ({i})), bytes: new Uint8Array(9)};
  const top = treePage(root);
  assert.deepEqual(top.rows.map(row => [row.key, row.preview, row.container]), [['name', '"doc"', false], ['list', 'Array(120)', true], ['bytes', 'Uint8Array(9)', false]]);
  const second = treePage(root, {path: ['list'], cursor: 50});
  assert.deepEqual([second.size, second.rows.length, second.rows[0].key, second.next], [120, 50, 50, 100]);
  assert.equal(treePage(root, {path: ['list', 3, 'i']}).value, '3');
  assert.throws(() => treePage(root, {path: ['name', 'x', 'y']}), /not inside a container/);
  assert.equal(preview('x'.repeat(300)).length, 130);
});

test('the instrumentation layer records nothing and returns defaults without the developer build', async () => {
  assert.equal(globalThis.__stykTrace, undefined);
  const trace = await import('../src/trace.mjs');
  assert.equal(trace.tracing, false);
  assert.equal(trace.traceBegin('x'), 0);
  assert.equal(trace.tuned('playback.lookaheadFrames', 48, {min: 2}), 48);
  trace.traceEnd(0); trace.traceInstant('x'); trace.traceCounter('x', 1); trace.traceComplete('x', 0, 1);
  const gate = await import('../src/devtools-gate.mjs');
  assert.equal(gate.startDevtools({}, {}), null);
});

test('a statistics listener hears names and durations only, and the developer sink still gets every span and its arguments', async () => {
  const recorded = [], sink = {
    begin: (name, args) => { recorded.push(['begin', name, args]); return recorded.length; },
    end: (token, args) => recorded.push(['end', token, args]),
    complete: (name, start, duration, args) => recorded.push(['complete', name, duration, args]),
    instant() {}, counter() {}, parameter: (name, fallback) => fallback,
  };
  globalThis.__stykTrace = sink;
  try {
    const trace = await import('../src/trace.mjs?with-sink');
    const heard = [];
    trace.listenSpans(new Set(['edit session call', 'stage geometry']), (name, ms) => heard.push([name, typeof ms]));
    const listened = trace.traceBegin('edit session call', undefined), other = trace.traceBegin('engine load');
    assert.ok(listened < 0 && other > 0, 'a listened span has a listener token, another the sink\'s');
    trace.traceEnd(listened, {method: 'pose'}); trace.traceEnd(other, {workers: 2});
    trace.traceComplete('stage geometry', 0, 4, {why: 1}); trace.traceComplete('paint', 0, 9);
    assert.deepEqual(heard, [['edit session call', 'number'], ['stage geometry', 'number']]);
    assert.deepEqual(recorded.map(row => row[0] === 'begin' ? row.slice(0, 2) : row[0] === 'end' ? [row[0], row[2]] : [row[0], row[1], row[3]]),
      [['begin', 'edit session call'], ['begin', 'engine load'], ['end', {method: 'pose'}], ['end', {workers: 2}], ['complete', 'stage geometry', {why: 1}], ['complete', 'paint', undefined]]);
    trace.stopListening();
    assert.ok(trace.traceBegin('edit session call') > 0, 'without a listener the sink alone answers');
  } finally { delete globalThis.__stykTrace; }
});

test('without the developer build a listener uses a fixed set of slots, and stopping it restores the inert layer', async () => {
  const trace = await import('../src/trace.mjs');
  let heard = 0;
  trace.listenSpans(new Set(['stage submit']), () => { heard++; });
  try {
    const tokens = new Set();
    for (let i = 0; i < 200; i++) { const token = trace.traceBegin('stage submit'); tokens.add(token); trace.traceEnd(token); }
    assert.equal(heard, 200);
    assert.ok(tokens.size <= 64, `tokens come from a fixed set of slots (${tokens.size})`);
    assert.equal(trace.traceBegin('paint'), 0, 'a span the listener did not ask for is inert');
  } finally { trace.stopListening(); }
  assert.equal(trace.traceBegin('stage submit'), 0);
  assert.equal(trace.tracing, false);
});

test('the shipping check finds developer files, markers, binaries and capabilities, and passes clean inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-devtools-'));
  try {
    const clean = path.join(root, 'clean'), dirty = path.join(root, 'dirty'), caps = path.join(root, 'caps');
    await mkdir(path.join(clean, 'src'), {recursive: true});
    await writeFile(path.join(clean, 'src', 'app.mjs'), 'const sink = globalThis.__stykTrace ?? null; if (globalThis.__STYK_DEVTOOLS__) import(new URL("./devtools/devtools.mjs", location.href));');
    assert.deepEqual(await scanWeb(clean), []);
    await mkdir(path.join(dirty, 'src', 'devtools'), {recursive: true});
    await writeFile(path.join(dirty, 'src', 'devtools', 'early.js'), '');
    await writeFile(path.join(dirty, 'chunk.mjs'), 'const DEVELOPER = "styk-devtools";');
    assert.deepEqual((await scanWeb(dirty)).sort(), ['chunk.mjs: contains "styk-devtools"', 'src/devtools/early.js: a developer tools file']);
    await writeFile(path.join(root, 'app.exe'), Buffer.concat([Buffer.from('MZ\0\0'), Buffer.from('__stykDevtoolsReceive', 'utf16le')]));
    assert.deepEqual(await scanBinary(path.join(root, 'app.exe')), ['app.exe: contains "__stykDevtoolsReceive" (UTF-16)']);
    await mkdir(caps);
    await writeFile(path.join(caps, 'main.json'), JSON.stringify({permissions: ['core:default', 'allow-file-write-begin']}));
    assert.deepEqual(await scanCapabilities(caps), []);
    await writeFile(path.join(caps, 'dev.json'), JSON.stringify({permissions: ['styk-devtools:default']}));
    assert.deepEqual(await scanCapabilities(caps), ['dev.json: allows styk-devtools:default']);
    assert.ok(isDeveloperPath('src/devtools/panels.mjs') && isDeveloperPath(path.join('src', 'devtools', 'x.mjs')) && !isDeveloperPath('src/trace.mjs'));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the shipped web file set leaves the developer tools out', async () => {
  const files = await selectFiles(path.resolve('.'), ['src/**/*']);
  assert.ok(files.length > 100);
  assert.ok(!files.some(file => isDeveloperPath(file)), 'no src/devtools file is selected');
  assert.ok(files.some(file => file.replace(/\\/g, '/') === 'src/trace.mjs'));
});

test('shipping code builds no tracing objects: span arguments are guarded and live parameters\' specs are constants', async () => {
  const {readdir, readFile} = await import('node:fs/promises');
  const files = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!['devtools', 'pkg', 'locales'].includes(entry.name)) await walk(full); }
      else if (/\.mjs$/.test(entry.name) && entry.name !== 'trace.mjs') files.push(full);
    }
  };
  await walk('src');
  let calls = 0;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (!text.includes('trace.mjs')) continue;
    for (const [index, line] of text.split('\n').entries()) {
      const where = `${file}:${index + 1}`;
      if (/\btrace(End|Complete|Instant|Begin)\([^)]*\{/.test(line)) {
        calls++;
        // An open span is not enough: statistics open spans in the shipping build too (src/trace.mjs listenSpans).
        assert.match(line, /if \(tracing\)|tracing \? \{/, `${where}: a span's argument object is built only when the developer tools record`);
      }
      if (/\btuned\(/.test(line)) { calls++; assert.doesNotMatch(line, /\btuned\([^)]*,\s*\{/, `${where}: a live parameter's spec is a module constant`); }
    }
  }
  assert.ok(calls >= 8, `the scan found the instrumented call sites (${calls})`);
});

test('the packaged desktop app leaves the developer launch out: its module and the tools are not in the file lists, and the shipped desktop code names none of it', async () => {
  const {readdir, readFile} = await import('node:fs/promises');
  const build = JSON.parse(await readFile('package.json', 'utf8')).build;
  assert.ok(build.files.includes('!desktop/devtools.cjs'), 'the desktop file list leaves desktop/devtools.cjs out');
  const web = build.extraResources.find(resource => resource.to === 'web');
  assert.ok(web.filter.includes('!src/devtools/**'), 'the web resources leave src/devtools out');
  for (const name of await readdir('desktop')) {
    if (!/\.cjs$/.test(name) || name === 'devtools.cjs') continue;
    const text = await readFile(path.join('desktop', name), 'utf8');
    for (const marker of MARKERS) assert.ok(!text.includes(marker), `desktop/${name} carries no developer marker (${marker})`);
  }
  const main = await readFile('desktop/main.cjs', 'utf8');
  assert.match(main, /!app\.isPackaged && \(process\.argv\.includes\('--styk-developer'\)/, 'only a source checkout that asks loads the developer module');
});
