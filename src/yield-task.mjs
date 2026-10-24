/** Gives the browser its turn: input and painting run before the caller continues. */
export const yieldLoadTask = globalThis.scheduler?.yield
  ? () => globalThis.scheduler.yield()
  : () => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
