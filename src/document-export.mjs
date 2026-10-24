import {restoreMessageError, messageError} from './localized-error.mjs';

import {documentChunks} from './document-transport.mjs';
import {drawingBarrier} from './drawing-resources.mjs';
import {codecJob} from './codec-job.mjs';
import {browserCodecHost} from './codec-web-host.mjs';
import {createContainerCompressionCache} from './container-cache.mjs';

function abortError(message = 'Document export cancelled.') { return new DOMException(message, 'AbortError'); }
async function yieldToInput() {
  if (globalThis.scheduler?.yield) await scheduler.yield();
  else await new Promise(resolve => setTimeout(resolve, 0));
}

/** Asynchronous, bounded snapshots + worker serialization and codec requests.
 * Callers must abort on every document mutation, including uncommitted gestures.
 * getRevision catches committed edits between chunks and before returning data.
 * The Pivot codec runs in a worker of this page (`codecHost`, codec-web-host.mjs).
 */
export class DocumentExporter {
  constructor({codecHost = null, targetRecords = 2000,
    targetBytes = 1024 * 1024, timeoutMs = 300000, idleMs = 30000, maxQueued = 4, workerByteBudget = 8 * 1024 * 1024} = {}) {
    if (!Number.isFinite(idleMs) || idleMs < 0 || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 16 ||
      !Number.isSafeInteger(workerByteBudget) || workerByteBudget <= 0)
      throw new RangeError('Invalid document export worker capacity.');
    this.codecHost = codecHost;
    this.targetRecords = targetRecords;
    this.targetBytes = targetBytes;
    this.timeoutMs = timeoutMs;
    this.jobs = new Set();
    this.disposed = false;
    this.lastTimings = null;
    this.idleMs = idleMs;
    this.maxQueued = maxQueued;
    this.queue = [];
    this.active = false;
    this.sequence = 0;
    this.workerByteBudget = workerByteBudget;
    this.workerBytes = 0;
    // Only immutable, content-addressed compressed bytes survive retirement.
    // Editable snapshots and codec heaps stay inside each worker's lifetime.
    this.compressionCache = createContainerCompressionCache({maxBytes: 64 * 1024 * 1024, maxEntries: 8});
  }

  _terminateWorker({clearCache = true} = {}) {
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = null;
    this.workerBytes = 0;
    if (clearCache) this.compressionCache.clear();
  }

  _acquire(signal) {
    if (signal.aborted) return Promise.reject(abortError());
    if (!this.active) {
      this.active = true;
      clearTimeout(this.idleTimer);
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued)
      return Promise.reject(Object.assign(new Error('Too many document exports are waiting.'), {code: 'export_busy'}));
    return new Promise((resolve, reject) => {
      const entry = {resolve, reject, signal};
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', entry.abort, {once: true});
      this.queue.push(entry);
    });
  }

  _release() {
    const next = this.queue.shift();
    if (next) {
      next.signal.removeEventListener('abort', next.abort);
      next.resolve();
      return;
    }
    this.active = false;
    if (this.worker || this.compressionCache.size) {
      if (this.disposed || this.idleMs <= 0) this._terminateWorker();
      else {
        this.idleTimer = setTimeout(() => this._terminateWorker(), this.idleMs);
        this.idleTimer.unref?.();
      }
    }
  }

  /** @returns {Promise<Blob>} Native .styk/.stkz or Pivot .piv/.stk bytes. */
  async export(report, {sourceId, format = 'styk', name, figureTypeId, figureUid, figureUids, tick, signal, getRevision} = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.documentExport.theDocumentExporterHasBeenDisposed", {});
    if (!report || typeof report !== 'object') throw messageError(new TypeError(''), "errors.documentExport.exportRequiresAnEditableDocument", {});
    if (!['piv', 'stk', 'styk', 'stkz', 'stykmov'].includes(format)) throw messageError(new Error(''), "errors.documentExport.chooseAPivStkStykStkzOrStykmov", {});
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const job = {cancel: () => controller.abort()};
    this.jobs.add(job);
    const started = performance.now();
    let acquired = false;
    try {
      const originalRevision = getRevision?.();
      await this._acquire(signal);
      acquired = true;
      await drawingBarrier(report,{signal});
      if(signal.aborted||getRevision&&getRevision()!==originalRevision)throw abortError('The document changed while preparing drawing pixels.');
      return await this._export(report, {sourceId, format, name, figureTypeId, figureUid, figureUids, tick, signal, getRevision, originalRevision, started});
    } catch (error) {
      if (acquired) this._terminateWorker();
      throw error;
    } finally {
      this.jobs.delete(job);
      if (acquired) this._release();
    }
  }

