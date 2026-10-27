import {messageError} from './localized-error.mjs';
/** Small native-field gestures. Authored transform channels use editor-animation.
 *
 * Every gesture here is a session call or a gesture of the session's: the animation edit of a property channel (of one target, or
 * of the several of a branch's style or a draw order), a pose or camera gesture (a pose at one value in several frames is the
 * session's `setPoseProperty`), the project's fields and the sheet's duration. What this module used to write into the document
 * itself, to record it as an entry of the editor's own (the definition of a figure), is the engine's alone now, and refused where
 * the session has no command for it. */
import { objectBounds } from "./renderer-geometry.mjs";
import { cameraValues } from "./pivot/model.mjs";
import { animationStyleValue, polygonIdentity, resolveInstanceFigure } from "./animation-style.mjs";
import { builderStyleProperty, builderOrderTargets, builderOrderValues } from './editor-builder-style.mjs';
import { branchOpacityPlan } from './editor-branch-style.mjs';

const active = new WeakMap();
const poseKeys = new Set([
  "root_x",
  "root_y",
  "scale",
  "rotation",
  "figure_opacity",
  "figure_z_order",
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
  figure_z_order: "Z-index",
  figure_opacity: "Figure opacity",
};
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
        ...(geometry.meshDrawables ?? []),
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
    ["root_x", "root_y", "scale", "rotation", "figure_opacity", "figure_z_order"].includes(key)
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
  if (key === "figure_z_order") return object._stykZIndex ?? 0;
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
    throw messageError(new Error(''), "errors.nativePropertyEdit.enterAFiniteNumberWithinTheNativeRange", {});
  if (/^polygon_\d+_opacity$/.test(key) && (value < 0 || value > 100))
    throw messageError(new Error(''), "errors.editorBuilderStyle.polygonOpacityMustBeFrom0To100", {});
  const integer = ["fps", "canvas_width", "canvas_height", "duration", "figure_z_order"].includes(
    key,
  );
  const min =
    key === "figure_z_order"
      ? -1000000
      : key === "duration"
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
    key === "figure_z_order"
      ? 1000000
      : key === "fps"
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
    throw messageError(new Error(''), "errors.nativePropertyEdit.enterAWholeNumber", {});
  if (value < min || value > max)
    throw messageError(new Error(''), "errors.nativePropertyEdit.enterAValueFromTo", {min: min, max: max});
  return value;
}
const refused = () => messageError(new Error(''), "errors.engineOwner.notSupported", {});
function assertCurrent(token, {preview = false} = {}) {
  if (!token || token.closed || active.get(token.editor) !== token)
    throw messageError(new Error(''), "errors.nativePropertyEdit.thisPropertyGestureHasEnded", {});
  const editor = token.editor;
  if (
    editor.report !== token.report ||
    editor.frameIndex !== token.frameIndex ||
    (token.pose && (editor.selectedUid !== token.uid || editor.selectedJoint !== token.joint))
  ) {
    cancelNativePropertyEdit(token);
    throw messageError(new Error(''), "errors.nativePropertyEdit.theSelectedPropertyChangedDuringTheGesture", {});
  }
  // A branch or a draw order previews the frame it began on, and is keyed at the tick it began on when it ends.
  if (preview && (token.branchAnimation || token.orderAnimation) && editor.tick !== token.tick) {
    cancelNativePropertyEdit(token);
    throw messageError(new Error(''), "errors.editorBranchStyle.theBranchEditTargetChanged", {});
  }
}
/** The project's own fields: shown as typed, one command of the session when the edit ends. */
const projectKeys = new Set(["fps", "canvas_width", "canvas_height"]);
export function beginNativePropertyEdit(
  editor,
  key,
  { bounds, indices, rangeMode = "absolute", branch = false } = {},
) {
  if (!canEditNativeProperty(editor, key))
    throw messageError(new Error(''), "errors.nativePropertyEdit.selectThePropertyBeforeEditingIt", {});
  if (active.has(editor)) cancelNativePropertyEdit(active.get(editor));
  if (editor._animationEdit) editor.commitAnimationEdit();
  if (editor.dragging) editor.commitDrag();
  const sheet = Boolean(editor.report._styk?.layerSheet);
  const begun = fields => {
    const token = {
      editor, key, report: editor.report, frameIndex: editor.frameIndex, tick: editor.tick, uid: editor.selectedUid, joint: editor.selectedJoint,
      selection: editor._selectionState(), closed: false, ...fields,
    };
    active.set(editor, token);
    return token;
  };
  if (key === 'duration' && sheet) {
    const span = editor.sheetSpan(), value = span.end - span.start;
    return begun({sheetDuration: true, layerId: editor.activeLayerId, tick: editor.tick, value, initialValue: value});
  }
  if (projectKeys.has(key)) {
    const value = getNativePropertyValue(editor, key);
    return begun({project: true, label: names[key] ?? key, value, initialValue: value});
  }
  const label = names[key] ?? key.replaceAll("_", " ");
  const builder = builderStyleProperty(editor, key, {branch});
  const branchPlan = branch ? branchOpacityPlan(editor, key) : null;
  const pose = poseKeys.has(key), camera = cameraKeys.has(key);
  const value = getNativePropertyValue(editor, key, { bounds: key.startsWith("group_") ? { ...boundsOfSelection(editor, bounds) } : null });
  if (!Number.isFinite(value))
    throw messageError(new Error(''), "errors.nativePropertyEdit.theSelectedPropertyHasNoFiniteValue", {});
  const sheetTicks = sheet ? editor.sheetEditTimes(indices ?? [editor.frameIndex]) : null;
  const frames = editor._frameIndices(indices?.length ? [...indices, editor.frameIndex] : [editor.frameIndex]);
  if (sheetTicks) frames.sheetTicks = sheetTicks;
  const common = {label: builder?.label ?? (branchPlan ? `Branch ${key === 'thickness' ? 'thickness' : branchPlan.property === 'opacity' ? 'opacity' : 'gradient opacity'}` : label),
    builder, pose, camera, sheetTicks, indices: frames, rangeMode, value, initialValue: value, bounds: null};
  if (builder?.animated) {
    // The draw order of the figure on show: one edit of every drawable's position.
    const targets = builderOrderTargets(editor, builder);
    editor.beginAnimationEdit(targets, 'zIndex', {exactTarget: true});
    return begun({...common, orderAnimation: {targets, values: null}});
  }
  const scalar = editor.propertyChannels && !branchPlan ? styleBinding(editor, key) : null;
  if (scalar) {
    editor.beginAnimationEdit(scalar.target, scalar.property);
    return begun({...common, scalar, factor: ['thickness', 'outlineWidth'].includes(scalar.property) ? 1 : 100});
  }
  if (branchPlan?.authored) {
    // The branch's segments (and enclosed polygons): one edit of the property on all of them.
    const targets = branchPlan.entries.map(entry => entry.target);
    editor.beginAnimationEdit(targets, branchPlan.property, {exactTarget: true});
    return begun({...common, branchAnimation: {targets, property: branchPlan.property}});
  }
  if (camera) {
    if (!editor.beginCameraDrag({ label: common.label }))
      throw messageError(new Error(''), "errors.nativePropertyEdit.chooseACameraFrame", {});
    return begun(common);
  }
  if (pose) {
    // With several frames chosen the gesture shows the frame on show, and the value is set in every chosen frame when it ends.
    if (!editor.beginDrag(common.label, { scope: key.startsWith("group_") || key === "root_x" || key === "root_y" ? "translation" : "selection" }))
      throw messageError(new Error(''), "errors.nativePropertyEdit.chooseAFigureFirst", {});
    return begun(common);
  }
  // The definition of a figure and the fields of a frame are edited by the engine's commands, never in place.
  throw refused();
}
export function previewNativePropertyEdit(token, value) {
  assertCurrent(token, {preview: true});
  validate(token.key, value);
  if (token.sheetDuration || token.project) { token.value = value; return true; }
  if (token.value === value && (!token.branchAnimation || token.branchAnimation.applied)) return false;
  const { editor, key } = token;
  if (token.orderAnimation) {
    // Every drawable takes the position the move gives it.
    const values = builderOrderValues(token.builder, value);
    editor.previewAnimationEdit(values);
    token.orderAnimation.values = values;
  } else if (token.scalar) {
    editor.previewAnimationEdit(value / token.factor);
  } else if (token.branchAnimation) {
    // A value the selected segment already has still sets the others of the branch.
    editor.previewAnimationEdit(value / (key === 'thickness' ? 1 : 100));
    token.branchAnimation.applied = true;
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
  } else if (["group_x", "group_y", "root_x", "root_y"].includes(key))
    editor.moveSelection(
      key.endsWith("_x") ? value - token.initialValue : 0,
      key.endsWith("_y") ? value - token.initialValue : 0,
      { fromStart: true },
    );
  else if (key === "scale") editor.updateObject({ scale: value / 100 });
  else if (key === "rotation")
    editor.rotateFigure(radians(value - getNativePropertyValue(editor, key)));
  else if (key === "figure_opacity") editor.updateObject({ field28: Math.round((1 - value / 100) * 255) });
  // A stacking number of zero is the figure without one.
  else if (key === "figure_z_order") editor.updateObject({ _stykZIndex: value || undefined });
  else if (key === "group_width" || key === "group_height") {
    if (token.initialValue <= 0)
      throw messageError(new Error(''), "errors.nativePropertyEdit.increaseTheSelectionSizeBeforeScaling", {});
    // The size is applied when the edit ends (a scale is relative to the figures as they are): nothing shows meanwhile.
  } else if (key.startsWith("joint_"))
    editor.updateSegment(
      key === "joint_angle"
        ? { angle_rad: radians(value) }
        : key === "joint_length"
          ? { length: value }
          : { bend_rad: radians(value) },
    );
  else throw refused();
  token.value = value;
  return true;
}
export function commitNativePropertyEdit(token) {
  assertCurrent(token);
  validate(token.key, token.value);
  if (token.value === token.initialValue && !token.branchAnimation) {
    cancelNativePropertyEdit(token);
    return false;
  }
  const { editor } = token;
  const rangeCount = token.sheetTicks?.length ?? token.indices?.length;
  const rangeTimes = () => token.sheetTicks ?? token.indices.map(index => editor.timeline[index].start);
  const finish = run => {
    try {
      const result = run();
      token.closed = true; active.delete(editor);
      return result;
    } catch (error) { cancelNativePropertyEdit(token); throw error; }
  };
  if (token.sheetDuration) { token.closed = true; active.delete(editor); return editor.sheetSetDuration(token.value, token.layerId, token.tick); }
  if (token.project) {
    token.closed = true; active.delete(editor);
    const options = { label: token.label };
    return token.key === 'fps' ? editor.setFPS(token.value, options) : editor.updateProject({ [token.key]: token.value }, options);
  }
  if (token.orderAnimation) {
    return finish(() => {
      if (rangeCount > 1) {
        const { targets, values } = token.orderAnimation;
        const entries = rangeTimes().flatMap(tick => targets.map((target, index) => ({target, property: 'zIndex', tick, value: values[index], exactTarget: true, interpolation: 'constant'})));
        editor.cancelAnimationEdit();
        return editor.addAnimationKeys(entries);
      }
      return editor.commitAnimationEdit();
    });
  }
  if (token.scalar) {
    let result;
    if (rangeCount > 1) { editor.cancelAnimationEdit(); result = editor.addAnimationKeys(rangeTimes().map(tick => ({...token.scalar, tick, value: token.value / token.factor}))); }
    else result = editor.commitAnimationEdit();
    token.closed = true; active.delete(editor); return result;
  }
  if (token.branchAnimation) {
    return finish(() => {
      if (rangeCount > 1) {
        const { targets, property } = token.branchAnimation;
        const entries = rangeTimes().flatMap(tick => targets.map(target => ({target, property, tick, value: token.value / (token.key === 'thickness' ? 1 : 100)})));
        editor.cancelAnimationEdit();
        return editor.addAnimationKeys(entries);
      }
      return editor.commitAnimationEdit();
    });
  }
  if (token.camera) {
    return finish(() => {
      if (rangeCount > 1) {
        editor.cancelCameraDrag();
        const field = token.key === "camera_angle" ? "angle_rad" : token.key.slice(7);
        return Boolean(editor.setCameraValues(
          { [field]: token.key === "camera_scale" ? token.value / 100 : token.key === "camera_angle" ? radians(token.value) : token.value },
          token.indices,
        ));
      }
      return Boolean(editor.commitDrag());
    });
  }
  if (token.pose && rangeCount > 1) {
    // The preview was the frame on show: the value is set in every chosen frame, from where each one stands, as one entry.
    return finish(() => {
      editor.cancelDrag();
      return editor.setPoseProperty(token.key, token.value, token.indices, { label: token.label }).changedFrames > 0;
    });
  }
  if (token.key === "group_width" || token.key === "group_height") {
    return finish(() => { editor.cancelDrag(); return editor.scaleSelection(token.value / token.initialValue, { label: token.label }); });
  }
  return finish(() => editor.commitDrag());
}
export function cancelNativePropertyEdit(token) {
  if (!token || token.closed) return false;
  const { editor } = token;
  token.closed = true;
  active.delete(editor);
  if (editor.report !== token.report) return false;
  if (token.sheetDuration || token.project) return true;
  if (token.scalar || token.orderAnimation || token.branchAnimation) return editor.cancelAnimationEdit();
  editor.cancelDrag();
  editor._restoreSelection(token.selection);
  editor._invalidate();
  return true;
}
export const preview = previewNativePropertyEdit;
export const commit = commitNativePropertyEdit;
export const cancel = cancelNativePropertyEdit;
export const get = getNativePropertyValue;
