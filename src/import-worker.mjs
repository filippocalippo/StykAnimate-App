import {errorMessageData, messageError, restoreMessageError} from './localized-error.mjs';

/** Worker side of the file protocol. No scene rendering or UI state lives here. */
import { documentChunks } from './document-transport.mjs';
import {diagnosticDetails} from './telemetry-schema.mjs';
import {NATIVE_FRAME_CONTENT_TYPE, unpackNativeFrameResponse} from './import-wire.mjs';
import {nativeFileCodec} from './native-file-codec.mjs';
import {codecRequest} from './codec-request.mjs';
import {bytesToBase64} from './base64.mjs';
import {decodeSourceRecord} from './source-record.mjs';
const pending = new Map();
const receipts = new Map();

async function sendResult(id, result, signal) {
  const nativeTransfer=result.nativeTransfer; delete result.nativeTransfer;
  if (!nativeTransfer && Number(result.timings?.document_bytes || 0) < 1024 * 1024) { self.postMessage({ id, ok: true, result }); return; }
  const started = performance.now(); let sequence = 0;
  // 4 MiB clone packets cut the acknowledged round trips on dense scenes;
  // sender work still yields every 2 ms so the channel stays responsive.
  for (const chunk of documentChunks(result.document, {maxBytes: 4 * 1024 * 1024, timeBudgetMs: 2, sharedFigures:true})) {
    if (signal.aborted) return;
    const key = `${id}:${sequence}`;
    // Acknowledging each batch bounds queued receiver allocations and gives input
    // and animation tasks room to run between native figure/frame records.
    const acknowledged = new Promise((resolve, reject) => {
      const cancel = () => { receipts.delete(key); reject(messageError(new DOMException('', 'AbortError'), "errors.editorLoad.importCancelled", {})); };
      receipts.set(key, () => { signal.removeEventListener('abort', cancel); resolve(); });
      signal.addEventListener('abort', cancel, { once: true });
    });
    self.postMessage({ id, ok: true, chunk, sequence });
    await acknowledged; sequence++;
  }
  if (signal.aborted) return;
  const { document, ...metadata } = result;
  metadata.timings = { ...metadata.timings, worker_transfer_ms: +(performance.now() - started).toFixed(3), document_chunks: sequence };
  self.postMessage({ id, ok: true, complete: true, result: metadata,
    ...(nativeTransfer?{nativeFrames:nativeTransfer}:{}) },nativeTransfer?[nativeTransfer.buffer]:[]);
}

function errorMessage(error, stage) {
  return {message: error?.message || String(error), ...errorMessageData(error), code: error?.code, status: error?.status,
    ...diagnosticDetails(error,stage,stage === 'prepare' ? 'snapshot_failed' : 'decode_failed')};
}

/** The error a codec answer that is not a success stands for. */
function codecFailure(response, result) {
  const error = restoreMessageError(result?.error?.message || result?.error || result?.message ? new Error(result?.error?.message || result?.error || result?.message) : messageError(new Error(''), 'errors.importWorker.importFailed', {status:response.status}), result?.error && typeof result.error === 'object' ? result.error : result);
  error.code = result?.code;
  error.status = response.status;
  error.telemetryCode = response.status >= 500 ? 'backend_unavailable' : 'backend_rejected'; error.telemetryStage = 'request';
  return error;
}

