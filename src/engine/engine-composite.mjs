/**
 * The artwork a fill or a magic wand samples ("sample all layers"), drawn by the engine
 * (docs/engine/drawing.md, Sampling the artwork).
 *
 * The engine's preview worker draws the figures of the playhead's tick on transparency, with the
 * CPU rasterizer, through the matrix that takes the scene to the cel's pixels: a `width × height`
 * rectangle of RGBA from `(x, y)` in cel pixels, which the pixel worker then reads like any
 * other source. Layers the document hides stay out; there is no background, no effect, no
 * camera. The document is the engine's, brought to the editor's revision first
 * (`engineDocument`), so the drawings must be published (`drawingBarrier`) before.
 */
import {messageError} from '../localized-error.mjs';
import {enginePreviews} from './engine-previews.mjs';

const abortError = () => new DOMException('The drawing sample was superseded.', 'AbortError');
/** Times the engine is asked again after another revision superseded the one asked for. */
const ATTEMPTS = 3;

/**
 * @param {object} options
 * @param {(report: object, revision: number, check: () => void) => Promise<string|null>} options.document
 *   brings the engine's document to the editor's; resolves why it cannot (null once it holds it)
 * @param {() => {handle: {address(): number, forget_address(address: number): void}}|undefined} options.engine the stage's engine, once it has one
 * @param {() => object} options.current the editor's `{report, revision, tick}` now
 * @param {{x: number, y: number, width: number, height: number}} options.bounds the rectangle, in cel pixels
 * @param {number[]} options.matrix scene units to cel pixels (`[a, b, c, d, e, f]`)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<ArrayBuffer>} the rectangle's straight RGBA, `width × height × 4` bytes (the pixel worker takes it over)
 */
export async function engineComposite({document, engine, current, bounds, matrix, signal, previews = enginePreviews}) {
  const worker = await previews(), running = engine();
  if (!worker?.usable || !running) throw messageError(new Error('The engine has no preview worker.'), 'errors.drawingComposite.theDrawingCompositeCanvasIsUnavailable', {});
  const check = () => { if (signal?.aborted) throw abortError(); };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    check();
    const {report, revision, tick} = current();
    const reason = await document(report, revision, check);
    check();
    if (reason) throw messageError(new Error(`The engine cannot sample the artwork: ${reason}`), 'errors.drawingComposite.theDrawingCompositeCanvasIsUnavailable', {});
    const answer = await worker.request(() => ({operation: 'composite', address: running.handle.address(), revision, tick, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, matrix}),
      {signal, discard: message => running.handle.forget_address(message.address)});
    check();
    if (answer.refused === 'stale') continue;
    if (answer.refused || !answer.pixels) throw messageError(new Error(`The engine did not draw the artwork (${answer.refused ?? 'no picture'}).`), 'errors.drawingComposite.theDrawingCompositeCanvasIsUnavailable', {});
    return answer.pixels;
  }
  throw abortError();
}
