// Paints test artwork: a stroke of samples rasterized into a tile store by the drawing raster engine
// (the module the app uses), the way the brush does. Importing this module loads the engine, in Node
// and in the page alike.
//
//   const stroke = new DrawingStroke(store, {size: 8, color: [20, 30, 40], seed: 1});
//   stroke.sample({x: 10, y: 10, pressure: 1, time: 0}); ... stroke.finish();
import {loadDrawingEngine, paintStroke} from '../../src/engine/engine-drawing.mjs';

await loadDrawingEngine();

export class DrawingStroke {
  constructor(store, settings = {}) {
    this.store = store;
    this.settings = settings;
    this.samples = [];
  }

  sample(input) {
    this.samples.push({pressure: 1, time: this.samples.length, ...input});
  }

  /** Paints every sample given so far, with the whole stroke's settings, into the store; returns its undo records. */
  finish() {
    const changes = paintStroke(this.store, this.settings, this.samples);
    this.samples = [];
    return changes;
  }
}
