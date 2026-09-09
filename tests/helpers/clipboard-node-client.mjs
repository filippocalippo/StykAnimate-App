import {Worker} from 'node:worker_threads';
import {ClipboardWorkerClient} from '../../src/clipboard-worker-client.mjs';
export function nodeClipboardClient(options={}) {
  return new ClipboardWorkerClient({yieldControl:()=>new Promise(resolve=>setImmediate(resolve)),...options,workerFactory:()=>{
    const worker=new Worker(new URL('../clipboard-worker-model-node.mjs',import.meta.url)),adapters=new Map();
    return{postMessage:(value,transfer)=>worker.postMessage(value,transfer),terminate:()=>{void worker.terminate();},
      addEventListener(name,callback){const adapter=value=>callback(name==='message'?{data:value}:value);adapters.set(callback,adapter);worker.on(name,adapter);},
      removeEventListener(name,callback){worker.off(name,adapters.get(callback));}};
  }});
}
