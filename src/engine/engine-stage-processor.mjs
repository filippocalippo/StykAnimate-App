/**
 * The stage drawn on the engine's workers (docs/engine/rendering.md, "The stage on the processor"; decision D21).
 *
 * Where the stage's graphics device is itself a software rasterizer (no graphics card: Chromium's SwiftShader), the
 * engine draws each frame with its processor renderer on its worker threads instead (`Stage::set_processor`,
 * `styk_engine::stage_raster`). Every draw still goes through the stage as before; a draw that returns true has asked
 * for a frame, and this shows it when the workers have finished it: the newest finished frame is copied out of the
 * engine's memory onto a 2D canvas laid over the scene canvas (`putImageData`, which the software compositor shows
 * soonest), the previous picture staying meanwhile. Waiting is the engine's progress counter (`whenProgress`, D7): the
 * interface thread never waits for a frame.
 *
 * `createProcessorStage({stage, engine, scene, onPicture, onFailed})`: `stage` the engine's `Stage`, `engine` the loaded
 * engine (its memory and progress counter), `scene` the scene canvas. `onPicture(prepared, at, {tick, revision})` is told
 * when a frame is shown; `onFailed()` when the workers could not draw one (the stage then draws with its device).
 */
import {traceComplete, tracing} from '../trace.mjs';

/** How long a wait for the workers lasts before it looks again (a frame whose job had nothing to report). */
const WAIT_MS = 16;

export function createProcessorStage({stage, engine, scene, onPicture = () => {}, onFailed = () => {}, document = globalThis.document}) {
  let on = false, canvas = null, context = null, image = null, waiting = false, destroyed = false;
  /** What each frame asked of the workers was for, by its number: when, which tick, a prepared frame or the edit frame. */
  const asked = new Map();
  const show = visible => {
    if (canvas) canvas.style.visibility = visible ? '' : 'hidden';
    scene.style.visibility = visible ? 'hidden' : '';
  };
  const self = {
    get on() { return on; },
    /** The canvas the frames are shown on (null until the first is). */
    get canvas() { return canvas; },
    /** Draws on the workers (true) or with the stage's device (false); the scene canvas shows while it is off. */
    set(wanted) {
      wanted = Boolean(wanted) && !destroyed;
      if (wanted === on) return;
      stage.set_processor(wanted);
      on = wanted;
      if (on && !canvas) {
        canvas = document.createElement('canvas');
        // Laid exactly over the scene canvas (both fill the viewport), under the overlay that follows it.
        canvas.className = 'scene-processor';
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
        canvas.setAttribute('aria-hidden', 'true');
        context = canvas.getContext('2d');
        scene.after(canvas);
      }
      if (!on) { asked.clear(); image = null; }
      show(on);
    },
    /** A draw asked the workers for a frame (`at` when it began): it is shown when they are done. */
    asked(at, {tick, prepared = false, revision} = {}) {
      if (!on) return;
      asked.set(stage.processor_serial(), {at, tick, prepared, revision});
      self.present();
    },
    /** Shows the newest frame the workers finished, if any, and waits for the next while one is being drawn. */
    present() {
      if (destroyed || !on) return;
      const seen = engine.progressSeen();
      const frame = stage.processor_frame();
      if (frame.length) {
        const [address, width, height, serial] = frame, started = performance.now();
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        if (image?.width !== width || image?.height !== height) image = new ImageData(width, height);
        // The engine's memory is shared: the canvas takes a copy of its own, and the frame's buffer serves the next one.
        image.data.set(new Uint8ClampedArray(engine.join.memory.buffer, address, width * height * 4));
        stage.processor_shown(serial);
        context.putImageData(image, 0, 0);
        const request = asked.get(serial), shown = performance.now();
        for (const key of asked.keys()) if (key <= serial) asked.delete(key);
        if (request) {
          // The picture's span runs from the draw that asked for it to its showing: when the person saw that tick (src/devtools/capture.mjs).
          // A name of its own: the draw's span measured the interface's part, this one is mostly the workers'.
          traceComplete(request.prepared ? 'stage picture prepared' : 'stage picture', request.at, shown - request.at, tracing ? {tick: request.tick, drawn: true, copyMs: shown - started} : undefined);
          onPicture(request.prepared, shown, {tick: request.tick, revision: request.revision});
        }
      }
      if (stage.processor_failed()) {
        // A picture of the frame could not be held: the device draws from now on (the picture on show stays until it does).
        self.set(false);
        onFailed();
        return;
      }
      if (!waiting && stage.processor_pending()) {
        waiting = true;
        engine.whenProgress(seen, WAIT_MS).then(() => { waiting = false; self.present(); });
      }
    },
    destroy() {
      destroyed = true;
      asked.clear();
      canvas?.remove();
      canvas = context = image = null;
      on = false;
      scene.style.visibility = '';
    },
  };
  return self;
}
