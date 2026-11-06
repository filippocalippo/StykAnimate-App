import {errorMessageData, messageError} from './localized-error.mjs';

import {diagnosticDetails} from './telemetry-schema.mjs';
import {makeExportDocument, makeProjectFile, releaseEngineThread} from './engine/engine-document-export.mjs';
import {flattenDrawingFigures} from './drawing-flatten.mjs';
import {codecRequest} from './codec-request.mjs';

/**
 * The document export worker. Every file is made by the engine, which the worker joins (src/engine/engine-document-export.mjs):
 * a `.styk` project is written from the snapshot of the editing session the interface took (a project opened from Pivot carries its
 * original in the document); Pivot `.piv`/`.stk` need the document evaluated, so
 * the engine makes the document of the export from the one it holds at the interface's revision and the worker carries it on to
 * the codec's export request; figure files `.stkz`/`.stykmov` are written by the engine as well.
 */
let config, running = false, guard = null;
let timings = {};
function reply(id, payload, transfer = []) { self.postMessage({id, ok: true, ...payload}, transfer); }

/** The `.styk` container of the project the interface handed over, written by the engine. */
async function projectFile(message) {
  if (!config.engine || !message.project) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
  const cancelled = () => Boolean(message.cancel && Atomics.load(message.cancel, 0));
  const made = makeProjectFile({join: config.engine.join, guard, cancelled, address: message.project.address,
    request: {snapshots: message.project.snapshots, scopes: message.project.scopes, helpers: message.project.helpers, aside: message.project.aside, reservation: message.project.reservation, name: config.name}});
  timings.container_raw_bytes = made.rawBytes;
  timings.engine = made.timings;
  return made.bytes;
}

/** The document the export in `config` saves, made by the engine from the document it holds at the interface's revision. */
function engineDocument(message) {
  if (!config.engine || !message.engine) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
  const cancelled = () => Boolean(message.cancel && Atomics.load(message.cancel, 0));
  const piv = ['piv', 'stk'].includes(config.format);
  return makeExportDocument({join: config.engine.join, guard, address: message.engine.address, revision: message.engine.revision, cancelled, request: {
    format: config.format, name: config.name, figureTypeId: config.figureTypeId, figureUid: config.figureUid, figureUids: config.figureUids,
    tick: config.tick, output: piv ? 'codec' : 'container'}});
}

/** The content type of the codec's export request: the document's JSON, then the Pivot original the document carries (the engine's
 * `CodecRequest` output; the codec's `FRAMED_EXPORT`). */
const FRAMED_EXPORT = 'application/vnd.stykanimate.export';

/** The body of the codec's export request. Pivot formats cannot carry tile blobs: drawing cels flatten into ordinary
 * sprites at source resolution (largest mip level past the 16 Mpx cap), with anchors rewritten so placement is identical. */
async function codecBody(made) {
  if (!made.drawings) return made.bytes;
  // Four bytes of the JSON's length, the JSON, the original: only the JSON is read and rewritten.
  const framed = made.bytes, length = new DataView(framed.buffer, framed.byteOffset, 4).getUint32(0, true);
  const request = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))), flattenStats = {}, flattening = performance.now();
  timings.drawing_flattens = await flattenDrawingFigures(request.document, {stats: flattenStats});
  if (flattenStats.downsampled) timings.drawing_downsampled = flattenStats.downsampled;
  timings.drawing_flatten_ms = +(performance.now() - flattening).toFixed(3);
  const json = new TextEncoder().encode(JSON.stringify(request)), original = framed.subarray(4 + length);
  const body = new Uint8Array(4 + json.length + original.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4); body.set(original, 4 + json.length);
  return body;
}

