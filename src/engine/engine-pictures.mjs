/**
 * Pictures the interface shows outside the stage, drawn by the engine's preview worker
 * (engine-previews.mjs; docs/engine/rendering.md, Thumbnails and library previews).
 *
 * - `engineDocumentPicture`: a small document the interface built and the engine opens for
 *   one picture: the effects catalogue's stills, the background dialog's preview, a rig being
 *   tested, a figure of the asset library. Nothing of it touches the document the engine holds.
 * - `EnginePoses`: a pose of the open document drawn through a camera of its own, for the
 *   parallax monitor, which shows how a camera position moves the layers.
 *
 * Both resolve an `ImageBitmap` (the caller closes it; `engineDocumentPicture` also says whether
 * the frame has artwork), or null where the engine does not draw the picture: no preview worker
 * (a page that is not cross-origin isolated), a document it cannot read, or an engine at another
 * revision than the editor's.
 */
import {engineDocument} from './engine-document.mjs';
import {enginePreviews} from './engine-previews.mjs';

/**
 * How a picture is placed in its rectangle (`Placement`, styk_wasm::preview): `card` fits the
 * canvas and centres it; `camera(zoom, x, y)` puts the canvas at `zoom` pixels a unit with its
 * origin at `x, y`, seen through the scene camera; `fit(margin)` fits the artwork with `margin`
 * pixels around it; `matrix([a, b, c, d, e, f])` is world to pixels as given.
 */
export const placement = {
  card: () => ({mode: 0, params: []}),
  camera: (zoom, x, y) => ({mode: 1, params: [zoom, x, y]}),
  fit: margin => ({mode: 2, params: [margin]}),
  matrix: matrix => ({mode: 3, params: [...matrix]}),
};

/**
 * `report` (a document in the editor's own form) at `tick`, `width × height` pixels, on
 * transparency or on `background` (ARGB; null: the document's own backgrounds).
 * @param {object} report
 * @param {{tick?: number, width: number, height: number, placement?: {mode: number, params: number[]}, background?: number|null, signal?: AbortSignal}} options
 * @returns {Promise<{bitmap: ImageBitmap, artwork: boolean}|null>}
 */
export async function engineDocumentPicture(report, {tick = 0, width, height, placement: placed = placement.card(), background = null, signal} = {}) {
  const previews = await enginePreviews();
  if (!previews?.usable) return null;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(report)).buffer;
    const answer = await previews.request({operation: 'sketch', bytes, extension: 'json', tick, width, height, ...placed, background}, {signal, transfer: [bytes]});
    return answer.refused || !answer.bitmap ? null : {bitmap: answer.bitmap, artwork: answer.artwork !== false};
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

/** Poses of the editor's open document, drawn by the preview worker from the document the engine holds. */
export class EnginePoses {
  /** `stage()` returns the app's stage renderer once it exists. */
  constructor(editor, {stage = () => null, previews = enginePreviews} = {}) {
    this.editor = editor;
    this.stage = stage;
    this.previews = previews;
  }

  /**
   * `pose` (a keyframe record of the open document) in a `width × height` picture, seen through
   * the camera it carries. The engine is first brought to the editor's revision; a picture of a
   * document the editor has left meanwhile is not drawn.
   * @returns {Promise<ImageBitmap|null>}
   */
  async picture(pose, {width, height, placement: placed, signal}) {
    const stage = this.stage(), {editor} = this;
    if (!stage?.engineSide?.engine?.threaded) return null;
    const previews = await this.previews();
    if (!previews?.usable || signal?.aborted) return null;
    const report = editor.report, revision = editor.revision;
    if (await engineDocument({stage, report, revision, check: () => signal?.throwIfAborted()})) return null;
    if (editor.report !== report || editor.revision !== revision) return null;
    const engine = stage.engineSide.engine, json = JSON.stringify(pose);
    try {
      const answer = await previews.request(() => ({operation: 'pose', address: engine.handle.address(), revision, json, width, height, ...placed}),
        {signal, discard: message => engine.handle.forget_address(message.address)});
      return answer.refused ? null : answer.bitmap ?? null;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }
}

/** A blob URL of `bitmap` as a PNG (the bitmap is closed). */
export async function bitmapURL(bitmap) {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return URL.createObjectURL(await canvas.convertToBlob({type: 'image/png'}));
  } finally { bitmap.close?.(); }
}
