/**
 * The page's first script (index.html), ahead of the application (src/app.mjs): the engine's module is compiled, its
 * threads started and the scene canvas's graphics device requested while the application's own modules are still
 * arriving. The application's `loadEngine()` and `createStage()` take what this started, so a launch waits for the
 * slower of the two instead of their sum. A start that fails is reported by the application's call, which tries again.
 */
import {loadEngine, requestGraphicsAdapter} from './engine.mjs';

const scene = document.getElementById('scene');
if (scene) {
  warmGraphics();
  loadEngine().then(engine => engine.prepareStage(scene)).catch(() => {});
}

/**
 * The browser's first graphics adapter and device take most of a second in its graphics process, whoever asks. The
 * stage can ask only once the engine has loaded, so a device is asked for now, while that loads, and let go of: the
 * stage's own request then meets a process that is already up.
 */
function warmGraphics() {
  requestGraphicsAdapter().then(adapter => adapter?.requestDevice()).then(device => device?.destroy()).catch(() => {});
}
