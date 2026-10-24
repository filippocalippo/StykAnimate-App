// Editor-owned recordings for effect paints, presets and connected scopes (D15).
// node engine/tools/edit-vfx-scenarios.mjs
// node engine/tools/edit-replay.mjs --all
import {fileURLToPath} from 'node:url';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {documentOf, limb, open, prune} from './fixture-kit.mjs';
import {VFX_PRESETS} from '../../src/vfx-presets.mjs';
import {createVfx} from '../../src/vfx.mjs';
import {createVfxClip} from '../../src/vfx-clips.mjs';

const out = fileURLToPath(new URL('../tests/edit/', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const figure = uid => ({kind: 'figure', uid}), segment = {kind: 'segment', uid: 1, handleId: 22}, scene = {kind: 'scene'};
const paint = (type = 'linear') => ({type, angle: 45, stops: [{offset: 1, color: [240.5, 60.2, 80], opacity: .6}, {offset: 0, color: [40, 120.5, 255], opacity: 1}]});
const tint = {version: 2, id: 'fx-paint', type: 'tint', enabled: true, params: {color: paint(), mix: .7}};
const scenario = (name, steps, document = 'joined-chain.document.json', editor = app) => {
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');
};

// Keep the Rust catalogue byte-verifiable against its JavaScript oracle.
const catalogue = new URL('../crates/styk-edit/src/vfx_presets.json', import.meta.url);
const catalogueBytes = JSON.stringify(Object.fromEntries(Object.entries(VFX_PRESETS).map(([name, preset]) => [name, preset.effects])), null, 1) + '\n';
// This production catalogue is embedded in Rust; identical regeneration must preserve its mtime.
if (!existsSync(catalogue) || readFileSync(catalogue, 'utf8') !== catalogueBytes) writeFileSync(catalogue, catalogueBytes);

scenario('vfx-presets-sheet', [
  ...Object.keys(VFX_PRESETS).flatMap(name => [['applyVfxPreset', figure(1), name], ['undo'], ['redo'], ['undo']]),
  ['@seek', 3], ['applyVfxPreset', [figure(1), segment], 'Power up'], ['undo'], ['redo'],
  ['applyVfxPreset', scene, 'Golden hour'], ['applyVfxPreset', figure(1), 'unknown'],
  ['applyVfxPreset', figure(99), 'Neon'], ['applyVfxPreset', {kind: 'camera'}, 'Neon'],
  ['setLayerLocked', 'layer-1', true], ['applyVfxPreset', figure(1), 'Ice'], ['setLayerLocked', 'layer-1', false], ['undo'], ['undo'], ['redo'],
]);

scenario('vfx-paints-sheet', [
  ['pasteVfx', [figure(1), segment], [tint]], ['setVfxParameter', figure(1), 'fx-paint', 'color', paint('radial')],
  ['setVfxParameter', figure(1), 'fx-paint', 'color', null], ['setVfxParameter', figure(1), 'fx-paint', 'color', []],
  ['setVfxParameter', figure(1), 'fx-paint', 'color', {...paint(), type: 'bad'}],
  ['setVfxParameter', figure(1), 'fx-paint', 'color', {...paint(), stops: [paint().stops[0]]}],
  ['setVfxParameter', figure(1), 'fx-paint', 'color', {...paint(), angle: 36001}],
  ['setVfxParameter', figure(1), 'fx-paint', 'color', {...paint(), stops: [{offset: 0, color: [1, 2], opacity: 1}, paint().stops[0]]}],
  ['setVfxParameter', figure(1), 'fx-paint', 'color', {...paint(), stops: [{offset: 0, color: [1, 2, 256], opacity: 1}, paint().stops[0]]}],
  ['pasteVfx', figure(1), [{...tint, params: {color: {...paint(), stops: [{offset: -1, color: [1, 2, 3], opacity: 1}, paint().stops[0]]}}}]],
  ['@seek', 3], ['setVfxParameter', segment, 'fx-paint', 'color', paint('diamond')], ['undo'], ['undo'], ['redo'],
]);

scenario('vfx-scopes-sheet', [
  ['setVfxScope', figure(1), true], ['setVfxScope', figure(2), true], ['setVfxScope', figure(2), false],
  ['setVfxScope', segment, true], ['setVfxScope', scene, true], ['setVfxScope', figure(1), 1], ['setVfxScope', figure(99), true],
  ['pasteVfx', [figure(1), figure(2), segment], [tint], {includeAttached: true}], ['@seek', 3],
  ['setVfxScope', figure(2), true], ['pasteVfx', figure(1), [createVfx('blur', 'fx-paint')], {includeAttached: true}],
  ['setLayerLocked', 'layer-1', true], ['setVfxScope', figure(1), true], ['setLayerLocked', 'layer-1', false],
  ['undo'], ['undo'], ['undo'], ['redo'],
]);

scenario('vfx-clip-presets-sheet', [
  ...Object.keys(VFX_PRESETS).flatMap(name => [['addVfxGroup', figure(1), name, {includeAttached: true}], ['undo'], ['redo'], ['undo']]),
  ['@seek', 3], ['addVfxGroup', scene, 'Golden hour', {start: 2, duration: 20}],
  ['addVfxGroup', segment, 'Power up'], ['addVfxGroup', figure(1), 'bad'], ['addVfxGroup', {kind: 'camera'}, 'Neon'],
  ['addVfxGroup', figure(1), 'Neon', {duration: 0}], ['addVfxGroup', figure(1), 'Neon', {includeAttached: 1}],
  ['setLayerLocked', 'layer-1', true], ['addVfxGroup', figure(1), 'Ice'], ['setLayerLocked', 'layer-1', false], ['undo'], ['redo'],
]);

{
  const preset = {id: 'user-preset', name: 'Gradient pulse', created: 0, effects: [tint, createVfx('particles', 'fx-seeded')], strength: .8, fadeIn: 2, fadeOut: 3, duration: 12, offset: 2,
    keys: {'vfx1:tint:fx-paint:color': [{tick: 0, value: paint(), interpolation: 'ease-in'}, {tick: 6, value: 0xffffff, interpolation: 'linear'}]}};
  scenario('vfx-user-presets-sheet', [
    ['@seek', 3.5], ['addVfxUserPreset', figure(1), preset, {includeAttached: true}], ['addVfxUserPreset', scene, preset, {start: -4}],
    ['addVfxUserPreset', segment, {...preset, duration: null, offset: 0}, {start: 100}],
    ['addVfxUserPreset', figure(1), preset, {start: 1e8}], ['addVfxUserPreset', figure(1), {...preset, strength: 2}],
    ['addVfxUserPreset', figure(1), {...preset, effects: [{...tint, params: {color: {...paint(), type: 'bad'}}}]}],
    ['setLayerLocked', 'layer-1', true], ['addVfxUserPreset', figure(1), preset], ['setLayerLocked', 'layer-1', false], ['undo'], ['undo'], ['redo'],
  ]);
}

// Each gradient layout the evaluator interpolates: number/number, solid/gradient,
// matching gradients, different kinds and stop counts, fractional values and easing.
{
  const document = JSON.parse(readFileSync(`${out}/joined-chain.document.json`, 'utf8'));
  const solid = {type: 'solid', stops: [{offset: 0, color: [10.5, 50, 180], opacity: .4}]};
  const extra = {...paint(), stops: [paint().stops[0], {offset: .3, color: [0, 255, 40.5], opacity: .2}, paint().stops[1]]};
  const pairs = [[0xff0022, 0x10ffff], [0xffffff, paint()], [solid, paint()], [paint(), {...paint(), angle: -15, stops: paint().stops.map(s => ({...s, opacity: .25}))}],
    [paint(), paint('radial')], [extra, paint()], [paint('angular'), paint('diamond')], [paint(), solid]];
  const clips = pairs.map(([a, b], i) => ({...createVfxClip(figure(1), 'tint', `clip-mix-${i}`, 'fx-paint', {start: 1, duration: 12}), offset: 2,
    keys: {'vfx1:tint:fx-paint:color': [{tick: 0, value: a, interpolation: 'ease-in'}, {tick: 8, value: b, interpolation: 'linear'}]}}));
  document._styk.vfxClips = {version: 1, clips};
  const steps = [['@seek', 4], ...clips.flatMap(c => [
    ['copyVfxClip', c.id], ['pasteVfxClip', figure(2), {animation: false, start: 4}],
    ['toggleVfxClipKey', c.id, 'vfx1:tint:fx-paint:color', 4], ['undo'], ['redo'],
  ])];
  scenario('vfx-paint-interpolation-sheet', steps, document);
  scenario('vfx-paint-interpolation-native', steps, document, {});
}

{
  const document = JSON.parse(readFileSync(`${out}/joined-chain.document.json`, 'utf8'));
  const clip = createVfxClip(figure(1), 'tint', 'clip-paint', 'fx-paint', {start: 0, duration: 12});
  document._styk.vfxClips = {version: 1, clips: [clip]};
  scenario('vfx-clip-paints-sheet', [
    ['setVfxClip', 'clip-paint', {includeAttached: true}], ['addVfxClip', figure(2), 'glow', {includeAttached: true}],
    ['setVfxClipParameter', 'clip-paint', 'fx-paint', 'color', paint()],
    ['setVfxClipParameter', 'clip-paint', 'fx-paint', 'color', {...paint(), type: 'bad'}],
    ['setVfxClipParameter', 'clip-paint', 'fx-paint', 'color', null],
    ['setVfxClipParameters', 'clip-paint', 'fx-paint', {mix: .4, color: {...paint(), angle: 1e6}}],
    ['setVfxClipParameter', 'clip-paint', 'fx-paint', 'color', paint(), {key: true, tick: 0}],
    ['setVfxClipParameter', 'clip-paint', 'fx-paint', 'color', paint('radial'), {key: true, tick: 8}],
    ['@seek', 4], ['copyVfxClip', 'clip-paint'], ['pasteVfxClip', figure(2), {animation: false}], ['pasteVfxClip', segment],
    ['toggleVfxClipKey', 'clip-paint', 'vfx1:tint:fx-paint:color', 4], ['setVfxClipEasing', 'clip-paint', 'vfx1:tint:fx-paint:color', 0, 'ease-in'],
    ['beginVfxClipEdit'], ['setVfxClipParameter', 'clip-paint', 'fx-paint', 'color', paint('angular'), {tick: 4}], ['cancelVfxClipEdit'],
    ['beginVfxClipEdit'], ['setVfxClipParameter', 'clip-paint', 'fx-paint', 'color', paint('diamond'), {tick: 4}], ['commitVfxClipEdit'],
    ['undo'], ['undo'], ['redo'],
  ], document);
}

// Sixteen nested scopes are supported; forcing the seventeenth is refused atomically.
{
  const nested = open(documentOf(Array.from({length: 18}, () => limb()), i => [200 + i * 5, 170]));
  for (let uid = 2; uid <= 18; uid++) { nested.select(uid); nested.joinTo(uid - 1, 22); }
  for (let uid = 1; uid <= 16; uid++) nested.setVfxScope(figure(uid), true);
  const document = prune(nested.report);
  const clip = createVfxClip(figure(17), 'tint', 'clip-deep', 'fx-deep');
  document._styk.vfxClips = {version: 1, clips: [clip]};
  scenario('vfx-scopes-depth-sheet', [
    ['setVfxScope', figure(17), true], ['pasteVfx', figure(17), [tint], {includeAttached: true}],
    ['addVfxClip', figure(17), 'glow', {includeAttached: true}], ['addVfxGroup', figure(17), 'Neon', {includeAttached: true}],
    ['setVfxClip', 'clip-deep', {includeAttached: true}], ['setVfxScope', figure(1), false], ['setVfxScope', figure(17), true],
    ['setVfxClip', 'clip-deep', {includeAttached: true}], ['undo'], ['undo'], ['redo'],
  ], document);
}

// The clip model also works without a sheet; publication keeps native poses untouched.
for (const base of ['vfx-clip-presets', 'vfx-user-presets', 'vfx-clip-paints']) {
  const recorded = JSON.parse(readFileSync(`${out}/${base}-sheet.scenario.json`, 'utf8'));
  scenario(`${base}-native`, recorded.steps, recorded.document, {});
}
