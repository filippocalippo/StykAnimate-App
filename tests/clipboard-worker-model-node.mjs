import {parentPort} from 'node:worker_threads';
import {createClipboardWorkerEndpoint} from '../src/clipboard-worker.mjs';
const receive=createClipboardWorkerEndpoint((message,transfer)=>parentPort.postMessage(message,transfer));
parentPort.on('message',receive);
