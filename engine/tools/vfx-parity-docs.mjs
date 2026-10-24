#!/usr/bin/env node
// Builds small projects with the real editor to check how the engine draws effects (rule D13).
// Each covers some filter types with non-default parameters, or one kind of
// target: figures, nodes, connected groups, translucent figures, movieclips,
// clips with fades and strength, the scene (camera image), and drawing cels
// under effects (which the editor paints into the effect raster with Canvas 2D).
//
//   node engine/tools/vfx-parity-docs.mjs [--out tmp/vfx-parity] [--list]
//
// The ticks worth comparing for each document are printed and written to
// <out>/ticks.json. Documents are plain JSON, opened as the editor opens a project.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {repo, repoUrl, emptyDocument, createObject, createFrame, open} from './fixture-kit.mjs';

const {createVfx} = await import(`${repoUrl}/src/vfx.mjs`);
const {TILE, TILE_BYTES} = await import(`${repoUrl}/src/drawing-tiles.mjs`);
const {TILE_BLOB_PREFIX, assembleTileBlobBytes, encodeTile} = await import(`${repoUrl}/src/drawing-tile-codec.mjs`);
const {defaultFigure} = await import(`${repoUrl}/src/demo.mjs`);

// Stable identities, so a document is the same every time it is built.
let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});

const figure = uid => ({kind: 'figure', uid}), scene = {kind: 'scene'};
const node = (uid, handleId, figureTypeId = 1) => ({kind: 'segment', uid, handleId, figureTypeId});
const gradient = (type, angle, ...stops) => ({type, angle, stops: stops.map(([offset, color, opacity = 1]) => ({offset, color, opacity}))});
const fx = (type, id, params = {}) => { const effect = createVfx(type, id); return {...effect, params: {...effect.params, ...params}}; };
/** Appends effects to a pose stack in one editor command. */
const pose = (e, target, effects) => e.changeVfxStack(target, stack => {
  for (const [type, params] of effects) stack.push(fx(type, `fx-${target.kind}-${target.uid ?? 's'}-${target.handleId ?? ''}${stack.length}`, params));
});

/** A walker, a bright one (for bloom) and a ball, as figure definitions 1-3. */
function figures() {
  const walker = defaultFigure(1);
  const bright = {...defaultFigure(2), name: 'Bright'};
  bright.segments = bright.segments.map((s, i) => ({...s, color_rgb: i % 2 ? [255, 236, 120] : [250, 250, 250]}));
  const ball = {figure_type_id: 3, name: 'Ball', segment_count: 2, segments: [
    {...walker.segments[0], segment_id: 1, parent_id: 0, length: 70, angle_rad: -Math.PI / 2, thickness: 0, primitive_code: 3, flags: 3,
      segment_type: 'circle', segment_kind: 'circleFill', color_rgb: [240, 120, 60]},
    {...walker.segments[0], segment_id: 2, parent_id: 1, length: 50, angle_rad: 0, thickness: 14, color_rgb: [40, 90, 200]},
  ], polyfills: [], image_assets: [], text_assets: []};
  return [walker, bright, ball];
}

/** A document with `objects` ([figure index, x, y, extra]) on one frame of `ticks` ticks. */
function documentWith(objects, ticks = 12) {
  const document = emptyDocument(), types = figures();
  document.figure_types = types;
  document.keyframes = [{...createFrame(objects.map(([type, x, y, extra = {}], i) => createObject(types[type], i + 1, x, y, {scale: .55, ...extra})), ticks), _styk: {easing: {interpolation: 'linear'}}}];
  return document;
}

/**
 * A drawing figure (`figureTypeId`) whose cel (12×8 tiles at 2 pixels a unit) holds speckled
 * light strokes, as a charcoal brush leaves them: every pixel near a stroke's centre line takes
 * a deterministic random alpha. Encoded with the editor's own tile codec.
 */