/** Keeps the original of a Pivot project in the codec, leased to the owner, for saving the document the engine read from it. */
async function keepSource(message, signal) {
  if (!(message.bytes instanceof ArrayBuffer)) throw messageError(new Error(''), "errors.importWorker.theImporterDidNotReceiveTheCompleteFile", {});
  const headers = {'Content-Type': 'application/octet-stream', 'X-Styk-Job-Id': message.jobId, 'X-Styk-Source-Owner': message.sourceOwner};
  const response = await codecRequest(message, `/api/source/keep?filename=${encodeURIComponent(message.filename)}`, {method: 'POST', headers, body: message.bytes, signal}).catch(error => {
    error.telemetryCode = 'backend_unavailable'; error.telemetryStage = 'request'; throw error;
  });
  let result;
  try { result = JSON.parse(await response.text()); }
  catch {
    const error = messageError(new Error(''), 'errors.importWorker.serviceFailed', {status:response.status});
    error.status = response.status; error.telemetryCode = 'backend_unavailable'; error.telemetryStage = 'request';
    throw error;
  }
  if (!response.ok || result?.ok === false) throw codecFailure(response, result);
  if (!message.embedSource) return result;
  // The web build keeps no lease in the codec, which a page that is not cross-origin isolated restarts on
  // cancellation: the project carries its original, which the page has, with the codec's description of it.
  const sourceHeaders = {'X-Styk-Job-Id': message.jobId};
  const record = await codecRequest(message, `/api/source?id=${encodeURIComponent(result.sourceId)}`, {headers: sourceHeaders, signal});
  if (!record.ok) throw Object.assign(messageError(new Error(''), 'errors.documentExportWorker.theFileServiceReturnedAnInvalidSourceRecord', {}), {status: record.status});
  const source = decodeSourceRecord(await record.arrayBuffer());
  await codecRequest(message, '/api/source/release', {method: 'POST', headers: {...sourceHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({ownerId: result.sourceOwner}), signal});
  return {ok: true, sourceId: null, filename: result.filename, kind: result.kind, version: result.version, sourceDescription: source.metadata};
}

async function importRequest(message, signal) {
  const started = performance.now();
  if(message.operation==='keep')return keepSource(message, signal);
  if(message.operation==='import' && /\.(nodes|nodemc|stknds|zip)$/i.test(message.filename??'')){
    if(!(message.bytes instanceof ArrayBuffer))throw messageError(new Error(''), "errors.importWorker.theImporterDidNotReceiveTheCompleteFile", {});
    const {importStickNodes}=await import('./sticknodes/adapter.mjs');
    return importStickNodes(new Uint8Array(message.bytes),{filename:message.filename,entryIndex:message.entryIndex,signal,onProgress:progress=>self.postMessage({id:message.id,progress})});
  }
  const headers = {Accept: `${NATIVE_FRAME_CONTENT_TYPE}, application/json`};
  if (message.jobId) headers['X-Styk-Job-Id'] = message.jobId;
  if (message.sourceOwner) headers['X-Styk-Source-Owner'] = message.sourceOwner;
  let path, body;
  if (message.operation === 'import') {
    if (!(message.bytes instanceof ArrayBuffer)) throw messageError(new Error(''), "errors.importWorker.theImporterDidNotReceiveTheCompleteFile", {});
    if (typeof message.filename !== 'string') throw messageError(new Error(''), "errors.importWorker.theImportedFileNeedsAFilename", {});
    const nativeKind = /\.(styk|stkz|stykmov)$/i.exec(message.filename)?.[1]?.toLowerCase();
    if (nativeKind) {
      // Native containers open in this worker, in Rust (native-file-codec.mjs): verify, inflate and
      // normalize there instead of round-tripping a full JSON document through the codec worker.
      const decodeStarted = performance.now();
      const opened = await nativeFileCodec.open(new Uint8Array(message.bytes), nativeKind);
      const parsed = performance.now();
      return {ok: true, sourceId: null, filename: message.filename, kind: nativeKind, version: opened.document.version,
        document: opened.document,
        timings: {decode_ms: +(parsed - decodeStarted).toFixed(3), cache_hit: false,
          total_ms: +(parsed - started).toFixed(3), source_bytes: message.bytes.byteLength,
          document_bytes: opened.materializedBytes, transport: `local-container-v${opened.version}`,
          worker_fetch_ms: 0, worker_parse_ms: +(parsed - decodeStarted).toFixed(3), worker_ms: +(parsed - started).toFixed(3)}};
    }
    path = `/api/import?filename=${encodeURIComponent(message.filename)}`;
    headers['Content-Type'] = 'application/octet-stream';
    body = message.bytes;
  } else throw messageError(new Error(''), "errors.importWorker.unknownImportOperation", {});
  const response = await codecRequest(message, path, {method: 'POST', headers, body, signal}).catch(error => {
    error.telemetryCode = 'backend_unavailable'; error.telemetryStage = 'request'; throw error;
  });
  if(response.ok && response.headers.get('Content-Type')?.split(';')[0]===NATIVE_FRAME_CONTENT_TYPE) {
    const buffer=await response.arrayBuffer(), received=performance.now();
    const {result,offset}=unpackNativeFrameResponse(buffer), parsed=performance.now();
    result.timings={...result.timings,worker_fetch_ms:+(received-started).toFixed(3),
      worker_parse_ms:+(parsed-received).toFixed(3),worker_ms:+(parsed-started).toFixed(3),
      wire_bytes:buffer.byteLength,document_chunks:0,worker_transfer_ms:0};
    result.nativeTransfer={buffer,offset}; return result;
  }
  const text = await response.text();
  const received = performance.now();
  let result;
  try { result = JSON.parse(text); }
  catch {
    const error = messageError(new Error(''), response.ok ? 'errors.importWorker.unreadableProject' : 'errors.importWorker.serviceFailed', {status:response.status});
    error.status = response.status;
    error.telemetryCode = response.ok ? 'decode_failed' : response.status >= 500 ? 'backend_unavailable' : 'backend_rejected'; error.telemetryStage = response.ok ? 'decode' : 'request';
    throw error;
  }
  if (!response.ok || result?.ok === false) throw codecFailure(response, result);
  if (!result || typeof result !== 'object' || !result.document) throw messageError(new Error(''), "errors.importWorker.theFileServiceReturnedNoEditableDocument", {});
  // Native source bytes are embedded in the document, including JSON aliases
  // and the service fallback for unavailable container codecs.
  if (['styk','stkz','stykmov'].includes(result.kind)) result.sourceId = null;
  const parsed = performance.now();
  result.timings = {...result.timings, worker_fetch_ms: +(received - started).toFixed(3),
    worker_parse_ms: +(parsed - received).toFixed(3), worker_ms: +(parsed - started).toFixed(3)};
  return result;
}

async function embedBrowserSource(result,message,signal) {
  if (!message.embedSource || !result.sourceOwner || !result.sourceId) return;
  // The web build keeps no lease in the codec, which a page that is not
  // cross-origin isolated restarts on cancellation: the editable project
  // carries its verified original before it is published to the page.
  const headers = {'X-Styk-Job-Id':message.jobId};
  const response = await codecRequest(message, `/api/source?id=${encodeURIComponent(result.sourceId)}`, {headers,signal});
  if (!response.ok) throw Object.assign(messageError(new Error(''), 'errors.documentExportWorker.theFileServiceReturnedAnInvalidSourceRecord', {}), {status:response.status});
  const source = decodeSourceRecord(await response.arrayBuffer());
  // The fingerprint the codec recorded must match the bytes that crossed to this worker.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source.bytes));
  if ([...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') !== source.metadata.sha256)
    throw messageError(new Error(''), "errors.nativeContainer.embeddedOriginalSourceFingerprintDoesNotMatch", {});
  result.document._stykSource = {...source.metadata,source_base64:bytesToBase64(source.bytes)};
  result.timings.document_bytes = Number(result.timings.document_bytes || 0) + result.document._stykSource.source_base64.length;
  await codecRequest(message, '/api/source/release', {method:'POST',headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({ownerId:result.sourceOwner}),signal});
  result.sourceId = null;
  delete result.sourceOwner;
}

self.addEventListener('message', event => {
  const message = event.data;
  if (!message || !Number.isInteger(message.id)) return;
  if (message.operation === 'ack') {
    const key = `${message.id}:${message.sequence}`; receipts.get(key)?.(); receipts.delete(key); return;
  }
  if (message.operation === 'cancel') {
    pending.get(message.id)?.abort();
    return;
  }
  const controller = new AbortController();
  pending.set(message.id, controller);
  let stage = 'decode';
  importRequest(message, controller.signal).then(async result => {
    stage = 'prepare';
    if (!controller.signal.aborted && message.operation === 'import') await embedBrowserSource(result,message,controller.signal);
    if (!controller.signal.aborted) await sendResult(message.id, result, controller.signal);
  }).catch(error => {
    if (!controller.signal.aborted) self.postMessage({id: message.id, ok: false, error: errorMessage(error, stage)});
  }).finally(() => pending.delete(message.id));
});
