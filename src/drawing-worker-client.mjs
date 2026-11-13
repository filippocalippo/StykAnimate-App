import {restoreMessageError, messageError} from './localized-error.mjs';

/** How long a drawing worker with nothing to do stays: its own copy of the drawing engine keeps the
 * memory its largest job grew it to (tens of megabytes each, up to its allowance), and a document has
 * several (pixels, decoding, thumbnails, previews, encoders). A request after the end starts a new one
 * (tens of milliseconds); the encoder's tile cache and the preview's source are rebuilt as after a
 * cancellation. */
export const DRAWING_WORKER_IDLE_MS=10000;

/** Lazy, bounded worker requests shared by pixel operations and preview
 * captures. Cancellation closes this worker; the next request can reopen it.
 * A worker that has had nothing to do for `idleMs` ends the same way, and
 * `instance` (one more for every worker started) tells whoever keeps state in
 * it that it is another worker now. */
export class DrawingWorker {
  constructor(url=new URL('./drawing-worker.mjs',import.meta.url),{maxPending=2,idleMs=DRAWING_WORKER_IDLE_MS}={}) {
    this.url=url;this.maxPending=maxPending;this.idleMs=idleMs;this.next=1;this.pending=new Map();this.instance=0;this.idleTimer=0;
  }
  /** Whether a worker is loaded or loading; false after cancellation closed it. */
  get active(){return Boolean(this.worker);}
  request(kind,payload,{signal,transfer}={}) {
    if(signal?.aborted)return Promise.reject(messageError(new DOMException('', 'AbortError'), "errors.drawingResources.drawingOperationCancelled", {}));
    if(this.pending.size>=this.maxPending)return Promise.reject(messageError(new Error(''), "errors.drawingResources.drawingWorkerIsBusyWaitForTheCurrent", {}));
    clearTimeout(this.idleTimer);this.idleTimer=0;
    if(!this.worker){
      let worker;
      try {worker=this.worker=new Worker(this.url,{type:'module',name:'StykAnimate drawing pixels'});this.instance++;}
      catch(error){return Promise.reject(error);}
      worker.onmessage=({data})=>{
        if(this.worker!==worker){data.bitmap?.close();return;}
        const pending=this.pending.get(data.id);
        if(!pending){data.bitmap?.close();return;}
        const error=data.error?restoreMessageError(new Error(data.error), data):null;
        if(error&&typeof data.code==='string')error.code=data.code;
        if(data.fatal){data.bitmap?.close();this.dispose(error??restoreMessageError(messageError(new Error(''), "errors.drawingResources.drawingWorkerCouldNotLoadRetryTheOperation", {}), data));return;}
        this.pending.delete(data.id);
        if(data.error)data.bitmap?.close();
        pending.finish(error,data);
        this.rest();
      };
      worker.onerror=event=>{
        event.preventDefault();
        if(this.worker===worker)this.dispose((event.message ? new Error(event.message) : messageError(new Error(''), "errors.drawingResources.drawingWorkerStoppedRetryTheOperation", {})));
      };
      worker.onmessageerror=()=>{if(this.worker===worker)this.dispose(messageError(new Error(''), "errors.drawingResources.drawingPixelsCouldNotBeTransferred", {}));};
    }
    return new Promise((resolve,reject)=>{
      const id=this.next++,abort=()=>this.dispose(messageError(new DOMException('', 'AbortError'), "errors.drawingResources.drawingOperationCancelled", {}));
      const timeout=setTimeout(()=>this.dispose(messageError(new Error(''), "errors.drawingResources.drawingWorkerTimedOutRetryTheOperation", {})),120000);
      this.pending.set(id,{finish:(error,result)=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);}});
      signal?.addEventListener('abort',abort,{once:true});
      try {this.worker.postMessage({id,kind,...payload},transfer??[]);}
      catch(error){this.dispose(error);}
    });
  }
  /** With nothing pending, the worker ends once it has rested `idleMs` (a request before then keeps it). */
  rest(){
    if(this.pending.size||!this.worker||!(this.idleMs>0))return;
    clearTimeout(this.idleTimer);
    this.idleTimer=setTimeout(()=>{this.idleTimer=0;if(!this.pending.size&&this.worker){this.worker.terminate();this.worker=null;}},this.idleMs);
    // A timer of its own never keeps a process alive (Node: the tests, the tools).
    this.idleTimer?.unref?.();
  }
  dispose(error=messageError(new DOMException('', 'AbortError'), "errors.drawingResources.drawingResourcesClosed", {})) {
    clearTimeout(this.idleTimer);this.idleTimer=0;
    this.worker?.terminate();this.worker=null;
    for(const pending of this.pending.values())pending.finish(error);
    this.pending.clear();
  }
}
