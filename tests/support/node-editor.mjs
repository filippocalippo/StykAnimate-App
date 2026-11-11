// A fixture a browser test builds in Node before it opens the page: an editor the engine owns, as the app makes its own (the
// engine opens every document and runs every edit, D19). The engine is registered here (register-engine.mjs); the editor is
// not released, as the script ends with the process.
import './register-engine.mjs';
import {Editor} from '../../src/editor.mjs';
import {installEngineOwner} from '../../src/engine/engine-owner.mjs';

/** The editor on `document` (the blank document when there is none). */
export function nodeEditor(document, options = {}) {
  const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: true, ...options});
  if (document) editor.load(document);
  installEngineOwner(editor);
  return editor;
}
