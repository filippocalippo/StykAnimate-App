/** File I/O boundary: bytes transfer to a worker; JSON parsing stays off the UI. */
import { applyDocumentChunk } from './document-transport.mjs';
import {materializeNativeFrames} from './import-wire.mjs';
export class ImportClient {
  constructor({baseURL = globalThis.location?.origin, token = '', timeoutMs = 180000,
    workerURL = new URL('./import-worker.mjs', import.meta.url)} = {}) {
    if (!baseURL) throw new Error('The importer requires a local backend URL.');
    this.baseURL = new URL(baseURL, globalThis.location?.href).origin;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.disposed = false;
    this.failure = null;
    this.worker = new Worker(workerURL, {type: 'module', name: 'StykAnimate file importer'});
    this.worker.addEventListener('message', event => this._receive(event.data));
    this.worker.addEventListener('messageerror', () => this._fail(new Error('The imported project could not be transferred.')));
    this.worker.addEventListener('error', event => {
      event.preventDefault();
      this._fail(new Error(event.message || 'The file importer stopped unexpectedly.'));
    });
  }

  _receive(message) {
    const request = this.pending.get(message?.id);
    if (!request) return;
    if(message.ok && message.nativeFrames) {
      if(request.materializing) return;
      request.materializing=true;
      const {buffer,offset}=message.nativeFrames;
      const result=message.complete?{...message.result,document:request.document}:message.result;
      materializeNativeFrames(result,buffer,offset,{isCancelled:()=>this.pending.get(message.id)!==request}).then(result=>{
        if(this.pending.get(message.id)!==request) return;
        this.pending.delete(message.id);clearTimeout(request.timer);request.resolve(result);
      },error=>{
        if(this.pending.get(message.id)!==request) return;
        this.pending.delete(message.id);clearTimeout(request.timer);request.reject(error);
      });
      return;
    }
    if (message.chunk) {
      try {
        request.document = applyDocumentChunk(request.document, message.chunk);
        this.worker.postMessage({ operation: 'ack', id: message.id, sequence: message.sequence });
      } catch (error) {
        this.pending.delete(message.id); clearTimeout(request.timer); this.worker.postMessage({ operation: 'cancel', id: message.id }); request.reject(error);
      }
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.complete ? { ...message.result, document: request.document } : message.result);
    else {
      const error = new Error(message.error?.message || 'This file could not be imported.');
      if (message.error?.code) error.code = message.error.code;
      if (message.error?.status) error.status = message.error.status;
      request.reject(error);
    }
  }

  _fail(error) {
    this.failure = error;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  _request(operation, payload, transfer = []) {
    if (this.disposed) return Promise.reject(new Error('The file importer has been disposed.'));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = this.timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        this.worker.postMessage({operation: 'cancel', id});
        const error = new Error('The file import timed out. Try opening a smaller project.');
        error.code = 'import_timeout';
        reject(error);
      }, this.timeoutMs) : null;
      this.pending.set(id, {resolve, reject, timer});
      try {
        this.worker.postMessage({id, operation, baseURL: this.baseURL, token: this.token, ...payload}, transfer);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async importFile(file) {
    if (this.disposed) throw new Error('The file importer has been disposed.');
    if (this.failure) throw this.failure;
    if (!file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string') {
      throw new TypeError('Choose a Pivot animation, stick figure, or StykAnimate project file.');
    }
    const native = /\.(styk|json)$/i.test(file.name);
    const limit = (native ? 256 : 128) * 1024 * 1024;
    if (Number(file.size) > limit) throw new Error(`The file exceeds the ${limit / 1024 / 1024} MiB import limit.`);
    const bytes = await file.arrayBuffer();
    // Transfer ownership rather than structured-cloning a second upload buffer.
    return this._request('import', {filename: file.name, bytes}, [bytes]);
  }

  importNative(file) {
    if (!/\.(styk|json)$/i.test(file?.name || '')) {
      return Promise.reject(new Error('Choose a .styk or .json project file.'));
    }
    return this.importFile(file);
  }

  openSample(path) {
    if (typeof path !== 'string' || !path) return Promise.reject(new Error('Choose a project from the library.'));
    return this._request('open', {path});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._fail(new Error('The file importer has been disposed.'));
  }
}
