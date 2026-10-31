import {restoreMessageError, messageError} from './localized-error.mjs';

import {drawingBarrier} from './drawing-resources.mjs';
import {codecJob} from './codec-job.mjs';
import {browserCodecHost} from './codec-web-host.mjs';
import {registeredEngine, holdsRevision} from './engine/engine-open.mjs';
import {snapshotDocument} from './engine/engine-owner.mjs';
import {releaseSnapshots} from './engine/engine-document-export.mjs';

function abortError(message = 'Document export cancelled.') { return new DOMException(message, 'AbortError'); }
/** The formats whose document the engine makes from the one it holds at the editor's revision: they need it evaluated
 * (docs/engine/document.md). A `.styk` project needs no evaluation: it is written from the snapshot of the editing session. */
const ENGINE_FORMATS = new Set(['piv', 'stk', 'stkz', 'stykmov']);
/** How long a worker that joined the engine has to give its thread back before it is ended. */
const RELEASE_MS = 5000;
async function yieldToInput() {
  if (globalThis.scheduler?.yield) await scheduler.yield();
  else await new Promise(resolve => setTimeout(resolve, 0));
}

/** Document exports on a worker that joined the engine, and codec requests.
 * Callers must abort on every document mutation, including uncommitted gestures.
 * getRevision catches committed edits before the work starts and before returning data.
 * The Pivot codec runs in a worker of this page (`codecHost`, codec-web-host.mjs).
 * A `.styk` save is written by the engine from a snapshot of the editing session of `report` (the interface thread copies
 * nothing: the snapshot is a handle on the session's copy-on-write tree). Pivot and figure files are made by the engine from the
 * document it holds at `revision` (the editor's). Nothing of the document crosses to the worker in either case.
 */
export class DocumentExporter {
  constructor({codecHost = null, engine = null, timeoutMs = 300000, idleMs = 30000, maxQueued = 4} = {}) {
    if (!Number.isFinite(idleMs) || idleMs < 0 || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 16)
      throw new RangeError('Invalid document export worker capacity.');
    this.codecHost = codecHost;
    this.timeoutMs = timeoutMs;
    this.jobs = new Set();
    this.disposed = false;
    this.lastTimings = null;
    this.idleMs = idleMs;
    this.maxQueued = maxQueued;
    this.queue = [];
    this.active = false;
    this.sequence = 0;
    this.engine = engine ?? registeredEngine();
    this.joined = new WeakSet();
  }

  _terminateWorker() {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    if (worker) this._retire(worker);
    this.worker = null;
  }

  /** Ends a worker. One that joined the engine is told to give its thread back first, and the engine work it is in the middle of
   * to stop: a thread of the shared memory ended mid-call could hold the engine's allocator. */
  _retire(worker) {
    if (this.cancelFlag) Atomics.store(this.cancelFlag, 0, 1);
    if (!this.joined.has(worker)) { worker.terminate(); return; }
    const timer = setTimeout(() => worker.terminate(), RELEASE_MS);
    timer.unref?.();
    worker.addEventListener('message', ({data}) => { if (data?.released) { clearTimeout(timer); worker.terminate(); } });
    try { worker.postMessage({operation: 'release'}); } catch { clearTimeout(timer); worker.terminate(); }
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
    if (this.worker) {
      if (this.disposed || this.idleMs <= 0) this._terminateWorker();
      else {
        this.idleTimer = setTimeout(() => this._terminateWorker(), this.idleMs);
        this.idleTimer.unref?.();
      }
    }
  }

