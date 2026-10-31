import {restoreMessageError, messageError} from './localized-error.mjs';

/** File I/O boundary: bytes transfer to a worker; JSON parsing stays off the UI. */
import { applyDocumentChunk } from './document-transport.mjs';
import {materializeNativeFrames} from './import-wire.mjs';
import {attachRead, openBytes, openJson} from './engine/engine-open.mjs';
import {codecJob} from './codec-job.mjs';
import {codecRequest} from './codec-request.mjs';
import {browserCodecHost, codecProfile} from './codec-web-host.mjs';
/** The SHA-256 of `bytes` as lower-case hexadecimal. */
async function sha256(bytes){
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return [...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export class ImportClient {
  /** `baseURL` is the page origin workers resolve resources against. The Pivot codec runs in a
   * worker of this page (`codecHost`). With `embedSource` (the web build) a Pivot import carries
   * its original in the document instead of a lease in the codec. `readSample` reads a file of
   * the desktop sample list: {ok, name, bytes} or {ok: false, error, code, status}. */
  constructor({baseURL = globalThis.location?.origin, timeoutMs = 180000,
    workerURL = new URL('./import-worker.mjs', import.meta.url), codecHost = null, embedSource = codecProfile() === 'web',
    readSample = path => globalThis.stykDesktop?.readSample?.(path)} = {}) {
    if (!baseURL) throw messageError(new Error(''), "errors.importClient.theImporterRequiresALocalBackendUrl", {});
    this.baseURL = new URL(baseURL, globalThis.location?.href).origin;
    this.codecHost = codecHost;
    this.embedSource = embedSource;
    this.readSample = readSample;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.cancelGeneration = 0;
    /** The documents being opened on the engine, which `cancelPending` stops. */
    this.opening = new Set();
    this.pending = new Map();
    this.sourceOwners = new Map();
    this.activeSourceOwner = null;
    this.sourceRelease = Promise.resolve();
    this.disposed = false;
    this.failure = null;
    this.workerURL=workerURL;this._startWorker();
  }

  _startWorker() {
    const worker = new Worker(this.workerURL, {type: 'module', name: 'StykAnimate file importer'});
    this.worker=worker;this.failure=null;
    worker.addEventListener('message', event => {if(this.worker===worker)this._receive(event.data);});
    worker.addEventListener('messageerror', () => {if(this.worker===worker)this._fail(Object.assign(messageError(new Error(''), "errors.importClient.theImportedProjectCouldNotBeTransferred", {}), { telemetryCode: 'snapshot_failed', telemetryStage: 'prepare' }));});
    worker.addEventListener('error', event => {
      event.preventDefault();
      if(this.worker===worker)this._fail(Object.assign((event.message ? new Error(event.message) : messageError(new Error(''), "errors.importClient.theFileImporterStoppedUnexpectedly")), { telemetryCode: 'worker_failed', telemetryStage: 'decode' }));
    });
  }

  _receive(message) {
    const request = this.pending.get(message?.id);
    if (!request) return;
    if(message.progress){request.onProgress?.(message.progress);return;}
    if(message.ok && message.nativeFrames) {
      if(request.materializing) return;
      request.materializing=true;
      const {buffer,offset}=message.nativeFrames;
      const result=message.complete?{...message.result,document:request.document}:message.result;
      materializeNativeFrames(result,buffer,offset,{isCancelled:()=>this.pending.get(message.id)!==request}).then(result=>{
        if(this.pending.get(message.id)!==request) return;
        this.pending.delete(message.id);clearTimeout(request.timer);this._complete(request,result);
      },error=>{
        if(this.pending.get(message.id)!==request) return;
        this.pending.delete(message.id);clearTimeout(request.timer);this._cancelRequest(request);request.reject(error);
      });
      return;
    }
    if (message.chunk) {
      try {
        request.document = applyDocumentChunk(request.document, message.chunk);
        this.worker.postMessage({ operation: 'ack', id: message.id, sequence: message.sequence });
      } catch (error) {
        this.pending.delete(message.id); clearTimeout(request.timer); this._cancelRequest(request); this.worker.postMessage({ operation: 'cancel', id: message.id }); request.reject(error);
      }
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) { this._complete(request,message.complete ? { ...message.result, document: request.document } : message.result); }
    else {
      this._cancelRequest(request);
      const error = restoreMessageError((message.error?.message ? new Error(message.error?.message) : messageError(new Error(''), "errors.importClient.thisFileCouldNotBeImported")), message.error);
      if (message.error?.code) error.code = message.error.code;
      if (message.error?.status) error.status = message.error.status;
      error.telemetryCode = message.error?.telemetryCode; error.telemetryStage = message.error?.telemetryStage;
      error.telemetryFrames=message.error?.telemetryFrames;error.name=message.error?.name||'Error';
      request.reject(error);
    }
  }

  _complete(request,result) {
    if (request.sourceOwner && result?.sourceId && result.sourceOwner !== request.sourceOwner) {
      this._cancelRequest(request);
      request.reject(messageError(new Error(''), 'errors.documentExportWorker.theFileServiceReturnedAnInvalidSourceRecord', {}));
      return;
    }
    request.backendJob.finish();
    // Native files already carry their original source. Imports without a
    // retained source never leave an empty lease behind.
    if (result?.sourceOwner !== request.sourceOwner || !result?.sourceId) void this.releaseSource(request.sourceOwner);
    request.resolve(result);
  }

  _cancelRequest(request) {
    // Stop work promptly, then repeat its identity in cleanup so the service
    // also orders cancellation before release if this control request fails.
    const cancelled = request.backendJob.cancel();
    if (request.sourceOwner) void this.releaseSource(request.sourceOwner,cancelled,request.backendJob.id);
  }

  /** Transfer the imported original's lifetime to the accepted project. */
  adoptSource(result) {
    const owner = this.sourceOwners.get(result?.sourceOwner) === 'owned' ? result.sourceOwner : null;
    const previous = this.activeSourceOwner;
    this.activeSourceOwner = owner;
    if (previous && previous !== owner) void this.releaseSource(previous);
  }

  /**
   * Several projects stay open (project-tabs-host.mjs): the one leaving the front takes its original with it,
   * and gets it back when it returns. A resting project's original is released only when the project closes.
   */
  detachSource() {
    const owner = this.activeSourceOwner;
    this.activeSourceOwner = null;
    return owner;
  }
  attachSource(owner) {
    this.activeSourceOwner = this.sourceOwners.get(owner) === 'owned' ? owner : null;
  }

  /**
   * Several projects stay open (project-tabs-host.mjs): the one leaving the front takes its original with it,
   * and gets it back when it returns. A resting project's original is released only when the project closes.
   */
  detachSource() {
    const owner = this.activeSourceOwner;
    this.activeSourceOwner = null;
    return owner;
  }
  attachSource(owner) {
    this.activeSourceOwner = this.sourceOwners.get(owner) === 'owned' ? owner : null;
  }

  /** Release an unaccepted result, or the accepted project being replaced. */
  async releaseSource(result,cancelled,jobId) {
    const ownerId = typeof result === 'string' ? result : result?.sourceOwner;
    if (!ownerId || this.sourceOwners.get(ownerId) !== 'owned') return;
    this.sourceOwners.set(ownerId,'releasing');
    if (this.activeSourceOwner === ownerId) this.activeSourceOwner = null;
    // Bulk cancellation shares four small control slots with other clients.
    // Keep one cleanup request in flight and retry temporary transport failure.
    this.sourceRelease = this.sourceRelease.then(async () => {
      await cancelled;
      for (let attempt=0; attempt<3; attempt++) {
        const job = this._codecJob();
        try {
          const link = job.link();
          const response = await codecRequest(link.fields, '/api/source/release', {
            method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerId,...(jobId ? {jobId} : {})}),signal:AbortSignal.timeout(10000),
          });
          if (response.ok || response.status < 500) return;
        } catch { /* A transient transport failure must not drop queued cleanup. */ }
        finally { job.finish(); }
        if (attempt<2) await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
      }
    }).finally(() => this.sourceOwners.delete(ownerId));
    await this.sourceRelease;
  }

  _codecJob() { return codecJob({host: this.codecHost ?? browserCodecHost()}); }

  _fail(error) {
    if(!this.disposed)this.diagnostics?.recovery('import_worker','started');
    this.failure = error;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      this._cancelRequest(request);
      request.reject(error);
    }
    this.pending.clear();
  }

  _request(operation, payload, transfer = [], onProgress, project = false) {
    if (this.disposed) return Promise.reject(messageError(new Error(''), "errors.importClient.theFileImporterHasBeenDisposed", {}));
    if (project && this.sourceOwners.size >= 16) return Promise.reject(Object.assign(
      messageError(new Error(''), 'errors.importClient.thisFileCouldNotBeImported', {}), {code:'source_retention_limit',status:413}));
    // Retry only the user's next operation; never silently repeat a failed one.
    if(this.failure){try{this._startWorker();}catch(error){this.diagnostics?.recovery('import_worker','failed');return Promise.reject(error);}}
    const id = ++this.sequence, backendJob = this._codecJob();
    const sourceOwner = project ? crypto.randomUUID().replaceAll('-','') : undefined;
    if (sourceOwner) this.sourceOwners.set(sourceOwner,'owned');
    return new Promise((resolve, reject) => {
      const timer = this.timeoutMs > 0 ? setTimeout(() => {
        const error = messageError(new Error(''), "errors.importClient.theFileImportTimedOutTryOpeningA", {});
        error.code = 'import_timeout';
        error.telemetryStage='decode';
        this._fail(error);
      }, this.timeoutMs) : null;
      const succeeded=value=>{this.diagnostics?.recovery('import_worker','recovered');resolve(value);};
      const request = {resolve:succeeded, reject, timer, onProgress, backendJob, sourceOwner};
      this.pending.set(id, request);
      try {
        const link = backendJob.link();
        this.worker.postMessage({id, operation, jobId: backendJob.id, sourceOwner, embedSource: this.embedSource, ...link.fields, ...payload}, [...transfer, ...link.transfer]);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this._cancelRequest(request);
        reject(error);
      }
    });
  }

  /**
   * Imports a file. With `open` (`{layerTimeline}`: the editor the document opens in) a project file is opened
   * on the engine (src/engine/engine-open.mjs): the result's `document` is the editor's read view of the
   * normalized document, which `editor.loadAsync` adopts as it is, and a Pivot file's original is kept in the
   * codec for saving it. Figure files and imports that are not opened as projects give the document the
   * file holds.
   */
  async importFile(file,{entryIndex,onProgress,project=false,open=null}={}) {
    if (this.disposed) throw messageError(new Error(''), "errors.importClient.theFileImporterHasBeenDisposed", {});
    if (!file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string') {
      throw messageError(new TypeError(''), "errors.importClient.chooseAStykanimatePivotOrStickNodesFile", {});
    }
    const native = /\.(styk|stkz|stykmov|json)$/i.test(file.name);
    const limit = (native ? 256 : 128) * 1024 * 1024;
    if (Number(file.size) > limit) throw Object.assign(messageError(new Error(''), "errors.importClient.theFileExceedsTheMibImportLimit", {value: limit / 1024 / 1024}), { telemetryCode: 'file_too_large', telemetryStage: 'prepare' });
    const generation=this.cancelGeneration,bytes = await file.arrayBuffer();
    if(generation!==this.cancelGeneration)throw messageError(new DOMException('', 'AbortError'), "errors.importClient.importSuperseded", {});
    return this._import(file.name,bytes,{entryIndex,onProgress,project,open});
  }

  /** The import of a file's bytes: opened on the engine as a project, or decoded to the document it holds. */
  async _import(filename,bytes,{entryIndex,onProgress,project,open}) {
    if (!open) return this._request('import', {filename, bytes,entryIndex}, [bytes],onProgress,project);
    if (/\.(piv|styk|json)$/i.test(filename)) return this._openProject(filename,bytes,{onProgress,project,open});
    // Stick Nodes files decode in the worker; the document they give is opened like any other.
    const result = await this._request('import', {filename, bytes,entryIndex}, [bytes],onProgress,project);
    return result?.document && !/^(stk|stkz|stykmov)$/.test(result.kind) ? this._adopt(result,filename,open) : result;
  }

  /** Opens `bytes` as a project on the engine, keeping a Pivot file's original in the codec for saving. */
  async _openProject(filename,bytes,{onProgress,project,open}) {
    const started=performance.now(),controller=new AbortController(),{signal}=controller;
    this.opening.add(controller);
    let keeping=null,opening=null,keepFailure=null;
    try {
      // The codec keeps a copy of the original while the engine reads the bytes it is given: both need only the bytes.
      const original=project&&/\.piv$/i.test(filename)?bytes.slice(0):null;
      keeping=original?this._keep(filename,original):null;
      // A codec that fails stops the open, and the open fails with the codec's error instead of its own cancellation.
      keeping?.catch(error=>{if(!signal.aborted){keepFailure=error;controller.abort();}});
      opening=await openBytes(bytes,filename,{layerTimeline:open.layerTimeline,signal});
      const decoded=performance.now();
      let kept=keeping?await keeping:null;
      if(kept?.sourceDescription){
        // The web build embeds the original in the document: it is the file the engine read, as the codec fingerprinted it.
        if(await sha256(bytes)!==kept.sourceDescription.sha256)throw messageError(new Error(''), "errors.nativeContainer.embeddedOriginalSourceFingerprintDoesNotMatch", {});
        opening.attachSource(kept.sourceDescription,bytes);
        keeping=kept=null;
      }
      const read=await opening.read({signal,onProgress});
      return this._opened(read,opening,filename,{sourceId:kept?.sourceId??null,sourceOwner:kept?.sourceOwner,sourceBytes:bytes.byteLength,started,decoded});
    } catch (error) {
      opening?.dispose();
      // What the codec kept, even if it is still being kept, is let go once it is done (a stopped open included).
      void keeping?.then(kept=>this.releaseSource(kept),()=>{});
      throw keepFailure??error;
    } finally { this.opening.delete(controller); }
  }

  /** A document the worker decoded, opened as a project on the engine. */
  async _adopt(result,filename,open) {
    const started=performance.now(),controller=new AbortController(),{signal}=controller;
    this.opening.add(controller);
    let opening=null;
    try {
      opening=await openJson(result.document,filename,{layerTimeline:open.layerTimeline,signal});
      const decoded=performance.now(),read=await opening.read({signal});
      const opened=this._opened(read,opening,filename,{sourceId:result.sourceId??null,sourceOwner:result.sourceOwner,sourceBytes:0,started,decoded});
      return {...result,...opened,timings:{...result.timings,...opened.timings,decode_ms:(result.timings?.decode_ms??0)+opened.timings.decode_ms}};
    } catch (error) { opening?.dispose(); throw error; }
    finally { this.opening.delete(controller); }
  }

  /** The import result of an opening whose read view is built. */
  _opened(read,opening,filename,{sourceId,sourceOwner,sourceBytes,started,decoded}) {
    const now=performance.now();
    attachRead(read.report,read);
    return {ok:true,sourceId,...(sourceOwner?{sourceOwner}:{}),filename,kind:opening.kind,version:opening.version,savedDraft:opening.savedDraft,document:read.report,
      timings:{decode_ms:+(decoded-started).toFixed(3),cache_hit:false,total_ms:+(now-started).toFixed(3),source_bytes:sourceBytes,
        read_ms:+(now-decoded).toFixed(3),transport:'engine-open'}};
  }

  /** Keeps the original of a Pivot project in the codec, leased to a new owner (src/import-worker.mjs, `keep`). */
  _keep(filename,bytes) { return this._request('keep',{filename,bytes},[bytes],undefined,true); }

  cancelPending() {
    this.cancelGeneration++;
    for(const controller of this.opening)controller.abort();
    for(const [id,request] of this.pending){clearTimeout(request.timer);this._cancelRequest(request);this.worker.postMessage({operation:'cancel',id});request.reject(messageError(new DOMException('', 'AbortError'), "errors.importClient.importSuperseded", {}));}
    this.pending.clear();
  }

  importNative(file,options) {
    if (!/\.(styk|stkz|stykmov|json)$/i.test(file?.name || '')) {
      return Promise.reject(messageError(new Error(''), "errors.importClient.chooseAStykProjectStkzFigureStykmovMovieclip", {}));
    }
    return this.importFile(file,options);
  }

  /** A file of the desktop sample list: the desktop reads it, and its bytes are an ordinary import under its own name. */
  async openSample(path,{project=false,open=null}={}) {
    if (this.disposed) throw messageError(new Error(''), "errors.importClient.theFileImporterHasBeenDisposed", {});
    if (typeof path !== 'string' || !path) throw messageError(new Error(''), "errors.importClient.chooseAProjectFromTheLibrary", {});
    const generation=this.cancelGeneration,sample=await this.readSample(path);
    if(generation!==this.cancelGeneration)throw messageError(new DOMException('', 'AbortError'), "errors.importClient.importSuperseded", {});
    if (!sample?.ok) {
      // The codec service's own answer for a sample it could not open (desktop/samples.cjs).
      const status=Number(sample?.status)||500;
      const error=sample?.error?new Error(sample.error):messageError(new Error(''), 'errors.importWorker.importFailed', {status});
      throw Object.assign(error,{code:sample?.code,status,telemetryCode:status>=500?'backend_unavailable':'backend_rejected',telemetryStage:'request'});
    }
    const view=sample.bytes,bytes=view.byteOffset===0&&view.byteLength===view.buffer.byteLength?view.buffer:view.slice().buffer;
    return this._import(sample.name,bytes,{project,open});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._fail(messageError(new Error(''), "errors.importClient.theFileImporterHasBeenDisposed", {}));
    for (const owner of this.sourceOwners.keys()) void this.releaseSource(owner);
  }
}
