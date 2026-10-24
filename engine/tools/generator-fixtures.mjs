#!/usr/bin/env node
// Builds the generated-effect fixtures of the Rust engine with the real
// JavaScript editor: each is a small project (plain JSON, opened like a .styk)
// and, per tick, what the editor computes for its generated effects: the batch
// the renderers draw (`buildGeneratorBatch` with an exact anchor sampler:
// records, birth table and draws) and every live particle of every draw
// (`evaluateParticle`), beam and lightning arc. `atlas.json` holds a hash of
// every material row and reduced level (`atlasRow`).
//
//   node engine/tools/generator-fixtures.mjs [name ...] [--list]
//
// Without names it regenerates every fixture into
// engine/crates/styk-eval/tests/fixtures/generators/. The Rust test
// engine/crates/styk-eval/tests/generators.rs compares the engine with them.
// Regeneration is byte-stable: identities and seeds start again from the same
// values for each fixture.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, repo, repoUrl, documentOf, limb, open, whole, nextKey, nextSheetKey, prune, createObject, createFrame, emptyDocument} from './fixture-kit.mjs';

const {buildGeneratorBatch, evaluateParticle, rampColor, beamTip, beamWidth, steppedTime, RECORD_FLOATS, SHAPE} = await import(`${repoUrl}/src/vfx-generators.mjs`);
const {GeneratorAnchors} = await import(`${repoUrl}/src/vfx-generator-anchors.mjs`);
const {atlasRow, ATLAS_ROWS} = await import(`${repoUrl}/src/vfx-generator-atlas.mjs`);
const {createVfxClip} = await import(`${repoUrl}/src/vfx-clips.mjs`);
const {createVfx} = await import(`${repoUrl}/src/vfx.mjs`);
const {hash: particleHash, pcg} = await import(`${repoUrl}/src/vfx-generators.mjs`);

let counter = 0, state = 1;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});
Math.random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
const restart = () => { counter = 0; state = 1; };

// ---------------------------------------------------------------- helpers

const figure = uid => ({kind: 'figure', uid}), scene = {kind: 'scene'};
const node = (uid, handleId, figureTypeId) => ({kind: 'segment', uid, handleId, ...(figureTypeId === undefined ? {} : {figureTypeId})});
const gradient = (type, angle, ...stops) => ({type, angle, stops: stops.map(([offset, color, opacity = 1]) => ({offset, color, opacity}))});
const clipOf = (e, id) => e.getVfxClips().find(clip => clip.id === id);
/** Sets parameters of a clip's effect without keys. */
function set(e, id, index, params) {
  const effect = clipOf(e, id).effects[index];
  for (const [param, value] of Object.entries(params)) e.setVfxClipParameter(id, effect.id, param, value);
}
/** Keys `values` ([tick, value] in document ticks) on one parameter of a clip's effect. */
function keys(e, id, index, param, values) {
  const effect = clipOf(e, id).effects[index];
  for (const [tick, value] of values) e.setVfxClipParameter(id, effect.id, param, value, {key: true, tick});
}
/** An editor over `count` figures on a layer sheet, in a row. */
const sheet = (figures, place) => open(documentOf(figures, place), {propertyChannels: true, layerTimeline: true});
/** Moves figure `uid` by (dx, dy) at a new sheet key `tick`: trails sample its earlier positions. */
function move(e, uid, tick, dx, dy) { nextSheetKey(e, tick, uid); whole(e, uid).moveSelection(dx, dy); }
const row = (count, length = 60) => Array.from({length: count}, () => [[11, 0, length, 1.2], [22, 11, length * .8, 2.2]]);

// --------------------------------------------------------------- fixtures

