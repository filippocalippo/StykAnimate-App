#!/usr/bin/env node
// Builds the visual-effect fixtures of the Rust engine with the real
// JavaScript editor: each is a small project (plain JSON, opened like a .styk)
// and what the editor evaluates for it, effects included (tools/reference.mjs
// --vfx). `vectors.json` records inputs and outputs of the pure functions
// (colour interpolation, key sampling, padding, neutral effects).
//
//   node engine/tools/vfx-fixtures.mjs [name ...] [--out <folder>] [--list]
//
// Without names it regenerates every fixture into
// engine/crates/styk-eval/tests/fixtures/vfx/. The Rust test
// engine/crates/styk-eval/tests/vfx.rs compares the engine with each of them.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, repo, repoUrl, emptyDocument, createObject, createFrame, documentOf, limb, open, whole, nextKey, nextSheetKey, writeProject, writeReference} from './fixture-kit.mjs';

const {createVfx, VFX_REGISTRY, vfxProperty, vfxPadding, vfxSamplingPadding, vfxWorkingSlots, neutralVfx, resolvedVfx, activeVfx} = await import(`${repoUrl}/src/vfx.mjs`);
const {interpolateVfxColor} = await import(`${repoUrl}/src/vfx-paint.mjs`);
const {createVfxClip, sampleVfxKeys} = await import(`${repoUrl}/src/vfx-clips.mjs`);

// The editor draws effect and clip identities, and generator seeds, at random.
// Fixtures must be byte-stable: both start again from the same values for each one.
let counter = 0, state = 1;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});
Math.random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
const restart = () => { counter = 0; state = 1; };

// ---------------------------------------------------------------- helpers

const figure = uid => ({kind: 'figure', uid}), scene = {kind: 'scene'};
const node = (uid, handleId, figureTypeId) => ({kind: 'segment', uid, handleId, ...(figureTypeId === undefined ? {} : {figureTypeId})});
const gradient = (type, angle, ...stops) => ({type, angle, stops: stops.map(([offset, color, opacity = 1]) => ({offset, color, opacity}))});
/** An effect record as the editor saves it, with some parameters set. */
const fx = (type, id, params = {}, extra = {}) => { const effect = createVfx(type, id); return {...effect, ...extra, params: {...effect.params, ...params}}; };
/** Appends effects to a pose stack in one editor command: [type, params, extra] each. */
const pose = (e, target, effects) => e.changeVfxStack(target, stack => {
  for (const [type, params, extra] of effects) stack.push(fx(type, `fx-${target.kind}-${stack.length}`, params, extra));
});
/** Changes the parameters of a pose stack's effects by position; `remove` drops some, `add` appends. */
const repose = (e, target, edits, {remove = [], add = []} = {}) => e.changeVfxStack(target, stack => {
  stack.forEach((effect, i) => Object.assign(effect.params, edits[i] ?? {}));
  for (const i of [...remove].sort((a, b) => b - a)) stack.splice(i, 1);
  for (const [type, params, extra] of add) stack.push(fx(type, `fx-${target.kind}-added-${stack.length}`, params, extra));
});
const clipOf = (e, id) => e.getVfxClips().find(clip => clip.id === id);
/** Keys `values` ([tick, value] in document ticks) on one parameter of a clip's effect. */
function keys(e, id, index, param, values, interpolation) {
  const clip = clipOf(e, id), effect = clip.effects[index];
  for (const [tick, value] of values) e.setVfxClipParameter(id, effect.id, param, value, {key: true, tick});
  if (interpolation) for (const key of clipOf(e, id).keys[vfxProperty(effect.type, effect.id, param)]) e.setVfxClipEasing(id, vfxProperty(effect.type, effect.id, param), key.tick, interpolation);
}
/** Sets parameters of a clip's effect without keys. */
function set(e, id, index, params) {
  const effect = clipOf(e, id).effects[index];
  for (const [param, value] of Object.entries(params)) e.setVfxClipParameter(id, effect.id, param, value);
}
const sheet = (figures, place) => open(documentOf(figures, place), {layerTimeline: true});
const row = (count, length = 60) => Array.from({length: count}, () => [[11, 0, length, 1.2]]);

