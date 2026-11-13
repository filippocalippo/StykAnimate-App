// The editor's statistics collector (docs/STATISTICS.md): the frame counter, problems, engine panics, file operations and
// the session summary, as the desktop process receives them through the bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameCounter} from '../src/stats/frames.mjs';
import {createStats} from '../src/stats/collector.mjs';
import {ourStack, panicDetails, engineFunction} from '../src/stats/stack.mjs';
import {formatOf, reasonOf, workerFailure, restoreFailure} from '../src/stats/files.mjs';
import {capturePanics, onEnginePanic, lastPanic} from '../src/engine/engine-panic.mjs';
import {validateReport, sanitizeMessage, frameStep, FRAME_BOUNDS} from '../src/stats/schema.mjs';
import {messageError} from '../src/localized-error.mjs';
import {UserActionError} from '../src/user-action-error.mjs';
import {traceBegin, traceEnd, traceComplete} from '../src/trace.mjs';

const REFRESH = 1000 / 60;
/** A frame counter on a 60 Hz display whose callbacks it has already seen. */
function counter(segments = 500) {
  const frames = new FrameCounter({segments: () => segments});
  for (let i = 0; i < 8; i++) { frames.tick(i * REFRESH); frames.end(true); }
  return {frames, at: 8 * REFRESH};
}
/** Runs one display callback at `now` that draws for `doing` (null: draws nothing) with a paint of `paint` ms. */
function callback(frames, now, doing, paint = 4, continues = true) {
  frames.tick(now);
  if (doing) frames.drawn(doing, now + 1, now + 1 + paint);
  frames.end(continues);
}

test('frames are counted per interaction and scene size, and late ones are those over one and a half refreshes', () => {
  const {frames, at} = counter(500);
  let now = at;
  for (let i = 0; i < 30; i++) callback(frames, now += REFRESH, 'drag');
  callback(frames, now += 3 * REFRESH, 'drag', 30);   // overran: the next callback comes 50 ms after it
  callback(frames, now += 3 * REFRESH, 'drag');
  callback(frames, now += REFRESH, 'drag', 4, false); // the loop stops: the last frame ends with its paint
  const {smooth} = frames.summary();
  assert.equal(smooth.length, 1);
  const [cell] = smooth;
  assert.deepEqual([cell.doing, cell.scene], ['drag', 'under-1k']);
  assert.equal(cell.frames, 33, 'every frame drawn for the drag');
  assert.equal(cell.times.reduce((a, b) => a + b, 0), cell.frames, 'the histogram holds every frame');
  assert.ok(cell.late >= 1 && cell.late <= 2, `the overrun frame is late (${cell.late})`);
  assert.ok(cell.worst >= 49 && cell.worst <= 51, `worst ${cell.worst}`);
  assert.equal(frames.smoothShare(), 1 - cell.late / cell.frames);
});

test('another interaction or a larger scene is a cell of its own, and nothing is counted when nothing is done', () => {
  let segments = 500;
  const frames = new FrameCounter({segments: () => segments});
  let now = 0;
  for (let i = 0; i < 4; i++) callback(frames, now += REFRESH, null);
  for (let i = 0; i < 5; i++) callback(frames, now += REFRESH, 'play');
  segments = 120000;
  now += 1000; // the scene is read again at most twice a second
  for (let i = 0; i < 5; i++) callback(frames, now += REFRESH, 'scrub');
  callback(frames, now += REFRESH, null);
  const cells = frames.summary().smooth.map(cell => [cell.doing, cell.scene, cell.frames]);
  assert.deepEqual(cells, [['play', 'under-1k', 5], ['scrub', '50k-200k', 5]]);
});

test('the first frame of a burst is timed from the input that started it', () => {
  const {frames, at} = counter();
  frames.input(at + 100);
  callback(frames, at + 140, 'view', 5, false);   // 40 ms of waiting for the callback, then 1 + 5 ms of paint
  const [cell] = frames.summary().smooth;
  assert.equal(cell.frames, 1);
  assert.equal(cell.late, 1, 'input to picture took 46 ms');
  assert.ok(cell.stages.wait >= 39 && cell.stages.wait <= 41, `the wait is its own stage (${cell.stages.wait})`);
});

