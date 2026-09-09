/** Target controllers for native, absolute-angle skeletons. No renderer/editor dependencies.
 * Constraints belong to a pose instance and address stable handle IDs, never array slots.
 * Two-link limbs use an analytic solve; longer chains use bounded FABRIK iterations.
 */
export const MAX_IK_CHAIN = 256;
const EPS = 1e-10, TAU = 2 * Math.PI;
const wrap = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const hasPinnedIK = object => Boolean(object?._stykIK && Object.values(object._stykIK).some(c => c.enabled && c.pinned));
/** Placement of a new copy moves its controllers too; ordinary root posing does not. */
export function translateIKTargets(object, dx, dy) {
  if (!object._stykIK) return;
  object._stykIK = Object.fromEntries(Object.entries(object._stykIK).map(([id, c]) => [id,
    {...c, target: {...c.target, x: c.target.x + dx, y: c.target.y + dy}}]));
}

export function ikLayout(figure) {
  const ids = new Map(), children = new Map(), order = [];
  figure.segments.forEach((s, i) => ids.set(s.segment_id, i));
  figure.segments.forEach((s, i) => {
    if (!ids.has(s.parent_id)) order.push(i);
    const list = children.get(s.parent_id) ?? []; list.push(i); children.set(s.parent_id, list);
  });
  for (let q = 0; q < order.length && q < figure.segments.length; q++)
    for (const i of children.get(figure.segments[order[q]].segment_id) ?? []) order.push(i);
  return {ids, children, order};
}

export function ikChain(figure, handle, length, layout = ikLayout(figure)) {
  const chain = [], seen = new Set(); let i = layout.ids.get(Number(handle));
  while (i !== undefined && chain.length < Math.min(length, MAX_IK_CHAIN) && !seen.has(i)) {
    seen.add(i); chain.push(i); i = layout.ids.get(figure.segments[i].parent_id);
  }
  return chain.reverse();
}

export function validateIK(object) {
  if (object._stykIK === undefined) return;
  const table = object._stykIK;
  if (!table || typeof table !== 'object' || Array.isArray(table) || Object.keys(table).length > MAX_IK_CHAIN)
    throw new Error('Invalid IK controller table.');
  for (const [handle, c] of Object.entries(table)) {
    if (!/^[1-9]\d*$/.test(handle) || Number(handle) > 65535 || !c ||
        typeof c.enabled !== 'boolean' || typeof c.pinned !== 'boolean' ||
        !Number.isInteger(c.chainLength) || c.chainLength < 1 || c.chainLength > MAX_IK_CHAIN ||
        ![1, 0, -1].includes(c.bendDirection) || c.allowStretch !== undefined && typeof c.allowStretch !== 'boolean' || !c.target ||
        !['x', 'y', 'rotation'].every(k => Number.isFinite(c.target[k])) ||
        !['x', 'y'].every(k => Number.isFinite(Math.fround(c.target[k])))) throw new Error('Invalid IK controller.');
    if (!c.followers || typeof c.followers !== 'object' || Array.isArray(c.followers) ||
        Object.entries(c.followers).some(([id, a]) => !/^[1-9]\d*$/.test(id) || !Number.isFinite(a)))
      throw new Error('Invalid IK controller orientation.');
    if (c.bendReference !== undefined && (!c.bendReference || ![-1, 1].includes(c.bendReference.side) ||
        !['angle', 'axis', 'ratio'].every(k => Number.isFinite(c.bendReference[k])) || c.bendReference.ratio < 0 ||
        c.bendReference.shape !== undefined && (!Array.isArray(c.bendReference.shape) || c.bendReference.shape.length > MAX_IK_CHAIN || !c.bendReference.shape.every(Number.isFinite))))
      throw new Error('Invalid IK bend reference.');
  }
}

