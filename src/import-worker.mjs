/** Worker side of the file protocol. No scene rendering or UI state lives here. */
import { documentChunks } from './document-transport.mjs';
import {NATIVE_FRAME_CONTENT_TYPE, unpackNativeFrameResponse} from './import-wire.mjs';
const pending = new Map();
const receipts = new Map();

async function sendResult(id, result, signal) {
  const nativeTransfer=result.nativeTransfer; delete result.nativeTransfer;
  if (!nativeTransfer && Number(result.timings?.document_bytes || 0) < 1024 * 1024) { self.postMessage({ id, ok: true, result }); return; }
  const started = performance.now(); let sequence = 0;
  // Definitions contain many tiny records. A 1 MiB clone budget avoids hundreds
  // of mostly empty message round trips; sender work still yields every 2 ms.
  for (const chunk of documentChunks(result.document, {maxBytes: 1024 * 1024, timeBudgetMs: 2})) {
    if (signal.aborted) return;
    const key = `${id}:${sequence}`;
    // Acknowledging each batch bounds queued receiver allocations and gives input
    // and animation tasks room to run between native figure/frame records.
    const acknowledged = new Promise((resolve, reject) => {
      const cancel = () => { receipts.delete(key); reject(new DOMException('Import cancelled.', 'AbortError')); };
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

function errorMessage(error) {
  return {message: error?.message || String(error), code: error?.code, status: error?.status};
}

async function importRequest(message, signal) {
  const started = performance.now();
  if(message.operation==='import' && /\.(nodes|nodemc|stknds|zip)$/i.test(message.filename??'')){
    if(!(message.bytes instanceof ArrayBuffer))throw new Error('The importer did not receive the complete file bytes.');
    const {importStickNodes}=await import('./sticknodes/adapter.mjs');
    return importStickNodes(new Uint8Array(message.bytes),{filename:message.filename,entryIndex:message.entryIndex,signal,onProgress:progress=>self.postMessage({id:message.id,progress})});
  }
  const headers = {Accept: `${NATIVE_FRAME_CONTENT_TYPE}, application/json`};
  if (message.token) headers.Authorization = `Bearer ${message.token}`;
  let path, body;
  if (message.operation === 'import') {
    if (!(message.bytes instanceof ArrayBuffer)) throw new Error('The importer did not receive the complete file bytes.');
    if (typeof message.filename !== 'string') throw new Error('The imported file needs a filename.');
    path = `/api/import?filename=${encodeURIComponent(message.filename)}`;
    headers['Content-Type'] = 'application/octet-stream';
    body = message.bytes;
  } else if (message.operation === 'open') {
    if (typeof message.path !== 'string') throw new Error('The sample needs a file path.');
    path = '/api/open';
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({path: message.path});
  } else throw new Error('Unknown import operation.');
  const response = await fetch(new URL(path, message.baseURL), {method: 'POST', headers, body, signal});
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
    const error = new Error(response.ok ? 'The file service returned an unreadable project.' : `The file service failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok || result?.ok === false) {
    const error = new Error(result?.error?.message || result?.error || result?.message || `Import failed (${response.status}).`);
    error.code = result?.code;
    error.status = response.status;
    throw error;
  }
  if (!result || typeof result !== 'object' || !result.document) throw new Error('The file service returned no editable document.');
  const parsed = performance.now();
  result.timings = {...result.timings, worker_fetch_ms: +(received - started).toFixed(3),
    worker_parse_ms: +(parsed - received).toFixed(3), worker_ms: +(parsed - started).toFixed(3)};
  return result;
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
  importRequest(message, controller.signal).then(async result => {
    if (!controller.signal.aborted) await sendResult(message.id, result, controller.signal);
  }).catch(error => {
    if (!controller.signal.aborted) self.postMessage({id: message.id, ok: false, error: errorMessage(error)});
  }).finally(() => pending.delete(message.id));
});
