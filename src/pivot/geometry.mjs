import {canvasPaint, segmentPaint, textPaintGeometry, shapePaintBounds} from '../paint.mjs';
// Scene evaluation is independent of the DOM so the regression harness can test it.
import { tweenBackground } from "./background.mjs";
import { composePoseChannels, invalidatePoseCache } from '../animation-pose.mjs';
import { composeAnimationChannels, animationEndTick } from '../animation-channels.mjs';
import { applyLayerOrder } from '../layers.mjs';
import { resolveInstanceFigure } from '../animation-style.mjs';
import {animationOriginLayout, animationOriginAngle, animationOriginBend, correctAnimationOrigins} from '../animation-origin.mjs';
import {interpolateOriginSupport} from '../animation-origin-support.mjs';
import {easedProgress, usesLegacyNativeEasing, easingMode, autoValue} from '../keyframe-easing.mjs';
import {geometryDefinition} from './geometry-definition.mjs';
const authoredTimelines = new WeakMap();
export function invalidateEvaluationCaches(report) {
  authoredTimelines.delete(report);
  invalidatePoseCache(report);
}
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
  if (![start.x, start.y, angle, length, bend].every(Number.isFinite))
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
  const entries = nativeTimeline(report), last = entries.at(-1);
  if (last) last.count = Math.max(last.count, animationEndTick(report) - last.start);
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
  return pchip(times, values, index - left, t);
}
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
export function evaluatedNativeFrame(report, index, t = 0, tweenCache) {
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
  const frame = {
    ...a,
    objects: a.objects.map((o) => {
      const next = byId.get(o.unique_id),
        fig = types.get(o.figure_type_id);
      if (!next || next.figure_type_id !== o.figure_type_id || !fig) return o;
      const constantTween=!legacyEasing&&tweenCache?.lookup(o,next,fig);
      if(constantTween?.value)return constantTween.value;
      const out = { ...o, runtime_segments: undefined };
      const matching = (f) => {
        let objects = identities.get(f);
        if (!objects) { objects = new Map(f.objects.map(item => [item.unique_id, item])); identities.set(f, objects); }
        const item = objects.get(o.unique_id);
        return item?.figure_type_id === o.figure_type_id ? item : undefined;
      };
      for (const k of ["root_x", "root_y", "scale"])
        out[k] = parameter(report, index, t, (f) => matching(f)?.[k]);
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
          out[field] = fig.segments.map((s, i) =>
            parameter(report, index, t, (f) => {
              const item = matching(f);
              return item
                ? item[flag]
                  ? item[field][i]
                  : (s[base] ?? 0)
                : undefined;
            }),
          );
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
      const {ids, ready} = layout, angles = new Array(fig.segments.length);
      for (let q = 0; q < ready.length; q++) {
        const i = ready[q];
        const s = fig.segments[i],
          parent = ids.get(s.parent_id);
        const relative = parameter(
          report,
          index,
          t,
          (f) => {
            const item = matching(f);
            if (!item) return undefined;
            let value = Number(item.angles?.[i] ?? s.angle_rad ?? 0);
            if (parent !== undefined) {
              const ps = fig.segments[parent];
              value -=
                Number(item.angles?.[parent] ?? ps.angle_rad ?? 0) +
                Number(
                  item.bend_flag ? item.bends[parent] : (ps.bend_rad ?? 0),
                );
            }
            return value;
          },
          true,
        );
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
  }
  // Image identities cannot share scalar tangents; each crossfade eases locally.
  Object.assign(frame, tweenBackground(a, b, auto ? easedProgress(a._styk.easing, t) : t));
  return correctAnimationOrigins(report, frame);
}
/** Every editor, worker and export samples the same authored scene. Native
 * documents take the original evaluator path without channel indexing work. */
export function evaluatedFrame(report, index, t = 0, absoluteTick, {tweenCache} = {}) {
  let frame = evaluatedNativeFrame(report, index, t, tweenCache);
  if (report._styk?.animation?.channels?.length) {
    let entries = authoredTimelines.get(report);
    if (!entries) authoredTimelines.set(report, entries = timeline(report));
    const entry = entries[index];
    const tick = absoluteTick ?? ((entry?.start || 0) + Math.max(0, t) * (entry?.count || 0));
    frame = composePoseChannels(report, frame, tick, { sampleNative: evaluatedNativeFrame, resolveGeometry: buildGeometry });
    frame = composeAnimationChannels(report, frame, tick, { resolveGeometry: buildGeometry });
  }
  return applyLayerOrder(report, frame);
}
export function buildGeometry(report, frame, incremental = null) {
  const iterator = buildGeometrySteps(report, frame, incremental);
  for (;;) {
    const step = iterator.next();
    if (step.done) return step.value;
  }
}

/** Shares the exact synchronous builder, with checkpoints between figure units.
 * A single figure's segment construction remains one indivisible unit. */
export function* buildGeometrySteps(report, frame, incremental = null) {
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
  function objectAt(slot, seen = new Set()) {
    if (cache.has(slot)) return cache.get(slot);
    const obj = frame.objects[slot],
      fig = resolveInstanceFigure(types.get(Number(obj?.figure_type_id)), obj);
    if (!obj || !fig) return null;
    if (seen.has(slot)) {
      warnings.push(`Cyclic join at object ${slot}`);
      return null;
    }
    seen.add(slot);
    let root = { x: Number(obj.root_x ?? 0), y: Number(obj.root_y ?? 0) };
    if (obj.join) {
      const parent = objectAt(
        Number(obj.join.target_object_slot),
        new Set(seen),
      );
      const p = parent?.joints.get(Number(obj.join.target_handle_id ?? 0));
      if (p) root = { ...p };
      else warnings.push(`Unresolved join at object ${slot}`);
    }
    let plan = definitionPlans.get(fig);
    if (!plan) {plan = geometryDefinition(fig); definitionPlans.set(fig, plan);}
    const joints = new Map([[0, root]]),
      renders = new Map(),
      {segments, ids} = plan;
    const scale = Number(obj.scale ?? 1),
      opacity = 1 - Number(obj.field28 ?? obj.transparency ?? 0) / 255;
    function segmentAt(i, active) {
      if (renders.has(i)) return renders.get(i);
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
      const start = joints.get(Number(seg.parent_id)) || root,
        rt = obj.runtime_segments?.[i];
      const angle = Number(
        obj.angles?.[i] ?? rt?.angle_rad ?? seg.angle_rad ?? 0,
      );
      const bend = Number(
        obj.bend_flag
          ? (obj.bends?.[i] ?? 0)
          : (rt?.bend_rad ?? seg.bend_rad ?? 0),
      );
      const length =
        Number(
          obj.len_flag
            ? (obj.lengths?.[i] ?? seg.length)
            : (rt?.length ?? seg.length ?? 0),
        ) * scale;
      const points = arc(start, angle, length, bend),
        last = points.at(-1) || start,
        end = { x: Math.fround(last.x), y: Math.fround(last.y) };
      if (points.length) points[points.length - 1] = end;
      joints.set(Number(seg.segment_id), end);
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
        thickness: Number(seg.thickness ?? 0) * Math.abs(scale),
        rgb,
        alpha:
          seg.transparency === undefined
            ? (seg.color_alpha ?? 1)
            : 1 - seg.transparency / 255,
        opacity,
        static: isStatic(seg),
      };
      renders.set(i, render);
      return render;
    }
    for (const i of plan.order) segmentAt(i);
    if (plan.order.length < segments.length)
      warnings.push(`Cyclic segment hierarchy in object ${slot}`);
    const malformedEdges = ids.size !== segments.length ? new Map(
      [...renders.values()].map((s) => [
        `${s.seg.parent_id}:${s.seg.segment_id}`,
        s,
      ]),
    ) : null;
    const polys = (fig.polyfills || []).map((poly, i) => {
      const polygon = plan.polygons[i], points = [];
      if (polygon.first !== undefined && joints.has(polygon.first)) points.push(joints.get(polygon.first));
      for (let j = 0; j < polygon.edges.length; j++) {
        const step = polygon.edges[j], b = step.end;
        let edge = renders.get(step.index), reverse = step.reverse;
        if (malformedEdges) {
          const a = Number(poly.segment_ids[j]), forward = malformedEdges.get(`${a}:${b}`);
          edge = forward || malformedEdges.get(`${b}:${a}`); reverse = !forward;
        }
        if (edge && Math.abs(edge.bend) > 1e-7)
          points.push(
            ...(reverse ? [...edge.points].reverse() : edge.points).slice(1),
          );
        else if (joints.has(b)) points.push(joints.get(b));
      }
      if (
        points.length > 1 &&
        points[0].x === points.at(-1).x &&
        points[0].y === points.at(-1).y
      )
        points.pop();
      return {
        type: "poly",
        poly,
        obj,
        fig,
        slot,
        index: i,
        points,
        z: Number(poly.z_order ?? 0),
        rgb: objectColor(poly.color_rgb ?? [0, 0, 0], obj),
        alpha:
          poly.alpha_raw === undefined
            ? (poly.color_alpha ?? 1)
            : 1 - poly.alpha_raw / 255,
        opacity,
      };
    });
    const geometry = {
      slot,
      obj,
      fig,
      root,
      joints,
      segments: [...renders.values()].sort((a, b) => a.index - b.index),
      polys,
    };
    const renderSource=incremental?.renderSources?.get(slot);
    if(renderSource)Object.defineProperty(geometry,'renderSource',{value:renderSource});
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
      objectAt(ready[q]); ready.push(...(children.get(ready[q]) || []));
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
    objectAt(slot);
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
    const g = objectAt(Number(slot));
    if (!g) {
      yield {phase: 'geometry', stage: 'drawables', completed: ++collected, total: order.length};
      continue;
    }
    const local = g.drawables ?? [
      ...g.polys,
      ...g.segments
        .filter((s) => s.seg.visible !== false)
        .map((s) => ({
          ...s,
          type: ["circle", "image", "text"].includes(s.seg.segment_type)
            ? s.seg.segment_type
            : "line",
        })),
    ];
    if (!g.drawables) { local.sort((a, b) => a.z - b.z); g.drawables = local; }
    if (local.length) orderedObjects.push(g);
    yield {phase: 'geometry', stage: 'drawables', completed: ++collected, total: order.length};
  }
  // Keep edit invalidation metadata without retaining a chain of previous scenes.
  // The flattened compatibility view is created only when a consumer needs it.
  let drawables;
  return { objects: cache, orderedObjects, token: {}, previousToken: incremental?.previous?.token,
    changedSlots: incremental?.dirtySlots ? new Set(incremental.dirtySlots) : null,
    get drawables() { return drawables ??= orderedObjects.flatMap(g => g.drawables); }, warnings };
}

const yieldGeometryTask = globalThis.scheduler?.yield ? () => globalThis.scheduler.yield() : () => new Promise(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {channel.port1.close(); channel.port2.close(); resolve();};
  channel.port2.postMessage(null);
});

/** Prepare unpublished geometry without blocking across many small figures.
 * sliceMs is a scheduling target, not a maximum for an individual large figure. */
export async function buildGeometryAsync(report, frame, incremental = null,
  {sliceMs = 4, signal, checkCurrent, yieldControl = yieldGeometryTask, onProgress, onTiming} = {}) {
  if (!Number.isFinite(sliceMs) || sliceMs < 0) throw new Error('Choose a nonnegative geometry preparation slice duration.');
  const check = () => {
    if (signal?.aborted || checkCurrent?.() === false)
      throw new DOMException('Geometry preparation was cancelled or superseded.', 'AbortError');
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
  for (const cache of [groupCanvases, outlineCanvases]) {
    const scratch = cache.get(ctx);
    if (!scratch) continue;
    if (!retainCanvases) cache.delete(ctx);
    releaseGeometryResources(scratch.getContext('2d'), { retainCanvases });
    scratch.width = 1; scratch.height = 1;
  }
}
function isolated(ctx, alpha, paint, cache) {
  if (alpha <= 0) return;
  if (alpha >= 1) {
    paint(ctx);
    return;
  }
  let scratch = cache.get(ctx);
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height)
        : ctx.canvas.ownerDocument.createElement("canvas");
    cache.set(ctx, scratch);
  }
  if (scratch.width !== ctx.canvas.width) scratch.width = ctx.canvas.width;
  if (scratch.height !== ctx.canvas.height) scratch.height = ctx.canvas.height;
  const temp = scratch.getContext("2d");
  temp.setTransform(1, 0, 0, 1, 0, 0);
  temp.clearRect(0, 0, scratch.width, scratch.height);
  temp.setTransform(ctx.getTransform());
  paint(temp);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}
