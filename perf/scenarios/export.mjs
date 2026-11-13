/**
 * Exporting: a still picture, a GIF, a video, and a Pivot file and its import back (docs/EXPORT-FORMATS.md,
 * docs/engine/rendering.md "Exports", docs/engine/formats-piv.md).
 *
 * Each export is made as a person makes it: the export dialog (Ctrl+E's dialog, src/export-sheet.mjs) set to a type, a
 * short range and a moderate size, then its Export button. The dialog's choices are made before the capture; the
 * measured stretch is from the press to the file complete. The desktop asks for the path; the run answers the dialog
 * with a file in a scratch folder (`dialog.answer`, docs/DEVTOOLS.md).
 *
 * While a picture export runs, the dialog shows its progress (src/export-progress.mjs): preparing (the engine's
 * export worker starting, its GPU device, the document at the export's revision), then frame after frame, then
 * finishing the file and saving it. The scenario notes when each stage first shows; those are the phases it reports,
 * and the frames per second are the frames over the stretch that drew them. The capture's frames and long tasks say
 * what the export did to the window meanwhile (the progress must keep moving, Cancel must answer).
 */
import {scratchFolder, written} from '../lib/files.mjs';
import {LIMITS} from '../lib/metrics.mjs';
import {desktopOnly, documentExportEnds, recoveryQuiet, statusLine} from './save.mjs';

/** Frames a sequence, GIF or video exports: one second at 24 frames a second, short enough for every workload. */
const RANGE = 24;
/** The size preset: 720p (1280×720 on a 16:9 artboard), a size people share. */
const SIZE = '720';

/**
 * Opens the export dialog and sets it to `category` and `action` (an export command: 'export-video', 'export-gif', …),
 * the size preset and, for an animation, frames 1 to `frames`. Waits until the dialog can export, with the encoder
 * chosen for a video. Returns what the dialog says of the type: {disabled, reason, provider}.
 */
async function prepareDialog(context, {category, action, project, frames}) {
  // An export started on a project with unsaved changes schedules a recovery copy for after it: not inside the next pass.
  await recoveryQuiet(context);
  await context.app.quiet();
  await context.request('command.run', {command: 'export'});
  await context.until(() => document.querySelector('#export-dialog[open] #export-submit'), {what: 'the export dialog'});
  await context.press(`#export-dialog [data-category="${category}"]`);
  if (project) await context.press(`#export-project-type [data-format="${project}"]`);
  return context.until(async ({action, frames, size, video}) => {
    const set = (id, value) => { const field = document.getElementById(id); if (!field || field.value === String(value)) return; field.value = String(value); field.dispatchEvent(new Event('input', {bubbles: true})); };
    if (action) {
      set('output-format', action);
      const option = document.querySelector(`#output-format option[value="${action}"]`);
      if (!option) return {disabled: true, reason: 'the dialog does not offer it'};
      if (option.disabled) return {disabled: true, reason: option.title || 'the dialog does not offer it here'};
      // A video's encoder is named once the dialog's capability check has run.
      if (video && !option.dataset.provider) return null;
    }
    if (document.getElementById('export-resolution')?.offsetParent) set('export-resolution', size);
    if (frames && document.getElementById('export-start')?.offsetParent) { set('export-start', 1); set('export-end', frames); }
    const submit = document.getElementById('export-submit');
    return submit && !submit.disabled ? {disabled: false, provider: document.querySelector(`#output-format option[value="${action}"]`)?.dataset.provider ?? ''} : null;
  }, {argument: {action, frames, size: SIZE, video: category === 'video'}, timeoutMs: 15000, what: 'the export dialog to accept the choices'});
}

/**
 * Starts watching the export dialog in the page: when each progress stage first shows (its text's key,
 * `#export-stage[data-i18n]`) and when the dialog closes. Call it before pressing Export; resolves with
 * {ms, stages: {key: ms}} counted from the call, or {timedOut} after `timeoutMs`.
 */
