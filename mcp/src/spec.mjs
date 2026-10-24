// Compiles an animation spec (a cast and a list of keyframes) into a native
// StykAnimate document, using the app's own document factories so the result
// is the same data the editor creates and opens.
import {appModule} from './app-root.mjs';
import {JOINTS, POSES, lowestPoint, resolveAngles, segmentAngles} from './rig.mjs';

const {defaultFigure, createObject, createFrame, emptyDocument} = await appModule('src/demo.mjs');
const {validateScene} = await appModule('src/pivot/model.mjs');

export const EASINGS = Object.freeze({
  auto: {interpolation: 'auto'},
  linear: {interpolation: 'linear'},
  'ease-in': {interpolation: 'ease-in'},
  'ease-out': {interpolation: 'ease-out'},
  'ease-in-out': {interpolation: 'bezier', bezier: [0.42, 0, 0.58, 1]},
  constant: {interpolation: 'constant'},
});

export function parseColor(value, label = 'color') {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? ''));
  if (!match) throw new Error(`${label} must be a hex colour such as "#2b2b2b"`);
  const hex = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join('') : match[1];
  const rgb = Number.parseInt(hex, 16);
  return [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255];
}

const radians = degrees => degrees * Math.PI / 180;
const staticSegment = {aux_code: 1, flags: 256, is_static: true};
const segment = (length, angle, thickness, extra = {}) => ({
  segment_id: 1, parent_id: 0, length, angle_rad: angle, thickness, bend_rad: 0, primitive_code: 0, aux_code: 0,
  flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: [43, 43, 43], transparency: 0, visible: true, z_order: 1, ...extra,
});
const definition = (figure_type_id, name, segments) =>
  ({figure_type_id, name, segment_count: segments.length, segments, polyfills: [], image_assets: [], text_assets: []});

/** A figure definition for one cast member; text and file figures come from `external`. */
function castDefinition(member, typeId, external) {
  const color = parseColor(member.color ?? '#2b2b2b', `${member.id}.color`);
  switch (member.kind) {
    case 'stickman': {
      const figure = defaultFigure(typeId), thickness = member.thickness ?? 1, head = member.headColor ? parseColor(member.headColor, `${member.id}.headColor`) : color;
      figure.name = member.id;
      for (const part of figure.segments) {
        part.color_rgb = part.segment_id === 2 ? [...head] : [...color];
        part.thickness = Math.max(1, Math.round(part.thickness * thickness));
      }
      if (member.headFilled) Object.assign(figure.segments[1], {primitive_code: 3, flags: 3, segment_kind: 'circleFill', thickness: 0});
      return figure;
    }
    case 'line':
      return definition(typeId, member.id, [segment(member.length ?? 400, 0, member.thickness ?? 4, {...staticSegment, color_rgb: color})]);
    case 'circle': {
      const filled = member.filled ?? true, diameter = 2 * (member.radius ?? 30);
      return definition(typeId, member.id, [segment(diameter, -Math.PI / 2, filled ? 0 : member.thickness ?? 4, {
        ...staticSegment, color_rgb: color, primitive_code: filled ? 3 : 1, flags: filled ? 259 : 257,
        segment_type: 'circle', segment_kind: filled ? 'circleFill' : 'circle'})]);
    }
    case 'text': case 'file': {
      const figure = external.get(member.id)?.figure;
      if (!figure) throw new Error(`${member.id}: its ${member.kind} figure was not prepared`);
      return {...structuredClone(figure), figure_type_id: typeId, name: member.id};
    }
    default:
      throw new Error(`${member.id}: unknown kind "${member.kind}"`);
  }
}

/** Places one cast member for one keyframe from its accumulated state. */
function placeObject(member, figure, uid, state, anchor) {
  const object = createObject(figure, uid, state.x ?? 0, state.y ?? 0);
  object.scale = state.scale ?? 1;
  if (state.opacity !== undefined) object.field28 = Math.round((1 - Math.min(1, Math.max(0, state.opacity))) * 255);
  if (member.kind === 'stickman') {
    const angles = segmentAngles(figure, state.angles);
    object.angles = angles;
    if (state.ground !== undefined) object.root_y = state.ground - lowestPoint(figure, angles) * object.scale;
  } else {
    const turn = radians(state.rotate ?? 0);
    object.angles = figure.segments.map(part => (state.flip ? Math.PI - part.angle_rad : part.angle_rad) + turn);
    if (state.flip) object.image_text_flags = 1;
    // A circle's root is its bottom; the spec places its centre.
    if (member.kind === 'circle') object.root_y += figure.segments[0].length / 2 * object.scale;
    // A text's root is its bottom-left corner; the spec places its centre, which rotation turns around.
    if (anchor) {
      const ax = (state.flip ? -anchor.x : anchor.x) * object.scale, ay = anchor.y * object.scale;
      object.root_x += ax * Math.cos(turn) - ay * Math.sin(turn);
      object.root_y += ax * Math.sin(turn) + ay * Math.cos(turn);
    }
  }
  return object;
}

