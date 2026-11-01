/**
 * The page's first script (index.html), ahead of the application (src/app.mjs): the engine's module is compiled, its
 * threads started and the scene canvas's graphics device requested while the application's own modules are still
 * arriving. The application's `loadEngine()` and `createStage()` take what this started, so a launch waits for the
 * slower of the two instead of their sum. A start that fails is reported by the application's call, which tries again.
 */
import {loadEngine, expectAdapterInfo} from './engine.mjs';

const scene = document.getElementById('scene');
if (scene) {
  warmGraphics();
  loadEngine().then(engine => engine.prepareStage(scene)).catch(() => {});
}

/**
 * The browser's first graphics adapter and device take most of a second in its graphics process, whoever asks, and the
 * asking thread waits while the process sets its connection up. The stage can ask only once the engine has loaded, so a
 * worker asks now, while that loads (src/engine/engine-graphics-worker.mjs), and the interface thread never waits for it.
 * The worker also reports the adapter's description, which the stage shows as the adapter's name.
 */
function warmGraphics() {
  if (typeof Worker !== 'function' || !globalThis.navigator?.gpu) return;
  const worker = new Worker(new URL('./engine-graphics-worker.mjs', import.meta.url), {type: 'module', name: 'styk-graphics'});
  expectAdapterInfo(new Promise(resolve => {
    worker.onmessage = ({data}) => { worker.terminate(); resolve(data); };
    worker.onerror = () => { worker.terminate(); resolve(null); };
  }));
}
