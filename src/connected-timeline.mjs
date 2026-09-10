/** Union joins by persistent identity, including authored pose sources. Membership
 * is independent of the playhead: a pickup/drop does not reshuffle the timeline. */
import {layerIdForUid} from './layers.mjs';
import {poseSourceFrame} from './animation-pose.mjs';
const groupIndices=new WeakMap();
export function connectedGroupIndex(groups) {
  let index=groupIndices.get(groups);
  if(!index){index={byId:new Map(),byUid:new Map()};for(const group of groups){index.byId.set(group.id,group);for(const uid of group.figureUids)index.byUid.set(uid,group);}groupIndices.set(groups,index);}
  return index;
}
const nativeMembership = new WeakMap();
export function connectedTimelineGroups(report, {nativeGroups} = {}) {
  // A child belongs to a rig only while its parent identity is consistent across
  // every pose in which it exists. Missing children do not split a rig. An
  // unjoined child, or one switching parents, is independently addressable.
  const cached = nativeGroups && nativeMembership.get(nativeGroups);
  const channels = report?._styk?.animation?.channels?.filter(channel => channel.property === 'pose') ?? [];
  const figureOwners = new Set(channels.filter(channel => channel.target?.kind === 'figure').map(channel => channel.target.uid));
  const layerOwners = new Set(channels.filter(channel => channel.target?.kind === 'layer').map(channel => channel.target.id));
  const nativeOwner = uid => !figureOwners.has(uid) && !layerOwners.has(layerIdForUid(report, uid));
  const membership = new Map([...(cached ?? [])].filter(([uid]) => nativeOwner(uid)));
  const observe = (frame, includes = () => true) => {
    for (const object of frame.objects ?? []) {
      if (!object || !includes(object.unique_id)) continue;
      const parent = object.join ? object.join.target_unique_id ?? frame.objects[object.join.target_object_slot]?.unique_id : null;
      const candidate = parent === undefined || parent === object.unique_id ? null : parent;
      if (!membership.has(object.unique_id)) membership.set(object.unique_id, candidate);
      else if (membership.get(object.unique_id) !== candidate) membership.set(object.unique_id, null);
    }
  };
  if (!cached) for (const frame of report?.keyframes ?? []) observe(frame, nativeOwner);
  // Snapshots retain ancestors and sometimes whole scenes. Only the owners
  // sampling a sequence contribute its attachment history.
  const sequences = new Map();
  for (const channel of channels) {
    if (channel.target && !['figure','layer'].includes(channel.target.kind)) continue;
    let owners = sequences.get(channel.keys);
    if (!owners) sequences.set(channel.keys, owners = {figures:new Set(),layers:new Set(),all:false});
    if (channel.target?.kind === 'figure') owners.figures.add(channel.target.uid);
    else if (channel.target?.kind === 'layer') owners.layers.add(channel.target.id);
    else owners.all = true;
  }
  for (const [keys, owners] of sequences) {
    const includes = uid => owners.all || owners.figures.has(uid) || !figureOwners.has(uid) && owners.layers.has(layerIdForUid(report, uid));
    const seen = new Set();
    for (const key of keys) {
      const id = key.value?.frameId;
      if (seen.has(id)) continue;
      seen.add(id);
      const source = poseSourceFrame(report, id);
      if (source) observe(source, includes);
    }
  }
  if (cached && membership.size === cached.size && [...membership].every(([uid,parent]) => cached.get(uid) === parent)) return nativeGroups;
  const parents = new Map();
  const find = uid => {
    if (!parents.has(uid)) parents.set(uid,uid);
    let root = uid;
    while (parents.get(root) !== root) root = parents.get(root);
    while (parents.get(uid) !== uid) { const next = parents.get(uid); parents.set(uid,root); uid = next; }
    return root;
  };
  for (const [uid,parent] of membership) if (parent !== null && membership.has(parent)) {
    const a = find(uid), b = find(parent); if (a !== b) parents.set(a,b);
  }
  const groups = new Map();
  for (const uid of parents.keys()) {
    const root = find(uid), list = groups.get(root) ?? []; list.push(uid); groups.set(root,list);
  }
  const result = [...groups].filter(([,uids]) => uids.length > 1).map(([rootUid,uids]) => ({
    id: 'assembly:' + Math.min(...uids), rootUid, figureUids: uids.sort((a,b) => a-b),
  }));
  nativeMembership.set(result,membership);
  return result;
}
