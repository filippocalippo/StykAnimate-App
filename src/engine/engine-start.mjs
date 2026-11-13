/**
 * The page's first script (index.html), ahead of the application (src/app.mjs): the scene canvas's graphics adapter is
 * asked for, the engine's module compiled and the stage started over the canvas, all while the application's own
 * modules are still arriving. The application's `loadEngine()` and `createStage()` take what this started, so a launch
 * waits for the slowest of them instead of their sum. A start that fails is reported by the application's call, which
 * tries again.
 */
import {loadEngine, expectAdapterInfo} from './engine.mjs';
import {askAdapterEarly} from './engine-adapter.mjs';

const scene = document.getElementById('scene');
if (scene) {
  // The adapter comes back in most of a second on a first launch: asked now, its wait runs beside the engine's load,
  // and its description names the adapter in the status line.
  expectAdapterInfo(askAdapterEarly());
  // The stage starts as soon as the engine's module runs, before its threads have joined.
  loadEngine({stage: scene}).catch(() => {});
}
