/**
 * The StykAnimate engine (docs/ARCHITECTURE.md): the one module that loads the
 * WebAssembly engine and its worker threads. Nothing else imports `./pkg/`.
 *
 * The engine is one WebAssembly module instantiated once per thread over one
 * shared memory. This thread holds the handle and draws; the workers prepare
 * frames and decode files and images. Shared memory needs a cross-origin
 * isolated page (COOP/COEP headers); without it the engine still runs, doing
 * its background work here between frames.
 */
import init, {EditSession, EngineHandle, Stage, api_version} from './pkg/styk_engine.js';
import {declaredMemoryPages} from './engine-memory.mjs';

/** The command/query API this loader was written for. */
const API_VERSION = 1;
/** Each worker's stack: evaluation recurses through nested movieclips. */
const WORKER_STACK_BYTES = 2 * 1024 * 1024;

/** How many preparation threads a device gets: its cores minus the interface thread, at most eight. */
function defaultWorkerCount(cores = globalThis.navigator?.hardwareConcurrency || 4) {
  return Math.max(1, Math.min(8, cores - 1));
}

let loading = null;

/**
 * Loads the engine once per page.
 * @param {{workers?: number, deviceMemory?: number}} [options]
 * @returns {Promise<{handle: EngineHandle, workers: number, threaded: boolean, createStage(canvas: HTMLCanvasElement): Promise<Stage>,
 *   open(bytes: Uint8Array, extension: string, name: string): Promise<object>, whenProgress(seen?: number, timeoutMs?: number): Promise<void>, progressSeen(): number, destroy(): void}>}
 */
export function loadEngine(options = {}) {
  return loading ??= load(options).catch(error => { loading = null; throw error; });
}

/** WebAssembly pages (64 KiB) the engine's shared memory may grow to: 2 GiB, then smaller. */
const MEMORY_MAXIMA = [32768, 16384, 8192];

/**
 * The engine's shared memory. Its maximum is reserved when it is created and can
 * never change (docs/engine/decisions/0014-shared-memory-maximum.md): a device that
 * cannot reserve 2 GiB of address space (mobile WebKit is the risk) gets the largest
 * maximum it accepts.
 * It starts at `initial` pages, the size the module declares (`declaredMemoryPages`):
 * a smaller memory does not link, and the size changes with the module's static data.
 */
function createEngineMemory(initial, maxima = MEMORY_MAXIMA) {
  let failure;
  for (const maximum of maxima) {
    try { return Object.assign(new WebAssembly.Memory({initial, maximum, shared: true}), {maximumBytes: maximum * 65536}); }
    catch (error) { failure = error; }
  }
  throw new Error(`The engine could not reserve its memory: ${failure?.message ?? failure}`);
}

/** The existing progress wait owner. A timeout rechecks readiness, never changes
 * the counter. Interface waits are finite and at most the default 250 ms. */
export function waitForEngineProgress(progress, threaded, seen, timeoutMs = 250) {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(250, timeoutMs)) : 250;
  if (Atomics.load(progress, 0) !== seen || timeout === 0) return Promise.resolve();
  if (threaded && typeof Atomics.waitAsync === 'function') {
    const waiting = Atomics.waitAsync(progress, 0, seen, timeout);
    return waiting.async ? waiting.value.then(() => {}) : Promise.resolve();
  }
  const deadline = performance.now() + timeout;
  return new Promise(resolve => {
    const check = () => {
      const remaining = deadline - performance.now();
      if (Atomics.load(progress, 0) !== seen || remaining <= 0) resolve();
      else setTimeout(check, Math.min(4, remaining));
    };
    setTimeout(check, Math.min(4, timeout));
  });
}

