/**
 * How long an input took to show its picture, read out of a capture (docs/PERFORMANCE.md "Latency").
 *
 * Every capture reports `input.p95`: from an input to the end of the frame that followed its handler. That is the
 * whole wait when the handler's own frame shows the result (a drag, a pan). It is not when the picture is made off
 * the interface thread and arrives frames later, as a seek in a dense scene does: the frame after the key press is on
 * time and shows the old picture. For those a scenario reads the capture's `shown` series (when the stage drew which
 * tick) against when each input happened.
 */
import {distribution} from '../../src/devtools/stats.mjs';

/**
 * For a run of inputs that each move the playhead by `step` ticks from `firstTick` (a held frame-step key): how long
 * each waited for a picture of its tick or a later one. `shown` is the capture's ({at, tick, inputs}, milliseconds
 * from the capture's start); `lastTick` is where the playhead stops (the document's end).
 * Returns {count, p50, p95, worst, unanswered}: an input no picture answered counts as waiting to the capture's end.
 */
export function seekLatency(shown, {firstTick, step = 1, lastTick = Infinity, endMs}) {
  const waits = [];
  let unanswered = 0, from = 0;
  shown.inputs.forEach((pressed, index) => {
    const target = Math.min(lastTick, firstTick + (index + 1) * step);
    // Pictures are in time order: the answer to a later input is never before the answer to an earlier one.
    while (from < shown.at.length && (shown.at[from] < pressed || shown.tick[from] < target)) from++;
    if (from < shown.at.length) waits.push(shown.at[from] - pressed);
    else { unanswered++; waits.push(Math.max(0, endMs - pressed)); }
  });
  const stats = distribution(waits, 1);
  return {count: stats.count, p50: stats.p50, p95: stats.p95, worst: stats.worst, unanswered};
}

/** How many different ticks the stage showed in a capture, and how many pictures in all: what a scrub or a playback delivered. */
export function shownTicks(shown) {
  return {pictures: shown.at.length, ticks: new Set(shown.tick).size, prepared: shown.prepared.reduce((total, flag) => total + flag, 0)};
}
