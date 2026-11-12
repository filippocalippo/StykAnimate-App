import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_VERSION, MAX_REPORTS, FRAME_BOUNDS, StatsError, validateBatch, validateReport, sanitizeMessage, stackFrame,
  sceneOf, fileSizeOf, memoryOf, coresOf, refreshOf, dayPartOf, installAgeOf, figureCountOf, frameCountOf, frameRateOf,
  machineClassOf, isLate, emptyFrameTimes, frameStep, frameQuantile } from '../src/stats/schema.mjs';

const today = '2026-11-12';
const sid = 'a'.repeat(32);
const times = (...pairs) => { const out = emptyFrameTimes(); for (const [ms, n] of pairs) out[frameStep(ms)] += n; return out; };
const session = (extra = {}) => ({ kind: 'session', sid, day: today, minutes: 42, open: 55, end: 'clean',
  first: { ever: false, day: true, week: false, back: false }, age: 'month', when: { weekday: 4, part: 'evening' }, language: 'it',
  mode: { simple: 30, advanced: 12 }, features: ['onion', 'library'], reached: ['edit', 'play', 'save'],
  counts: { edits: 310, undos: 22, keyframes: 48, plays: 9, playSeconds: 140, saves: 3 }, ...extra });
const problem = (extra = {}) => ({ kind: 'problem', sid, day: today, type: 'engine', message: 'index out of bounds: the len is 0 but the index is 0',
  stack: ['styk_eval::drawlist::encode_strokes styk-eval/src/drawlist.rs:412', 'render engine-export-worker.mjs:280'], doing: 'exporting',
  trail: ['open', 'toggle-onion', 'play', 'export-video'], scene: '10k-50k', features: ['onion'], times: 1, ...extra });
const batch = (...reports) => ({ v: STATS_VERSION, app: { version: '1.2.6', channel: 'stable', platform: 'win32', arch: 'x64' },
  machine: { graphics: 'integrated', vendor: 'intel', backend: 'webgpu', memory: '8', cores: '8', refresh: '60' }, reports });
const refusedAt = (value, field) => assert.throws(() => validateBatch(value, { today }), error => error instanceof StatsError && error.field === field, field);

test('a report passes unchanged and nothing outside the description passes at all', () => {
  const sent = batch(session({ smooth: [{ doing: 'drag', scene: '50k-200k', frames: 100, late: 29, times: times([14, 71], [40, 20], [120, 9]), worst: 120.04, lateMs: 1880, stages: { edit: 300, geometry: 900.26 } }],
    slow: [{ ms: 410, doing: 'drag', scene: '50k-200k', stages: { edit: 300 } }],
    files: [{ op: 'open', format: 'sticknodes', made: 'sticknodes/4.2', ok: 2, failed: 1, cancelled: 0, ms: 840 }],
    project: { scene: '50k-200k', figures: '21-100', frames: '200-1k', rate: '12-15' }, commands: { undo: 22, 'add-frame': 48 },
    recovery: { offered: true, restored: true, failed: false } }), problem(),
  { kind: 'file', sid, day: today, op: 'save', format: 'styk', size: '1-10mb', scene: '1k-10k', stage: 'write', reason: 'disk-full', kept: 'untouched', ms: 91 });
  const clean = validateBatch(sent, { today });
  assert.equal(clean.reports[0].smooth[0].worst, 120, 'milliseconds keep one decimal');
  assert.equal(clean.reports[0].smooth[0].stages.geometry, 900.3);
  assert.deepEqual({ ...clean, reports: clean.reports.map(report => ({ ...report, smooth: undefined })) }, { ...sent, reports: sent.reports.map(report => ({ ...report, smooth: undefined })) });

  refusedAt({ ...batch(session()), installationId: 'x' }, 'batch.installationId');
  refusedAt(batch(session({ fileName: 'goku.styk' })), 'batch.reports[0].fileName');
  refusedAt(batch(session({ features: ['onion', 'onion'] })), 'batch.reports[0].features');
  refusedAt(batch(session({ features: ['my-figure'] })), 'batch.reports[0].features[0]');
  refusedAt(batch(session({ counts: { edits: -1 } })), 'batch.reports[0].counts.edits');
  refusedAt(batch(session({ commands: { 'Goku punches': 1 } })), 'batch.reports[0].commands.Goku punches');
  refusedAt(batch(session({ files: [{ op: 'open', format: 'styk', made: 'C:/Users/me', ok: 1, failed: 0, cancelled: 0, ms: 1 }] })), 'batch.reports[0].files[0].made');
  refusedAt(batch(session({ sid: 'A'.repeat(32) })), 'batch.reports[0].sid');
  refusedAt(batch({ kind: 'screenshot' }), 'batch.reports[0].kind');
  refusedAt(batch(), 'batch.reports');
  refusedAt(batch(...Array.from({ length: MAX_REPORTS + 1 }, () => problem())), 'batch.reports');
  refusedAt({ ...batch(session()), v: 2 }, 'batch.v');
  refusedAt({ ...batch(session()), machine: { graphics: 'integrated', vendor: 'intel', backend: 'webgpu', memory: '12', cores: '8', refresh: '60' } }, 'batch.machine.memory');
});

