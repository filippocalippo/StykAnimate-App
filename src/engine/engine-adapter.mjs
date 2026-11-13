/**
 * The page's graphics adapter, asked for when the page starts (src/engine/engine-start.mjs) rather than when the stage
 * starts (docs/APP-START.md "The stage's wait for the graphics process").
 *
 * An adapter takes most of a second to come back on a first launch, and the stage can ask for one only once the engine's
 * WebAssembly is running, which is about half a second into the page. The engine asks through the browser
 * (`navigator.gpu.requestAdapter`, from wgpu), so the request is made here first and its answer handed to the first
 * request the engine makes with the same options. Only that one request is answered so: a second stage (after a lost
 * device) asks the browser again, as an adapter gives one device.
 */

/** The options every engine device asks for its adapter with (styk-wasm `gpu::adapter_options`). */
const STAGE_OPTIONS = Object.freeze({powerPreference: 'high-performance'});

/** Whether `options` asks for the adapter the early request asked for. */
const sameRequest = options => options?.powerPreference === STAGE_OPTIONS.powerPreference && !options.forceFallbackAdapter && !options.featureLevel
  && !options.xrCompatible;

/**
 * Asks `gpu` (the page's `navigator.gpu`) for its adapter now, and answers the next request with the same options with
 * it. Returns the promise of the adapter's description ({vendor, architecture, device, description}), null where the
 * browser gives no adapter; null itself where the page has no WebGPU.
 */
export function askAdapterEarly(gpu = globalThis.navigator?.gpu) {
  if (typeof gpu?.requestAdapter !== 'function') return null;
  // A request that fails is an answer of no adapter: the engine then draws with WebGL2, as for a refused request.
  let asked = null;
  try { asked = gpu.requestAdapter(STAGE_OPTIONS); } catch { /* no adapter */ }
  const early = Promise.resolve(asked).catch(() => null);
  const own = Object.getOwnPropertyDescriptor(gpu, 'requestAdapter');
  Object.defineProperty(gpu, 'requestAdapter', {configurable: true, writable: true, value(options) {
    // Once asked, the browser's own method answers again.
    if (own) Object.defineProperty(gpu, 'requestAdapter', own); else delete gpu.requestAdapter;
    return sameRequest(options) ? early : gpu.requestAdapter(options);
  }});
  return early.then(adapter => {
    if (!adapter) return null;
    const {vendor, architecture, device, description} = adapter.info ?? {};
    return {vendor, architecture, device, description};
  });
}