const fixtures = {
  /** Every aura style on its own figure, each figure walking across the stage
   * so trails read earlier positions; ground effects, toggled layers, blends
   * and a start delay. A dark scene: Auto layers add light. */
  'auras': () => {
    const e = sheet(Array.from({length: 8}, () => limb()), i => [80 + i * 110, 230]);
    e.setBackgroundColor(0xff101018);
    for (let uid = 1; uid <= 8; uid++) move(e, uid, 10, 30 + uid * 4, -12);
    for (let i = 0; i < 8; i++) {
      const id = e.addVfxClip(figure(i + 1), 'aura', {start: i % 3, duration: 18});
      set(e, id, 0, {style: i, density: .45, height: 1 + (i % 3) * .4, turbulence: .5 + i * .2, intensity: 1 + i * .1});
      if (i % 2 === 0) set(e, id, 0, {dust: 1});
      if (i === 3) set(e, id, 0, {flames: 0, blend: 1});
      if (i === 5) set(e, id, 0, {trail: 0, embers: 0, glow: 0});
      if (i === 6) set(e, id, 0, {blend: 2, step: 1});
      if (i === 7) set(e, id, 0, {delay: 3});
      e.setVfxClip(id, {fadeIn: 2, fadeOut: 3, strength: .9});
    }
    return {document: e.serialize(), ticks: [4, 9, 13, 19]};
  },
  /** Beams in every style: from figures and from the scene, aimed at a stage
   * point and at nodes, with charge particles, arcs, sparks and splashes;
   * fire breath streams toward its aim. A light scene: Auto layers paint solid
   * and borrow saturated colours for white stops. */
  'beams': () => {
    const e = sheet([limb(), limb(), limb()], i => [140 + i * 280, 250]);
    move(e, 1, 6, 20, -30);
    const styles = [[0, figure(1)], [1, figure(2)], [2, figure(3)], [3, scene], [4, figure(1)], [5, figure(2)]];
    for (const [style, target] of styles) {
      const id = e.addVfxClip(target, 'beam', {start: style, duration: 16});
      const applied = [{color: 0x4fd2ff, width: 16, wobble: 1, charge: 6, travel: 6, arcs: 3}, {color: 0xff3148, width: 6, wobble: 0, charge: 4, travel: 2, arcs: 0},
        {color: 0xffd23c, width: 22, wobble: .6, charge: 5, travel: 5, arcs: 0}, {color: 0xb06bff, width: 18, wobble: .8, charge: 4, travel: 6, arcs: 2},
        {color: 0xa47cff, width: 7, wobble: 2.4, charge: 0, travel: 2, arcs: 6}, {color: 0xff7a1a, width: 26, wobble: 1, charge: 4, travel: 8, arcs: 0}][style];
      set(e, id, 0, {style, ...applied, sparks: style === 2 ? 0 : .6, aimX: .9 - style * .05, aimY: .2 + style * .1, x: .2, y: .5});
      if (style === 1) set(e, id, 0, {aimUid: 3, aimHandle: 22});
      if (style === 5) set(e, id, 0, {aimUid: 3});
      if (style === 3) set(e, id, 0, {splash: 0, layer: 1});
      e.setVfxClip(id, {fadeOut: style * 2});
    }
    return {document: e.serialize(), ticks: [3, 7, 11, 15]};
  },
  /** Every explosion style, from figures (bursting at the figure's centre) and
   * from the scene (at a stage position, dust on its own ground), with a
   * gradient colour (fireworks and magic pick one colour per particle), smoke,
   * debris and ring toggles, animate on twos and a delay. */
  'explosions': () => {
    const e = sheet(Array.from({length: 5}, () => limb()), i => [120 + i * 180, 240]);
    e.setBackgroundColor(0xff08080c);
    for (let style = 0; style < 10; style++) {
      const target = style % 2 ? scene : figure(1 + (style >> 1));
      const id = e.addVfxClip(target, 'explosion', {start: style % 3, duration: 24});
      set(e, id, 0, {style, size: .6 + style * .05, density: .35, debris: style === 3 ? 0 : .5, smoke: style % 4 ? .5 : 0, x: .1 + style * .08, y: .4 + (style % 3) * .1});
      if (style === 5 || style === 7) set(e, id, 0, {color: gradient('linear', 0, [0, [255, 80, 120]], [.5, [255, 200, 60]], [1, [70, 170, 255]])});
      if (style === 9) set(e, id, 0, {step: 1});
      if (style === 2) set(e, id, 0, {ring: 0, flash: 0, delay: 2});
      if (style === 4) set(e, id, 0, {sparks: 0, dust: 0});
    }
    return {document: e.serialize(), ticks: [2, 6, 12, 22]};
  },
  /** Smoke in every style: continuous with a keyed amount and wind, bursts,
   * following its target or leaving a trail, dust on the ground, from the scene. */
  'smoke': () => {
    const e = sheet([limb(), limb(), limb()], i => [160 + i * 260, 260]);
    move(e, 1, 8, 60, 0);
    const a = e.addVfxClip(figure(1), 'smoke', {start: 0, duration: 20});
    set(e, a, 0, {style: 0, life: 18, size: 16, wind: 1.5});
    keys(e, a, 0, 'amount', [[0, 1], [10, 4], [16, 0]]);
    const b = e.addVfxClip(figure(2), 'smoke', {start: 2, duration: 16});
    set(e, b, 0, {style: 1, emission: 1, count: 24, life: 20, growth: 4, space: 1});
    const c = e.addVfxClip(figure(3), 'smoke', {start: 0, duration: null});
    set(e, c, 0, {style: 4, amount: 1.5, life: 14, spread: 30, layer: 1});
    const d = e.addVfxClip(scene, 'smoke', {start: 1, duration: 14});
    set(e, d, 0, {style: 2, amount: 2, life: 16, x: .3, y: .8, rise: 3, shading: .6});
    const t = e.addVfxClip(figure(2), 'smoke', {start: 4, duration: 10});
    set(e, t, 0, {style: 3, amount: 1, life: 12, size: 30, turbulence: 2});
    return {document: e.serialize(), ticks: [3, 8, 13, 17]};
  },
  /** Particles in every look and emitter: keyed rate, direction, speed and size;
   * circle, body and line emitters, the whole stage edge from the scene; motion
   * trails, glow halos, outlines, random colours, landing on the ground,
   * rotation and size modes, swirl, flow, turbulence, wind and twinkle. */
  'particles': () => {
    const e = sheet(Array.from({length: 6}, () => limb()), i => [90 + i * 150, 220]);
    move(e, 2, 8, -40, 20);
    for (let look = 0; look < 23; look++) {
      const target = look === 17 ? scene : figure(1 + look % 6);
      const id = e.addVfxClip(target, 'particles', {start: look % 4, duration: 14});
      set(e, id, 0, {look, rate: 1.5, life: 10 + look % 5, size: 5 + look % 7, speed: 1 + look * .2, direction: (look * 37) % 360 - 180, spread: 30 + look * 10,
        color: look % 3 ? 0x66ccff + look * 4000 : gradient('linear', 0, [0, [255, 220, 40]], [1, [200, 30, 200], .4]), variation: (look % 5) / 5,
        shape: look % 4, radius: (look % 4) * 15, endSize: .3 + (look % 3) * .5, sizeMode: look % 5, rotation: look % 5, spin: look % 3 ? 4 : 0,
        drag: (look % 2) * .05, wind: look % 3 === 1 ? .2 : 0, turbulence: look % 7 === 3 ? 20 : 0, flow: look % 6 === 4 ? 30 : 0, swirl: look % 8 === 5 ? 6 : 0,
        twinkle: look % 4 === 2 ? .5 : 0, gravity: look % 3 === 2 ? .15 : 0, ground: look % 5 === 4 ? 1 : 0, colorMode: look % 2, blend: look % 3,
        trail: look % 6 === 1 ? 2 : 0, glow: look % 7 === 2 ? .6 : 0, outline: look % 5 === 3 ? 1 : 0, outlineWidth: 1.5, space: look % 2, layer: look % 2});
      if (look === 17) set(e, id, 0, {shape: 3, radius: 0, direction: 90});
      if (look === 5) { keys(e, id, 0, 'rate', [[1, .5], [8, 3]]); keys(e, id, 0, 'direction', [[1, -90], [10, 0]]); keys(e, id, 0, 'size', [[1, 4], [10, 12]]); }
      if (look === 9) { set(e, id, 0, {emission: 1, count: 30}); keys(e, id, 0, 'speed', [[1, 1], [6, 6]]); }
      if (look === 12) set(e, id, 0, {delay: 2, step: 2});
    }
    return {document: e.serialize(), ticks: [3, 7, 10, 14]};
  },
  /** Particles outliving their clip: the tail after a timed clip's end, a clip
   * fade-out fading everything by the end, a disabled and an invisible effect
   * in a group, and a filter in the same clip. */
  'tails': () => {
    const e = sheet([limb(), limb()], i => [240 + i * 300, 220]);
    move(e, 2, 20, 10, 0);
    const a = e.addVfxClip(figure(1), 'particles', {start: 0, duration: 6});
    set(e, a, 0, {look: 0, rate: 3, life: 12, speed: 2});
    const b = e.addVfxClip(figure(2), 'explosion', {start: 1, duration: 4});
    set(e, b, 0, {style: 0, density: .4, size: .8});
    e.setVfxClip(b, {fadeOut: 2});
    e.addVfxGroupEffect(b, 'glow');
    e.addVfxGroupEffect(b, 'smoke'); set(e, b, 2, {enabled: 0});
    e.addVfxGroupEffect(b, 'particles'); set(e, b, 3, {effectStrength: 0});
    return {document: e.serialize(), ticks: [2, 5, 7, 12, 17]};
  },
  /** Where generated effects sit in painter order: overlapping figures with
   * effects behind and in front of them, scene effects behind and in front of
   * every figure, and a connected group (a scope on a figure covering the part
   * joined to it) whose member's effects the editor draws after everything. */
  'placement': () => {
    const e = sheet([limb(), limb(), [[11, 0, 70, 1.4], [22, 11, 60, 2.4]], limb()], i => [300 + i * 70, 240]);
    e.select(3); e.joinTo(2, 22);
    e.changeVfxStack(figure(2), stack => { stack.push({...createVfx('tint', 'scope-tint'), params: {...createVfx('tint', 'scope-tint').params, mix: .3, color: 0x3366ff}}); });
    e.setVfxScope(figure(2), true);
    const aura = e.addVfxClip(figure(1), 'aura', {start: 0, duration: 16});
    set(e, aura, 0, {style: 2, density: .5, dust: 1});
    const behind = e.addVfxClip(figure(2), 'particles', {start: 0, duration: 16});
    set(e, behind, 0, {look: 9, rate: 2, life: 10, size: 22, speed: 3, spread: 120, layer: 1, color: 0xffcc00});
    const member = e.addVfxClip(figure(3), 'particles', {start: 0, duration: 16});
    set(e, member, 0, {look: 4, rate: 2, life: 10, size: 14, speed: 2, color: 0x33cc66});
    const front = e.addVfxClip(figure(4), 'smoke', {start: 0, duration: 16});
    set(e, front, 0, {style: 3, amount: 1.5, life: 12, size: 26});
    const sceneBehind = e.addVfxClip(scene, 'particles', {start: 0, duration: 16});
    set(e, sceneBehind, 0, {look: 2, rate: 3, life: 12, size: 30, speed: 2, x: .4, y: .5, layer: 1, color: 0xcc3366});
    const sceneFront = e.addVfxClip(scene, 'explosion', {start: 2, duration: 12});
    set(e, sceneFront, 0, {style: 1, size: .6, density: .4, x: .5, y: .45});
    return {document: e.serialize(), ticks: [4, 8, 12]};
  },
  /** Generated effects inside a movieclip, drawn beside each instance in its
   * transform and opacity: one instance turned, scaled and mirrored at partial
   * opacity, one plain, both playing the clip from different offsets. */
  'movieclip': () => {
    const source = open(documentOf([limb()]));
    nextKey(source, 8); whole(source).moveSelection(50, -20);
    source.seek(0); source.select(1);
    const clip = source.createMovieclip({start: 0, end: 9, replace: false}), inner = clip._styk.movieclip.document;
    delete inner._styk.movieclipSource;
    for (const frame of inner.keyframes) delete frame._styk?.movieclipSourceTick;
    const aura = createVfxClip(figure(1), 'aura', 'inner-aura', 'inner-aura-fx', {start: 0, duration: null});
    Object.assign(aura.effects[0].params, {style: 0, density: .4, seed: 7});
    const burst = createVfxClip(scene, 'explosion', 'inner-boom', 'inner-boom-fx', {start: 1, duration: 10});
    Object.assign(burst.effects[0].params, {style: 1, density: .3, size: .5, x: .4, y: .4, seed: 9});
    inner._styk = {...inner._styk, vfxClips: {version: 1, clips: [aura, burst]}};
    const instance = (uid, x, extra = {}) => createObject(clip, uid, x, 240, {angles: [0], _stykMovieclip: {start: 0, end: 20, offset: uid === 8 ? 3 : 0, speed: 1, mode: 'loop'}, ...extra});
    const pose = () => [instance(7, 260, {angles: [.4], scale: 1.6, image_text_flags: 1, field28: 80}), instance(8, 600)];
    const document = {...emptyDocument(), figure_types: [clip], keyframes: [createFrame(pose(), 12), createFrame(pose(), 1)]};
    const e = open(document, {propertyChannels: true, layerTimeline: true});
    return {document: e.serialize(), ticks: [0, 2, 5, 9]};
  },
};

