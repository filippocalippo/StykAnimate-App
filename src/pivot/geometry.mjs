import {messageError} from '../localized-error.mjs';
import {projection,projectSpatialFace,interpolateSpatialPose} from '../spatial-projection.mjs';
import {createSurfaceEvaluation} from './surfaces.mjs';
import {depthSurface,paintDepthSurfaces,releaseSurfaceRaster} from '../surface-raster.mjs';
import {spatialMeshPlan,evaluateSpatialMeshSteps,spatialMeshDrawables} from '../spatial-mesh.mjs';
import {orderPoseDrawables} from './geometry-order.mjs';
import {primitiveOutsideRasterClip} from './raster-clip.mjs';
import {paintDrawingTiles} from '../drawing-raster.mjs';
import {vfxRenderFrame,frameWithVfxTime} from '../vfx-clips.mjs';
import {frameWithCameraTime} from '../camera-motion.mjs';
import {canvasPaint, segmentPaint, textPaintGeometry, shapePaintBounds} from '../paint.mjs';
// Scene evaluation is independent of the DOM so the regression harness can test it.
import { tweenBackground, releaseBackgroundResources } from "./background.mjs";
import { composePoseChannels, invalidatePoseCache } from '../animation-pose.mjs';
import { composeAnimationChannels, animationEndTick } from '../animation-channels.mjs';
import { applyLayerOrder } from '../layers.mjs';
import { resolveInstanceFigure, meshPaletteColor } from '../animation-style.mjs';
import {animationOriginLayout, animationOriginAngle, animationOriginBend, correctAnimationOrigins, animationRotation} from '../animation-origin.mjs';
import {interpolateOriginSupport} from '../animation-origin-support.mjs';
import {easedProgress, usesLegacyNativeEasing, easingMode, autoValue} from '../keyframe-easing.mjs';
import {geometryDefinition} from './geometry-definition.mjs';
import {geometryPose,geometryPosePlan,geometryPlans} from './geometry-pose.mjs';
import {hasRigConstraints, createRigEvaluation, rigConstraintPlanSteps} from '../rig-constraints.mjs';
import {hasPinnedIK, interpolateIK} from '../ik.mjs';
import {evaluateIKPose} from '../ik-evaluation.mjs';
import {solveJoinedIK} from '../ik-joined.mjs';
import {isMovieclip, sampleMovieclipObjects,movieclipTypes,movieclipSourceDocument} from '../movieclips.mjs';
import {buildMovieclipGeometrySteps} from '../movieclip-geometry.mjs';
import {sampleLayerSheet,invalidateLayerSheet} from '../layer-sheet.mjs';
import {presenceIndex,presenceElapsed,invalidateMovieclipPresence,cachedPresenceIndex,usesPresence} from '../movieclip-presence.mjs';
import {createSheetMembershipSampler} from '../movieclip-membership.mjs';
import {sticknodesShape,sticknodesCurve,sticknodesDrawables,sticknodesSpriteAsset} from '../sticknodes/geometry.mjs';
const authoredTimelines = new WeakMap();
const evaluationGenerations = new WeakMap();
/** Changes whenever a document's evaluation caches are invalidated. */
export const evaluationGeneration = report => evaluationGenerations.get(report)?.evaluation ?? 0;
/** Pose invalidations, distinguished from parameter edits that retain the geometry. */
export const evaluationGeometryGeneration = report => evaluationGenerations.get(report)?.geometry ?? 0;
export function invalidateEvaluationCaches(report, {retainGeometry = false} = {}) {
  evaluationGenerations.set(report, {evaluation: evaluationGeneration(report) + 1, geometry: evaluationGeometryGeneration(report) + (retainGeometry ? 0 : 1)});
  invalidateMovieclipPresence(report);
  invalidateLayerSheet(report);
  authoredTimelines.delete(report);
  invalidatePoseCache(report);
}
import {interpolateVfx, vfxStack, activeVfx} from '../vfx.mjs';

