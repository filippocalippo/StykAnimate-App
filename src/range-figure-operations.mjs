/** Pure, copy-on-write plans for figure controls applied to native frame ranges.
 * Slots address joins; UIDs identify the same figure across different frames.
 * Numeric scale affects selected instances only, whereas flip includes their
 * joined descendants. Pivot documents those distinctions here:
 * https://www.pivotanimator.net/help5-2/joining_figures.htm
 * https://www.pivotanimator.net/help5-1/multi_figure_selection.htm
 */
import {buildGeometry} from './pivot/geometry.mjs';
import {layerIdForUid} from './layers.mjs';
import {objectBounds} from './renderer-geometry.mjs';
import {rotateOriginSupport,mirrorOriginSupport,resetOriginSupport} from './animation-origin-support.mjs';
import {animationRotation,reflectAnimationOriginOffset} from './animation-origin.mjs';

const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new Error(`${label} must be finite and within the native numeric range.`);
  return value;
};
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}.`);
  return value;
};
function validateOperation(report, operation) {
  if (!operation || typeof operation !== 'object') throw new Error('Choose a figure operation.');
  const {kind} = operation;
  if (kind === 'appearance') {
    const patch = {...(operation.patch ?? {})};
    if (operation.opacity !== undefined) {
      if (owns(patch, 'opacity') || owns(patch, 'field28')) throw new Error('Specify opacity only once.');
      patch.opacity = operation.opacity;
    }
    for (const key of Object.keys(patch)) {
      if (key === 'color_override_raw') integer(patch[key], report.version < 5 ? -0x80000000 : 0, 0xffffffff, 'figure color');
      else if (key === 'field28') integer(patch[key], 0, 255, 'figure transparency');
      else if (key === 'opacity') {
        finite(patch[key], 'Opacity');
        if (patch[key] < 0 || patch[key] > 1 || owns(patch, 'field28')) throw new Error('Opacity must be between 0 and 1 and specified only once.');
      } else throw new Error(`Unsupported appearance field: ${key}.`);
    }
    if (owns(patch, 'opacity')) { patch.field28 = Math.round((1 - patch.opacity) * 255); delete patch.opacity; }
    return {...operation, patch};
  }
  if (kind === 'order') {
    if (!['front', 'back'].includes(operation.direction) && !Number.isSafeInteger(operation.direction))
      throw new Error('Figure order needs front, back, or a whole number of steps.');
  } else if (kind === 'join') {
    integer(operation.targetUid, 0, 0xffffffff, 'join target identity');
    integer(operation.handleId ?? 0, 0, 0xffff, 'join target handle');
  } else if (kind === 'scale') {
    if (owns(operation, 'factor') === owns(operation, 'value')) throw new Error('Specify one scale factor or absolute scale value.');
    const value = finite(operation.factor ?? operation.value, 'Scale');
    if (value < 0) throw new Error('Scale cannot be negative.');
    if (operation.referenceUid !== undefined) integer(operation.referenceUid, 0, 0xffffffff, 'scale reference identity');
  } else if (kind === 'mirror') {
    if (!['horizontal', 'vertical'].includes(operation.axis ?? 'horizontal')) throw new Error('Choose a horizontal or vertical flip.');
  } else if (kind === 'duplicate') {
    if (!(operation.uidMap instanceof Map)) throw new Error('Duplicate figures require a stable identity map.');
    finite(operation.offset ?? 24, 'Duplicate offset');
  } else if (kind === 'rotate') {
    finite(operation.radians, 'Rotation');
  } else if (kind === 'align') {
    if (!['x', 'y'].includes(operation.axis) || !['start', 'center', 'end'].includes(operation.edge)) throw new Error('Choose an alignment axis and edge.');
    if (operation.boundsOf !== undefined && typeof operation.boundsOf !== 'function') throw new Error('Provide a figure bounds function.');
  } else if (kind === 'center') {
    finite(report.canvas_width, 'Canvas width'); finite(report.canvas_height, 'Canvas height');
  } else if (!['delete', 'detach', 'reset'].includes(kind)) throw new Error(`Unsupported figure operation: ${kind}.`);
  if (operation.center !== undefined) {
    finite(operation.center?.x, 'Transform center X'); finite(operation.center?.y, 'Transform center Y');
  }
  return operation;
}
function hierarchy(objects) {
  const children = new Map(), ready = [];
  objects.forEach((object, slot) => {
    if (!object.join) ready.push(slot);
    else {
      const parent = object.join.target_object_slot;
      if (!Number.isInteger(parent) || !objects[parent]) throw new Error('Join target is missing.');
      const list = children.get(parent) ?? []; list.push(slot); children.set(parent, list);
    }
  });
  for (let i = 0; i < ready.length; i++) for (const child of children.get(ready[i]) ?? []) ready.push(child);
  if (ready.length !== objects.length) throw new Error('Figures contain a cyclic join.');
  return {children, order: ready};
}
function descendants(children, slots) {
  const queue = [...slots], affected = new Set(queue);
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? [])
    if (!affected.has(child)) { affected.add(child); queue.push(child); }
  return affected;
}
function nativeOrder(frame) {
  const order = frame.object_draw_order ?? frame.objects.map((_, slot) => slot);
  if (order.length !== frame.objects.length || new Set(order).size !== order.length ||
      order.some(slot => !Number.isInteger(slot) || !frame.objects[slot])) throw new Error('Invalid native figure order.');
  return order;
}

/** Linear stable partition/movement even for a request to cross 100,000 slots. */
function movedOrder(order, selected, direction) {
  const others = order.filter(slot => !selected.has(slot));
  const steps = direction === 'front' ? order.length : direction === 'back' ? -order.length : direction;
  let passed = 0;
  const targets = [];
  for (const slot of order) {
    if (selected.has(slot)) targets.push({slot, position: Math.max(0, Math.min(others.length, passed + steps))});
    else passed++;
  }
  const result = []; let cursor = 0;
  for (let index = 0; index <= others.length; index++) {
    while (targets[cursor]?.position === index) result.push(targets[cursor++].slot);
    if (index < others.length) result.push(others[index]);
  }
  return result;
}

/** Only endpoints are needed to recanonicalize an attachment. This follows the
 * native float32 endpoint rounding without allocating the renderer's arcs,
 * polygons, styles and drawables a second time after each frame transform.
 */
function jointEndpoints(object, figure, root) {
  if (!figure) throw new Error('Unknown figure definition.');
  const segments = figure.segments, byHandle = new Map(segments.map((segment, index) => [segment.segment_id, index]));
  const children = new Map(), ready = [], joints = new Map([[0, root]]);
  segments.forEach((segment, index) => {
    if (!byHandle.has(segment.parent_id)) ready.push(index);
    else { const list = children.get(segment.parent_id) ?? []; list.push(index); children.set(segment.parent_id, list); }
  });
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const index = ready[cursor], segment = segments[index], runtime = object.runtime_segments?.[index];
    const start = joints.get(segment.parent_id) ?? root;
    const angle = object.angles?.[index] ?? runtime?.angle_rad ?? segment.angle_rad ?? 0;
    const bend = object.bend_flag ? (object.bends?.[index] ?? 0) : (runtime?.bend_rad ?? segment.bend_rad ?? 0);
    const length = (object.len_flag ? (object.lengths?.[index] ?? segment.length) : (runtime?.length ?? segment.length ?? 0)) * object.scale;
    let x, y;
    if (Math.abs(bend) < 1e-7) { x = start.x + length * Math.cos(angle); y = start.y + length * Math.sin(angle); }
    else { const radius = length / bend; x = start.x + radius * (Math.sin(angle + bend) - Math.sin(angle)); y = start.y + radius * (Math.cos(angle) - Math.cos(angle + bend)); }
    joints.set(segment.segment_id, {x: Math.fround(finite(x, 'Joint X')), y: Math.fround(finite(y, 'Joint Y'))});
    for (const child of children.get(segment.segment_id) ?? []) ready.push(child);
  }
  if (ready.length !== segments.length) throw new Error('Figure contains a cyclic segment hierarchy.');
  return joints;
}

/**
 * operation:
 *   delete | detach
 *   appearance: patch {color_override_raw?, field28?}, or opacity in [0,1]
 *   order: direction 'front' | 'back' | signed integer (within assigned layer)
 *   join: targetUid, handleId (native segment ID, 0 means origin)
 *   mirror: axis 'horizontal' | 'vertical', optional center {x,y}
 *   scale: factor OR native reference value, optional referenceUid and center
 *     Absolute values preserve selected figures' relative proportions.
 *
 * Missing selected UIDs and an absent join target are skipped. Invalid options,
 * handles and cycles throw before any source mutation. changedUids includes
 * removed figures and surviving figures whose native slot/reference changed.
 * Caller commits all planned frames together and owns history/selection.
 */
export function planFigureFrameOperation(report, frame, uids, input) {
  const operation = validateOperation(report, input), objects = frame.objects;
  const requested = new Set(uids ?? []), slots = [];
  objects.forEach((object, slot) => { if (requested.has(object.unique_id)) slots.push(slot); });
  if (!slots.length) return null;
  const selected = new Set(slots), changes = new Map();
  let geometry, sourceHierarchy;
  const getHierarchy = () => sourceHierarchy ??= hierarchy(objects);
  const getGeometry = () => {
    if (!geometry) {
      // A range can contain thousands of large frames. Resolve only the edited
      // component and its ancestry, not every unrelated figure on each frame.
      const {children} = getHierarchy();
      const needed = ['scale', 'mirror', 'rotate', 'join'].includes(operation.kind) ? descendants(children, slots) :
        operation.kind === 'delete' ? new Set(objects.flatMap((object, slot) => object.join && selected.has(object.join.target_object_slot) && !selected.has(slot) ? [slot] : [])) : new Set(slots);
      if (operation.kind === 'join') {
        const target = objects.findIndex(object => object.unique_id === operation.targetUid);
        if (target >= 0) needed.add(target);
      }
      const queue = [...needed];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const parent = objects[queue[cursor]].join?.target_object_slot;
        if (parent !== undefined && !needed.has(parent)) { needed.add(parent); queue.push(parent); }
      }
      const ordered = [...needed].sort((a, b) => a - b), localSlots = new Map(ordered.map((slot, index) => [slot, index]));
      const localObjects = ordered.map((slot, index) => {
        const object = objects[slot];
        return {...object, object_slot: index, join: object.join ? {...object.join, target_object_slot: localSlots.get(object.join.target_object_slot)} : null};
      });
      const local = buildGeometry(report, {...frame, objects: localObjects,
        object_draw_order: localObjects.map((_, index) => index), object_draw_order_unique_ids: localObjects.map(object => object.unique_id)});
      geometry = {warnings: local.warnings, objects: new Map(ordered.map(slot => [slot, local.objects.get(localSlots.get(slot))]))};
      if (geometry.warnings.length || [...geometry.objects.values()].some(value => !value))
        throw new Error('Cannot transform a frame with unresolved figure geometry.');
    }
    return geometry;
  };
  const patchObject = (slot, patch, remove = []) => {
    const source = changes.get(slot) ?? objects[slot];
    if (Object.entries(patch).every(([key, value]) => Object.is(source[key], value)) && remove.every(key => !owns(source, key))) return source;
    const next = changes.get(slot) ?? {...source}; changes.set(slot, next);
    Object.assign(next, patch); for (const key of remove) delete next[key];
    return next;
  };
  const result = (structural = false) => changes.size ? {
    frame: {...frame, objects: objects.map((object, slot) => changes.get(slot) ?? object)},
    changedUids: [...changes.keys()].sort((a, b) => a - b).map(slot => objects[slot].unique_id), structural,
  } : null;

  if (operation.kind === 'appearance') {
    for (const slot of slots) patchObject(slot, operation.patch, owns(operation.patch, 'color_override_raw') ? ['color_transition'] : []);
    return result();
  }
  if (operation.kind === 'duplicate') {
    if (objects.length + slots.length > 65535) throw new Error('A native keyframe supports at most 65,535 figures.');
    const occupied = new Set(objects.map(object => object.unique_id)), nextSlots = new Map(), offset = operation.offset ?? 24;
    for (const slot of slots) {
      const uid = operation.uidMap.get(objects[slot].unique_id); integer(uid, 0, 0xffffffff, 'duplicate figure identity');
      if (occupied.has(uid)) throw new Error('Duplicate figure identities must be fresh and distinct.');
      occupied.add(uid); nextSlots.set(slot, objects.length + nextSlots.size);
    }
    const types = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
    const copied = new Map(slots.map(slot => {
      const original = objects[slot], object = structuredClone(original), figure = types.get(object.figure_type_id);
      object.unique_id = operation.uidMap.get(original.unique_id); object.object_slot = nextSlots.get(slot);
      if (object.runtime_segments) {
        if (!object.len_flag) { object.len_flag = 1; object.lengths = figure.segments.map((segment, index) => object.runtime_segments[index]?.length ?? segment.length); }
        if (!object.bend_flag) { object.bend_flag = 1; object.bends = figure.segments.map((segment, index) => object.runtime_segments[index]?.bend_rad ?? segment.bend_rad ?? 0); }
      }
      const root = original.join ? getGeometry().objects.get(slot).root : {x: original.root_x, y: original.root_y};
      object.root_x = finite(root.x + offset, 'Duplicate X'); object.root_y = finite(root.y + offset, 'Duplicate Y');
      const target = original.join?.target_object_slot;
      object.join = selected.has(target) ? {...original.join, target_object_slot: nextSlots.get(target), target_unique_id: operation.uidMap.get(objects[target].unique_id)} : null;
      delete object.runtime_segments; return [slot, object];
    }));
    // Recanonicalize copied attachments in parent-first order, even when native
    // slots are reversed or a copied child detaches from an uncopied ancestor.
    const {order, children} = getHierarchy(), endpoints = new Map();
    for (const slot of order) if (selected.has(slot)) {
      const object = copied.get(slot), original = objects[slot];
      if (object.join) {
        const root = endpoints.get(original.join.target_object_slot)?.get(object.join.target_handle_id);
        if (!root) throw new Error('Duplicate attachment has an unresolved joint.');
        object.root_x = root.x; object.root_y = root.y;
      }
      if ((children.get(slot) ?? []).some(child => selected.has(child))) endpoints.set(slot,
        jointEndpoints(object, types.get(object.figure_type_id), {x: object.root_x, y: object.root_y}));
    }
    const added = slots.map(slot => copied.get(slot)), next = [...objects, ...added];
    const beforeOrder = nativeOrder(frame), drawOrder = [...beforeOrder, ...beforeOrder.filter(slot => selected.has(slot)).map(slot => nextSlots.get(slot))];
    return {frame: {...frame, objects: next, object_draw_order: drawOrder, object_draw_order_unique_ids: drawOrder.map(slot => next[slot].unique_id),
      ...('object_count' in frame ? {object_count: next.length} : {})}, changedUids: added.map(object => object.unique_id), structural: true};
  }
  if (operation.kind === 'order') {
    const before = nativeOrder(frame), groups = new Map();
    for (const slot of before) {
      const layer = layerIdForUid(report, objects[slot].unique_id), group = groups.get(layer) ?? {order: [], cursor: 0};
      group.order.push(slot); groups.set(layer, group);
    }
    for (const group of groups.values()) group.order = movedOrder(group.order, selected, operation.direction);
    const after = before.map(slot => { const group = groups.get(layerIdForUid(report, objects[slot].unique_id)); return group.order[group.cursor++]; });
    const changedUids = after.filter((slot, index) => slot !== before[index]).map(slot => objects[slot].unique_id);
    return changedUids.length ? {frame: {...frame, object_draw_order: after, object_draw_order_unique_ids: after.map(slot => objects[slot].unique_id)},
      changedUids, structural: true} : null;
  }
  if (operation.kind === 'delete') {
    const before = nativeOrder(frame), remap = new Map(), survivors = [];
    objects.forEach((object, slot) => { if (!selected.has(slot)) { remap.set(slot, survivors.length); survivors.push(slot); } });
    const changedUids = slots.map(slot => objects[slot].unique_id);
    const remaining = survivors.map(slot => {
      const object = objects[slot], nextSlot = remap.get(slot), patch = {};
      if (object.object_slot !== nextSlot) patch.object_slot = nextSlot;
      if (object.join) {
        const target = object.join.target_object_slot;
        if (selected.has(target)) {
          const root = getGeometry().objects.get(slot).root;
          Object.assign(patch, {join: null, root_x: root.x, root_y: root.y});
        } else if (remap.get(target) !== target) patch.join = {...object.join, target_object_slot: remap.get(target), target_unique_id: objects[target]?.unique_id};
      }
      if (Object.keys(patch).length) { changedUids.push(object.unique_id); return {...object, ...patch}; }
      return object;
    });
    const order = before.filter(slot => !selected.has(slot)).map(slot => remap.get(slot));
    return {frame: {...frame, objects: remaining, object_draw_order: order, object_draw_order_unique_ids: order.map(slot => remaining[slot].unique_id),
      ...('object_count' in frame ? {object_count: remaining.length} : {})}, changedUids, structural: true};
  }
  if (operation.kind === 'detach') {
    for (const slot of slots) if (objects[slot].join) {
      const root = getGeometry().objects.get(slot).root;
      patchObject(slot, {join: null, root_x: root.x, root_y: root.y});
    }
    return result(true);
  }

  const {children} = getHierarchy(), types = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
  if (operation.kind === 'reset') {
    for (const slot of slots) {
      const figure = types.get(objects[slot].figure_type_id); if (!figure) throw new Error('Unknown figure definition.');
      const angles = figure.segments.map(segment => segment.angle_rad ?? 0), original = objects[slot];
      const reset = {...original}, ghostsChanged = resetOriginSupport(figure, reset);
      if (!ghostsChanged && !original.len_flag && !original.bend_flag && !original.runtime_segments && !original.lengths?.length && !original.bends?.length &&
          original.angles.length === angles.length && original.angles.every((angle, i) => angle === angles[i])) continue;
      patchObject(slot, {angles, len_flag: 0, bend_flag: 0, lengths: [], bends: [],
        ...(ghostsChanged ? {_stykAnimationOrigin: reset._stykAnimationOrigin} : {})}, ['runtime_segments']);
    }
    if (!changes.size) return null;
  } else if (operation.kind === 'align' || operation.kind === 'center') {
    const roots = new Map(), groups = new Map();
    for (const slot of getHierarchy().order) roots.set(slot, objects[slot].join ? roots.get(objects[slot].join.target_object_slot) : slot);
    for (const slot of slots) { const root = roots.get(slot), group = groups.get(root) ?? []; group.push(slot); groups.set(root, group); }
    if (operation.kind === 'align' && groups.size < 2) return null;
    const geometry = getGeometry();
    if (operation.kind === 'center') {
      let center;
      if (slots.length === 1) center = geometry.objects.get(slots[0]).root;
      else {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const slot of slots) for (const point of geometry.objects.get(slot).joints.values()) {
          minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
        }
        center = {x: (minX + maxX) / 2, y: (minY + maxY) / 2};
      }
      const dx = report.canvas_width / 2 - center.x, dy = report.canvas_height / 2 - center.y;
      for (const root of groups.keys()) patchObject(root, {root_x: finite(objects[root].root_x + dx, 'Figure X'), root_y: finite(objects[root].root_y + dy, 'Figure Y')});
    } else {
      const [lo, hi, position] = operation.axis === 'x' ? ['minX', 'maxX', 'root_x'] : ['minY', 'maxY', 'root_y'];
      const boundsOf = operation.boundsOf ?? (g => objectBounds([...g.segments.filter(segment => segment.seg.visible !== false)
        .map(segment => ({...segment, type: segment.seg.segment_type || 'line'})), ...g.polys]));
      let start = Infinity, end = -Infinity; const extents = new Map();
      for (const [root, members] of groups) {
        let min = Infinity, max = -Infinity;
        for (const slot of members) {
          const raw = boundsOf(geometry.objects.get(slot)), bounds = raw && ('minX' in raw ? raw : {minX: raw.x, minY: raw.y, maxX: raw.x + raw.width, maxY: raw.y + raw.height});
          if (!bounds || !['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(bounds[key])) || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY)
            throw new Error('Figure bounds must contain finite, ordered coordinates.');
          min = Math.min(min, bounds[lo]); max = Math.max(max, bounds[hi]);
        }
        extents.set(root, {min, max}); start = Math.min(start, min); end = Math.max(end, max);
      }
      const at = (min, max) => operation.edge === 'start' ? min : operation.edge === 'end' ? max : (min + max) / 2, target = at(start, end);
      for (const [root, bounds] of extents) patchObject(root, {[position]: finite(objects[root][position] + target - at(bounds.min, bounds.max), 'Figure position')});
    }
    if (!changes.size) return null;
  } else if (operation.kind === 'join') {
    const target = objects.findIndex(object => object.unique_id === operation.targetUid);
    if (target < 0) return null;
    const handle = operation.handleId ?? 0, figure = types.get(objects[target].figure_type_id);
    if (!figure || (handle !== 0 && !figure.segments.some(segment => segment.segment_id === handle))) throw new Error('Choose a valid target joint.');
    for (let cursor = target; cursor !== undefined; cursor = objects[cursor].join?.target_object_slot)
      if (selected.has(cursor)) throw new Error('Joining these figures would create a cycle.');
    for (const slot of slots) {
      const join = objects[slot].join;
      if (join?.target_object_slot === target && join.target_handle_id === handle && join.target_unique_id === operation.targetUid) continue;
      patchObject(slot, {join: {...join, target_object_slot: target, target_unique_id: operation.targetUid, target_handle_id: handle}});
    }
    if (!changes.size) return null;
  } else {
    if (operation.kind === 'rotate' && operation.radians === 0) return null;
    let scaleFactor = operation.factor, collapsedScale;
    if (operation.kind === 'scale' && scaleFactor === undefined) {
      const slotByUid = new Map(slots.map(slot => [objects[slot].unique_id, slot]));
      const reference = slotByUid.get(operation.referenceUid) ?? [...requested].map(uid => slotByUid.get(uid)).find(slot => slot !== undefined);
      const original = objects[reference].scale;
      if (original) scaleFactor = operation.value / original;
      else if (!operation.value) scaleFactor = 1;
      else if (slots.every(slot => !objects[slot].scale)) { scaleFactor = 1; collapsedScale = operation.value; }
      else throw new Error('Cannot infer relative figure scales from a zero-scale reference.');
      finite(scaleFactor, 'Scale factor');
    }
    const selectedScales = operation.kind === 'scale' ? new Map(slots.map(slot => [slot,
      collapsedScale ?? finite(objects[slot].scale * scaleFactor, 'Scale')])) : null;
    if (selectedScales && [...selectedScales].every(([slot, value]) => value === objects[slot].scale)) return null;
    const affected = descendants(children, slots), g = getGeometry();
    let center = operation.center;
    if (!center && slots.length === 1) center = g.objects.get(slots[0]).root;
    if (!center) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const members = operation.kind === 'scale' ? selected : affected;
      for (const slot of members) for (const point of g.objects.get(slot).joints.values()) {
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
      }
      center = {x: (minX + maxX) / 2, y: (minY + maxY) / 2};
    }
    const transformed = operation.kind === 'scale' ? selected : affected;
    for (const slot of transformed) {
      const object = objects[slot], figure = types.get(object.figure_type_id), patch = {};
      // Materialize effective runtime lengths/bends before retiring a tween cache.
      if (object.runtime_segments) {
        if (!object.len_flag) { patch.len_flag = 1; patch.lengths = figure.segments.map((segment, index) => object.runtime_segments[index]?.length ?? segment.length); }
        if (!object.bend_flag) { patch.bend_flag = 1; patch.bends = figure.segments.map((segment, index) => object.runtime_segments[index]?.bend_rad ?? segment.bend_rad ?? 0); }
      }
      if (operation.kind === 'scale') {
        patch.scale = selectedScales.get(slot);
        if (!object.join) {
          patch.root_x = finite(center.x + (object.root_x - center.x) * scaleFactor, 'Figure X');
          patch.root_y = finite(center.y + (object.root_y - center.y) * scaleFactor, 'Figure Y');
        }
      } else if (operation.kind === 'rotate') {
        if (!object.join) {
          const x = object.root_x - center.x, y = object.root_y - center.y, c = Math.cos(operation.radians), s = Math.sin(operation.radians);
          patch.root_x = finite(center.x + x * c - y * s, 'Figure X'); patch.root_y = finite(center.y + x * s + y * c, 'Figure Y');
        }
        patch.angles = object.angles.map(angle => finite(angle + operation.radians, 'Joint angle'));
      } else {
        const horizontal = (operation.axis ?? 'horizontal') === 'horizontal';
        if (!object.join) {
          if (horizontal) patch.root_x = finite(2 * center.x - object.root_x, 'Figure X');
          else patch.root_y = finite(2 * center.y - object.root_y, 'Figure Y');
        }
        patch.angles = object.angles.map(angle => horizontal ? Math.PI - angle : -angle);
        const bends = patch.bends ?? (object.bend_flag ? object.bends : figure.segments.map(segment => segment.bend_rad ?? 0));
        patch.bend_flag = 1; patch.bends = bends.map(bend => -bend); patch.image_text_flags = Number(!object.image_text_flags);
      }
      const changed = patchObject(slot, patch, ['runtime_segments']);
      if (operation.kind === 'rotate') rotateOriginSupport(figure, changed, operation.radians);
      else if (operation.kind === 'mirror') {
        const axis = operation.axis ?? 'horizontal', previousRotation = object._stykAnimationOrigin ? animationRotation(figure, object) : 0;
        mirrorOriginSupport(figure, changed, axis);
        reflectAnimationOriginOffset(figure, changed, axis, previousRotation);
      }
    }
  }

  // Re-evaluate only attachment endpoints below changed figures. Canonical raw
  // roots survive native export even when sources stored stale joined origins.
  const affected = descendants(children, changes.keys()), originalGeometry = getGeometry();
  const nextObjects = objects.map((object, slot) => changes.get(slot) ?? object), nextHierarchy = hierarchy(nextObjects), endpoints = new Map();
  for (const slot of nextHierarchy.order) if (affected.has(slot)) {
    let object = changes.get(slot) ?? objects[slot], root = {x: object.root_x, y: object.root_y};
    if (object.join) {
      const parent = object.join.target_object_slot;
      root = (endpoints.get(parent) ?? originalGeometry.objects.get(parent)?.joints)?.get(object.join.target_handle_id);
      if (!root) throw new Error('Join target handle is missing.');
      object = patchObject(slot, {root_x: root.x, root_y: root.y});
    }
    if (nextHierarchy.children.has(slot)) endpoints.set(slot, jointEndpoints(object, types.get(object.figure_type_id), root));
  }
  return result(operation.kind === 'join');
}
