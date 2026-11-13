/**
 * The feature workloads (docs/PERFORMANCE.md "Workloads"): the busy scene of `medium` with one of the app's heavier
 * features added, so every scenario can be run on it and its cost compared with plain `medium`. perf/workloads.mjs
 * builds the plain document and hands it here with the workload's spec; each feature changes it in place.
 *
 * Every feature is written as the app's JSON, not authored through the app: a `.json` file opens through the native
 * project path, which keeps every `_styk` field (docs/engine/document.md "No silent loss"), so effects, movieclips,
 * layers and cameras survive as written, and a recipe of app commands would only be a slower way to the same bytes.
 * Like the plain workloads, a feature is deterministic: the same spec gives the same bytes on every machine (what is
 * random comes from the seeded generator perf/workloads.mjs hands in as `next`).
 */
import {deflateSync, crc32} from 'node:zlib';
import {movieclipFigure} from '../src/movieclips.mjs';

const fixed = value => Math.round(value * 1000) / 1000;
/** A stable id of the form the app writes for effects and clips (a version 4 UUID), numbered. */
const uuid = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const rgbInt = ([r, g, b]) => (r << 16) | (g << 8) | b;

// --- Pictures -------------------------------------------------------------------------------------------------------

/** An RGBA picture as PNG bytes: filter 0 on every row, one IDAT, no ancillary chunks. */
export function png(width, height, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), length = Buffer.alloc(4), check = Buffer.alloc(4);
    length.writeUInt32BE(data.length); check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, {level: 6})), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Picture `index` of `size`² pixels: a round shape in the colour `rgb`, shaded from its middle, with bands and a little
 * grain so that it neither compresses to nothing nor to noise (a drawn sprite), transparent outside the shape.
 */
function picture(size, rgb, index, next) {
  const pixels = new Uint8Array(size * size * 4), centre = size / 2, radius = size * .46, bands = 3 + index % 5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre, dy = y - centre, distance = Math.hypot(dx, dy) / radius;
      if (distance > 1) continue;
      const shade = 1.15 - distance * .55, band = Math.sin((Math.atan2(dy, dx) + distance * 2) * bands) > .6 ? .75 : 1, grain = (next() - .5) * 10;
      const at = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[at + channel] = Math.max(0, Math.min(255, Math.round(rgb[channel] * shade * band + 40 * (1 - distance) + grain)));
      // The edge fades over the last few pixels, so the shape is drawn smooth at any scale.
      pixels[at + 3] = Math.round(255 * Math.min(1, (1 - distance) * radius / 3));
    }
  }
  return png(size, size, pixels);
}

/**
 * `sprites`: the last two segments of every limb are pictures (the head included), each figure type with its own set
 * of `pictures / types` pictures of `pictureSize`² pixels. A picture is drawn 3.3 times its segment's length, centred
 * on it, as a sprite drawn over a rig is.
 */
function sprites(document, spec, next) {
  const types = document.figure_types, perType = Math.ceil(spec.pictures / types.length), size = spec.pictureSize;
  types.forEach((type, typeIndex) => {
    const colour = type.segments[0].color_rgb;
    type.image_assets = Array.from({length: perType}, (_, index) => ({
      kind: 'image', asset_index: index, table_index: index, mime_type: 'image/png', width: size, height: size,
      data_url: `data:image/png;base64,${picture(size, colour.map((value, channel) => (value + (index * 47 + channel * 31) % 120) % 256), typeIndex * perType + index, next).toString('base64')}`,
      anchor_start: {x: size * .35, y: size / 2}, anchor_end: {x: size * .65, y: size / 2}, anchor_length: size * .3, anchor_angle_rad: 0,
    }));
    let slot = 0;
    for (const segment of type.segments) {
      const inChain = (segment.segment_id - 1) % spec.chain;
      if (inChain < spec.chain - 2) continue;
      const asset = slot++ % perType;
      Object.assign(segment, {primitive_code: 2, aux_code: 0, flags: 2, segment_type: 'image', segment_kind: 'image', extra_u16: asset, extra_u8_a: 0, extra_u8_b: 0, extra: [asset, 0, 0]});
    }
  });
}

