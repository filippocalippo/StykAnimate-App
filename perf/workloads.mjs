/**
 * The documents a profiling run measures the app on (docs/PERFORMANCE.md "Workloads").
 *
 * Every workload is generated here, from a seed, so a run needs no file from outside the repository and two machines
 * measure the same document. A workload is a size class of real use: a document of that many figures, segments and
 * frames, with every figure moving on every frame (the worst honest case for evaluation and drawing).
 *
 * `document(workload)` builds the document as the app's own JSON (what a decoded Pivot file is); `file(workload)`
 * writes it once under artifacts/perf/workloads/ and returns its path.
 */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ROOT} from './lib/app.mjs';
import {FEATURES} from './workload-features.mjs';

/**
 * figures × segments is what one frame draws; keyframes × hold is the animation's length in frames (between two
 * keyframes the app interpolates every joint). `chain` is how many segments hang from one another before a new limb
 * starts at the figure's origin.
 */
export const WORKLOADS = Object.freeze({
  starter: {id: 'starter', title: 'New project', description: 'The document the app starts with: one figure, ten frames. Nothing is opened.', builtin: true},
  small: {id: 'small', title: 'Small scene', description: '12 figures of 20 segments (240 segments a frame), 120 frames: a short hobby animation.',
    figures: 12, segments: 20, chain: 5, keyframes: 25, hold: 5, canvas: [1280, 720]},
  medium: {id: 'medium', title: 'Busy scene', description: '80 figures of 40 segments (3,200 segments a frame), 128 frames: a crowded fight.',
    figures: 80, segments: 40, chain: 8, keyframes: 17, hold: 8, canvas: [1920, 1080]},
  large: {id: 'large', title: 'Large scene', description: '500 figures of 60 segments (30,000 segments a frame), 110 frames: more than most projects ever hold.',
    figures: 500, segments: 60, chain: 10, keyframes: 12, hold: 10, canvas: [1920, 1080]},
  stress: {id: 'stress', title: 'Stress scene', description: '2,000 figures of 100 segments (200,000 segments a frame), 101 frames: the scene the app must stay usable on.',
    figures: 2000, segments: 100, chain: 10, keyframes: 11, hold: 10, canvas: [1920, 1080]},
  // The busy scene with one of the heavier features (perf/workload-features.mjs), to compare with `medium`; `long` is the small scene made long.
  sprites: {id: 'sprites', title: 'Busy scene of pictures', description: 'The busy scene with the last two segments of every limb drawn as a picture: 48 pictures of 512² pixels, 800 drawn a frame.',
    figures: 80, segments: 40, chain: 8, keyframes: 17, hold: 8, canvas: [1920, 1080], feature: 'sprites', pictures: 48, pictureSize: 512},
  effects: {id: 'effects', title: 'Busy scene with effects', description: 'The busy scene with an effect on every figure for the whole animation: glow, shadow, outline, tint and blur, each on 16 figures.',
    figures: 80, segments: 40, chain: 8, keyframes: 17, hold: 8, canvas: [1920, 1080], feature: 'effects'},
  movieclips: {id: 'movieclips', title: 'Busy scene in movieclips', description: 'The busy scene\'s 80 figures inside movieclips two deep: 8 instances of a clip that holds 5 figures and a clip of 5 more.',
    figures: 80, segments: 40, chain: 8, keyframes: 17, hold: 8, canvas: [1920, 1080], feature: 'movieclips'},
  camera: {id: 'camera', title: 'Busy scene through a camera', description: 'The busy scene spread over 3840 × 2160 behind a 1920 × 1080 canvas, with a camera that pans, zooms and turns on every frame.',
    figures: 80, segments: 40, chain: 8, keyframes: 17, hold: 8, canvas: [3840, 2160], feature: 'camera', shot: [1920, 1080]},
  text: {id: 'text', title: 'Busy scene with labels', description: 'The busy scene with a text label in place of every figure\'s head: 80 labels of 7 glyphs a frame.',
    figures: 80, segments: 40, chain: 8, keyframes: 17, hold: 8, canvas: [1920, 1080], feature: 'text'},
  shapes: {id: 'shapes', title: 'Busy scene of filled shapes', description: 'The busy scene with half-transparent filled polygons over every limb and through the limbs\' tips: 480 a frame.',
    figures: 80, segments: 40, chain: 8, keyframes: 17, hold: 8, canvas: [1920, 1080], feature: 'shapes'},
  long: {id: 'long', title: 'Long animation', description: '12 figures of 20 segments over 4,001 frames (2 min 47 s at 24 fps, 401 keyframes): what the timeline costs when it is long.',
    figures: 12, segments: 20, chain: 5, keyframes: 401, hold: 10, canvas: [1280, 720]},
});

/** The workload named `id`; throws with the list when there is none. */
export function workload(id) {
  const found = WORKLOADS[id];
  if (!found) throw new Error(`Unknown workload ${JSON.stringify(id)}: one of ${Object.keys(WORKLOADS).join(', ')}.`);
  return found;
}

/** A workload of `segments` segments a frame in figures of 50, for a scaling run: how cost grows with the scene. */
export function scaled(segments) {
  const figures = Math.max(1, Math.round(segments / 50));
  return {id: `scale-${figures * 50}`, title: `${(figures * 50).toLocaleString('en')} segments`, description: `${figures} figures of 50 segments, 41 frames.`,
    figures, segments: 50, chain: 10, keyframes: 5, hold: 10, canvas: [1920, 1080]};
}

