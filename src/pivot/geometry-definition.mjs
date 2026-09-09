/** Compile definition-only traversal data. The owner scopes this cache to one
 * geometry build, so mutable figure edits need no global invalidation protocol.
 * Instance coordinates, Float32 rounding, styles and warnings stay in the builder.
 */
export function geometryDefinition(figure) {
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
  const polygons = (figure.polyfills || []).map(poly => {
    const handles = poly.segment_ids || [];
    return {first: handles.length ? Number(handles[0]) : undefined,
      edges: handles.map((id, j) => {
        const a = Number(id), b = Number(handles[(j + 1) % handles.length]);
        const forward = edges.get(`${a}:${b}`), backward = forward === undefined ? edges.get(`${b}:${a}`) : undefined;
        return {end: b, index: forward ?? backward, reverse: forward === undefined};
      })};
  });
  return {segments, ids, order, polygons, children};
}
