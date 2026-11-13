// The performance runner's feature workloads (perf/workloads.mjs, perf/workload-features.mjs) and the input the
// drawing scenarios use: every workload is the same document every time, opens through the engine as a file does,
// and holds the feature it says it holds. What the scenarios do in the app is checked by running them
// (npm run perf -- run features, npm run perf -- run drawing), which needs a real window.
import assert from 'node:assert/strict';
import test from 'node:test';
import {inflateSync} from 'node:zlib';
import {paths} from '../perf/lib/input.mjs';
import {document as build, measure, workload, WORKLOADS} from '../perf/workloads.mjs';
import {openBytes} from '../src/engine/engine-open.mjs';
import {validateMovieclipGraph, validatePlayback} from '../src/movieclips.mjs';
import {VFX_REGISTRY} from '../src/vfx-registry.mjs';
import {nodeEngine} from './support/engine-node.mjs';

const FEATURES = ['sprites', 'effects', 'movieclips', 'camera', 'text', 'shapes', 'long'];
const ticksOf = document => document.keyframes.reduce((ticks, frame) => ticks + frame.duration_raw, 0);
const segments = (document, kind) => document.figure_types.flatMap(type => type.segments.filter(segment => segment.segment_kind === kind).map(segment => ({type, segment})));

/**
 * The workloads once each. The file takes about 15 s: `sprites` draws 48 pictures of 512² pixels pixel by pixel (about
 * 4 s; its determinism is checked on 64² pictures, the same code at an eighth of the size) and the engine opens its
 * 19 MB without worker threads.
 */
const built = new Map(FEATURES.map(id => [id, build(workload(id))]));

test('a feature workload is the same document every time', () => {
  for (const id of FEATURES) {
    const spec = id === 'sprites' ? {...workload(id), pictureSize: 64} : workload(id);
    assert.equal(JSON.stringify(build(spec)), JSON.stringify(id === 'sprites' ? build(spec) : built.get(id)), `${id} is deterministic`);
  }
});

test('a feature workload has the figures, segments and frames it reports, and a name of its own', () => {
  for (const id of FEATURES) {
    const spec = workload(id), facts = measure(spec), document = built.get(id);
    assert.ok(spec.title && spec.description.length > 40, `${id} says what it is`);
    assert.equal(ticksOf(document), facts.frames, `${id}: frames`);
    if (id !== 'movieclips') assert.equal(document.keyframes[0].objects.length * document.figure_types[0].segments.length, facts.segmentsPerFrame, `${id}: segments a frame`);
    if (spec.feature) assert.equal(facts.feature, spec.feature);
  }
  assert.equal(measure(workload('long')).frames, 4001);
});

test('every feature workload opens through the engine as a file does, with nothing to mend', async () => {
  const {engine} = await nodeEngine();
  for (const id of FEATURES) {
    const opened = await openBytes(new TextEncoder().encode(JSON.stringify(built.get(id))), `${id}.json`, {engine, layerTimeline: true});
    try { assert.equal(opened.repairs, 0, `${id} opens as written`); }
    finally { opened.dispose(); }
  }
});

test('sprites: the last two segments of every limb draw one of the figure type\'s own pictures, real PNGs of the stated size', () => {
  const spec = workload('sprites'), document = built.get('sprites'), facts = measure(spec);
  const pictures = document.figure_types.flatMap(type => type.image_assets);
  assert.equal(pictures.length, facts.pictures);
  assert.equal(new Set(pictures.map(picture => picture.data_url)).size, facts.pictures, 'every picture is its own');
  for (const picture of pictures) {
    const bytes = Buffer.from(picture.data_url.split(',')[1], 'base64');
    assert.deepEqual([...bytes.subarray(1, 4)].map(code => String.fromCharCode(code)).join(''), 'PNG');
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [picture.width, picture.height]);
    assert.equal(picture.width, spec.pictureSize);
  }
  // The first picture decodes to its rows (one filter byte each) and is transparent at its corner, opaque in its middle.
  const first = Buffer.from(pictures[0].data_url.split(',')[1], 'base64'), rows = inflateSync(first.subarray(41, 41 + first.readUInt32BE(33))), stride = spec.pictureSize * 4 + 1;
  assert.equal(rows.length, stride * spec.pictureSize);
  assert.equal(rows[1 + 3], 0);
  assert.equal(rows[stride * spec.pictureSize / 2 + 1 + spec.pictureSize * 2 + 3], 255);
  const images = segments(document, 'image'), perType = new Map(document.figure_types.map(type => [type.figure_type_id, images.filter(image => image.type === type).length]));
  assert.equal(document.keyframes[0].objects.reduce((total, object) => total + perType.get(object.figure_type_id), 0), facts.picturesPerFrame);
  for (const {type, segment} of images) {
    assert.equal(segment.primitive_code, 2);
    assert.ok(type.image_assets.some(picture => picture.asset_index === segment.extra_u16), 'the picture a segment names is its figure type\'s');
  }
});