/** What a workload holds, for reports: figures and segments a frame, frames, and the generated file's size. */
export function measure(spec) {
  if (spec.builtin) return {figures: 1, segmentsPerFrame: 10, frames: 10, bytes: 0};
  return {figures: spec.figures, segmentsPerFrame: spec.figures * spec.segments, frames: (spec.keyframes - 1) * spec.hold + 1, keyframes: spec.keyframes,
    ...(spec.feature ? {feature: spec.feature, ...FEATURES[spec.feature].measure(spec)} : {})};
}

/** A small seeded generator (mulberry32): the same numbers on every machine. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
const fixed = value => Math.round(value * 1000) / 1000;
const COLOURS = [[43, 43, 43], [200, 60, 50], [40, 110, 200], [50, 150, 90], [150, 80, 180], [220, 140, 40]];

/** One figure type: limbs of `chain` segments from the origin, lines with a round head on the first limb, sized to `reach` pixels. */
function figureType(id, segments, chain, reach, colour) {
  const length = reach / chain, list = [];
  for (let index = 0; index < segments; index++) {
    const inChain = index % chain, head = index === chain - 1;
    list.push({segment_id: index + 1, parent_id: inChain === 0 ? 0 : index, length: fixed(length * (1 - inChain * .04)), angle_rad: 0, thickness: fixed(Math.max(1.5, length * (.6 - inChain * .03))),
      bend_rad: 0, primitive_code: head ? 1 : 0, aux_code: 0, flags: head ? 1 : 0, segment_type: head ? 'circle' : 'line', segment_kind: head ? 'circle' : 'line',
      color_rgb: colour, transparency: 0, visible: true, z_order: index + 1});
  }
  return {figure_type_id: id, name: `Figure ${id}`, segment_count: segments, segments: list, polyfills: [], image_assets: [], text_assets: []};
}

/** The document of a workload, as the app's JSON. Deterministic: the same workload always gives the same bytes. */
export function document(spec) {
  if (spec.builtin) throw new Error(`${spec.id} is the app's own starting document: there is nothing to build.`);
  const {figures, segments, chain, keyframes, hold} = spec, [width, height] = spec.canvas, next = random(spec.seed ?? 20261112);
  // Figures stand on a grid that fills the canvas; each reaches about a third of its cell.
  const columns = Math.ceil(Math.sqrt(figures * width / height)), rows = Math.ceil(figures / columns), cell = Math.min(width / columns, height / rows), reach = cell * .42;
  const types = COLOURS.map((colour, index) => figureType(index + 1, segments, chain, reach, colour));
  const limbs = Math.ceil(segments / chain);
  const actors = Array.from({length: figures}, (_, index) => ({
    uid: index + 1, type: index % types.length + 1, x: (index % columns + .5) * width / columns, y: (Math.floor(index / columns) + .5) * height / rows,
    // Each limb points its own way and curls by its own amount; each figure moves with its own phase and speed.
    limbs: Array.from({length: limbs}, (_, limb) => ({base: limb / limbs * 2 * Math.PI + next() * .6, curl: (next() - .5) * .7, swing: .25 + next() * .5})),
    phase: next() * 2 * Math.PI, speed: .5 + next(), driftX: (next() - .5) * cell * .5, driftY: (next() - .5) * cell * .5,
  }));
  const frames = Array.from({length: keyframes}, (_, frame) => {
    const time = frame / Math.max(1, keyframes - 1) * 2 * Math.PI;
    const objects = actors.map((actor, slot) => {
      const angles = new Array(segments);
      for (let index = 0; index < segments; index++) {
        const limb = actor.limbs[Math.floor(index / chain)], inChain = index % chain;
        const wave = Math.sin(time * actor.speed + actor.phase + inChain * .5) * limb.swing;
        angles[index] = fixed(limb.base + wave + limb.curl * inChain);
      }
      return {object_slot: slot, unique_id: actor.uid, figure_type_id: actor.type, root_x: fixed(actor.x + Math.sin(time + actor.phase) * actor.driftX), root_y: fixed(actor.y + Math.cos(time * actor.speed + actor.phase) * actor.driftY),
        scale: 1, color_override_raw: 0, field28: 0, angles, len_flag: 0, lengths: [], bend_flag: 0, bends: [], join: null};
    });
    return {duration_raw: frame === keyframes - 1 ? 1 : hold, background_id: 0, background_id_b: 0, background_mix: 0, camera: {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0},
      objects, object_draw_order: objects.map((_, slot) => slot), object_draw_order_unique_ids: objects.map(object => object.unique_id)};
  });
  const result = {version: 5, canvas_width: width, canvas_height: height, fps: 24, auto_easing: false, auto_easing_disabled_raw: 1, auto_easing_source: 'file', backgrounds: [],
    figure_types: types, keyframes: frames, _styk: {format: 'StykAnimate', format_version: 1, name: spec.title}};
  // A feature workload is the plain scene with its feature added; the feature draws its own numbers from the same generator.
  if (spec.feature) FEATURES[spec.feature].apply(result, spec, next, document);
  return result;
}

/**
 * The workload's document as a file the app opens: written once per definition under artifacts/perf/workloads/ (the
 * name carries a hash of the definition, so a changed workload is a new file). Returns {path, bytes, sha256}.
 */
export function file(spec, directory = path.join(ROOT, 'artifacts', 'perf', 'workloads')) {
  const {title: _title, description: _description, ...shape} = spec;
  const key = createHash('sha256').update(JSON.stringify(shape)).update('generator 1').update(spec.feature ? ` ${spec.feature} ${FEATURES[spec.feature].version}` : '').digest('hex').slice(0, 12);
  const target = path.join(directory, `${spec.id}-${key}.json`);
  if (!existsSync(target)) {
    mkdirSync(directory, {recursive: true});
    writeFileSync(target, JSON.stringify(document(spec)));
  }
  return {path: target, bytes: statSync(target).size, key};
}