function floatBits(n) {
  const a = new Uint32Array([n]);
  return new Float32Array(a.buffer)[0];
}
export function drawGeometry(ctx, geometry, resources = {}) {
  // The native export restores its brush after each frame. Opaque objects share
  // this state; every isolated opacity/outline pass starts with a fresh brush.
  const mainStroke = { width: 1 };
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
  for (const g of groups)
    isolated(
      ctx,
      g.opacity,
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
          isolated(
            target,
            1 - Number(style.u30 ?? 0) / 255,
            (c) =>
              drawPrimitives(
                c,
                outline,
                resources,
                c === target ? stroke : { width: 1 },
              ),
            outlineCanvases,
          );
        }
        drawPrimitives(target, g.items, resources, stroke);
      },
      groupCanvases,
    );
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
function drawPrimitives(ctx, items, resources, stroke) {
  for (const s of items) {
    const brush = gradient(ctx, s) || rgba(s.rgb, s.alpha);
    ctx.fillStyle = brush;
    ctx.strokeStyle = brush;
    if (s.type === "text") {
      const a = s.asset;
      if (!a?.normalized_svg_path || !a.bounds.width) continue;
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
            (2 * s.outline) / Math.abs(s.obj.scale ?? 1),
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
      const a = s.asset,
        img = a && resources.image?.(resources.url?.(a));
      if (!a || !img?.complete || !img.naturalWidth || !a.anchor_length)
        continue;
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
      ctx.translate(-a.anchor_start.x, -a.anchor_start.y);
      ctx.globalAlpha *= s.alpha;
      // Pivot requests FMX's high-speed (nearest-neighbor) bitmap sampler.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      ctx.restore();
      continue;
    }
    if (s.type === "poly") {
      if (s.points.length < 3) continue;
      const width = strokeWidth(stroke, s.outline ? 2 * s.outline : 0);
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      if (s.outline) {
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.stroke();
      } else ctx.fill("evenodd");
      continue;
    }
    let width = strokeWidth(stroke, s.baseThickness ?? s.thickness);
    if (s.outline) width = strokeWidth(stroke, width + 2 * s.outline);
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
        if (!s.outline) ctx.fillStyle = rgba([255, 255, 255], s.alpha);
        ctx.fill();
      }
      if (!filled && width > 0) {
        ctx.lineWidth = width;
        ctx.stroke();
      }
      continue;
    }
    if (s.points.length < 2 || width <= 0) continue;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.lineWidth = width;
    ctx.lineCap = s.seg.segment_kind === "squareLine" ? "square" : "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}
