#!/usr/bin/env node
// Builds the property-channel fixtures of the Rust engine with the real JavaScript
// editor (docs/engine/evaluation.md, "Property channels"): each is a small project
// animated with channels on its native timeline (`_styk.animation`, the editor with
// property channels on), the same project as the app holds it once loaded (a layer
// sheet whose imported keys sample the channels as `legacyAnimation`), and what the
// editor evaluates for it (tools/reference.mjs, the app's configuration).
//
//   node engine/tools/channel-fixtures.mjs [name ...] [--out <folder>] [--list]
//
// Without names it regenerates every fixture into
// engine/crates/styk-eval/tests/fixtures/channels/: `<name>.json` (as saved) with what the
// editor evaluates on its native timeline (`<name>.native.reference.json`), and
// `<name>.sheet.json` (as the app loads it) with what the app evaluates
// (`<name>.reference.json`). The Rust test engine/crates/styk-eval/tests/channels.rs
// compares the engine with both, and checks that each fixture differs without its channels.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, repo, repoUrl, Editor, documentOf, limb, open, joint, whole, nextKey, writeProject, writeReference} from './fixture-kit.mjs';

const {animationChannelId} = await import(`${repoUrl}/src/animation-channels.mjs`);

// The editor names effects at random; fixtures must be byte-stable, so identities count
// up again from the same value for each fixture.
let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});

/** The editor with property channels on a native timeline, as documents with channels were made. */
const authoring = document => open(document, {propertyChannels: true});
const figure = uid => ({kind: 'figure', uid});
const segment = (uid, handleId, figureTypeId) => ({kind: 'segment', uid, handleId, ...(figureTypeId === undefined ? {} : {figureTypeId})});
const key = (target, property, tick, value, extra = {}) => ({target, property, tick, value, exactTarget: true, ...extra});
/** Sets the easing of the key of `channel` at `tick`. */
function ease(e, target, property, tick, interpolation, bezier) {
  const channel = e.animationChannel(target, property, {exactTarget: true});
  const found = channel.keys.find(k => k.tick === tick && !k.hidden);
  e.setAnimationKey(channel.id, found.id, {interpolation, ...(bezier ? {bezier} : {})});
}
const every = (from, to) => Array.from({length: to - from + 1}, (_, i) => from + i);

