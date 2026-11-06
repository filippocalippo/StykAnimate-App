/** The Pivot codec in WebAssembly (engine/crates/styk-codec-wasm, built into
 * src/engine/pkg/ by scripts/engine-build.mjs).
 *
 * The module loads on the first request, never earlier, and this turns one request
 * into one response. It knows nothing about Workers, ports or the page, so the worker
 * shell and the Node tests drive it identically.
 *
 * `loadModule()` resolves the module's initialised wasm-bindgen glue (`PivotCodec`,
 * `__wbg_reset_state`). `limits` is 'web' (the browser build's) or 'desktop'. A failed
 * load is retried by the next request. A trap (a panic aborts; memory runs out)
 * leaves the instance unusable: that request answers 500 and the next one runs on a
 * fresh instance, with an empty source cache, as a restarted codec service would.
 */
const JSON_HEADERS = {'Content-Type': 'application/json; charset=utf-8'};
const encoder = new TextEncoder();
const NOT_CANCELLED = {cancelled: () => false};

function failure(status, code, error) {
  return {status, headers: JSON_HEADERS, body: encoder.encode(JSON.stringify({ok: false, error, code}))};
}

function bytesOf(body) {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array(0);
}

export function createCodecEngine({loadModule, limits = 'web', onStatus = () => {}}) {
  let booting = null;

  async function boot() {
    onStatus({state: 'loading', stage: 'runtime'});
    const glue = await loadModule();
    onStatus({state: 'loading', stage: 'codec'});
    const codec = new glue.PivotCodec(limits);
    onStatus({state: 'ready'});
    return {glue, codec};
  }

  const runtime = () => booting ??= boot().catch(error => { booting = null; onStatus({state: 'failed', message: error?.message}); throw error; });

  return {
    /** `cancel.cancelled()` is polled while the request runs; once true it answers 499.
     * @returns {Promise<{status: number, headers: object, body: Uint8Array}>} Never rejects for codec errors. */
    async handle({method, path, headers = {}, body, cancel = NOT_CANCELLED}) {
      let engine;
      try { engine = await runtime(); }
      catch (error) {
        return failure(503, 'codec_unavailable', `The Pivot converter could not be loaded (${error?.message || 'unknown error'}). Check your connection and try again.`);
      }
      let response;
      try {
        response = engine.codec.request(method, path, JSON.stringify(headers), bytesOf(body), cancel);
        // takeBody copies the bytes out of WebAssembly memory: the buffer is safe to transfer.
        return {status: response.status, headers: Object.fromEntries(JSON.parse(response.headers)), body: response.takeBody()};
      } catch (error) {
        // The instance trapped and cannot be trusted; the next request gets a fresh one.
        booting = null;
        try { engine.glue.__wbg_reset_state(); } catch { /* The next boot reports a failure itself. */ }
        onStatus({state: 'failed', message: error?.message});
        return failure(500, 'codec_error', 'The project operation failed.');
      } finally {
        try { response?.free(); } catch { /* Already released with its instance. */ }
      }
    },
  };
}
