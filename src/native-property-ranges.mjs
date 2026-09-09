/** Absolute native values on selected frames; only touched components are copied. */
import { buildGeometry, evaluatedFrame } from "./pivot/geometry.mjs";
import { rotationEdits } from "./pivot/structure.mjs";
import { validateObjectChanges } from "./pivot/model.mjs";
import { objectBounds } from "./renderer-geometry.mjs";
import { setAnimationStyle } from "./animation-style.mjs";
import { rotateOriginSupport } from "./animation-origin-support.mjs";
const clone = (value) => structuredClone(value),
  radians = (value) => (value * Math.PI) / 180;

function affectedSlots(frame, selected, ancestors) {
  const children = new Map(),
    set = new Set(),
    queue = [];
  frame.objects.forEach((o, i) => {
    if (selected.has(o.unique_id)) {
      set.add(i);
      queue.push(i);
    }
    if (o.join) {
      const list = children.get(o.join.target_object_slot) ?? [];
      list.push(i);
      children.set(o.join.target_object_slot, list);
    }
  });
  if (ancestors)
    for (let n = 0; n < queue.length; n++) {
      const parent = frame.objects[queue[n]].join?.target_object_slot;
      if (parent !== undefined && !set.has(parent)) {
        set.add(parent);
        queue.push(parent);
      }
    }
  for (let n = 0; n < queue.length; n++)
    for (const child of children.get(queue[n]) ?? [])
      if (!set.has(child)) {
        set.add(child);
        queue.push(child);
      }
  return [...set];
}
function localGeometry(report, frame, slots) {
  const needed = new Set(slots),
    queue = [...slots];
  for (let n = 0; n < queue.length; n++) {
    const parent = frame.objects[queue[n]].join?.target_object_slot;
    if (parent !== undefined && !needed.has(parent)) {
      needed.add(parent);
      queue.push(parent);
    }
  }
  const ordered = [...needed].sort((a, b) => a - b),
    local = new Map(ordered.map((slot, i) => [slot, i]));
  const objects = ordered.map((slot, i) => {
    const object = frame.objects[slot];
    return {
      ...object,
      object_slot: i,
      join: object.join
        ? {
            ...object.join,
            target_object_slot: local.get(object.join.target_object_slot),
          }
        : null,
    };
  });
  const geometry = buildGeometry(report, {
    ...frame,
    objects,
    object_draw_order: objects.map((_, i) => i),
  });
  return new Map(
    ordered.map((slot) => [slot, geometry.objects.get(local.get(slot))]),
  );
}
function selectionBounds(geometry, selected) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const entry of geometry.values())
    if (selected.has(entry.obj.unique_id)) {
      const b = objectBounds([
        ...entry.segments
          .filter((s) => s.seg.visible !== false)
          .map((s) => ({ ...s, type: s.seg.segment_type || "line" })),
        ...entry.polys,
      ]);
      bounds.minX = Math.min(bounds.minX, b.x);
      bounds.minY = Math.min(bounds.minY, b.y);
      bounds.maxX = Math.max(bounds.maxX, b.x + b.width);
      bounds.maxY = Math.max(bounds.maxY, b.maxY ?? b.y + b.height);
    }
  return bounds;
}
function refreshJoined(report, frame, slots) {
  if (!slots.some((slot) => frame.objects[slot].join)) return;
  const geometry = localGeometry(report, frame, slots);
  for (const slot of slots) {
    const object = frame.objects[slot],
      root = geometry.get(slot)?.root;
    if (object.join && root) {
      object.root_x = root.x;
      object.root_y = root.y;
    }
  }
}
function mutatePose(
  editor,
  frame,
  slots,
  selected,
  key,
  value,
  joint,
  uid,
  capturedStyle,
) {
  const figureById = new Map(
    editor.report.figure_types.map((f) => [f.figure_type_id, f]),
  );
  const primary =
    frame.objects.find((o) => o.unique_id === uid) ??
    frame.objects.find((o) => selected.has(o.unique_id));
  if (!primary) return;
  if (capturedStyle) {
    const target = { ...capturedStyle.target, uid: primary.unique_id };
    const figure = figureById.get(primary.figure_type_id);
    const segment =
      target.kind === "segment"
        ? figure?.segments.find(
            (segment) => segment.segment_id === target.handleId,
          )
        : null;
    if (
      target.kind === "figure" ||
      (segment &&
        (capturedStyle.property !== "gradientOpacity" || segment.secondary))
    )
      setAnimationStyle(primary, target, capturedStyle.property, value / 100);
  } else if (
    [
      "root_x",
      "root_y",
      "group_x",
      "group_y",
      "group_width",
      "group_height",
    ].includes(key)
  ) {
    const geometry = localGeometry(editor.report, frame, slots),
      b = key.startsWith("group_") ? selectionBounds(geometry, selected) : null;
    if (key === "group_width" || key === "group_height") {
      const size = key === "group_width" ? b.maxX - b.minX : b.maxY - b.minY;
      if (size <= 0)
        throw new Error("A selected frame has a zero-sized figure group.");
      const factor = value / size,
        cx = (b.minX + b.maxX) / 2,
        cy = (b.minY + b.maxY) / 2;
      for (const slot of slots) {
        const object = frame.objects[slot];
        if (!object.join) {
          object.root_x = cx + (object.root_x - cx) * factor;
          object.root_y = cy + (object.root_y - cy) * factor;
        }
        object.scale *= factor;
      }
    } else {
      const axis = key.endsWith("_x") ? "x" : "y",
        root = geometry.get(frame.objects.indexOf(primary)).root,
        current = b ? b[axis === "x" ? "minX" : "minY"] : root[axis],
        delta = value - current;
      for (const slot of slots) {
        const object = frame.objects[slot];
        if (!object.join) object[`root_${axis}`] += delta;
      }
    }
  } else if (key === "scale") primary.scale = value / 100;
  else if (key === "rotation") {
    const figure = figureById.get(primary.figure_type_id),
      current = (primary.angles[0] ?? 0) - (figure.segments[0]?.angle_rad ?? 0),
      delta = radians(value) - current;
    for (const slot of slots) {
      frame.objects[slot].angles = frame.objects[slot].angles.map(
        (angle) => angle + delta,
      );
      rotateOriginSupport(figureById.get(frame.objects[slot].figure_type_id), frame.objects[slot], delta);
    }
  } else if (key === "figure_opacity") {
    for (const object of frame.objects)
      if (selected.has(object.unique_id))
        object.field28 = Math.round((1 - value / 100) * 255);
  } else if (key.startsWith("joint_")) {
    const figure = figureById.get(primary.figure_type_id),
      segment = figure.segments[joint];
    if (!segment) return;
    if (key === "joint_length") {
      if (!primary.len_flag)
        primary.lengths = figure.segments.map((s) => s.length);
      primary.len_flag = 1;
      primary.lengths[joint] = value;
    } else {
      const current =
        key === "joint_angle"
          ? primary.angles[joint]
          : primary.bend_flag
            ? primary.bends[joint]
            : (segment.bend_rad ?? 0);
      const primarySlot = frame.objects.indexOf(primary), rotatedChildren = new Set(), delta = radians(value) - current;
      for (const change of rotationEdits(
        { ...editor.report, keyframes: [frame] },
        0,
        frame.objects.indexOf(primary),
        joint,
        radians(value) - current,
        key === "joint_angle",
      )) {
        const path = change.path.split("/");
        const slot = Number(path[4]);
        frame.objects[slot].angles[Number(path[6])] = change.value;
        if (slot !== primarySlot) rotatedChildren.add(slot);
      }
      for (const slot of rotatedChildren) rotateOriginSupport(figureById.get(frame.objects[slot].figure_type_id), frame.objects[slot], delta);
      if (key === "joint_bend") {
        if (!primary.bend_flag)
          primary.bends = figure.segments.map((s) => s.bend_rad ?? 0);
        primary.bend_flag = 1;
        primary.bends[joint] = radians(value);
      }
    }
  }
  for (const slot of slots) delete frame.objects[slot].runtime_segments;
  refreshJoined(editor.report, frame, slots);
}

