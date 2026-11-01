/**
 * Asks the browser's graphics process for an adapter and a device, and lets go of both: the first request of a page takes
 * most of a second there, and the interface thread waits for the process while it sets the page's connection up. Asked
 * here the wait is this thread's, and the stage's own request (engine-start.mjs starts this) meets a process that is up.
 * It answers with the adapter's description, or null where there is no adapter.
 */
let info = null;
try {
  const adapter = await self.navigator?.gpu?.requestAdapter({powerPreference: 'high-performance'});
  const {vendor, architecture, device, description} = adapter?.info ?? {};
  if (adapter) info = {vendor, architecture, device, description};
  (await adapter?.requestDevice())?.destroy();
} catch { /* The stage reports a graphics device it cannot get. */ }
self.postMessage(info);
