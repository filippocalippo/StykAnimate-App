/**
 * Saving: the project saved to a file, saved again after an edit, and the recovery copy the app writes on its own
 * after an edit (docs/document-exports.md, docs/PROJECT-TABS.md "Saving and recovery").
 *
 * A save is the engine writing the `.styk` container from a snapshot of the editing session on the export worker
 * (`DocumentExporter`, src/document-export.mjs), then the desktop writing it to a staged file that replaces the
 * destination. When one ends the app keeps its phases in `state.lastExport`: the exporter's own (`total_ms`, from the
 * request to the file's bytes in the page) and the engine's inside the worker (`engine`: prepare, lift, check, frames,
 * assemble). What follows the bytes (handing them to the desktop, the atomic replace, marking the project saved) is the
 * save's duration less the exporter's total.
 */
import {scratchFolder, sizeOf, written} from '../lib/files.mjs';
import {LIMITS} from '../lib/metrics.mjs';

/** On a browser a save is a download or a file picker, which a run cannot answer: the scenarios that need a file skip there. */
export const desktopOnly = context => (context.app.kind === 'browser' ? 'the browser saves through a download or its file picker, which a run cannot answer' : undefined);

/**
 * Starts waiting in the page for the save, export or recovery write in flight to end (`state.lastExport` is replaced
 * when one ends) and, with `saved`, for the save to be over as the person sees it: the project marked saved and the
 * status line no longer busy (after the file, the app removes the recovery copy and updates the title and the tab
 * before it says "Project saved"). Call it before the command, await it after: resolves with {ms, timings}, `ms`
 * counted from the call (the command follows within a millisecond), or null after `timeoutMs`.
 */