async function load({workers = defaultWorkerCount(), deviceMemory = globalThis.navigator?.deviceMemory} = {}) {
  const source = new URL('./pkg/styk_engine_bg.wasm', import.meta.url);
  const {module, pages} = await compile(source);
  const reserved = createEngineMemory(pages);
  const wasm = await init({module_or_path: module, memory: reserved});
  if (api_version() !== API_VERSION) throw new Error(`The engine module has API ${api_version()}, this page expects ${API_VERSION}. Reload the page.`);
  const memory = wasm.memory;
  // Caches are budgeted by device memory; a memory that could reserve 1 GiB or less budgets like a 2 GiB device.
  const budget = reserved.maximumBytes <= 2 ** 30 ? Math.min(deviceMemory ?? 2, 2) : deviceMemory;
  const handle = new EngineHandle(budget ?? undefined, reserved.maximumBytes);
  // Threads need the memory to be shareable with workers, which a page that is not cross-origin isolated cannot do.
  const threaded = workers > 0 && globalThis.crossOriginIsolated !== false && typeof Worker === 'function';
  const pool = [];
  if (threaded) {
    await Promise.all(Array.from({length: workers}, () => new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./engine-worker.mjs', import.meta.url), {type: 'module', name: 'styk-engine'});
      worker.onmessage = () => resolve();
      worker.onerror = event => reject(new Error(`An engine worker failed to start: ${event.message}`));
      worker.postMessage({module, memory, address: handle.address(), stack: WORKER_STACK_BYTES});
      pool.push(worker);
    })));
  }
  const progress = new Int32Array(memory.buffer, handle.progress_address(), 1);
  let pumping = false;
  /** Without workers, background work runs here in slices that leave the frame its time. */
  const pump = () => {
    if (threaded || pumping) return;
    pumping = true;
    const slice = () => {
      const started = performance.now();
      let more = true;
      while (more && performance.now() - started < 6) more = handle.step();
      if (more) setTimeout(slice, 0); else pumping = false;
    };
    setTimeout(slice, 0);
  };
  /** The progress counter now: read it before checking for a result, then wait with it. */
  const progressSeen = () => Atomics.load(progress, 0);
  /**
   * Resolves when background work has finished something since the counter read `seen`
   * (by default, since the call). Pass a value read before checking for a result, or work
   * finishing in between is only noticed at the timeout (default 250 ms).
   * A shorter timeout also retries Busy admission when no progress was published.
   */
  const whenProgress = (seen = progressSeen(), timeoutMs = 250) => {
    pump();
    return waitForEngineProgress(progress, threaded, seen, timeoutMs);
  };
  return {
    handle, workers: pool.length, threaded, pump, whenProgress, progressSeen,
    /**
     * What another thread needs to join the engine (the export worker, engine-export.mjs):
     * the compiled module, the shared memory, a worker's stack size and the address of
     * the progress counter. Call `handle.address()` for the engine itself, once per thread.
     */
    join: {module, memory, stack: WORKER_STACK_BYTES, progress: handle.progress_address()},
    /** The engine's memory now, and the most it may grow to (chosen by createEngineMemory). */
    get memoryBytes() { return memory.buffer.byteLength; },
    memoryMaximumBytes: reserved.maximumBytes,
    /** Where the memory is: linear memory, bytes the allocator handed out, and what the engine holds of it. */
    memory: () => JSON.parse(handle.memory()),
    createStage: canvas => Stage.create(canvas, handle),
    /** An edit session on the document `json` exactly as the editor holds it (D19). */
    editSession: (json, state, revision) => EditSession.from_document(json, state, revision),
    destroy() {
      handle.stop();
      for (const worker of pool) worker.terminate();
      loading = null;
    },
  };
}

/** The compiled module and the pages of memory it declares. */
async function compile(source) {
  // Node (unit tests) reads the file; browsers compile while downloading.
  if (source.protocol === 'file:') {
    const {readFile} = await import('node:fs/promises');
    const bytes = await readFile(source);
    return {module: await WebAssembly.compile(bytes), pages: declaredMemoryPages(bytes)};
  }
  const response = await fetch(source, {credentials: 'same-origin'});
  // A second reader of the same download: the import section says how large the memory starts.
  const bytes = response.clone().arrayBuffer();
  let module;
  try { module = await WebAssembly.compileStreaming(response); }
  catch { module = await WebAssembly.compile(await bytes); }
  return {module, pages: declaredMemoryPages(await bytes)};
}