function exportEnds(context, timeoutMs) {
  return context.evaluate(async timeoutMs => {
    const started = performance.now(), stages = {};
    const note = () => { const key = document.getElementById('export-stage')?.getAttribute('data-i18n'); if (key && stages[key] === undefined) stages[key] = performance.now() - started; };
    const dialog = document.getElementById('export-dialog');
    const observer = new MutationObserver(note);
    if (dialog) observer.observe(dialog, {subtree: true, childList: true, attributes: true, attributeFilter: ['data-i18n']});
    try {
      while (document.querySelector('#export-dialog[open]')) {
        if (performance.now() - started > timeoutMs) return {timedOut: true, stages};
        await new Promise(resolve => setTimeout(resolve, 4));
      }
      return {ms: performance.now() - started, stages};
    } finally { observer.disconnect(); }
  }, timeoutMs);
}

/**
 * The phases of an export from the stages its dialog showed (`stages`, ms from the press) and its end (`ms`):
 *   prepare   the press to the first frame started (the export's worker, GPU device and document);
 *   frames    the first frame started to every frame drawn and encoded (the encoder finishing or the file saving);
 *   finish    from there to the dialog closing with the file complete.
 * A stage that did not show (an export too quick to paint it) leaves its phase out.
 */
export function exportPhases(stages, ms, frames) {
  const working = ['exportProgress.renderingFrames', 'exportProgress.encodingFrames', 'exportProgress.buildingGifColors'].map(key => stages[key]).filter(Number.isFinite);
  const finishing = ['exportProgress.finishingYourFile', 'exportProgress.savingYourFile'].map(key => stages[key]).filter(Number.isFinite);
  const first = working.length ? Math.min(...working) : null, done = finishing.length ? Math.min(...finishing) : null;
  const values = {duration: ms, 'export.fps': frames / (ms / 1000)};
  if (first !== null) values['export.prepare'] = first;
  if (first !== null && done !== null && done > first) Object.assign(values, {'export.frames': done - first, 'export.framesPerSecond': frames / ((done - first) / 1000)});
  if (done !== null) values['export.finish'] = ms - done;
  return values;
}

const EXPORT_METRICS = {
  'export.fps': {title: 'Frames exported per second, press to file', short: 'exported', unit: 'fps', better: 'higher', digits: 1},
  'export.framesPerSecond': {title: 'Frames drawn and encoded per second', unit: 'fps', better: 'higher', digits: 1},
  'export.prepare': {title: 'Press to the first frame (worker, GPU device, document)', unit: 'ms', better: 'lower', digits: 0},
  'export.frames': {title: 'Drawing and encoding the frames', unit: 'ms', better: 'lower', digits: 0},
  'export.finish': {title: 'Finishing and saving the file', unit: 'ms', better: 'lower', digits: 0},
  'export.fileMB': {title: 'File size', unit: 'MB', better: 'lower', digits: 2},
};
// While an export runs the dialog is all a person has: its longest task is how long Cancel or the progress can wait.
const RESPONSIVE = {metric: 'longTasks.longest', limits: LIMITS.response};

/**
 * A picture export: `format` names it ('png', 'gif', …; `name` in the id where the format has a digit, which ids do not), `category` and `action` the dialog's choices, `frames` the
 * frames it draws (1 for a still). Judged on frames exported per second, against the animation's own rate: twice as
 * fast as it plays is good, as fast as it plays fair, a third of that poor. A still is judged on its time instead.
 */
