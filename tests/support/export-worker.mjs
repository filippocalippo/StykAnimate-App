// The document export worker (src/document-export-worker.mjs) in a Node worker behind the page's `Worker` interface, for tests that
// save through the real worker: it joins the engine's shared memory and writes the file as the app's worker does.
import {Worker as NodeWorker} from 'node:worker_threads';

export class WorkerFacade extends EventTarget {
  /** The page calls `new Worker(url, options)`; the Node worker that runs the export worker is `script` of the subclass (the plain one by default). */
  constructor(...[, , script = '../document-export-node-worker.mjs']) {
    super();
    this.worker = new NodeWorker(new URL(script, import.meta.url), {execArgv: []});
    this.worker.on('message', data => { const event = new Event('message'); event.data = data; this.dispatchEvent(event); });
    this.worker.on('error', error => { const event = new Event('error', {cancelable: true}); event.message = error.message; this.dispatchEvent(event); });
    this.worker.on('messageerror', () => this.dispatchEvent(new Event('messageerror')));
  }
  postMessage(value, transfer) { this.worker.postMessage(value, transfer); }
  terminate() { void this.worker.terminate(); }
}

/** Installs [`WorkerFacade`] as the global `Worker` until `t` ends. */
export function useExportWorker(t, script) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const facade = script ? class extends WorkerFacade { constructor(url, options) { super(url, options, script); } } : WorkerFacade;
  Object.defineProperty(globalThis, 'Worker', {value: facade, configurable: true});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'Worker', previous); else delete globalThis.Worker; });
}
