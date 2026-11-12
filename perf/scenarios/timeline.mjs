/**
 * The timeline: moving through the animation's frames.
 */
import {seekLatency} from '../lib/latency.mjs';
import {LIMITS} from '../lib/metrics.mjs';

/** How many times the next-frame key is pressed, and over how long: twenty a second, what a held key gives. */
const STEPS = 30, STEP_MS = 1500;

export const step = {
  id: 'timeline.step', area: 'timeline', title: 'Step through frames', kind: 'gesture',
  description: 'Presses the next-frame key 30 times in 1.5 s, as a held key does. Each press is a seek: the engine evaluates the frame, the stage draws it, the interface follows.',
  // Smooth is not enough here: each press must show its own frame before the next press comes.
  judge: [{metric: 'frame.felt', limits: LIMITS.frame}, {metric: 'seek.p95', limits: [50, 100, 250]}],
  metrics: {
    'seek.p50': {title: 'Key press to its frame, median', short: 'key to frame p50', unit: 'ms', better: 'lower', digits: 0},
    'seek.p95': {title: 'Key press to its frame, 95th percentile', short: 'key to frame', unit: 'ms', better: 'lower', digits: 0},
    'seek.unanswered': {title: 'Key presses whose frame never showed', unit: '', better: 'lower', digits: 0},
  },
  when: async context => ((await context.state()).document.totalTicks < 2 ? 'the document has one frame' : undefined),
  setup: async context => ({presses: Math.min(STEPS, (await context.state()).document.totalTicks - 1)}),
  run: (context, {presses}) => context.input.keys('Period', {count: presses, durationMs: STEP_MS * presses / STEPS}),
  measure(context, {presses}, summary) {
    const waits = seekLatency(summary.shown, {firstTick: 0, lastTick: presses, endMs: summary.ms});
    return {'seek.p50': waits.p50, 'seek.p95': waits.p95, 'seek.unanswered': waits.unanswered};
  },
  reset: context => context.request('seek', {tick: 0}),
};

export const jump = {
  id: 'timeline.jump', area: 'timeline', title: 'Jump to a far frame', kind: 'operation',
  description: 'Seeks from the first frame to the middle of the animation and waits for its picture: one cold frame, nothing prepared around it.',
  judge: {metric: 'duration', limits: LIMITS.response},
  when: async context => ((await context.state()).document.totalTicks < 4 ? 'the document is too short' : undefined),
  async run(context) {
    const ticks = (await context.state()).document.totalTicks;
    const shown = await context.request('seek', {tick: Math.floor(ticks / 2)});
    return {metrics: {duration: shown.presentedMs ?? NaN}};
  },
  reset: context => context.request('seek', {tick: 0}),
};

export default [step, jump];
