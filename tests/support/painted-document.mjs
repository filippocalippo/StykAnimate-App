// A document with a drawing layer whose cels carry pixels, made the way the app makes one: the session creates the
// layer and its keys, the editor paints and publishes the cels (the pixels are not the document's until published).
import {Editor} from '../../src/editor.mjs';
import {DrawingResources} from '../../src/drawing-resources.mjs';
import {drawingMetadata} from '../../src/drawing-model.mjs';
import {TILE_BYTES} from '../../src/drawing-tiles.mjs';
import {drawingEngineOperation} from '../../src/engine/engine-drawing-worker.mjs';
import {loadDrawingEngine} from '../../src/engine/engine-drawing.mjs';
import {installEngineOwner} from '../../src/engine/engine-owner.mjs';
import {recordedDocument} from './owned-vs-plain.mjs';

/** The pixel worker, answered in this thread by the drawing raster engine. */
export function workerStub() {
  return {async request(kind, data) {
    let reply;
    await drawingEngineOperation({id: 0, kind, ...structuredClone(data)}, message => { reply = message; });
    if (reply.error) throw Object.assign(new Error(reply.error), {messageKey: reply.messageKey});
    return reply;
  }, dispose() {}};
}

/** A tile of one colour. */
export const tile = (value, tx = 0, ty = 0) => ({tx, ty, before: null, after: new Uint8ClampedArray(TILE_BYTES).fill(value)});

/**
 * @param {string} base the recorded document the drawing layer is added to
 * @param {number[]} colors one cel per colour, each at its own key (ticks 0, 3, 6, ...)
 * @returns {Promise<{document: object, layer: string, second: string, cels: string[]}>} the document (a fresh copy for each
 *   reader), the drawing layer, another drawing layer (blank) and the cel identities of the first in key order
 */
export async function paintedDocument(base = 'sheet-layers', colors = [11, 22]) {
  await loadDrawingEngine();
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(recordedDocument(base));
  const resources = new DrawingResources(editor.report, {worker: workerStub()});
  const owner = installEngineOwner(editor);
  try {
    const layer = editor.createDrawingLayer('Ink');
    const cels = [];
    for (const [index, color] of colors.entries()) {
      editor.seek(index * 3);
      if (index) editor.drawingKey([layer.id], index * 3, {blank: true});
      const target = editor.prepareDrawingCel({pixelsPerUnit: 1, world: {x: 100 + index * 10, y: 100}});
      await resources.surface(target.figure);
      editor.commitDrawingPixels(target, [tile(color)]);
      cels.push(drawingMetadata(editor.drawingTarget().figure).celId);
    }
    await resources.flush();
    const second = editor.createDrawingLayer('Ink 2');
    editor.seek(0);
    return {document: structuredClone(editor.report), layer: layer.id, second: second.id, cels};
  } finally {
    owner.release();
    resources.dispose();
  }
}
