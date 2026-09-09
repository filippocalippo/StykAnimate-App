import {clipboardWireChunks, createClipboardWireDecoder} from './clipboard-wire.mjs';
import {CLIPBOARD_CHUNK_BYTES, CLIPBOARD_TRANSFER_BYTES, clipboardChunkBytes, clipboardControlBytes} from './clipboard-worker-client.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaultRun = async (input, options) => (await import('./clipboard-worker-plan.mjs')).runClipboardWorkerRequest(input, options);
// Each reverse ACK already arrives in a new worker event task. Another timer
// per bounded chunk adds avoidable transfer latency without helping UI input.
const pause = () => Promise.resolve();

/** Isolated per-operation receiver. The injected planner is used only by tests;
 * production loads the shared clipboard planner after complete input streams. */
export function createClipboardWorkerEndpoint(postMessage, {runRequest = defaultRun, yieldControl = pause} = {}) {
  let job = null;
  const fail = (error, id) => {
    if (!job || job.failed) return;
    job.failed = true; job.input = null; job.decoder?.dispose(); job.decoder = null; job.ack?.reject(error); job.ack = null;
    postMessage({jobId: job.id, id, type: 'error', error: {
      name: String(error?.name || 'Error').slice(0, 128), message: String(error?.message || error).slice(0, 2000),
      ...(typeof error?.code === 'string' ? {code: error.code.slice(0, 128)} : {})}});
  };
  const ack = message => postMessage({jobId: job.id, id: message.id, type: 'ack', operation: message.operation,
    ...(message.stream === undefined ? {} : {stream: message.stream}), ...(message.sequence === undefined ? {} : {sequence: message.sequence})});
  async function run(message) {
    const active = job, started = performance.now(); let iterator;
    const check = () => {if (job !== active || active.failed) throw new Error('Clipboard worker operation was cancelled.');};
    try {
      active.phase = 'running';
      const onProgress = progress => {check(); clipboardControlBytes(progress); postMessage({jobId: active.id, id: message.id, type: 'progress', progress});};
      const result = await runRequest({...active.input, request: active.request}, {onProgress});
      check(); if (!record(result)) throw new Error('The clipboard planner returned no result record.');
      const planned = performance.now(); active.input = null; active.phase = 'sending';
      let encoding;
      iterator = clipboardWireChunks(result, {maxBytes: CLIPBOARD_CHUNK_BYTES, timeBudgetMs: 2,
        checkCurrent: check, omitRuntimeSegments: true, onTimings: stats => {encoding = stats;}});
      let sequence = 0, bytes = 0;
      for (;;) {
        check(); const step = await iterator.next(); if (step.done) break;
        bytes += clipboardChunkBytes(step.value, sequence);
        if (bytes > active.maxBytes) throw new Error('Clipboard output exceeds its transfer budget.');
        const received = new Promise((resolve, reject) => {active.ack = {id: message.id, sequence, resolve, reject};});
        postMessage({jobId: active.id, id: message.id, type: 'result-chunk', sequence: sequence++, chunk: step.value}, [step.value]);
        await received; await yieldControl();
      }
      check(); active.phase = 'done';
      postMessage({jobId: active.id, id: message.id, type: 'result', sequence,
        timings: {planMs: planned - started, transferMs: performance.now() - planned, totalMs: performance.now() - started,
          outputBytes: bytes, outputLogicalBytes: encoding?.residentBytes, encoding}});
    } catch (error) {fail(error, message.id);}
    finally {await iterator?.return?.();}
  }
  return async message => {
    try {
      if (!record(message) || !Number.isSafeInteger(message.jobId) || message.jobId < 1 || !Number.isSafeInteger(message.id) || message.id < 1)
        throw new Error('Invalid clipboard worker request.');
      if (message.operation === 'start') {
        if (job) throw new Error('The clipboard worker already received a request.');
        job = {id: message.jobId, phase: 'input', input: {}, request: message.request, streams: message.streams,
          streamIndex: 0, sequence: 0, bytes: 0, residentBytes: 0, lastRequestId: message.id, maxBytes: message.maxBytes};
        if (!Array.isArray(job.streams) || job.streams[0] !== 'report' || job.streams.length > 3 ||
            job.streams.some((name, index) => !['report', 'clipboard', 'state'].includes(name) || job.streams.indexOf(name) !== index) ||
            !Number.isSafeInteger(job.maxBytes) || job.maxBytes < 1024 || job.maxBytes > CLIPBOARD_TRANSFER_BYTES)
          throw new Error('Invalid clipboard input streams or transfer budget.');
        clipboardControlBytes(job.request); ack(message); return;
      }
      if (!job || job.failed || message.jobId !== job.id) throw new Error('Clipboard request does not match the worker operation.');
      if (job.receiving) throw new Error('Clipboard input arrived before its acknowledgement.');
      if (message.operation === 'result-ack') {
        const waiting = job.ack;
        if (job.phase !== 'sending' || !waiting || waiting.id !== message.id || waiting.sequence !== message.sequence)
          throw new Error('Clipboard result acknowledgement arrived out of order.');
        job.ack = null; waiting.resolve(); return;
      }
      if (message.id !== job.lastRequestId + 1) throw new Error('Clipboard requests arrived out of order.');
      job.lastRequestId = message.id;
      if (message.operation === 'run') {
        if (job.phase !== 'input' || job.streamIndex !== job.streams.length) throw new Error('Clipboard planning started before all inputs arrived.');
        void run(message); return;
      }
      if (job.phase !== 'input' || message.stream !== job.streams[job.streamIndex] || message.sequence !== job.sequence)
        throw new Error('Clipboard input chunks arrived out of order.');
      if (message.operation === 'chunk') {
        const bytes = clipboardChunkBytes(message.chunk, job.sequence);
        if (job.bytes + bytes > job.maxBytes) throw new Error('Clipboard input exceeds its transfer budget.');
        const active = job;
        if (active.residentBytes >= active.maxBytes * 8) throw new Error('Clipboard input exceeds its resident data budget.');
        active.decoder ??= createClipboardWireDecoder({maxBytes: active.maxBytes, maxResidentBytes: active.maxBytes * 8 - active.residentBytes, timeBudgetMs: 4,
          checkCurrent: () => {if (job !== active || active.failed) throw new Error('Clipboard input was cancelled.');}});
        active.receiving = true;
        try {await active.decoder.push(message.chunk);
          if (job !== active || active.failed) return;
          active.bytes += bytes; active.sequence++; active.receiving = false; ack(message);
        } finally {active.receiving = false;}
      } else if (message.operation === 'end') {
        if (!job.sequence || !job.decoder) throw new Error('Clipboard input stream is incomplete.');
        const value = job.decoder.finish();
        if (!record(value)) throw new Error('Clipboard input stream must be a record.');
        job.input[message.stream] = value; job.residentBytes += job.decoder.stats.residentBytes;
        job.decoder.dispose(); job.decoder = null;
        job.streamIndex++; job.sequence = 0; ack(message);
      } else throw new Error('Unknown clipboard worker operation.');
    } catch (error) {
      if (!job && record(message)) job = {id: message.jobId};
      fail(error, message?.id);
    }
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !globalThis.document) {
  const receive = createClipboardWorkerEndpoint((message, transfer) => self.postMessage(message, transfer));
  self.addEventListener('message', event => receive(event.data));
}
