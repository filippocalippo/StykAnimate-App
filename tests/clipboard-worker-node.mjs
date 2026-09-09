import {parentPort} from 'node:worker_threads';
import {createClipboardWorkerEndpoint} from '../src/clipboard-worker.mjs';

const receive = createClipboardWorkerEndpoint((message, transfer) => parentPort.postMessage(message, transfer), {
  async runRequest(input, {onProgress}) {
    if (input.request.operation === 'busy') {
      onProgress({phase: 'busy'});
      const until = performance.now() + 3000;
      while (performance.now() < until) { /* Worker termination must interrupt synchronous planning. */ }
      return {finished: true};
    }
    onProgress({phase: 'planning', completed: 1});
    return input;
  },
});
parentPort.on('message', receive);
