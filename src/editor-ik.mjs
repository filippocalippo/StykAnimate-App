import {ikLayout, ikChain, ikBendReference, solveObjectIK, MAX_IK_CHAIN} from './ik.mjs';

function controllerAt(editor) {
  const handle = editor.figure?.segments[editor.selectedJoint]?.segment_id;
  return {handle, controller: editor.object?._stykIK?.[handle]};
}
function capture(figure, geometry, handle, controller) {
  const index = figure.segments.findIndex(s => s.segment_id === handle), point = geometry.joints.get(handle);
  const rotation = controller?.target?.rotation ?? 0, followers = {};
  for (const s of geometry.segments) if (s.seg.parent_id === handle) followers[s.seg.segment_id] = s.angle - rotation;
  const chain = ikChain(figure, handle, controller?.chainLength ?? 2);
  let bendDirection = controller?.bendDirection ?? 1;
  if (chain.length >= 2) {
    const a = geometry.segments[chain[0]].start, c = geometry.segments[chain.at(-1)].end;
    let cross = 0;
    for (const i of chain.slice(0, -1)) {
      const b = geometry.segments[i].end, value = (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
      if (Math.abs(value) > Math.abs(cross)) cross = value;
    }
    if (Math.abs(cross) > 1e-8) bendDirection = cross < 0 ? -1 : 1;
  }
  if (index < 0 || !point) throw new Error('Select a valid IK node.');
  const points = [geometry.segments[chain[0]].start, ...chain.map(i => geometry.segments[i].end)];
  const lengths = chain.map(i => {const s = geometry.segments[i]; return Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);});
  return {target: {...point, rotation}, followers, bendDirection: controller?.bendDirection ?? bendDirection,
    bendReference: ikBendReference(points, lengths, controller?.bendReference)};
}