self.addEventListener('message', async event => {
  const message = event.data;
  if (message.operation === 'release') {
    // A worker that joined the engine gives its thread back before it ends; no call into the module may follow. One the interface
    // already claimed to end it (src/engine/engine-guard.mjs) has nothing to give back.
    try { releaseEngineThread(guard); } catch { /* ended */ }
    self.postMessage({released: true});
    self.close?.();
    return;
  }
  if (running) { self.postMessage({id: message.id, ok: false, error: {message: 'The document export worker is busy.', messageKey:'errors.documentExportWorker.busy', telemetryCode: 'worker_busy', telemetryStage: 'prepare'}}); return; }
  running = true;
  let stage = 'prepare';
  try {
    if (message.operation === 'start') {
      config?.codecPort?.close();
      config = message.options;
      guard ??= config.guard ?? null;
      timings = {};
      reply(message.id);
    } else if (message.operation === 'export') {
      if (!config) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
      const started = performance.now();
      let body, blob;
      if (config.format === 'styk') {
        stage = 'serialize';
        blob = new Blob([await projectFile(message)]);
        timings.container_build_ms = timings.normalize_ms = +(performance.now() - started).toFixed(3);
      } else if (['stkz', 'stykmov'].includes(config.format)) {
        // The engine bakes, validates, refuses and writes the figure file.
        stage = 'validate';
        const made = engineDocument(message);
        timings.normalize_ms = timings.compose_ms = timings.container_build_ms = performance.now() - started;
        timings.container_raw_bytes = made.rawBytes;
        blob = new Blob([made.bytes]);
      } else {
        // The engine bakes, validates and refuses; this worker carries the result on.
        stage = 'validate';
        const made = engineDocument(message);
        timings.normalize_ms = timings.compose_ms = performance.now() - started;
        body = await codecBody(made);
        stage = 'serialize';
        // The engine wrote the request; fetch consumes the large body in this worker. Passing it back to the main thread
        // would recreate the freeze.
        timings.json_characters = body.length;
        const sending = performance.now();
        const headers = {'Content-Type': FRAMED_EXPORT};
        if (config.jobId) headers['X-Styk-Job-Id'] = config.jobId;
        stage = 'request';
        const response = await codecRequest(config, '/api/export', {method: 'POST', headers, body});
        if (!response.ok) {
          const text = await response.text();
          let details;
          try { details = JSON.parse(text); } catch { /* Preserve status for non-JSON failures. */ }
          const error = new Error(details?.error?.message || details?.error || `Document export failed (${response.status}).`);
          error.status = response.status; error.code = details?.code;
          error.telemetryCode = response.status >= 500 ? 'backend_unavailable' : 'backend_rejected';
          throw error;
        }
        blob = await response.blob();
        timings.fetch_ms = performance.now() - sending;
        const service = {};
        for (const metric of (response.headers.get('Server-Timing') || '').slice(0, 1024).split(',')) {
          const match = /^\s*(receive|parse|validate|source_digest|provenance|document_digest|encode|total);dur=(\d+(?:\.\d+)?)\s*$/.exec(metric);
          if (match && Number.isFinite(Number(match[2]))) service[match[1]] = Number(match[2]);
        }
        timings.service_ms = service;
        const bytes = Number(response.headers.get('X-Styk-Request-Bytes'));
        if (Number.isSafeInteger(bytes) && bytes > 0) timings.request_bytes = bytes;
      }
      timings.worker_ms = performance.now() - started;
      timings.output_bytes = blob.size;
      reply(message.id, {blob, timings});
      config.codecPort?.close();
      config = null;
    } else throw messageError(new Error(''), "errors.documentExportWorker.unknownDocumentExportOperation", {});
  } catch (error) {
    config?.codecPort?.close();
    config = null;
    self.postMessage({id: message.id, ok: false, error: {message: error?.message || String(error), ...errorMessageData(error),
      code: error?.code, status: error?.status, name: error?.name, trapped: error?.trapped === true,
      ...diagnosticDetails(error,stage,stage === 'validate' ? 'invalid_document' : stage === 'serialize' ? 'serialize_failed' : stage === 'request' ? 'backend_unavailable' : 'snapshot_failed')}});
  } finally { running = false; }
});
