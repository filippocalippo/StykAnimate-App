/** The app's figure-bounds callback for the alignment and camera-centering commands (docs/engine/editing.md).
 * The app's own callback (`boundsOf` in src/app.mjs) is registered here with `markAppBounds` and reaches the engine as
 * `{"@boundsCallback": "app"}`: the engine measures the figures itself (styk-edit `bounds.rs`). Any other callback is not data
 * for the session and is refused.
 */
const APP_BOUNDS = Object.freeze({'@boundsCallback': 'app'});
const appCallbacks = new WeakSet();
/** Registers the app's bounds callback (the engine measures the document's figures as the app
 * does once its images and drawings have loaded). */
export function markAppBounds(callback) { appCallbacks.add(callback); return callback; }
/** What the engine receives for a callback: the marker when it is the app's, else nothing. */
export const appBoundsMarker = callback => appCallbacks.has(callback) ? APP_BOUNDS : undefined;
