/** Polygon construction follows the same evaluated bone arcs as a committed fill. */
const edgesByGeometry = new WeakMap();

export function polygonPreviewPoints(geometry, handleIds, {closed = true} = {}) {
  if (!geometry || !handleIds?.length) return [];
  let edges = edgesByGeometry.get(geometry);
  if (!edges) {
    edges = new Map((geometry.segments ?? []).map(segment => [
      `${segment.seg.parent_id}:${segment.seg.segment_id}`, segment,
    ]));
    edgesByGeometry.set(geometry, edges);
  }
  const joints = geometry.joints, points = [];
  const first = joints.get(Number(handleIds[0]));
  if (first) points.push(first);
  const edgeCount = Math.max(0, handleIds.length - (closed ? 0 : 1));
  for (let i = 0; i < edgeCount; i++) {
    const from = Number(handleIds[i]), to = Number(handleIds[(i + 1) % handleIds.length]);
    const forward = edges.get(`${from}:${to}`), backward = forward ? null : edges.get(`${to}:${from}`);
    const edge = forward || backward;
    if (edge && Math.abs(edge.bend) > 1e-7) {
      if (forward) for (let j = 1; j < edge.points.length; j++) points.push(edge.points[j]);
      else for (let j = edge.points.length - 2; j >= 0; j--) points.push(edge.points[j]);
    } else if (joints.has(to)) points.push(joints.get(to));
  }
  if (closed && points.length > 1 && points[0].x === points.at(-1).x && points[0].y === points.at(-1).y) points.pop();
  return points;
}