// ---------------------------------------------------------------- recording

const f32 = Math.fround;
/** The batch and every live particle at `tick`. */
function record(e, tick) {
  e.seek(tick);
  if (e.tick !== tick) throw new Error(`tick ${tick} is past the timeline (${e.totalTicks} ticks)`);
  const frame = e.evaluatedFrame, geometry = e.geometry;
  const batch = buildGeneratorBatch(e.report, frame, geometry, {sampler: new GeneratorAnchors()});
  if (!batch) return {tick, batch: null};
  if (batch.incomplete) throw new Error(`tick ${tick}: an incomplete batch`);
  const particles = [], beams = [], arcs = [], ramps = [], p = {}, color = [0, 0, 0, 0];
  batch.draws.forEach((draw, d) => {
    const R = batch.records, o = draw.record * RECORD_FLOATS;
    for (const x of [0, .3, .77, 1]) ramps.push([d, x, ...rampColor(batch, draw, x, color)]);
    if (draw.shape === SHAPE.beam) {
      const te = steppedTime(R, o), [bx, by] = beamTip(R, o, te);
      beams.push([d, te, bx, by, beamWidth(R, o, te)]);
      return;
    }
    if (draw.shape === SHAPE.arc) {
      const te = steppedTime(R, o), seed = R[o + 7] >>> 0, segs = Math.max(1, R[o + 62] | 0);
      for (let i = 0; i < draw.count; i++) {
        const arc = Math.floor(i / segs), key = pcg((seed + Math.imul(arc, 7919) + Math.imul(Math.floor(te / 2), 104729)) >>> 0);
        arcs.push([d, i, particleHash(arc, 99, key), particleHash(i % segs, 3, key)]);
      }
      return;
    }
    for (let i = 0; i < draw.count; i++) if (evaluateParticle(batch, draw, i, p)) particles.push([d, i, p.x, p.y, p.vx, p.vy, p.size, p.alpha, p.color, p.rotation, p.variant, p.n]);
  });
  return {tick, batch: {tick: batch.tick, particles: batch.particles, records: Array.from(batch.records), table: Array.from(batch.table),
    draws: batch.draws.map(d => [d.record, d.count, d.shape, d.blend, d.uid, d.placement === 'behind' ? 1 : 0, d.scene ? 1 : 0, d.material])}, particles, beams, arcs, ramps};
}