test('a late frame keeps where its time went, from the spans it heard, and the five slowest are listed', () => {
  const {frames, at} = counter();
  let now = at;
  for (let i = 0; i < 7; i++) {
    frames.tick(now += REFRESH);
    frames.onSpan('stage geometry', 12); frames.onSpan('stage submit', 20); frames.onSpan('edit session call', 3);
    frames.drawn('drag', now + 1, now + 1 + 33);
    frames.end(true);
    now += 2 * REFRESH;
  }
  callback(frames, now += REFRESH, 'drag');
  const {smooth: [cell], slow} = frames.summary();
  assert.ok(cell.late >= 6);
  assert.ok(cell.stages.geometry > 0 && cell.stages.draw > 0 && cell.stages.edit > 0 && cell.stages.interface > 0);
  assert.equal(slow.length, 5, 'the five slowest moments');
  assert.ok(slow.every((moment, i) => i === 0 || slow[i - 1].ms >= moment.ms));
  assert.deepEqual(Object.keys(slow[0].stages).sort(), ['draw', 'edit', 'geometry', 'interface', 'other'].filter(name => slow[0].stages[name]).sort());
});

test('a frame time falls in the histogram step of its upper bound', () => {
  assert.equal(frameStep(16.7), FRAME_BOUNDS.indexOf(17));
  assert.equal(frameStep(5000), FRAME_BOUNDS.length);
});

/** A desktop bridge that answers `enabled` and records what the page sends. */
function bridge(enabled = true) {
  const sent = {sessions: [], reports: []}, listeners = [];
  return {sent, listeners, getStatsState: async () => ({enabled, counting: enabled, forcedOff: false, noticeSeen: true, uploads: false}),
    onStatsState: callback => { listeners.push(callback); return () => {}; },
    sendStatsSession: (summary, facts) => { sent.sessions.push({summary, facts}); return true; },
    sendStatsReport: report => { sent.reports.push(report); return true; }};
}
const app = (extra = {}) => ({language: () => 'it', mode: () => 'simple', playing: () => false, activity: () => 'editing', featuresOn: () => ['onion'],
  segments: () => 4200, project: () => ({segments: 4200, figures: 12, frames: 300, fps: 24}), backend: () => 'WebGPU',
  commandIds: new Set(['undo', 'toggle-onion', 'add-frame', 'export-video', 'tutorials']), ...extra});
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
/** What the desktop process adds to a summary before it checks it (desktop/stats.cjs). */
const asSent = summary => ({kind: 'session', sid: 'b'.repeat(32), day: new Date().toISOString().slice(0, 10), sample: 100, end: 'clean',
  first: {ever: false, day: true, week: false, back: false}, age: 'month', when: {weekday: 2, part: 'morning'}, ...summary});
const withIds = report => ({...report, sid: 'b'.repeat(32), day: new Date().toISOString().slice(0, 10), sample: 100});

test('off means off: no frame counter, no listener, no span heard, nothing sent', async () => {
  const desktop = bridge(false), stats = await createStats({bridge: desktop, app: app()}).init();
  try {
    assert.equal(stats.on, false); assert.equal(stats.frames, null);
    assert.equal(traceBegin('edit session call'), 0, 'the trace layer has no listener and returns the inert token');
    stats.command('undo'); stats.problem(new Error('x')); stats.file('save', 'styk', {error: new Error('y')}); stats.flush();
    await settle();
    assert.deepEqual(desktop.sent, {sessions: [], reports: []});
    // Turned on, then off again from Preferences: it starts and stops with the desktop process's state.
    desktop.listeners[0]({enabled: true, counting: true});
    assert.equal(stats.on, true); assert.ok(stats.frames);
    assert.notEqual(traceBegin('edit session call'), 0, 'listening, the span it asked for has a token');
    desktop.listeners[0]({enabled: false, counting: false});
    assert.equal(stats.on, false); assert.equal(stats.frames, null);
    assert.equal(traceBegin('edit session call'), 0);
  } finally { stats.dispose(); }
});

