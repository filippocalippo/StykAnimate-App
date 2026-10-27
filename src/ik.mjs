import {messageError} from './localized-error.mjs';
/** IK controllers as a document stores them: the chain a joint's controller drives and the check of the stored controller table.
 * Constraints belong to a pose instance and address stable handle IDs, never array slots. The engine solves them. */
import {derivedRigJoint} from './rig-constraints.mjs';
const MAX_IK_CHAIN = 256;
export const hasPinnedIK = object => Boolean(object?._stykIK && Object.values(object._stykIK).some(c => c.enabled && c.pinned));

function ikLayout(figure) {
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
    if(derivedRigJoint(figure.segments[i]))break;
    seen.add(i); chain.push(i); i = layout.ids.get(figure.segments[i].parent_id);
  }
  return chain.reverse();
}

export function validateIK(object) {
  if (object._stykIK === undefined) return;
  const table = object._stykIK;
  if (!table || typeof table !== 'object' || Array.isArray(table) || Object.keys(table).length > MAX_IK_CHAIN)
    throw messageError(new Error(''), "errors.ik.invalidIkControllerTable", {});
  for (const [handle, c] of Object.entries(table)) {
    if (!/^[1-9]\d*$/.test(handle) || Number(handle) > 65535 || !c ||
        typeof c.enabled !== 'boolean' || typeof c.pinned !== 'boolean' ||
        !Number.isInteger(c.chainLength) || c.chainLength < 1 || c.chainLength > MAX_IK_CHAIN ||
        ![1, 0, -1].includes(c.bendDirection) || c.allowStretch !== undefined && typeof c.allowStretch !== 'boolean' || !c.target ||
        !['x', 'y', 'rotation'].every(k => Number.isFinite(c.target[k])) ||
        !['x', 'y'].every(k => Number.isFinite(Math.fround(c.target[k])))) throw messageError(new Error(''), "errors.ik.invalidIkController", {});
    if (!c.followers || typeof c.followers !== 'object' || Array.isArray(c.followers) ||
        Object.entries(c.followers).some(([id, a]) => !/^[1-9]\d*$/.test(id) || !Number.isFinite(a)))
      throw messageError(new Error(''), "errors.ik.invalidIkControllerOrientation", {});
    if (c.attachmentOffsets !== undefined && (!c.attachmentOffsets || typeof c.attachmentOffsets !== 'object' || Array.isArray(c.attachmentOffsets) ||
        Object.entries(c.attachmentOffsets).some(([id,a]) => !/^[1-9]\d*$/.test(id) || !Number.isFinite(a)))) throw messageError(new Error(''), "errors.ik.invalidIkAttachmentOrientation", {});
    for (const field of ['joinedFollowers','joinedAttachmentOffsets']) if (c[field] !== undefined && (!c[field] || typeof c[field] !== 'object' || Array.isArray(c[field]) ||
        Object.entries(c[field]).some(([uid, children]) => !/^[1-9]\d*$/.test(uid) || !children || typeof children !== 'object' || Array.isArray(children) ||
          Object.entries(children).some(([id, a]) => !/^[1-9]\d*$/.test(id) || !Number.isFinite(a)))))
      throw messageError(new Error(''), "errors.ik.invalidJoinedIkOrientation", {});
    const quaternion=q=>Array.isArray(q)&&q.length===4&&q.every(Number.isFinite)&&Math.abs(Math.hypot(...q)-1)<1e-5;
    const quaternionTable=t=>t&&typeof t==='object'&&!Array.isArray(t)&&Object.entries(t).every(([id,q])=>/^[1-9]\d*$/.test(id)&&quaternion(q));
    if(c.spatialFollowers!==undefined&&!quaternionTable(c.spatialFollowers)||c.joinedSpatialFollowers!==undefined&&(!c.joinedSpatialFollowers||typeof c.joinedSpatialFollowers!=='object'||Array.isArray(c.joinedSpatialFollowers)||Object.entries(c.joinedSpatialFollowers).some(([id,t])=>!/^[1-9]\d*$/.test(id)||!quaternionTable(t))))throw messageError(new Error(''), "errors.ik.invalidSpatialIkOrientation", {});
    if(c.spatialTarget!==undefined){const t=c.spatialTarget,unit=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)&&Math.abs(Math.hypot(...v)-1)<=1e-5;if(!t||!Number.isFinite(t.depth)||!Number.isFinite(Math.fround(t.depth))||!unit(t.pole)||!Number.isFinite(t.swivel)||t.normals!==undefined&&(!Array.isArray(t.normals)||t.normals.length!==2||!t.normals.every(unit)))throw messageError(new Error(''), "errors.ik.invalidSpatialIkTarget", {});}
    if (c.bendReference !== undefined && (!c.bendReference || ![-1, 1].includes(c.bendReference.side) ||
        !['angle', 'axis', 'ratio'].every(k => Number.isFinite(c.bendReference[k])) || c.bendReference.ratio < 0 ||
        c.bendReference.shape !== undefined && (!Array.isArray(c.bendReference.shape) || c.bendReference.shape.length > MAX_IK_CHAIN || !c.bendReference.shape.every(Number.isFinite))))
      throw messageError(new Error(''), "errors.ik.invalidIkBendReference", {});
  }
}