  /** @param {{reports: object[], typeIds: number[]}} [scopes] `.styk` only: the documents the movieclips being edited were entered
   * from (`reports`, outermost first) and the movieclip of each that the next document is the document of (`typeIds`): the
   * project is written with them folded in, as a recovery copy stores it.
   * @returns {Promise<Blob>} Native .styk/.stkz or Pivot .piv/.stk bytes. */
  async export(report, {sourceId, format = 'styk', name, figureTypeId, figureUid, figureUids, tick, signal, getRevision, revision, scopes} = {}) {
    if (this.disposed) throw messageError(new Error(''), "errors.documentExport.theDocumentExporterHasBeenDisposed", {});
    if (!report || typeof report !== 'object') throw messageError(new TypeError(''), "errors.documentExport.exportRequiresAnEditableDocument", {});
    if (!['piv', 'stk', 'styk', 'stkz', 'stykmov'].includes(format)) throw messageError(new Error(''), "errors.documentExport.chooseAPivStkStykStkzOrStykmov", {});
    if (ENGINE_FORMATS.has(format) && !Number.isSafeInteger(revision)) throw messageError(new TypeError(''), "errors.documentExport.exportRequiresTheEditorRevision", {});
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
      return await this._export(report, {sourceId, format, name, figureTypeId, figureUid, figureUids, tick, signal, getRevision, originalRevision, started, revision, scopes});
    } catch (error) {
      if (acquired) this._terminateWorker();
      throw error;
    } finally {
      this.jobs.delete(job);
      if (acquired) this._release();
    }
  }

  async _export(report, {sourceId, format, name, figureTypeId, figureUid, figureUids, tick, signal, getRevision, originalRevision, started, revision, scopes}) {
    // The engine makes every file on the worker: it joins the shared memory and is told, with the export, which engine and
    // revision, or which snapshots of sessions (and a flag, in that memory, that stops it). A page that is not cross-origin
    // isolated cannot share the memory with a worker (nor make the flag), so it makes no file.
    const engine = this.engine;
    if (!engine?.join || globalThis.crossOriginIsolated === false) throw Object.assign(messageError(new Error(''), "errors.documentExport.theEngineCannotMakeThisFileHere", {}), {telemetryCode: 'engine_failed', telemetryStage: 'prepare'});
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
    const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
    this.cancelFlag = cancelFlag;
    const backendJob = codecJob({host: this.codecHost ?? browserCodecHost()});
    let pending, failure, completed = false, postMax = 0, mainWork = 0, snapshots = [];
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
      await request('start', {options: {sourceId, format, name, figureTypeId, figureUid, figureUids, tick, jobId: backendJob.id, engine: {join: engine.join}, ...link.fields}}, link.transfer);
      this.joined.add(worker);
      check();
      const snapshotStarted = performance.now();
      let work;
      if (format === 'styk') {
        // The session hands over the tree it holds now; the interface thread copies and walks nothing (D7).
        snapshots = [...(scopes?.reports ?? []), report].map(snapshotDocument);
        if (snapshots.includes(undefined)) {
          snapshots = snapshots.filter(token => token !== undefined);
          throw messageError(new Error(''), "errors.documentExportWorker.theDocumentSnapshotWasNotInitialized", {});
        }
        work = {project: {snapshots, scopes: scopes?.typeIds ?? []}, cancel: cancelFlag};
      } else {
        // The session publishes every change at the editor's revision; one still on its way is waited for briefly.
        for (let waited = 0; !holdsRevision(engine, revision); waited += 16) {
          if (waited > 2000) throw abortError('The document changed during export.');
          check();
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        work = {engine: {address: engine.handle.address(), revision}, cancel: cancelFlag};
      }
      check();
      const snapshotMs = performance.now() - snapshotStarted;
      const result = await request('export', work);
      check();
      if (!(result.blob instanceof Blob)) throw messageError(new Error(''), "errors.documentExport.theFileServiceReturnedNoExportedDocument", {});
      this.lastTimings = {format, reused_worker: reusedWorker, snapshot_ms: snapshotMs,
        max_chunk_post_ms: postMax, main_work_ms: mainWork, total_ms: performance.now() - started, ...result.timings};
      backendJob.finish();
      completed = true;
      return result.blob;
    } finally {
      // A snapshot the worker did not take (a save stopped before it began) is let go; one it took is gone already.
      releaseSnapshots(snapshots);
      clearTimeout(timer);
      if (this.cancelFlag === cancelFlag) this.cancelFlag = null;
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
