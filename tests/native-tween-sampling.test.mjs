import test from 'node:test';
import assert from 'node:assert/strict';
import {shortest, nativeTimeline} from '../src/pivot/read-view.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

/** A stored keyframe's ticks: the displayed keyframe and its outgoing inbetweens (raw signed duration). */
const frameTicks = frame => Math.max(0, Number(frame.duration_raw ?? 1));

// The native-easing sampler as it was before per-object sampling: one keyframe lookup, run search, tangent array and pchip per
// joint and channel, written out here as the reference the engine's evaluated frame must equal bit for bit.
const lerp = (a, b, t) => Number(a) + (Number(b) - Number(a)) * t;
function endpointSlope(h0, h1, d0, d1) {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(m) !== Math.sign(d0)) return 0;
  if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0;
  return m;
}
function pchip(times, values, index, t) {
  const n = values.length;
  if (n < 3) return lerp(values[index], values[index + 1], t);
  const h = times.slice(1).map((v, i) => v - times[i]), d = h.map((v, i) => (values[i + 1] - values[i]) / v);
  const slope = i => {
    if (i === 0) return endpointSlope(h[0], h[1], d[0], d[1]);
    if (i === n - 1) return endpointSlope(h.at(-1), h.at(-2), d.at(-1), d.at(-2));
    if (!d[i - 1] || !d[i] || Math.sign(d[i - 1]) !== Math.sign(d[i])) return 0;
    const w = (2 * h[i - 1] + h[i]) / (3 * (h[i - 1] + h[i]));
    return (d[i - 1] * d[i]) / (w * d[i - 1] + (1 - w) * d[i]);
  };
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * values[index] + (t3 - 2 * t2 + t) * h[index] * slope(index) + (3 * t2 - 2 * t3) * values[index + 1] + (t3 - t2) * h[index] * slope(index + 1);
}
function parameter(frames, index, t, get, angular = false) {
  let left = index, right = index + 1;
  const a = get(frames[index]), b = get(frames[index + 1]);
  if (a === undefined || b === undefined) return a ?? 0;
  while (left > 0 && frameTicks(frames[left - 1]) > 1 && get(frames[left - 1]) !== undefined) left--;
  while (right < frames.length - 1 && frameTicks(frames[right]) > 1 && get(frames[right + 1]) !== undefined) right++;
  const times = [0], values = [get(frames[left])];
  for (let i = left + 1; i <= right; i++) {
    times.push(times.at(-1) + frameTicks(frames[i - 1]));
    const value = get(frames[i]);
    values.push(angular ? values.at(-1) + shortest(value - values.at(-1)) : value);
  }
  return pchip(times, values, index - left, t);
}
function expected(report, index, t, uid) {
  const frames = report.keyframes, o = frames[index].objects.find(x => x.unique_id === uid), fig = report.figure_types[0];
  const match = f => f.objects.find(x => x.unique_id === uid);
  const out = {root_x: parameter(frames, index, t, f => match(f)?.root_x)};
  for (const [flag, field, base] of [['len_flag', 'lengths', 'length'], ['bend_flag', 'bends', 'bend_rad']])
    out[field] = fig.segments.map((s, i) => parameter(frames, index, t, f => { const item = match(f); return item ? item[flag] ? item[field][i] : (s[base] ?? 0) : undefined; }));
  const angles = [];
  fig.segments.forEach((s, i) => {
    const parent = fig.segments.findIndex(p => p.segment_id === s.parent_id);
    const relative = parameter(frames, index, t, f => {
      const item = match(f); if (!item) return undefined;
      let value = Number(item.angles?.[i] ?? s.angle_rad ?? 0);
      if (parent >= 0) { const ps = fig.segments[parent]; value -= Number(item.angles?.[parent] ?? ps.angle_rad ?? 0) + Number(item.bend_flag ? item.bends[parent] : (ps.bend_rad ?? 0)); }
      return value;
    }, true);
    angles[i] = parent < 0 ? relative : angles[parent] + Number(out.bends[parent]) + relative;
  });
  out.angles = angles;
  return out;
}

/** Pivot native easing (auto_easing, unkeyed frames) with long runs, gaps where an object is absent, channels some keys do not
 * carry (lengths and bends flagged off) and angles that wrap around. */
function nativeDocument() {
  const template = emptyDocument().figure_types[0].segments[0];
  const segments = [
    {...template, segment_id: 1, parent_id: 0, length: 30, angle_rad: 0, bend_rad: 0},
    {...template, segment_id: 2, parent_id: 1, length: 20, angle_rad: 1, bend_rad: .1},
    {...template, segment_id: 3, parent_id: 2, length: 10, angle_rad: 2, bend_rad: 0},
  ];
  const keyframes = [];
  for (let k = 0; k < 14; k++) {
    const objects = [];
    for (const uid of [1, 2, 3]) {
      if (uid === 2 && k === 6) continue; // absent in one key: the run splits
      const wrap = k * 2.9; // consecutive angles differ by more than pi after wrapping
      const object = {unique_id: uid, figure_type_id: 1, object_slot: objects.length, root_x: 10 * k + uid, root_y: k * k, scale: 1,
        angles: [Math.sin(k + uid) * 3, wrap + uid, -wrap], bend_flag: k % 3 ? 1 : 0, bends: k % 3 ? [0, .05 * k, .2] : [],
        len_flag: 0, lengths: [], field28: 0, color_override_raw: 0, join: null};
      if (uid !== 1 || k % 2) { object.len_flag = 1; object.lengths = [30 + k, 20 - k, 10 + uid]; }
      objects.push(object);
    }
    keyframes.push({duration_raw: k === 10 ? 1 : 3 + (k % 2), background_id: 0, background_id_b: 0, background_mix: 0,
      camera: {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0}, objects,
      object_draw_order: objects.map((_, i) => i), object_draw_order_unique_ids: objects.map(o => o.unique_id)});
  }
  const document = emptyDocument();
  return {...document, auto_easing: true, auto_easing_disabled_raw: 0, figure_types: [{...document.figure_types[0], figure_type_id: 1, segment_count: 3, segments}], keyframes};
}

test('the native-easing sampling of the engine equals the per-joint evaluation exactly', () => {
  const report = nativeDocument(), editor = ownedEditorFor({demo: false}, report), rows = nativeTimeline(report);
  let compared = 0;
  // Every whole tick inside a keyframe's span samples that keyframe at tick-start over the span (the last keyframe holds one tick).
  for (const {index, start, count} of rows) {
    if (index + 1 >= rows.length) continue;
    for (let at = 0; at < count; at++) {
      const t = at / count;
      if (!t) continue;
      editor.seek(start + at);
      const frame = editor.evaluatedFrame;
      for (const uid of [1, 2, 3]) {
        const object = frame.objects.find(o => o.unique_id === uid);
        if (!report.keyframes[index].objects.some(o => o.unique_id === uid) || !report.keyframes[index + 1].objects.some(o => o.unique_id === uid)) continue;
        const want = expected(report, index, t, uid);
        assert.ok(Object.is(object.root_x, want.root_x), `root ${index} ${t} ${uid}: ${object.root_x} vs ${want.root_x}`);
        for (const field of ['lengths', 'bends', 'angles']) want[field].forEach((value, i) =>
          assert.ok(Object.is(object[field][i], value), `${field}[${i}] key ${index} t ${t} object ${uid}: ${object[field][i]} vs ${value}`));
        compared++;
      }
    }
  }
  assert.ok(compared > 60, `compared ${compared} poses`);
});
