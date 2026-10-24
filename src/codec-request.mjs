import {restoreMessageError, messageError} from './localized-error.mjs';

/** One request to the Pivot codec, from a worker.
 *
 * The codec runs in a worker of the page (codec-web-host.mjs). A job carries a
 * MessagePort to it and requests travel over that port as they would over HTTP:
 * method, path, headers and body. The caller gets a standard Response, so status,
 * headers and bodies are read as they always were and the transport does not leak
 * into import or export logic.
 *
 * An ArrayBuffer or typed-array body is transferred, not copied: the codec consumes
 * the upload and the caller must not reuse it afterwards.
 */
const NO_BODY = new Set([101, 204, 205, 304]);
const conversations = new WeakMap();

export function codecRequest(config, path, init = {}) {
  if (!config?.codecPort) return Promise.reject(Object.assign(messageError(new TypeError(''), "errors.codecRequest.theCodecIsNotConnected", {}), {name: 'TypeError'}));
  return requestOverPort(config.codecPort, path, init);
}

function conversation(port) {
  let state = conversations.get(port);
  if (state) return state;
  state = {sequence: 0, pending: new Map()};
  port.addEventListener('message', event => {
    const message = event.data, request = state.pending.get(message?.id);
    if (!request) return;
    state.pending.delete(message.id);
    request.settle(message);
  });
  port.start();
  conversations.set(port, state);
  return state;
}

function encodeBody(body) {
  if (body == null) return {bytes: new Uint8Array(0), transfer: []};
  if (typeof body === 'string') { const bytes = new TextEncoder().encode(body); return {bytes, transfer: [bytes.buffer]}; }
  if (body instanceof ArrayBuffer) return {bytes: body, transfer: [body]};
  if (ArrayBuffer.isView(body)) return {bytes: body, transfer: [body.buffer]};
  throw messageError(new TypeError(''), "errors.codecRequest.theCodecAcceptsTextOrBinaryRequestBodies", {});
}

function requestOverPort(port, path, {method = 'GET', headers = {}, body, signal} = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? messageError(new DOMException('', 'AbortError'), "errors.codecRequest.theCodecRequestWasCancelled", {}));
  let encoded;
  try { encoded = encodeBody(body); } catch (error) { return Promise.reject(error); }
  const {bytes, transfer} = encoded;
  const state = conversation(port);
  const id = ++state.sequence;
  return new Promise((resolve, reject) => {
    let onAbort;
    const settle = message => {
      signal?.removeEventListener('abort', onAbort);
      if (message.error) { reject(Object.assign(restoreMessageError(new Error(message.error), message), {name: 'TypeError'})); return; }
      const status = message.status;
      resolve(new Response(NO_BODY.has(status) ? null : message.body, {status, headers: message.headers}));
    };
    onAbort = () => { state.pending.delete(id); reject(signal.reason ?? messageError(new DOMException('', 'AbortError'), "errors.codecRequest.theCodecRequestWasCancelled", {})); };
    signal?.addEventListener('abort', onAbort, {once: true});
    state.pending.set(id, {settle});
    try {
      port.postMessage({id, method, path, headers: Object.fromEntries(new Headers(headers)), body: bytes}, transfer);
    } catch (error) {
      state.pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}
