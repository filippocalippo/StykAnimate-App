import {messageError} from './localized-error.mjs';
/** Page-side owner of the Pivot codec worker.
 *
 * It creates the worker on first use, connects one MessagePort per job, and
 * applies cancellation. On a cross-origin isolated page each job carries a shared
 * flag: cancelling sets it, the codec stops the running request at its next
 * checkpoint, and the worker keeps its imported-source cache. Without shared memory
 * a running request cannot be interrupted, so cancelling the job that is running
 * stops the worker itself, and the next request starts a fresh one (the cache is
 * lost, as when the desktop codec service restarted). If other jobs are waiting on
 * the same worker, terminating would discard their requests, so the cancelled job is
 * only skipped and its running request finishes unobserved.
 */

/** Which codec profile this page runs: 'web' for the web build (marked
 * <meta name="styk-codec" content="browser">, or ?codec=browser on a development
 * page) and 'desktop' otherwise; the desktop app is always 'desktop'.
 * 'web' has the browser build's smaller limits, embeds an import's original in its
 * document and announces the converter's first download; 'desktop' has the desktop
 * limits and keeps originals in the codec's leases. */
export function codecProfile(scope = globalThis) {
  if (scope.stykDesktop) return 'desktop';
  const requested = new URLSearchParams(scope.location?.search ?? '').get('codec')
    ?? scope.document?.querySelector?.('meta[name="styk-codec"]')?.content;
  return requested === 'browser' ? 'web' : 'desktop';
}

export class BrowserCodecHost {
  #worker = null;
  #jobs = new Map();   // job id -> {worker its requests were sent to (null until it links), cancellation flag}
  #busyJob = null;
  #listeners = new Set();
  #createWorker;
  #limits;
  #sharedCancel;

  constructor({createWorker = () => new Worker(new URL('./codec-web-worker.mjs', import.meta.url),
    {type: 'module', name: 'StykAnimate Pivot codec'}), limits = codecProfile(),
  sharedCancel = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'} = {}) {
    this.#createWorker = createWorker;
    this.#limits = limits === 'web' ? 'web' : 'desktop';
    this.#sharedCancel = sharedCancel;
  }

  /** Progress of loading the codec, for the interface. */
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(status) { for (const listener of this.#listeners) listener(status); }

  register(jobId) { this.#jobs.set(jobId, {worker: null, flag: null}); }

  /** A port for the worker running this job. Loading the codec waits for its first request. */
  link(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw messageError(new DOMException('', 'AbortError'), "errors.codecWebHost.theCodecJobWasCancelled", {});
    const {port1, port2} = new MessageChannel();
    const worker = this.#ensure();
    job.worker = worker;
    job.flag ??= this.#sharedCancel ? new Int32Array(new SharedArrayBuffer(4)) : null;
    worker.postMessage({type: 'connect', jobId, port: port2, ...(job.flag ? {cancel: job.flag} : {})}, [port2]);
    return {fields: {codecPort: port1}, transfer: [port1]};
  }

  release(jobId) {
    if (this.#jobs.delete(jobId)) this.#worker?.postMessage({type: 'release', jobId});
  }

  cancel(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return;
    this.#jobs.delete(jobId);
    // Seen by the codec at once, even while it is busy with this job's request.
    if (job.flag) Atomics.store(job.flag, 0, 1);
    if (!this.#worker) return;
    // Skip what is already queued for the job, then let the worker drop its port.
    this.#worker.postMessage({type: 'skip', jobId});
    this.#worker.postMessage({type: 'release', jobId});
    if (job.flag) return;
    // Stopping discards every request queued in this worker. Only jobs that sent
    // requests to it are affected; a job on a worker that already died is gone.
    const othersWaiting = [...this.#jobs.values()].some(other => other.worker === this.#worker);
    if (this.#busyJob === jobId && !othersWaiting) this.#stop('cancelled');
  }

  dispose() { this.#jobs.clear(); this.#stop('disposed'); this.#listeners.clear(); }

  #ensure() {
    if (this.#worker) return this.#worker;
    const worker = this.#createWorker();
    this.#worker = worker;
    worker.addEventListener('message', ({data}) => {
      if (this.#worker !== worker || !data) return;
      if (data.type === 'busy') this.#busyJob = data.jobId;
      else if (data.type === 'idle') this.#busyJob = null;
      else if (data.type === 'status') this.#emit(data);
    });
    const failed = event => {
      if (this.#worker !== worker) return;
      event?.preventDefault?.();
      this.#emit({state: 'failed', message: event?.message || 'The Pivot converter stopped unexpectedly.'});
      this.#stop('failed');
    };
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    worker.postMessage({type: 'configure', limits: this.#limits});
    return worker;
  }

  #stop(reason) {
    const worker = this.#worker;
    this.#worker = null;
    this.#busyJob = null;
    worker?.terminate();
    if (worker) this.#emit({state: 'stopped', reason});
  }
}

let shared = null;
export function browserCodecHost() { return shared ??= new BrowserCodecHost(); }
