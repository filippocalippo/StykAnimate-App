import {errorMessageData, messageError} from './localized-error.mjs';

import {documentHasRigConstraints} from './rig-constraints.mjs';
import {documentHasSurfaces} from './pivot/surfaces.mjs';
import {applyDocumentChunk} from './document-transport.mjs';
import {diagnosticDetails} from './telemetry-schema.mjs';
import {validateScene} from './pivot/model.mjs';
import {synchronizeExistingDerived} from './document-normalize.mjs';
import {materializePivotDocument} from './pivot-export-materialize.mjs';
import {validateAnimationDocument} from './animation-channels.mjs';
import {materializeStyledFigureForStk} from './pivot-style-materialize.mjs';
import {nativeFigureDocument} from './native-figure.mjs';
import {validateMovieclipGraph,isMovieclip} from './movieclips.mjs';
import {packPoseSequences} from './pose-sequence-storage.mjs';
import {documentHasVfx} from './vfx.mjs';
import {liftDocument} from './document-lift.mjs';
import {nativeFileCodec} from './native-file-codec.mjs';
import {createContainerCompressionCache} from './container-cache.mjs';
import {flattenDrawingFigures} from './drawing-flatten.mjs';
import {codecRequest} from './codec-request.mjs';
import {decodeSourceRecord} from './source-record.mjs';

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
  const portable = config.format === 'styk' ? document : {...document};
  if (config.format !== 'styk') delete portable._stykSource;
  const output = packPoseSequences(portable);
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

