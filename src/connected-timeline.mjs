/** Union joins by persistent identity, including authored pose sources. Membership
 * is independent of the playhead: a pickup/drop does not reshuffle the timeline. */
const groupIndices=new WeakMap();
export function connectedGroupIndex(groups) {
  let index=groupIndices.get(groups);
  if(!index){index={byId:new Map(),byUid:new Map()};for(const group of groups){index.byId.set(group.id,group);for(const uid of group.figureUids)index.byUid.set(uid,group);}groupIndices.set(groups,index);}
  return index;
}
export function connectedTimelineGroups(report, {nativeGroups} = {}) {
  const parents = new Map();
  const find = uid => {
    if (!parents.has(uid)) parents.set(uid, uid);
    let root = uid;
    while (parents.get(root) !== root) root = parents.get(root);
    while (parents.get(uid) !== uid) { const next = parents.get(uid); parents.set(uid, root); uid = next; }
    return root;
  };
  const available = report?._styk?.frameSources ?? {}, referenced = new Set(), sequences = new Set();
  if (Object.keys(available).length) for (const channel of report?._styk?.animation?.channels ?? []) {
    if (channel.property !== 'pose' || sequences.has(channel.keys)) continue;
    sequences.add(channel.keys);
    for (const key of channel.keys) if (Object.hasOwn(available,key.value?.frameId)) referenced.add(key.value.frameId);
  }
  const sources = [...referenced].map(id => available[id]);
  if(nativeGroups){
    const {byUid}=connectedGroupIndex(nativeGroups);
    const unchanged=sources.every(frame=>frame.objects.every(object=>{
      if(!object.join)return true;
      const parent=object.join.target_unique_id??frame.objects[object.join.target_object_slot]?.unique_id;
      return parent===undefined||parent===object.unique_id||byUid.has(object.unique_id)&&byUid.get(object.unique_id)===byUid.get(parent);
    }));
    if(unchanged)return nativeGroups;
    for(const group of nativeGroups){const root=find(group.rootUid);for(const uid of group.figureUids)parents.set(find(uid),root);}
  }
  for (const frame of [...(nativeGroups ? [] : report?.keyframes ?? []), ...sources]) {
    for (const object of frame.objects ?? []) if (object.join) {
      const parent = object.join.target_unique_id ?? frame.objects[object.join.target_object_slot]?.unique_id;
      if (parent === undefined || parent === object.unique_id) continue;
      const a = find(object.unique_id), b = find(parent);
      if (a !== b) parents.set(a, b);
    }
  }
  const groups = new Map();
  for (const uid of parents.keys()) {
    const root = find(uid), list = groups.get(root) ?? [];
    list.push(uid); groups.set(root, list);
  }
  return [...groups].filter(([, uids]) => uids.length > 1).map(([rootUid, uids]) => ({
    id: `assembly:${Math.min(...uids)}`, rootUid, figureUids: uids.sort((a, b) => a - b),
  }));
}
