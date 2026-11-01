/**
 * The files of an export, made by the engine (docs/engine/document.md, "Exports of the document"): Pivot animations and
 * figures (`.piv`, `.stk`) with the authored tracks, camera motion, parallax, styles and movieclips baked into stored
 * frames, figure files (`.stkz`, `.stykmov`), and the `.styk` project the editing session holds.
 *
 * This runs in the document export worker (src/document-export-worker.mjs), which joins the engine's shared memory as the
 * export renderer does (engine-export-worker.mjs) and calls the engine on the document it holds at the revision the
 * interface exports, or on the snapshot of a session the interface took; the interface thread is not involved. The call is
 * one synchronous stretch of work on the worker that asks `cancelled()` between its steps. A worker that joined must give
 * its thread back before it ends (`releaseEngineThread`), as the export renderer does.
 */
import {initSync, export_document, save_project, release_snapshot} from './pkg/styk_engine.js';
import {messageError} from '../localized-error.mjs';
import {validationLabel} from '../validation-labels.mjs';
import {inside} from './engine-guard.mjs';

let wasm = null;

/** Refusals for what a Pivot file cannot hold: counted as unsupported features, not as invalid documents. */
const UNSUPPORTED = new Set([
  'errors.documentExportWorker.pivotFilesCannotPreserveVfxSaveAsStyk',
  'errors.documentExportWorker.pivotCannotPreserveConnectorsSmartStretchOrOne',
  'errors.documentExportWorker.pivotCannotRetainTheseStickNodesShapesSave',
  'errors.documentExportWorker.saveMovieclipsAsStykmovUseBreakApartTo',
  'errors.documentExportWorker.pivotFilesCannotRepresentTheseGradientFillsSave',
  'errors.documentExportWorker.selectAMovieclipToExportAsStykmov',
  'errors.pivotExportMaterialize.pivotCannotPreserveOneSidedFillsSaveAs',
  'errors.pivotExportMaterialize.pivotCannotPreserveConnectorsOrSmartStretchSave',
]);

/** Joins the engine on this thread (once). `join` is `engine.join` of src/engine/engine.mjs. */
function joinEngine(join) {
  wasm ??= initSync({module: join.module, memory: join.memory, thread_stack_size: join.stack});
}

/** A value an engine refusal names: text as it is, a field label translated. */
const parameter = value => value && typeof value === 'object' && '@label' in value ? validationLabel(value['@label']) : value;

/**
 * The error for what the engine raised: its message is JSON (`{name, message, messageKey, messageParams}`). Anything else that comes out
 * of a call into the engine is not a failure the engine reported but a thread that was cut off in the middle of its work: a trap (the
 * `unreachable` of a panic, an out-of-bounds access), or a JavaScript exception thrown through its frames. Nothing in those frames ran its
 * destructors, so a reservation of memory they held is still held: the error is marked `trapped` and whoever receives it gives the
 * reservation back (a failure the engine reported has dropped its own, and giving back twice is harmless).
 */
function failure(error) {
  let data;
  try { data = JSON.parse(error?.message); } catch { data = null; }
  if (!data || typeof data !== 'object') {
    if (error && typeof error === 'object') error.trapped = true;
    return error;
  }
  if (data?.name === 'AbortError') return new DOMException(String(data.message ?? 'The export was cancelled.'), 'AbortError');
  const params = Object.fromEntries(Object.entries(data?.messageParams ?? {}).map(([name, value]) => [name, parameter(value)]));
  const result = data?.messageKey ? messageError(new Error(String(data.message)), data.messageKey, params) : new Error(String(data?.message ?? error.message));
  if (data?.code) result.code = data.code;
  if (UNSUPPORTED.has(data?.messageKey)) result.telemetryCode = 'unsupported_feature';
  return result;
}

/**
 * Makes the document of an export of `request` from the document the engine holds at `revision` (the interface's
 * revision of it). `request`: `format` (`piv`, `stk`, `stkz`, `stykmov`), `name`, `figureTypeId`, `figureUid`,
 * `figureUids`, `tick`, `output` (`document`, `container` for the figure file as it is stored, or `codec` for the body of the
 * codec's export request).
 * `address` is a fresh `engine.handle.address()`; `cancelled()` says whether the export is stopped.
 * `address` is a fresh `engine.handle.address()` (consumed) whose workers the save may use, or 0.
 * `join` is null where the caller is a thread of the engine already (the tests, which run it in-process). `guard` is the worker's
 * (src/engine/engine-guard.mjs): the call is made with it held, so the interface cannot end the worker inside the engine.
 * @returns {{bytes: Uint8Array, figureTypeId: (number|undefined), drawings: boolean, rawBytes: number}}
 */
export function makeExportDocument({join, address, revision, request, cancelled, guard}) {
  return inside(guard, () => {
    if (join) joinEngine(join);
    let made;
    try { made = export_document(address, revision, JSON.stringify(request), cancelled); } catch (error) { throw failure(error); }
    try { return {bytes: made.bytes(), figureTypeId: made.figure_type_id() ?? undefined, drawings: made.drawings(), rawBytes: made.raw_bytes()}; } finally { made.free(); }
  });
}

/**
 * The `.styk` container of a project, written by the engine from the documents sessions handed over. `request`:
 * `snapshots` (tokens of `EditSession.snapshot()`, the outermost movieclip scope first, the document in front last, consumed
 * by the call), `scopes` (the movieclip type each document but the last was entered from) and `name`. A project opened from
 * Pivot carries its original in the document (`_stykSource`).
 * `join` is null where the caller is a thread of the engine already (the tests, which run it in-process).
 * @returns {{bytes: Uint8Array, rawBytes: number, timings: object}} `timings`: where the save's time went in the engine (`prepare_ms`,
 * `lift_ms`, `assemble_ms`, `total_ms`, and for the skeleton, the arrays section and the payloads section `{raw, stored, hash_ms, compress_ms, reused}`).
 */
export function makeProjectFile({join, request, cancelled, guard, address = 0}) {
  return inside(guard, () => {
    if (join) joinEngine(join);
    let made;
    try { made = save_project(address, JSON.stringify(request), cancelled); } catch (error) { throw failure(error); }
    try { return {bytes: made.bytes(), rawBytes: made.raw_bytes(), timings: JSON.parse(made.timings() || 'null')}; } finally { made.free(); }
  });
}

/** Lets go of the snapshots of a save that did not take them (a cancelled or failed one); harmless for those it took. */
export function releaseSnapshots(snapshots) {
  for (const token of snapshots) release_snapshot(token);
}

/** Gives this thread back to the engine; no call into the module may follow. Throws an AbortError, doing nothing, when the interface
 * has claimed `guard` to end this worker (src/engine/engine-guard.mjs). */
export function releaseEngineThread(guard) {
  inside(guard, () => {
    try { wasm?.__wbindgen_thread_destroy(); } catch { /* never started */ }
    wasm = null;
  });
}
