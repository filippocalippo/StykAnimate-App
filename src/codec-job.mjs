/** The UI owns cancellation even while the codec is busy with a job.
 *
 * A job is one import or export against the Pivot codec, which runs in a worker of
 * this page (codec-web-host.mjs). `link()` returns what the worker running the job
 * needs to reach the codec: a MessagePort. Callers spread `link().fields` into the
 * worker message and add `link().transfer` to its transfer list. */
import {browserCodecHost} from './codec-web-host.mjs';

export function codecJob({host = browserCodecHost()} = {}) {
  const id = crypto.randomUUID().replaceAll('-', '');
  let settled = false, cancellation;
  host.register(id);
  return {id,
    link() { return host.link(id); },
    finish() { settled = true; host.release(id); },
    cancel() {
      if (settled) return cancellation;
      settled = true;
      host.cancel(id);
      return cancellation = Promise.resolve();
    },
  };
}
