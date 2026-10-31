/**
 * Keeps the interface from ending a worker that is inside the engine (docs/engine/threading.md).
 *
 * A worker that joined the engine's shared memory may hold its allocator or one of its locks while a call into the engine runs;
 * `Worker.terminate()` at that moment leaves them held, and every thread that needs them waits for good. The worker therefore
 * marks the stretches in which it calls the engine in a word of shared memory (its guard), and the interface ends a worker only by
 * claiming that word while the worker is outside. One side wins: a worker that finds its guard claimed does not enter, and an
 * interface that finds the worker inside waits (the engine work it was told to stop ends at its next question to the cancel flag,
 * or when it is done, and the worker then releases its thread) and tries again.
 */

const OUTSIDE = 0, INSIDE = 1, CLAIMED = 2;
/** How long a worker may take to give its thread back before the interface looks at ending it. */
export const RELEASE_MS = 5000;

const guards = new WeakMap();
const depths = new WeakMap();

/** The guard of `worker`, made on first ask; send it to the worker with its first message (a `SharedArrayBuffer` view). */
export function workerGuard(worker) {
  let guard = guards.get(worker);
  if (!guard) guards.set(worker, guard = new Int32Array(new SharedArrayBuffer(4)));
  return guard;
}

/**
 * Worker side: runs `run`, a synchronous stretch that calls the engine, with the guard held. Throws an AbortError, without
 * running it, when the interface has claimed the guard to end this worker. A promise `run` returns is not waited for: only its
 * synchronous part is inside. Without a guard (a thread of the engine already, the tests) `run` is simply called.
 */
export function inside(guard, run) {
  if (!guard) return run();
  const depth = depths.get(guard) ?? 0;
  if (depth === 0 && Atomics.compareExchange(guard, 0, OUTSIDE, INSIDE) !== OUTSIDE) throw new DOMException('The worker is being ended.', 'AbortError');
  depths.set(guard, depth + 1);
  try { return run(); } finally {
    depths.set(guard, depth);
    if (depth === 0) Atomics.store(guard, 0, OUTSIDE);
  }
}

/** Worker side: `object` (an instance of the engine's module) whose every method call is made `inside` the guard. */
export function guarded(guard, object) {
  if (!guard || !object) return object;
  return new Proxy(object, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? (...args) => inside(guard, () => value.apply(target, args)) : value;
    },
  });
}

/**
 * Interface side: asks `worker` to give its thread back and end, and ends it when it says it has, or when `ms` have passed and
 * it is outside the engine (it cannot be harmed then; what it held stays allocated). A worker still inside the engine is
 * asked again every `ms`: it finishes the call it is in, releases, and the cancel flag the caller raised makes that short.
 */
export function releaseWorker(worker, ms = RELEASE_MS) {
  const guard = guards.get(worker);
  let timer;
  const end = () => { clearTimeout(timer); worker.terminate(); };
  const watch = () => {
    timer = setTimeout(() => { if (!guard || Atomics.compareExchange(guard, 0, OUTSIDE, CLAIMED) === OUTSIDE) end(); else watch(); }, ms);
    timer.unref?.();
  };
  worker.addEventListener('message', ({data}) => { if (data?.released) end(); });
  try { worker.postMessage({operation: 'release'}); watch(); } catch { end(); }
}