test('the summary counts commands, features, files and time, and passes the schema as the desktop process completes it', async () => {
  const desktop = bridge(), stats = await createStats({bridge: desktop, app: app()}).init();
  try {
    for (const id of ['undo', 'undo', 'toggle-onion', 'add-frame', 'not-a-command']) stats.command(id);
    stats.count('edits', 3); stats.reach('edit'); stats.feature('ik'); stats.recovery('offered'); stats.recovery('restored');
    stats.file('open', 'Walk cycle.piv', {ms: 120, kind: 'piv', version: 5});
    stats.file('save', 'styk', {ms: 30});
    stats.file('export', 'mp4', {cancelled: true});
    const summary = stats.flush();
    assert.deepEqual(summary.commands, {undo: 2, 'add-frame': 1, 'toggle-onion': 1}, 'only commands of the registry, most used first');
    assert.deepEqual(summary.counts, {commands: 4, undos: 2, keyframes: 1, edits: 3, opens: 1, saves: 1});
    assert.deepEqual(summary.features, ['onion', 'ik']);
    assert.deepEqual(summary.reached, ['edit', 'save']);
    assert.deepEqual(summary.files, [{op: 'open', format: 'pivot-animation', made: 'pivot/5', ok: 1, failed: 0, cancelled: 0, ms: 120},
      {op: 'save', format: 'styk', ok: 1, failed: 0, cancelled: 0, ms: 30}, {op: 'export', format: 'video', ok: 0, failed: 0, cancelled: 1, ms: 0}]);
    assert.deepEqual(summary.project, {scene: '1k-10k', figures: '6-20', frames: '200-1k', rate: '16-24'});
    assert.deepEqual(summary.recovery, {offered: true, restored: true, failed: false});
    assert.equal(summary.language, 'it');
    assert.ok(!JSON.stringify(summary).includes('Walk cycle'), 'a file name never reaches a summary');
    assert.ok(Object.values(summary).every(value => value !== undefined), 'no field without a value: the desktop process\'s store refuses them');
    validateReport(asSent(summary));
    await settle();
    assert.equal(desktop.sent.sessions.length, 1);
    assert.equal(desktop.sent.sessions[0].facts.backend, 'webgpu');
  } finally { stats.dispose(); }
});

test('a problem carries cleaned text, its message key, our own stack lines, what was happening and the last commands', async () => {
  const desktop = bridge(), stats = await createStats({bridge: desktop, app: app()}).init();
  try {
    stats.command('toggle-onion'); stats.command('export-video');
    const error = new TypeError(`Cannot read "C:\\Users\\Ann\\Goku.styk" at 'Walk cycle' for ann@example.com`);
    error.stack = `TypeError: x\n    at render (stykanimate-app://app/src/engine/engine-stage.mjs:410:9)\n    at chrome-extension://abc/content.js:1:1\n    at Object.loop (stykanimate-app://app/src/app.mjs:1700:3)\n    at node_modules/thing.js:3:3`;
    stats.problem(error); stats.problem(error); // one error, reported by two layers
    stats.problem(new UserActionError('Select a figure first'));
    stats.problem(new DOMException('cancelled', 'AbortError'));
    const keyed = messageError(new Error(''), 'errors.app.theGraphicsDeviceWasLost', {});
    stats.problem(keyed, {type: 'graphics-lost', recovered: false});
    await settle();
    const [first, second] = desktop.sent.reports;
    assert.equal(desktop.sent.reports.length, 2, 'a person\'s refusal and a cancel are not problems; one error is one report');
    assert.equal(first.message, 'TypeError: Cannot read … at … for …');
    assert.deepEqual(first.stack, ['render src/engine/engine-stage.mjs:410', 'loop src/app.mjs:1700']);
    assert.deepEqual([first.doing, first.trail, first.scene, first.features], ['editing', ['toggle-onion', 'export-video'], undefined, ['onion']]);
    assert.equal(second.key, 'errors.app.theGraphicsDeviceWasLost');
    assert.equal(second.message, 'The graphics device was lost.', 'the English text of the key, whatever language the interface shows');
    assert.equal(second.type, 'graphics-lost'); assert.equal(second.recovered, false);
    for (const report of desktop.sent.reports) validateReport(withIds(report));
    // The same problem again is counted, and sent with its total alongside the next summary; a device back marks it recovered.
    const again = new TypeError(error.message); again.stack = error.stack;
    stats.problem(again); stats.recovered('graphics-lost');
    await settle();
    stats.flush();
    const resent = desktop.sent.reports.slice(2);
    assert.deepEqual(resent.map(report => [report.type, report.times, report.recovered]).sort(), [['error', 2, undefined], ['graphics-lost', 1, true]]);
  } finally { stats.dispose(); }
});