// --------------------------------------------------------------- fixtures

const fixtures = {
  /** Every object filter on one figure, with a node stack and a scene stack,
   * all tweened between two keys of a layer sheet: numbers and colours
   * interpolate (gradients too), modes hold, an effect removed at the second
   * key holds and one added there is not introduced early. A neutral tint
   * appears as it tweens away from zero; a disabled blur never does. */
  'pose-sheet': () => {
    const e = sheet([limb(), limb()], i => [220 + i * 220, 150]), layer = e.layerForUid(1);
    pose(e, figure(1), [
      ['tint', {color: 0x3366ff, mix: .4}],
      ['glow', {color: gradient('linear', 30, [0, [255, 80, 20]], [1, [40, 90, 255], .6]), radius: 18, intensity: 1.2, mode: 2, spread: 3, falloff: 1.5, coreColor: 0xffeeaa, coreMix: .3, blend: 1}],
      ['outline', {color: 0x202020, width: 4, opacity: .8, mode: 1, rounded: 0, only: 1}],
      ['shadow', {color: 0x102030, radius: 10, offsetX: -12, offsetY: 6, opacity: .7, spread: 2, mode: 1}],
      ['blur', {mode: 1, radius: 6, angle: 30, centerX: .3, centerY: .6}],
      ['grade', {exposure: .5, contrast: 1.2, saturation: .8, temperature: .2, tint: -.1, shadows: .1, highlights: -.2, gamma: 1.1}],
      ['pixelate', {size: 6, linked: 0, sizeY: 10, offsetX: 3, offsetY: -2}],
      ['noise', {amount: .2, size: 3, colored: 1, pattern: 1, contrast: 1.5, softness: .2, seed: 7, phase: 12}],
      ['dissolve', {progress: .5, size: 30, edge: .1, color: 0x00ff88, softness: .05, seed: 3}],
      ['rgbSplit', {amount: 5, angle: 45, red: 1.5, green: -.5, blue: -1.2}],
      ['wave', {strength: 6, wavelength: 50, angle: 20, phase: 90}],
      ['bloom', {threshold: .5, softness: .3, radius: 12, intensity: 1.1, color: 0xffddcc}],
      ['lightSweep', {position: .2, angle: 40, width: .3, softness: .4, intensity: 1.3, color: 0xaaffee}],
      ['turbulence', {amount: 9, size: 40, evolution: 2.5, detail: 2, seed: 11}],
      ['tint', {mix: 0}],
      ['blur', {radius: 8}, {enabled: false}],
    ]);
    pose(e, node(1, 22, 1), [['glow', {radius: 6, intensity: 1.5, effectStrength: .5}], ['outline', {width: 2, color: 0xff0000, mode: 2}]]);
    pose(e, scene, [
      ['vignette', {amount: .5, softness: .3, color: 0x200010, centerX: .4, centerY: .45, roundness: .7, aspect: 1.5, radius: 1.2}],
      ['shockwave', {radius: 120, thickness: 30, strength: -20, centerX: .6, centerY: .4, falloff: 2}],
      ['crt', {amount: .3, spacing: 4, curvature: .1, chromatic: 3, phase: 2, color: 0x102010}],
      ['grade', {exposure: -.3, gamma: 1.4}],
    ]);
    nextSheetKey(e, 8, 1); e.sheetInsertKey(['scene'], 8);
    repose(e, figure(1), {
      0: {color: 0x00ff00, mix: .9},
      1: {color: gradient('linear', 120, [.2, [0, 255, 120], .9], [1, [255, 255, 0]]), radius: 30, intensity: .4, mode: 0, spread: 9, falloff: .5, coreColor: gradient('radial', 0, [0, [255, 255, 255]], [1, [0, 0, 0], .2]), coreMix: .9, blend: 2},
      2: {color: 0xeeeeee, width: 10, opacity: .2, mode: 2, rounded: 1, only: 0},
      3: {offsetX: 30, offsetY: -40, opacity: .1, radius: 2},
      4: {radius: 20, angle: -60, mode: 3},
      5: {exposure: -1, contrast: .5, gamma: 2.5},
      6: {size: 20, sizeY: 2, linked: 1},
      7: {amount: .7, seed: 99, phase: 400},
      9: {amount: 40, red: -2, blue: 2},
      10: {strength: 30, phase: -180},
      11: {color: gradient('linear', 0, [0, [255, 0, 0]], [1, [0, 0, 255]]), intensity: 2.5},
      12: {position: 1.4, color: 0x000000},
      13: {amount: 100, evolution: -50},
      14: {mix: .6},
      15: {radius: 40},
    }, {remove: [8], add: [['glow', {radius: 40, color: 0x123456}]]});
    repose(e, node(1, 22, 1), {0: {radius: 30, effectStrength: 1}, 1: {width: 12, color: 0x0000ff}});
    repose(e, scene, {0: {amount: .9, color: 0xffffff, aspect: .5}, 1: {radius: 900, strength: 100}, 2: {curvature: .4, chromatic: 10}, 3: {exposure: 1}});
    e.sheetSetEasing([layer], 0, 7, {interpolation: 'linear'});
    e.sheetSetEasing(['scene'], 0, 7, {interpolation: 'ease-in'});
    return {document: e.serialize(), ticks: [0, 2, 4, 5, 7, 8]};
  },
  /** Per-pose stacks on a native timeline, written as older projects saved
   * them: linear, ease-in, Auto and held keyframes; a version 1 outline (no
   * rounded corners); an identity whose type changes (it holds); a scene stack
   * on the keyframes; and a figure whose stack starts at the second key. */
  'pose-native': () => {
    const document = documentOf([limb(), limb()], i => [220 + i * 220, 150]), [a] = document.keyframes;
    a.objects[0]._stykVfx = {
      figure: [fx('glow', 'g', {radius: 10, color: 0x112233, coreColor: gradient('linear', 10, [0, [255, 0, 0]], [1, [0, 255, 0]]), coreMix: .5}),
        fx('blur', 'b', {radius: 2, mode: 2, centerX: .2}),
        {version: 1, id: 'legacy', type: 'outline', enabled: true, params: {color: 0x445566, width: 2, opacity: 1}},
        fx('tint', 'swap', {mix: .3})],
      '1/22': [fx('shadow', 's', {offsetX: 4, color: 0x330000})],
    };
    a._stykVfx = {figure: [fx('vignette', 'v', {amount: .3}), fx('crt', 'c', {curvature: .1, chromatic: 2})]};
    a.duration_raw = 6; a._styk = {easing: {interpolation: 'linear'}};
    const b = structuredClone(a);
    b.objects[0].root_x += 40;
    Object.assign(b.objects[0]._stykVfx.figure[0].params, {radius: 30, color: 0x8899aa, coreColor: gradient('linear', 70, [0, [0, 0, 255]], [1, [255, 255, 255], .3]), coreMix: .1});
    Object.assign(b.objects[0]._stykVfx.figure[1].params, {radius: 9, mode: 3, centerX: .8});
    b.objects[0]._stykVfx.figure[2] = fx('outline', 'legacy', {color: 0x998877, width: 6, rounded: 1});
    b.objects[0]._stykVfx.figure[3] = fx('blur', 'swap', {radius: 12});
    b.objects[0]._stykVfx['1/22'][0].params.offsetX = -20;
    b.objects[1]._stykVfx = {figure: [fx('pixelate', 'late', {size: 12})]};
    Object.assign(b._stykVfx.figure[0].params, {amount: .8}); Object.assign(b._stykVfx.figure[1].params, {curvature: .3, chromatic: 0});
    b.duration_raw = 4; b._styk = {easing: {interpolation: 'ease-in'}};
    const c = structuredClone(b);
    c.objects[0].root_y -= 30; c.objects[0]._stykVfx.figure[0].params.radius = 5; c.objects[1]._stykVfx.figure[0].params.size = 2;
    c._stykVfx.figure[0].params.amount = .1;
    c.duration_raw = 4; c._styk = {easing: {interpolation: 'auto'}};
    const d = structuredClone(c);
    d.objects[0].root_x -= 50; d.objects[0]._stykVfx.figure[0].params.radius = 50; d._stykVfx.figure[0].params.amount = 1;
    d.duration_raw = 4; d._styk = {easing: {interpolation: 'auto'}};
    const last = structuredClone(d); last.objects[0]._stykVfx.figure[0].params.radius = 1; last.duration_raw = 1;
    document.keyframes = [a, b, c, d, last];
    return {document: open(document).serialize(), ticks: [0, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 18]};
  },
  /** Effect clips on figures: a timed tint with fades, partial strength and
   * keyed mix and colour; an "Always" glow with gradient, solid-to-gradient
   * and on/off keys; a trimmed group (a preset) with a disabled, a neutral and
   * a weaker effect; held keys; a disabled clip and a clip at zero strength. */
  'clips': () => {
    const e = sheet([limb(), limb()], i => [220 + i * 220, 150]);
    const tint = e.addVfxClip(figure(1), 'tint', {start: 2, duration: 12});
    e.setVfxClip(tint, {fadeIn: 3, fadeOut: 4, strength: .6});
    keys(e, tint, 0, 'mix', [[2, .2], [10, .9]]);
    keys(e, tint, 0, 'color', [[2, 0xff0000], [12, 0x00ff80]], 'ease-in');
    const glow = e.addVfxClip(figure(1), 'glow');
    keys(e, glow, 0, 'radius', [[0, 8], [6, 24]], 'bezier');
    keys(e, glow, 0, 'color', [[0, gradient('linear', 0, [0, [255, 0, 0]], [1, [0, 0, 255], .5])], [8, gradient('linear', 90, [.3, [0, 255, 0], .8], [1, [255, 255, 255]])]]);
    keys(e, glow, 0, 'coreColor', [[0, 0xffffff], [8, gradient('linear', 45, [0, [20, 20, 20]], [.5, [200, 100, 0]], [1, [0, 100, 200], .4])]], 'ease-out');
    set(e, glow, 0, {coreMix: .4, intensity: 1.4});
    keys(e, glow, 0, 'enabled', [[0, 1], [9, 0]]);
    const group = e.addVfxGroup(figure(1), 'Hologram', {start: 4, duration: 10});
    e.trimVfxClipStart(group, 6);
    set(e, group, 0, {mix: 0});
    set(e, group, 1, {enabled: 0});
    set(e, group, 2, {effectStrength: .5});
    keys(e, group, 3, 'effectStrength', [[6, 1], [12, .2]]);
    const held = e.addVfxClip(figure(2), 'shadow', {start: 0, duration: 12});
    keys(e, held, 0, 'offsetX', [[0, 0], [5, 20], [9, -10]], 'constant');
    keys(e, held, 0, 'color', [[0, 0x000000], [6, 0x0000ff]], 'constant');
    const disabled = e.addVfxClip(figure(1), 'blur'); e.setVfxClip(disabled, {enabled: false});
    const silent = e.addVfxClip(figure(2), 'outline'); e.setVfxClip(silent, {strength: 0});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6, 8, 9, 11, 13, 14, 16]};
  },
  /** Scene effects: the scene's own stack, then its clips in order: a keyed
   * shockwave fading out, a curved CRT fading in at partial strength, an
   * "Always" light sweep and a short RGB split. */
  'scene-clips': () => {
    const e = sheet([limb()]);
    pose(e, scene, [['grade', {saturation: 1.4}], ['vignette', {amount: .3, softness: .5}]]);
    const shock = e.addVfxClip(scene, 'shockwave', {start: 1, duration: 10});
    e.setVfxClip(shock, {fadeOut: 3});
    keys(e, shock, 0, 'radius', [[1, 0], [10, 400]]);
    set(e, shock, 0, {thickness: 40, strength: -30, centerX: .3, falloff: 2});
    const crt = e.addVfxClip(scene, 'crt', {start: 3, duration: 8});
    e.setVfxClip(crt, {fadeIn: 2, strength: .8});
    set(e, crt, 0, {curvature: .2, chromatic: 4, phase: 3, spacing: 4, amount: .4, color: 0x003300});
    const sweep = e.addVfxClip(scene, 'lightSweep');
    keys(e, sweep, 0, 'position', [[0, -.5], [12, 1.5]]);
    const split = e.addVfxClip(scene, 'rgbSplit', {start: 5, duration: 2});
    set(e, split, 0, {amount: 12, green: 2});
    return {document: e.serialize(), ticks: [0, 1, 2, 3, 4, 6, 8, 10, 11, 12]};
  },
  /** Node effects: pose stacks and clips scoped to a figure definition, an
   * unscoped stack and clip (saved under `*` and never drawn) and a clip
   * scoped to another definition (skipped). */
  'segments': () => {
    const e = sheet([limb(), limb()], i => [220 + i * 220, 150]);
    pose(e, node(1, 22, 1), [['glow', {radius: 5}]]);
    pose(e, node(1, 11), [['tint', {mix: .8}]]);
    pose(e, node(2, 33, 2), [['outline', {width: 5}]]);
    const scoped = e.addVfxClip(node(1, 22, 1), 'blur', {start: 0, duration: 6}); set(e, scoped, 0, {radius: 3});
    e.addVfxClip(node(1, 33), 'tint', {start: 0, duration: 6});
    e.addVfxClip(node(1, 11, 2), 'glow', {start: 0, duration: 6});
    const late = e.addVfxClip(node(2, 33, 2), 'bloom', {start: 2, duration: 3, includeAttached: true}); set(e, late, 0, {radius: 30});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 6]};
  },
  /** Connected effects: a figure with three attached parts whose own stack
   * covers them (pose scope), a timed clip that includes them, a clip of the
   * root alone, a nested group on an attached part and a lone figure whose
   * group is itself. */
  'attached': () => {
    const e = sheet([limb(), [[11, 0, 60, 1.2]], [[11, 0, 40, .4]], [[11, 0, 50, 2.2]], limb()], i => [140 + i * 90, 160]);
    e.select(2); e.joinTo(1, 22); e.select(3); e.joinTo(2, 11); e.select(4); e.joinTo(1, 33);
    pose(e, figure(1), [['outline', {width: 2}], ['tint', {mix: .3}]]);
    e.setVfxScope(figure(1), true);
    pose(e, figure(2), [['glow', {radius: 7}]]);
    pose(e, figure(4), [['pixelate', {size: 3}]]);
    e.addVfxClip(figure(1), 'shadow', {start: 2, duration: 6, includeAttached: true});
    e.addVfxClip(figure(1), 'blur', {start: 0, duration: 10});
    e.addVfxClip(figure(2), 'bloom', {start: 4, duration: 6, includeAttached: true});
    e.addVfxClip(figure(5), 'wave', {start: 0, duration: 4, includeAttached: true});
    return {document: e.serialize(), ticks: [0, 1, 2, 4, 5, 7, 8, 9, 11]};
  },
  /** Written by hand: eighteen figures in a chain, each covering its attached
   * parts. Connected groups nest at most sixteen deep; the two innermost
   * figures keep their effects to themselves. The editor refuses to create
   * such a chain but evaluates one. */
  'deep-scope': () => {
    const document = documentOf([[[1, 0, 24, .3]]]), type = document.figure_types[0];
    const objects = Array.from({length: 18}, (_, i) => createObject(type, i + 1, 120 + i * 30, 200, {
      _stykVfxScope: 1, _stykVfx: {figure: [fx('tint', `t${i + 1}`, {mix: (i + 1) / 20})]},
      ...(i ? {join: {target_object_slot: i - 1, target_unique_id: i, target_handle_id: 1}} : {})}));
    document.keyframes = [createFrame(objects, 1)];
    return {document: open(document).serialize(), ticks: [0]};
  },
  /** Movieclip containers: the clip's own scene stack (tweened) and scene
   * clip apply to the container before the instance's figure stack and clips.
   * The captured clip keeps its own keyframes only: the engine does not read a
   * capture's retained source curves (`movieclipSource`) yet. */
  'movieclip': () => {
    const source = open(documentOf([limb()]));
    nextKey(source, 6); whole(source).moveSelection(40, -24);
    source.seek(0); source.select(1);
    const clip = source.createMovieclip({start: 0, end: 7, replace: false}), inner = clip._styk.movieclip.document;
    delete inner._styk.movieclipSource;
    for (const frame of inner.keyframes) delete frame._styk?.movieclipSourceTick;
    inner.keyframes[0]._stykVfx = {figure: [fx('tint', 'inner-tint', {mix: .2, color: 0x00ffaa})]};
    inner.keyframes.at(-1)._stykVfx = {figure: [fx('tint', 'inner-tint', {mix: .8, color: 0xaa00ff})]};
    const wave = createVfxClip(scene, 'wave', 'inner-wave', 'inner-wave-fx', {start: 1, duration: 3});
    wave.effects[0].params.strength = 20;
    inner._styk = {...inner._styk, vfxClips: {version: 1, clips: [wave]}};
    const instance = (uid, x, extra = {}) => createObject(clip, uid, x, 220, {angles: [0], _stykMovieclip: {start: 0, end: 20, offset: uid === 8 ? 2 : 0, speed: 1, mode: 'loop'}, ...extra});
    const document = {...emptyDocument(), figure_types: [clip], keyframes: [
      createFrame([instance(7, 300), instance(8, 520, {_stykVfx: {figure: [fx('outline', 'own', {width: 3})]}})], 8),
      createFrame([instance(7, 340), instance(8, 520, {_stykVfx: {figure: [fx('outline', 'own', {width: 9})]}})], 1)]};
    document.keyframes[0]._styk = {easing: {interpolation: 'linear'}};
    const e = open(document, {layerTimeline: true});
    const glow = e.addVfxClip(figure(7), 'glow', {start: 2, duration: 4}); set(e, glow, 0, {radius: 20});
    return {document: e.serialize(), ticks: [0, 1, 2, 3, 4, 5, 7]};
  },
  /** Generated effects: carried with their resolved parameters, opacity and
   * start, never simulated. Fades, keyed rates, a start delay, a disabled and
   * an invisible effect inside a group, scene and figure targets, and a clip
   * mixing a generator with a filter. */
  'generators': () => {
    const e = sheet([limb(), limb()], i => [220 + i * 220, 150]);
    const particles = e.addVfxClip(figure(1), 'particles', {start: 2, duration: 10});
    e.setVfxClip(particles, {fadeIn: 2, fadeOut: 3, strength: .7});
    keys(e, particles, 0, 'rate', [[2, 4], [8, 20]]);
    set(e, particles, 0, {look: 8, color: gradient('linear', 0, [0, [255, 200, 0]], [1, [255, 0, 0], .2]), shape: 2, size: 12, gravity: .5, trail: 2, outline: 1, colorMode: 1, space: 1, step: 1});
    e.addVfxGroupEffect(particles, 'glow');
    set(e, particles, 1, {radius: 14});
    const aura = e.addVfxClip(figure(2), 'aura', {start: 0, duration: 20});
    set(e, aura, 0, {style: 3, color: 0xffe7a0, intensity: 1.5, height: 2, dust: 1, embers: 0, blend: 2, delay: 4});
    const beam = e.addVfxClip(scene, 'beam', {start: 5, duration: 8});
    set(e, beam, 0, {style: 4, aimX: .7, aimY: .3, width: 30, arcs: 5, sparks: 2, orb: 0, x: .2, y: .6});
    keys(e, beam, 0, 'intensity', [[5, .5], [9, 2]]);
    const smoke = e.addVfxClip(figure(1), 'smoke', {start: 0, duration: null});
    set(e, smoke, 0, {style: 1, amount: 8, rise: -2, life: 30, emission: 1, count: 40, growth: 5});
    const boom = e.addVfxClip(scene, 'explosion', {start: 8, duration: 6});
    set(e, boom, 0, {style: 5, size: 2, debris: 3, sparks: 0, x: .5, y: .8});
    e.setVfxClip(boom, {fadeOut: 2});
    e.addVfxGroupEffect(boom, 'particles'); set(e, boom, 1, {enabled: 0});
    e.addVfxGroupEffect(boom, 'smoke'); set(e, boom, 2, {effectStrength: 0});
    e.addVfxGroupEffect(boom, 'aura'); set(e, boom, 3, {delay: 7});
    return {document: e.serialize(), ticks: [0, 2, 3, 5, 8, 10, 12, 13, 15]};
  },
};