self.addEventListener('message', async event => {
  const message = event.data;
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
      if (!document || !config) throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
      const started = performance.now();
      document._styk = {...document._styk, format: 'StykAnimate', format_version: 1,
        ...(config.name ? {name: config.name} : {})};
      for (const frame of document.keyframes || []) for (const object of frame.objects || []) delete object.runtime_segments;
      stage = 'validate';
      if(['piv','stk'].includes(config.format)&&documentHasVfx(document))throw Object.assign(messageError(new Error(''), "errors.documentExportWorker.pivotFilesCannotPreserveVfxSaveAsStyk", {}),{telemetryCode:'unsupported_feature'});
      validateAnimationDocument(document);
      validateMovieclipGraph(document);
      if (config.format === 'stkz' || config.format === 'stykmov') {
        document = nativeFigureDocument(document, config);
        if(config.format==='stykmov'&&!isMovieclip(document.figure_types[0]))throw messageError(new Error(''), "errors.documentExportWorker.selectAMovieclipToExportAsStykmov", {});
        config.sourceId = undefined;
        config.name = document._styk.name;
      }
      if(['piv','stk'].includes(config.format)) {
        if(documentHasRigConstraints(document)||documentHasSurfaces(document))throw Object.assign(messageError(new Error(''), "errors.documentExportWorker.pivotCannotPreserveConnectorsSmartStretchOrOne", {}),{telemetryCode:'unsupported_feature'});
        const visited=new Set(),hasSourceShapes=doc=>{
          if(visited.has(doc))return false;visited.add(doc);
          return doc.figure_types.some(f=>f.segments.some(s=>s._sticknodes)||
            (f._styk?.movieclip&&hasSourceShapes(f._styk.movieclip.document)))||
            doc.keyframes.some(f=>f.objects.some(o=>o._sticknodesSprite));
        };
        if(hasSourceShapes(document))throw Object.assign(messageError(new Error(''), "errors.documentExportWorker.pivotCannotRetainTheseStickNodesShapesSave", {}), {telemetryCode: 'unsupported_feature'});
      }
      if (['piv','stk'].includes(config.format)) {
        // Pivot formats cannot carry tile blobs: drawing cels flatten into
        // ordinary sprites at source resolution (largest mip level past the
        // 16 Mpx cap), with anchors rewritten so placement is identical.
        const flattenStats = {}, flattening = performance.now();
        timings.drawing_flattens = await flattenDrawingFigures(document, {stats: flattenStats});
        if (flattenStats.downsampled) timings.drawing_downsampled = flattenStats.downsampled;
        timings.drawing_flatten_ms = +(performance.now() - flattening).toFixed(3);
      }
      if (config.format === 'piv') {
        const composing = performance.now(), originalFrames = document.keyframes.length;
        document = materializePivotDocument(document);
        // Native source frames acquire editor reference identities on load.
        // They are not Pivot data and must not force a changed-source rewrite.
        // This worker owns the snapshot; live document identities stay intact.
        for (const frame of document.keyframes) if (frame._styk?.frameId !== undefined) {
          const metadata = {...frame._styk}; delete metadata.frameId;
          if (Object.keys(metadata).length) frame._styk = metadata; else delete frame._styk;
        }
        timings.compose_ms = performance.now() - composing;
        timings.source_keyframes = originalFrames; timings.export_keyframes = document.keyframes.length;
      } else if (config.format === 'stk') {
        if(isMovieclip(document.figure_types.find(f=>f.figure_type_id===config.figureTypeId)))
          throw Object.assign(messageError(new Error(''), "errors.documentExportWorker.saveMovieclipsAsStykmovUseBreakApartTo", {}), {telemetryCode: 'unsupported_feature'});
        const resolved = materializeStyledFigureForStk(document, config);
        document = resolved.report; config.figureTypeId = resolved.figureTypeId;
      }
      if(['piv','stk'].includes(config.format)) {
        const figures=config.format==='stk'?document.figure_types.filter(f=>f.figure_type_id===config.figureTypeId):document.figure_types;
        const unsupported=p=>p && p.type!=='solid' && (p.type!=='linear'||p.angle%360!==0||p.stops.length!==2||p.stops[0].offset!==0||p.stops[1].offset!==1);
        // Native text gradients run vertically per glyph. A paint fill spans
        // the entire text run, even when it is a two-stop linear gradient.
        if(figures.some(f=>f.segments.some(s=>unsupported(s.paint)||s.paint&&s.paint.type!=='solid'&&(s.primitive_code===5||s.segment_type==='text'))) || (config.format==='piv' && document.backgrounds?.some(b=>b.paint&&b.paint.type!=='solid')))
          throw Object.assign(messageError(new Error(''), "errors.documentExportWorker.pivotFilesCannotRepresentTheseGradientFillsSave", {}), {telemetryCode: 'unsupported_feature'});
      }
      synchronizeExistingDerived(document);
      // Zero stored frames are a valid native PIV boundary. The materializer
      // already validated the editable placeholder before removing it; retain
      // full figure-table validation without inventing an exported exposure.
      validateScene(config.format === 'piv' && document.keyframes.length === 0
        ? {...document, keyframes: [{objects: [], duration_raw: 0}]} : document);
      timings.normalize_ms = performance.now() - started;
      stage = 'serialize';
      let blob;
      if (['styk', 'stkz', 'stykmov'].includes(config.format)) {
        const building = performance.now();
        blob = new Blob([await buildNativeContainer()]);
        timings.container_build_ms = +(performance.now() - building).toFixed(3);
      } else {
        const serializing = performance.now();
        const body = JSON.stringify({document, sourceId: config.sourceId, format: config.format,
          filename: config.name, figureTypeId: config.figureTypeId});
        timings.stringify_ms = performance.now() - serializing;
        timings.json_characters = body.length;
        // Fetch consumes the large JSON body in this worker. Passing a string or
        // expanded document back to the main thread would recreate the freeze.
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
      code: error?.code, status: error?.status,
      ...diagnosticDetails(error,stage,stage === 'validate' ? 'invalid_document' : stage === 'serialize' ? 'serialize_failed' : stage === 'request' ? 'backend_unavailable' : 'snapshot_failed')}});
  } finally { running = false; }
});