function pictureExport({format, name = format, extension, category, action, frames, title, description}) {
  const still = frames === 1;
  return {
    id: `export.${name}`, area: 'exports', title, kind: 'operation', description,
    judge: [still ? {metric: 'duration', limits: [1000, 3000, 10000]} : {metric: 'export.fps', limits: [48, 24, 8]}, RESPONSIVE],
    metrics: EXPORT_METRICS,
    timeoutMs: 180000,
    async when(context) {
      const skip = desktopOnly(context);
      if (skip) return skip;
      if (!still && (await context.state()).document.totalTicks < 2) return 'the document has one frame';
      const offered = await prepareDialog(context, {category, action, frames});
      await context.app.quiet();
      return offered.disabled ? `this machine cannot export ${format.toUpperCase()}: ${offered.reason}` : undefined;
    },
    async setup(context) {
      const files = scratchFolder(`export-${format}`), count = Math.min(frames, (await context.state()).document.totalTicks);
      const offered = await prepareDialog(context, {category, action, frames: count});
      return {files, frames: count, provider: offered.provider};
    },
    async run(context, state) {
      const file = state.files.file(`export.${extension}`);
      await context.app.answerDialog('save', file);
      const ends = exportEnds(context, 150000);
      await context.press('#export-submit');
      const ended = await ends;
      if (ended.timedOut) throw new Error(`The export did not end within 150 s (stages seen: ${Object.keys(ended.stages).join(', ') || 'none'}).`);
      const bytes = await written(file, {timeoutMs: 2000, what: `the ${format.toUpperCase()} export`}).catch(async error => { throw new Error(`${error.message} The app says: "${await statusLine(context)}".`); });
      return {metrics: {...exportPhases(ended.stages, ended.ms, state.frames), 'export.fileMB': bytes / 1048576}, notes: state.provider ? [`encoder: ${state.provider}`] : []};
    },
    // The dialog closes when the export ends: the next pass opens it again with the same choices.
    reset: (context, state) => prepareDialog(context, {category, action, frames: state.frames}),
    async teardown(context, state) { await context.app.quiet(); await context.app.dialogs({clear: true}).catch(() => {}); state.files.remove(); },
  };
}

export const png = pictureExport({
  format: 'png', extension: 'png', category: 'frames', action: 'export-png', frames: 1, title: 'Export a frame as PNG',
  description: 'The frame on show as a 720p PNG: the engine\'s export worker starts (its own GPU device, the document at this revision), draws the frame, the page encodes the PNG and the desktop writes it.',
});
export const gif = pictureExport({
  format: 'gif', extension: 'gif', category: 'animated', action: 'export-gif', frames: RANGE, title: 'Export a GIF',
  description: `${RANGE} frames at 720p as an animated GIF: the frames drawn on the export worker twice (a pass to build the palette, a pass to encode), streamed into the file.`,
});
export const webm = pictureExport({
  format: 'webm', extension: 'webm', category: 'video', action: 'export-video', frames: RANGE, title: 'Export a WebM video',
  description: `${RANGE} frames at 720p as WebM: frames drawn on the export worker, encoded by the encoder the dialog chose (the bundled FFmpeg, or the browser's WebCodecs without it), streamed into the file.`,
});
export const mp4 = pictureExport({
  format: 'mp4', name: 'mpeg', extension: 'mp4', category: 'video', action: 'export-mp4', frames: RANGE, title: 'Export an MP4 video',
  description: `${RANGE} frames at 720p as H.264 MP4: frames drawn on the export worker and encoded by the encoder the dialog chose. Skipped where this machine has no H.264 encoder.`,
});

/** The Pivot export through the dialog (Project, .piv). Resolves with the metrics; `file` is where it is written. */
async function exportPivot(context, file) {
  await context.app.answerDialog('save', file);
  const ends = documentExportEnds(context), closed = exportEnds(context, 150000);
  await context.press('#export-submit');
  const [ended] = await Promise.all([ends, closed]);
  if (!ended) throw new Error(`The Pivot export did not end within a minute. The app says: "${await statusLine(context)}".`);
  if (ended.timings?.format !== 'piv') throw new Error(`Something else ended first: a ${ended.timings?.format} export.`);
  const bytes = await written(file, {timeoutMs: 5000, what: 'the Pivot file'}).catch(async error => { throw new Error(`${error.message} The app says: "${await statusLine(context)}".`); });
  const timings = ended.timings, values = {duration: ended.ms, 'export.fileMB': bytes / 1048576};
  if (Number.isFinite(timings.normalize_ms)) values['piv.document'] = timings.normalize_ms;
  if (Number.isFinite(timings.fetch_ms)) values['piv.encode'] = timings.fetch_ms;
  if (Number.isFinite(timings.total_ms)) Object.assign(values, {'piv.make': timings.total_ms, 'piv.write': ended.ms - timings.total_ms});
  return values;
}

