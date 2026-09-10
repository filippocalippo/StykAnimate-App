import {ikLayout, ikChain, ikFollowers, ikFollowerIndices, ikBendReference, solveObjectIK, MAX_IK_CHAIN} from './ik.mjs';
import {ikComponents, joinedIKGraph} from './ik-joined.mjs';

function context(editor) {
  const frame = editor.selectionFrame;
  if (!frame.objects.some(o => o.join)) return null;
  const slots = ikComponents(frame).find(slots => slots.includes(editor.selectedSlot));
  return slots?.length > 1 ? joinedIKGraph(editor.report, frame, slots) : null;
}
function captureFor(editor, geometry, handle, controller, graph) {
  if (!graph) return capture(editor.figure, geometry, handle, controller);
  const chain = graph.chain(editor.selectedSlot, handle, controller.chainLength), scene = editor.geometry;
  const shapes = chain.map(i => {const e = graph.entries[i]; return scene.objects.get(e.slot).segments[e.index];});
  const rotation = controller.target?.rotation ?? 0, followers = {}, joinedFollowers = {};
  const id = graph.maps.get(editor.selectedSlot).get(handle);
  for (const i of ikFollowerIndices(graph.figure, id, graph.layout)) {
    const entry = graph.entries[i], angle = scene.objects.get(entry.slot).segments[entry.index].angle - rotation;
    if (entry.slot === editor.selectedSlot) followers[entry.handle] = angle;
    else (joinedFollowers[entry.uid] ??= {})[entry.handle] = angle;
  }
  return {target: {...geometry.joints.get(handle), rotation}, followers, joinedFollowers,
    bendDirection: controller.bendDirection,
    bendReference: ikBendReference([shapes[0].start, ...shapes.map(s => s.end)], shapes.map(s => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y)), controller.bendReference)};
}

function bakeGraph(editor, graph, scene, lengthEntries = []) {
  editor._expandIKDrag(graph.slots);
  for (const slot of graph.slots) {
    const object = editor.frame.objects[slot], geometry = scene.objects.get(slot);
    editor._bakeIKFollowers(object, geometry);
    if (geometry.solvedAngles) object.angles = geometry.solvedAngles.slice();
    const entries = lengthEntries.filter(e => e.slot === slot);
    if (geometry.solvedLengths && entries.length) {
      const lengths = object.len_flag ? object.lengths.slice() : geometry.fig.segments.map(s => s.length);
      for (const e of entries) lengths[e.index] = geometry.solvedLengths[e.index] ?? lengths[e.index];
      if (entries.some(e => lengths[e.index] !== (object.len_flag ? object.lengths[e.index] : geometry.fig.segments[e.index].length))) {object.len_flag = 1; object.lengths = lengths;}
    }
    delete object.runtime_segments;
  }
}

function poseGraph(editor, graph, handle, controller, geometry, target) {
  editor._expandIKDrag(graph.slots);
  const captured = captureFor(editor, geometry, handle, controller, graph), temporary = {...controller, ...captured, target, pinned: true};
  const baselines = new Map(editor._drag.before.map(o => [o.object_slot, o]));
  for (let i = 0; i < graph.entries.length; i++) {
    const entry = graph.entries[i], baseline = baselines.get(entry.slot), g = editor.geometry.objects.get(entry.slot);
    graph.object.lengths[i] = (baseline.len_flag ? baseline.lengths[entry.index] : g.fig.segments[entry.index].length) * entry.scale;
  }
  const id = graph.maps.get(editor.selectedSlot).get(handle), solved = graph.solve({[id]: graph.mapController(editor.selectedSlot, handle, temporary)});
  for (const [slot, result] of graph.scatter(solved)) {
    const object = editor.frame.objects[slot], baseline = baselines.get(slot);
    object.angles = result.angles;
    object.len_flag = result.lengths ? 1 : baseline.len_flag;
    object.lengths = (result.lengths ?? baseline.lengths).slice(); delete object.runtime_segments;
  }
  return {...captured, target, bendReference: solved.results.get(id)?.bendReference ?? captured.bendReference};
}