const fixtures = {
  /** Three figures, the third joined to the first; native keys at 0, 10 and 20. Scale with
   * a Bézier curve, rotation easing in, an opacity and an ARGB colour resampled from the
   * native keys (`nativeValueMode`), depth keys that move the second figure behind the
   * first, and the position of the joined figure, which moves its root figure (the world
   * geometry path) and turns with its own rotation key. Imported figure transforms are
   * keyed directly, as older files carry them. */
  'channels-figure': () => {
    const e = authoring(documentOf([limb(), limb(), limb()], i => [220 + i * 150, 160]));
    e.select(3); e.joinTo(1, 22);
    nextKey(e, 10); whole(e, 1).moveSelection(40, -20);
    nextKey(e, 10); whole(e, 2).moveSelection(-30, 25);
    e.addAnimationKeys([key(figure(1), 'scale', 4, 1.6), key(figure(1), 'scale', 16, 0.7)]);
    ease(e, figure(1), 'scale', 4, 'bezier', [0.2, 0.8, 0.3, 1]);
    e.addAnimationKeys([key(figure(1), 'rotation', 6, 0.9), key(figure(1), 'rotation', 14, -0.4)]);
    ease(e, figure(1), 'rotation', 6, 'ease-in');
    e.addAnimationKeys([key(figure(2), 'opacity', 5, 0.3), key(figure(2), 'color', 8, 0xff2080f0), key(figure(2), 'color', 15, 0x80f02020)]);
    ease(e, figure(2), 'opacity', 5, 'ease-out');
    e.addAnimationKeys([key(figure(2), 'zIndex', 7, -5), key(figure(2), 'zIndex', 13, 3)]);
    e.addAnimationKeys([key(figure(3), 'x', 9, 120), key(figure(3), 'y', 11, 260), key(figure(3), 'rotation', 12, 2.2)]);
    return {document: e.serialize(), ticks: every(0, 21)};
  },
  /** Outline colour, width and opacity of a figure: what its resolved figure is drawn with. */
  'channels-outline': () => {
    const base = documentOf([limb(), limb()], i => [260 + i * 160, 160]);
    for (const figure of base.figure_types) figure.segment_decode = {global_style: {rgb: [30, 30, 30], outline_thickness: 2, u28: new Uint32Array(new Float32Array([2]).buffer)[0], u30: 0}};
    const e = authoring(base);
    nextKey(e, 12); whole(e, 1).moveSelection(30, 10);
    e.addAnimationKeys([key(figure(1), 'outlineColor', 3, 0xe03020), key(figure(1), 'outlineColor', 9, 0x2040f0),
      key(figure(1), 'outlineWidth', 2, 1), key(figure(1), 'outlineWidth', 10, 6.5), key(figure(2), 'outlineOpacity', 4, 0.25)]);
    return {document: e.serialize(), ticks: every(0, 12), style: true};
  },
  /** Segment and polygon styles: colour, opacity, width, the second colour and opacity of a
   * native gradient, a fill style held from its key, depth; a segment colour scoped to the
   * figure type that wins over the unscoped curve; a polygon's colour, opacity and depth. */
  'channels-style': () => {
    const painted = [
      [11, 0, 90, .8, {color_rgb: [200, 30, 30]}],
      [22, 11, 90, 2, {color_rgb: [20, 160, 40], secondary: {rgb: [0, 0, 255], a: 0}}],
      [33, 22, 35, 0, {color_rgb: [40, 40, 200]}],
      [44, 0, 70, 2.6, {color_rgb: [90, 90, 20]}],
    ];
    const base = documentOf([painted, limb()], i => [240 + i * 170, 170]);
    base.figure_types[0].polyfills = [{polyfill_id: 1, segment_ids: [0, 11, 22], color_rgb: [120, 40, 160], alpha_raw: 0, z_order: 0}];
    const e = authoring(base);
    nextKey(e, 12); whole(e, 1).moveSelection(20, 15);
    e.addAnimationKeys([
      key(segment(1, 11), 'color', 3, 0x10a0e0), key(segment(1, 11), 'color', 9, 0xf0e010),
      key(segment(1, 33), 'opacity', 2, 0.2), key(segment(1, 33), 'thickness', 6, 18),
      key(segment(1, 22), 'gradientColor', 4, 0xff8000), key(segment(1, 22), 'gradientOpacity', 8, 0.5),
      key(segment(1, 44), 'paint', 5, {type: 'linear', angle: 30, stops: [{offset: 0, color: [255, 0, 0], opacity: 1}, {offset: 1, color: [0, 0, 255], opacity: 0.6}]}),
      key(segment(1, 44), 'zIndex', 7, -2),
      key(segment(1, 11, 1), 'color', 6, 0x40ff40),
      key({kind: 'polygon', uid: 1, polygonId: 1, figureTypeId: 1}, 'color', 3, 0x30c0a0),
      key({kind: 'polygon', uid: 1, polygonId: 1, figureTypeId: 1}, 'opacity', 7, 0.4),
      key({kind: 'polygon', uid: 1, polygonId: 1, figureTypeId: 1}, 'zIndex', 9, 10),
    ]);
    ease(e, segment(1, 11), 'color', 3, 'auto');
    return {document: e.serialize(), ticks: every(0, 12), style: true};
  },
  /** The camera's position, zoom and turn with Auto curves between neighbouring keys and a
   * held key; the scene's background chosen and coloured, a colour key of `null` handing
   * the colour back to the background. */
  'channels-camera-scene': () => {
    const e = authoring(documentOf([limb(), limb()], i => [260 + i * 160, 160]));
    nextKey(e, 8); whole(e, 1).moveSelection(30, 10);
    nextKey(e, 8);
    const camera = {kind: 'camera'};
    e.addAnimationKeys([key(camera, 'x', 2, 40), key(camera, 'x', 6, -20), key(camera, 'x', 12, 60),
      key(camera, 'y', 3, 30), key(camera, 'scale', 4, 1.5), key(camera, 'scale', 10, 0.8), key(camera, 'rotation', 5, 0.3), key(camera, 'rotation', 13, -0.2)]);
    for (const tick of [2, 6, 12]) ease(e, camera, 'x', tick, 'auto');
    ease(e, camera, 'scale', 4, 'constant');
    e.seek(3); e.setSceneColor(0xff204060);
    e.seek(7); e.importSceneBackground({kind: 2, color: 0xffe0c080, name: 'Warm'});
    e.seek(11); e.setSceneColor(0xff80f080);
    return {document: e.serialize(), ticks: every(0, 16), camera: true, scene: true};
  },
  /** Pose channels: the camera's and the scene's own poses, a layer's pose track (a second
   * layer, in front, blank before its only key), a figure's pose track with Auto curves and
   * a hidden key, which keeps the native appearance, and a joined figure whose parent's pose
   * track turns the joint it hangs from. Native keys change background and camera, so the scene and camera tracks,
   * blank before their first key, differ from them. */
  'channels-pose': () => {
    const base = documentOf([limb(), limb(), limb(), limb()], i => [180 + i * 140, 160]);
    base.backgrounds = [{background_id: 1, kind: 2, color: 0xffd0e0f0, name: 'Sky'}, {background_id: 2, kind: 2, color: 0xff203040, name: 'Night'}];
    base.keyframes[0].background_id = 1;
    base.keyframes[0].camera = {is_default: false, x: 30, y: -10, scale: 1.2, angle_rad: 0.1};
    const e = authoring(base);
    e.select(3); e.joinTo(2, 22);
    e.createLayer('Front'); e.assignFiguresToLayer([4], 'layer-2');
    nextKey(e, 10); whole(e, 1).moveSelection(30, 20);
    nextKey(e, 10);
    e.seek(4); whole(e, 2).moveSelection(-25, 15);
    e.seek(6); e.select(2); e.rotateSelection(0.6);
    e.seek(15); whole(e, 2).moveSelection(35, -20);
    for (const tick of [4, 6, 10, 15]) ease(e, figure(2), 'pose', tick, 'auto');
    const channel = e.animationChannel(figure(2), 'pose', {exactTarget: true});
    e.setAnimationKey(channel.id, channel.keys.find(k => k.tick === 10).id, {hidden: true});
    e.addAnimationKeys([{target: {kind: 'layer', id: 'layer-2'}, property: 'pose', tick: 8}]);
    e.seek(12); e.addAnimationKeys([{target: {kind: 'camera'}, property: 'pose', tick: 12}]);
    e.seek(14); e.addAnimationKeys([{target: {kind: 'scene'}, property: 'pose', tick: 14}]);
    const document = e.serialize();
    // Written by hand: the second native key changes background, which the scene's pose
    // (captured before) does not; native keys scale and colour the second figure, which its
    // captured poses do not (a pose track with native properties keeps the native ones).
    document.keyframes[1].background_id = 2;
    for (const frame of document.keyframes) Object.assign(frame.objects.find(o => o.unique_id === 2), {scale: 1.3, color_override_raw: 0xff30a030});
    // The joined figure keeps its native pose (its pose track, which the editor gave it when
    // its parent moved, is dropped): it turns with the joint of its parent's pose track.
    dropChannel(document, 'figure:3:pose');
    return {document, ticks: every(0, 21), camera: true, scene: true};
  },
  /** A movieclip captured on the native timeline: the figure's pose is masked (`maskedRanges`,
   * `useBasePose`) while the instance's pose track shows it, stacked after the figure it
   * replaces (`orderAnchor`) until its end (`clipEnd`). */
  'channels-movieclip': () => {
    const e = authoring(documentOf([limb(), limb()], i => [240 + i * 170, 160]));
    nextKey(e, 10); whole(e, 1).moveSelection(40, -10); whole(e, 2).moveSelection(-20, 30);
    nextKey(e, 6);
    e.seek(3); e.select(1);
    e.createMovieclip({start: 3, end: 9});
    return {document: e.serialize(), ticks: every(0, 16)};
  },
  /** Written by hand on editor-built projects: a movieclip whose own document has channels,
   * sampled at the instance's local time (no command makes one: a capture keeps its channels
   * in the retained source, `movieclipSource`). The clip is a figure scaled, turned and
   * recoloured by channels on its native timeline; the host is a layer sheet. */
  'channels-in-movieclip': () => {
    // Placed so that the scaled, turned figure stays inside the camera's frame.
    const inner = authoring(documentOf([limb()], () => [260, 150]));
    nextKey(inner, 12); whole(inner, 1).moveSelection(40, 10);
    inner.addAnimationKeys([key(figure(1), 'scale', 4, 1.6), key(figure(1), 'rotation', 8, 1.2), key(figure(1), 'color', 6, 0xffe02040), key(figure(1), 'scale', 16, 0.8)]);
    const clipDocument = inner.serialize();
    const host = open(documentOf([limb(), limb()], i => [220 + i * 200, 170]), {layerTimeline: true});
    host.sheetSetDuration(24);
    host.select(1);
    const clip = host.createMovieclip({start: 0, end: 24});
    const document = host.serialize();
    const definition = document.figure_types.find(f => f.figure_type_id === clip.figure_type_id);
    Object.assign(definition._styk.movieclip, {document: clipDocument, duration: 17, sourceStart: 0});
    return {document: open(document, {layerTimeline: true}).serialize(), ticks: every(0, 23)};
  },
  /** Effects animated by channels: a stack added to a figure, a node and the scene, a number
   * keyed between values, an RGB colour and a gradient colour, an option held from its key,
   * an effect switched off and on, and a figure's stack covering its attached figure. */
  'channels-vfx': () => {
    const e = authoring(documentOf([limb(), limb()], i => [240 + i * 170, 160]));
    e.select(2); e.joinTo(1, 22);
    nextKey(e, 12); whole(e, 1).moveSelection(30, 10);
    e.seek(0);
    const [blur] = e.addVfx(figure(1), 'blur');
    const [glow] = e.addVfx(segment(1, 22, 1), 'glow');
    const [grade] = e.addVfx({kind: 'scene'}, 'grade');
    e.seek(2); e.setVfxParameter(figure(1), blur, 'radius', 2);
    e.seek(9); e.setVfxParameter(figure(1), blur, 'radius', 14);
    e.seek(3); e.setVfxParameter(segment(1, 22, 1), glow, 'color', 0x20e0ff);
    e.seek(10); e.setVfxParameter(segment(1, 22, 1), glow, 'color', {type: 'linear', angle: 0, stops: [{offset: 0, color: [255, 0, 0], opacity: 1}, {offset: 1, color: [0, 255, 0], opacity: 1}]});
    ease(e, figure(1), `vfx1:blur:${blur}:radius`, 2, 'ease-out');
    ease(e, segment(1, 22, 1), `vfx1:glow:${glow}:color`, 3, 'linear');
    e.seek(5); e.setVfxParameter(figure(1), blur, 'enabled', 0);
    e.seek(7); e.setVfxParameter(figure(1), blur, 'enabled', 1);
    e.seek(8); e.setVfxParameter(figure(1), blur, 'mode', 1);
    e.seek(6); e.setVfxScope(figure(1), true);
    e.seek(4); e.changeVfxStack({kind: 'scene'}, stack => { stack[0].params.contrast = 1.8; });
    const document = e.serialize();
    // Written by hand: on a native timeline the editor keys a scene parameter only where the
    // effect is in a native pose; files can carry one on an effect a stack channel adds.
    const property = `vfx1:grade:${grade}:saturation`;
    document._styk.animation.channels.push({id: animationChannelId({kind: 'scene'}, property), target: {kind: 'scene'}, property,
      keys: [{id: 'grade-1', tick: 5, value: 0.2, interpolation: 'linear'}, {id: 'grade-2', tick: 11, value: 1.6, interpolation: 'linear'}]});
    return {document, ticks: every(0, 12), vfx: true};
  },
  /** A follow camera over channels: it follows the second figure, joined to the first, whose
   * own channels move it; the first figure's channels and the scene's are left out of what
   * the follow samples (`followSamplingReport` keeps the camera's, layers' and the followed
   * figures' channels), the camera's own channels are kept. */
  'channels-follow': () => {
    const e = authoring(documentOf([limb(), limb()], i => [200 + i * 160, 170]));
    e.select(2); e.joinTo(1, 22);
    nextKey(e, 30); whole(e, 1).moveSelection(60, 10);
    e.addAnimationKeys([key(figure(1), 'scale', 8, 1.8), key(figure(1), 'rotation', 14, 1.1), key(figure(2), 'rotation', 10, -1.4),
      key(figure(2), 'scale', 20, 2.2), key({kind: 'camera'}, 'scale', 12, 1.4), key({kind: 'camera'}, 'x', 18, -40)]);
    e.seek(5); e.setSceneColor(0xff406080);
    const follow = e.addCameraMotion('follow', {start: 2, duration: 26, targets: [{uid: 2, weight: 1}]});
    e.setCameraMotion(follow, {params: {lag: 3, lookAhead: 2, zoomFit: 0.7, padding: 0.2, maxZoom: 3, fadeIn: 3, fadeOut: 3}});
    return {document: e.serialize(), ticks: [0, 2, 4, 6, 9, 12, 15, 18, 21, 24, 27, 30], camera: true, scene: true};
  },
  /** Animation origins under channels: a figure re-rooted at a shin's end (Set Origin), its
   * rotation, position and pose keyed by channels about its original pivot, and a figure
   * joined to it at a joint the original tree reaches, which turns with that joint when the
   * parent's pose track changes it (written by hand: without the pose track the editor gives
   * it); `support` dissolves a segment first, so the original tree
   * is a retained support graph with a ghost bone that rotation turns too. */
  'channels-origin': () => origin(false),
  'channels-origin-support': () => origin(true),
  /** Curves as imported files carry them: Pivot's monotone cubic across native keys without
   * easing (`nativeCurve`, angles along the shortest turn for rotation), a key whose interval
   * hands the property back to the pose (`passthrough`), and keys past the last native key,
   * which lengthen the timeline. */
  'channels-curves': () => {
    const base = documentOf([limb(), limb()], i => [240 + i * 170, 160]);
    base.auto_easing = true;
    const e = authoring(base);
    for (const [ticks, dx, turn] of [[6, 30, 0.8], [6, -40, 2.9], [6, 25, -2.9], [6, 0, 0]]) {
      nextKey(e, ticks); whole(e, 1).moveSelection(dx, dx / 3); e.select(1); e.rotateSelection(turn);
    }
    for (const frame of e.report.keyframes) delete frame._styk?.easing;
    e.addAnimationKeys([key(figure(1), 'scale', 9, 1.4), key(figure(1), 'rotation', 15, 0.5), key(figure(2), 'scale', 3, 1.3), key(figure(2), 'scale', 30, 0.6)]);
    const scale = e.animationChannel(figure(2), 'scale', {exactTarget: true});
    e.setAnimationKey(scale.id, scale.keys.find(k => k.tick === 3).id, {interpolation: 'linear'});
    const document = e.serialize();
    // Written by hand: no command writes `passthrough`; older files carry it.
    const channel = document._styk.animation.channels.find(c => c.id === scale.id);
    channel.keys.splice(channel.keys.findIndex(k => k.tick > 8), 0, {id: 'passthrough-1', tick: 8, value: 2, interpolation: 'linear', passthrough: true});
    return {document, ticks: every(0, 31)};
  },
};

