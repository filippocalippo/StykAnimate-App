/** In a browser page: an Editor the engine owns, the way the app makes its own (src/app.mjs). The engine opens every document
 * and runs every edit in the editor's session (D19), so a page that builds a document with the editor's commands needs both.
 *
 * In the app page (`window.styk` is ready) the engine is registered already:
 *   const {pageEditor} = await import('/tests/support/page-editor.mjs');
 *   const editor = pageEditor({demo: false});
 * In a page of its own (tests/fixtures/blank.html), register the engine first: `await registerPageEngine()`.
 *
 * The editor is detached (the rig test's way, src/rig-test-ui.mjs): its session answers its own calls and reads while the
 * project the page shows keeps the stage. */
import {Editor} from '/src/editor.mjs';
import {loadEngine} from '/src/engine/engine.mjs';
import {useEngine, registeredEngine} from '/src/engine/engine-open.mjs';
import {installEngineOwner} from '/src/engine/engine-owner.mjs';

/** Loads the engine and registers it, once per page. */
export async function registerPageEngine() {
  const engine = registeredEngine() ?? await loadEngine();
  useEngine(engine);
  return engine;
}

/** A new editor on the blank document (or the demo with `demo: true`), laid out as the app lays its own out. */
export function pageEditor(options = {}) {
  const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: true, ...options});
  installEngineOwner(editor, {detached: true});
  return editor;
}