test('a smoothness cell must add up, and a day must be recent', () => {
  const cell = { doing: 'play', scene: 'under-1k', frames: 10, late: 1, times: times([10, 9], [60, 1]), worst: 60, lateMs: 60 };
  assert.equal(validateBatch(batch(session({ smooth: [cell] })), { today }).reports[0].smooth[0].frames, 10);
  refusedAt(batch(session({ smooth: [{ ...cell, frames: 11 }] })), 'batch.reports[0].smooth[0]');
  refusedAt(batch(session({ smooth: [{ ...cell, late: 11 }] })), 'batch.reports[0].smooth[0]');
  refusedAt(batch(session({ smooth: [{ ...cell, times: cell.times.slice(1) }] })), 'batch.reports[0].smooth[0].times');
  refusedAt(batch(session({ smooth: [{ ...cell, stages: { shader: 4 } }] })), 'batch.reports[0].smooth[0].stages.shader');

  assert.equal(validateBatch(batch(session({ day: '2026-11-13' })), { today }).reports[0].day, '2026-11-13', 'a clock a day ahead of UTC');
  refusedAt(batch(session({ day: '2026-11-14' })), 'batch.reports[0].day');
  refusedAt(batch(session({ day: '2026-10-28' })), 'batch.reports[0].day');
  refusedAt(batch(session({ day: '2026-02-30' })), 'batch.reports[0].day');
});

test('error text loses every path, address and quoted name, and keeps its numbers', () => {
  const cases = [
    ['index out of bounds: the len is 0 but the index is 3', 'index out of bounds: the len is 0 but the index is 3'],
    ["ENOENT: no such file or directory, open 'C:\\Users\\Marta\\Desktop\\Goku fight.styk'", 'ENOENT: no such file or directory, open …'],
    ['EACCES: permission denied, open C:\\Users\\Marta\\Desktop\\a.styk', 'EACCES: permission denied, open …'],
    ['cannot read /home/marta/projects/fight.styk: truncated', 'cannot read … truncated'],
    ["Cannot read properties of undefined (reading 'segments')", 'Cannot read properties of undefined (reading …)'],
    ['Figure "Goku" has no joint `left hand`', 'Figure … has no joint …'],
    ["the file's header can't be read", "the file's header can't be read"],
    ['Failed to fetch https://stykanimate.com/api/v1/releases?x=1 from blob:file:///abc', 'Failed to fetch … from …'],
    ['wrote to \\\\nas\\share\\marta\\a.styk and mailed marta@example.com', 'wrote to … and mailed …'],
    ['line one\nline two\ttabbed', 'line one line two tabbed'],
  ];
  for (const [raw, safe] of cases) assert.equal(sanitizeMessage(raw), safe, raw);
  assert.equal(sanitizeMessage('x'.repeat(500)).length, 240);
  assert.equal(sanitizeMessage(undefined), '');
  // The intake refuses text that the app's own cleaning would have changed.
  assert.throws(() => validateReport(problem({ message: "open 'C:\\Users\\Marta\\a.styk'" })), error => error.field === 'report.message');
});

test('a stack line names a function and a place inside the repository, or it is not sent', () => {
  assert.equal(stackFrame('styk_eval::drawlist::encode_strokes', 'styk-eval/src/drawlist.rs:412'), 'styk_eval::drawlist::encode_strokes styk-eval/src/drawlist.rs:412');
  assert.equal(stackFrame('', 'app.mjs:6209'), 'app.mjs:6209');
  assert.equal(stackFrame('renderLibrary', ''), 'renderLibrary');
  assert.equal(stackFrame('renderLibrary', 'C:/Users/marta/app/src/library-panel.mjs:214'), 'renderLibrary', 'an absolute path is dropped');
  assert.equal(stackFrame('at eval (eval at <anonymous>)', 'file:///C:/x.js:1'), null);
  assert.equal(validateReport(problem({ stack: ['app.mjs:10', 'figureRows figure-types.mjs:88', 'styk_engine::jobs::export_frame'] })).stack.length, 3);
  for (const bad of ['open C:/Users/marta/a.mjs:1', 'a b c:1', 'x'.repeat(200), 'f /etc/passwd:1'])
    assert.throws(() => validateReport(problem({ stack: [bad] })), error => error.field === 'report.stack[0]', bad);
});