  async _export(report, {sourceId, format, name, figureTypeId, figureUid, figureUids, tick, signal, getRevision, originalRevision, started}) {
    const reusedWorker = Boolean(this.worker);
    const worker = this.worker ??= new Worker(new URL('./document-export-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate document export'});
    if (!reusedWorker) {
      const idleFailure = event => {
        if (this.worker === worker && !this.active) {
          event.preventDefault?.();
          this._terminateWorker();
        }
      };
      worker.addEventListener('error', idleFailure);
      worker.addEventListener('messageerror', idleFailure);
    }
    const backendJob = codecJob({host: this.codecHost ?? browserCodecHost()});
    let pending, failure, completed = false, count = 0, prepMax = 0, postMax = 0, mainWork = 0;
    const fail = error => { failure ??= error; backendJob.cancel(); pending?.reject(failure); pending = null; this._terminateWorker(); };
    const onError = event => { event.preventDefault(); fail(Object.assign((event.message ? new Error(event.message) : messageError(new Error(''), "errors.documentExport.theDocumentExportWorkerStopped")), { telemetryCode: 'worker_failed', telemetryStage: 'serialize' })); };
    const onMessageError = () => fail(Object.assign(messageError(new Error(''), "errors.documentExport.theDocumentSnapshotCouldNotBeTransferred", {}), { telemetryCode: 'snapshot_failed', telemetryStage: 'prepare' }));
    const onMessage = event => {
      if (!pending || pending.id !== event.data?.id) return;
      const request = pending; pending = null;
      if (event.data.ok) request.resolve(event.data);
      else {
        const error = restoreMessageError((event.data.error?.message ? new Error(event.data.error?.message) : messageError(new Error(''), "errors.documentExport.documentExportFailed")), event.data.error);
        error.code = event.data.error?.code; error.status = event.data.error?.status;
        error.telemetryCode = event.data.error?.telemetryCode; error.telemetryStage = event.data.error?.telemetryStage;
        error.telemetryFrames=event.data.error?.telemetryFrames;error.name=event.data.error?.name||'Error';
        request.reject(error);
      }
    };
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    worker.addEventListener('message', onMessage);
    const check = () => {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;
      if (getRevision && getRevision() !== originalRevision) throw abortError('The document changed during export.');
    };
    const request = (operation, data = {}, transfer = []) => {
      check();
      return new Promise((resolve, reject) => {
        const id = ++this.sequence;
        pending = {id, resolve, reject};
        const before = performance.now();
        try { worker.postMessage({id, operation, ...data}, transfer); }
        catch (error) { pending = null; reject(error); }
        const elapsed = performance.now() - before;
        postMax = Math.max(postMax, elapsed); mainWork += elapsed;
      });
    };
    const abort = () => fail(abortError());
    signal?.addEventListener('abort', abort, {once: true});
    const timer = this.timeoutMs > 0 ? setTimeout(() => fail(Object.assign(messageError(new Error(''), "errors.documentExport.documentExportTimedOut", {}), { telemetryCode: 'timeout', telemetryStage: 'serialize' })), this.timeoutMs) : null;
    try {
      const link = backendJob.link();
      // The cached blocks move to the worker for this export and come back with its result.
      const cacheEntries = this.compressionCache.take();
      await request('start', {options: {sourceId, format, name, figureTypeId, figureUid, figureUids, tick, jobId: backendJob.id, ...link.fields}, cacheEntries},
        [...link.transfer, ...cacheEntries.map(entry => entry.bytes.buffer)]);
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
      if (!(result.blob instanceof Blob)) throw messageError(new Error(''), "errors.documentExport.theFileServiceReturnedNoExportedDocument", {});
      this.lastTimings = {format, reused_worker: reusedWorker, chunks: count, snapshot_ms: snapshotMs, max_chunk_prepare_ms: prepMax,
        max_chunk_post_ms: postMax, main_work_ms: mainWork, total_ms: performance.now() - started, ...result.timings};
      backendJob.finish();
      this.compressionCache.restore(result.cacheEntries);
      const rawBytes = result.timings?.container_raw_bytes ?? (result.timings?.json_characters || 0) * 2;
      this.workerBytes += Number.isSafeInteger(rawBytes) && rawBytes >= 0 ? rawBytes : this.workerByteBudget;
      if (this.workerBytes >= this.workerByteBudget) this._terminateWorker({clearCache: false});
      completed = true;
      return result.blob;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      backendJob.cancel();
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      worker.removeEventListener('message', onMessage);
      if (!completed) this._terminateWorker();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs) job.cancel();
    this.jobs.clear();
    this._terminateWorker();
  }
}
