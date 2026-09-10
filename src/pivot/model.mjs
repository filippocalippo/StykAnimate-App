import {validateSticknodesShape,validateSticknodesObject} from '../sticknodes/validation.mjs';
import {normalizePaint} from '../paint.mjs';
import {validatePlayback} from '../movieclips.mjs';
import {validateIK} from '../ik.mjs';
import { timeline } from "./geometry.mjs";
import { inverseCameraScale } from "./background.mjs";
import { validateAnimationStyle } from '../animation-style.mjs';
import {validateFigureZIndex} from '../animation-properties.mjs';
import {validateOriginObject,validateOriginObjectSteps,validateOriginSupportSteps} from '../animation-origin-validation.mjs';
export const MAX_EXPORT_PIXELS = 64 * 1024 * 1024;
const finite = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number.`);
};
export function roundEven(value) {
  const floor = Math.floor(value),
    fraction = value - floor;
  return fraction < 0.5
    ? floor
    : fraction > 0.5
      ? floor + 1
      : floor + Math.abs(floor % 2);
}
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
};
const float32 = (value, label) => {
  finite(value, label);
  if (!Number.isFinite(Math.fround(value)))
    throw new Error(`${label} exceeds the native float32 range.`);
};
const rgb = (value, label) => {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error(`${label} needs three RGB bytes.`);
  for (const n of value) integer(n, 0, 255, label);
};
// Populated only by successful definition validation. Editor topology/style
// commands validate their replacement definitions before the next object edit.
const validatedDefinitions = new WeakMap();
function validateObjectPose(report, object, figure, origin = true) {
  if(object._sticknodesShapes||object._sticknodesSprite)validateSticknodesObject(object,figure);
  validateIK(object);
  validateAnimationStyle(object);
  if (object._stykZIndex !== undefined) validateFigureZIndex(object._stykZIndex);
  if(origin&&(object._stykAnimationOrigin!==undefined||figure._styk?.animationOrigin))validateOriginObject(object,figure);
  for (const key of ['root_x', 'root_y', 'scale']) float32(object[key], `Object ${key}`);
  integer(object.unique_id, 0, 0xffffffff, 'Object identity');
  if (object.color_override_raw !== undefined)
    integer(object.color_override_raw, report.version < 5 ? -0x80000000 : 0, 0xffffffff, 'Figure color');
  if (object.field28 !== undefined) integer(object.field28, 0, 255, 'Figure transparency');
  if (object.scale < 0) throw new Error('Object scale cannot be negative.');
  for (const [flag, key] of [[true, 'angles'], [object.len_flag, 'lengths'], [object.bend_flag, 'bends']]) if (flag) {
    if (!Array.isArray(object[key]) || object[key].length !== figure.segments.length)
      throw new Error('Pose array does not match its figure.');
    for (const value of object[key]) (key === 'lengths' ? float32 : finite)(value, key);
  }
}

/** Validate an object gesture against already validated, unchanged definitions.
 * All changed numeric channels, identities, target handles and ancestry cycles
 * are checked. Unrelated poses, backgrounds and library geometry are untouched.
 */
export function validateObjectChanges(report, frame, changedUids) {
  const types = new Map(), metadata = new Map();
  for (const figure of report.figure_types) {
    if (types.has(figure.figure_type_id)) throw new Error('Invalid or repeated figure type.');
    types.set(figure.figure_type_id, figure);
  }
  const definition = typeId => {
    const figure = types.get(typeId);
    if (!figure) throw new Error('Unknown figure or repeated object identity.');
    let cached = validatedDefinitions.get(figure);
    if (!cached || cached.segments !== figure.segments || cached.count !== figure.segments.length ||
        cached.origin!==figure._styk?.animationOrigin || cached.support!==figure._styk?.animationOrigin?.support) {
      validateScene({...report, figure_types: [figure], backgrounds: [], keyframes: [{objects: [], duration_raw: 1}]});
      cached = validatedDefinitions.get(figure);
    }
    metadata.set(typeId, cached); return figure;
  };
  const changed = new Set(changedUids), identities = new Set(), slots = [];
  frame.objects.forEach((object, slot) => {
    if (identities.has(object.unique_id)) throw new Error('Unknown figure or repeated object identity.');
    identities.add(object.unique_id);
    if (changed.has(object.unique_id)) slots.push(slot);
  });
  if (slots.length !== changed.size) throw new Error('A gesture cannot change figure identities.');
  for (const slot of slots) validateObjectPose(report, frame.objects[slot], definition(frame.objects[slot].figure_type_id));
  const finished = new Set();
  for (const initial of slots) {
    let slot = initial; const chain = new Set();
    while (!finished.has(slot)) {
      if (chain.has(slot)) throw new Error('Figures contain a cyclic join.');
      chain.add(slot); const object = frame.objects[slot];
      if (!object?.join) break;
      const targetSlot = object.join.target_object_slot, parent = frame.objects[targetSlot];
      if (!Number.isInteger(targetSlot) || !parent) throw new Error('Join points to a missing figure or handle.');
      const figure = definition(parent.figure_type_id);
      if (!metadata.get(figure.figure_type_id).handles.has(object.join.target_handle_id))
        throw new Error('Join points to a missing figure or handle.');
      slot = targetSlot;
    }
    for (const slot of chain) finished.add(slot);
  }
  return frame;
}
function styleValues(s) {
  if(s.z_order!==undefined)float32(s.z_order,'Segment drawing order');
  if (s.bend_rad !== undefined) finite(s.bend_rad, "Segment bend");
  if (s.color_rgb !== undefined) rgb(s.color_rgb, "Segment color");
  if (s.transparency !== undefined)
    integer(s.transparency, 0, 255, "Segment transparency");
  if (s.secondary) {
    rgb(s.secondary.rgb, "Gradient color");
    integer(s.secondary.a, 0, 255, "Gradient transparency");
  }
  if (s.aux_code !== undefined) integer(s.aux_code, 0, 255, "Segment flags");
  if (s.primitive_code !== undefined)
    integer(s.primitive_code, 0, 6, "Segment shape");
}
export function validateScene(report) {
  const iterator = validateSceneSteps(report, {sliceMs:Infinity});
  let step; do {step=iterator.next();} while (!step.done);
  return step.value;
}
/** The same authoritative checks as synchronous validation, with cooperative
 * checkpoints for large imports. Cancelling iteration never publishes a scene. */
export function* validateSceneSteps(report, {sliceMs=4} = {}) {
  let lastYield=performance.now(), work=0;
  const due=()=>++work%128===0 && performance.now()-lastYield>=sliceMs;
  const progress=stage=>{lastYield=performance.now();return {phase:'validation',stage,objects:totalObjects,segments:totalSegments};};
  if (
    !report ||
    typeof report !== "object" ||
    ![2, 3, 4, 5].includes(report.version)
  )
    throw new Error("Expected a decoded Pivot 2–5 scene.");
  for (const key of ["canvas_width", "canvas_height"])
    if (
      !Number.isInteger(report[key]) ||
      report[key] < 1 ||
      report[key] > 100000
    )
      throw new Error("Canvas dimensions must be integers from 1 to 100,000.");
  integer(report.fps, 1, 1000, "FPS");
  if (report.frame_delay_ms != null)
    integer(report.frame_delay_ms, 1, 65535, "Frame delay");
  if (report.fps < 1 || report.fps > 1000)
    throw new Error("FPS must be between 1 and 1,000.");
  if (
    !Array.isArray(report.figure_types) ||
    report.figure_types.length > 65535 ||
    !Array.isArray(report.keyframes) ||
    !report.keyframes.length ||
    report.keyframes.length > 100000
  )
    throw new Error(
      "Scene must have a valid figure table and 1–100,000 keyframes.",
    );
  const types = new Map(), typeHandles = new Map();
  let totalSegments = 0,
    totalObjects = 0;
  for (const fig of report.figure_types) {
    if (
      !Number.isInteger(fig.figure_type_id) ||
      types.has(fig.figure_type_id) ||
      !Array.isArray(fig.segments)
    )
      throw new Error("Invalid or repeated figure type.");
    types.set(fig.figure_type_id, fig);
    if (fig.segments.length > 30000)
      throw new Error('A native Pivot figure supports at most 30,000 segments.');
    totalSegments += fig.segments.length;
    if (totalSegments > 1000000)
      throw new Error("Figure table exceeds the one-million-segment limit.");
    const parents = new Map();
    for (const s of fig.segments) {
      if(s.paint)normalizePaint(s.paint);
      if(s._sticknodes)validateSticknodesShape(s._sticknodes);
      if (
        !Number.isInteger(s.segment_id) ||
        s.segment_id <= 0 ||
        s.segment_id > 65535 ||
        parents.has(s.segment_id)
      )
        throw new Error("Invalid or repeated segment handle.");
      parents.set(s.segment_id, s.parent_id);
      for (const k of ["length", "angle_rad", "thickness"])
        (k === "angle_rad" ? finite : float32)(s[k], `Segment ${k}`);
      styleValues(s);
      if (due()) yield progress('figures');
    }
    const done = new Set([0]);
    for (const id of parents.keys()) {
      if (done.has(id)) continue;
      const seen = new Set();
      let p = id;
      while (!done.has(p)) {
        if (!parents.has(p) || seen.has(p))
          throw new Error("Figure has a missing parent or a cycle.");
        seen.add(p);
        p = parents.get(p);
        if (due()) yield progress('figures');
      }
      for (const p of seen) done.add(p);
    }
    typeHandles.set(fig.figure_type_id, new Set([0, ...parents.keys()]));
    if(fig._styk?.animationOrigin!==undefined)yield* validateOriginSupportSteps(fig,fig._styk.animationOrigin,{sliceMs});
  }
  for (const frame of report.keyframes) {
    if (
      !frame ||
      !Array.isArray(frame.objects) ||
      !Number.isInteger(frame.duration_raw) ||
      frame.duration_raw < 0 ||
      frame.duration_raw > 65535
    )
      throw new Error("Invalid keyframe objects or duration.");
    totalObjects += frame.objects.length;
    if (totalObjects > 2000000)
      throw new Error("Scene exceeds the two-million-object limit.");
    const uids = new Set();
    for (const o of frame.objects) {
      const fig = types.get(o.figure_type_id);
      if (!fig || !Number.isInteger(o.unique_id) || uids.has(o.unique_id))
        throw new Error("Unknown figure or repeated object identity.");
      uids.add(o.unique_id);
      validateObjectPose(report, o, fig, false);
      if (o._stykMovieclip) validatePlayback(o._stykMovieclip);
      if(o._stykAnimationOrigin!==undefined||fig._styk?.animationOrigin)yield* validateOriginObjectSteps(o,fig,{sliceMs});
      if (o.join) {
        const parent = frame.objects[o.join.target_object_slot],
          target = types.get(parent?.figure_type_id);
        if (
          !target ||
          !typeHandles.get(target.figure_type_id).has(o.join.target_handle_id)
        )
          throw new Error("Join points to a missing figure or handle.");
      }
      if (due()) yield progress('poses');
    }
    const finished = new Set();
    for (let i = 0; i < frame.objects.length; i++) {
      if (finished.has(i)) continue;
      let slot = i;
      const chain = new Set();
      while (!finished.has(slot)) {
        if (chain.has(slot)) throw new Error("Figures contain a cyclic join.");
        chain.add(slot);
        const join = frame.objects[slot].join;
        if (!join) break;
        slot = join.target_object_slot;
        if (due()) yield progress('joins');
      }
      for (const slot of chain) finished.add(slot);
    }
    if (frame.object_draw_order) {
      const order = frame.object_draw_order;
      if (
        order.length !== frame.objects.length ||
        new Set(order).size !== order.length ||
        order.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= frame.objects.length,
        )
      )
        throw new Error("Invalid figure layer order.");
    }
    if (frame.camera && !frame.camera.is_default) {
      for (const k of ["x", "y", "scale"])
        float32(frame.camera[k], `Camera ${k}`);
      if (frame.camera.scale <= 0)
        throw new Error("Camera scale must be positive.");
      inverseCameraScale(frame.camera);
      if (frame.camera.angle_rad !== undefined)
        finite(frame.camera.angle_rad, "Camera angle");
    }
    if (due()) yield progress('frames');
  }
  for (const fig of report.figure_types) {
    const style = fig.segment_decode?.global_style;
    if (style) {
      if (style.outline_thickness !== undefined) {
        float32(style.outline_thickness, "Outline width");
        if (style.outline_thickness < 0)
          throw new Error("Outline width cannot be negative.");
      }
      if (style.u28 !== undefined) {
        integer(style.u28, 0, 0xffffffff, "Outline bits");
        const width = new Float32Array(new Uint32Array([style.u28]).buffer)[0];
        if (!Number.isFinite(width) || width < 0)
          throw new Error("Invalid outline width.");
      }
      if (style.rgb) rgb(style.rgb, "Outline color");
      if (style.u30 !== undefined)
        integer(style.u30, 0, 255, "Outline transparency");
    }
    for (const poly of fig.polyfills || []) {
      if(poly.z_order!==undefined)float32(poly.z_order,'Polygon drawing order');
      if(poly.color_alpha!==undefined){finite(poly.color_alpha,'Polygon opacity');if(poly.color_alpha<0||poly.color_alpha>1)throw new Error('Polygon opacity must be between zero and one.');}
      if (poly.color_rgb) rgb(poly.color_rgb, "Polygon color");
      if (poly.alpha_raw !== undefined)
        integer(poly.alpha_raw, 0, 255, "Polygon transparency");
      if (due()) yield progress('styles');
    }
    if (due()) yield progress('styles');
  }
  const backgrounds = new Set([0]);
  for (const bg of report.backgrounds || []) {
    if(bg.paint)normalizePaint(bg.paint);
    if (
      !Number.isInteger(bg.background_id) ||
      bg.background_id < 1 ||
      backgrounds.has(bg.background_id)
    )
      throw new Error("Invalid or repeated background ID.");
    backgrounds.add(bg.background_id);
    if (bg.kind === 2) integer(bg.color, 0, 0xffffffff, "Background color");
    if ([3, 4].includes(bg.kind)) {
      integer(bg.color_a, 0, 0xffffffff, "Background color A");
      integer(bg.color_b, 0, 0xffffffff, "Background color B");
      for (const key of ["x1", "y1", "x2", "y2"])
        float32(bg[key], "Gradient " + key);
      if (bg.kind === 4 && (bg.x2 < 0 || bg.y2 < 0))
        throw new Error("Radial background radii cannot be negative.");
    }
    if (due()) yield progress('backgrounds');
  }
  for (const f of report.keyframes) {
    if (
      !backgrounds.has(f.background_id ?? 0) ||
      (f.background_mix && !backgrounds.has(f.background_id_b ?? 0))
    )
      throw new Error("Frame references a missing background.");
    if (f.background_mix !== undefined)
      integer(f.background_mix, 0, 255, "Background mix");
    if (due()) yield progress('background references');
  }
  for (const figure of report.figure_types) validatedDefinitions.set(figure,
    {segments: figure.segments, count: figure.segments.length, handles: typeHandles.get(figure.figure_type_id),origin:figure._styk?.animationOrigin,support:figure._styk?.animationOrigin?.support});
  return report;
}
export function syncDerived(report) {
  const segmentColorTypes = new Set(report.figure_types.filter(fig => fig._styk?.colorMode === 'segments').map(fig => fig.figure_type_id));
  if (report.auto_easing_source === "application_default")
    report.auto_easing_disabled_raw = null;
  for (const fig of report.figure_types || []) {
    fig.segment_count = fig.segments.length;
    for (const s of fig.segments) {
      if(s.paint)normalizePaint(s.paint);
      if(s._sticknodes)validateSticknodesShape(s._sticknodes);
      if (s.primitive_code !== undefined && s.aux_code !== undefined) {
        s.flags = s.primitive_code | (s.aux_code << 8);
        s.is_static = Boolean(s.aux_code & 1);
        s.flag_bits = { ...s.flag_bits, is_static: s.is_static };
        for (const [key, value] of [
          ["raw", s.flags],
          ["low_byte", s.primitive_code],
          ["high_byte", s.aux_code],
          [
            "set_bits",
            Array.from({ length: 16 }, (_, i) => i).filter(
              (i) => s.flags & (1 << i),
            ),
          ],
        ])
          if (key in s.flag_bits) s.flag_bits[key] = value;
        s.segment_kind = {
          0: "line",
          1: "circle",
          2: "image",
          3: "circleFill",
          4: "circleClear",
          5: "text",
          6: "squareLine",
        }[s.primitive_code];
        s.segment_type = [1, 3, 4].includes(s.primitive_code)
          ? "circle"
          : s.primitive_code === 2
            ? "image"
            : s.primitive_code === 5
              ? "text"
              : "line";
        s.visible =
          s.thickness > 0.01 || [1, 2, 3, 4, 5, 6].includes(s.primitive_code);
      }
    }
  }
  if (report.version < 5 && report.frame_delay_ms)
    report.fps = roundEven(1000 / report.frame_delay_ms);
  if (
    report.auto_easing !== undefined &&
    report.auto_easing_source !== "application_default"
  )
    report.auto_easing_disabled_raw = report.auto_easing ? 0 : 1;
  const times = timeline(report);
  report.total_output_frames = times.reduce((sum, t) => sum + t.count, 0);
  report.duration_seconds = report.total_output_frames / report.fps;
  for (const f of report.keyframes) {
    f.inbetweens = report.version >= 5 ? f.duration_raw - 1 : 0;
    f.hidden = f.duration_raw === 0;
    if (report.version < 5) f.duration_frames = f.duration_raw;
    for (const o of f.objects) {
      const raw = Number(o.color_override_raw) >>> 0;
      o.color_override_rgb =
        report.version < 5 && !segmentColorTypes.has(o.figure_type_id) && (raw | 0) < 0
          ? [0, 0, 0]
          : [raw & 255, (raw >>> 8) & 255, (raw >>> 16) & 255];
      if (report.version >= 5 || segmentColorTypes.has(o.figure_type_id)) o.color_override_mix = raw >>> 24;
      o.transparency = Number(o.field28 ?? 0);
      o.opacity = 1 - o.transparency / 255;
    }
  }
}
export function validateRaster(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_EXPORT_PIXELS
  )
    throw new Error("PNG export is limited to 64 megapixels.");
}
