import {playbackProperties} from './playback-patch.mjs';
import {easingMode, usesLegacyNativeEasing} from './keyframe-easing.mjs';

/** Small render-metadata snapshot. Native object/asset tables stay out of it.
 * Authored sources and Simple drafts currently require full invalidation: their
 * dependency graph is wider than native adjacent-frame interpolation. */
export function playbackRetentionSnapshot(report, entries, {scale, cameraEnabled, storedFrames} = {}) {
  if (storedFrames || report._styk?.simpleFrameDraft || report._styk?.animation?.channels?.length) return null;
  return {signature: JSON.stringify([playbackProperties(report), scale, cameraEnabled, storedFrames]),
    entries: entries.map(entry => ({...entry})),
    legacy: report.keyframes.map((_, index) => usesLegacyNativeEasing(report, index)),
    auto: report.keyframes.map(frame => easingMode(frame._styk?.easing) === 'auto'),
    interpolates: report.keyframes.map(frame => report.version >= 5 || Boolean(frame._styk?.easing))};
}

/** Retain only packets whose sampled inputs and absolute tick location are
 * unchanged. Conservative legacy-easing dependencies include the whole native
 * sequence because angular unwrapping can propagate beyond adjacent keys. */
export function unchangedPlaybackTicks(previous, next, packets, changedIndices) {
  const keep = new Set(), dirty = new Set(changedIndices);
  if (!previous || !next || previous.signature !== next.signature) return keep;
  for (const packet of packets) {
    const index = packet.frameIndex, before = previous.entries[index], after = next.entries[index];
    if (!before || !after || before.start !== after.start || before.count !== after.count || dirty.has(index)) continue;
    if (packet.tick < after.start || packet.tick >= after.start + after.count) continue;
    if (packet.tick > after.start && previous.interpolates[index] && index + 1 < previous.entries.length) {
      if (dirty.has(index + 1)) continue;
      // Auto tangents use adjacent values and each adjoining key's easing mode.
      // Include both neighbors even when a mode edit starts/ends an Auto run.
      if (previous.auto[index] && (dirty.has(index - 1) || dirty.has(index + 2))) continue;
      if (previous.legacy[index] && dirty.size) continue;
    }
    keep.add(packet.tick);
  }
  return keep;
}
