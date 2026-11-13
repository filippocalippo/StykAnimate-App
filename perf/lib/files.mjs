/**
 * Files a scenario makes: saves, exports, the Pivot file an import reads back (perf/scenarios/save.mjs, export.mjs).
 *
 * Each scenario that writes gets a folder of its own under the operating system's temp folder, and removes it in its
 * teardown: nothing a run writes stays behind, and nothing lands beside the person's own files. The app writes through
 * a staged file that replaces the destination when it is complete (docs/document-exports.md), so a file that exists
 * at the path asked for is a file written in full.
 */
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

/**
 * A new, empty folder for one scenario's files: `file(name)` is a path in it, `remove()` deletes the folder and all it
 * holds (the save or export a failed pass left too).
 */
export function scratchFolder(label) {
  const folder = mkdtempSync(path.join(os.tmpdir(), `styk-perf-${label}-`));
  let count = 0;
  return {
    folder,
    /** A path in the folder that nothing has used yet: `name` with a counter before its extension. */
    file(name) { const {name: stem, ext} = path.parse(name); return path.join(folder, `${stem}-${++count}${ext}`); },
    remove() { rmSync(folder, {recursive: true, force: true, maxRetries: 20, retryDelay: 250}); },
  };
}

/** The size in bytes of the file at `file`, or null when there is none. */
export function sizeOf(file) {
  try { return statSync(file).size; } catch { return null; }
}

/**
 * Waits until a file of at least one byte is at `file` and returns its size; throws, saying what was awaited, after
 * `timeoutMs`. The app's writes are atomic, so the file appears complete.
 */
export async function written(file, {timeoutMs = 10000, what = 'the file'} = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const bytes = sizeOf(file);
    if (bytes > 0) return bytes;
    if (performance.now() > deadline) throw new Error(`${what} was not written${bytes === 0 ? ' (the file is empty)' : ''}: ${path.basename(file)}.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
