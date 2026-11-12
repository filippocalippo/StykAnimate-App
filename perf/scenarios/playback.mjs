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

export default [play];