function celFigure(figureTypeId) {
  const [tilesX, tilesY] = [12, 8], width = tilesX * TILE, height = tilesY * TILE;
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const strokes = Array.from({length: 48}, () => {
    const x = random() * width, y = random() * height, angle = (random() - .5) * 1.2 + .6, length = 60 + random() * 260;
    return {x, y, dx: Math.cos(angle), dy: Math.sin(angle), length, radius: 1.5 + random() * 4};
  });
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let ink = 0;
    for (const s of strokes) {
      const t = Math.max(0, Math.min(s.length, (x - s.x) * s.dx + (y - s.y) * s.dy));
      const d = Math.hypot(x - s.x - s.dx * t, y - s.y - s.dy * t);
      if (d < s.radius) ink = Math.max(ink, 1 - d / s.radius);
    }
    if (!ink) continue;
    const i = (y * width + x) * 4, speckle = random();
    pixels[i] = 235; pixels[i + 1] = 238; pixels[i + 2] = 242;
    pixels[i + 3] = speckle < .25 ? 0 : Math.round(255 * Math.min(1, ink * 1.4) * (.35 + .65 * speckle));
  }
  const tiles = [];
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
    const tile = new Uint8ClampedArray(TILE_BYTES);
    for (let row = 0; row < TILE; row++) tile.set(pixels.subarray(((ty * TILE + row) * width + tx * TILE) * 4, ((ty * TILE + row) * width + tx * TILE + TILE) * 4), row * TILE * 4);
    if (tile.some((value, i) => i % 4 === 3 && value)) tiles.push({tx, ty, png: encodeTile(tile)});
  }
  const bytes = assembleTileBlobBytes(tiles);
  const template = JSON.parse(readFileSync(`${repo}/engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json`, 'utf8')).figure_types[0];
  return {...template, figure_type_id: figureTypeId,
    image_assets: [{...template.image_assets[0], styk_tiles: TILE_BLOB_PREFIX + Buffer.from(bytes).toString('base64')}],
    _styk: {...template._styk, drawing: {...template._styk.drawing, celId: 'cel-00000000-0000-4000-8000-0000000c0001', revision: 1, bounds: {x: 0, y: 0, width, height}}}};
}

/** Six figures on a 3x2 grid, each with one stack: [figure index, effects]. */
function grid(stacks) {
  const at = i => [190 + (i % 3) * 290, 170 + Math.floor(i / 3) * 250];
  const e = open(documentWith(stacks.map(([type], i) => [type, ...at(i), {color_override_raw: i === 3 ? 0x7f2050c0 : 0}])), {layerTimeline: true});
  stacks.forEach(([, effects], i) => pose(e, figure(i + 1), effects));
  return e;
}