// --- Effects --------------------------------------------------------------------------------------------------------

/** The effects the `effects` workload puts on figures, by figure: [type, its parameters]. Glow and blur are the heavy ones. */
const EFFECTS = [
  ['glow', colour => ({color: rgbInt(colour), radius: 14, intensity: 1.1, mode: 0, spread: 0, falloff: 1, coreColor: 0xffffff, coreMix: .2, blend: 0})],
  ['shadow', () => ({color: 0, radius: 8, offsetX: 8, offsetY: 8, opacity: .5, spread: 0, mode: 0})],
  ['outline', () => ({color: 0x111111, width: 3, opacity: 1, mode: 0, rounded: 1, only: 0})],
  ['tint', colour => ({color: rgbInt(colour.map(value => 255 - value)), mix: .4})],
  ['blur', () => ({mode: 0, radius: 4, angle: 0, centerX: .5, centerY: .5})],
];

/**
 * `effects`: every figure has one effect for the whole animation, as an effect clip (`_styk.vfxClips`, the form the
 * Effects panel writes): glow, shadow, outline, tint and blur in turn, so each is on a fifth of the figures.
 */
function effects(document) {
  const colours = new Map(document.figure_types.map(type => [type.figure_type_id, type.segments[0].color_rgb]));
  const clips = document.keyframes[0].objects.map((object, index) => {
    const [type, params] = EFFECTS[index % EFFECTS.length];
    return {id: uuid(2 * index + 1), name: '', target: {kind: 'figure', uid: object.unique_id}, start: 0, duration: null, offset: 0, enabled: true, strength: 1, fadeIn: 0, fadeOut: 0, includeAttached: false,
      effects: [{version: 2, id: uuid(2 * index + 2), type, enabled: true, params: {effectStrength: 1, ...params(colours.get(object.figure_type_id))}}], keys: {}};
  });
  document._styk.vfxClips = {version: 1, clips};
}

// --- Movieclips -----------------------------------------------------------------------------------------------------

/** A figure type that is a movieclip of `clip`, turning about the clip's middle. */
const clipType = (id, name, clip, duration) => movieclipFigure(id, name, clip, {duration, pivot: {x: clip.canvas_width / 2, y: clip.canvas_height / 2}});
/** An instance of a movieclip type on a keyframe: it plays the clip on a loop from `offset` ticks in. */
const instance = (slot, uid, type, x, y, offset) => ({object_slot: slot, unique_id: uid, figure_type_id: type, root_x: fixed(x), root_y: fixed(y), scale: 1, color_override_raw: 0, field28: 0,
  angles: [0], len_flag: 0, lengths: [], bend_flag: 0, bends: [], join: null, _stykMovieclip: {start: 0, end: null, offset, speed: 1, mode: 'loop'}});

/**
 * `movieclips`: the same 80 figures, but inside movieclips two deep. The inner clip animates `figures / 16` figures;
 * the outer clip animates as many again beside one instance of the inner clip; the stage holds 8 instances of the
 * outer clip, each started at its own tick and drifting a little. `build` is perf/workloads.mjs `document`.
 */