const PLACEMENT_KEYS = ['x', 'y', 'ground', 'scale', 'rotate', 'flip', 'opacity'];

/** The next state of a cast member: unspecified fields carry over from the previous keyframe. */
function nextState(member, previous, change) {
  const state = {...previous};
  for (const key of PLACEMENT_KEYS) if (change[key] !== undefined) state[key] = change[key];
  if (change.y !== undefined && change.ground === undefined) delete state.ground;
  if (change.ground !== undefined && change.y === undefined) delete state.y;
  if (member.kind === 'stickman' && (change.pose !== undefined || change.joints || change.lean || change.flip !== undefined || !previous.angles)) {
    const flip = state.flip ?? false;
    // A new pose starts from its library angles; joints alone adjust the previous pose.
    if (change.pose !== undefined || !previous.angles) state.angles = resolveAngles({pose: change.pose ?? 'stand', joints: change.joints, lean: change.lean, flip});
    else {
      const unflipped = previous.flip ? Object.fromEntries(JOINTS.map(joint => [joint, 180 - previous.angles[joint]])) : previous.angles;
      state.angles = resolveAngles({pose: null, joints: change.joints, lean: change.lean, flip}, unflipped);
    }
  }
  return state;
}

/**
 * Compiles a spec into a document. `external` maps a text or file cast id to {figure, anchor?}: its prepared
 * definition and, for text, the offset from the placed centre to the figure's root before scale.
 * Returns {document, ticks, seconds}.
 */
export function compileSpec(spec, external = new Map()) {
  const width = spec.width ?? 540, height = spec.height ?? 960, fps = spec.fps ?? 24;
  const cast = spec.cast ?? [];
  if (!cast.length) throw new Error('The cast is empty: add at least one figure');
  if (!spec.keyframes?.length) throw new Error('Add at least one keyframe');
  const ids = new Set();
  for (const member of cast) {
    if (!member.id || ids.has(member.id)) throw new Error(`Cast ids must be unique and non-empty (problem: "${member.id}")`);
    ids.add(member.id);
  }

  const document = emptyDocument();
  Object.assign(document, {canvas_width: width, canvas_height: height, fps});
  document._styk.name = spec.title ?? 'Untitled animation';
  document.figure_types = cast.map((member, index) => castDefinition(member, index + 1, external));
  const figures = new Map(cast.map((member, index) => [member.id, document.figure_types[index]]));
  const uids = new Map(cast.map((member, index) => [member.id, index + 1]));

  const backgrounds = new Map();
  const backgroundId = color => {
    const [r, g, b] = parseColor(color, 'background');
    const argb = (0xff000000 | r << 16 | g << 8 | b) >>> 0;
    if (!backgrounds.has(argb)) backgrounds.set(argb, {background_id: backgrounds.size + 1, kind: 2, color: argb, name: `Color ${color}`});
    return backgrounds.get(argb).background_id;
  };

  const states = new Map(), visible = new Set();
  let background = spec.background ?? '#ffffff', camera = null, ticks = 0;
  const frames = spec.keyframes.map((key, index) => {
    const hold = key.hold ?? 12;
    if (!Number.isInteger(hold) || hold < 1 || hold > 65535) throw new Error(`keyframes[${index}].hold must be a whole number of frames from 1 to 65535`);
    for (const [id, change] of Object.entries(key.figures ?? {})) {
      const member = cast.find(entry => entry.id === id);
      if (!member) throw new Error(`keyframes[${index}] names "${id}", which is not in the cast`);
      if (change.hide) { visible.delete(id); continue; }
      states.set(id, nextState(member, states.get(id) ?? {}, change));
      visible.add(id);
    }
    if (key.background) background = key.background;
    if (key.camera) camera = {...camera, ...key.camera};
    const objects = cast.filter(member => visible.has(member.id))
      .map(member => placeObject(member, figures.get(member.id), uids.get(member.id), states.get(member.id), external.get(member.id)?.anchor));
    const frame = createFrame(objects, hold);
    const easing = EASINGS[key.ease ?? spec.ease ?? 'auto'];
    if (!easing) throw new Error(`keyframes[${index}].ease must be one of ${Object.keys(EASINGS).join(', ')}`);
    frame._styk = {easing: structuredClone(easing)};
    frame.background_id = backgroundId(background);
    if (camera) frame.camera = {is_default: false, x: (camera.x ?? width / 2) - width / 2, y: (camera.y ?? height / 2) - height / 2,
      scale: 1 / (camera.zoom ?? 1), angle_rad: radians(camera.rotate ?? 0)};
    ticks += hold;
    return frame;
  });
  // The last keyframe holds for its own length: a closing copy marks where it ends.
  const closing = structuredClone(frames.at(-1));
  closing.duration_raw = 1; closing._styk = {easing: {interpolation: 'constant'}};
  frames.push(closing);
  document.keyframes = frames;
  document.backgrounds = [...backgrounds.values()];
  validateScene(document);
  return {document, ticks, seconds: ticks / fps};
}

export const poseNames = () => Object.keys(POSES);
