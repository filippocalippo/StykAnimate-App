import { parentPort } from 'node:worker_threads';
import { createPlaybackWorkerEndpoint } from '../src/playback-worker.mjs';
const receive = createPlaybackWorkerEndpoint((message, transfer) => parentPort.postMessage(message, transfer));
parentPort.on('message', receive);