test('stack lines are ours only: source modules, bundled lines through the tables, engine functions without their hash', () => {
  const tables = {'chunk-AB.mjs': {modules: ['src/editor.mjs', 'src/stats/frames.mjs'], runs: [[0, 120, 100, 7, 110, 40], [1, 200, 150, 3]]}};
  const stack = ['Error: x', '    at a (stykanimate-app://app/src/chunks/chunk-AB.mjs:105:2)', '    at b (stykanimate-app://app/src/chunks/chunk-AB.mjs:115:2)',
    '    at c (stykanimate-app://app/src/chunks/chunk-AB.mjs:160:2)', '    at d (stykanimate-app://app/src/chunks/chunk-AB.mjs:130:2)',
    '    at styk_eval::load::read_figure::h0123456789abcdef (wasm://wasm/0a1b2c3d:wasm-function[77]:0x1f2e)',
    '    at std::panicking::begin_panic::h0123456789abcdef (wasm://wasm/0a1b2c3d:wasm-function[2]:0x10)'].join('\n');
  assert.deepEqual(ourStack(stack, {tables}), ['a src/editor.mjs:12', 'b src/editor.mjs:45', 'c src/stats/frames.mjs:13', 'styk_eval::load::read_figure']);
  assert.deepEqual(ourStack('Error\n    at f (file:///home/ann/project/src/app.mjs:3:1)', {tables: null}), [], 'a file path is never sent, nor read as ours');
  assert.deepEqual(ourStack('Error\n    at f (stykanimate-app://app/src/x.mjs:3:1)\n    at g (stykanimate-app://app/vendor/opentype.mjs:1:1)\n    at h (stykanimate-app://app/src/devtools/panels.mjs:1:1)', {tables: null}),
    ['f src/x.mjs:3'], 'vendored code and the developer tools are not ours');
  assert.equal(engineFunction('<alloc::vec::Vec<T> as core::ops::Drop>::drop::h0123456789abcdef'), null, 'the standard library is not ours');
});

test('an engine panic\'s text becomes an engine problem with the Rust file and line, never the path it was built at', async () => {
  const text = 'StykAnimate engine panic: panicked at /home/builder/stykanimate/engine/crates/styk-eval/src/drawlist.rs:412:9:\nindex out of bounds: the len is 0 but the index is 3';
  const stack = 'Error\n    at console.error (stykanimate-app://app/src/engine/engine-panic.mjs:21:5)\n    at __wbg_error_123 (stykanimate-app://app/src/engine/pkg/styk_engine.js:9:1)\n'
    + '    at styk_eval::drawlist::encode_strokes::h0123456789abcdef (wasm://wasm/0a1b:wasm-function[9]:0x1)\n    at std::panicking::rust_panic_with_hook::h0123456789abcdef (wasm://wasm/0a1b:wasm-function[1]:0x1)';
  const details = panicDetails(text, stack);
  assert.equal(details.message, 'index out of bounds: the len is 0 but the index is 3');
  assert.deepEqual(details.stack, ['styk-eval/src/drawlist.rs:412', 'styk_eval::drawlist::encode_strokes']);
  assert.deepEqual(panicDetails('StykAnimate Pivot codec panic: panicked at C:\\work\\engine\\crates\\styk-piv\\src\\piv\\frames.rs:88:1:\nbad tag').stack, ['styk-piv/src/piv/frames.rs:88']);
  // The capture on this thread: the console still gets the text, and the collector hears it as an engine problem. (The
  // engine may have installed it already in this process: it is installed once, and console.error stays its own.)
  capturePanics();
  const heard = [], stop = onEnginePanic(panic => heard.push(panic)), write = process.stderr.write;
  process.stderr.write = () => true; // the test's own output stays quiet
  try {
    console.error(text);
    assert.equal(heard.length, 1); assert.equal(lastPanic().text, text);
    const desktop = bridge(), stats = await createStats({bridge: desktop, app: app()}).init();
    try {
      console.error(text);
      const trap = new WebAssembly.RuntimeError('unreachable');
      stats.problem(trap); // the trap that follows the panic is the same problem
      await settle();
      assert.deepEqual(desktop.sent.reports.map(report => [report.type, report.message, report.stack[0]]),
        [['engine', 'index out of bounds: the len is 0 but the index is 3', 'styk-eval/src/drawlist.rs:412']]);
      validateReport(withIds(desktop.sent.reports[0]));
    } finally { stats.dispose(); }
  } finally { stop(); process.stderr.write = write; }
});