function movieclips(document, spec, next, build) {
  const [width, height] = spec.canvas, columns = 4, rows = 2, cellWidth = width / columns, cellHeight = height / rows, each = spec.figures / (columns * rows) / 2;
  const clipSpec = (seed, canvas) => ({...spec, feature: undefined, figures: each, keyframes: 5, hold: 8, canvas, seed});
  const inner = build(clipSpec(11, [cellWidth / 2, cellHeight]));
  const outer = build(clipSpec(12, [cellWidth / 2, cellHeight]));
  const ticks = clip => clip.keyframes.reduce((total, frame) => total + frame.duration_raw, 0);
  // The outer clip shows its own figures on its left half and the inner clip on its right half.
  const innerType = Math.max(...outer.figure_types.map(type => type.figure_type_id)) + 1;
  outer.figure_types.push(clipType(innerType, 'Inner clip', inner, ticks(inner)));
  outer.canvas_width = cellWidth;
  for (const frame of outer.keyframes) {
    const uid = Math.max(...frame.objects.map(object => object.unique_id)) + 1;
    frame.objects.push(instance(frame.objects.length, uid, innerType, cellWidth * .75, cellHeight / 2, 0));
    frame.object_draw_order = frame.objects.map((_, slot) => slot);
    frame.object_draw_order_unique_ids = frame.objects.map(object => object.unique_id);
  }
  const outerTicks = ticks(outer), places = Array.from({length: columns * rows}, () => ({offset: Math.floor(next() * outerTicks), driftX: (next() - .5) * cellWidth * .1, driftY: (next() - .5) * cellHeight * .1, phase: next() * 2 * Math.PI}));
  document.figure_types = [clipType(1, 'Outer clip', outer, outerTicks)];
  document.keyframes.forEach((frame, index) => {
    const time = index / Math.max(1, document.keyframes.length - 1) * 2 * Math.PI;
    frame.objects = places.map((place, slot) => instance(slot, slot + 1, 1, (slot % columns + .5) * cellWidth + Math.sin(time + place.phase) * place.driftX, (Math.floor(slot / columns) + .5) * cellHeight + Math.cos(time + place.phase) * place.driftY, place.offset));
    frame.object_draw_order = frame.objects.map((_, slot) => slot);
    frame.object_draw_order_unique_ids = frame.objects.map(object => object.unique_id);
  });
}

// --- Camera ---------------------------------------------------------------------------------------------------------

/**
 * `camera`: the scene is generated on the workload's `canvas` and the document's canvas is the smaller `shot`, centred in
 * it, so most of the scene is outside the canvas; the camera travels round the scene on every keyframe, showing 0.7 to
 * 1.4 times the canvas and turning a little. Between two keyframes with a camera the app tweens it, so the shot moves
 * on every frame.
 */
function camera(document, spec) {
  const [width, height] = spec.shot, shiftX = (spec.canvas[0] - width) / 2, shiftY = (spec.canvas[1] - height) / 2;
  document.keyframes.forEach((frame, index) => {
    for (const object of frame.objects) { object.root_x = fixed(object.root_x - shiftX); object.root_y = fixed(object.root_y - shiftY); }
    const time = index / Math.max(1, document.keyframes.length - 1) * 2 * Math.PI;
    frame.camera = {is_default: false, x: fixed(Math.cos(time) * shiftX * .8), y: fixed(Math.sin(time) * shiftY * .8), scale: fixed(1.05 + Math.sin(time * 2) * .35), angle_rad: fixed(Math.sin(time) * .08)};
  });
  document.canvas_width = width;
  document.canvas_height = height;
}

// --- Text and shapes ------------------------------------------------------------------------------------------------

/**
 * Glyphs of a seven-segment display, enough for figure labels: the segments of each character (a top, b top right,
 * c bottom right, d bottom, e bottom left, f top left, g middle), drawn as bars in a 6 × 10 cell above the baseline.
 */
