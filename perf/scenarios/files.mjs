/**
 * Files: opening a document. (Saving and the recovery copy are in save.mjs, exports and the Pivot import in export.mjs,
 * project tabs in projects.mjs.)
 */
import {file} from '../workloads.mjs';

/**
 * Opens the workload's document. The runner runs it first for every workload that has one: the first pass is the
 * launch's cold open, as a person's first open of the day is.
 */
export const open = {
  id: 'file.open', area: 'files', title: 'Open a document', kind: 'operation',
  description: 'From asking for the file to its first frame drawn: reading, the engine\'s decode and preparation on its threads, the interface\'s read view, the first paint.',
  judge: {metric: 'duration', limits: [1000, 3000, 10000]},
  metrics: {
    'open.decode': {title: 'Engine: decode and prepare', unit: 'ms', better: 'lower', digits: 0},
    'open.fileMB': {title: 'File size', unit: 'MB', better: 'lower', digits: 1},
  },
  // The first open is cold; the profiled pass opens the file again, the warm case, in a project tab of its own.
  passes: 1,
  async run(context) {
    const written = file(context.workload);
    const opened = await context.app.open(written.path);
    await context.app.quiet();
    const timings = await context.evaluate(() => globalThis.styk.performance().import ?? null);
    return {metrics: {duration: opened.ms, 'open.fileMB': written.bytes / 1048576, ...(Number.isFinite(timings?.decode_ms) ? {'open.decode': timings.decode_ms} : {})}};
  },
  // Each open after the first adds a tab beside the first (docs/PROJECT-TABS.md): it is closed, so the scenarios that
  // follow run with the one project open, not beside resting copies of it. The first project's tab comes forward.
  async reset(context) {
    if (await context.evaluate(() => globalThis.styk.projects.tabs.size) < 2) return;
    await context.evaluate(() => globalThis.styk.projects.close());
    await context.app.quiet();
    await context.settle();
  },
};

export default [open];