// ---------------------------------------------------------- pure functions

/** Inputs and outputs of the arithmetic the fixtures cannot reach exhaustively. */
function vectors() {
  const paints = [0x102030, 0xff8800,
    gradient('linear', 0, [0, [255, 0, 0]], [1, [0, 0, 255]]),
    gradient('linear', 90, [0, [10, 200, 30], .5], [1, [250, 250, 250]]),
    gradient('radial', 0, [0, [0, 0, 0]], [.5, [128, 64, 32], .3], [1, [255, 255, 255]]),
    {type: 'solid', angle: 0, stops: [{offset: 0, color: [200, 100, 50], opacity: .4}]},
    {type: 'solid', angle: 15, stops: [{offset: .2, color: [1, 2, 3], opacity: 1}, {offset: .9, color: [90, 80, 70], opacity: .5}]},
    gradient('linear', -45, [.7, [9, 9, 9]], [.1, [200, 10, 10]]),
    gradient('angular', 400, [0, [3.4, 250.6, 7], .25], [1, [40, 50, 60]]),
    gradient('diamond', 0, [0, [0, 255, 0]], [.4, [0, 0, 255], .5], [.6, [255, 0, 0]])];
  const colors = [];
  for (const a of paints) for (const b of paints) for (const t of [.25, .5, .9]) colors.push({a, b, t, value: interpolateVfxColor(a, b, t)});
  const keysCases = [];
  const numeric = vfxProperty('glow', 'k', 'radius'), color = vfxProperty('glow', 'k', 'color'), mode = vfxProperty('glow', 'k', 'mode');
  const curves = [{interpolation: 'linear'}, {interpolation: 'ease-in'}, {interpolation: 'ease-out'}, {interpolation: 'auto'},
    {interpolation: 'bezier'}, {interpolation: 'bezier', bezier: [.1, .9, .2, 1]}, {interpolation: 'constant'}, {interpolation: 'hold'}, {}];
  for (const curve of curves) {
    const table = [{tick: 2, value: 4, ...curve}, {tick: 10, value: 100, ...curve}, {tick: 11, value: 30, ...curve}];
    for (const tick of [0, 2, 3.5, 6, 9.999, 10, 10.5, 12]) keysCases.push({property: numeric, keys: table, tick, value: sampleVfxKeys(table, tick, -1, numeric)});
    const tints = [{tick: 0, value: 0x204060, ...curve}, {tick: 4, value: gradient('linear', 30, [0, [255, 255, 255]], [1, [0, 0, 0], .5]), ...curve}];
    for (const tick of [1, 2.5]) keysCases.push({property: color, keys: tints, tick, value: sampleVfxKeys(tints, tick, 0, color)});
  }
  const modes = [{tick: 0, value: 0, interpolation: 'constant'}, {tick: 5, value: 2, interpolation: 'constant'}];
  for (const tick of [0, 4.9, 5, 7]) keysCases.push({property: mode, keys: modes, tick, value: sampleVfxKeys(modes, tick, 0, mode)});
  const stacks = [
    [fx('blur', 'a', {radius: .4}), fx('blur', 'b', {radius: 47}), fx('blur', 'c', {radius: 130 / 2, mode: 1})],
    [fx('glow', 'a', {radius: 33, spread: 5}), fx('shadow', 'b', {radius: 3, offsetX: -40, offsetY: 12, spread: 1.5}), fx('bloom', 'c', {radius: 64})],
    [fx('outline', 'a', {width: 7.3, mode: 2}), fx('pixelate', 'b', {size: 3, linked: 0, sizeY: 17}), fx('rgbSplit', 'c', {amount: 9, red: .3, blue: -1.7})],
    [fx('turbulence', 'a', {amount: 21}), fx('wave', 'b', {strength: 13.5}), fx('shockwave', 'c', {strength: -77})],
    [fx('crt', 'a', {curvature: .25, chromatic: 6}), fx('blur', 'b', {radius: 20, mode: 2})],
    [fx('crt', 'a', {chromatic: 3}), fx('tint', 'b', {effectStrength: .4}), fx('blur', 'c', {radius: 0})],
    [fx('outline', 'a', {width: 0, only: 1})],
  ];
  const padding = [];
  for (const stack of stacks) for (const scale of [.3, 1, 2.5]) for (const extent of [0, 800]) {
    const slots = vfxWorkingSlots(stack);
    padding.push({stack, scale, extent, padding: vfxPadding(stack, scale, extent), sampling: vfxSamplingPadding(stack, scale, extent), slots: slots.gpu, active: activeVfx(stack).map(e => e.id)});
  }
  const neutral = [];
  for (const type of Object.keys(VFX_REGISTRY)) neutral.push({effect: fx(type, 'n'), neutral: neutralVfx(resolvedVfx(fx(type, 'n')))});
  for (const effect of [fx('outline', 'n', {width: 0, only: 1}), fx('outline', 'n', {opacity: 0}), fx('pixelate', 'n', {size: 1, linked: 0, sizeY: 2}),
    fx('pixelate', 'n', {size: 1, linked: 0, sizeY: 1}), fx('grade', 'n', {gamma: 1.01}), fx('crt', 'n', {amount: 0}), fx('crt', 'n', {amount: 0, chromatic: 1}),
    fx('glow', 'n', {intensity: 0}), fx('glow', 'n', {intensity: 0, coreMix: 0}), fx('tint', 'n', {effectStrength: 0, mix: 1}), fx('shockwave', 'n', {strength: 0})])
    neutral.push({effect, neutral: neutralVfx(resolvedVfx(effect))});
  return {colors, keys: keysCases, padding, neutral};
}

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log([...Object.keys(fixtures), 'vectors'].join('\n')); process.exit(0); }
const outAt = args.indexOf('--out');
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/vfx` : args[outAt + 1]);
const names = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
for (const name of names) if (!fixtures[name] && name !== 'vectors') { console.error(`unknown fixture ${name}`); process.exit(2); }
mkdirSync(out, {recursive: true});
if (!names.length || names.includes('vectors')) {
  const cases = vectors();
  writeFileSync(`${out}/vectors.json`, JSON.stringify(cases) + '\n');
  console.log(`vectors: ${cases.colors.length} colours, ${cases.keys.length} key samples, ${cases.padding.length} paddings, ${cases.neutral.length} neutral checks`);
}
for (const name of (names.length ? names : Object.keys(fixtures)).filter(name => name !== 'vectors')) {
  restart();
  const built = fixtures[name]();
  writeReference(writeProject(out, name, built.document, built.ticks, {vfx: true}), name);
}
