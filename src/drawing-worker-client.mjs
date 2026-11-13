import {restoreMessageError, messageError} from './localized-error.mjs';
import {enginePanicked} from './engine/engine-panic.mjs';

/** Lazy, bounded worker requests shared by pixel operations and preview
 * captures. Cancellation closes this worker; the next request can reopen it. */
export class DrawingWorker {
  constructor(url=new URL('./drawing-worker.mjs',import.meta.url),{maxPending=2}={}) {
    this.url=url;this.maxPending=maxPending;this.next=1;this.pending=new Map();
  }
  /** Whether a worker is loaded or loading; false after cancellation closed it. */
  get active(){return Boolean(this.worker);}
  request(kind,payload,{signal,transfer}={}) {
    if(signal?.aborted)return Promise.reject(messageError(new DOMException('', 'AbortError'), "errors.drawingResources.drawingOperationCancelled", {}));
    if(this.pending.size>=this.maxPending)return Promise.reject(messageError(new Error(''), "errors.drawingResources.drawingWorkerIsBusyWaitForTheCurrent", {}));
    if(!this.worker){
      let worker;
      try {worker=this.worker=new Worker(this.url,{type:'module',name:'StykAnimate drawing pixels'});}
      catch(error){return Promise.reject(error);}
      worker.onmessage=({data})=>{
        if(this.worker!==worker){data.bitmap?.close();return;}
        const pending=this.pending.get(data.id);
        if(!pending){data.bitmap?.close();return;}
        const error=data.error?restoreMessageError(new Error(data.error), data):null;
        if(data.panic)enginePanicked(data.panic);
        if(error&&typeof data.code==='string')error.code=data.code;
        if(data.fatal){data.bitmap?.close();this.dispose(error??restoreMessageError(messageError(new Error(''), "errors.drawingResources.drawingWorkerCouldNotLoadRetryTheOperation", {}), data));return;}
        this.pending.delete(data.id);
        if(data.error)data.bitmap?.close();
        pending.finish(error,data);
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
  dispose(error=messageError(new DOMException('', 'AbortError'), "errors.drawingResources.drawingResourcesClosed", {})) {
    this.worker?.terminate();this.worker=null;
    for(const pending of this.pending.values())pending.finish(error);
    this.pending.clear();
  }
}
