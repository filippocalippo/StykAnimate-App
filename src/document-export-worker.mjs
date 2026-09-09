import {applyDocumentChunk} from './document-transport.mjs';
import {validateScene} from './pivot/model.mjs';
import {synchronizeExistingDerived} from './document-normalize.mjs';
import {materializePivotDocument} from './pivot-export-materialize.mjs';
import {validateAnimationDocument} from './animation-channels.mjs';
import {materializeStyledFigureForStk} from './pivot-style-materialize.mjs';
import {nativeFigureDocument} from './native-figure.mjs';

let document, config, running = false;
const timings = {};
function reply(id, payload) { self.postMessage({id, ok: true, ...payload}); }

self.addEventListener('message', async event => {
  const message = event.data;
  if (running) { self.postMessage({id: message.id, ok: false, error: {message: 'The document export worker is busy.'}}); return; }
  running = true;
  try {
    if (message.operation === 'start') {
      config = message.options;
      document = undefined;
      reply(message.id);
    } else if (message.operation === 'chunk') {
      document = applyDocumentChunk(document, message.chunk);
      reply(message.id);
    } else if (message.operation === 'export') {
      if (!document || !config) throw new Error('The document snapshot was not initialized.');
      const started = performance.now();
      document._styk = {...document._styk, format: 'StykAnimate', format_version: 1,
        ...(config.name ? {name: config.name} : {})};
      for (const frame of document.keyframes || []) for (const object of frame.objects || []) delete object.runtime_segments;
      validateAnimationDocument(document);
      if (config.format === 'stkz') {
        document = nativeFigureDocument(document, config);
        config.sourceId = undefined;
        config.name = document._styk.name;
      }
      if (config.format === 'piv') {
        const composing = performance.now(), originalFrames = document.keyframes.length;
        document = materializePivotDocument(document);
        timings.compose_ms = performance.now() - composing;
        timings.source_keyframes = originalFrames; timings.export_keyframes = document.keyframes.length;
      } else if (config.format === 'stk') {
        const resolved = materializeStyledFigureForStk(document, config);
        document = resolved.report; config.figureTypeId = resolved.figureTypeId;
      }
      if(['piv','stk'].includes(config.format)) {
        const figures=config.format==='stk'?document.figure_types.filter(f=>f.figure_type_id===config.figureTypeId):document.figure_types;
        const unsupported=p=>p && p.type!=='solid' && (p.type!=='linear'||p.angle%360!==0||p.stops.length!==2||p.stops[0].offset!==0||p.stops[1].offset!==1);
        if(figures.some(f=>f.segments.some(s=>unsupported(s.paint))) || (config.format==='piv' && document.backgrounds?.some(b=>b.paint&&b.paint.type!=='solid')))
          throw new Error('Pivot files cannot represent these gradient fills. Save as .styk to keep editable gradients, or export SVG, PNG or video to preserve their appearance.');
      }
      synchronizeExistingDerived(document);
      // Zero stored frames are a valid native PIV boundary. The materializer
      // already validated the editable placeholder before removing it; retain
      // full figure-table validation without inventing an exported exposure.
      validateScene(config.format === 'piv' && document.keyframes.length === 0
        ? {...document, keyframes: [{objects: [], duration_raw: 0}]} : document);
      timings.normalize_ms = performance.now() - started;
      const serializing = performance.now();
      const body = JSON.stringify({document, sourceId: config.sourceId, format: config.format,
        filename: config.name, figureTypeId: config.figureTypeId});
      timings.stringify_ms = performance.now() - serializing;
      timings.json_characters = body.length;
      // Fetch consumes the large JSON body in this worker. Passing a string or
      // expanded document back to the main thread would recreate the freeze.
      const sending = performance.now();
      const headers = {'Content-Type': 'application/json'};
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      const response = await fetch(new URL('/api/export', config.baseURL), {method: 'POST', headers, body});
      if (!response.ok) {
        const text = await response.text();
        let details;
        try { details = JSON.parse(text); } catch { /* Preserve status for non-JSON failures. */ }
        const error = new Error(details?.error?.message || details?.error || `Document export failed (${response.status}).`);
        error.status = response.status; error.code = details?.code;
        throw error;
      }
      const blob = await response.blob();
      timings.fetch_ms = performance.now() - sending;
      timings.worker_ms = performance.now() - started;
      timings.output_bytes = blob.size;
      document = null;
      reply(message.id, {blob, timings});
    } else throw new Error('Unknown document export operation.');
  } catch (error) {
    document = null;
    self.postMessage({id: message.id, ok: false, error: {message: error?.message || String(error),
      code: error?.code, status: error?.status}});
  } finally { running = false; }
});
