// The document export worker (src/document-export-worker.mjs) in a Node worker behind the page's `Worker` interface, for tests that
// save through the real worker: it joins the engine's shared memory and writes the file as the app's worker does.
import {Worker as NodeWorker} from 'node:worker_threads';

export class WorkerFacade extends EventTarget {
  constructor() {
    super();
    this.worker = new NodeWorker(new URL('../document-export-node-worker.mjs', import.meta.url), {execArgv: []});
    this.worker.on('message', data => { const event = new Event('message'); event.data = data; this.dispatchEvent(event); });
    this.worker.on('error', error => { const event = new Event('error', {cancelable: true}); event.message = error.message; this.dispatchEvent(event); });
    this.worker.on('messageerror', () => this.dispatchEvent(new Event('messageerror')));
  }
  postMessage(value, transfer) { this.worker.postMessage(value, transfer); }
  terminate() { void this.worker.terminate(); }
}

/** Installs [`WorkerFacade`] as the global `Worker` until `t` ends. */
export function useExportWorker(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {value: WorkerFacade, configurable: true});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'Worker', previous); else delete globalThis.Worker; });
}