const PIVOT_METRICS = {
  'piv.make': {title: 'Making the file (request to its bytes in the page)', short: 'make', unit: 'ms', better: 'lower', digits: 0},
  'piv.document': {title: 'Engine: the Pivot document baked from the session', unit: 'ms', better: 'lower', digits: 0},
  'piv.encode': {title: 'Codec: the document encoded as Pivot', unit: 'ms', better: 'lower', digits: 0},
  'piv.write': {title: 'Writing it (to the desktop, staged, replaced)', unit: 'ms', better: 'lower', digits: 0},
  'export.fileMB': EXPORT_METRICS['export.fileMB'],
};

export const pivot = {
  id: 'export.piv', area: 'exports', title: 'Export a Pivot file', kind: 'operation',
  description: 'The animation as a .piv from the export dialog: the engine bakes the Pivot document from the one it holds, the Pivot codec in its worker encodes it, the desktop writes the file.',
  judge: [{metric: 'duration', limits: [1000, 3000, 10000]}, RESPONSIVE],
  metrics: PIVOT_METRICS,
  when: desktopOnly,
  async setup(context) {
    await prepareDialog(context, {category: 'editable', project: 'piv'});
    return {files: scratchFolder('export-piv')};
  },
  run: async (context, {files}) => ({metrics: await exportPivot(context, files.file('export.piv'))}),
  reset: context => prepareDialog(context, {category: 'editable', project: 'piv'}),
  async teardown(context, {files}) { await context.app.quiet(); await context.app.dialogs({clear: true}).catch(() => {}); files.remove(); },
};

/**
 * The Pivot file of the workload read back: the run exports it first (as `export.piv` does), then opens it as a person
 * opens a file, in a project tab of its own. The import's input is the app's own output, so nothing from outside
 * the repository is needed.
 */
export const importPivot = {
  id: 'file.import-piv', area: 'files', title: 'Import a Pivot file', kind: 'operation',
  description: 'Opens a .piv of the workload (exported first by the run): the Pivot codec decodes it in its worker, the engine takes the document, a project tab opens with its first frame drawn.',
  judge: {metric: 'duration', limits: [1000, 3000, 10000]},
  metrics: {
    'open.decode': {title: 'Engine: decode and prepare', unit: 'ms', better: 'lower', digits: 0},
    'open.fileMB': {title: 'File size', unit: 'MB', better: 'lower', digits: 2},
  },
  when: desktopOnly,
  async setup(context) {
    const files = scratchFolder('import-piv'), file = files.file('import.piv');
    await prepareDialog(context, {category: 'editable', project: 'piv'});
    const exported = await exportPivot(context, file);
    return {files, file, bytes: exported['export.fileMB'] * 1048576, front: await context.evaluate(() => globalThis.styk.projects.tabs.activeId)};
  },
  async run(context, {file, bytes, front}) {
    const opened = await context.app.open(file);
    await context.app.quiet();
    const [timings, now] = await context.evaluate(() => [globalThis.styk.performance().import ?? null, globalThis.styk.projects.tabs.activeId]);
    if (now === front) throw new Error('The Pivot file did not open in a project of its own.');
    return {metrics: {duration: opened.ms, 'open.fileMB': bytes / 1048576, ...(Number.isFinite(timings?.decode_ms) ? {'open.decode': timings.decode_ms} : {})}};
  },
  // The imported project closes (nothing in it changed, so nothing is asked) and the workload comes back to the front.
  reset: (context, {front}) => closeFrontUntil(context, front),
  async teardown(context, state) { await closeFrontUntil(context, state.front); state.files.remove(); },
};

/** Closes the project in front until the project `id` is in front again, then waits for its frame. */
export async function closeFrontUntil(context, id) {
  for (let closes = 0; closes < 4; closes++) {
    const front = await context.evaluate(() => globalThis.styk.projects.tabs.activeId);
    if (front === id) break;
    await context.evaluate(() => globalThis.styk.projects.close());
    await context.app.quiet();
  }
  await context.settle();
}

export default [png, gif, webm, mp4, pivot, importPivot];