const docs = {
  /** Light and colour filters on figures, at half the figures' scale. */
  'figures-light': () => ({editor: grid([
    [0, [['tint', {color: gradient('linear', 30, [0, [255, 40, 40]], [1, [40, 90, 255], .7]), mix: .7}]]],
    [0, [['glow', {color: 0xff6a00, radius: 18, intensity: 1.4, mode: 2, spread: 3, falloff: 1.6, coreColor: 0xffffaa, coreMix: .35, blend: 1}]]],
    [2, [['outline', {color: 0x1060ff, width: 6, opacity: .9, mode: 0, rounded: 1}]]],
    [0, [['outline', {color: 0xff2060, width: 7, mode: 2, rounded: 0, only: 1}]]],
    [2, [['shadow', {color: 0x203040, radius: 10, offsetX: 14, offsetY: 10, opacity: .7, spread: 2}]]],
    [1, [['bloom', {threshold: .45, softness: .3, radius: 22, intensity: 1.6, color: 0xffd0a0}]]],
  ]), ticks: [0]}),
  /** Blur in its four modes, a blur past the downsampling threshold, and grading. */
  'figures-blur': () => ({editor: grid([
    [0, [['blur', {radius: 7}]]],
    [0, [['blur', {radius: 80}]]],
    [2, [['blur', {mode: 1, radius: 16, angle: 35}]]],
    [0, [['blur', {mode: 2, radius: 20, centerX: .3, centerY: .6}]]],
    [2, [['blur', {mode: 3, radius: 24, centerX: .6, centerY: .4}]]],
    [0, [['grade', {exposure: .6, contrast: 1.4, saturation: 1.6, temperature: .4, tint: -.3, shadows: .2, highlights: -.2, gamma: 1.3}]]],
  ]), ticks: [0]}),
  /** Texture and distortion filters, with partial strength. */
  'figures-texture': () => ({editor: grid([
    [2, [['pixelate', {size: 7, linked: 0, sizeY: 11, offsetX: 3, offsetY: -2}]]],
    [0, [['noise', {amount: .5, size: 3, colored: 1, pattern: 1, contrast: 1.6, softness: .3, seed: 9, phase: 2}], ['tint', {mix: .3, color: 0x00a0ff}]]],
    [2, [['dissolve', {progress: .45, size: 18, edge: .12, color: 0x00ff88, softness: .04, seed: 5}]]],
    [0, [['rgbSplit', {amount: 9, angle: 30, red: 1.4, green: -.6, blue: -1.2}]]],
    [2, [['wave', {strength: 10, wavelength: 40, angle: 20, phase: 60, effectStrength: .6}]]],
    [0, [['turbulence', {amount: 14, size: 30, evolution: 3.5, detail: 3, seed: 4}], ['lightSweep', {position: .35, angle: 40, width: .3, softness: .5, intensity: 1.5, color: gradient('linear', 0, [0, [255, 255, 255]], [1, [255, 120, 0]])}]]],
  ]), ticks: [0]}),
  /** Inner placements, outlines inside, stacked effects with strength. */
  'figures-inner': () => ({editor: grid([
    [2, [['glow', {color: 0x40ffff, radius: 9, intensity: 1.2, mode: 1}]]],
    [2, [['shadow', {color: 0x000000, radius: 6, offsetX: -6, offsetY: 5, opacity: .8, mode: 1}]]],
    [2, [['outline', {color: 0x00c000, width: 5, mode: 1, rounded: 1}]]],
    [0, [['glow', {radius: 12, intensity: .9, effectStrength: .5}], ['outline', {width: 3, color: 0x202020}]]],
    [0, [['blur', {radius: 5, effectStrength: .4}], ['tint', {color: 0xff00ff, mix: .5}]]],
    [1, [['bloom', {threshold: .3, radius: 50, intensity: 2.2}], ['grade', {saturation: 0}]]],
  ]), ticks: [0]}),
  /** Node stacks, a translucent figure, a figure outline, a connected group with a
   * nested one, and a timed clip with fades at partial strength. */
  'targets': () => {
    const document = documentWith([[0, 150, 260], [0, 380, 260, {field28: 110}], [2, 600, 220], [0, 820, 250], [2, 820, 250], [2, 820, 250]], 24);
    document.figure_types[0].segment_decode = {global_style: {u28: new Uint32Array(new Float32Array([2.5]).buffer)[0], rgb: [10, 10, 10], u30: 60}};
    const e = open(document, {layerTimeline: true});
    pose(e, node(1, 2), [['glow', {color: 0xff0080, radius: 10, intensity: 1.6}]]);
    pose(e, node(1, 8), [['outline', {color: 0x0080ff, width: 4}], ['blur', {radius: 3}]]);
    pose(e, figure(2), [['glow', {color: 0x00ff60, radius: 14, intensity: 1.3}]]);
    pose(e, figure(3), [['shadow', {radius: 8, offsetX: 10, offsetY: 6, opacity: .6}]]);
    // Figure 4 owns 5, which owns 6: two connected groups, one inside the other.
    e.select(5); e.joinTo(4, 4); e.select(6); e.joinTo(5, 2);
    pose(e, figure(4), [['blur', {radius: 6}], ['tint', {color: 0x8000ff, mix: .4}]]);
    e.setVfxScope(figure(4), true);
    pose(e, figure(5), [['outline', {width: 4, color: 0xff8000}]]);
    e.setVfxScope(figure(5), true);
    const clip = e.addVfxClip(figure(3), 'glow', {start: 4, duration: 16});
    e.setVfxClip(clip, {fadeIn: 6, fadeOut: 6, strength: .8});
    const effect = e.getVfxClips().find(c => c.id === clip).effects[0];
    for (const [param, value] of Object.entries({radius: 16, intensity: 1.5, color: 0xff00ff})) e.setVfxClipParameter(clip, effect.id, param, value);
    return {editor: e, ticks: [0, 6, 12, 18]};
  },
  /** Movieclips: the clip's own scene effects and an inner figure's stack, the
   * instance's stack, a translucent rotated instance, and an instance in an instance. */
  'movieclip': () => {
    const inner = documentWith([[0, 200, 200, {scale: 1}], [2, 320, 210, {scale: 1}]], 8);
    inner.keyframes[0]._stykVfx = {figure: [fx('tint', 'clip-tint', {mix: .5, color: 0x00c0ff})]};
    inner.keyframes[0].objects[1]._stykVfx = {figure: [fx('glow', 'inner-glow', {radius: 12, intensity: 1.4, color: 0xffff00})]};
    inner.keyframes.push(structuredClone(inner.keyframes[0]));
    inner.keyframes[1].objects[0].root_x += 60;
    inner.keyframes[1]._stykVfx.figure[0].params.mix = .9;
    const source = open(inner);
    source.seek(0); source.select(1);
    const clip = source.createMovieclip({start: 0, end: source.totalTicks, replace: false});
    const captured = clip._styk.movieclip.document;
    // The engine does not read a capture's retained source curves yet (docs/engine/vfx.md).
    delete captured._styk.movieclipSource;
    for (const frame of captured.keyframes) delete frame._styk?.movieclipSourceTick;
    // The capture keeps the selected figure only: give the clip the ball with its own glow,
    // and the scene stack (tweened between the clip's two keys) its document had.
    if (!captured.figure_types.some(f => f.figure_type_id === 3)) captured.figure_types.push(structuredClone(inner.figure_types[2]));
    captured.keyframes.forEach((frame, i) => {
      const ball = structuredClone(inner.keyframes[Math.min(i, inner.keyframes.length - 1)].objects[1]);
      ball.unique_id = Math.max(...frame.objects.map(o => o.unique_id)) + 1;
      frame.objects.push(ball);
      frame.object_draw_order = frame.objects.map((_, slot) => slot);
      frame.object_draw_order_unique_ids = frame.objects.map(o => o.unique_id);
      frame.objects.forEach((o, slot) => { o.object_slot = slot; });
      frame._stykVfx = structuredClone(inner.keyframes[Math.min(i, inner.keyframes.length - 1)]._stykVfx);
    });
    const types = figures();
    const instance = (uid, x, y, extra = {}) => createObject(clip, uid, x, y, {angles: [0], _stykMovieclip: {start: 0, end: 20, offset: 0, speed: 1, mode: 'loop'}, ...extra});
    const document = {...emptyDocument(), figure_types: [...types, {...clip, figure_type_id: 4}]};
    const clipType = document.figure_types[3];
    document.keyframes = [{...createFrame([
      createObject(types[0], 1, 120, 300, {scale: .5}),
      {...instance(2, 300, 300, {_stykVfx: {figure: [fx('outline', 'own', {width: 4, color: 0xff0000})]}}), figure_type_id: clipType.figure_type_id},
      {...instance(3, 640, 260, {scale: 1.3, angles: [.4], field28: 90, _stykVfx: {figure: [fx('blur', 'own-blur', {radius: 4})]}}), figure_type_id: clipType.figure_type_id},
    ], 8), _styk: {easing: {interpolation: 'linear'}}}];
    return {editor: open(document, {layerTimeline: true}), ticks: [0, 3]};
  },
  /** Drawing cels under effects, which the editor paints into the effect raster with Canvas 2D
   * smoothing, beside a cel without effects. The cel is speckled light strokes like charcoal
   * (`celFigure`) on a dark scene: fine texture is where the sampling of reduced levels shows.
   * At the fitted view of a 1,440×900 window, the cels' level of detail lies past half a
   * level, where Canvas 2D blends in the next reduction. At 2× and 3× zoom the effect
   * rasters also enlarge cel pixels with Mitchell filtering (docs/engine/rendering.md). */
  'drawing-cels': () => {
    const document = emptyDocument();
    document.figure_types = [celFigure(1)];
    const cels = [[40, 40, .56], [360, 50, .58], [680, 40, .53], [40, 300, .57], [360, 310, .55], [700, 320, .28]];
    document.keyframes = [{...createFrame(cels.map(([x, y, scale], i) => createObject(document.figure_types[0], i + 1, x, y, {scale})), 12), _styk: {easing: {interpolation: 'linear'}}}];
    const e = open(document, {layerTimeline: true});
    e.setSceneColor(0xff101018);
    pose(e, figure(1), [['outline', {color: 0xfbfafa, width: 1.2, opacity: 1, mode: 2, rounded: 0}]]);
    pose(e, figure(2), [['glow', {color: 0xff4080, radius: 12, intensity: 1.3}]]);
    pose(e, figure(3), [['blur', {mode: 1, radius: 5, angle: 60}], ['bloom', {threshold: .4, radius: 18, intensity: 1.4}]]);
    pose(e, figure(4), [['tint', {color: 0x20c0ff, mix: .6}]]);
    pose(e, figure(6), [['blur', {radius: 3}], ['glow', {color: 0xffd000, radius: 10, intensity: 1.1}]]);
    return {editor: e, ticks: [0]};
  },
  /** The scene stack (camera image) on an unmoved camera, with a blur past downsampling. */
  'scene': () => {
    const e = open(documentWith([[0, 200, 260], [2, 480, 240], [1, 760, 270]]), {layerTimeline: true});
    pose(e, figure(2), [['glow', {radius: 10, intensity: 1.2}]]);
    pose(e, scene, [
      ['grade', {saturation: 1.5, contrast: 1.2}],
      ['vignette', {amount: .6, softness: .5, color: 0x200010, centerX: .45, centerY: .55, roundness: .6, aspect: 1.4, radius: 1.1}],
      ['shockwave', {radius: 160, thickness: 50, strength: -24, centerX: .55, centerY: .45, falloff: 1.5}],
      ['blur', {radius: 30}],
    ]);
    return {editor: e, ticks: [0]};
  },
  /** The scene stack through a moved, zoomed and rotated camera; scene clips with fades. */
  'scene-camera': () => {
    const document = documentWith([[0, 260, 270], [2, 520, 240], [1, 760, 290]], 24);
    document.keyframes[0].camera = {is_default: false, x: 60, y: -30, scale: .8, angle_rad: .12};
    const e = open(document, {layerTimeline: true});
    pose(e, scene, [['crt', {amount: .4, spacing: 4, curvature: .15, chromatic: 3, phase: 1, color: 0x002000}]]);
    const split = e.addVfxClip(scene, 'rgbSplit', {start: 2, duration: 16});
    e.setVfxClip(split, {fadeIn: 4, fadeOut: 4, strength: .9});
    const effect = e.getVfxClips().find(c => c.id === split).effects[0];
    e.setVfxClipParameter(split, effect.id, 'amount', 10);
    return {editor: e, ticks: [0, 4, 10]};
  },
};

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(Object.keys(docs).join('\n')); process.exit(0); }
const at = args.indexOf('--out');
const out = path.resolve(at < 0 ? `${repo}/tmp/vfx-parity` : args[at + 1]);
mkdirSync(out, {recursive: true});
const ticks = {};
for (const [name, build] of Object.entries(docs)) {
  counter = 0;
  const {editor, ticks: list} = build();
  writeFileSync(path.join(out, `${name}.json`), JSON.stringify(editor.serialize()) + '\n');
  ticks[name] = list;
  console.log(`${name}: ticks ${list.join(',')}`);
}
writeFileSync(path.join(out, 'ticks.json'), JSON.stringify(ticks, null, 2) + '\n');
