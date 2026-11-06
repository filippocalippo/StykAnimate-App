// The document export worker (src/document-export-worker.mjs) in a Node worker whose engine is cut off in the middle of a save, as a trap
// cuts it off: the second time WebAssembly calls the clock (`save_project` has reserved its memory by then, and has not prepared the
// document yet), the clock throws a real `WebAssembly.RuntimeError`, which unwinds through the engine's frames without running a destructor,
// exactly the state a panic's `unreachable` leaves: the reservation is never dropped.
import {parentPort} from 'node:worker_threads';
globalThis.self = {postMessage: value => parentPort.postMessage(value), close: () => parentPort.close(), addEventListener(type, listener) { if (type === 'message') parentPort.on('message', data => listener({data})); }};
// An `unreachable` instruction in a real module: the error a trap throws.
const trap = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 116, 114, 97, 112, 0, 0, 10, 5, 1, 3, 0, 0, 11]))).exports.trap;
const realNow = performance.now.bind(performance);
let fromWasm = 0;
performance.now = () => {
  if (new Error().stack.includes('wasm-function') && ++fromWasm === 2) trap();
  return realNow();
};
await import('../../src/document-export-worker.mjs');
parentPort.postMessage({ready: true});
