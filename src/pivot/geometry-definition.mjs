/** Retain definition traversal plans across frames, checking only the fields
 * that affect topology. In-place edits are detected without allocating maps on
 * every frame. Coordinates, styles and native rounding stay in the builder.
 */
const plans = new WeakMap();
export function geometryDefinition(figure) {
  const cached = plans.get(figure), current = figure.segments || [], polygons = figure.polyfills || [];
  if (cached && cached.plan.segments === current && cached.ids.length === current.length * 2 &&
      cached.polygons.length === polygons.length && current.every((segment, i) =>
        Number(segment.segment_id) === cached.ids[i * 2] && Number(segment.parent_id) === cached.ids[i * 2 + 1]) &&
      polygons.every((polygon, i) => {
        const ids = polygon.segment_ids || [], previous = cached.polygons[i];
        return ids.length === previous.length && ids.every((id, j) => Number(id) === previous[j]);
      })) return cached.plan;
  const segments = figure.segments || [], ids = new Map(), children = new Map(), order = [];
  for (let i = 0; i < segments.length; i++) ids.set(Number(segments[i].segment_id), i);
  for (let i = 0; i < segments.length; i++) {
    const parent = Number(segments[i].parent_id);
    if (!ids.has(parent)) order.push(i);
    else {
      let list = children.get(parent);
      if (!list) children.set(parent, list = []);
      list.push(i);
    }
  }
  for (let q = 0; q < order.length; q++) {
    const list = children.get(Number(segments[order[q]].segment_id));
    if (list) order.push(...list);
  }
  // Preserve the old edge-map insertion order (last duplicate edge wins), and
  // exclude unreachable cyclic segments exactly as the native builder does.
  const edges = new Map();
  for (const i of order) edges.set(`${segments[i].parent_id}:${segments[i].segment_id}`, i);
  const polygonPlans = (figure.polyfills || []).map(poly => {
    const handles = poly.segment_ids || [];
    return {first: handles.length ? Number(handles[0]) : undefined,
      edges: handles.map((id, j) => {
        const a = Number(id), b = Number(handles[(j + 1) % handles.length]);
        const forward = edges.get(`${a}:${b}`), backward = forward === undefined ? edges.get(`${b}:${a}`) : undefined;
        return {end: b, index: forward ?? backward, reverse: forward === undefined};
      })};
  });
  const plan = {segments, ids, order, polygons: polygonPlans, children};
  plans.set(figure, {plan, ids: segments.flatMap(segment => [Number(segment.segment_id), Number(segment.parent_id)]),
    polygons: polygons.map(polygon => (polygon.segment_ids || []).map(Number))});
  return plan;
}