test('a worker\'s failure carries its stage, reason, stack and panic back to the interface thread', () => {
  const error = Object.assign(new RangeError('Array buffer allocation failed'), {fileStage: 'decode'});
  const posted = workerFailure(error, 'prepare', undefined);
  assert.equal(posted.fileStage, 'decode'); assert.equal(typeof posted.workerStack, 'string');
  const restored = restoreFailure(new Error('Array buffer allocation failed'), JSON.parse(JSON.stringify(posted)));
  assert.equal(restored.fileStage, 'decode'); assert.equal(reasonOf(restored), 'out-of-memory');
  assert.equal(reasonOf(Object.assign(new Error(''), {code: 'ENOSPC'})), 'disk-full');
  assert.equal(reasonOf(messageError(new Error(''), 'errors.importClient.theFileExceedsTheMibImportLimit', {value: 256})), 'too-large');
  assert.deepEqual(['scene.stykmov', 'stkz', 'png-sequence', 'mp4', 'figure.nodemc', 'x.zip', 'apng', 'odd.xyz'].map(formatOf),
    ['styk-movieclip', 'styk-figure', 'picture-sequence', 'video', 'sticknodes-movieclip', 'archive', 'apng', 'unknown']);
});

test('a failed file operation is a file report and a problem; a cancelled one is neither', async () => {
  const desktop = bridge(), stats = await createStats({bridge: desktop, app: app()}).init();
  try {
    const full = Object.assign(new Error('ENOSPC: no space left on device, write \'D:\\Animations\\Goku.styk\''), {code: 'ENOSPC'});
    stats.file('save', 'styk', {error: full, stage: 'write', bytes: 3 * 1048576, kept: 'unknown', ms: 40});
    stats.file('export', 'gif', {error: new DOMException('', 'AbortError')});
    await settle();
    const [file, problem] = desktop.sent.reports;
    assert.deepEqual(file, {kind: 'file', op: 'save', format: 'styk', size: '1-10mb', stage: 'write', reason: 'disk-full', kept: 'unknown', ms: 40});
    assert.equal(problem.kind, 'problem'); assert.equal(problem.message, sanitizeMessage(problem.message));
    assert.ok(!problem.message.includes('Goku'));
    assert.equal(desktop.sent.reports.length, 2);
    for (const report of desktop.sent.reports) validateReport(withIds(report));
    assert.deepEqual(stats.flush().files.map(row => [row.op, row.failed, row.cancelled]), [['save', 1, 0], ['export', 0, 1]]);
  } finally { stats.dispose(); }
});

test('the trace layer hands a listener names and durations of the spans it asked for, and nothing else', async () => {
  const desktop = bridge(), stats = await createStats({bridge: desktop, app: app()}).init();
  try {
    const span = traceBegin('edit session call');
    assert.ok(span < 0, 'a listener token');
    traceEnd(span, undefined);
    traceEnd(span, undefined); // a second end is ignored
    assert.equal(traceBegin('engine load'), 0, 'a span nobody listens to costs nothing');
    traceComplete('stage geometry', 0, 7);
    traceComplete('paint', 0, 50);
    const heard = Array.from(stats.frames.spans);
    assert.ok(heard[0] >= 0 && heard[1] === 7, `edit ${heard[0]}, geometry ${heard[1]}`);
    assert.equal(heard.reduce((a, b) => a + b, 0) - heard[0], 7, 'paint is not a stage span');
  } finally { stats.dispose(); }
});

test('a session the desktop process did not choose does no work, though statistics are on', async () => {
  const desktop = bridge(true);
  desktop.getStatsState = async () => ({enabled: true, counting: false, forcedOff: false, noticeSeen: true, uploads: true});
  const stats = await createStats({bridge: desktop, app: {}, developer: false}).init();
  try {
    assert.equal(stats.on, false);
    assert.equal(stats.frames, null);
    stats.command('undo'); stats.problem(new Error('x')); stats.file('save', 'a.styk', {ms: 4});
    assert.equal(stats.flush(), null);
    assert.deepEqual(desktop.sent, {sessions: [], reports: []});
  } finally { stats.dispose(); }
});

test('a frame waiting for its next display callback is dropped when the window is hidden, not counted as a stall', () => {
  const frames = new FrameCounter({segments: () => 500});
  frames.tick(0); frames.drawn('play', 0, 4); frames.end(true);
  frames.tick(16.7); frames.drawn('play', 16.7, 20); frames.end(true);
  frames.interrupt();
  frames.tick(60000);
  const cell = frames.summary().smooth[0];
  assert.equal(cell.frames, 1, "the first frame of the burst; the one that was waiting is not counted");
  assert.equal(cell.late, 0);
  assert.ok(cell.worst < 30);
});
