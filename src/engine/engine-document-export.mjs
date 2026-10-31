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

/** The error for what the engine raised: its message is JSON (`{name, message, messageKey, messageParams}`). */
function failure(error) {
  let data;
  try { data = JSON.parse(error?.message); } catch { return error; }
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
 * codec's export request, with `sourceId`).
 * `address` is a fresh `engine.handle.address()`; `cancelled()` says whether the export is stopped.
 * `join` is null where the caller is a thread of the engine already (the tests, which run it in-process).
 * @returns {{bytes: Uint8Array, figureTypeId: (number|undefined), drawings: boolean, rawBytes: number}}
 */
export function makeExportDocument({join, address, revision, request, cancelled}) {
  if (join) joinEngine(join);
  let made;
  try { made = export_document(address, revision, JSON.stringify(request), cancelled); } catch (error) { throw failure(error); }
  try { return {bytes: made.bytes(), figureTypeId: made.figure_type_id() ?? undefined, drawings: made.drawings(), rawBytes: made.raw_bytes()}; } finally { made.free(); }
}

/**
 * The `.styk` container of a project, written by the engine from the documents sessions handed over. `request`:
 * `snapshots` (tokens of `EditSession.snapshot()`, the outermost movieclip scope first, the document in front last, consumed
 * by the call), `scopes` (the movieclip type each document but the last was entered from), `name`, and `source`, the record
 * of the Pivot original the interface holds for the project, whose bytes are `source`.
 * `join` is null where the caller is a thread of the engine already (the tests, which run it in-process).
 * @returns {{bytes: Uint8Array, rawBytes: number}}
 */
export function makeProjectFile({join, request, source, cancelled}) {
  if (join) joinEngine(join);
  let made;
  try { made = save_project(JSON.stringify(request), source, cancelled); } catch (error) { throw failure(error); }
  try { return {bytes: made.bytes(), rawBytes: made.raw_bytes()}; } finally { made.free(); }
}

/** Lets go of the snapshots of a save that did not take them (a cancelled or failed one); harmless for those it took. */
export function releaseSnapshots(snapshots) {
  for (const token of snapshots) release_snapshot(token);
}

/** Gives this thread back to the engine; no call into the module may follow. */
export function releaseEngineThread() {
  try { wasm?.__wbindgen_thread_destroy(); } catch { /* never started */ }
  wasm = null;
}