test('effects: every figure has one effect clip for the whole animation, of a kind the app knows, with only parameters it knows', () => {
  const document = built.get('effects'), clips = document._styk.vfxClips.clips, uids = document.keyframes[0].objects.map(object => object.unique_id);
  assert.deepEqual(clips.map(clip => clip.target.uid).sort((a, b) => a - b), [...uids].sort((a, b) => a - b));
  assert.equal(new Set(clips.flatMap(clip => [clip.id, ...clip.effects.map(effect => effect.id)])).size, clips.length * 2, 'ids are unique');
  for (const clip of clips) {
    assert.equal(clip.duration, null);
    const [effect] = clip.effects, known = VFX_REGISTRY[effect.type];
    assert.ok(known, effect.type);
    for (const name of Object.keys(effect.params)) if (name !== 'effectStrength') assert.ok(name in known.params, `${effect.type}.${name}`);
  }
  assert.deepEqual([...new Set(clips.map(clip => clip.effects[0].type))].sort(), ['blur', 'glow', 'outline', 'shadow', 'tint']);
});

test('movieclips: 80 figures inside clips two deep, a graph and playback the app accepts', () => {
  const document = built.get('movieclips');
  assert.doesNotThrow(() => validateMovieclipGraph(document));
  const outer = document.figure_types[0]._styk.movieclip, inner = outer.document.figure_types.find(type => type._styk?.movieclip)._styk.movieclip;
  for (const frame of document.keyframes) for (const object of frame.objects) assert.doesNotThrow(() => validatePlayback(object._stykMovieclip));
  const plain = clip => clip.document.keyframes[0].objects.filter(object => !object._stykMovieclip).length;
  assert.equal(document.keyframes[0].objects.length * (plain(outer) + plain(inner)), measure(workload('movieclips')).figures);
  assert.equal(outer.duration, ticksOf(outer.document));
  assert.ok(!inner.document.figure_types.some(type => type._styk?.movieclip), 'two deep, no deeper');
});

test('camera: the scene is larger than the canvas and the camera moves, zooms and turns on every keyframe', () => {
  const spec = workload('camera'), document = built.get('camera'), cameras = document.keyframes.map(frame => frame.camera);
  assert.deepEqual([document.canvas_width, document.canvas_height], spec.shot);
  assert.ok(cameras.every(camera => camera.is_default === false));
  for (const key of ['x', 'y', 'scale', 'angle_rad']) assert.ok(new Set(cameras.map(camera => camera[key])).size > 3, `the camera's ${key} changes`);
  const xs = document.keyframes.flatMap(frame => frame.objects.map(object => object.root_x));
  assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > spec.shot[0], 'figures stand outside the canvas on both sides');
});

test('text: each figure type labels its figures with a text asset whose placements name its glyphs', () => {
  const document = built.get('text'), labels = segments(document, 'text');
  assert.equal(labels.length, document.figure_types.length);
  for (const {type, segment} of labels) {
    const [asset] = type.text_assets;
    assert.equal(segment.primitive_code, 5);
    assert.equal(segment.length, asset.bounds.width, 'drawn at the width it was set');
    assert.ok(asset.placements.every(placement => placement.glyph_index < asset.glyphs.length));
    assert.ok(asset.glyphs.every(glyph => /^M[\d.\s LZM-]+$/.test(glyph.svg_path) && glyph.bounds.right > glyph.bounds.left && glyph.bounds.bottom > glyph.bounds.top));
    assert.equal(asset.placements.length, asset.text.replace(/ /g, '').length);
  }
});

test('shapes: every polygon runs through joints its figure has', () => {
  const document = built.get('shapes');
  for (const type of document.figure_types) {
    const joints = new Set([0, ...type.segments.map(segment => segment.segment_id)]);
    assert.equal(type.polyfills.length, measure(workload('shapes')).fillsPerFrame / document.keyframes[0].objects.length);
    for (const fill of type.polyfills) assert.ok(fill.segment_ids.length >= 3 && fill.segment_ids.every(id => joints.has(id)), `fill ${fill.polyfill_id}`);
  }
});

test('the plain workloads are unchanged by the features, and every feature workload is listed', () => {
  for (const id of FEATURES) assert.ok(WORKLOADS[id]);
  assert.equal(build(workload('medium')).keyframes[0].objects[0].figure_type_id, 1);
  assert.ok(!('feature' in measure(workload('medium'))));
});

test('a wavy stroke starts and ends where it is aimed and swings to both sides of the line', () => {
  const wave = paths.wave({x: 0, y: 100}, {x: 400, y: 100}, 30), close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(wave(0).x, 0) && close(wave(0).y, 100) && close(wave(1).x, 400) && close(wave(1).y, 100));
  const ys = Array.from({length: 101}, (_, step) => wave(step / 100).y);
  assert.ok(Math.min(...ys) < 75 && Math.max(...ys) > 125);
});