/** A small, serializable continuity reference; no renderer-owned solver history. */
export function ikBendReference(points, lengths, previous) {
  const base = points[0], end = points.at(-1), dx = end.x - base.x, dy = end.y - base.y;
  const total = lengths.reduce((a, b) => a + b, 0), distance = Math.hypot(dx, dy);
  let cross = 0, pole = points[1] ?? end;
  for (let i = 1; i < points.length - 1; i++) {
    const value = dx * (points[i].y - base.y) - dy * (points[i].x - base.x);
    if (Math.abs(value) > Math.abs(cross)) { cross = value; pole = points[i]; }
  }
  return {side: Math.abs(cross) > total * total * 1e-7 ? Math.sign(cross) : previous?.side ?? 1,
    angle: Math.hypot(pole.x - base.x, pole.y - base.y) > EPS ? Math.atan2(pole.y - base.y, pole.x - base.x) : previous?.angle ?? 0,
    axis: distance > EPS ? Math.atan2(dy, dx) : previous?.axis ?? 0,
    ratio: total > EPS ? distance / total : 0,
    ...(lengths.length > 2 ? {shape: lengths.map((_, i) => Math.atan2(points[i + 1].y - points[i].y, points[i + 1].x - points[i].x))} : {})};
}

/** Pure point solver. Writes only caller-owned scratch points, never changes lengths. */
export function solveIKPoints(points, lengths, target, bendDirection = 1, {iterations = 32, tolerance = 1e-5, bendReference} = {}) {
  const n = lengths.length, base = {...points[0]}, total = lengths.reduce((a, b) => a + b, 0);
  if (!n || total < EPS) return {iterations: 0, error: Math.hypot(target.x - base.x, target.y - base.y)};
  const automatic = bendDirection === 0, reference = automatic ? bendReference ?? ikBendReference(points, lengths) : null;
  // Canvas/world conversion and native float32 poses introduce tiny offsets at
  // a folded endpoint. Their atan2 is essentially random; treat them as zero.
  const foldTolerance = automatic ? Math.max(EPS, total * 1e-6) : EPS;
  // Longer chains have many valid shapes. Continue from their last solved
  // chord directions instead of restarting FABRIK from the original rig pose.
  if (n > 2 && reference?.shape?.length === n) for (let i = 0; i < n; i++)
    points[i + 1] = {x: points[i].x + Math.cos(reference.shape[i]) * lengths[i], y: points[i].y + Math.sin(reference.shape[i]) * lengths[i]};
  let dx = target.x - base.x, dy = target.y - base.y, distance = Math.hypot(dx, dy);
  const fallback = reference?.axis ?? Math.atan2(points[n].y - base.y, points[n].x - base.x);
  const direction = distance > foldTolerance ? Math.atan2(dy, dx) : fallback;
  const ux = Math.cos(direction), uy = Math.sin(direction);
  // Preserve the branch of the solved limb, not the side of the old knee
  // relative to each new mouse position (which mirrors an otherwise bent limb).
  if (automatic) bendDirection = reference.side;
  let used = 0;
  if (distance >= total - EPS || n === 1) {
    for (let i = 0; i < n; i++) points[i + 1] = {x: points[i].x + ux * lengths[i], y: points[i].y + uy * lengths[i]};
  } else if (n === 2 && lengths[0] > EPS && lengths[1] > EPS) {
    const [a, b] = lengths, d = clamp(distance, Math.abs(a - b), a + b);
    const along = d > EPS ? (a * a - b * b + d * d) / (2 * d) : 0;
    const magnitude = Math.sqrt(Math.max(0, a * a - along * along));
    if (automatic) {
      // Consider the other branch only where it can preserve continuity:
      // near extension, or when the target path passes through the folded region.
      const oldX = Math.cos(reference.axis) * reference.ratio * total, oldY = Math.sin(reference.axis) * reference.ratio * total;
      const vx = dx - oldX, vy = dy - oldY, travel2 = vx * vx + vy * vy;
      const t = travel2 > EPS ? clamp(-(oldX * vx + oldY * vy) / travel2, 0, 1) : 0;
      const throughFold = Math.hypot(oldX + t * vx, oldY + t * vy) < total * .04 && oldX * dx + oldY * dy <= 0;
      if (magnitude < total * .02 || throughFold) {
        const poleX = Math.cos(reference.angle), poleY = Math.sin(reference.angle);
        // Difference in squared knee travel, normalized by link length. A dead
        // band prevents floating-point noise or subpixel motion flipping sides.
        const improvement = -4 * magnitude / a * bendDirection * (-uy * poleX + ux * poleY);
        if (improvement > .002) bendDirection = -bendDirection;
      }
      if (distance <= foldTolerance && Math.abs(a - b) < EPS) {
        // Use the limit of the approaching branch. Reusing the earlier bent
        // knee angle would jump at an exact-zero sample during random seeking.
        const angle = reference.ratio > 1e-6 ? reference.axis + reference.side * Math.PI / 2 : reference.angle;
        points[1] = {x: base.x + Math.cos(angle) * a, y: base.y + Math.sin(angle) * a};
        points[2] = {...base};
        return {iterations: 0, error: distance, bendReference: {...reference, angle, ratio: 0}};
      }
    }
    const height = magnitude * bendDirection;
    points[1] = {x: base.x + ux * along - uy * height, y: base.y + uy * along + ux * height};
    points[2] = {x: base.x + ux * d, y: base.y + uy * d};
  } else {
    let greatest = 0;
    for (const p of points.slice(1, -1)) {
      const side = ux * (p.y - base.y) - uy * (p.x - base.x);
      if (Math.abs(side) > Math.abs(greatest)) greatest = side;
    }
    const error = Math.hypot(points[n].x - target.x, points[n].y - target.y);
    if ((automatic || greatest * bendDirection >= 0) && error <= tolerance)
      return {iterations: 0, error, ...(automatic ? {bendReference: ikBendReference(points, lengths, reference)} : {})};
    // FABRIK already follows its input pose. Both must not reflect the whole
    // chain just because its target crosses the old pose's axis.
    if (!automatic && greatest * bendDirection < -total * 1e-7) for (let i = 1; i < n; i++) {
      const side = ux * (points[i].y - base.y) - uy * (points[i].x - base.x);
      points[i] = {x: points[i].x + 2 * uy * side, y: points[i].y - 2 * ux * side};
    }
    // A perfectly straight chain cannot escape the collinear FABRIK singularity.
    // Seed a small deterministic bend, preserving the user's chosen side.
    const cross = points.slice(1, -1).some(p => Math.abs((p.x - base.x) * uy - (p.y - base.y) * ux) > total * 1e-7);
    if (!cross) for (let i = 1; i < n; i++) {
      const offset = Math.sin(Math.PI * i / n) * total * .05 * bendDirection;
      points[i] = {x: points[i].x - uy * offset, y: points[i].y + ux * offset};
    }
    const place = (i, anchor, length, fallbackX, fallbackY) => {
      const p = points[i], vx = p.x - anchor.x, vy = p.y - anchor.y, d = Math.hypot(vx, vy);
      points[i] = {x: anchor.x + (d > EPS ? vx / d : fallbackX) * length,
        y: anchor.y + (d > EPS ? vy / d : fallbackY) * length};
    };
    for (; used < iterations; used++) {
      points[n] = {...target};
      for (let i = n - 1; i >= 0; i--) place(i, points[i + 1], lengths[i], -ux, -uy);
      points[0] = {...base};
      for (let i = 0; i < n; i++) place(i + 1, points[i], lengths[i], ux, uy);
      if (Math.hypot(points[n].x - target.x, points[n].y - target.y) <= tolerance) { used++; break; }
    }
  }
  return {iterations: used, error: Math.hypot(points[n].x - target.x, points[n].y - target.y),
    ...(automatic ? {bendReference: ikBendReference(points, lengths, {...reference, side: bendDirection})} : {})};
}

