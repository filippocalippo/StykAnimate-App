import {documentChunks} from './document-transport.mjs';

function abortError(message = 'Document export cancelled.') { return new DOMException(message, 'AbortError'); }
async function yieldToInput() {
  if (globalThis.scheduler?.yield) await scheduler.yield();
  else await new Promise(resolve => setTimeout(resolve, 0));
}

/** Asynchronous, bounded snapshots + worker serialization and HTTP uploads.
 * Callers must abort on every document mutation, including uncommitted gestures.
 * getRevision catches committed edits between chunks and before returning data.
 */
export class DocumentExporter {
  constructor({baseURL = globalThis.location?.origin, token = '', targetRecords = 500,
    targetBytes = 256 * 1024, timeoutMs = 300000} = {}) {
    if (!baseURL) throw new Error('Document export requires the local file service URL.');
    this.baseURL = new URL(baseURL, globalThis.location?.href).origin;
    this.token = token;
    this.targetRecords = targetRecords;
    this.targetBytes = targetBytes;
    this.timeoutMs = timeoutMs;
    this.jobs = new Set();
    this.disposed = false;
    this.lastTimings = null;
  }

  /** @returns {Promise<Blob>} Native .styk/.stkz or Pivot .piv/.stk bytes. */
  async export(report, {sourceId, format = 'styk', name, figureTypeId, figureUid, tick, signal, getRevision} = {}) {
    if (this.disposed) throw new Error('The document exporter has been disposed.');
    if (!report || typeof report !== 'object') throw new TypeError('Export requires an editable document.');
    if (!['piv', 'stk', 'styk', 'stkz'].includes(format)) throw new Error('Choose a .piv, .stk, .styk, or .stkz export.');
    if (signal?.aborted) throw abortError();
    const originalRevision = getRevision?.(), started = performance.now();
    const worker = new Worker(new URL('./document-export-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate document export'});
    let pending, sequence = 0, failure, count = 0, prepMax = 0, postMax = 0, mainWork = 0;
    const fail = error => { failure = error; pending?.reject(error); pending = null; worker.terminate(); };
    const job = {cancel: () => fail(abortError())};
    this.jobs.add(job);
    worker.addEventListener('error', event => { event.preventDefault(); fail(new Error(event.message || 'The document export worker stopped.')); });
    worker.addEventListener('messageerror', () => fail(new Error('The document snapshot could not be transferred.')));
    worker.addEventListener('message', event => {
      if (!pending || pending.id !== event.data?.id) return;
      const request = pending; pending = null;
      if (event.data.ok) request.resolve(event.data);
      else {
        const error = new Error(event.data.error?.message || 'Document export failed.');
        error.code = event.data.error?.code; error.status = event.data.error?.status;
        request.reject(error);
      }
    });
    const check = () => {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;
      if (getRevision && getRevision() !== originalRevision) throw abortError('The document changed during export.');
    };
    const request = (operation, data = {}) => {
      check();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = {id, resolve, reject};
        const before = performance.now();
        try { worker.postMessage({id, operation, ...data}); }
        catch (error) { pending = null; reject(error); }
        const elapsed = performance.now() - before;
        postMax = Math.max(postMax, elapsed); mainWork += elapsed;
      });
    };
    const abort = () => fail(abortError());
    signal?.addEventListener('abort', abort, {once: true});
    const timer = this.timeoutMs > 0 ? setTimeout(() => fail(new Error('Document export timed out.')), this.timeoutMs) : null;
    try {
      await request('start', {options: {sourceId, format, name, figureTypeId, figureUid, tick, baseURL: this.baseURL, token: this.token}});
      const snapshotStarted = performance.now();
      const chunks = documentChunks(report, {maxRecords: this.targetRecords, maxBytes: this.targetBytes,
        timeBudgetMs: 3, omitRuntimeSegments: true});
      for (;;) {
        check();
        const before = performance.now(), next = chunks.next(), elapsed = performance.now() - before;
        prepMax = Math.max(prepMax, elapsed); mainWork += elapsed;
        if (next.done) break;
        check();
        await request('chunk', {chunk: next.value});
        count++;
        // ACK bounds memory, and yielding explicitly gives pending input/UI work
        // a turn even on browsers with aggressively scheduled MessagePort tasks.
        await yieldToInput();
      }
      check();
      const snapshotMs = performance.now() - snapshotStarted;
      const result = await request('export');
      check();
      if (!(result.blob instanceof Blob)) throw new Error('The file service returned no exported document.');
      this.lastTimings = {format, chunks: count, snapshot_ms: snapshotMs, max_chunk_prepare_ms: prepMax,
        max_chunk_post_ms: postMax, main_work_ms: mainWork, total_ms: performance.now() - started, ...result.timings};
      return result.blob;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.jobs.delete(job);
      worker.terminate();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs) job.cancel();
    this.jobs.clear();
  }
}
