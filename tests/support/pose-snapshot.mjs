// How the recorded tapes and the layer tests read a frame: a pose as stored data, without the evaluation caches
// (`runtime_segments`, `_movieclipSample`) or the playhead clocks, with attachments named by the figure they join.
const poseFields = source => {
  const object = {};
  for (const key of Object.keys(source)) if (key !== 'runtime_segments' && key !== '_movieclipSample') object[key] = source[key];
  return object;
};

/** A pose compared by identity, independent of evaluation slots and caches. */
export function poseObjectSignature(object, frame) {
  const fields = poseFields(object);
  delete fields.object_slot;
  if (object.join) {
    const {target_object_slot, target_unique_id, ...join} = object.join;
    fields.join = {...join, target_unique_id: frame.objects[target_object_slot]?.unique_id ?? target_unique_id};
  }
  return JSON.stringify(fields);
}

/** The frame (or only the figures `uids` and the figures they are attached to) as a plain copy without the playhead clocks. */
export function snapshotPoseFrame(frame, uids) {
  let slots;
  if (uids) {
    const byUid = new Map(frame.objects.map((object, slot) => [object.unique_id, slot])), wanted = new Set(), queue = [];
    for (const uid of uids) { const slot = byUid.get(uid); if (slot !== undefined && !wanted.has(slot)) { wanted.add(slot); queue.push(slot); } }
    for (let i = 0; i < queue.length; i++) {
      const parent = frame.objects[queue[i]].join?.target_object_slot;
      if (parent !== undefined && frame.objects[parent] && !wanted.has(parent)) { wanted.add(parent); queue.push(parent); }
    }
    slots = [...wanted].sort((a, b) => a - b);
  } else slots = frame.objects.map((_, slot) => slot);
  const remap = new Map(slots.map((slot, index) => [slot, index]));
  const objects = slots.map((slot, index) => {
    const object = poseFields(frame.objects[slot]);
    return {...object, object_slot: index, ...(object.join ? {join: {...object.join, target_object_slot: remap.get(object.join.target_object_slot)}} : {})};
  });
  const order = (frame.object_draw_order ?? slots).filter(slot => remap.has(slot)).map(slot => remap.get(slot));
  const {_cameraMotionTick, _vfxTimelineTick, _vfxTimelineScene, ...saved} = frame;
  return structuredClone({...saved, objects, object_count: objects.length, object_draw_order: order,
    object_draw_order_unique_ids: order.map(slot => objects[slot].unique_id)});
}
