import {messageError} from './localized-error.mjs';
/** Numeric animation dependencies retained after construction joints disappear.
 * These bones never enter native geometry, selection, or the renderer. */
const layouts = new WeakMap();
function originSupportLayout(figure) {
  const support = figure?._styk?.animationOrigin?.support;
  if (!support) return null;
  let layout = layouts.get(support);
  if (layout?.segments === figure.segments) return layout;
  const ids = new Map(figure.segments.map((segment, index) => [segment.segment_id, index]));
  const children = new Map(), ready = [], indices = support.bones.map(bone => bone.handleId === null ? -1 : ids.get(bone.handleId));
  support.bones.forEach((bone, index) => {
    if (bone.parent < 0) ready.push(index);
    else {const list = children.get(bone.parent) ?? []; list.push(index); children.set(bone.parent, list);}
  });
  for (let cursor = 0; cursor < ready.length; cursor++) for (const child of children.get(ready[cursor]) ?? []) ready.push(child);
  if (ready.length !== support.bones.length) throw messageError(new Error(''), "errors.animationOriginSupport.theRetainedAnimationSupportContainsACycle", {});
  layout = {support, segments: figure.segments, indices, ready}; layouts.set(support, layout); return layout;
}
export function originSupportPose(figure, object, index, layout = originSupportLayout(figure)) {
  const bone = layout.support.bones[index], nativeIndex = layout.indices[index];
  if (nativeIndex < 0) return object?._stykAnimationOrigin?.ghosts?.[index] ?? bone;
  if (!object) return bone;
  const segment = figure.segments[nativeIndex], runtime = object.runtime_segments?.[nativeIndex];
  const bend = Number(object.bend_flag ? object.bends[nativeIndex] : runtime?.bend_rad ?? segment.bend_rad ?? 0);
  return {angle_rad: Number(object.angles[nativeIndex]) + (bone.reversed ? bend + Math.PI : 0),
    bend_rad: bone.reversed ? -bend : bend,
    length: Number(object.len_flag ? object.lengths[nativeIndex] : runtime?.length ?? segment.length)};
}
export function originSupportOffset(figure, object) {
  const layout = originSupportLayout(figure), scale = Number(object.scale ?? 1); let x = 0, y = 0;
  for (const {bone, sign} of layout.support.path) {
    const pose = originSupportPose(figure, object, bone, layout), angle = pose.angle_rad, bend = pose.bend_rad, length = pose.length * scale * sign;
    if (Math.abs(bend) < 1e-7) {x += length * Math.cos(angle); y += length * Math.sin(angle);}
    else {const radius = length / bend; x += radius * (Math.sin(angle + bend) - Math.sin(angle)); y += radius * (Math.cos(angle) - Math.cos(angle + bend));}
  }
  return {x, y};
}
export function initializeOriginSupport(figure, object) {
  const support = figure?._styk?.animationOrigin?.support; if (!support) return;
  const ghosts = {};
  support.bones.forEach((bone, index) => {if (bone.handleId === null) ghosts[index] = {angle_rad: bone.angle_rad, bend_rad: bone.bend_rad, length: bone.length};});
  if (Object.keys(ghosts).length) object._stykAnimationOrigin = {...object._stykAnimationOrigin, ghosts};
}
