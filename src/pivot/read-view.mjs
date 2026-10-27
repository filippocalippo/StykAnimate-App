/**
 * What the interface reads of a document's stored data without evaluating it: colour words, a segment's static
 * flag, the shortest turn between angles and the timeline index (where each stored keyframe starts). The
 * evaluation of a frame (poses, geometry, cameras, effects) is the engine's (docs/engine/evaluation.md); the
 * interface reads it through `src/engine/engine-shown.mjs`.
 */
import {animationEndTick} from '../animation-channels.mjs';

export const shortest = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** A packed ARGB-ish colour word as its channels: `{rgb: [r, g, b], alpha}`. */
export function color(raw) {
  const n = Number(raw) >>> 0;
  return {
    rgb: [n & 255, (n >>> 8) & 255, (n >>> 16) & 255],
    alpha: (n >>> 24) / 255,
  };
}

/** `base` mixed with the override `raw` by its strength byte (0 keeps `base`, 255 is the override). */
export function mixColor(base, raw) {
  const k = Number(raw) >>> 24;
  if (k === 0) return base;
  const c = color(raw);
  if (k === 255) return c.rgb;
  return base.map((v, i) => Math.floor((v * 256 + k * (c.rgb[i] - v)) / 256));
}

/** Whether a segment is static (cannot be posed), by whichever of its stored flags the file carries. */
export function isStatic(s) {
  if (s.aux_code !== undefined) return Boolean(s.aux_code & 1);
  if (s.static_raw !== undefined) return Boolean(s.static_raw);
  return (
    s.flag_bits?.is_static ?? s.is_static ?? Boolean(Number(s.flags || 0) & 256)
  );
}

function frameTicks(f) {
  // Raw signed duration is the displayed keyframe plus its outgoing inbetweens.
  const n = Number(f.duration_raw ?? 1);
  return Math.max(0, n);
}

/** One `{index, start, count}` per stored keyframe, on the native timeline. */
export function nativeTimeline(report) {
  let tick = 0;
  return (report.keyframes || []).map((f, index) => {
    const n = frameTicks(f),
      count =
        report.version >= 5 && index === report.keyframes.length - 1
          ? Math.min(1, n)
          : n,
      out = { index, start: tick, count };
    tick += count;
    return out;
  });
}

const sourceIndices = new WeakMap();

/** The stored frame a pose key names: the retained source table first, then the native keyframe carrying that id. */
export function poseSourceFrame(report, id) {
  if (id === null || id === undefined) return null;
  const sources = report._styk?.frameSources;
  const retained = sources && Object.hasOwn(sources, id) ? sources[id] : null;
  if (retained) return retained;
  const frames = report.keyframes || [];
  let index = sourceIndices.get(report);
  const candidate = index?.ids.get(id);
  if (!index || index.frames !== frames || index.length !== frames.length ||
      (candidate !== undefined && frames[candidate]?._styk?.frameId !== id)) {
    index = { frames, length: frames.length, ids: new Map() };
    frames.forEach((frame, i) => { if (frame._styk?.frameId) index.ids.set(frame._styk.frameId, i); });
    sourceIndices.set(report, index);
  }
  const slot = index.ids.get(id);
  return slot === undefined ? null : frames[slot];
}

/** The timeline rows of a document: the native ones, lasting as long as the layer sheet, the property channels, the
 * camera-motion clips and the effect clips do. */
export function timeline(report) {
  const sheet=report._styk?.layerSheet;
  const entries = nativeTimeline(report).filter(entry=>!sheet||entry.start<sheet.duration), last = entries.at(-1);
  if(sheet){for(const entry of entries)entry.count=Math.min(entry.count,sheet.duration-entry.start);if(last)last.count=Math.max(sheet.duration,...(report._styk?.cameraMotion?.clips??[]).map(c=>c.start+c.duration),...(report._styk?.vfxClips?.clips??[]).map(c=>c.duration===null?0:c.start+c.duration))-last.start;return entries;}
  if (last) last.count = Math.max(last.count, Math.max(animationEndTick(report),...(report._styk?.cameraMotion?.clips??[]).map(c=>c.start+c.duration),...(report._styk?.vfxClips?.clips??[]).map(c=>c.duration===null?0:c.start+c.duration)) - last.start);
  return entries;
}