function origin(support) {
  const e = authoring(documentOf([limb(true), limb()], i => [260 + i * 220, 170]));
  joint(e, 22, 1); e.setOrigin(22);
  if (support) { joint(e, 11, 1); e.deleteSingleSegment({preserveEndpoints: true}); }
  e.select(2); e.joinTo(1, 55);
  nextKey(e, 14); e.select(1); e.rotateSelection(0.7); e.moveSelection(30, -15);
  e.seek(9); e.select(1); e.rotateSelection(-1.1); joint(e, 66, 1); e.rotateJoint(0.6);
  e.addAnimationKeys([key(figure(1), 'rotation', 4, 1.4), key(figure(1), 'x', 6, 330), key(figure(1), 'y', 11, 120), key(figure(1), 'scale', 12, 1.3)]);
  const document = e.serialize();
  // Written by hand: the joined figure keeps its native pose and turns with its parent's joint.
  dropChannel(document, 'figure:2:pose');
  return {document, ticks: every(0, 15)};
}

/** Removes a channel the editor added along with the one a fixture is about. */
function dropChannel(document, id) {
  const channels = document._styk.animation.channels, at = channels.findIndex(c => c.id === id);
  if (at < 0) throw new Error(`no channel ${id}`);
  channels.splice(at, 1);
}

