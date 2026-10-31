/**
 * Asks the browser's graphics process for an adapter and a device, and lets go of both: the first request of a page takes
 * most of a second there, and the interface thread waits for the process while it sets the page's connection up. Asked
 * here the wait is this thread's, and the stage's own request (engine-start.mjs starts this) meets a process that is up.
 */
try {
  const adapter = await self.navigator?.gpu?.requestAdapter({powerPreference: 'high-performance'});
  (await adapter?.requestDevice())?.destroy();
} catch { /* The stage reports a graphics device it cannot get. */ }
self.postMessage('done');