/** Build and validate every replacement before mutating any other frame. */
export function commitNativePoseRange(token) {
  const { editor, key } = token,
    drag = editor._drag;
  if(drag?.authored && editor.propertyChannels) {
    editor.cancelDrag();
    const selected=new Set(token.selection.uids),plans=[];
    for(const index of token.indices) {
      const tick=editor.timeline[index].start,source=evaluatedFrame(editor.report,index,0,tick);
      const eligible=new Set(source.objects.filter(object=>selected.has(object.unique_id)).map(object=>object.unique_id));
      if(!eligible.size)continue;
      const slots=affectedSlots(source,eligible,['root_x','root_y'].includes(key)||key.startsWith('group_'));
      const frame={...source,objects:source.objects.slice()},snapshots=slots.map(slot=>source.objects[slot]);
      for(const slot of slots)frame.objects[slot]=clone(source.objects[slot]);
      mutatePose(editor,frame,slots,eligible,key,token.value,token.joint,token.uid,token.capturedStyle);
      editor._synchronizeAnimationOrigins(frame,snapshots);
      const changedUids=slots.map(slot=>frame.objects[slot].unique_id);
      validateObjectChanges(editor.report,frame,new Set(changedUids));
      if(JSON.stringify(snapshots)!==JSON.stringify(slots.map(slot=>frame.objects[slot])))plans.push({tick,beforeFrame:source,frame,changedUids});
    }
    if(!plans.length)return false;
    editor._commitAuthoredFigureRange(plans,{kind:'pose'},null,editor.report,`${token.label} in ${plans.length} frames`,token.selection);
    return true;
  }
  if (drag?.authored)
    throw new Error("Choose native frames to apply an absolute value range.");
  const selected = new Set(token.selection.uids),
    before = [],
    after = [];
  for (const index of token.indices) {
    const source = editor.report.keyframes[index],
      eligible = new Set(
        source.objects
          .filter((o) => selected.has(o.unique_id))
          .map((o) => o.unique_id),
      );
    if (!eligible.size) continue;
    const current = index === token.frameIndex;
    const slots = current
      ? source.objects.flatMap((o, i) =>
          token.beforeObjects.has(o.unique_id) ? [i] : [],
        )
      : affectedSlots(
          source,
          eligible,
          ["root_x", "root_y"].includes(key) || key.startsWith("group_"),
        );
    const snapshots = current
      ? drag.before
      : slots.map((slot) => clone(source.objects[slot]));
    const frame = { ...source, objects: source.objects.slice() };
    for (const slot of slots) frame.objects[slot] = clone(source.objects[slot]);
    if (current) refreshJoined(editor.report, frame, slots);
    else
      mutatePose(
        editor,
        frame,
        slots,
        eligible,
        key,
        token.value,
        token.joint,
        token.uid,
        token.capturedStyle,
      );
    editor._synchronizeAnimationOrigins(frame, snapshots);
    validateObjectChanges(
      editor.report,
      frame,
      new Set(slots.map((slot) => frame.objects[slot].unique_id)),
    );
    const values = slots.map((slot) => frame.objects[slot]);
    if (JSON.stringify(snapshots) === JSON.stringify(values)) continue;
    before.push({ index, objects: snapshots });
    after.push({ index, objects: values });
  }
  editor._drag = null;
  if (!after.length) return false;
  for (const entry of after) editor._replaceObjects(entry.index, entry.objects);
  editor._record({
    kind: "native-properties",
    scope: "objects-range",
    label: `${token.label} in ${after.length} frames`,
    before,
    after,
    beforeSelection: token.selection,
    afterSelection: editor._selectionState(),
    structural: false,
    timing: false,
  });
  editor._invalidate();
  editor._emit("edit", {
    label: token.label,
    changedUids: [...selected],
    changedFrames: after.map((entry) => entry.index),
    nativeProperty: key,
  });
  return true;
}
