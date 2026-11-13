/**
 * Playback: the animation playing from its first frame.
 */

/** How long playback runs. Long enough to leave the start-up buffer behind and reach a steady rate. */
const SECONDS = 3;

export const play = {
  id: 'playback.play', area: 'playback', title: 'Play the animation', kind: 'gesture',
  description: `Plays from the first frame for ${SECONDS} s. The engine's threads prepare frames ahead; the interface shows each on its tick.`,
  // Judged on what a person sees: the share of the animation's own frame rate that reached the screen.
  judge: {metric: 'playback.delivered', limits: [97, 85, 50]},
  metrics: {
    'playback.delivered': {title: 'Frames delivered, of the animation\'s rate', short: 'delivered', unit: '%', better: 'higher', digits: 1},
    'playback.fps': {title: 'Frames shown per second', unit: 'fps', better: 'higher', digits: 1},
    'playback.start': {title: 'Play pressed to first frame', unit: 'ms', better: 'lower', digits: 0},
    'playback.stutters': {title: 'Frames over one and a half periods', unit: '', better: 'lower', digits: 0},
    'playback.buffering': {title: 'Time spent waiting for frames', unit: 'ms', better: 'lower', digits: 0},
  },
  async run(context) {
    await context.evaluate(() => globalThis.styk.actions.play());
    await context.sleep(SECONDS * 1000);
    // Read while it still plays: stopping ends the measurement the app keeps.
    const shown = await context.evaluate(() => {
      const {styk} = globalThis, presentation = styk.performance().presentation;
      if (styk.state.playing) styk.actions.play();
      return presentation;
    });
    const intervals = shown?.intervalsMs ?? [], target = shown?.targetFps || 24, total = intervals.reduce((sum, ms) => sum + ms, 0);
    const fps = total > 0 ? intervals.length * 1000 / total : 0;
    return {metrics: {'playback.fps': fps, 'playback.delivered': Math.min(100, fps / target * 100), 'playback.start': shown?.startupMs ?? NaN,
      'playback.stutters': intervals.filter(ms => ms > 1500 / target).length, 'playback.buffering': shown?.bufferingMs ?? 0}};
  },
};

/**
 * The same playback with one feature turned off, the way a person turns it off: run on the same document after
 * `playback.play`, the difference between the two is what the feature costs while playing.
 */
export const effectsOff = {
  id: 'playback.effects-off', area: 'playback', title: 'Play with the effects preview off', kind: 'gesture',
  description: `Turns Effects preview off with its button in the stage header, plays from the first frame for ${SECONDS} s as playback.play does, and turns it back on. Against playback.play on the same document: what drawing the effects costs.`,
  judge: play.judge, metrics: play.metrics,
  // Effects live in effect clips (_styk.vfxClips) or on a pose (_stykVfx on a keyframe or a figure on it).
  when: async context => (await context.evaluate(() => {
    const report = globalThis.styk.editor.report;
    return Boolean(report._styk?.vfxClips?.clips?.length || report.keyframes.some(frame => frame._stykVfx || frame.objects.some(object => object._stykVfx)));
  }) ? undefined : 'the document has no effects'),
  async setup(context) {
    if (!(await context.evaluate(() => globalThis.styk.state.vfxEnabled))) throw new Error('The effects preview is off before the scenario turns it off.');
    await context.press('#vfx-preview');
    await context.until(() => globalThis.styk.state.vfxEnabled === false, {what: 'the effects preview to turn off'});
  },
  run: (context, state) => play.run(context, state),
  async teardown(context) {
    if (await context.evaluate(() => globalThis.styk.state.vfxEnabled)) return;
    await context.press('#vfx-preview');
    await context.until(() => globalThis.styk.state.vfxEnabled === true, {what: 'the effects preview to turn back on'});
  },
};

export const cameraOff = {
  id: 'playback.camera-off', area: 'playback', title: 'Play without the camera', kind: 'gesture',
  description: `Hides the camera layer, plays from the first frame for ${SECONDS} s as playback.play does (the whole stage instead of the camera's shot), and shows it again. Against playback.play on the same document: what playing through a moving camera costs.`,
  judge: play.judge, metrics: play.metrics,
  when: async context => (await context.evaluate(() => globalThis.styk.editor.report.keyframes.some(frame => frame.camera && frame.camera.is_default === false))
    ? undefined : 'the document has no camera'),
  // The camera's eye in the timeline has no stable handle to aim at: setup hides it with the command the eye runs
  // (one undo step, undone in teardown); what is measured is the playback after it.
  async setup(context) {
    await context.evaluate(() => globalThis.styk.editor.setLayerVisible('camera', false));
    await context.settle();
  },
  run: (context, state) => play.run(context, state),
  async teardown(context) {
    if (await context.evaluate(() => globalThis.styk.editor.report._styk?.layers?.fixed?.camera?.visible === false && globalThis.styk.editor.undoLabel === 'Set layer visibility')) await context.request('undo');
  },
};

export default [play,
  effectsOff, cameraOff,
];