const SEVEN = {A: 'abcefg', E: 'adefg', L: 'def', P: 'abefg', R: 'eg', Y: 'bcdfg', 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg'};
const BARS = {a: [1, -10, 4, 1.2], b: [4, -10, 1.2, 5], c: [4, -5, 1.2, 5], d: [1, -1.2, 4, 1.2], e: [0, -5, 1.2, 5], f: [0, -10, 1.2, 5], g: [1, -5.6, 4, 1.2]};
const GLYPH_ADVANCE = 7;
function glyph(character) {
  const path = [...SEVEN[character]].map(bar => { const [x, y, w, h] = BARS[bar]; return `M${x} ${y} L${fixed(x + w)} ${y} L${fixed(x + w)} ${fixed(y + h)} L${x} ${fixed(y + h)} Z`; }).join(' ');
  return {svg_path: path, bounds: {left: 0, top: -10, right: 5.2, bottom: 0}};
}
/** A text asset of `text` (characters of SEVEN and spaces), one glyph per distinct character, placed left to right. */
function textAsset(text) {
  const characters = [...new Set(text.replace(/ /g, ''))], placements = [];
  [...text].forEach((character, index) => { if (character !== ' ') placements.push({character_index: index, glyph_index: characters.indexOf(character), visible: true, x: index * GLYPH_ADVANCE, y: 0}); });
  return {kind: 'text', asset_index: 0, table_index: 0, font_name: 'Seven segments', text, alignment: 0, bounds: {left: 0, bottom: 0, width: text.length * GLYPH_ADVANCE, height: 10},
    glyphs: characters.map(glyph), placements};
}

/**
 * `text`: every figure carries a label ("PLAYER 1" to "PLAYER 6", by figure type) in place of its head, as a text
 * segment as long as the label is wide, held level on every keyframe so it reads.
 */
function text(document, spec) {
  const head = spec.chain;
  for (const type of document.figure_types) {
    const asset = textAsset(`PLAYER ${type.figure_type_id}`);
    type.text_assets = [asset];
    Object.assign(type.segments[head - 1], {primitive_code: 5, aux_code: 0, flags: 5, segment_type: 'text', segment_kind: 'text', length: asset.bounds.width, thickness: 10, extra_u16: 0, extra_u8_a: 0, extra_u8_b: 0, extra: [0, 0, 0]});
  }
  for (const frame of document.keyframes) for (const object of frame.objects) object.angles[head - 1] = 0;
}

/**
 * `shapes`: every figure has filled polygons over its joints (a figure's `polyfills`): one per limb from the origin
 * along the limb and back, which curls and is concave, and one through the tips of the limbs; half transparent.
 */
function shapes(document, spec) {
  const limbs = Math.ceil(spec.segments / spec.chain);
  for (const type of document.figure_types) {
    const colour = type.segments[0].color_rgb.map(value => Math.round(value + (255 - value) * .45)), fills = [];
    for (let limb = 0; limb < limbs; limb++) {
      const ids = Array.from({length: Math.min(spec.chain, spec.segments - limb * spec.chain)}, (_, index) => limb * spec.chain + index + 1);
      fills.push({polyfill_id: limb + 1, segment_ids: [0, ...ids], color_rgb: colour, alpha_raw: 90, z_order: 0});
    }
    fills.push({polyfill_id: limbs + 1, segment_ids: Array.from({length: limbs}, (_, limb) => Math.min(spec.segments, (limb + 1) * spec.chain)), color_rgb: colour, alpha_raw: 140, z_order: 0});
    type.polyfills = fills;
  }
}

/**
 * The features by name: `apply(document, spec, next, build)` changes the plain document in place; `measure(spec)` is
 * what reports say the workload holds beyond figures and frames. `version` is part of a generated file's name: change
 * it when a feature's output changes, so no old file is taken for the new one.
 */
export const FEATURES = Object.freeze({
  sprites: {version: 1, apply: sprites,
    measure: spec => ({pictures: spec.pictures, picturePixels: spec.pictures * spec.pictureSize ** 2, picturesPerFrame: spec.figures * 2 * Math.ceil(spec.segments / spec.chain)})},
  effects: {version: 1, apply: effects, measure: spec => ({effects: spec.figures, effectTypes: EFFECTS.map(([type]) => type)})},
  movieclips: {version: 1, apply: movieclips, measure: () => ({clips: 2, clipInstances: 8, clipDepth: 2})},
  camera: {version: 1, apply: camera, measure: spec => ({scene: spec.canvas, canvas: spec.shot, cameraKeys: spec.keyframes})},
  text: {version: 1, apply: text, measure: spec => ({labels: spec.figures, glyphsPerFrame: spec.figures * 7})},
  shapes: {version: 1, apply: shapes, measure: spec => ({fillsPerFrame: spec.figures * (Math.ceil(spec.segments / spec.chain) + 1)})},
});