export function documentExportEnds(context, {saved = false, timeoutMs = 60000} = {}) {
  return context.evaluate(async ({saved, timeoutMs}) => {
    const {styk} = globalThis, before = styk.state.lastExport, started = performance.now();
    // A short timer, not an animation frame: waiting must not ask the stage for frames it would not otherwise draw.
    const busy = () => document.getElementById('status-dot')?.classList.contains('busy');
    while (styk.state.lastExport === before || (saved && (styk.editor.dirty || busy()))) {
      if (performance.now() - started > timeoutMs) return null;
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    return {ms: performance.now() - started, timings: styk.state.lastExport};
  }, {saved, timeoutMs});
}

/** The app's status line: what it says when an operation did not end as asked. */
export const statusLine = context => context.evaluate(() => document.getElementById('status')?.textContent?.trim().slice(0, 200) ?? '');

/**
 * The metrics of a `.styk` saved in `ms`, from the phases the app recorded (`timings`, state.lastExport) and the
 * file's `bytes`. They add up: start + worker + write is the duration, and the engine's phases are most of the worker.
 */
export function saveMetrics(ms, timings, bytes) {
  const engine = timings?.engine ?? {}, values = {duration: ms, 'save.fileMB': bytes / 1048576};
  if (Number.isFinite(timings?.total_ms)) Object.assign(values, {'save.make': timings.total_ms, 'save.write': ms - timings.total_ms});
  if (Number.isFinite(timings?.total_ms) && Number.isFinite(timings?.worker_ms)) Object.assign(values, {'save.worker': timings.worker_ms, 'save.start': timings.total_ms - timings.worker_ms});
  for (const phase of ['prepare', 'lift', 'check', 'frames', 'assemble']) if (Number.isFinite(engine[`${phase}_ms`])) values[`save.engine.${phase}`] = engine[`${phase}_ms`];
  return values;
}

const SAVE_METRICS = {
  'save.make': {title: 'Making the file (request to its bytes in the page)', short: 'make', unit: 'ms', better: 'lower', digits: 0},
  'save.start': {title: 'Starting: the export worker, the session snapshot, the messages', unit: 'ms', better: 'lower', digits: 0},
  'save.worker': {title: 'The worker writing the container (the engine phases below)', unit: 'ms', better: 'lower', digits: 0},
  'save.write': {title: 'Writing it (to the desktop, staged, replaced, marked saved)', short: 'write', unit: 'ms', better: 'lower', digits: 0},
  'save.engine.prepare': {title: 'Engine: the document checked and prepared', unit: 'ms', better: 'lower', digits: 0},
  'save.engine.lift': {title: 'Engine: lifted into skeleton and sections', unit: 'ms', better: 'lower', digits: 0},
  'save.engine.check': {title: 'Engine: the written file checked', unit: 'ms', better: 'lower', digits: 0},
  'save.engine.frames': {title: 'Engine: the frames compressed', unit: 'ms', better: 'lower', digits: 0},
  'save.engine.assemble': {title: 'Engine: the container assembled', unit: 'ms', better: 'lower', digits: 0},
  'save.fileMB': {title: 'File size', unit: 'MB', better: 'lower', digits: 2},
};
// A save is waited on, but not in the middle of a gesture: a second keeps the thought, three are a pause, ten a break.
const SAVE_JUDGE = {metric: 'duration', limits: [1000, 3000, 10000]};

/**
 * Presses `keys` (a save shortcut) and waits until the file is written and the project marked saved. Returns the
 * metrics; throws when the save did not end, or wrote nothing at `file`.
 */
async function saveWith(context, file, press) {
  const ends = documentExportEnds(context, {saved: true});
  await press();
  const ended = await ends;
  if (!ended) throw new Error(`The save did not end within a minute. The app says: "${await statusLine(context)}".`);
  if (ended.timings?.format !== 'styk') throw new Error(`Something else ended first: a ${ended.timings?.format} export.`);
  return saveMetrics(ended.ms, ended.timings, await written(file, {what: 'the saved project'}));
}

/**
 * Waits for a recovery write that is due (an edit, or an export or save that started while the project had unsaved
 * changes, schedules one), so that it does not run inside the next measured stretch: until the timer has fired and the
 * copy is written, or the project has nothing unsaved (the timer then writes nothing). At most half a minute.
 */
export async function recoveryQuiet(context) {
  await context.evaluate(async () => {
    const {styk} = globalThis, before = styk.state.lastExport, until = performance.now() + 30000;
    const pause = () => new Promise(resolve => setTimeout(resolve, 20));
    while (styk.state.recoveryTimer && performance.now() < until) await pause();
    while (styk.state.lastExport === before && styk.editor.dirty && performance.now() < until) await pause();
  });
}

export const saveAs = {
  id: 'file.save-as', area: 'files', title: 'Save a project as a new file', kind: 'operation',
  description: 'Ctrl+Shift+S, the save dialog answered with a new file: the engine writes the .styk from a snapshot of the session on the export worker, the desktop writes it to a staged file that replaces the destination, the project is marked saved.',
  judge: SAVE_JUDGE,
  metrics: SAVE_METRICS,
  when: desktopOnly,
  setup: () => ({files: scratchFolder('save')}),
  async run(context, {files}) {
    const file = files.file('project.styk');
    await context.app.answerDialog('save', file);
    return {metrics: await saveWith(context, file, () => context.input.key('s', {ctrl: true, shift: true}))};
  },
  teardown: (context, {files}) => files.remove(),
};

/**
 * The common save: the project already has its file, one joint is moved, Ctrl+S. No dialog; the same file is
 * replaced. The edit is made before the capture, so the measured stretch is the save alone.
 */
export const saveAgain = {
  id: 'file.save-again', area: 'files', title: 'Save again after an edit', kind: 'operation',
  description: 'A joint moved, then Ctrl+S on a project that has its file: no dialog, the engine writes the whole .styk again and the desktop replaces the file. The save people make most.',
  judge: SAVE_JUDGE,
  metrics: SAVE_METRICS,
  when: desktopOnly,
  async setup(context) {
    const files = scratchFolder('save-again'), file = files.file('project.styk');
    await context.app.answerDialog('save', file);
    await saveWith(context, file, () => context.input.key('s', {ctrl: true, shift: true}));
    const state = {files, file, edits: 0};
    await edit(context, state);
    return state;
  },
  async run(context, {file}) {
    if (!(sizeOf(file) > 0)) throw new Error('The project has no file to save again.');
    return {metrics: await saveWith(context, file, () => context.input.key('s', {ctrl: true}))};
  },
  // The next pass saves an edit too.
  reset: (context, state) => edit(context, state),
  async teardown(context, state) {
    for (let undo = 0; undo < state.edits; undo++) await context.request('undo');
    await recoveryQuiet(context);
    state.files.remove();
  },
};

/**
 * One edit: a joint of the figure with the most joints dragged for half a second, as pose.drag-joint does, counted so
 * that the scenario can undo its edits at the end. The handle is found again each time: the last edit moved it.
 */
async function edit(context, state) {
  const first = await context.request('target.handle', {kind: 'pose'});
  await context.request('select', {uid: first.uid});
  const target = await context.request('target.handle', {kind: 'pose'});
  if (!target.onStage) throw new Error('Something covers the stage where the handle is: the edit cannot be made.');
  const before = (await context.state()).document.revision;
  await context.input.stroke(context.paths.sweep(target, 40, 30), {durationMs: 500});
  await context.settle();
  if ((await context.state()).document.revision === before) throw new Error('The joint did not move: the press did not start a drag.');
  state.edits++;
}

/**
 * The recovery copy: after an edit the app waits for its autosave interval (2.5 s by default, a setting) and writes the
 * whole project to the recovery file on its own, while the person goes on working. Nobody waits for it; what matters
 * is that the interface does not stutter while it runs. The pass makes an edit, then waits for the timer and the write;
 * its numbers are the write's own and the interface's frames during it (`trace.recent` over the write's stretch).
 */
export const recovery = {
  id: 'file.recovery', area: 'files', title: 'Recovery copy after an edit', kind: 'operation',
  description: 'A joint moved, then the app\'s autosave timer writes the recovery copy: the same engine save as Save, to the recovery file, while the stage stays live. Judged on the frames the interface shows while it runs.',
  judge: {metric: 'recovery.worstFrame', limits: LIMITS.frame},
  metrics: {
    'recovery.wait': {title: 'From the edit to the write starting (the autosave timer)', unit: 'ms', better: 'lower', digits: 0},
    'recovery.worstFrame': {title: 'Longest frame while it writes', short: 'worst frame', unit: 'ms', better: 'lower', digits: 1},
    'recovery.lateFrames': {title: 'Late frames while it writes', unit: '', better: 'lower', digits: 0},
    'recovery.longestTask': {title: 'Longest interface task while it writes', unit: 'ms', better: 'lower', digits: 0},
    ...SAVE_METRICS,
  },
  async when(context) {
    const seconds = await context.evaluate(() => globalThis.styk.state.settings?.autosaveSeconds ?? null);
    // The browser writes its copy to its own storage: the scenario runs there too.
    return seconds === 0 ? 'the recovery copy is turned off in the settings' : undefined;
  },
  async setup(context) {
    await recoveryQuiet(context);
    return {edits: 0};
  },
  async run(context, state) {
    await edit(context, state);
    // The timer fires (`recoveryTimer` is cleared as its callback starts), then the write ends (`lastExport` is replaced).
    const ended = await context.evaluate(async () => {
      const {styk} = globalThis, began = performance.now(), before = styk.state.lastExport;
      const wait = async (test, ms) => { const until = performance.now() + ms; while (!test()) { if (performance.now() > until) return false; await new Promise(resolve => setTimeout(resolve, 4)); } return true; };
      if (!await wait(() => !styk.state.recoveryTimer, 20000)) return {error: 'the autosave timer did not fire within 20 s'};
      const fired = performance.now();
      if (!await wait(() => styk.state.lastExport !== before, 60000)) return {error: 'the recovery copy was not written within a minute'};
      return {waitMs: fired - began, writeMs: performance.now() - fired, timings: styk.state.lastExport};
    });
    if (ended.error) throw new Error(`${ended.error}. The app says: "${await statusLine(context)}".`);
    // The interface while the copy was written: the capture's ring over that stretch.
    const during = await context.request('trace.recent', {ms: Math.ceil(ended.writeMs) + 20}, 'full');
    const longTask = during.spans.find(row => row.name === 'long task');
    const bytes = ended.timings?.output_bytes ?? NaN;
    return {metrics: {...saveMetrics(ended.writeMs, ended.timings, bytes), 'recovery.wait': ended.waitMs,
      'recovery.worstFrame': during.frames?.worst ?? NaN, 'recovery.lateFrames': during.frames?.count ? Math.round((during.frames.lateShare ?? 0) * during.frames.count) : NaN,
      'recovery.longestTask': longTask?.worst ?? 0}};
  },
  async teardown(context, state) {
    for (let undo = 0; undo < state.edits; undo++) await context.request('undo');
    await recoveryQuiet(context);
  },
};

export default [saveAs, saveAgain, recovery];
