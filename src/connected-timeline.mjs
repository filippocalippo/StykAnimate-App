/** Union joins by persistent identity, including authored pose sources. Membership
 * is independent of the playhead: a pickup/drop does not reshuffle the timeline. */
export function connectedTimelineGroups(report) {
  const parents = new Map();
  const find = uid => {
    if (!parents.has(uid)) parents.set(uid, uid);
    let root = uid;
    while (parents.get(root) !== root) root = parents.get(root);
    while (parents.get(uid) !== uid) { const next = parents.get(uid); parents.set(uid, root); uid = next; }
    return root;
  };
  const referenced = new Set((report?._styk?.animation?.channels ?? []).filter(channel => channel.property === 'pose')
    .flatMap(channel => channel.keys.map(key => key.value?.frameId)));
  const sources = Object.entries(report?._styk?.frameSources ?? {}).filter(([id]) => referenced.has(id)).map(([,frame]) => frame);
  for (const frame of [...(report?.keyframes ?? []), ...sources]) {
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