function controllerAt(editor) {
  const handle = editor.figure?.segments[editor.selectedJoint]?.segment_id;
  return {handle, controller: editor.object?._stykIK?.[handle]};
}
function capture(figure, geometry, handle, controller) {
  const index = figure.segments.findIndex(s => s.segment_id === handle), point = geometry.joints.get(handle);
  const rotation = controller?.target?.rotation ?? 0, followers = {};
  for (const i of ikFollowerIndices(figure, handle)) {
    const s = geometry.segments[i]; followers[s.seg.segment_id] = s.angle - rotation;
  }
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
  _bakeIKFollowers(object, geometry) {
    for (const [id, result] of geometry?.ik ?? []) {
      const c = object._stykIK?.[id]; if (!c?.enabled || !c.pinned || !result.followers) continue;
      object._stykIK = {...object._stykIK, [id]: {...c, followers: result.followers,
        ...(result.joinedFollowers ? {joinedFollowers: result.joinedFollowers} : {})}};
    }
  },
  _rotateIKFollowers(targets, delta, includeJoint) {
    if (!delta || !this._drag?.before.some(o => Object.values(o._stykIK ?? {}).some(c => c.enabled && c.pinned))) return;
    const graph = context(this), figure = graph?.figure ?? this.figure, source = graph?.object ?? this.object;
    const layout = graph?.layout ?? ikLayout(figure);
    const selected = new Set(targets.map(([slot, index]) => `${slot}:${index}`));
    const entryAt = i => graph?.entries[i] ?? {slot: this.selectedSlot, index: i, handle: figure.segments[i].segment_id};
    for (const [id, c] of Object.entries(source._stykIK ?? {})) {
      if (!c.enabled || !c.pinned) continue;
      const endpoint = layout.ids.get(Number(id)); if (endpoint === undefined) continue;
      const owner = entryAt(endpoint);
      // Ancestor FK motion must leave the target's orientation planted. An FK
      // edit inside the outgoing group instead changes its controller offset.
      if (selected.has(`${owner.slot}:${owner.index}`)) continue;
      const object = this.frame.objects[owner.slot], current = object._stykIK[owner.handle];
      let next;
      const followers = ikFollowers(figure, source, id, c, layout);
      for (const i of ikFollowerIndices(figure, id, layout)) {
        const child = entryAt(i);
        if (!includeJoint && child.slot === this.selectedSlot && child.index === this.selectedJoint) continue;
        if (!selected.has(`${child.slot}:${child.index}`)) continue;
        next ??= {...current, followers: {...current.followers}, joinedFollowers: {...current.joinedFollowers}};
        const angle = followers[figure.segments[i].segment_id] + delta;
        if (child.slot === owner.slot) next.followers[child.handle] = angle;
        else next.joinedFollowers[child.uid] = {...next.joinedFollowers[child.uid], [child.handle]: angle};
      }
      if (next) object._stykIK = {...object._stykIK, [owner.handle]: next};
    }
  },
  _ikPoseSlots(frame, slots) {
    if (!frame.objects.some(o => o.join) || !frame.objects.some(o => Object.values(o._stykIK ?? {}).some(c => c.enabled))) return slots;
    const affected = new Set(slots);
    for (const group of ikComponents(frame)) if (group.some(slot => affected.has(slot)) && group.some(slot => Object.values(frame.objects[slot]._stykIK ?? {}).some(c => c.enabled)))
      for (const slot of group) affected.add(slot);
    return [...affected].sort((a, b) => a - b);
  },
  _expandIKDrag(slots) {
    const snapshots = new Map(this._drag.before.map(o => [o.object_slot, o]));
    this._ownAuthoredSlots(slots);
    for (const slot of slots) if (!snapshots.has(slot)) snapshots.set(slot, structuredClone(this.frame.objects[slot]));
    this._drag.before = [...snapshots.values()].sort((a, b) => a.object_slot - b.object_slot);
  },
  getIKSettings() {
    const {handle, controller} = controllerAt(this);
    const graph = handle ? context(this) : null;
    const maxLength = handle ? (graph ? graph.chain(this.selectedSlot, handle, MAX_IK_CHAIN) : ikChain(this.figure, handle, MAX_IK_CHAIN)).length : 0;
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
    const graph = context(this), virtualHandle = graph?.maps.get(this.selectedSlot).get(handle);
    if (next.enabled) {
      const chain = new Set(graph ? graph.chain(this.selectedSlot, handle, next.chainLength) : ikChain(this.figure, handle, next.chainLength));
      for (const [id, other] of Object.entries(graph?.object._stykIK ?? this.object._stykIK ?? {})) if (Number(id) !== (virtualHandle ?? handle) && other.enabled &&
          ikChain(graph?.figure ?? this.figure, id, other.chainLength, graph?.layout).some(i => chain.has(i)))
        throw new Error('IK chains cannot share bones. Shorten the chain or disable the overlapping controller.');
    }
    const scene = this.geometry, geometry = scene.objects.get(this.selectedSlot);
    const solved = geometry.ik?.get(handle);
    if (solved?.followers) Object.assign(next, {followers: solved.followers}, solved.joinedFollowers ? {joinedFollowers: solved.joinedFollowers} : {});
    return this._objectEdit('Configure IK', object => {
      if (graph) bakeGraph(this, graph, scene, !next.enabled || !next.pinned ? graph.chain(this.selectedSlot, handle, settings.chainLength).map(i => graph.entries[i]) : []);
      else if (geometry.solvedAngles) {this._bakeIKFollowers(object, geometry); object.angles = geometry.solvedAngles.slice();}
      if (!graph && geometry.solvedLengths && (!next.enabled || !next.pinned)) {
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
        Object.assign(next, captureFor(this, geometry, handle, next, graph));
      if (settings.enabled && patch.chainLength !== undefined) {
        next.target = settings.target; next.bendDirection = settings.bendDirection;
      }
      if (patch.bendDirection !== undefined) {
        next.bendDirection = patch.bendDirection;
        if (next.bendDirection === 0) next.bendReference = captureFor(this, geometry, handle, next, graph).bendReference;
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
    const geometry = this.geometry.objects.get(this.selectedSlot), graph = context(this);
    return this._objectEdit('Move IK target', object => {
      const current = object._stykIK[handle], target = {...current.target, x, y};
      const next = {...current, target};
      // Unpinned IK is a posing tool: bake its solution, then let normal FK/root
      // transforms carry the limb. Pinning makes the target persist in world space.
      if (!current.pinned && graph) Object.assign(next, poseGraph(this, graph, handle, current, geometry, target));
      else if (!current.pinned) {
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
    const geometry = this.geometry.objects.get(this.selectedSlot), graph = context(this);
    return this._objectEdit('Rotate IK target', object => {
      const current = object._stykIK[handle];
      const next = {...current, target: {...current.target, rotation: radians}};
      if (!current.pinned) {
        // A free controller bakes explicit rotation into the displayed pose;
        // capture current articulation before rotating so re-pinning is smooth.
        Object.assign(next, captureFor(this, geometry, handle, current, graph), {target: {...current.target, rotation: radians}});
        const figure = graph?.figure ?? this.figure, layout = graph?.layout ?? ikLayout(figure);
        const id = graph?.maps.get(this.selectedSlot).get(handle) ?? handle;
        const indices = ikFollowerIndices(figure, id, layout), visited = new Set(indices);
        for (let q = 0; q < indices.length; q++) for (const child of layout.children.get(figure.segments[indices[q]].segment_id) ?? [])
          if (!visited.has(child)) {visited.add(child); indices.push(child);}
        this._applyJointRotation(indices.map(i => graph ? [graph.entries[i].slot, graph.entries[i].index] : [this.selectedSlot, i]), radians - current.target.rotation);
      }
      object._stykIK = {...object._stykIK, [handle]: next};
      delete object.runtime_segments;
    }, {posed: true});
  },
};
