/**
 * The page's first script (index.html), ahead of the application (src/app.mjs): the engine's module is compiled, its
 * threads started and the scene canvas's graphics device requested while the application's own modules are still
 * arriving. The application's `loadEngine()` and `createStage()` take what this started, so a launch waits for the
 * slower of the two instead of their sum. A start that fails is reported by the application's call, which tries again.
 */
import {loadEngine} from './engine.mjs';

const scene = document.getElementById('scene');
if (scene) loadEngine().then(engine => engine.prepareStage(scene)).catch(() => {});
