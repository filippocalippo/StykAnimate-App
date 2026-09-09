/** Numeric animation dependencies retained after construction joints disappear.
 * These bones never enter native geometry, selection, or the renderer. */
const layouts = new WeakMap();
export function originSupportLayout(figure) {
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
  if (ready.length !== support.bones.length) throw new Error('The retained animation support contains a cycle.');
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
/** Scalar and whole-figure rotation must carry hidden angular dependencies. */
export function rotateOriginSupport(figure, object, delta) {
  if (!delta || !figure?._styk?.animationOrigin?.support || !object._stykAnimationOrigin?.ghosts) return object;
  const ghosts = Object.fromEntries(Object.entries(object._stykAnimationOrigin.ghosts).map(([index, pose]) => [index, {...pose, angle_rad: pose.angle_rad + delta}]));
  object._stykAnimationOrigin = {...object._stykAnimationOrigin, ghosts}; return object;
}
export function mirrorOriginSupport(figure, object, axis = 'horizontal') {
  if (!figure?._styk?.animationOrigin?.support || !object._stykAnimationOrigin?.ghosts) return object;
  const ghosts = Object.fromEntries(Object.entries(object._stykAnimationOrigin.ghosts).map(([index, pose]) => [index,
    {...pose, angle_rad: axis === 'vertical' ? -pose.angle_rad : Math.PI - pose.angle_rad, bend_rad: -pose.bend_rad}]));
  object._stykAnimationOrigin = {...object._stykAnimationOrigin, ghosts}; return object;
}
export function resetOriginSupport(figure, object) {
  if (!figure?._styk?.animationOrigin?.support) return false;
  const before = JSON.stringify(object._stykAnimationOrigin?.ghosts); initializeOriginSupport(figure, object);
  return before !== JSON.stringify(object._stykAnimationOrigin?.ghosts);
}
export function initializeOriginSupport(figure, object) {
  const support = figure?._styk?.animationOrigin?.support; if (!support) return;
  const ghosts = {};
  support.bones.forEach((bone, index) => {if (bone.handleId === null) ghosts[index] = {angle_rad: bone.angle_rad, bend_rad: bone.bend_rad, length: bone.length};});
  if (Object.keys(ghosts).length) object._stykAnimationOrigin = {...object._stykAnimationOrigin, ghosts};
}
/** `sample` uses exactly the native interpolation/easing/wrap implementation. */
export function interpolateOriginSupport(figure, output, sample) {
  const layout = originSupportLayout(figure), {support} = layout, ghosts = {}, angles = new Array(support.bones.length), bends = new Array(support.bones.length);
  for (const index of layout.ready) {
    const bone = support.bones[index];
    bends[index] = sample(object => originSupportPose(figure, object, index, layout).bend_rad);
    if (bone.handleId === null) ghosts[index] = {bend_rad: bends[index], length: sample(object => originSupportPose(figure, object, index, layout).length)};
    const relative = sample(object => {
      const pose = originSupportPose(figure, object, index, layout);
      if (bone.parent < 0) return pose.angle_rad;
      const parent = originSupportPose(figure, object, bone.parent, layout);
      return pose.angle_rad - parent.angle_rad - parent.bend_rad;
    }, true);
    angles[index] = relative + (bone.parent < 0 ? 0 : angles[bone.parent] + bends[bone.parent]);
    // The legacy reversed-edge round trip adds one turn when it writes a
    // native angle and reads its virtual direction again. Retain that exact
    // property value for hidden edges as well as their identical geometry.
    if (bone.handleId === null) ghosts[index].angle_rad = angles[index] + (bone.reversed ? 2 * Math.PI : 0);
  }
  output.angles = [...output.angles];
  support.bones.forEach((bone, index) => {if (bone.handleId !== null) output.angles[layout.indices[index]] = angles[index] + (bone.reversed ? bends[index] + Math.PI : 0);});
  if (Object.keys(ghosts).length) output._stykAnimationOrigin = {...output._stykAnimationOrigin, ghosts};
  return output;
}
