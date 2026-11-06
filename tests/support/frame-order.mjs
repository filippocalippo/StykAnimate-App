// A frame's drawing order as figure ids (front to back), read and written the way documents store it.
export function frameOrder(frame) {
  return (frame.object_draw_order || frame.objects.map((_, i) => i))
    .map((i) => frame.objects[i]?.unique_id)
    .filter((x) => x !== undefined);
}

export function setOrder(frame, ids) {
  const map = new Map(frame.objects.map((o, i) => [o.unique_id, i]));
  frame.object_draw_order_unique_ids = ids;
  frame.object_draw_order = ids.map((id) => map.get(id));
}
