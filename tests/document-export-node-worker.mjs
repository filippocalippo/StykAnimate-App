import {parentPort} from 'node:worker_threads';
globalThis.self={postMessage:value=>parentPort.postMessage(value),addEventListener(type,listener){if(type==='message')parentPort.on('message',data=>listener({data}));}};
await import('../src/document-export-worker.mjs');
parentPort.postMessage({ready:true});