function chord(figure, object, i, lengths) {
  const s = figure.segments[i], bend = object.bend_flag ? object.bends[i] : s.bend_rad ?? 0;
  const length = (lengths?.[i] ?? (object.len_flag ? object.lengths[i] : s.length)) * object.scale;
  return {bend, signed: length * (Math.abs(bend) < EPS ? 1 : 2 * Math.sin(bend / 2) / bend)};
}

/** Resolve only constrained objects. Plans are scoped to a build/gesture, so mutable
 * topology cannot leave stale global cache entries. Work is O(segments + chain * iterations).
 * Disjoint limbs may share a base. Overlapping chains have deterministic handle priority.
 */
export function solveObjectIK(figure, object, root, layout = ikLayout(figure), controllers = object._stykIK) {
  const active = Object.entries(controllers ?? {}).filter(([id, c]) => c.enabled && c.pinned && layout.ids.has(Number(id)));
  if (!active.length) return null;
  const angles = object.angles.slice(), points = new Map([[0, root]]), results = new Map(), claimed = new Set();
  let lengths;
  const forward = i => {
    const s = figure.segments[i], p = points.get(s.parent_id) ?? root, c = chord(figure, object, i, lengths), a = angles[i] + c.bend / 2;
    points.set(s.segment_id, {x: p.x + Math.cos(a) * c.signed, y: p.y + Math.sin(a) * c.signed});
  };
  for (const i of layout.order) forward(i);
  const chains = new Map(active.map(([id, c]) => [id, ikChain(figure, id, c.chainLength, layout)]));
  if (active.length > 1) {
    const rank = new Map(layout.order.map((i, order) => [i, order]));
    active.sort(([a], [b]) => rank.get(chains.get(a)[0]) - rank.get(chains.get(b)[0]) || Number(a) - Number(b));
  }
  for (const [id, c] of active) {
    const chain = chains.get(id);
    if (!chain.length || chain.some(i => claimed.has(i))) { results.set(Number(id), {conflict: true}); continue; }
    chain.forEach(i => claimed.add(i));
    const chainSet = new Set(chain), base = points.get(figure.segments[chain[0]].parent_id) ?? root;
    const positions = [base, ...chain.map(i => points.get(figure.segments[i].segment_id))].map(p => ({...p}));
    const chords = chain.map(i => chord(figure, object, i, lengths));
    const reach = chords.reduce((sum, c) => sum + Math.abs(c.signed), 0), distance = Math.hypot(c.target.x - base.x, c.target.y - base.y);
    const stretch = c.allowStretch && reach > EPS ? Math.max(1, distance / reach) : 1;
    if (stretch > 1) {
      lengths ??= figure.segments.map((s, i) => object.len_flag ? object.lengths[i] : s.length);
      chain.forEach((i, j) => { lengths[i] *= stretch; chords[j].signed *= stretch; });
    }
    const result = solveIKPoints(positions, chords.map(c => Math.abs(c.signed)), c.target, c.bendDirection, {bendReference: c.bendReference});
    const deltas = new Map();
    chain.forEach((i, j) => {
      if (Math.abs(chords[j].signed) < EPS) return;
      const a = Math.atan2(positions[j + 1].y - positions[j].y, positions[j + 1].x - positions[j].x) - chords[j].bend / 2 - (chords[j].signed < 0 ? Math.PI : 0);
      const delta = wrap(a - angles[i]); angles[i] += delta; deltas.set(figure.segments[i].segment_id, delta);
    });
    // Off-chain branches retain their local articulation. Outgoing branches at the
    // effector are parented to the virtual controller, not the solved incoming bone.
    const affected = [...chain], visited = new Set(chain);
    for (let q = 0; q < affected.length; q++) {
      const i = affected[q], s = figure.segments[i];
      if (!chainSet.has(i)) {
        let delta = deltas.get(s.parent_id);
        if (s.parent_id === Number(id) && Number.isFinite(c.followers?.[s.segment_id]))
          delta = wrap(c.target.rotation + c.followers[s.segment_id] - angles[i]);
        if (delta !== undefined) { angles[i] += delta; deltas.set(s.segment_id, delta); }
      }
      forward(i);
      for (const child of layout.children.get(s.segment_id) ?? []) if (!visited.has(child)) { visited.add(child); affected.push(child); }
    }
    results.set(Number(id), {...result, target: c.target, chain, stretch});
  }
  return {angles, lengths, results, points};
}

export function interpolateIK(a, b, t, sample) {
  if (!a?._stykIK) return undefined;
  const table = {};
  for (const [id, c] of Object.entries(a._stykIK)) {
    const next = b?._stykIK?.[id];
    if (!next?.enabled || !c.enabled || next.pinned !== c.pinned) { table[id] = c; continue; }
    const target = {...c.target}, followers = {...c.followers};
    for (const k of ['x', 'y', 'rotation']) target[k] = sample ? sample(id, 'target', k, k === 'rotation') : target[k] + (k === 'rotation' ? wrap(next.target[k] - target[k]) : next.target[k] - target[k]) * t;
    for (const child of Object.keys(followers)) if (Number.isFinite(next.followers[child])) followers[child] = sample ? sample(id, 'followers', child, true) : followers[child] + wrap(next.followers[child] - followers[child]) * t;
    let bendReference = c.bendReference;
    if (bendReference?.shape?.length && bendReference.shape.length === next.bendReference?.shape?.length)
      bendReference = {...bendReference, shape: bendReference.shape.map((a, i) => a + wrap(next.bendReference.shape[i] - a) * t)};
    table[id] = {...c, target, followers, ...(bendReference ? {bendReference} : {})};
  }
  return table;
}
