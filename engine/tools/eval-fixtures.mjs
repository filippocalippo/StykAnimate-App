#!/usr/bin/env node
// Builds the evaluation fixtures of the Rust engine with the real JavaScript
// editor: each is a small project (plain JSON, opened like a .styk) and what
// the editor evaluates for it (tools/reference.mjs).
//
//   node engine/tools/eval-fixtures.mjs [name ...] [--out <folder>] [--list]
//
// Without names it regenerates every fixture into
// engine/crates/styk-eval/tests/fixtures/eval/. The Rust test
// engine/crates/styk-eval/tests/eval.rs compares the engine with each of them.
// Inverse kinematics has its own set (ik-fixtures.mjs).
import {mkdirSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import path from 'node:path';
import {here, repo, repoUrl, documentOf, limb, open, whole, nextKey, nextSheetKey, writeProject, writeReference} from './fixture-kit.mjs';

const {createImageFigure} = await import(`${repoUrl}/src/media-authoring.mjs`);

// The editor names camera-motion clips at random; fixtures must be byte-stable, so
// identities count up again from the same value for each fixture.
let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});

/** Two limbs on one layer, the first moving between two keys of a layer sheet. */
function pair() {
  const e = open(documentOf([limb(), limb()], i => [260 + i * 120, 150]), {layerTimeline: true});
  nextSheetKey(e, 6, 1); whole(e, 1).moveSelection(40, -20);
  e.seek(0);
  return e;
}
/** A small PNG of four coloured quadrants, so a misplaced picture shows. */
function quadrants(width, height) {
  const crc = bytes => { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); head.write(type, 4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(0);
    for (let x = 0; x < width; x++) rows.push(...(x < width / 2 ? (y < height / 2 ? [230, 40, 40, 255] : [40, 160, 60, 255]) : (y < height / 2 ? [40, 70, 220, 255] : [240, 200, 30, 255])));
  }
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(rows), {level: 9})), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
const instanceOf = (e, clip) => e.evaluatedFrame.objects.find(object => object.figure_type_id === clip.figure_type_id).unique_id;