export const editorIKMethods = {
  getIKSettings() {
    const {handle, controller} = controllerAt(this);
    const maxLength = handle ? ikChain(this.figure, handle, MAX_IK_CHAIN).length : 0;
    return {enabled: false, pinned: false, allowStretch: false, bendDirection: 0, chainLength: Math.min(2, maxLength), ...controller, maxLength};
  },
  _rememberIKBends() {
    // Resolve through the normal geometry cache once. Saving just the compact
    // branch reference keeps replay/export deterministic and avoids a global,
    // time-dependent solver cache. Unchanged figures retain their geometry.
    let geometry;
    for (const before of this._drag?.before ?? []) {
      const object = this.frame.objects[before.object_slot];
      if (object?.unique_id !== before.unique_id) continue;
      for (const [id, c] of Object.entries(object._stykIK ?? {})) {
        if (!c.enabled || !c.pinned || c.bendDirection !== 0) continue;
        geometry ??= this.geometry;
        let reference = geometry.objects.get(object.object_slot)?.ik?.get(Number(id))?.bendReference;
        if (!reference) continue;
        const baseline = before._stykIK?.[id]?.bendReference;
        // Returning to the same pose must remain an exact history no-op.
        const closeAngle = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-7;
        if (baseline && reference.side === baseline.side && closeAngle(reference.angle, baseline.angle) &&
            closeAngle(reference.axis, baseline.axis) && Math.abs(reference.ratio - baseline.ratio) < 1e-7 &&
            reference.shape?.length === baseline.shape?.length && (!reference.shape || reference.shape.every((a, i) => closeAngle(a, baseline.shape[i])))) reference = baseline;
        object._stykIK = {...object._stykIK, [id]: {...c, bendReference: reference}};
      }
    }
  },
  setNodeIK(patch) {
    const {handle} = controllerAt(this);
    if (!handle) return false;
    const settings = this.getIKSettings(), next = {...settings, ...patch}; delete next.maxLength;
    if (Object.keys(patch).some(k => !['enabled', 'pinned', 'allowStretch', 'chainLength', 'bendDirection'].includes(k))) throw new Error('Unknown IK setting.');
    if (!Number.isInteger(next.chainLength) || next.chainLength < 1 || next.chainLength > settings.maxLength)
      throw new Error(`Chain length must be between 1 and ${settings.maxLength}.`);
    if (typeof next.enabled !== 'boolean' || typeof next.pinned !== 'boolean' || typeof next.allowStretch !== 'boolean' || ![-1, 0, 1].includes(next.bendDirection))
      throw new Error('Invalid IK setting.');
    // Enabling creates a pinned controller at the displayed endpoint, without a jump.
    if (patch.enabled === true && !settings.enabled && patch.pinned === undefined) next.pinned = true;
    if (next.enabled) {
      const chain = new Set(ikChain(this.figure, handle, next.chainLength));
      for (const [id, other] of Object.entries(this.object._stykIK ?? {})) if (Number(id) !== handle && other.enabled &&
          ikChain(this.figure, id, other.chainLength).some(i => chain.has(i)))
        throw new Error('IK chains cannot share bones. Shorten the chain or disable the overlapping controller.');
    }
    const geometry = this.geometry.objects.get(this.selectedSlot);
    return this._objectEdit('Configure IK', object => {
      if (geometry.solvedAngles) object.angles = geometry.solvedAngles.slice();
      if (geometry.solvedLengths && (!next.enabled || !next.pinned)) {
        // Releasing one controller must not change another limb's rest lengths.
        const chain = ikChain(this.figure, handle, settings.chainLength);
        const rest = i => object.len_flag ? object.lengths[i] : this.figure.segments[i].length;
        if (chain.some(i => geometry.solvedLengths[i] !== rest(i))) {
          const lengths = this.figure.segments.map((_, i) => rest(i));
          for (const i of chain) lengths[i] = geometry.solvedLengths[i];
          object.len_flag = 1; object.lengths = lengths;
        }
      }
      if (!settings.enabled || patch.pinned === true && !settings.pinned || patch.chainLength !== undefined)
        Object.assign(next, capture(this.figure, geometry, handle, next));
      if (settings.enabled && patch.chainLength !== undefined) {
        next.target = settings.target; next.bendDirection = settings.bendDirection;
      }
      if (patch.bendDirection !== undefined) {
        next.bendDirection = patch.bendDirection;
        if (next.bendDirection === 0) next.bendReference = capture(this.figure, geometry, handle, next).bendReference;
      }
      if (!next.enabled) {
        object._stykIK = {...object._stykIK}; delete object._stykIK[handle];
        if (!Object.keys(object._stykIK).length) delete object._stykIK;
      } else object._stykIK = {...object._stykIK, [handle]: next};
      delete object.runtime_segments;
    });
  },
  poseIKTarget(x, y) {
    if (![x, y].every(Number.isFinite)) throw new Error('IK target coordinates must be finite.');
    const {handle, controller} = controllerAt(this);
    if (!controller?.enabled) return false;
    const geometry = this.geometry.objects.get(this.selectedSlot);
    return this._objectEdit('Move IK target', object => {
      const current = object._stykIK[handle], target = {...current.target, x, y};
      const next = {...current, target};
      // Unpinned IK is a posing tool: bake its solution, then let normal FK/root
      // transforms carry the limb. Pinning makes the target persist in world space.
      if (!current.pinned) {
        const temporary = {...next, ...capture(this.figure, geometry, handle, current), target, pinned: true};
        const baseline = this._drag.before.find(o => o.unique_id === object.unique_id);
        const source = {...object, len_flag: baseline.len_flag, lengths: baseline.lengths};
        const solution = solveObjectIK(this.figure, source, geometry.root, ikLayout(this.figure), {[handle]: temporary});
        object.angles = solution.angles;
        object.len_flag = solution.lengths ? 1 : baseline.len_flag;
        object.lengths = (solution.lengths ?? baseline.lengths).slice();
        next.followers = temporary.followers;
        next.bendReference = solution.results.get(handle)?.bendReference ?? temporary.bendReference;
      }
      object._stykIK = {...object._stykIK, [handle]: next}; delete object.runtime_segments;
    });
  },
  rotateIKTarget(radians) {
    if (!Number.isFinite(radians)) throw new Error('IK rotation must be finite.');
    const {handle, controller} = controllerAt(this);
    if (!controller?.enabled) return false;
    const geometry = this.geometry.objects.get(this.selectedSlot);
    return this._objectEdit('Rotate IK target', object => {
      const next = {...object._stykIK[handle], target: {...controller.target, rotation: radians}};
      if (!controller.pinned) {
        const captured = capture(this.figure, geometry, handle, controller);
        const temporary = {...next, followers: captured.followers, pinned: true, target: {...captured.target, rotation: radians}};
        const solution = solveObjectIK(this.figure, object, geometry.root, ikLayout(this.figure), {[handle]: temporary});
        object.angles = solution.angles;
        if (solution.lengths) { object.len_flag = 1; object.lengths = solution.lengths; }
        next.target = temporary.target; next.followers = temporary.followers;
      }
      object._stykIK = {...object._stykIK, [handle]: next}; delete object.runtime_segments;
    });
  },
  _rotateIKFollower(delta) {
    const segment = this.figure?.segments[this.selectedJoint], table = this.object?._stykIK;
    const controller = table?.[segment?.parent_id];
    if (!controller?.enabled || !controller.pinned || controller.followers[segment.segment_id] === undefined) return;
    this.object._stykIK = {...table, [segment.parent_id]: {...controller,
      followers: {...controller.followers, [segment.segment_id]: controller.followers[segment.segment_id] + delta}}};
  },
};