import {withVfx,releaseVfxSurface,configureVfxSoftwareResources} from '../vfx-canvas.mjs';
import {segmentVfx,hasDrawableVfx} from '../vfx-drawable.mjs';
import {objectBounds} from '../renderer-geometry.mjs';
export const TAU = Math.PI * 2;
export const lerp = (a, b, t) => Number(a) + (Number(b) - Number(a)) * t;
export const shortest = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export function color(raw) {
  const n = Number(raw) >>> 0;
  return {
    rgb: [n & 255, (n >>> 8) & 255, (n >>> 16) & 255],
    alpha: (n >>> 24) / 255,
  };
}
export function mixColor(base, raw) {
  const k = Number(raw) >>> 24;
  if (k === 0) return base;
  const c = color(raw);
  if (k === 255) return c.rgb;
  return base.map((v, i) => Math.floor((v * 256 + k * (c.rgb[i] - v)) / 256));
}
export function rgba(rgb = [0, 0, 0], a = 1) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a))})`;
}
export function isStatic(s) {
  if (s.aux_code !== undefined) return Boolean(s.aux_code & 1);
  if (s.static_raw !== undefined) return Boolean(s.static_raw);
  return (
    s.flag_bits?.is_static ?? s.is_static ?? Boolean(Number(s.flags || 0) & 256)
  );
}
export function arc(start, angle, length, bend = 0) {
  if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(angle) || !Number.isFinite(length) || !Number.isFinite(bend))
    return [];
  if (Math.abs(bend) < 1e-7)
    return [
      start,
      {
        x: start.x + length * Math.cos(angle),
        y: start.y + length * Math.sin(angle),
      },
    ];
  const steps = Math.max(
    8,
    Math.min(
      160,
      Math.ceil(Math.abs(bend) * 16),
      Math.ceil(Math.abs(length) / 4),
    ),
  );
  const r = length / bend;
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: start.x + r * (Math.sin(angle + (bend * i) / steps) - Math.sin(angle)),
    y: start.y + r * (Math.cos(angle) - Math.cos(angle + (bend * i) / steps)),
  }));
}
export function frameTicks(f) {
  // Raw signed duration is the displayed keyframe plus its outgoing inbetweens.
  const n = Number(f.duration_raw ?? 1);
  return Math.max(0, n);
}
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
export function timeline(report) {
  const sheet=report._styk?.layerSheet;
  const entries = nativeTimeline(report).filter(entry=>!sheet||entry.start<sheet.duration), last = entries.at(-1);
  if(sheet){for(const entry of entries)entry.count=Math.min(entry.count,sheet.duration-entry.start);if(last)last.count=Math.max(sheet.duration,...(report._styk?.cameraMotion?.clips??[]).map(c=>c.start+c.duration),...(report._styk?.vfxClips?.clips??[]).map(c=>c.duration===null?0:c.start+c.duration))-last.start;return entries;}
  if (last) last.count = Math.max(last.count, Math.max(animationEndTick(report),...(report._styk?.cameraMotion?.clips??[]).map(c=>c.start+c.duration),...(report._styk?.vfxClips?.clips??[]).map(c=>c.duration===null?0:c.start+c.duration)) - last.start);
  return entries;
}
function sameSign(a, b) {
  return Math.sign(a) === Math.sign(b);
}
function endpointSlope(h0, h1, d0, d1) {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (!sameSign(m, d0)) return 0;
  if (!sameSign(d0, d1) && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0;
  return m;
}
export function pchip(times, values, index, t) {
  const n = values.length;
  if (n < 3) return lerp(values[index], values[index + 1], t);
  const h = times.slice(1).map((v, i) => v - times[i]),
    d = h.map((v, i) => (values[i + 1] - values[i]) / v);
  function slope(i) {
    if (i === 0) return endpointSlope(h[0], h[1], d[0], d[1]);
    if (i === n - 1)
      return endpointSlope(h.at(-1), h.at(-2), d.at(-1), d.at(-2));
    if (!d[i - 1] || !d[i] || !sameSign(d[i - 1], d[i])) return 0;
    const w = (2 * h[i - 1] + h[i]) / (3 * (h[i - 1] + h[i]));
    return (d[i - 1] * d[i]) / (w * d[i - 1] + (1 - w) * d[i]);
  }
  const t2 = t * t,
    t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * values[index] +
    (t3 - 2 * t2 + t) * h[index] * slope(index) +
    (3 * t2 - 2 * t3) * values[index + 1] +
    (t3 - t2) * h[index] * slope(index + 1)
  );
}
// pchip() at one interval without building the tangent arrays: identical
// arithmetic, evaluated only for the two slopes the interval uses.
const intervalWidth = (times, i) => times[i + 1] - times[i];
const secant = (times, values, i) => (values[i + 1] - values[i]) / intervalWidth(times, i);
function pchipAt(times, values, index, t) {
  const n = values.length;
  if (n < 3) return lerp(values[index], values[index + 1], t);
  const slope = i => {
    if (i === 0) return endpointSlope(intervalWidth(times, 0), intervalWidth(times, 1), secant(times, values, 0), secant(times, values, 1));
    if (i === n - 1) return endpointSlope(intervalWidth(times, n - 2), intervalWidth(times, n - 3), secant(times, values, n - 2), secant(times, values, n - 3));
    const before = secant(times, values, i - 1), after = secant(times, values, i);
    if (!before || !after || !sameSign(before, after)) return 0;
    const h0 = intervalWidth(times, i - 1), h1 = intervalWidth(times, i), w = (2 * h0 + h1) / (3 * (h0 + h1));
    return (before * after) / (w * before + (1 - w) * after);
  };
  const t2 = t * t,
    t3 = t2 * t,
    h = intervalWidth(times, index);
  return (
    (2 * t3 - 3 * t2 + 1) * values[index] +
    (t3 - 2 * t2 + t) * h * slope(index) +
    (3 * t2 - 2 * t3) * values[index + 1] +
    (t3 - t2) * h * slope(index + 1)
  );
}
function parameter(report, index, t, get, angular = false) {
  let left = index,
    right = index + 1;
  const frames = report.keyframes;
  const a = get(frames[index]),
    b = get(frames[index + 1]);
  if (a === undefined || b === undefined) return a ?? 0;
  if (easingMode(frames[index]._styk?.easing) === 'auto') {
    const end = angular ? a + shortest(b - a) : b;
    const neighbour = (frame, duration, before) => {
      if (!frame) return undefined;
      let value = get(frame);
      if (value === undefined) return undefined;
      if (angular) value = before ? a - shortest(a - value) : end + shortest(value - b);
      return {value, duration};
    };
    return autoValue(a, end, t, frameTicks(frames[index]),
      easingMode(frames[index - 1]?._styk?.easing) === 'auto' ? neighbour(frames[index - 1], frameTicks(frames[index - 1]), true) : undefined,
      easingMode(frames[index + 1]?._styk?.easing) === 'auto' ? neighbour(frames[index + 2], frameTicks(frames[index + 1]), false) : undefined);
  }
  if (!usesLegacyNativeEasing(report, index)) return a + (angular ? shortest(b - a) : b - a) * t;
  while (
    left > 0 &&
    frameTicks(frames[left - 1]) > 1 &&
    get(frames[left - 1]) !== undefined
  )
    left--;
  while (
    right < frames.length - 1 &&
    frameTicks(frames[right]) > 1 &&
    get(frames[right + 1]) !== undefined
  )
    right++;
  const times = [0],
    values = [get(frames[left])];
  for (let i = left + 1; i <= right; i++) {
    times.push(times.at(-1) + frameTicks(frames[i - 1]));
    const value = get(frames[i]);
    values.push(
      angular ? values.at(-1) + shortest(value - values.at(-1)) : value,
    );
  }
  return pchipAt(times, values, index - left, t);
}
/** One object's records in the keyframes around a tween, matched once. */
function tweenRecords(frames, matching) {
  const records = new Map();
  return k => {
    let item = records.get(k);
    if (item === undefined && !records.has(k)) { item = matching(frames[k]); records.set(k, item); }
    return item;
  };
}
/** The native-easing run of keyframes that contain the object, and its times. */
function presenceRun(frames, index, record) {
  let run;
  return () => {
    if (run) return run;
    let left = index, right = index + 1;
    while (left > 0 && frameTicks(frames[left - 1]) > 1 && record(left - 1) !== undefined) left--;
    while (right < frames.length - 1 && frameTicks(frames[right]) > 1 && record(right + 1) !== undefined) right++;
    const times = [0];
    for (let i = left + 1; i <= right; i++) times.push(times[times.length - 1] + frameTicks(frames[i - 1]));
    return run = {left, right, times};
  };
}
const recordValue = (record, read, k, x, y) => { const item = record(k); return item === undefined ? undefined : read(item, x, y); };
const runTimes = [], runValues = [];
/** parameter() for a channel of one object: `read(item, x, y)` reads it from a
 * matched record. Same arithmetic and order, without per-sample lookups or arrays. */
function sampleRecords(report, index, t, record, read, angular, x, y, presence) {
  const frames = report.keyframes;
  const a = recordValue(record, read, index, x, y), b = recordValue(record, read, index + 1, x, y);
  if (a === undefined || b === undefined) return a ?? 0;
  if (easingMode(frames[index]._styk?.easing) === 'auto') {
    const end = angular ? a + shortest(b - a) : b;
    const neighbour = (k, duration, before) => {
      if (!frames[k]) return undefined;
      let value = recordValue(record, read, k, x, y);
      if (value === undefined) return undefined;
      if (angular) value = before ? a - shortest(a - value) : end + shortest(value - b);
      return {value, duration};
    };
    return autoValue(a, end, t, frameTicks(frames[index]),
      easingMode(frames[index - 1]?._styk?.easing) === 'auto' ? neighbour(index - 1, frameTicks(frames[index - 1]), true) : undefined,
      easingMode(frames[index + 1]?._styk?.easing) === 'auto' ? neighbour(index + 2, frameTicks(frames[index + 1]), false) : undefined);
  }
  if (!usesLegacyNativeEasing(report, index)) return a + (angular ? shortest(b - a) : b - a) * t;
  // The native run spans the object's records; a channel defined in all of them
  // has exactly that run, so its bounds and times are shared by every joint.
  const run = presence?.();
  if (run) {
    const values = runValues;
    values.length = 0;
    let complete = true;
    for (let i = run.left; i <= run.right; i++) {
      const value = recordValue(record, read, i, x, y);
      if (value === undefined) { complete = false; break; }
      if (i === run.left || !angular) values.push(value);
      else { const previous = values[values.length - 1]; values.push(previous + shortest(value - previous)); }
    }
    if (complete) return pchipAt(run.times, values, index - run.left, t);
  }
  let left = index, right = index + 1;
  while (left > 0 && frameTicks(frames[left - 1]) > 1 && recordValue(record, read, left - 1, x, y) !== undefined) left--;
  while (right < frames.length - 1 && frameTicks(frames[right]) > 1 && recordValue(record, read, right + 1, x, y) !== undefined) right++;
  const times = runTimes, values = runValues;
  times.length = 0; values.length = 0;
  times.push(0); values.push(recordValue(record, read, left, x, y));
  for (let i = left + 1; i <= right; i++) {
    times.push(times[times.length - 1] + frameTicks(frames[i - 1]));
    const value = recordValue(record, read, i, x, y), previous = values[values.length - 1];
    values.push(angular ? previous + shortest(value - previous) : value);
  }
  return pchipAt(times, values, index - left, t);
}
const readField = (item, key) => item[key];
const readRelativeAngle = (item, i, context) => {
  const {segments, parent} = context, s = segments[i];
  let value = Number(item.angles?.[i] ?? s.angle_rad ?? 0);
  if (parent !== undefined) {
    const ps = segments[parent];
    value -= Number(item.angles?.[parent] ?? ps.angle_rad ?? 0) + Number(item.bend_flag ? item.bends[parent] : (ps.bend_rad ?? 0));
  }
  return value;
};
function colorTween(a, b, t) {
  a = Number(a) >>> 0;
  b = Number(b) >>> 0;
  const am = a >>> 24,
    bm = b >>> 24;
  if (!am && !bm) return a;
  let out = 0;
  for (let i = 0; i < 4; i++) {
    let av = (a >>> (i * 8)) & 255,
      bv = (b >>> (i * 8)) & 255;
    if (i < 3) {
      if (!am) av = bv;
      if (!bm) bv = av;
    }
    out |= (av + Math.trunc((bv - av) * t)) << (i * 8);
  }
  return out >>> 0;
}
export function evaluatedNativeFrame(report, index, t = 0, tweenCache, requestedUids) {
  const a = report.keyframes[index],
    b = report.keyframes[index + 1];
  if (!a || !b || t <= 0 || report.version < 5 && !a._styk?.easing) return correctAnimationOrigins(report, a);
  if (t >= 1) return correctAnimationOrigins(report, b);
  const auto = easingMode(a._styk?.easing) === 'auto';
  t = auto ? t : easedProgress(a._styk?.easing, t);
  if (t <= 0) return correctAnimationOrigins(report, a);
  if (t >= 1) return correctAnimationOrigins(report, b);
  const legacyEasing = usesLegacyNativeEasing(report, index);
  const types = new Map(report.figure_types.map((f) => [f.figure_type_id, f]));
  const byId = new Map(b.objects.map((o) => [o.unique_id, o]));
  // Reuse per-frame identity indices for all pose channels. A linear find here
  // made tween evaluation quadratic in the number of figures in large scenes.
  const identities = new Map([[a, new Map(a.objects.map(o => [o.unique_id, o]))], [b, byId]]);
  const layouts = new Map();
  // A figure trajectory owns only its figures and their attachment ancestors.
  // Retain unrelated native records by reference instead of interpolating every
  // segment in the movie once for each independently authored trajectory.
  let needed;
  if (requestedUids) {
    needed = new Set(requestedUids);
    const queue = [...needed];
    for (let i = 0; i < queue.length; i++) {
      for (const source of [a, b]) {
        const objects = identities.get(source);
        const object = objects.get(queue[i]);
        const parent = source.objects[object?.join?.target_object_slot];
        if (parent && !needed.has(parent.unique_id)) { needed.add(parent.unique_id); queue.push(parent.unique_id); }
      }
    }
  }
  const frame = {
    ...a,
    objects: a.objects.map((o) => {
      if (needed && !needed.has(o.unique_id)) return o;
      const next = byId.get(o.unique_id),
        fig = types.get(o.figure_type_id);
      if (!next || next.figure_type_id !== o.figure_type_id || !fig) return o;
      const constantTween=!legacyEasing&&tweenCache?.lookup(o,next,fig);
      if(constantTween?.value)return constantTween.value;
      const out = { ...o, runtime_segments: undefined };
      if(o._stykSpatial||next._stykSpatial)out._stykSpatial=interpolateSpatialPose(o,next,t);
      if(o._stykVfx)out._stykVfx=interpolateVfx(o._stykVfx,byId.get(o.unique_id)?._stykVfx,t);
      const matching = (f) => {
        let objects = identities.get(f);
        if (!objects) { objects = new Map(f.objects.map(item => [item.unique_id, item])); identities.set(f, objects); }
        const item = objects.get(o.unique_id);
        return item?.figure_type_id === o.figure_type_id ? item : undefined;
      };
      if (o._stykIK) out._stykIK = interpolateIK(o, next, t, (id, section, key, angular) =>
        parameter(report, index, t, f => {
          const controller = matching(f)?._stykIK?.[id];
          return controller?.enabled && controller.pinned === o._stykIK[id].pinned ? controller[section]?.[key] : undefined;
        }, angular));
      const record = tweenRecords(report.keyframes, matching), presence = presenceRun(report.keyframes, index, record);
      for (const k of ["root_x", "root_y", "scale"])
        out[k] = sampleRecords(report, index, t, record, readField, false, k);
      if (fig._styk?.animationOrigin && o._stykAnimationOrigin && next._stykAnimationOrigin) {
        out._stykAnimationOrigin = {};
        for (const k of ['x', 'y']) out._stykAnimationOrigin[k] = parameter(report, index, t,
          f => matching(f)?._stykAnimationOrigin?.[k]);
        if (o._stykAnimationOrigin.offsetX !== undefined || next._stykAnimationOrigin.offsetX !== undefined ||
            o._stykAnimationOrigin.offsetY !== undefined || next._stykAnimationOrigin.offsetY !== undefined)
          for (const k of ['offsetX', 'offsetY']) out._stykAnimationOrigin[k] = parameter(report, index, t,
            f => {const item = matching(f); return item ? item._stykAnimationOrigin?.[k] ?? 0 : undefined;});
      }
      out.field28 = auto ? Math.round(parameter(report, index, t, f => {const item = matching(f); return item ? Number(item.field28 ?? 0) : undefined;})) :
        Number(o.field28 ?? 0) +
        Math.trunc((Number(next.field28 ?? 0) - Number(o.field28 ?? 0)) * t);
      for (const [flag, field, base] of [
        ["len_flag", "lengths", "length"],
        ["bend_flag", "bends", "bend_rad"],
      ]) {
        if (o[flag] || next[flag] || legacyEasing) {
          out[flag] = 1;
          const read = (item, i, fallback) => item[flag] ? item[field][i] : fallback;
          out[field] = fig.segments.map((s, i) => sampleRecords(report, index, t, record, read, false, i, s[base] ?? 0, presence));
        }
      }
      const originLayout = animationOriginLayout(fig);
      if (fig._styk?.animationOrigin?.support) {
        interpolateOriginSupport(fig, out, (get, angular = false) => parameter(report, index, t,
          frame => {const object = matching(frame); return object ? get(object) : undefined;}, angular));
      } else if (originLayout) {
        // Interpolate the same physical parent angles as before Set Origin.
        // Interpolating the reversed construction tree changes wrap/easing.
        const virtualAngles = new Array(fig.segments.length);
        for (const i of originLayout.ready) {
          const parent = originLayout.parents[i], reversed = Boolean(originLayout.reversed[i]);
          const relative = parameter(report, index, t, f => {
            const item = matching(f); if (!item) return undefined;
            let value = animationOriginAngle(fig, item, i, reversed);
            if (parent >= 0) value -= animationOriginAngle(fig, item, parent, Boolean(originLayout.reversed[parent])) +
              animationOriginBend(fig, item, parent, Boolean(originLayout.reversed[parent]));
            return value;
          }, true);
          virtualAngles[i] = relative + (parent < 0 ? 0 : virtualAngles[parent] +
            animationOriginBend(fig, out, parent, Boolean(originLayout.reversed[parent])));
        }
        out.angles = virtualAngles.map((angle, i) => angle + (originLayout.reversed[i]
          ? animationOriginBend(fig, out, i, true) + Math.PI : 0));
      } else {
      let layout = layouts.get(fig);
      if (!layout) {
      const ids = new Map(fig.segments.map((s, i) => [s.segment_id, i]));
      const children = new Map(), ready = [];
      fig.segments.forEach((s, i) => {
        const parent = ids.get(s.parent_id);
        if (parent === undefined) ready.push(i);
        else {
          const list = children.get(parent) || [];
          list.push(i);
          children.set(parent, list);
        }
      });
      for (let q = 0; q < ready.length; q++) ready.push(...(children.get(ready[q]) || []));
      layout = {ids, ready}; layouts.set(fig, layout);
      }
      const {ids, ready} = layout, angles = new Array(fig.segments.length), relativeTo = {segments: fig.segments, parent: undefined};
      for (let q = 0; q < ready.length; q++) {
        const i = ready[q];
        const s = fig.segments[i],
          parent = ids.get(s.parent_id);
        relativeTo.parent = parent;
        const relative = sampleRecords(report, index, t, record, readRelativeAngle, true, i, relativeTo, presence);
        angles[i] =
          parent === undefined
            ? relative
            : angles[parent] +
              Number(
                out.bend_flag
                  ? out.bends[parent]
                  : (fig.segments[parent].bend_rad ?? 0),
              ) +
              relative;
      }
      out.angles = fig.segments.map(
        (_, i) => angles[i] ?? Number(o.angles?.[i] ?? 0),
      );
      }
      out.color_override_raw = colorTween(
        o.color_override_raw,
        next.color_override_raw,
        t,
      );
      if (auto) {
        let color = 0;
        for (let shift = 0; shift < 32; shift += 8) {
          const component = f => {
            const item = matching(f); if (!item) return undefined;
            // A zero alpha override inherits the neighbouring RGB when fading.
            const raw = Number(item.color_override_raw) >>> 0;
            if (shift < 24 && !(raw >>> 24)) {
              const fallback = Number(o.color_override_raw) >>> 24 ? o.color_override_raw : next.color_override_raw;
              return (fallback >>> shift) & 255;
            }
            return (raw >>> shift) & 255;
          };
          color |= Math.round(parameter(report, index, t, component)) << shift;
        }
        out.color_override_raw = color >>> 0;
      }
      if(constantTween)constantTween.value=out;
      return out;
    }),
  };
  if (a.camera && b.camera) {
    frame.camera = { is_default: false };
    for (const k of ["x", "y", "scale", "angle_rad"])
      frame.camera[k] = parameter(
        report,
        index,
        t,
        (f) => Number(f.camera?.[k] ?? (k === "scale" ? 1 : 0)),
        k === "angle_rad",
      );
    if(a.camera._parallaxMotionOffset||b.camera._parallaxMotionOffset){frame.camera._parallaxMotionOffset={};
      for(const axis of ['x','y'])frame.camera._parallaxMotionOffset[axis]=parameter(report,index,t,f=>Number(f.camera?._parallaxMotionOffset?.[axis]??0));}
  }
  // Image identities cannot share scalar tangents; each crossfade eases locally.
  Object.assign(frame, tweenBackground(a, b, auto ? easedProgress(a._styk.easing, t) : t));
  if(a._stykVfx)frame._stykVfx=interpolateVfx(a._stykVfx,b._stykVfx,t);
  return correctAnimationOrigins(report, frame);
}
/** Every editor, worker and export samples the same authored scene. Native
 * documents take the original evaluator path without channel indexing work. */
export function movieclipPresenceIndex(report){
  const cached=cachedPresenceIndex(report);if(cached)return cached;
  const rows=timeline(report),sheet=report._styk?.layerSheet;
  const boundaries=sheet?[0,sheet.duration,...Object.values(sheet.tracks).flatMap(track=>[track.end,...track.keys.map(key=>key.tick)])]
    :[0,...rows.flatMap(row=>[row.start,row.start+row.count]),...(report._styk?.animation?.channels??[]).flatMap(channel=>channel.keys.map(key=>key.tick))];
  const membership=createSheetMembershipSampler(report,nativeTimeline(report));
  return presenceIndex(report,boundaries,membership??(time=>{
    let low=0,high=rows.length-1;while(low<high){const mid=(low+high+1)>>>1;if(rows[mid].start<=time)low=mid;else high=mid-1;}
    const row=rows[low];return evaluatedFrame(report,low,row?.count?(time-row.start)/row.count:0,time,{skipMovieclips:true});
  }));
}
function sampleClips(report,frame,tick,retainedSamples=false){
  let clock;
  const elapsed=(uid,time)=>{
    if(!clock){
      clock=movieclipPresenceIndex(report);
    }
    return presenceElapsed(clock,uid,time);
  };
  return sampleMovieclipObjects(report,frame,tick,buildGeometry,elapsed,retainedSamples);
}
const withRuntimeTime=(report,frame,tick)=>frameWithCameraTime(report,frameWithVfxTime(report,frame,tick),tick);
export function evaluatedFrame(report, index, t = 0, absoluteTick, {tweenCache,skipMovieclips=false,skipMovieclipPatches=false} = {}) {
  // The cache belongs to the immutable worker snapshot, including virtual
  // native spans used by authored tracks. Endpoint and definition identities
  // still decide reuse inside the one native evaluator.
  const sampleNative = tweenCache ? (source, index, t, _cache, requestedUids) =>
    evaluatedNativeFrame(source, index, t, tweenCache, requestedUids) : evaluatedNativeFrame;
  if(report._styk?.layerSheet){
    const row=timeline(report)[index],tick=absoluteTick??((row?.start??0)+t*(row?.count??0));
    let frame=sampleLayerSheet(report,tick,{resolveGeometry:buildGeometry,skipMovieclipPatches,sampleNative,sampleLegacy:(source,time)=>{
      let rows=authoredTimelines.get(source);if(!rows){rows=timeline(source);authoredTimelines.set(source,rows);}
      let low=0,high=rows.length-1;while(low<high){const mid=(low+high+1)>>>1;if(rows[mid].start<=time)low=mid;else high=mid-1;}
      const current=rows[low];return evaluatedFrame(source,low,current?.count?(time-current.start)/current.count:0,time,{tweenCache,skipMovieclips:true});
    }});
    if(!skipMovieclips&&movieclipTypes(report).size)frame=sampleClips(report,frame,tick);
    return withRuntimeTime(report,applyLayerOrder(report,frame),tick);
  }
  let frame = evaluatedNativeFrame(report, index, t, tweenCache);
  const source = movieclipSourceDocument(report);
  if (source) {
    const a=report.keyframes[index],b=report.keyframes[index+1];
    const start=a?._styk?.movieclipSourceTick;
    if (Number.isFinite(start)) {
      // The final captured frame still spans its fractional output interval.
      // Continue sampling the retained curve until the crop ends.
      const finish=b?._styk?.movieclipSourceTick??start+(timeline(report)[index]?.count??1),sourceTick=start+(finish-start)*Math.max(0,Math.min(1,t));
      let rows=authoredTimelines.get(source);if(!rows){rows=timeline(source);authoredTimelines.set(source,rows);}
      let low=0,high=rows.length-1;while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=sourceTick)low=mid;else high=mid-1;}
      const row=rows[low];frame={...evaluatedFrame(source,low,row.count?(sourceTick-row.start)/row.count:0,sourceTick,{tweenCache,skipMovieclips}),duration_raw:a.duration_raw,_styk:a._styk};
      // Captured local poses carry the phase at the crop's beginning. Retained
      // source evaluation supplies exact curves; local authoring keeps its own
      // clock origin when those source spans are later materialized or edited.
      const settings=new Map(a.objects.filter(usesPresence).map(object=>[object.unique_id,object._stykMovieclip]));
      if(settings.size)frame={...frame,objects:frame.objects.map(object=>settings.has(object.unique_id)?{...object,_stykMovieclip:settings.get(object.unique_id)}:object)};
    }
  }
  if (report._styk?.animation?.channels?.length) {
    let entries = authoredTimelines.get(report);
    if (!entries) authoredTimelines.set(report, entries = timeline(report));
    const entry = entries[index];
    const tick = absoluteTick ?? ((entry?.start || 0) + Math.max(0, t) * (entry?.count || 0));
    frame = composePoseChannels(report, frame, tick, { sampleNative, resolveGeometry: buildGeometry });
    frame = composeAnimationChannels(report, frame, tick, { resolveGeometry: buildGeometry });
  }
  if(!skipMovieclips&&movieclipTypes(report).size){
    let entries=authoredTimelines.get(report);if(absoluteTick===undefined&&!entries){entries=timeline(report);authoredTimelines.set(report,entries);}
    const row=entries?.[index];
    frame = sampleClips(report, frame, absoluteTick ?? ((row?.start ?? 0) + t * (row?.count ?? 0)),Boolean(source));
  }
  if(!report._styk?.cameraMotion?.clips.length&&!report._styk?.vfxClips?.clips.length)return applyLayerOrder(report,frame);
  const row=absoluteTick===undefined?timeline(report)[index]:null;
  return withRuntimeTime(report,applyLayerOrder(report, frame),absoluteTick??((row?.start??0)+t*(row?.count??0)));
}
export function buildGeometry(report, frame, incremental = null) {
  const iterator = buildGeometrySteps(report, frame, incremental);
  for (;;) {
    const step = iterator.next();
    if (step.done) return step.value;
  }
}

/** Shares the exact synchronous builder, with checkpoints inside dense figures
 * as well as between objects. Partial geometry is never published. */
export function* buildGeometrySteps(report, frame, incremental = null) {
  if(frame._vfxTimelineTick!==undefined){frame=vfxRenderFrame(report,frame);if(incremental){const dirtySlots=new Set(incremental.dirtySlots);frame.objects.forEach((o,i)=>{if(o._stykVfx!==incremental.previous?.objects.get(i)?.obj._stykVfx)dirtySlots.add(i);});incremental={...incremental,dirtySlots};}}
  const types = new Map(), definitions = report.figure_types || [];
  for (let index = 0; index < definitions.length; index++) {
    const figure = definitions[index];
    types.set(Number(figure.figure_type_id), figure);
    if ((index & 255) === 255) yield {phase: 'geometry', stage: 'definitions', completed: index + 1, total: definitions.length};
  }
  const cache = new Map(), warnings = [], definitionPlans = new Map();
  if (incremental?.previous) {
    let completed = 0;
    for (const [slot, geometry] of incremental.previous.objects) {
      cache.set(slot, geometry);
      if ((++completed & 255) === 0) yield {phase: 'geometry', stage: 'retained', completed, total: incremental.previous.objects.size};
    }
  }
  if (incremental?.dirtySlots) {
    let completed = 0;
    for (const slot of incremental.dirtySlots) {
      cache.delete(slot);
      if ((++completed & 255) === 0) yield {phase: 'geometry', stage: 'invalidation', completed};
    }
  }
  const joinedIK = solveJoinedIK(report, frame, incremental?.previous ? incremental.dirtySlots : null);
  for (const slot of joinedIK.keys()) cache.delete(slot);
  function* objectAt(slot, seen) {
    if (cache.has(slot)) return cache.get(slot);
    const obj = frame.objects[slot],
      fig = resolveInstanceFigure(types.get(Number(obj?.figure_type_id)), obj);
    if (!obj || !fig) return null;
    if (seen?.has(slot)) {
      warnings.push(`Cyclic join at object ${slot}`);
      return null;
    }
    let root = { x: Number(obj.root_x ?? 0), y: Number(obj.root_y ?? 0) },joinedParent;
    if (obj.join) {
      const parentSlot=Number(obj.join.target_object_slot);
      // Topological traversal normally resolved this parent already. Only an
      // unresolved recursive attachment needs a cycle-detection path.
      let parent=cache.get(parentSlot);
      if(!cache.has(parentSlot)){
        const path=new Set(seen);path.add(slot);
        parent=yield* objectAt(parentSlot,path);
      }
      const p = parent?.joints.get(Number(obj.join.target_handle_id ?? 0));
      joinedParent=parent;
      if (p) root = { ...p };
      else warnings.push(`Unresolved join at object ${slot}`);
    }
    if (isMovieclip(fig)) {
      const geometry = yield* buildMovieclipGeometrySteps(fig,obj,root,slot,{timeline,evaluatedFrame,buildGeometry,buildGeometrySteps,joinedParent,objectColor,previous:incremental?.previous?.objects.get(slot)});
      cache.set(slot,geometry); return geometry;
    }
    const previous = incremental?.previous?.objects.get(slot), poseAllowed = incremental?.poseSlots?.has(slot);
    const retainedPlan=geometryPosePlan(fig,obj,previous,poseAllowed);
    let plan = definitionPlans.get(fig);
    if (!plan) {plan = retainedPlan ? geometryPlans(previous).definition : geometryDefinition(fig); definitionPlans.set(fig, plan);}
    const rigPlan=retainedPlan ?? (hasRigConstraints(fig)?yield* rigConstraintPlanSteps(fig):null);
    const ik = joinedIK.get(slot) ?? (hasPinnedIK(obj) ? evaluateIKPose(report, `local:${obj.unique_id}`, fig, obj, root, plan,rigPlan) : null);
    const joints = new Map([[0, root]]),
      renders = [],
      {segments, ids} = plan;
    const scale = Number(obj.scale ?? 1),
      opacity = 1 - Number(obj.field28 ?? obj.transparency ?? 0) / 255;
    const rig = rigPlan ? createRigEvaluation(fig, obj, root, rigPlan) : null;
    const pose = geometryPose(fig, obj, root, rig, previous, poseAllowed, report.version, plan);
    function segmentAt(i, active) {
      if (renders[i]) return renders[i];
      if (active?.has(i)) {
        warnings.push(`Cyclic segment ${i} in object ${slot}`);
        return null;
      }
      const seg = segments[i],
        parent = ids.get(Number(seg.parent_id));
      if (parent !== undefined && !joints.has(Number(seg.parent_id))) {
        active ??= new Set(); active.add(i);
        segmentAt(parent, active);
      }
      let start = joints.get(Number(seg.parent_id)) || root;
      const rt = obj.runtime_segments?.[i];
      let angle = Number(
        ik?.angles[i] ?? obj.angles?.[i] ?? rt?.angle_rad ?? seg.angle_rad ?? 0,
      );
      let bend = Number(
        obj.bend_flag
          ? (obj.bends?.[i] ?? 0)
          : (rt?.bend_rad ?? seg.bend_rad ?? 0),
      );
      let length =
        Number(
          ik?.lengths?.[i] ?? (obj.len_flag
            ? (obj.lengths?.[i] ?? seg.length)
            : (rt?.length ?? seg.length ?? 0)),
        ) * scale;
      if (pose?.reuse(i, angle, length, bend)) {
        const prior = previous.segments[i];
        joints.set(Number(seg.segment_id), previous.joints.get(Number(seg.segment_id)));
        renders[i] = prior;
        return prior;
      }
      const rigPose = rig?.evaluate(i, {start,angle,length,bend}, joints);
      if (rigPose) ({start,angle,length,bend} = rigPose);
      let points,end;
      if(rigPose?.handle&&(seg._stykRig?.spatial||seg._stykRig?.weighted)){
        end={x:Math.fround(rigPose.handle.x),y:Math.fround(rigPose.handle.y)};points=[start,end];
      }else if(Math.abs(bend)<1e-7&&Number.isFinite(start.x)&&Number.isFinite(start.y)&&Number.isFinite(angle)&&Number.isFinite(length)){
        // The native endpoint is rounded once. A straight segment needs no
        // intermediate unrounded point or curve-validation array.
        end={x:Math.fround(start.x+length*Math.cos(angle)),y:Math.fround(start.y+length*Math.sin(angle))};
        points=[start,end];
      }else{
        points=arc(start,angle,length,bend);
        const last=points.at(-1)||start;
        end={x:Math.fround(last.x),y:Math.fround(last.y)};
        if(points.length)points[points.length-1]=end;
      }
      const handle = rigPose?.handle&&!(seg._stykRig?.spatial||seg._stykRig?.weighted) ? {x:Math.fround(rigPose.handle.x),y:Math.fround(rigPose.handle.y)} : end;
      if(rigPose?.depthOffset)handle.depthOffset=rigPose.depthOffset;
      if(rigPose?.handle?.rawPoint)handle.rawPoint=rigPose.handle.rawPoint;
      joints.set(Number(seg.segment_id), handle);
      const override = Number(obj.color_override_raw) >>> 0;
      const rgb =
        report.version < 5 && fig._styk?.colorMode !== 'segments'
          ? (Number(obj.color_override_raw) | 0) < 0
            ? [0, 0, 0]
            : color(obj.color_override_raw).rgb
          : objectColor(seg.color_rgb ?? [0, 0, 0], obj);
      const assets =
        seg.segment_type === "text"
          ? fig.text_assets
          : seg.segment_type === "image"
            ? fig.image_assets
            : null;
      let asset = assets?.find(
        (a) =>
          Number(
            a.asset_index ?? a.table_index ?? a.image_index ?? a.sprite_index,
          ) ===
          Number(
            seg.extra_u16 ??
              seg.extra?.[0] ??
              seg.image_asset_index ??
              seg.sprite_index ??
              0,
          ),
      );
      if (asset && !asset.anchor_length && asset.pivot && asset.endpoint) {
        asset = {
          ...asset,
          anchor_start: asset.pivot,
          anchor_end: asset.endpoint,
          anchor_length: Math.hypot(
            asset.endpoint.x - asset.pivot.x,
            asset.endpoint.y - asset.pivot.y,
          ),
          anchor_angle_rad: Math.atan2(
            asset.endpoint.y - asset.pivot.y,
            asset.endpoint.x - asset.pivot.x,
          ),
        };
      }
      const render = {
        type: seg.segment_type === 'circle' || seg.segment_type === 'image' || seg.segment_type === 'text' ? seg.segment_type : 'line',
        seg,
        obj,
        fig,
        asset,
        version: report.version,
        slot,
        index: i,
        start,
        end,
        points,
        angle,
        bend,
        length,
        z: Number(seg.z_order ?? i + 1),
        thickness: Number(seg.thickness ?? 0) * Math.abs(scale) * (rigPose?.width ?? 1),
        rgb,
        alpha:
          seg.transparency === undefined
            ? (seg.color_alpha ?? 1)
            : 1 - seg.transparency / 255,
        opacity,
        static: isStatic(seg),
      };
      if(rigPose)render.authoredAngle=rigPose.authoredAngle;
      if(rigPose?.spatial)render.spatialFrame=rigPose.spatial;
      if(rigPose?.connector){render.handle=handle;render.connector=true;render.attachmentPosition=rigPose.position;}
      if(rigPose?.space)render.rigSpace=rigPose.space;
      if(rigPose?.childSpace)render.rigChildSpace=rigPose.childSpace;
      if(rigPose?.rotation)render.rigRotation=rigPose.rotation;
      const sourceShape=sticknodesShape(seg,obj);
      if(sourceShape?.sagitta&&Math.abs(bend)<1e-7){render.points=sticknodesCurve(sourceShape,start,angle,length,scale);render.bend=1e-6;render._sticknodesCurve=true;}
      if(obj._sticknodesSprite)render.asset=sticknodesSpriteAsset(asset,obj);
      renders[i] = render;
      return render;
    }
    let built = 0;
    for (const i of rig?.plan.order ?? plan.order) {
      segmentAt(i);
      if ((++built & 127) === 0) yield {phase:'geometry',stage:'segments',slot,completed:built,total:plan.order.length};
    }
    if (plan.order.length < segments.length)
      warnings.push(`Cyclic segment hierarchy in object ${slot}`);
    const malformedEdges = ids.size !== segments.length ? new Map(
      renders.filter(Boolean).map((s) => [
        `${s.seg.parent_id}:${s.seg.segment_id}`,
        s,
      ]),
    ) : null;
    const polys = [],surfaceEvaluation=createSurfaceEvaluation(joints),camera=projection(obj,root);
    for (let i = 0; i < (fig.polyfills?.length ?? 0); i++) {
      if (pose?.reusePolygon(i)) {
        polys.push(previous.polys[i]);
        if ((i & 31) === 31) yield {phase:'geometry',stage:'polygons',slot,completed:i+1,total:fig.polyfills.length};
        continue;
      }
      const poly = fig.polyfills[i];
      const polygon = plan.polygons[i], points = [];
      if (polygon.first !== undefined && joints.has(polygon.first)) points.push(joints.get(polygon.first));
      for (let j = 0; j < polygon.edges.length; j++) {
        const step = polygon.edges[j], b = step.end;
        let edge = renders[step.index], reverse = step.reverse;
        if (malformedEdges) {
          const a = Number(poly.segment_ids[j]), forward = malformedEdges.get(`${a}:${b}`);
          edge = forward || malformedEdges.get(`${b}:${a}`); reverse = !forward;
        }
        if (edge && Math.abs(edge.bend) > 1e-7 && (!edge.connector || edge.seg.parent_id===edge.seg._stykRig.connector.start)) {
          const edgePoints=edge.connector?arc(edge.start,edge.angle,edge.length*edge.attachmentPosition,edge.bend*edge.attachmentPosition):edge.points;
          points.push(
            ...(reverse ? [...edgePoints].reverse() : edgePoints).slice(1),
          );
        } else if (joints.has(b)) points.push(joints.get(b));
        if ((j & 255) === 255) yield {phase:'geometry',stage:'polygon',slot,completed:j+1,total:polygon.edges.length};
      }
      if (
        points.length > 1 &&
        points[0].x === points.at(-1).x &&
        points[0].y === points.at(-1).y
      )
        points.pop();
      const projected=poly._stykSurface?.depthTest?projectSpatialFace(points,camera):null;
      if(projected&&projected.points!==points)points.splice(0,points.length,...projected.points);
      const surface=poly._stykSurface?surfaceEvaluation(poly,points,projected):null;
      const render={
        type: "poly",
        poly,
        obj,
        fig,
        slot,
        index: i,
        points,
        z:surface?.z??Number(poly.z_order??0),
        rgb: objectColor(poly.color_rgb ?? [0, 0, 0], obj),
        alpha:
          poly.alpha_raw === undefined
            ? (poly.color_alpha ?? 1)
            : 1 - poly.alpha_raw / 255,
        opacity,
      };
      if(surface){render.culled=surface.culled;if(surface.depthValues)render.depthValues=surface.depthValues;}
      polys.push(render);
      if ((i & 31) === 31) yield {phase:'geometry',stage:'polygons',slot,completed:i+1,total:fig.polyfills.length};
    }
    // Mesh vertices are definition data evaluated in one typed pass after
    // their bones; they never enter joints, segments or polygons.
    const meshPlan = rig ? spatialMeshPlan(fig, rig.plan.ids) : null;
    let spatialMesh = null, meshDrawables = null;
    if (meshPlan) {
      const frames = new Array(segments.length);
      for (const i of meshPlan.bones) frames[i] = renders[i]?.spatialFrame;
      spatialMesh = yield* evaluateSpatialMeshSteps(meshPlan, frames, {root, scale, figureAngle: animationRotation(fig, obj),
        mirror: Boolean(obj.image_text_flags), camera, joints, colorOf: (c,index) => objectColor(meshPaletteColor(fig,obj,index)??c, obj), slot}, previous?.spatialMesh);
      const levels = [];
      for (const p of polys) if (!p.culled) levels.push(p.z);
      // Zero-width lines paint nothing and must not split the depth-tested faces.
      for (const s of renders) if (s && s.seg.visible !== false && !(s.type === 'line' && !(s.thickness > 0))) levels.push(s.z);
      meshDrawables = spatialMeshDrawables(spatialMesh, {obj, fig, slot, opacity}, levels);
    }
    const geometry = {
      slot,
      ...(ik ? {ik: ik.results, solvedAngles: ik.angles, solvedLengths: ik.lengths} : {}),
      obj,
      fig,
      root,
      joints,
      segments: renders.filter(Boolean),
      polys,
      ...(spatialMesh ? {spatialMesh, meshDrawables} : {}),
    };
    const renderSource=incremental?.renderSources?.get(slot);
    if (pose && poseAllowed) geometry.drawables = orderPoseDrawables(geometry, previous);
    if(renderSource)Object.defineProperty(geometry,'renderSource',{value:renderSource});
    pose?.publish(geometry);
    cache.set(slot, geometry);
    return geometry;
  }
  if (incremental?.previous && incremental?.dirtySlots) {
    const dirty = new Set(incremental.dirtySlots), children = new Map(), ready = [];
    let completed = 0;
    for (const slot of dirty) {
      const target = frame.objects[slot]?.join?.target_object_slot;
      if (target === undefined || !dirty.has(target)) ready.push(slot);
      else { const list = children.get(target) || []; list.push(slot); children.set(target, list); }
      if ((++completed & 255) === 0) yield {phase: 'geometry', stage: 'joins', completed, total: dirty.size};
    }
    for (let q = 0; q < ready.length; q++) {
      yield* objectAt(ready[q]); ready.push(...(children.get(ready[q]) || []));
      yield {phase: 'geometry', stage: 'objects', completed: q + 1, total: dirty.size};
    }
    completed = 0;
    for (const slot of dirty) {
      if (!cache.has(slot)) { cache.set(slot, null); warnings.push(`Cyclic join or unresolved target at object ${slot}`); }
      if ((++completed & 255) === 0) yield {phase: 'geometry', stage: 'unresolved', completed, total: dirty.size};
    }
  } else {
  const joinedChildren = new Map(),
    ready = [];
  for (let i = 0; i < frame.objects.length; i++) {
    if (!(i in frame.objects)) continue;
    const o = frame.objects[i];
    if (!o.join) ready.push(i);
    else {
      const p = Number(o.join.target_object_slot),
        list = joinedChildren.get(p) || [];
      list.push(i);
      joinedChildren.set(p, list);
    }
    if ((i & 255) === 255) yield {phase: 'geometry', stage: 'joins', completed: i + 1, total: frame.objects.length};
  }
  for (let q = 0; q < ready.length; q++) {
    const slot = ready[q];
    yield* objectAt(slot);
    ready.push(...(joinedChildren.get(slot) || []));
    yield {phase: 'geometry', stage: 'objects', completed: q + 1, total: frame.objects.length};
  }
  for (let i = 0; i < frame.objects.length; i++) {
    if (!(i in frame.objects)) continue;
    if (!cache.has(i)) {
      cache.set(i, null);
      warnings.push(`Cyclic join or unresolved target at object ${i}`);
    }
    if ((i & 255) === 255) yield {phase: 'geometry', stage: 'unresolved', completed: i + 1, total: frame.objects.length};
  }
  }
  const order = frame.object_draw_order ?? frame.objects.map((_, i) => i),
    orderedObjects = [];
  let collected = 0;
  for (const slot of order) {
    const g = yield* objectAt(Number(slot));
    if (!g) {
      yield {phase: 'geometry', stage: 'drawables', completed: ++collected, total: order.length};
      continue;
    }
    let local = g.drawables;
    if (!local) {
      // One pass in the same order as polys, meshes, then visible segments with
      // their Stick Nodes expansions; no intermediate array per primitive.
      local = [];
      for (const p of g.polys) if (!p.culled) local.push(p);
      if (g.meshDrawables) for (const m of g.meshDrawables) local.push(m);
      for (const s of g.segments) {
        if (s.seg.visible === false) continue;
        const expanded = sticknodesDrawables(s);
        if (expanded) for (const e of expanded) local.push(e); else local.push(s);
      }
      local.sort((a, b) => a.z - b.z); g.drawables = local;
    }
    if (local.length) orderedObjects.push(g);
    yield {phase: 'geometry', stage: 'drawables', completed: ++collected, total: order.length};
  }
  return publishedGeometry(cache,orderedObjects,incremental?.previous?.token,
    incremental?.dirtySlots ? new Set(incremental.dirtySlots) : null,warnings);
}

// Build the lazy view in its own scope. A getter defined inside the generator
// captures its shared context, including incremental.previous, and keeps every
// earlier pose alive even though the returned fields only mention its token.
function publishedGeometry(objects,orderedObjects,previousToken,changedSlots,warnings) {
  let drawables;
  return { objects, orderedObjects, token: {}, previousToken, changedSlots,
    get drawables() { return drawables ??= orderedObjects.flatMap(g => g.drawables); }, warnings };
}

const yieldGeometryTask = globalThis.scheduler?.yield ? () => globalThis.scheduler.yield() : () => new Promise(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {channel.port1.close(); channel.port2.close(); resolve();};
  channel.port2.postMessage(null);
});

/** Prepare unpublished geometry with cancellation checkpoints inside figures.
 * sliceMs is a scheduling target; individual native primitives stay exact. */
export async function buildGeometryAsync(report, frame, incremental = null,
  {sliceMs = 4, signal, checkCurrent, yieldControl = yieldGeometryTask, onProgress, onTiming} = {}) {
  if (!Number.isFinite(sliceMs) || sliceMs < 0) throw messageError(new Error(''), "errors.geometry.chooseANonnegativeGeometryPreparationSliceDuration", {});
  const check = () => {
    if (signal?.aborted || checkCurrent?.() === false)
      throw messageError(new DOMException('', 'AbortError'), "errors.geometry.geometryPreparationWasCancelledOrSuperseded", {});
  };
  check();
  const iterator = buildGeometrySteps(report, frame, incremental), started = performance.now();
  let sliceStarted = null, cpuMs = 0, maxTaskMs = 0, slices = 0, yields = 0, steps = 0, completed = false;
  const finishSlice = () => {
    if (sliceStarted === null) return;
    const elapsed = performance.now() - sliceStarted;
    cpuMs += elapsed; maxTaskMs = Math.max(maxTaskMs, elapsed); slices++; sliceStarted = null;
  };
  try {
    for (;;) {
      check(); sliceStarted = performance.now(); let progress;
      do {
        check(); const step = iterator.next(); steps++;
        if (step.done) {check(); completed = true; return step.value;}
        progress = step.value;
      } while (performance.now() - sliceStarted < sliceMs);
      onProgress?.(progress); check(); finishSlice(); yields++;
      await yieldControl();
    }
  } finally {
    finishSlice(); iterator.return();
    onTiming?.({elapsedMs: performance.now() - started, cpuMs, maxTaskMs, slices, yields, steps, completed});
  }
}
function objectColor(base, obj) {
  if (obj.color_transition) {
    const c = obj.color_transition,
      a = mixColor(base, c.from),
      b = mixColor(base, c.to);
    return a.map((v, i) => Math.round(lerp(v, b[i], c.t)));
  }
  return mixColor(base, obj.color_override_raw);
}
const groupCanvases = new WeakMap();
const outlineCanvases = new WeakMap();
/** Release temporary isolation surfaces after a one-shot raster has been captured.
 * Long-lived Canvas renderers can keep their scratch surfaces for ordinary reuse. */
export function releaseGeometryResources(ctx, { retainCanvases = false } = {}) {
  if (!retainCanvases) releaseSurfaceRaster(ctx);
  if (!retainCanvases) releaseBackgroundResources(ctx);
  releaseVfxSurface(ctx,{retainSoftwareFilters:retainCanvases});
  for (const cache of [groupCanvases, outlineCanvases]) {
    const scratch = cache.get(ctx);
    if (!scratch) continue;
    if (!retainCanvases) cache.delete(ctx);
    releaseGeometryResources(scratch.getContext('2d'), { retainCanvases });
    scratch.width = 1; scratch.height = 1;
  }
}
/** A conservative user-space rectangle for everything drawGeometry can paint
 * for these items, or null when effects may paint beyond their artwork.
 * objectBounds pads strokes by half their width; square caps at an angle reach
 * up to sqrt(2) times that, so a quarter of the widest stroke is added. */
function isolationBounds(items, resources) {
  let widest = 0;
  for (const s of items) {
    if (hasDrawableVfx(s) || activeVfx(segmentVfx(s)).length) return null;
    widest = Math.max(widest, Math.abs(s.thickness ?? 0) + 2 * Math.abs(s.outline ?? 0));
  }
  const b = objectBounds(items, resources), pad = widest / 4;
  return {x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad};
}
/** Composite paint() at alpha as one layer. With bounds, the scratch surface
 * ends at the layer's far corner and only the layer is cleared and composited:
 * compositing an OffscreenCanvas snapshots its whole surface, so a frame-sized
 * layer cost about 1.5 ms per translucent figure even when clipped. The surface
 * keeps the destination's origin (translated surfaces antialias edges slightly
 * differently) and nothing is painted outside the bounds, so pixels are unchanged. */
function isolated(ctx, alpha, paint, cache, bounds = null) {
  if (alpha <= 0) return;
  if (alpha >= 1) {
    paint(ctx);
    return;
  }
  const width = ctx.canvas.width, height = ctx.canvas.height;
  let x0 = 0, y0 = 0, x1 = width, y1 = height;
  if (typeof bounds === 'function') bounds = bounds();
  if (bounds) {
    const m = ctx.getTransform();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]]) {
      const dx = m.a * x + m.c * y + m.e, dy = m.b * x + m.d * y + m.f;
      left = Math.min(left, dx); right = Math.max(right, dx); top = Math.min(top, dy); bottom = Math.max(bottom, dy);
    }
    if (Number.isFinite(left + top + right + bottom)) {
      x0 = Math.max(0, Math.floor(left) - 2); y0 = Math.max(0, Math.floor(top) - 2);
      x1 = Math.min(width, Math.ceil(right) + 2); y1 = Math.min(height, Math.ceil(bottom) + 2);
      // The isolated brush is private, so an off-surface layer has nothing to paint.
      if (x1 <= x0 || y1 <= y0) return;
    }
  }
  // Allocations grow in 64-pixel steps, so similar figures reuse one surface.
  const layerWidth = x1 - x0, layerHeight = y1 - y0;
  const surfaceWidth = Math.min(width, Math.ceil(x1 / 64) * 64), surfaceHeight = Math.min(height, Math.ceil(y1 / 64) * 64);
  let scratch = cache.get(ctx);
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(surfaceWidth, surfaceHeight)
        : ctx.canvas.ownerDocument.createElement("canvas");
    cache.set(ctx, scratch);
  }
  if (scratch.width !== surfaceWidth) scratch.width = surfaceWidth;
  if (scratch.height !== surfaceHeight) scratch.height = surfaceHeight;
  // Opacity and outline isolation must follow the destination's storage policy;
  // otherwise a software export silently creates full-size GPU scratch images.
  const temp = scratch.getContext("2d", {
    willReadFrequently: ctx.getContextAttributes?.().willReadFrequently === true,
  });
  if (!temp || temp.isContextLost?.()) throw Object.assign(messageError(new Error(''), "errors.geometry.theTemporaryDrawingCanvasIsUnavailable", {}), { telemetryCode: 'device_lost' });
  configureVfxSoftwareResources(temp,{owner:ctx});
  temp.setTransform(1, 0, 0, 1, 0, 0);
  temp.clearRect(x0, y0, layerWidth, layerHeight);
  temp.setTransform(ctx.getTransform());
  paint(temp);
  if (temp.isContextLost?.()) throw Object.assign(messageError(new Error(''), "errors.geometry.theTemporaryDrawingCanvasWasLostWhileRendering", {}), { telemetryCode: 'device_lost' });
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.imageSmoothingEnabled = false;
  // A clip keeps the whole-image blend pipeline; a source rectangle does not
  // round identically.
  if (x0 > 0 || y0 > 0 || x1 < surfaceWidth || y1 < surfaceHeight) { ctx.beginPath(); ctx.rect(x0, y0, layerWidth, layerHeight); ctx.clip(); }
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}
function floatBits(n) {
  const a = new Uint32Array([n]);
  return new Float32Array(a.buffer)[0];
}
/** Fingerprint of everything that could change a group's painted pixels.
 * withVfx caches filtered surfaces per (context, stack object, signature);
 * this hint is the signature's content component, so a repeated signature can
 * only come from identical painted content. A false miss only refilters; a
 * false hit would reuse wrong pixels, so the projection stays generous. */
function vfxCacheHint(items) {
  let h = "";
  // A dense figure shares one pose across all its faces. Include shared records
  // once, with local references, instead of repeating its full joint arrays for
  // every face. This dictionary belongs to this signature only.
  const records = new Map();
  const record = value => {
    if (records.has(value)) return `@${records.get(value)}`;
    const id = records.size; records.set(value, id);
    let text = ""; try { text = JSON.stringify(value) ?? ""; } catch {}
    return `@${id}:${text.length}:${text}`;
  };
  for (const i of items) {
    const obj = record(i.obj), paint = record(i.seg?.paint), style = record(i.fig?.segment_decode?.global_style);
    h += (i.type ?? "") + "|" + (i.obj?.unique_id ?? "") + "|" +
      (i.seg?.segment_id ?? "") + "|" + (i.fig?.figure_type_id ?? "") + "|" +
      (i.thickness ?? "") + "|" + (i.baseThickness ?? "") + "|" +
      (i.outline ?? "") + "|" + (i.rgb ?? "") + "|" + (i.alpha ?? "") + "|" +
      (i.start?.x ?? "") + "," + (i.start?.y ?? "") + "|" +
      (i.end?.x ?? "") + "," + (i.end?.y ?? "") + "|" + (i.bend ?? "") + "|" +
      (i.asset?.normalized_svg_path ?? i.asset?.image_id ?? i.asset?.background_id ?? "") + "|" +
      (i._movieclipPart ?? "") + "|" + obj + "|" + paint + "|" + style + "|";
    if (i.points) for (const p of i.points) h += p.x + "," + p.y + ";";
    for (let inner = i._movieclipInner; inner; inner = inner.inner) {
      let fx = "";
      try { fx = JSON.stringify(inner.owner?.effects); } catch {}
      h += ">" + (inner.part ?? "") + "~" + (inner.owner?.opacity ?? "") + "~" +
        (inner.owner?.scale ?? "") + "~" + fx;
    }
    h += "#";
  }
  return h;
}
export function drawGeometry(ctx, geometry, resources = {}) {
  // The native export restores its brush after each frame. Opaque objects share
  // this state; every isolated opacity/outline pass starts with a fresh brush.
  const mainStroke = geometry.strokeState || { width: 1 };
  // Pivot applies object transparency once to the completed object, including overlaps.
  const groups = [];
  for (const s of geometry.drawables) {
    let g = groups.at(-1);
    if (!g || g.slot !== s.slot) {
      g = { slot: s.slot, opacity: s.opacity, items: [] };
      groups.push(g);
    }
    g.items.push(s);
  }
  for (const g of groups) {
    const owner = g.items[0]?._movieclipOwner;
    const skipPaint = geometry.skipPaint === true;
    // Culled export objects still update Pivot's shared brush tolerance. An
    // isolated object's brush is private, so it has no state to carry forward.
    if (skipPaint && (owner || g.opacity < 1 || activeVfx(vfxStack(g.items[0]?.obj)).length)) continue;
    if (owner) {
      isolated(ctx,owner.opacity,target=>withVfx(target,owner.effects,filtered=>drawGeometry(filtered, {drawables:g.items.map(item => {
        const inner=item._movieclipInner;
        return {...item,slot:item._movieclipPart,_movieclipOwner:inner?.owner,_movieclipPart:inner?.part,_movieclipInner:inner?.inner};
      })},resources),{bounds:owner.effects?.length?objectBounds(g.items,resources):undefined,domainBounds:owner.effects?.length?(owner.domainBounds??objectBounds(g.items,{...resources,vfxBounds:false})):undefined,scale:owner.scale,cacheHint:()=>vfxCacheHint(g.items),outputRect:geometry.outputRect}),groupCanvases,
        ()=>activeVfx(owner.effects).length?null:isolationBounds(g.items,resources));
      continue;
    }
    const effects=vfxStack(g.items[0]?.obj);
    isolated(ctx,g.opacity,filtered=>withVfx(
      filtered,effects,
      (target) => {
        const stroke = target === ctx ? mainStroke : { width: 1 };
        const style = g.items.find((s) => s.fig)?.fig.segment_decode
            ?.global_style,
          ow = style ? floatBits(style.u28) : 0;
        if (ow > 0 && Number.isFinite(ow)) {
          const outline = g.items
            .filter((s) => s.type !== "image")
            .map((s) => ({
              ...s,
              outline: ow * Math.abs(s.obj.scale ?? 1),
              rgb: style.rgb,
              alpha: 1,
              baseThickness: s.thickness,
              thickness:
                s.thickness === undefined
                  ? undefined
                  : s.thickness + 2 * ow * Math.abs(s.obj.scale ?? 1),
            }));
          if (!skipPaint || Number(style.u30 ?? 0) <= 0) isolated(
            target,
            1 - Number(style.u30 ?? 0) / 255,
            (c) =>
              drawPrimitives(
                c,
                outline,
                resources,
                c === target ? stroke : { width: 1 },
                !skipPaint,
                null,
                geometry.outputRect,
              ),
            outlineCanvases,
            () => isolationBounds(outline, resources),
          );
        }
        const clip = !effects.length && !(ow > 0) ? geometry.clipBounds : null;
        drawPrimitives(target, g.items, resources, stroke, !skipPaint, clip, geometry.outputRect);
      },
      {bounds:effects.length?objectBounds(g.items,resources):undefined,domainBounds:effects.length?objectBounds(g.items,{...resources,vfxBounds:false}):undefined,scale:Math.abs(g.items[0]?.obj.scale??1),cacheHint:()=>vfxCacheHint(g.items),outputRect:geometry.outputRect},
    ),groupCanvases,()=>activeVfx(effects).length?null:isolationBounds(g.items,resources));
  }
}
const vectorPaths = new WeakMap();
function gradient(ctx, s) {
  if (s.seg?.paint && !s.outline && Number(s.obj.color_override_raw) >>> 24 !== 255)
    return canvasPaint(ctx, segmentPaint(s.seg), s.start, s.end, c => objectColor(c, s.obj),shapePaintBounds(s));
  if (
    s.outline ||
    !s.seg?.secondary ||
    Number(s.obj.color_override_raw) >>> 24 === 255
  )
    return null;
  let end = s.end;
  const dx = end.x - s.start.x,
    dy = end.y - s.start.y;
  if (Math.abs(s.bend) > 1e-7 && s.type === "line") {
    const xs = s.points.map((p) => p.x),
      ys = s.points.map((p) => p.y),
      w = Math.max(...xs) - Math.min(...xs),
      h = Math.max(...ys) - Math.min(...ys);
    if (w > 1e-6 && h > 1e-6) {
      const d = (dx * dx) / (w * w) + (dy * dy) / (h * h),
        gx = dx / (w * w * d),
        gy = dy / (h * h * d),
        norm = gx * gx + gy * gy;
      if (norm > 0)
        end = { x: s.start.x + gx / norm, y: s.start.y + gy / norm };
    }
  }
  const g = ctx.createLinearGradient(s.start.x, s.start.y, end.x, end.y);
  g.addColorStop(0, rgba(s.rgb, s.alpha));
  g.addColorStop(
    1,
    rgba(objectColor(s.seg.secondary.rgb, s.obj), 1 - s.seg.secondary.a / 255),
  );
  return g;
}
function strokeWidth(stroke, requested) {
  requested = Math.fround(Math.max(0, requested));
  // FMX's setter uses an absolute 0.0001 tolerance before updating its cache.
  if (Math.abs(requested - stroke.width) > 1e-4) stroke.width = requested;
  return stroke.width;
}
function drawPrimitives(ctx, items, resources, stroke, paint = true, clip = null, outputRect = null) {
  // Styles this loop last assigned. Parsing an unchanged colour or line style
  // again for every primitive dominated dense software frames; branches that
  // may leave other context state behind forget these values.
  let fillStyle, strokeStyle, lineCap, lineJoin, lineWidth;
  const forget = () => { fillStyle = strokeStyle = lineCap = lineJoin = lineWidth = undefined; };
  const fill = value => { if (value !== fillStyle) ctx.fillStyle = fillStyle = value; };
  const line = (width, cap, join) => {
    if (width !== lineWidth) ctx.lineWidth = lineWidth = width;
    if (cap !== undefined && cap !== lineCap) ctx.lineCap = lineCap = cap;
    if (join !== lineJoin) ctx.lineJoin = lineJoin = join;
  };
  for (let itemIndex=0;itemIndex<items.length;itemIndex++) {
    const s=items[itemIndex];
    if(paint&&depthSurface(s)){
      let end=itemIndex+1;while(end<items.length&&depthSurface(items[end]))end++;
      paintDepthSurfaces(ctx,items.slice(itemIndex,end));itemIndex=end-1;forget();continue;
    }
    // Outline and brush-only passes have nothing to paint for a solid mesh.
    if(s.type==='mesh')continue;
    // Adjacent opaque triangles of a projected solid share coverage. Filling
    // each separately antialiases the internal edges against the background.
    // Union consecutive, equally wound faces without crossing painter layers.
    if(paint&&ctx.globalAlpha===1&&opaqueSurfaceTriangle(s)){
      const winding=triangleWinding(s.points),rgb=s.rgb;
      fill(rgba(rgb,1));strokeWidth(stroke,0);ctx.beginPath();
      let end=itemIndex;
      for(;;){
        const face=items[end],p=face.points;
        if(clip&&primitiveOutsideRasterClip(face,clip,0)){if(clip.stats)clip.stats.culledPrimitives++;}
        else{ctx.moveTo(p[0].x,p[0].y);ctx.lineTo(p[1].x,p[1].y);ctx.lineTo(p[2].x,p[2].y);ctx.closePath();}
        const next=items[end+1];
        if(!opaqueSurfaceTriangle(next)||next.rgb.some((c,i)=>c!==rgb[i])||triangleWinding(next.points)!==winding)break;
        end++;
      }
      ctx.fill('nonzero');itemIndex=end;continue;
    }
    const effects=!s._vfxSkipNode&&!s.outline?segmentVfx(s):[];
    if(activeVfx(effects).length && paint){withVfx(ctx,effects,target=>drawPrimitives(target,[{...s,_vfxSkipNode:true}],resources,stroke),{bounds:objectBounds([s],resources),domainBounds:objectBounds([s],{...resources,vfxBounds:false}),scale:Math.abs(s.obj.scale??1),cacheHint:()=>vfxCacheHint([s]),outputRect});forget();continue;}
    if (paint) {
      const brush = gradient(ctx, s) || rgba(s.rgb, s.alpha);
      fill(brush);
      if (brush !== strokeStyle) ctx.strokeStyle = strokeStyle = brush;
    }
    if (s.type === "text" || s.type === "image") forget();
    if (s.type === "text") {
      const a = s.asset;
      if (!a?.normalized_svg_path || !a.bounds.width) continue;
      const outlineWidth = (2 * s.outline) / Math.abs(s.obj.scale ?? 1);
      if (!paint) {
        if (s.outline && a.placements?.some(pl => pl.visible)) strokeWidth(stroke, outlineWidth);
        continue;
      }
      const reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]),
        mirror =
          Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !==
          Boolean(s.obj.image_text_flags);
      const start = reverse ? s.end : s.start;
      ctx.save();
      ctx.translate(start.x, start.y);
      ctx.rotate(s.angle + (reverse ? Math.PI : 0) - (mirror ? Math.PI : 0));
      const xs =
        Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / a.bounds.width;
      ctx.scale(mirror ? -xs : xs, Number(s.obj.scale ?? 1));
      for (const pl of a.placements || []) {
        if (!pl.visible) continue;
        const glyph = a.glyphs[pl.glyph_index];
        let path = vectorPaths.get(glyph);
        if (!path) {
          path = new Path2D(glyph.svg_path);
          vectorPaths.set(glyph, path);
        }
        ctx.save();
        ctx.translate(pl.x - a.bounds.left, pl.y - a.bounds.bottom);
        if (s.outline) {
          ctx.strokeStyle = rgba(s.rgb);
          ctx.lineWidth = strokeWidth(
            stroke,
            outlineWidth,
          );
          ctx.lineCap = ctx.lineJoin = "round";
          ctx.stroke(path);
        } else {
          ctx.fillStyle = rgba(s.rgb, s.alpha);
          if (
            s.seg.secondary &&
            Number(s.obj.color_override_raw) >>> 24 < 255 &&
            glyph.bounds
          ) {
            const gr = ctx.createLinearGradient(
              0,
              glyph.bounds.bottom,
              0,
              glyph.bounds.top,
            );
            gr.addColorStop(0, rgba(s.rgb, s.alpha));
            gr.addColorStop(
              1,
              rgba(
                objectColor(s.seg.secondary.rgb, s.obj),
                1 - s.seg.secondary.a / 255,
              ),
            );
            ctx.fillStyle = gr;
          }
          if (s.seg.paint && Number(s.obj.color_override_raw) >>> 24 !== 255) {
            const geometry=textPaintGeometry(a.bounds,pl);
            ctx.fillStyle=canvasPaint(ctx,segmentPaint(s.seg),geometry.start,geometry.end,c=>objectColor(c,s.obj),geometry.bounds);
          }
          ctx.fill(path, "evenodd");
        }
        ctx.restore();
      }
      ctx.restore();
      continue;
    }
    if (s.type === "image") {
      if (!paint) continue;
      const a = s.asset,live=resources.drawing?.(s.fig);
      if (!a || !a.anchor_length) continue;
      const reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]),
        mirror =
          Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !==
          Boolean(s.obj.image_text_flags);
      const start = reverse ? s.end : s.start;
      ctx.save();
      ctx.translate(start.x, start.y);
      ctx.rotate(
        (mirror
          ? s.angle + a.anchor_angle_rad - Math.PI
          : s.angle - a.anchor_angle_rad) + (reverse ? Math.PI : 0),
      );
      const scale =
        Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / a.anchor_length;
      ctx.scale(mirror ? -scale : scale, scale);
      ctx.globalAlpha *= s.alpha;
      // Preserve Pivot sprite sampling; authored drawings use smooth scaling.
      ctx.imageSmoothingEnabled = Boolean(s.fig?._styk?.drawing);
      if(ctx.imageSmoothingEnabled)ctx.imageSmoothingQuality='high';
      if (live?.store) {
        // Tiles live in the cel's pixel space, anchored at drawing_anchor.
        const anchor=a.drawing_anchor??a.anchor_start;
        ctx.translate(-anchor.x,-anchor.y);
        paintDrawingTiles(ctx,live,{tint:s.onionTint,tintFn:resources.tint});
        if(!s.onionTint)live.presentedStamp=Math.max(live.presentedStamp??-1,live.stamp);
        ctx.restore();
        continue;
      }
      // A v2 cel whose live store was evicted is mid re-decode: its published
      // blob is only a placeholder, so drawing it would flash stale pixels.
      // v1 data URLs are real PNGs and remain the fallback.
      // Without a live store a v2 carrier is a transparent 1×1 placeholder, so
      // it is never decoded either.
      if (s.fig?._styk?.drawing?.version === 2){ctx.restore();continue;}
      ctx.translate(-a.anchor_start.x, -a.anchor_start.y);
      let img = resources.image?.(resources.url?.(a));
      if(s.onionTint&&img?.complete&&img.naturalWidth&&resources.tint)img=resources.tint(img,s.onionTint,live?.stamp??0);
      if (!img?.complete || !img.naturalWidth){ctx.restore();continue;}
      const iw = a.display_width ?? img.naturalWidth, ih = a.display_height ?? img.naturalHeight;
      // Cropped variants carry their source rectangle; mapping it back into
      // display space preserves the original placement and anchors.
      if (img.srcW !== undefined && img.naturalWidth)
        ctx.drawImage(img, (img.srcX * iw) / img.naturalWidth, (img.srcY * ih) / img.naturalHeight,
          (img.srcW * iw) / img.naturalWidth, (img.srcH * ih) / img.naturalHeight);
      else ctx.drawImage(img, 0, 0, iw, ih);
      ctx.restore();
      continue;
    }
    if (s.type === "poly") {
      if (s.points.length < 3) continue;
      const width = strokeWidth(stroke, s.outline ? 2 * s.outline : 0);
      if (!paint) continue;
      if (clip && primitiveOutsideRasterClip(s, clip, width)) {if (clip.stats) clip.stats.culledPrimitives++; continue;}
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.closePath();
      if (s.outline) {
        line(width, undefined, "round");
        ctx.stroke();
      } else ctx.fill("evenodd");
      continue;
    }
    let width = strokeWidth(stroke, s.baseThickness ?? s.thickness);
    if (s.outline) width = strokeWidth(stroke, width + 2 * s.outline);
    if (!paint) continue;
    if (clip && primitiveOutsideRasterClip(s, clip, width)) {if (clip.stats) clip.stats.culledPrimitives++; continue;}
    if (s.type === "circle") {
      const filled =
          s.seg.segment_kind === "circleFill" || width >= Math.abs(s.length),
        radius = (Math.abs(s.length) + (filled ? width : 0)) / 2;
      if (!radius) continue;
      ctx.beginPath();
      ctx.arc(
        (s.start.x + s.end.x) / 2,
        (s.start.y + s.end.y) / 2,
        radius,
        0,
        TAU,
      );
      if (filled) ctx.fill();
      else if (s.seg.segment_kind === "circle") {
        if (!s.outline) fill(rgba([255, 255, 255], s.alpha));
        ctx.fill();
      }
      if (!filled && width > 0) {
        if (width !== lineWidth) ctx.lineWidth = lineWidth = width;
        ctx.stroke();
      }
      continue;
    }
    if (s.points.length < 2 || width <= 0) continue;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    line(width, s.seg.segment_kind === "squareLine" ? "square" : "round", "round");
    ctx.stroke();
  }
}
function opaqueSurfaceTriangle(s){return s?.type==='poly'&&s.poly?._stykSurface?.depth?.length&&s.points.length===3&&s.alpha===1&&!s.outline;}
function triangleWinding([a,b,c]){return Math.sign((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));}