const fixtures = {
  /** A figure captured as a movieclip: the layer's keys replace it with the
   * clip's instance, and consecutive replacements tween like a pose track. */
  'movieclip-replacement': () => {
    const e = pair(); e.select(1);
    e.createMovieclip({start: 0, end: 7});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6]};
  },
  /** One frame of that movieclip broken apart: patch-only keys bound the
   * frame, and its replacement is itself replaced by the clip's parts. */
  'movieclip-break-apart': () => {
    const e = pair(); e.select(1);
    const clip = e.createMovieclip({start: 0, end: 7});
    e.seek(3); e.select(instanceOf(e, clip)); e.breakApartMovieclip();
    return {document: e.serialize(), ticks: [0, 2, 3, 4, 5, 6]};
  },
  /** Two joined figures captured together and one frame broken apart: the
   * parts keep their join inside the replacement, and a replacement can be empty. */
  'movieclip-joined': () => {
    const e = pair(); e.select(2); e.joinTo(1, 22);
    e.seek(0); e.select(1);
    const clip = e.createMovieclip({start: 0, end: 7});
    e.seek(4); e.select(instanceOf(e, clip)); e.breakApartMovieclip();
    return {document: e.serialize(), ticks: [0, 1, 3, 4, 5, 6]};
  },
  /** Written by hand: the figure another is joined to is replaced and nothing
   * takes its place in the join, which the editor's commands do not produce
   * but its evaluation handles. The joined figure
   * stays where the join held it; with `replacementUid` it follows the stand-in. */
  'movieclip-loose-child': () => {
    const e = pair(); e.select(2); e.joinTo(1, 22);
    const document = e.serialize(), sheet = document._styk.layerSheet, track = Object.values(sheet.tracks).find(track => track.keys.some(key => key.value?.frameId));
    const standIn = (id, uid, dx) => {
      const frame = structuredClone(document._styk.frameSources[track.keys[0].value.frameId]);
      frame.objects = frame.objects.filter(object => object.unique_id === 1).map(object => ({...object, unique_id: uid, object_slot: 0, root_x: object.root_x + dx}));
      frame.object_count = 1; frame.object_draw_order = [0]; frame.object_draw_order_unique_ids = [uid];
      frame._styk = {...frame._styk, frameId: id};
      document._styk.frameSources[id] = frame;
    };
    standIn('frame-loose', 8, 35); standIn('frame-held', 9, -30);
    track.keys[0].movieclipPatches = [{uid: 1, frameId: 'frame-loose'}];
    track.keys[1].movieclipPatches = [{uid: 1, frameId: 'frame-held', replacementUid: 9}];
    return {document: open(document, {layerTimeline: true}).serialize(), ticks: [0, 3, 6]};
  },
  /** An imported animation (four native keys, two joined limbs) with its second and
   * fourth layer keys edited in the layer timeline: the layer then mixes imported and
   * authored keys, which tween through a window of the keys around the playhead. */
  'sheet-mixed-keys': () => {
    const native = open(documentOf([limb(true), limb()], i => [240 + i * 150, 160]));
    native.select(2); native.joinTo(1, 33);
    for (const [dx, turn] of [[30, 0.5], [-10, -0.9], [45, 0.4]]) { nextKey(native, 4); native.select(1); native.moveSelection(dx, 12); native.rotateSelection(turn); }
    const e = open(native.serialize(), {layerTimeline: true});
    e.seek(4); e.select(1); e.moveSelection(25, -30);
    e.seek(12); e.select(2, 1); e.rotateJoint(0.7);
    e.seek(0);
    return {document: e.serialize(), ticks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]};
  },
  /** Two layers with parallax (one linked, one with its own response per axis and a
   * reference away from the origin) while the camera travels; a figure of a still
   * layer joined to a parallax figure moves with the layer of its chain's root. */
  'parallax-layers': () => {
    const e = open(documentOf([limb(), limb(), limb()], i => [200 + i * 120, 160]), {layerTimeline: true});
    e.sheetSetDuration(24);
    const back = e.createLayer('Back'), front = e.createLayer('Front');
    e.assignFiguresToLayer([1], back.id); e.assignFiguresToLayer([2], front.id);
    e.select(3); e.joinTo(2, 22);
    e.seek(8); e.setCameraValues({x: 60, y: -30});
    e.setLayerParallax(back.id, {enabled: true, x: 0.25});
    e.seek(16); e.setCameraValues({x: -40, y: 20, scale: 1.2, angle_rad: 0.15});
    e.setLayerParallax(front.id, {enabled: true, linked: false, x: 1.5, y: 0.6});
    e.seek(0);
    return {document: e.serialize(), ticks: [0, 3, 8, 11, 16, 20], camera: true};
  },
  /** A camera shake baked into camera keys: each key keeps the shake apart
   * (`_parallaxMotionOffset`), which parallax layers do not follow; between the keys
   * left after clearing some (one linear span, one Auto run), the offsets tween with
   * the camera. */
  'parallax-baked-motion': async () => {
    const e = open(documentOf([limb(), limb()], i => [220 + i * 160, 160]), {layerTimeline: true});
    e.sheetSetDuration(20);
    const back = e.createLayer('Back');
    e.assignFiguresToLayer([2], back.id);
    e.seek(10); e.setCameraValues({x: 50, y: 10});
    e.seek(0); e.setLayerParallax(back.id, {enabled: true, x: 0.4});
    const shake = e.addCameraMotion('shake', {start: 2, duration: 14});
    e.setCameraMotion(shake, {params: {moveX: 30, moveY: 20, frequency: 3}});
    await e.bakeCameraMotion({start: 0, end: 20});
    e.sheetClearKeys(['camera'], 4, 7); e.sheetClearKeys(['camera'], 12, 14);
    // Baked keys hold; a linear span, and an Auto run whose curve reads the keys around it.
    e.sheetSetEasing(['camera'], 3, 3, {interpolation: 'linear'}); e.sheetSetEasing(['camera'], 10, 15, {interpolation: 'auto'});
    e.seek(0);
    return {document: e.serialize(), ticks: [0, 3, 5, 6, 9, 13, 15, 17], camera: true};
  },
  /** A follow clip on two weighted figures (dead zone, look-ahead, smoothing, framing
   * zoom, an offset, fades), over a parallax layer whose figure hangs from one of them
   * and a shake on top: travel moves the layer, the shake only the shot. */
  'follow-figures': () => {
    const e = open(documentOf([limb(), limb(true), limb()], i => [180 + i * 140, 170]), {layerTimeline: true});
    e.sheetSetDuration(40);
    e.seek(12); e.select(1); e.moveSelection(160, -40); e.seek(30); e.select(1); e.moveSelection(120, 60);
    e.seek(20); e.select(2); e.moveSelection(-90, 80);
    const back = e.createLayer('Back');
    e.assignFiguresToLayer([3], back.id);
    e.select(3); e.joinTo(2, 33);
    e.seek(0); e.setLayerParallax(back.id, {enabled: true, x: 0.5});
    const follow = e.addCameraMotion('follow', {start: 2, duration: 34, targets: [{uid: 1, weight: 1}, {uid: 2, weight: 0.5}]});
    e.setCameraMotion(follow, {params: {lag: 5, deadZone: 0.1, lookAhead: 3, zoomFit: 0.6, padding: 0.15, maxZoom: 2.5, offsetX: 20, fadeIn: 4, fadeOut: 5}});
    const shake = e.addCameraMotion('shake', {start: 10, duration: 12});
    e.setCameraMotion(shake, {params: {moveX: 25, moveY: 15, roll: 2, zoom: 0.05}});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 10, 14, 18, 25, 33, 36, 39], camera: true};
  },
  /** A follow clip on a figure that appears late and leaves early (the camera aims at the
   * first frame showing it, then holds the last), under a turned and scaled authored camera,
   * overlapped by a second clip on another figure: overlapping follows blend. */
  'follow-missing': () => {
    const e = open(documentOf([limb(), limb()], i => [200 + i * 160, 170]), {layerTimeline: true});
    e.sheetSetDuration(40);
    const late = e.createLayer('Late');
    e.assignFiguresToLayer([2], late.id);
    e.seek(16); e.select(2); e.moveSelection(-120, 40);
    e.seek(30); e.select(1); e.moveSelection(140, 30);
    e.sheetClearFrames([late.id], 0, 9); e.sheetClearFrames([late.id], 25, 39);
    e.seek(0); e.setCameraValues({x: 30, y: -20, scale: 1.3, angle_rad: 0.2});
    const first = e.addCameraMotion('follow', {start: 0, duration: 40, targets: [{uid: 2, weight: 1}]});
    e.setCameraMotion(first, {params: {lag: 3, lookAhead: 4, fadeIn: 0, fadeOut: 0}});
    const second = e.addCameraMotion('follow', {start: 20, duration: 20, targets: [{uid: 1, weight: 1}]});
    e.setCameraMotion(second, {params: {lag: 0, zoomFit: 1, padding: 0.3, maxZoom: 4, fadeIn: 6, fadeOut: 0}});
    return {document: e.serialize(), ticks: [0, 4, 8, 10, 12, 18, 22, 26, 30, 35, 39], camera: true};
  },
  /** Written by hand on an editor-built project: no command writes colour transitions,
   * which older documents carry and the editor draws (`objectColor`). A figure with a
   * polygon, a circle, a two-colour segment and a painted one, each colour mixed with both
   * overrides part way, a later key with another transition (a tween keeps the first key's),
   * and a movieclip whose figure has one (its contents draw in their own object's colours). */
  'color-transitions': () => {
    const painted = [
      [11, 0, 90, .8, {color_rgb: [200, 30, 30]}],
      [22, 11, 90, 2, {color_rgb: [20, 160, 40], secondary: {rgb: [0, 0, 255], a: 0}}],
      [33, 22, 35, 0, {color_rgb: [40, 40, 200], paint: {type: 'linear', angle: 0, stops: [{offset: 0, color: [255, 0, 0], opacity: 1}, {offset: 1, color: [0, 0, 255], opacity: 1}]}}],
      [44, 0, 40, 2.6, {primitive_code: 3, segment_kind: 'circleFill', segment_type: 'circle', color_rgb: [90, 90, 20], thickness: 0}],
    ];
    const base = documentOf([painted, limb()], i => [240 + i * 170, 170]);
    base.figure_types[0].polyfills = [{polyfill_id: 1, segment_ids: [0, 11, 22], color_rgb: [120, 40, 160], alpha_raw: 0, z_order: 0}];
    const e = open(base, {layerTimeline: true});
    e.sheetSetDuration(12);
    e.seek(8); e.select(1); e.moveSelection(40, 20);
    e.seek(0); e.select(2);
    e.createMovieclip({start: 0, end: 12});
    const document = e.serialize();
    const transitions = {1: {from: 0xff2050c0, to: 0x80ff8000, t: 0.35}, 2: {from: 0, to: 0xffffffff, t: 0.6}};
    const visit = frame => { for (const object of frame.objects ?? []) if (transitions[object.unique_id]) object.color_transition = {...transitions[object.unique_id]}; };
    const visitDocument = doc => {
      if (!doc) return;
      [...doc.keyframes, ...Object.values(doc._styk?.frameSources ?? {})].forEach(visit);
      visitDocument(doc._styk?.movieclipSource?.document);
      for (const figure of doc.figure_types) visitDocument(figure._styk?.movieclip?.document);
    };
    visitDocument(document);
    const track = document._styk.layerSheet.tracks[document._styk.layers.defaultLayerId];
    const later = document._styk.frameSources[track.keys.find(key => key.tick === 8).value.frameId];
    later.objects.find(object => object.unique_id === 1).color_transition.t = 0.9;
    return {document: open(document, {layerTimeline: true}).serialize(), ticks: [0, 4, 8, 11]};
  },
  /** A sprite imported as the editor imports pictures, three instances: one plain, and two
   * with the fields the Stick Nodes importer writes for its sprites (`_sticknodesSprite`,
   * written by hand here: no command writes them), stretched and pivoted, one scaled and
   * turned, one mirrored, the first moving between two keys. */
  'sticknodes-sprites': () => {
    const sprite = createImageFigure({dataUrl: quadrants(16, 8), width: 16, height: 8, name: 'Sprite', figureTypeId: 1});
    const e = open(documentOf([limb()], () => [120, 150]), {layerTimeline: true});
    e.importFigure({...structuredClone(e.report), figure_types: [sprite], keyframes: [{...structuredClone(e.report.keyframes[0]), objects: []}]});
    e.sheetSetDuration(10);
    e.select(2); e.moveSelection(-200, -60);
    e.addFigure(2); const stretched = e.selectedUid; e.select(stretched); e.moveSelection(-60, 40); e.rotateSelection(0.4); e.scaleSelection(2);
    e.addFigure(2); const mirrored = e.selectedUid; e.select(mirrored); e.moveSelection(120, 10); e.mirrorSelection('horizontal'); e.rotateSelection(-0.7);
    e.seek(8); e.select(stretched); e.moveSelection(30, 20); e.rotateSelection(0.5);
    e.seek(0);
    const document = e.serialize(), source = {distortion: [[0, 0], [0, 0], [0, 0], [0, 0]]};
    const sprites = {[stretched]: {source, ratio: 1.6, pivotX: 0.25, pivotY: 0.7}, [mirrored]: {source, ratio: 0.5, pivotX: 0.8, pivotY: 0.1}};
    for (const frame of [...document.keyframes, ...Object.values(document._styk.frameSources)])
      for (const object of frame.objects) if (sprites[object.unique_id]) object._sticknodesSprite = structuredClone(sprites[object.unique_id]);
    return {document: open(document, {layerTimeline: true}).serialize(), ticks: [0, 4, 8], images: true};
  },
};

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(Object.keys(fixtures).join('\n')); process.exit(0); }
const outAt = args.indexOf('--out');
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/eval` : args[outAt + 1]);
const names = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
for (const name of names) if (!fixtures[name]) { console.error(`unknown fixture ${name}`); process.exit(2); }
mkdirSync(out, {recursive: true});
for (const name of names.length ? names : Object.keys(fixtures)) {
  counter = 0;
  const built = await fixtures[name]();
  writeReference(writeProject(out, name, built.document, built.ticks, {camera: built.camera, images: built.images}), name);
}
