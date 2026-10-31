/** What the effects timeline and its inspector show of effect clips over time, read from the engine session (`vfxClips` of
 * `engine/engine-shown.mjs`): how long a clip's particles last after its end, whether it is on at the playhead, and whether
 * the inspector lists it there. The records are immutable, so answers are kept per record. */
const tails = new WeakMap(), activity = new WeakMap();

/** The views the engine gives `clips` at `tick`, `[{tail, active, plays} | null, …]`, or null where it holds no document. */
const ask = (editor, clips, tick) => editor._shown?.vfxClips(clips, tick) ?? null;

/** The ticks after a timed clip's end during which its particles are still visible (0 for a clip with no end). */
export function clipTail(editor, clip) {
  if (clip.duration === null) return 0;
  let tail = tails.get(clip);
  if (tail === undefined) {
    tail = ask(editor, [clip], editor.tick)?.[0]?.tail;
    if (tail === undefined) return 0;
    tails.set(clip, tail);
  }
  return tail;
}

/** Whether `clip` is on at the playhead: enabled, with strength, in range and with an effect keyed on. */
export function clipActive(editor, clip) {
  const held = activity.get(clip), tick = editor.tick;
  if (held?.tick === tick) return held.active;
  const active = ask(editor, [clip], tick)?.[0]?.active;
  if (active === undefined) return false;
  activity.set(clip, {tick, active});
  return active;
}

/** For each of `clips`, whether the inspector lists it at `tick`: it is on there, or its generated effects are still showing. A clip
 * that is switched off is listed where it would play. */
export function clipsPlaying(editor, clips, tick) {
  const views = ask(editor, clips.map(clip => clip.enabled ? clip : {...clip, enabled: true}), tick);
  return clips.map((_, index) => views?.[index]?.plays === true);
}
