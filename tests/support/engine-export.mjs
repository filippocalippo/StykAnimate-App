// The document of a Pivot or figure export, made by the engine as the app's document export worker asks it (src/engine/engine-document-export.mjs),
// in-process: the engine must be registered (tests/support/register-engine.mjs). A document that is not an editor's is opened in one the
// engine owns first, as the app opens every document; the owner is released when the test ends.
import {afterEach} from 'node:test';
import {isDeepStrictEqual} from 'node:util';
import {Editor} from '../../src/editor.mjs';
import {registeredEngine} from '../../src/engine/engine-open.mjs';
import {makeExportDocument} from '../../src/engine/engine-document-export.mjs';
import {installEngineOwner, ownerOf} from '../../src/engine/engine-owner.mjs';

const owners = new Set();
afterEach(() => { for (const owner of owners) owner.release(); owners.clear(); });

/** The editor the engine holds `source` in: `source` itself when it is an editor the engine owns (its session started, its changes published). */
function held(source) {
  if (source instanceof Editor && source._shown) { ownerOf(source).activate(); return source; }
  if (source instanceof Editor) source = source.serialize();
  const editor = new Editor({demo: false, propertyChannels: true, layerTimeline: Boolean(source._styk?.layerSheet)});
  editor.load(structuredClone(source));
  const owner = installEngineOwner(editor, {verify: false});
  owners.add(owner);
  if (!owner.ready()) throw new Error('The document has no session.');
  return editor;
}

/**
 * What an export of `request` (`format`, `name`, `figureTypeId`, `figureUid`, `figureUids`, `tick`) saves of `source`, an editor or a document:
 * `{document, baked, drawings, figureTypeId}` (`baked`: tracks, styles or movieclips were baked into stored frames).
 */
export function exportDocument(source, request = {}) {
  const editor = held(source);
  const made = makeExportDocument({join: null, address: registeredEngine().handle.address(), revision: editor.revision, cancelled: () => false,
    request: {format: 'piv', output: 'document', ...request}});
  return {...made, document: JSON.parse(new TextDecoder().decode(made.bytes))};
}

/** The Pivot animation an export saves. */
export const pivotDocument = (source, request) => exportDocument(source, {format: 'piv', ...request}).document;

/** The figure document an export or the library saves. */
export const figureDocument = (source, request) => exportDocument(source, {format: 'stkz', ...request}).document;

/** The frames as a Pivot export stores them when it changes nothing of them: without the editor's identity and easing. */
function stored(frame) {
  const copy = structuredClone(frame);
  if (copy._styk) {
    delete copy._styk.frameId; delete copy._styk.easing;
    if (!Object.keys(copy._styk).length) delete copy._styk;
  }
  return copy;
}

/**
 * Whether a Pivot export of `source` keeps its stored frames as they are, false where authored tracks, styles, camera motion or
 * movieclips were baked into frames of their own.
 */
export function keepsStoredFrames(source, request) {
  const document = source instanceof Editor ? source.report : source;
  return isDeepStrictEqual(pivotDocument(source, request).keyframes, document.keyframes.map(stored));
}
