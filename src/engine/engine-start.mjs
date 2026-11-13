/**
 * The page's first script (index.html), ahead of the application (src/app.mjs): the engine's module is compiled, and
 * once the page has painted, the scene canvas's graphics adapter is asked for and the stage started over the canvas, all
 * while the application's own modules are still arriving. The application's `loadEngine()` and `createStage()` take what
 * this started, so a launch waits for the slowest of them instead of their sum. A start that fails is reported by the
 * application's call, which tries again.
 */
import {loadEngine, expectAdapterInfo} from './engine.mjs';
import {askAdapterEarly} from './engine-adapter.mjs';

/** The longest the stage waits for the page's first paint: a window that paints nothing yet does not hold it longer. */
const FIRST_PAINT_MS = 300;

/**
 * Resolves after the page's first frame has been painted, or after `FIRST_PAINT_MS`. The stage's start holds this thread
 * for parts of it (the page's first WebGPU call sets its connection up; WebGL2 waits for its shader program to link, about
 * 1.6 s on a cold profile), which must not keep the first pixels from the screen.
 */
function afterFirstPaint() {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, FIRST_PAINT_MS);
    // A task after the frame's callbacks runs after that frame's rendering.
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 0));
  });
}

const scene = document.getElementById('scene');
if (scene) {
  loadEngine({stage: afterFirstPaint().then(() => {
    // The adapter takes most of a second on a first launch: asked for now, it comes back while the engine loads, and its
    // description names the adapter in the status line.
    expectAdapterInfo(askAdapterEarly());
    return scene;
  })}).catch(() => {});
}