/** FNV-1a over bytes, as an unsigned 32-bit number. */
function fnv(bytes) { let h = 2166136261; for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }

const args = process.argv.slice(2);
if (args.includes('--list')) { console.log([...Object.keys(fixtures), 'atlas'].join('\n')); process.exit(0); }
const out = path.resolve(`${here}/../crates/styk-eval/tests/fixtures/generators`);
const names = args.filter(a => !a.startsWith('--'));
for (const name of names) if (!fixtures[name] && name !== 'atlas') { console.error(`unknown fixture ${name}`); process.exit(2); }
mkdirSync(out, {recursive: true});
if (!names.length || names.includes('atlas')) {
  const rows = [];
  for (let row = 0; row < ATLAS_ROWS; row++) rows.push(atlasRow(row).levels.map(level => [level.width, level.height, fnv(level.data)]));
  writeFileSync(`${out}/atlas.json`, JSON.stringify({rows}) + '\n');
  console.log(`atlas: ${rows.length} rows`);
}
for (const name of (names.length ? names : Object.keys(fixtures)).filter(name => name !== 'atlas')) {
  restart();
  const built = fixtures[name]();
  const document = prune(built.document);
  writeFileSync(`${out}/${name}.json`, JSON.stringify(document) + '\n');
  // Evaluate the saved project as the app opens it.
  const e = open(JSON.parse(JSON.stringify(document)), {propertyChannels: true, layerTimeline: true});
  const frames = built.ticks.map(tick => record(e, tick));
  const text = JSON.stringify({file: `${name}.json`, frames}) + '\n';
  writeFileSync(`${out}/${name}.batches.json`, text);
  const counts = frames.map(f => `${f.tick}: ${f.batch?.draws.length ?? 0} draws, ${f.particles?.length ?? 0} particles`).join('; ');
  console.log(`${name}: ${(text.length / 1024).toFixed(0)} KiB (${counts})`);
}
