function poseFields(source) {
  const object = {};
  for (const key of Object.keys(source)) if (key !== 'runtime_segments' && key !== '_movieclipSample') object[key] = source[key];
  return object;
}

/** Clipboard and history own saved pose data, never evaluated render caches. */
export function snapshotPoseObject(object) { return structuredClone(poseFields(object)); }

/** Capture the authoritative pose owned by a gesture. Attachment ancestors are
 * retained for exact world-coordinate reconstruction; unrelated figures do not
 * become history assets. Every retained record remains independently owned. */
export function snapshotPoseFrame(frame, uids) {
  let slots;
  if (uids) {
    const byUid=new Map(frame.objects.map((object,slot)=>[object.unique_id,slot])), wanted=new Set(),queue=[];
    for(const uid of uids){const slot=byUid.get(uid);if(slot!==undefined&&!wanted.has(slot)){wanted.add(slot);queue.push(slot);}}
    for(let i=0;i<queue.length;i++){
      const parent=frame.objects[queue[i]].join?.target_object_slot;
      if(parent!==undefined&&frame.objects[parent]&&!wanted.has(parent)){wanted.add(parent);queue.push(parent);}
    }
    slots=[...wanted].sort((a,b)=>a-b);
  } else slots=frame.objects.map((_,slot)=>slot);
  const remap=new Map(slots.map((slot,index)=>[slot,index]));
  const objects=slots.map((slot,index)=>{
    const object=poseFields(frame.objects[slot]);
    return {...object,object_slot:index,...(object.join?{join:{...object.join,target_object_slot:remap.get(object.join.target_object_slot)}}:{})};
  });
  const order=(frame.object_draw_order??slots).filter(slot=>remap.has(slot)).map(slot=>remap.get(slot));
  return structuredClone({...frame,objects,object_count:objects.length,object_draw_order:order,
    object_draw_order_unique_ids:order.map(slot=>objects[slot].unique_id)});
}
