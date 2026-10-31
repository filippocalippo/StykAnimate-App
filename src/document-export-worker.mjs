import {errorMessageData, messageError} from './localized-error.mjs';

import {diagnosticDetails} from './telemetry-schema.mjs';
import {makeExportDocument, makeProjectFile, releaseEngineThread} from './engine/engine-document-export.mjs';
import {flattenDrawingFigures} from './drawing-flatten.mjs';
import {codecRequest} from './codec-request.mjs';
import {decodeSourceRecord} from './source-record.mjs';

/**
 * The document export worker. Every file is made by the engine, which the worker joins (src/engine/engine-document-export.mjs):
 * a `.styk` project is written from the snapshot of the editing session the interface took (the Pivot original, which the codec
 * holds for a project opened from Pivot, is fetched here and goes in with it); Pivot `.piv`/`.stk` need the document evaluated, so
 * the engine makes the document of the export from the one it holds at the interface's revision and the worker carries it on to
 * the codec's export request; figure files `.stkz`/`.stykmov` are written by the engine as well.
 */
let config, running = false;
let timings = {};
function reply(id, payload, transfer = []) { self.postMessage({id, ok: true, ...payload}, transfer); }

/** Fetch the retained original binary source for native-save provenance.
 * Returns {meta, bytes} or null when the cache holds no binary source. */
async function fetchOriginalSource() {
  const headers = config.jobId ? {'X-Styk-Job-Id': config.jobId} : {};
  const response = await codecRequest(config, `/api/source?id=${encodeURIComponent(config.sourceId)}`, {headers});
  if (response.status === 422) return null;
  if (!response.ok) throw Object.assign(messageError(new Error(''), "errors.documentExportWorker.theOriginalSourceIsUnavailable", {status: response.status}), {status: response.status});
  const {metadata: meta, bytes} = await decodeSourceRecord(await response.arrayBuffer());
  return {meta, bytes};
}

/** The `.styk` container of the project the interface handed over, written by the engine. */
async function projectFile(message) {
  if (!config.engine || !message.project) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
  const cancelled = () => Boolean(message.cancel && Atomics.load(message.cancel, 0));
  const source = config.sourceId ? await fetchOriginalSource() : null;
  const made = makeProjectFile({join: config.engine.join, cancelled, source: source?.bytes,
    request: {snapshots: message.project.snapshots, scopes: message.project.scopes, name: config.name, source: source?.meta}});
  timings.container_raw_bytes = made.rawBytes;
  return made.bytes;
}

/** The document the export in `config` saves, made by the engine from the document it holds at the interface's revision. */
function engineDocument(message) {
  if (!config.engine || !message.engine) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
  const cancelled = () => Boolean(message.cancel && Atomics.load(message.cancel, 0));
  const piv = ['piv', 'stk'].includes(config.format);
  return makeExportDocument({join: config.engine.join, address: message.engine.address, revision: message.engine.revision, cancelled, request: {
    format: config.format, name: config.name, figureTypeId: config.figureTypeId, figureUid: config.figureUid, figureUids: config.figureUids,
    tick: config.tick, output: piv ? 'codec' : 'container', sourceId: config.sourceId}});
}

/** The body of the codec's export request. Pivot formats cannot carry tile blobs: drawing cels flatten into ordinary
 * sprites at source resolution (largest mip level past the 16 Mpx cap), with anchors rewritten so placement is identical. */
async function codecBody(made) {
  if (!made.drawings) return made.bytes;
  const request = JSON.parse(new TextDecoder().decode(made.bytes)), flattenStats = {}, flattening = performance.now();
  timings.drawing_flattens = await flattenDrawingFigures(request.document, {stats: flattenStats});
  if (flattenStats.downsampled) timings.drawing_downsampled = flattenStats.downsampled;
  timings.drawing_flatten_ms = +(performance.now() - flattening).toFixed(3);
  return new TextEncoder().encode(JSON.stringify(request));
}

self.addEventListener('message', async event => {
  const message = event.data;
  if (message.operation === 'release') {
    // A worker that joined the engine gives its thread back before it ends; no call into the module may follow.
    releaseEngineThread();
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
        const headers = {'Content-Type': 'application/json'};
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
      code: error?.code, status: error?.status, name: error?.name,
      ...diagnosticDetails(error,stage,stage === 'validate' ? 'invalid_document' : stage === 'serialize' ? 'serialize_failed' : stage === 'request' ? 'backend_unavailable' : 'snapshot_failed')}});
  } finally { running = false; }
});
