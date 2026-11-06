// A thread that joins the engine's shared memory and allocates through the module's own allocator (`__wbindgen_malloc` and
// `__wbindgen_free` are what every Rust allocation goes through), for tests/engine-allocator-threads.test.mjs.
import {parentPort, workerData} from 'node:worker_threads';
import {initSync} from '../../src/engine/pkg/styk_engine.js';

const {module, memory, stack} = workerData;
const wasm = initSync({module, memory, thread_stack_size: stack});
const view = () => new Uint8Array(memory.buffer);
const sizeOf = i => 1 + ((i * 37) % 700);

/** Blocks of every small size, each filled with its own pattern. */
function allocate(count, offset = 0) {
  const pointers = new Uint32Array(count), sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const size = sizeOf(i + offset), pointer = wasm.__wbindgen_malloc(size, 8) >>> 0;
    view().fill((i + offset) & 255, pointer, pointer + size);
    pointers[i] = pointer; sizes[i] = size;
  }
  return {pointers, sizes};
}

/** Checks the pattern of each block and gives it back; false when one was overwritten. */
function release({pointers, sizes}, offset = 0) {
  let intact = true;
  for (let i = 0; i < pointers.length; i++) {
    const bytes = view().subarray(pointers[i], pointers[i] + sizes[i]);
    if (bytes.some(b => b !== ((i + offset) & 255))) intact = false;
    wasm.__wbindgen_free(pointers[i], sizes[i], 8);
  }
  return intact;
}

parentPort.on('message', message => {
  if (message.type === 'allocate') {
    // Blocks this thread makes and another frees, and blocks it makes and frees itself, with bigger ones between so that the
    // heap has to grow (every other thread meets the lock while it does).
    const given = allocate(message.count);
    const own = allocate(message.count, 5);
    const big = Array.from({length: message.big}, () => wasm.__wbindgen_malloc(message.bigBytes, 8) >>> 0);
    const intact = release(own, 5);
    for (const pointer of big) wasm.__wbindgen_free(pointer, message.bigBytes, 8);
    parentPort.postMessage({type: 'allocated', given, intact});
  } else if (message.type === 'free') {
    // The blocks of another thread, freed here (they join this thread's lists), then the thread ends the way an export worker does.
    const intact = release(message.given);
    parentPort.postMessage({type: 'freed', intact});
  } else if (message.type === 'end') {
    wasm.__wbindgen_thread_destroy();
    parentPort.postMessage({type: 'ended'});
  }
});
parentPort.postMessage({type: 'ready'});
