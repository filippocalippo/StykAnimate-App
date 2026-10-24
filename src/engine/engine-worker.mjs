/** An engine worker thread: joins the shared memory and prepares frames until the engine stops. */
import {initSync, worker_run} from './pkg/styk_engine.js';

self.onmessage = ({data: {module, memory, address, stack}}) => {
  initSync({module, memory, thread_stack_size: stack});
  self.postMessage('ready');
  // Does not return while the engine lives: the thread sleeps inside it when idle.
  worker_run(address);
  self.close();
};
