import {errorMessageData, messageError} from './localized-error.mjs';

import {applyDocumentChunk} from './document-transport.mjs';
import {diagnosticDetails} from './telemetry-schema.mjs';
import {validateScene} from './pivot/model.mjs';
import {synchronizeExistingDerived} from './document-normalize.mjs';
import {validateAnimationDocument} from './animation-channels.mjs';
import {validateMovieclipGraph} from './movieclips.mjs';
import {makeExportDocument, releaseEngineThread} from './engine/engine-document-export.mjs';
import {packPoseSequences} from './pose-sequence-storage.mjs';
import {liftDocument} from './document-lift.mjs';
import {nativeFileCodec} from './native-file-codec.mjs';
import {createContainerCompressionCache} from './container-cache.mjs';
import {flattenDrawingFigures} from './drawing-flatten.mjs';
import {codecRequest} from './codec-request.mjs';
import {decodeSourceRecord} from './source-record.mjs';

/**
 * The document export worker. A `.styk` save is built here from the document the interface sends in bounded chunks
 * (the editable document, container-written by the Rust writer). The other formats (Pivot `.piv`/`.stk`, figure files
 * `.stkz`/`.stykmov`) need the document evaluated, which is the engine's: the worker joins it
 * (src/engine/engine-document-export.mjs), asks for the document of the export from the one the engine holds at the
 * interface's revision, and carries it on (the codec's export request, or the container writer).
 */
let document, config, running = false;
let timings = {};
const compressionCache = createContainerCompressionCache({maxBytes: 64 * 1024 * 1024, maxEntries: 8});
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

/** Build the native container in this worker: the editable document becomes a
 * compact skeleton plus binary sections instead of one large JSON payload, and the Rust
 * container writer (native-file-codec.mjs) compresses and frames them. It also checks that a
 * figure file holds a self-contained figure. */
async function buildNativeContainer() {
  // A figure file arrives with its poses stored once and without the project's source (the engine made it so).
  const output = config.format === 'styk' ? packPoseSequences(document) : {...document};
  output._styk = {...output._styk, format: 'StykAnimate', format_version: 1};
  let preBlobs = [], sourceMeta = null;
  if (config.format === 'styk' && config.sourceId) {
    const source = await fetchOriginalSource();
    if (source) { preBlobs = [source.bytes]; sourceMeta = source.meta; }
  }
  if (sourceMeta) output._stykSource = {...sourceMeta, source_base64: preBlobs[0]};
  const lifted = liftDocument(output, {preBlobs});
  const stats = {};
  const file = await nativeFileCodec.save(lifted, config.format, {cache: compressionCache, stats});
  Object.assign(timings, stats);
  return file;
}

/** The document the export in `config` saves, made by the engine from the document it holds at the interface's revision. */
function engineDocument(message) {
  if (!config.engine || !message.engine) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
  const cancelled = () => Boolean(message.cancel && Atomics.load(message.cancel, 0));
  const piv = ['piv', 'stk'].includes(config.format);
  return makeExportDocument({join: config.engine.join, address: message.engine.address, revision: message.engine.revision, cancelled, request: {
    format: config.format, name: config.name, figureTypeId: config.figureTypeId, figureUid: config.figureUid, figureUids: config.figureUids,
    tick: config.tick, output: piv ? 'codec' : 'document', sourceId: config.sourceId}});
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
      document = undefined;
      timings = {};
      compressionCache.restore(message.cacheEntries);
      reply(message.id);
    } else if (message.operation === 'chunk') {
      document = applyDocumentChunk(document, message.chunk);
      reply(message.id);
    } else if (message.operation === 'export') {
      if (!config) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
      const started = performance.now();
      let body;
      if (config.format === 'styk') {
        if (!document) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
        document._styk = {...document._styk, format: 'StykAnimate', format_version: 1,
          ...(config.name ? {name: config.name} : {})};
        for (const frame of document.keyframes || []) for (const object of frame.objects || []) delete object.runtime_segments;
        stage = 'validate';
        validateAnimationDocument(document);
        validateMovieclipGraph(document);
        synchronizeExistingDerived(document);
        validateScene(document);
        timings.normalize_ms = performance.now() - started;
      } else {
        // The engine bakes, validates and refuses; this worker carries the result on.
        stage = 'validate';
        const made = engineDocument(message);
        timings.normalize_ms = timings.compose_ms = performance.now() - started;
        if (['stkz', 'stykmov'].includes(config.format)) {
          document = JSON.parse(new TextDecoder().decode(made.bytes));
          config.sourceId = undefined;
          config.name = document._styk.name;
        } else {
          body = await codecBody(made);
        }
      }
      stage = 'serialize';
      let blob;
      if (['styk', 'stkz', 'stykmov'].includes(config.format)) {
        const building = performance.now();
        blob = new Blob([await buildNativeContainer()]);
        timings.container_build_ms = +(performance.now() - building).toFixed(3);
      } else {
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
      document = null;
      const cacheEntries = compressionCache.take();
      reply(message.id, {blob, timings, cacheEntries}, cacheEntries.map(entry => entry.bytes.buffer));
      config.codecPort?.close();
      config = null;
    } else throw messageError(new Error(''), "errors.documentExportWorker.unknownDocumentExportOperation", {});
  } catch (error) {
    document = null;
    config?.codecPort?.close();
    config = null;
    self.postMessage({id: message.id, ok: false, error: {message: error?.message || String(error), ...errorMessageData(error),
      code: error?.code, status: error?.status, name: error?.name,
      ...diagnosticDetails(error,stage,stage === 'validate' ? 'invalid_document' : stage === 'serialize' ? 'serialize_failed' : stage === 'request' ? 'backend_unavailable' : 'snapshot_failed')}});
  } finally { running = false; }
});
