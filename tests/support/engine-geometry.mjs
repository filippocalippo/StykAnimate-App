// The engine's geometry of a pose, for the tests that state what the stage and the handles see of it. Geometry is the engine's
// alone (docs/engine/evaluation.md): an editor the engine owns answers it for the frame on show (`editor.geometry`), and for
// any other pose record through the session's geometry preview, the way a drawing's first stroke is previewed.
import {Editor} from '../../src/editor.mjs';
import {ownedEditorFor} from './owned-editor.mjs';
import {pivotDocument} from './engine-export.mjs';

/** A uid no figure of a test document has: the preview assigns its extra figure to a layer under it. */
const SPARE_UID = 2 ** 31 - 2;

/**
 * The geometry (`{objects: Map<slot, group>, orderedObjects, drawables, warnings}`, engine-shown.mjs) of the pose record `frame`
 * (a stored keyframe, a pose made by hand) seen against the document `editor` holds: its figure definitions, layers and
 * canvas. `frame` is taken as it is, not evaluated.
 */
export function geometryOfFrame(editor, frame) {
  return editor._shown.previewGeometry(frame, editor.report.figure_types[0], editor.activeLayerId, SPARE_UID);
}

/**
 * [`geometryOfFrame`] for a document nobody edits: it is opened in an editor of its own (released when the test ends) and the
 * pose is its first stored keyframe unless `frame` says otherwise. A document changed in place is opened again by the next call.
 */
export function geometryOfDocument(document, frame = document.keyframes[0], options = {}) {
  const editor = ownedEditorFor({demo: false, propertyChannels: true, layerTimeline: Boolean(document._styk?.layerSheet), ...options}, structuredClone(document));
  return geometryOfFrame(editor, frame);
}

/**
 * The frame the engine shows for `document` at `tick` (the document is opened in an editor of its own): the evaluated pose, with
 * its camera, background and effect times.
 */
export function evaluatedAt(document, tick = 0, options = {}) {
  const editor = ownedEditorFor({demo: false, propertyChannels: true, layerTimeline: Boolean(document._styk?.layerSheet), ...options}, structuredClone(document));
  editor.seek(tick, {allowBeyondEnd: true});
  return editor.evaluatedFrame;
}

const flats = new WeakMap();
/**
 * The geometry of the whole scene the engine draws at `tick` of `source` (an editor the engine owns, or a document it opens in an editor
 * of its own), movieclip contents included: the interface's geometry of a clip is its handle (the stage draws what it holds), so the
 * scene is read from the Pivot document the engine's export makes, which flattens every clip into ordinary figures. The export is made
 * once per revision of an editor and once per document, from a copy of its document: the engine exports the document it was last handed.
 */
export function sceneAt(source, tick) {
  const key = source instanceof Editor ? source.report : source, revision = source instanceof Editor ? source.revision : 0;
  let flat = flats.get(key);
  if (!flat || flat.revision !== revision) {
    const document = pivotDocument(source instanceof Editor ? source.serialize() : source);
    flat = {revision, document, editor: ownedEditorFor({demo: false}, document)};
    flats.set(key, flat);
  }
  const {editor, document} = flat;
  editor.seek(tick, {allowBeyondEnd: true});
  // At a keyframe the scene is the pose the export stored there.
  const row = editor.timeline[editor.frameIndex];
  return row && row.start === tick ? geometryOfFrame(editor, document.keyframes[row.index]) : editor.geometry;
}
