/** Small native-field gestures. Authored transform channels use editor-animation. */
import { objectBounds } from "./renderer-geometry.mjs";
import { cameraValues } from "./editor-camera.mjs";
import { commitNativePoseRange } from "./native-property-ranges.mjs";
import { animationStyleValue, setAnimationStyle, polygonIdentity, resolveInstanceFigure } from "./animation-style.mjs";
import { builderStyleProperty, previewBuilderStyleProperty } from './editor-builder-style.mjs';
import { builderBranchStyleBinding } from './editor-builder-branch.mjs';
import { branchOpacityPlan, branchGradientOpacityBinding, beginBranchStyleAnimation, previewBranchStyleAnimation, commitBranchStyleAnimation, cancelBranchStyleAnimation } from './editor-branch-style.mjs';

const active = new WeakMap();
const poseKeys = new Set([
  "root_x",
  "root_y",
  "scale",
  "rotation",
  "figure_opacity",
  "group_x",
  "group_y",
  "group_width",
  "group_height",
  "joint_angle",
  "joint_length",
  "joint_bend",
]);
const cameraKeys = new Set([
  "camera_x",
  "camera_y",
  "camera_scale",
  "camera_angle",
]);
const keys = new Set([
  "fps",
  "canvas_width",
  "canvas_height",
  "duration",
  "outline_width",
  "outline_opacity",
  "thickness",
  "segment_opacity",
  "segment_gradient_opacity",
  ...poseKeys,
  ...cameraKeys,
]);
const names = {
  fps: "Frame rate",
  canvas_width: "Canvas width",
  canvas_height: "Canvas height",
  duration: "Keyframe hold",
  outline_width: "Outline width",
  outline_opacity: "Outline opacity",
  thickness: "Joint width",
  segment_opacity: "Joint opacity",
  segment_gradient_opacity: "Gradient end opacity",
  group_x: "Selection X",
  group_y: "Selection Y",
  group_width: "Selection width",
  group_height: "Selection height",
  joint_angle: "Joint angle",
  joint_length: "Joint length",
  joint_bend: "Joint bend",
};
const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);
const radians = (value) => (value * Math.PI) / 180;
function styleBinding(editor, key) {
  const uid = editor.object?.unique_id;
  if (uid === undefined) return null;
  const polygon=/^polygon_(\d+)_opacity$/.exec(key);
  if (polygon) {
    const index=Number(polygon[1]),item=editor.figure?.polyfills?.[index];
    return item ? {target:{kind:'polygon',uid,polygonId:polygonIdentity(item,index),figureTypeId:editor.figure.figure_type_id},property:'opacity'} : null;
  }
  if (key === "outline_opacity")
    return { target: { kind: "figure", uid }, property: "outlineOpacity" };
  if (key === 'outline_width') return {target:{kind:'figure',uid}, property:'outlineWidth'};
  if (!["segment_opacity", "segment_gradient_opacity", 'thickness'].includes(key))
    return null;
  const handleId = editor.figure?.segments[editor.selectedJoint]?.segment_id;
  if (!Number.isInteger(handleId)) return null;
  return {
    target: { kind: "segment", uid, handleId },
    property: key === 'thickness' ? 'thickness' : key === "segment_opacity" ? "opacity" : "gradientOpacity",
  };
}
function capturedStyleBinding(editor, key) {
  // Pasted poses retain appearance after their source scalar channels are gone.
  // Edit that local override; changing the shared type would remain invisible.
  const binding = styleBinding(editor, key);
  if (!binding) return null;
  const style = editor.object._stykStyle;
  const value =
    binding.target.kind === "figure"
      ? style?.outlineOpacity
      : style?.segments?.[binding.target.handleId]?.[binding.property];
  return Number.isFinite(value) ? binding : null;
}
function boundsOfSelection(editor, supplied) {
  if (supplied) return typeof supplied === "function" ? supplied() : supplied;
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const geometry of editor.geometry.objects.values()) {
    if (!geometry || !editor.selectedUids.has(geometry.obj.unique_id)) continue;
    const raw = objectBounds([
        ...geometry.segments
          .filter((s) => s.seg.visible !== false)
          .map((s) => ({ ...s, type: s.seg.segment_type || "line" })),
        ...geometry.polys,
      ]),
      b = {
        minX: raw.x,
        minY: raw.y,
        maxX: raw.x + raw.width,
        maxY: raw.y + raw.height,
      };
    for (const k of ["minX", "minY"]) bounds[k] = Math.min(bounds[k], b[k]);
    for (const k of ["maxX", "maxY"]) bounds[k] = Math.max(bounds[k], b[k]);
  }
  return bounds;
}
export function canEditNativeProperty(editor, key) {
  if (key === 'segment_z_order' || /^polygon_\d+_(?:z_order|opacity)$/.test(key))
    return Boolean(builderStyleProperty(editor, key));
  if (!keys.has(key)) return false;
  if (key === "segment_gradient_opacity")
    return Boolean(resolveInstanceFigure(editor.figure,editor.object)?.segments[editor.selectedJoint]?.secondary);
  if (
    key.startsWith("group_") ||
    ["root_x", "root_y", "scale", "rotation", "figure_opacity"].includes(key)
  )
    return Boolean(editor.object);
  if (
    key.startsWith("joint_") ||
    ["thickness", "segment_opacity"].includes(key)
  )
    return Boolean(editor.figure?.segments[editor.selectedJoint]);
  return ["outline_width", "outline_opacity"].includes(key)
    ? Boolean(editor.figure)
    : Boolean(editor.frame);
}
export function getNativePropertyValue(editor, key, { bounds } = {}) {
  if (!canEditNativeProperty(editor, key)) return undefined;
  const builder = builderStyleProperty(editor, key);
  const appearance=editor.propertyChannels && styleBinding(editor,key);
  if (appearance) return animationStyleValue(editor.figure,editor.object,appearance.target,appearance.property) * (['thickness','outlineWidth'].includes(appearance.property) ? 1 : 100);
  if (builder) return builder.value;
  const object = editor.object,
    figure = editor.figure,
    index = editor.selectedJoint,
    segment = figure?.segments[index];
  const style = styleBinding(editor, key);
  if (style)
    return (
      animationStyleValue(figure, object, style.target, style.property) * (['thickness','outlineWidth'].includes(style.property) ? 1 : 100)
    );
  if (key === "root_x" || key === "root_y") return object[key];
  if (key === "scale") return object.scale * 100;
  if (key === "rotation")
    return (
      (((object.angles[0] ?? 0) - (figure.segments[0]?.angle_rad ?? 0)) * 180) /
      Math.PI
    );
  if (key === "figure_opacity") return (1 - (object.field28 ?? 0) / 255) * 100;
  if (cameraKeys.has(key)) {
    const c = cameraValues(editor.evaluatedFrame.camera);
    return key === "camera_scale"
      ? (c.scale ?? 1) * 100
      : key === "camera_angle"
        ? ((c.angle_rad ?? 0) * 180) / Math.PI
        : (c[key.slice(7)] ?? 0);
  }
  if (["fps", "canvas_width", "canvas_height"].includes(key))
    return editor.report[key];
  if (key === "duration") return editor.frame.duration_raw ?? 1;
  if (key === "outline_width")
    return figure.segment_decode?.global_style?.outline_thickness ?? 0;
  if (key === "outline_opacity")
    return (1 - (figure.segment_decode?.global_style?.u30 ?? 0) / 255) * 100;
  if (key === "thickness") return segment.thickness;
  if (key === "segment_opacity")
    return (1 - (segment.transparency ?? 0) / 255) * 100;
  if (key === "segment_gradient_opacity")
    return (1 - (segment.secondary.a ?? 0) / 255) * 100;
  if (key === "joint_angle")
    return ((object.angles[index] ?? segment.angle_rad) * 180) / Math.PI;
  if (key === "joint_length")
    return object.len_flag ? object.lengths[index] : segment.length;
  if (key === "joint_bend")
    return (
      ((object.bend_flag ? object.bends[index] : (segment.bend_rad ?? 0)) *
        180) /
      Math.PI
    );
  const b = boundsOfSelection(editor, bounds);
  return key === "group_x"
    ? b.minX
    : key === "group_y"
      ? b.minY
      : key === "group_width"
        ? b.maxX - b.minX
        : b.maxY - b.minY;
}
function validate(key, value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isFinite(Math.fround(value))
  )
    throw new Error("Enter a finite number within the native range.");
  if (/^polygon_\d+_opacity$/.test(key) && (value < 0 || value > 100))
    throw new Error('Polygon opacity must be from 0 to 100%.');
  const integer = ["fps", "canvas_width", "canvas_height", "duration"].includes(
    key,
  );
  const min =
    key === "duration"
      ? 0
      : integer
        ? 1
        : [
              "outline_width",
              "thickness",
              "joint_length",
              "segment_opacity",
              "segment_gradient_opacity",
              "outline_opacity",
              "figure_opacity",
            ].includes(key)
          ? 0
          : ["group_width", "group_height", "scale", "camera_scale"].includes(
                key,
              )
            ? 0.01
            : -Infinity;
  const max =
    key === "fps"
      ? 1000
      : key === "duration"
        ? 65535
        : key.startsWith("canvas_")
          ? 16384
          : [
                "segment_opacity",
                "segment_gradient_opacity",
                "outline_opacity",
                "figure_opacity",
              ].includes(key)
            ? 100
            : ["outline_width", "thickness"].includes(key)
              ? 1e6
              : Infinity;
  if (integer && !Number.isInteger(value))
    throw new Error("Enter a whole number.");
  if (value < min || value > max)
    throw new Error(`Enter a value from ${min} to ${max}.`);
  return value;
}
function rootFor(editor, scope, index) {
  return scope === "report"
    ? editor.report
    : scope === "frame"
      ? editor.report.keyframes[index]
      : scope === "figure"
        ? editor.report.figure_types[index]
        : null;
}
function readPath(root, path) {
  let parent = root;
  for (const key of path.slice(0, -1)) {
    parent = parent?.[key];
    if (parent === undefined || parent === null)
      return { exists: false, value: undefined };
  }
  return {
    exists: Object.hasOwn(parent, path.at(-1)),
    value: clone(parent[path.at(-1)]),
  };
}
function capture(root, paths) {
  const parents = new Map();
  for (const path of paths)
    for (let n = 1; n < path.length; n++) {
      const prefix = path.slice(0, n);
      if (!readPath(root, prefix).exists)
        parents.set(JSON.stringify(prefix), prefix);
    }
  return {
    entries: paths.map((path) => ({ path, ...readPath(root, path) })),
    removeEmptyParents: [...parents.values()].sort(
      (a, b) => b.length - a.length,
    ),
  };
}
function applyPatch(root, patch) {
  for (const entry of patch.entries) {
    let parent = root;
    for (const key of entry.path.slice(0, -1)) parent = parent[key] ??= {};
    const key = entry.path.at(-1);
    if (entry.exists) parent[key] = clone(entry.value);
    else delete parent[key];
  }
  for (const path of patch.removeEmptyParents || []) {
    let parent = root;
    for (const key of path.slice(0, -1)) parent = parent?.[key];
    const key = path.at(-1),
      value = parent?.[key];
    if (value && Object.keys(value).length === 0) delete parent[key];
  }
}
/** Called by Editor's history dispatcher. Only small validated field values are copied. */
export function applyNativePropertyCommand(editor, command, direction) {
  if (command.scope === "objects-range") {
    for (const entry of command[direction])
      editor._replaceObjects(entry.index, entry.objects);
    return;
  }
  if (command.scope === "frames-range") {
    for (const entry of command[direction])
      applyPatch(editor.report.keyframes[entry.index], entry.patch);
    return;
  }
  const root = rootFor(editor, command.scope, command.index);
  if (!root) throw new Error("The property target no longer exists.");
  applyPatch(root, command[direction]);
}
function signal(
  token,
  live = true,
  indices = live ? [token.frameIndex] : token.indices,
) {
  const { editor } = token;
  editor._invalidate({ timing: token.timing });
  editor._emit("edit", {
    label: token.label,
    live,
    timing: token.timing,
    definition: token.definition,
    nativeProperty: token.key,
    ...(!token.definition
      ? { changedFrames: [...indices], frameIndices: [...indices] }
      : {}),
  });
}
function assertCurrent(token) {
  if (!token || token.closed || active.get(token.editor) !== token)
    throw new Error("This property gesture has ended.");
  const editor = token.editor;
  if (
    editor.report !== token.report ||
    editor.frameIndex !== token.frameIndex ||
    ((token.pose || token.definition) &&
      (editor.selectedUid !== token.uid ||
        editor.selectedJoint !== token.joint))
  ) {
    cancelNativePropertyEdit(token);
    throw new Error("The selected property changed during the gesture.");
  }
}
export function beginNativePropertyEdit(
  editor,
  key,
  { bounds, indices, rangeMode = "absolute", branch = false } = {},
) {
  if (!canEditNativeProperty(editor, key))
    throw new Error("Select the property before editing it.");
  if (active.has(editor)) cancelNativePropertyEdit(active.get(editor));
  if (editor._animationEdit) editor.commitAnimationEdit();
  if (editor.dragging) editor.commitDrag();
  if(key==='duration'&&editor.report._styk?.layerSheet){const span=editor.sheetSpan();const token={editor,key,sheetDuration:true,report:editor.report,frameIndex:editor.frameIndex,uid:editor.selectedUid,joint:editor.selectedJoint,selection:editor._selectionState(),layerId:editor.activeLayerId,tick:editor.tick,value:span.end-span.start,initialValue:span.end-span.start,closed:false};active.set(editor,token);return token;}
  const selection = editor._selectionState(),
    builder = builderStyleProperty(editor, key, {branch}),
    branchPlan = branch ? branchOpacityPlan(editor, key) : null,
    branchStyle = branch && key === 'thickness' && !branchPlan?.authored ? builderBranchStyleBinding(editor, {thickness: 0})
      : branchPlan && !branchPlan.authored ? branchPlan.property === 'opacity'
        ? builderBranchStyleBinding(editor, {opacity: 0}) : branchGradientOpacityBinding(editor, branchPlan) : null,
    capturedStyle = branchPlan ? null : capturedStyleBinding(editor, key),
    b = key.startsWith("group_")
      ? { ...boundsOfSelection(editor, bounds) }
      : null;
  const token = {
    editor,
    key,
    label: builder?.label ?? (branchStyle || branchPlan ? `Branch ${key === 'thickness' ? 'thickness' : branchPlan.property === 'opacity' ? 'opacity' : 'gradient opacity'}` : names[key] ?? key.replaceAll("_", " ")),
    builder,
    branchStyle,
    branchPlan,
    report: editor.report,
    frameIndex: editor.frameIndex,
    uid: editor.selectedUid,
    joint: editor.selectedJoint,
    selection,
    pose: poseKeys.has(key) || Boolean(capturedStyle),
    capturedStyle,
    camera: cameraKeys.has(key),
    sheetTicks: editor.report._styk?.layerSheet ? editor.sheetEditTimes(indices??[editor.frameIndex]) : null,
    indices: editor._frameIndices(
      indices?.length ? [...indices, editor.frameIndex] : [editor.frameIndex],
    ),
    rangeMode,
    definition: !branchPlan?.authored && (
      Boolean(builder) ||
      !capturedStyle &&
      [
        "outline_width",
        "outline_opacity",
        "thickness",
        "segment_opacity",
        "segment_gradient_opacity",
      ].includes(key)),
    timing: ["fps", "duration"].includes(key),
    value: getNativePropertyValue(editor, key, { bounds: b }),
    bounds: b,
    closed: false,
  };
  if(token.sheetTicks)token.indices.sheetTicks=token.sheetTicks;
  if (!Number.isFinite(token.value))
    throw new Error("The selected property has no finite value.");
  token.initialValue = token.value;
  const scalar = editor.propertyChannels && !branchPlan ? styleBinding(editor, key) : null;
  if (scalar) {
    token.scalar = scalar; token.factor = ['thickness','outlineWidth'].includes(scalar.property) ? 1 : 100;
    editor.beginAnimationEdit(scalar.target, scalar.property);
    active.set(editor, token); return token;
  }
  if (token.pose && token.indices.length > 1 && editor.animationChannels.length && !editor.propertyChannels)
    throw new Error("Choose native frames to apply an absolute value range.");
  if (branchPlan?.authored) {
    token.branchAnimation = beginBranchStyleAnimation(editor, branchPlan);
  } else if (token.camera) {
    if (!editor.beginCameraDrag({ label: token.label }))
      throw new Error("Choose a camera frame.");
  } else if (token.pose) {
    if (
      !editor.beginDrag(token.label, {
        scope:
          key.startsWith("group_") || key === "root_x" || key === "root_y"
            ? "translation"
            : "selection",
      })
    )
      throw new Error("Choose a figure first.");
    token.beforeObjects = new Map(
      editor._drag.before.map((o) => [o.unique_id, o]),
    );
    if (b)
      token.center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  } else {
    token.scope = token.definition
      ? "figure"
      : key === "duration" || cameraKeys.has(key)
        ? "frame"
        : "report";
    token.index = token.definition
      ? editor.report.figure_types.indexOf(editor.figure)
      : token.frameIndex;
    token.paths = branchStyle ? branchStyle.paths : builder ? builder.paths : cameraKeys.has(key)
      ? [["camera"]]
      : ["outline_width", "outline_opacity"].includes(key)
        ? [["segment_decode", "global_style"]]
        : key === "thickness"
          ? [
              ["segments", token.joint, "thickness"],
              ["segments", token.joint, "visible"],
            ]
          : key === "segment_gradient_opacity"
            ? [["segments", token.joint, "secondary", "a"]]
            : key === "segment_opacity"
              ? [
                  ["segments", token.joint, "transparency"],
                  ["segments", token.joint, "color_alpha"],
                ]
              : key === "fps" && editor.report.version < 5
                ? [["fps"], ["frame_delay_ms"]]
                : [[key === "duration" ? "duration_raw" : key]];
    token.before = capture(
      rootFor(editor, token.scope, token.index),
      token.paths,
    );
  }
  active.set(editor, token);
  return token;
}
export function previewNativePropertyEdit(token, value) {
  assertCurrent(token);
  validate(token.key, value);
  if(token.sheetDuration){token.value=value;return true;}
  if (token.value === value && ((!token.branchStyle && !token.branchAnimation) || token.branchStyleApplied)) return false;
  const { editor, key } = token;
  if (token.scalar) {
    editor.previewAnimationEdit(value / token.factor);
  } else if (token.branchAnimation) {
    previewBranchStyleAnimation(editor, value / (key === 'thickness' ? 1 : 100));
    token.branchStyleApplied = true;
  } else if (token.camera) {
    const field = key === "camera_angle" ? "angle_rad" : key.slice(7);
    editor.updateCameraDrag(
      {
        [field]:
          key === "camera_scale"
            ? value / token.initialValue
            : key === "camera_angle"
              ? radians(value - token.initialValue)
              : value - token.initialValue,
      },
      { fromStart: true },
    );
  } else if (token.pose) {
    if (token.capturedStyle) {
      editor._objectEdit(token.label, (object) => {
        setAnimationStyle(
          object,
          token.capturedStyle.target,
          token.capturedStyle.property,
          value / 100,
        );
        delete object.runtime_segments;
      });
    } else if (["group_x", "group_y", "root_x", "root_y"].includes(key))
      editor.moveSelection(
        key.endsWith("_x") ? value - token.initialValue : 0,
        key.endsWith("_y") ? value - token.initialValue : 0,
        { fromStart: true },
      );
    else if (key === "scale") editor.updateObject({ scale: value / 100 });
    else if (key === "rotation")
      editor.rotateFigure(radians(value - getNativePropertyValue(editor, key)));
    else if (key === "figure_opacity")
      editor._objectEdit("Figure opacity", () => {
        for (const object of editor.selectedObjects) {
          object.field28 = Math.round((1 - value / 100) * 255);
          delete object.runtime_segments;
        }
      });
    else if (key === "group_width" || key === "group_height") {
      if (token.initialValue <= 0)
        throw new Error("Increase the selection size before scaling.");
      const factor = value / token.initialValue;
      for (const object of editor.frame.objects) {
        const before = token.beforeObjects.get(object.unique_id);
        if (!before) continue;
        if (!object.join) {
          object.root_x =
            token.center.x + (before.root_x - token.center.x) * factor;
          object.root_y =
            token.center.y + (before.root_y - token.center.y) * factor;
        }
        object.scale = before.scale * factor;
        delete object.runtime_segments;
      }
      editor.touch();
    } else
      editor.updateSegment(
        key === "joint_angle"
          ? { angle_rad: radians(value) }
          : key === "joint_length"
            ? { length: value }
            : { bend_rad: radians(value) },
      );
  } else {
    const root = rootFor(editor, token.scope, token.index);
    if (token.branchStyle) {
      token.branchStyle.mutate(root, token.key === 'thickness' ? {thickness: value} : {[token.branchPlan.property]: value / 100});
      token.branchStyleApplied = true;
    } else if (token.builder) {
      previewBuilderStyleProperty(root, token.builder, value);
    } else if (cameraKeys.has(key)) {
      root.camera = {
        x: 0,
        y: 0,
        scale: 1,
        angle_rad: 0,
        ...root.camera,
        is_default: false,
      };
      root.camera[key === "camera_angle" ? "angle_rad" : key.slice(7)] =
        key === "camera_scale"
          ? value / 100
          : key === "camera_angle"
            ? radians(value)
            : value;
    } else if (["outline_width", "outline_opacity"].includes(key)) {
      root.segment_decode ??= {};
      const style = (root.segment_decode.global_style ??= {
        u28: 0,
        outline_thickness: 0,
        rgb: [0, 0, 0],
        u30: 0,
      });
      if (key === "outline_opacity")
        style.u30 = Math.round((1 - value / 100) * 255);
      else {
        style.outline_thickness = value;
        const data = new DataView(new ArrayBuffer(4));
        data.setFloat32(0, value, true);
        style.u28 = data.getUint32(0, true);
      }
    } else if (key === "thickness") {
      const segment = root.segments[token.joint];
      segment.thickness = value;
      segment.visible = value > 0.01 || segment.primitive_code > 0;
    } else if (key === "segment_opacity") {
      const segment = root.segments[token.joint];
      segment.transparency = Math.round((1 - value / 100) * 255);
      segment.color_alpha = 1 - segment.transparency / 255;
    } else if (key === "segment_gradient_opacity") {
      root.segments[token.joint].secondary.a = Math.round(
        (1 - value / 100) * 255,
      );
    } else {
      root[key === "duration" ? "duration_raw" : key] = value;
      if (key === "fps" && editor.report.version < 5)
        root.frame_delay_ms = Math.round(1000 / value);
    }
    signal(token);
  }
  token.value = value;
  return true;
}
export function commitNativePropertyEdit(token) {
  assertCurrent(token);
  validate(token.key, token.value);
  if (token.value === token.initialValue && !token.branchStyle && !token.branchAnimation) {
    cancelNativePropertyEdit(token);
    return false;
  }
  const { editor } = token;
  const rangeCount=token.sheetTicks?.length??token.indices?.length;
  const rangeTimes=()=>token.sheetTicks??token.indices.map(index=>editor.timeline[index].start);
  if(token.sheetDuration){token.closed=true;active.delete(editor);return editor.sheetSetDuration(token.value,token.layerId,token.tick);}
  if (token.scalar) {
    let result;
    if(rangeCount>1){editor.cancelAnimationEdit();result=editor.addAnimationKeys(rangeTimes().map(tick=>({...token.scalar,tick,value:token.value/token.factor})));}
    else result = editor.commitAnimationEdit(); token.closed = true; active.delete(editor); return result;
  }
  if (token.branchAnimation) {
    try {
      let result;
      if (rangeCount > 1) {
        const entries=rangeTimes().flatMap(tick=>token.branchPlan.entries.map(entry=>({target:entry.target,property:token.branchPlan.property,tick,value:token.value/(token.key==='thickness'?1:100)})));
        cancelBranchStyleAnimation(editor);result=editor.addAnimationKeys(entries);
      } else result = commitBranchStyleAnimation(editor);
      token.closed = true; active.delete(editor); return result;
    } catch (error) { cancelNativePropertyEdit(token); throw error; }
  } else if (token.camera) {
    try {
      let result;
      if (rangeCount > 1) {
        editor.cancelCameraDrag();
        const field =
          token.key === "camera_angle" ? "angle_rad" : token.key.slice(7);
        result = editor.setCameraValues(
          {
            [field]:
              token.key === "camera_scale"
                ? token.value / 100
                : token.key === "camera_angle"
                  ? radians(token.value)
                  : token.value,
          },
          token.indices,
        );
      } else result = editor.commitDrag();
      token.closed = true;
      active.delete(editor);
      return Boolean(result);
    } catch (error) {
      cancelNativePropertyEdit(token);
      throw error;
    }
  } else if (token.pose) {
    try {
      const result =
        rangeCount > 1
          ? commitNativePoseRange(token)
          : editor.commitDrag();
      token.closed = true;
      active.delete(editor);
      return result;
    } catch (error) {
      cancelNativePropertyEdit(token);
      throw error;
    }
  }
  const after = capture(rootFor(editor, token.scope, token.index), token.paths);
  if (JSON.stringify(token.before.entries) === JSON.stringify(after.entries)) {
    cancelNativePropertyEdit(token);
    return false;
  }
  if (token.key === "duration" && token.indices.length > 1) {
    const beforeRange = token.indices.map((index) => ({
      index,
      patch:
        index === token.frameIndex
          ? token.before
          : capture(editor.report.keyframes[index], token.paths),
    }));
    for (const index of token.indices)
      editor.report.keyframes[index].duration_raw = token.value;
    const afterRange = token.indices.map((index) => ({
      index,
      patch: capture(editor.report.keyframes[index], token.paths),
    }));
    editor._record({
      kind: "native-properties",
      scope: "frames-range",
      label: `${token.label} in ${token.indices.length} frames`,
      before: beforeRange,
      after: afterRange,
      beforeSelection: token.selection,
      afterSelection: editor._selectionState(),
      structural: false,
      timing: true,
    });
    token.closed = true;
    active.delete(editor);
    signal(token, false);
    return true;
  }
  token.closed = true;
  active.delete(editor);
  editor._record({
    kind: "native-properties",
    scope: token.scope,
    index: token.index,
    label: token.label,
    before: token.before,
    after,
    beforeSelection: token.selection,
    afterSelection: editor._selectionState(),
    structural: false,
    timing: token.timing,
    definition: token.definition,
  });
  signal(token, false);
  return true;
}
export function cancelNativePropertyEdit(token) {
  if (!token || token.closed) return false;
  const { editor } = token;
  token.closed = true;
  active.delete(editor);
  if (editor.report !== token.report) return false;
  if(token.sheetDuration)return true;
  if (token.scalar) return editor.cancelAnimationEdit();
  if (token.branchAnimation) return cancelBranchStyleAnimation(editor);
  if (token.pose || token.camera) {
    editor.cancelDrag();
    editor._restoreSelection(token.selection);
    editor._invalidate();
  } else {
    applyPatch(rootFor(editor, token.scope, token.index), token.before);
    editor._restoreSelection(token.selection);
    signal(token, false, [token.frameIndex]);
  }
  return true;
}
export const preview = previewNativePropertyEdit;
export const commit = commitNativePropertyEdit;
export const cancel = cancelNativePropertyEdit;
export const get = getNativePropertyValue;
