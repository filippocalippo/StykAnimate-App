/** Figure-bounds callbacks of the alignment and camera-centering commands (docs/engine/editing.md).
 * The app's own callback (`boundsOf` in src/app.mjs) is registered here with `markAppBounds`
 * and reaches the engine as `{"@boundsCallback": "app"}`: the engine measures the figures
 * itself (styk-edit `bounds.rs`). Any other callback is the editor's: `captureEditBounds` retains its
 * completed measurements as bounded data for the recorders to replay (no geometry is built here).
 */
const optionIndex = {centerCamera: 2, alignSelection: 2, alignFiguresInFrames: 3};
export const MAX_BOUNDS_SAMPLES = 8192;
export const APP_BOUNDS = Object.freeze({'@boundsCallback': 'app'});
const appCallbacks = new WeakSet();
/** Registers the app's bounds callback (the engine measures the document's figures as the app
 * does once its images and drawings have loaded). */
export function markAppBounds(callback) { appCallbacks.add(callback); return callback; }
/** What the engine receives for a callback: the marker when it is the app's, else nothing. */
export const appBoundsMarker = callback => appCallbacks.has(callback) ? APP_BOUNDS : undefined;
const fields = ['minX', 'minY', 'maxX', 'maxY', 'x', 'y', 'width', 'height'];
// Copy bounded data descriptors before serialization; never call an option getter or toJSON.
function snapshot(value, budget = {left: MAX_BOUNDS_SAMPLES}, depth = 0) {
  if (--budget.left < 0 || depth > 8) throw new Error('Bounds callback arguments exceed transport limits');
  if (value == null || ['number', 'string', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) throw new Error('Bounds callback arguments are not data');
  if (Array.isArray(value) && value.length > MAX_BOUNDS_SAMPLES) throw new Error('Bounds callback range exceeds transport limits');
  const descriptors = Object.getOwnPropertyDescriptors(value), copy = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('Bounds callback arguments have accessors');
    if (Array.isArray(value) && key !== 'sheetTicks' && !/^(0|[1-9][0-9]*)$/.test(key)) continue;
    if (descriptor.enumerable) copy[key] = snapshot(descriptor.value, budget, depth + 1);
  }
  if (Array.isArray(value)) {
    copy.length = value.length;
    if (Object.hasOwn(copy, 'sheetTicks')) return {'@array': copy.slice(), sheetTicks: copy.sheetTicks};
  }
  return copy;
}

/** Wrap a supplied callback without changing its receiver, arguments or returned value.
 * Accessors and non-data results are left to the editor, as are throws and oversized calls.
 * Capturing them would invoke user code again or retain an unbounded measurement log.
 */
export function captureEditBounds(name, args, editor) {
  const at = optionIndex[name], options = args[at];
  if (at === undefined || options == null || typeof options !== 'object') return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(options))) return {args, payload: () => null};
  const descriptors = Object.getOwnPropertyDescriptors(options), descriptor = descriptors.boundsOf;
  if (!descriptor) return null;
  if (!Object.hasOwn(descriptor, 'value') || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value'))) return {args, payload: () => null};
  const callback = descriptor.value;
  if (typeof callback !== 'function') return null;
  let input, copied;
  try { input = snapshot(args.slice(0, at)); copied = snapshot({...options, boundsOf: null}); }
  catch { return {args, payload: () => null}; }
  if (appBoundsMarker(callback)) return {args, payload() { const given = input.slice(); given[at] = {...copied, boundsOf: APP_BOUNDS}; return JSON.stringify(given); }};
  const data = {version: 1, method: name, input, options: copied, tick: editor.tick, frameIndex: editor.frameIndex,
    selectedUids: [...editor.selectedUids], samples: []};
  let supported = true;
  const reject = () => { supported = false; data.samples.length = 0; };
  const run = args.slice();
  run[at] = {...options, boundsOf: function (...given) {
    let result;
    try { result = callback.apply(this, given); } catch (error) { reject(); throw error; }
    if (!supported) return result;
    const uid = given[0]?.obj?.unique_id;
    if (!Number.isInteger(uid) || data.samples.length >= MAX_BOUNDS_SAMPLES) { reject(); return result; }
    let bounds = null;
    if (result != null) {
      if (typeof result !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) { reject(); return result; }
      bounds = {};
      for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(result, key);
        if (!descriptor) continue;
        if (!Object.hasOwn(descriptor, 'value') || descriptor.value !== null && !['number', 'string', 'boolean', 'undefined'].includes(typeof descriptor.value)) { reject(); return result; }
        bounds[key] = descriptor.value === undefined ? null : descriptor.value;
      }
    }
    data.samples.push({uid, bounds});
    return result;
  }};
  return {args: run, payload() {
    if (!supported) return null;
    const given = input.slice(); given[at] = {...copied, boundsOf: {'@measuredBounds': data}};
    return JSON.stringify(given);
  }};
}