/** The fields that make a fixture differ from its channels' absence, for a quick look. */
function summary(document) {
  const nested = doc => [...(doc._styk?.animation?.channels ?? []), ...doc.figure_types.flatMap(f => f._styk?.movieclip?.document ? nested(f._styk.movieclip.document) : [])];
  const channels = nested(document);
  return [...new Set(channels.map(c => `${c.target.kind}:${c.property.startsWith('vfx1:') ? 'vfx1' : c.property}`))].join(' ');
}

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(Object.keys(fixtures).join('\n')); process.exit(0); }
const outAt = args.indexOf('--out');
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/channels` : args[outAt + 1]);
const names = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
for (const name of names) if (!fixtures[name]) { console.error(`unknown fixture ${name}`); process.exit(2); }
mkdirSync(out, {recursive: true});
for (const name of names.length ? names : Object.keys(fixtures)) {
  counter = 0;
  const built = await fixtures[name]();
  const options = {vfx: built.vfx, camera: built.camera, scene: built.scene, style: built.style};
  writeReference(writeProject(out, name, built.document, built.ticks, options), `${name} (${summary(built.document)})`);
  writeReference(writeProject(out, name, built.document, built.ticks, {...options, native: true}), `${name}, native timeline`);
  // As the app holds it: the editor gives every document a layer sheet when it loads it.
  const app = new Editor({demo: false, propertyChannels: true, layerTimeline: true}).load(structuredClone(built.document), name);
  writeFileSync(`${out}/${name}.sheet.json`, JSON.stringify(app.serialize()) + '\n');
}
