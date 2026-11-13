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

/**
 * For a drag that moves the playhead at a steady pace from `fromTick` to `toTick` (a scrub along the ruler): how far
 * the stage's picture trailed the pointer. The drag runs from the capture's first input to its last (the press and the
 * release), so the tick under the pointer at any moment follows from the time, however the browser merged the moves.
 *
 * For each picture shown during the drag, `trail` is its age: how long before the picture the pointer reached the tick
 * it shows (a scrub that keeps up shows ages under one tick's share of the drag; an old place of the pointer shows as a
 * long age), and `behind` how many ticks the pointer was past it. `perSecond` is the different ticks shown during the
 * drag per second of it. `releaseMs` runs from the release to the first picture of `finalTick` (the playhead after the
 * drag), null when none came. Returns null when the capture has no drag (fewer than two inputs).
 */
export function scrubTrail(shown, {fromTick, toTick, finalTick = toTick}) {
  const start = shown.inputs[0], end = shown.inputs.at(-1);
  if (shown.inputs.length < 2 || !(end > start) || toTick === fromTick) return null;
  const span = end - start, ticks = toTick - fromTick;
  const reached = tick => start + Math.max(0, Math.min(1, (tick - fromTick) / ticks)) * span;
  const under = time => fromTick + Math.floor(Math.max(0, Math.min(1, (time - start) / span)) * ticks * Math.sign(ticks)) * Math.sign(ticks);
  const trail = [], behind = [], during = new Set();
  let releaseMs = null;
  shown.at.forEach((at, index) => {
    const tick = shown.tick[index];
    if (at > start && at <= end) {
      during.add(tick);
      trail.push(Math.max(0, at - reached(tick)));
      behind.push(Math.max(0, (under(at) - tick) * Math.sign(ticks)));
    } else if (at > end && releaseMs === null && tick === finalTick) releaseMs = at - end;
  });
  const age = distribution(trail, 1), late = distribution(behind, 1);
  return {pictures: trail.length, ticks: during.size, perSecond: during.size / (span / 1000), trail: {p50: age.p50, p95: age.p95, worst: age.worst}, behind: {p50: late.p50, p95: late.p95}, releaseMs};
}

/** How many different ticks the stage showed in a capture, and how many pictures in all: what a scrub or a playback delivered. */
export function shownTicks(shown) {
  return {pictures: shown.at.length, ticks: new Set(shown.tick).size, prepared: shown.prepared.reduce((total, flag) => total + flag, 0)};
}