test('sizes become ranges', () => {
  assert.deepEqual([0, 999, 1000, 49999, 50000, 199999, 200000, 5e6].map(sceneOf), ['under-1k', 'under-1k', '1k-10k', '10k-50k', '50k-200k', '50k-200k', 'over-200k', 'over-200k']);
  assert.equal(sceneOf(NaN), null);
  assert.deepEqual([500, 2 * 1048576, 20 * 1048576, 80 * 1048576, -1].map(fileSizeOf), ['under-1mb', '1-10mb', '10-50mb', 'over-50mb', 'unknown']);
  assert.deepEqual([3.9, 7.8, 15.8, 31.9, 128, 0].map(gb => memoryOf(gb * 1073741824)), ['4', '8', '16', '32', '64', 'unknown']);
  assert.deepEqual([1, 6, 12, 64, 0].map(coresOf), ['2', '8', '16', '32', 'unknown']);
  assert.deepEqual([59.94, 74.9, 143.8, 360, 5].map(refreshOf), ['60', '75', '144', '240', 'unknown']);
  assert.deepEqual([3, 9, 13, 19, 23].map(dayPartOf), ['night', 'morning', 'afternoon', 'evening', 'night']);
  assert.deepEqual([0, 3, 20, 100, 400].map(installAgeOf), ['day', 'week', 'month', 'half-year', 'older']);
  assert.deepEqual([1, 4, 20, 100, 101, 0].map(figureCountOf), ['1', '2-5', '6-20', '21-100', 'over-100', null]);
  assert.deepEqual([10, 200, 1000, 5000, 5001].map(frameCountOf), ['under-50', '50-200', '200-1k', '1k-5k', 'over-5k']);
  assert.deepEqual([10, 12, 24, 30, 60, 0].map(frameRateOf), ['under-12', '12-15', '16-24', '25-30', 'over-30', null]);
  assert.equal(machineClassOf({ graphics: 'discrete', memory: '8' }), 'discrete');
  assert.equal(machineClassOf({ graphics: 'integrated', memory: '16' }), 'integrated-large');
  assert.equal(machineClassOf({ graphics: 'unknown', memory: 'unknown' }), 'integrated-small');
});

test('a late frame is one that took more than one and a half refreshes, and a histogram answers "how slow"', () => {
  assert.equal(isLate(25, 1000 / 60), false);
  assert.equal(isLate(25.1, 1000 / 60), true);
  assert.equal(isLate(12, 1000 / 144), true);
  assert.equal(frameStep(4), 0);
  assert.equal(frameStep(16.7), 3);
  assert.equal(frameStep(5000), FRAME_BOUNDS.length);
  const seen = times([14, 90], [30, 6], [200, 3], [2400, 1]);
  assert.equal(frameQuantile(seen, 0.5), 17);
  assert.equal(frameQuantile(seen, 0.95), 33);
  assert.equal(frameQuantile(seen, 0.99), 250);
  assert.equal(frameQuantile(seen, 1, 2400), 2400);
  assert.equal(frameQuantile(times([14, 5]), 0.5, 13.2), 13.2, 'never above the worst frame');
  assert.equal(frameQuantile(emptyFrameTimes(), 0.5), null);
});

test('the words the app reports pass, and words the lists no longer hold are refused', () => {
  const sent = batch(session({ features: ['text', 'onion'], counts: { keyframes: 3 },
    smooth: [{ doing: 'view', scene: 'under-1k', frames: 2, late: 1, times: times([8, 1], [40, 1]), worst: 40, lateMs: 40, stages: { wait: 5, interface: 3, other: 12, draw: 20 } }],
    files: ['styk-figure', 'styk-movieclip', 'sticknodes-movieclip', 'archive', 'apng'].map(format => ({ op: 'open', format, ok: 1, failed: 0, cancelled: 0, ms: 1 })) }),
  problem({ doing: 'viewing' }),
  { kind: 'file', sid, day: today, op: 'open', format: 'pivot-animation', size: 'under-1mb', stage: 'request', reason: 'service-unavailable', ms: 4 },
  { kind: 'file', sid, day: today, op: 'export', format: 'video', size: 'unknown', stage: 'prepare', reason: 'transfer-failed', ms: 4 });
  assert.equal(validateBatch(sent, { today }).reports.length, 4);
  refusedAt(batch(session({ counts: { frames: 1 } })), 'batch.reports[0].counts.frames');
  refusedAt(batch(session({ slow: [{ ms: 40, doing: 'drag', scene: 'under-1k', stages: { evaluate: 1 } }] })), 'batch.reports[0].slow[0].stages.evaluate');
  refusedAt(batch(session({ slow: [{ ms: 40, doing: 'drag', scene: 'under-1k', stages: { overlay: 1 } }] })), 'batch.reports[0].slow[0].stages.overlay');
});
