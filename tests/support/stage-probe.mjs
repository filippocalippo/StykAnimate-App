/** In the app's page: what the app last asked its stage to draw. The engine's stage keeps no record of its own, so a test that
 * needs the options of the last frame (the view, whether the camera applies) watches the calls:
 *   await page.evaluate(async () => (await import('/tests/support/stage-probe.mjs')).watchStage());
 * and then reads `window.stageLast` (the call, `render` or `renderPrepared`, and its options). */
export function watchStage() {
  const stage = window.styk.state.renderer;
  if (stage.watched) return;
  stage.watched = true;
  for (const call of ['render', 'renderPrepared']) {
    const original = stage[call].bind(stage);
    stage[call] = (...args) => {
      window.stageLast = {call, ...args.find(argument => argument && typeof argument === 'object')};
      return original(...args);
    };
  }
}
