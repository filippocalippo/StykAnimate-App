/**
 * Files: opening a document. (Saving and exporting are in save.mjs and export.mjs.)
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
  // The first open is cold; opening again replaces the document, which is the warm case the profiled pass explains.
  passes: 1,
  async run(context) {
    const written = file(context.workload);
    const opened = await context.app.open(written.path);
    await context.app.quiet();
    const timings = await context.evaluate(() => globalThis.styk.performance().import ?? null);
    return {metrics: {duration: opened.ms, 'open.fileMB': written.bytes / 1048576, ...(Number.isFinite(timings?.decode_ms) ? {'open.decode': timings.decode_ms} : {})}};
  },
};

export default [open];
