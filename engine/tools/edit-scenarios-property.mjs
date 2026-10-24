// Command-replay scenarios of property edits on a layer sheet (docs/engine/editing.md):
// the inspector's scrubs (`beginAnimationEdit`, `previewAnimationEdit`, `commitAnimationEdit`,
// `cancelAnimationEdit`), keyed values (`addAnimationKeys`), the scene's colour and
// background, a figure's outline, a polygon's opacity and effect parameters, all through
// `_sheetPropertyEntries`. Run by engine/tools/edit-scenarios.mjs.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';

const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const scenario = (name, editor, steps, document) => writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const figure = uid => ({kind: 'figure', uid}), segment = (uid, handleId) => ({kind: 'segment', uid, handleId});
const camera = {kind: 'camera'}, scene = {kind: 'scene'};

// Two layers (figure 3 joined to 2 on its own layer, the first layer's first key held) with
// a colour background to choose.
{
  const document = JSON.parse(readFileSync(`${out}/sheet-layers.document.json`, 'utf8'));
  document.backgrounds = [{background_id: 1, kind: 2, color: 0xffe0c080, name: 'Warm'}];
  writeFileSync(`${out}/property-sheet.document.json`, mirror(open(document, app)));
}
scenario('property-scrub-sheet', app, [
  ['@select', 1, -1],
  ['beginAnimationEdit', figure(1), 'scale'], ['previewAnimationEdit', 1.3], ['previewAnimationEdit', 1.6], ['commitAnimationEdit'],
  ['undo'], ['redo'],
  ['beginAnimationEdit', figure(2), 'opacity'], ['previewAnimationEdit', 0.4], ['cancelAnimationEdit'],
  // A held cell: the edit goes to its key.
  ['@seek', 3],
  ['beginAnimationEdit', figure(1), 'color'], ['previewAnimationEdit', 0xff3080c0], ['commitAnimationEdit'],
  ['beginAnimationEdit', camera, 'x'], ['previewAnimationEdit', 40], ['commitAnimationEdit'],
  ['beginAnimationEdit', segment(1, 22), 'thickness'], ['previewAnimationEdit', 9], ['commitAnimationEdit'],
  ['beginAnimationEdit', figure(1), 'outlineWidth'], ['previewAnimationEdit', 3], ['commitAnimationEdit'],
  ['beginAnimationEdit', figure(2), 'zIndex'], ['previewAnimationEdit', 2], ['commitAnimationEdit'],
  ['beginAnimationEdit', scene, 'color'], ['previewAnimationEdit', 0xff204060], ['commitAnimationEdit'],
  // Nothing changed; a second edit commits the first.
  ['beginAnimationEdit', figure(1), 'scale'], ['commitAnimationEdit'], ['beginAnimationEdit', figure(1), 'scale'], ['previewAnimationEdit', 1.6], ['commitAnimationEdit'],
  ['beginAnimationEdit', figure(2), 'scale'], ['previewAnimationEdit', 0.8], ['beginAnimationEdit', figure(1), 'opacity'], ['previewAnimationEdit', 0.5], ['commitAnimationEdit'],
  // Refusals.
  ['beginAnimationEdit', figure(1), 'pose'], ['beginAnimationEdit', figure(99), 'scale'], ['beginAnimationEdit', {kind: 'figure'}, 'scale'],
  ['beginAnimationEdit', {kind: 'layer', id: 'layer-1'}, 'scale'], ['previewAnimationEdit', 1.2], ['commitAnimationEdit'], ['cancelAnimationEdit'],
  ['beginAnimationEdit', figure(2), 'opacity'], ['previewAnimationEdit', 2], ['previewAnimationEdit', 0.25], ['undo'], ['redo'],
  // A joined figure's position moves its root figure; a turn.
  ['@seek', 6],
  ['beginAnimationEdit', figure(3), 'x'], ['previewAnimationEdit', 380], ['commitAnimationEdit'],
  ['beginAnimationEdit', figure(2), 'rotation'], ['previewAnimationEdit', 0.5], ['commitAnimationEdit'],
  ['undo'], ['undo'], ['redo'],
], 'property-sheet.document.json');
scenario('property-autokey-sheet', {...app, autoKey: true}, [
  ['@seek', 3], ['@select', 1, -1], ['beginAnimationEdit', figure(1), 'scale'], ['previewAnimationEdit', 1.4], ['commitAnimationEdit'],
  ['beginAnimationEdit', camera, 'rotation'], ['previewAnimationEdit', 0.3], ['commitAnimationEdit'], ['undo'], ['redo'],
], 'property-sheet.document.json');
scenario('property-keys-sheet', app, [
  ['@select', 1, -1],
  ['addAnimationKeys', [{target: figure(1), property: 'scale', tick: 0, value: 1.2}, {target: figure(1), property: 'scale', tick: 4, value: 0.9}, {target: figure(3), property: 'opacity', tick: 4, value: 0.35}]],
  ['addAnimationKeys', [{target: figure(2), property: 'opacity'}]], ['@seek', 4], ['addAnimationKeys', [{target: figure(3), property: 'opacity'}]], ['@seek', 0],
  // Values on show: a joined figure's position is where it is drawn (its root figure stays).
  ['addAnimationKeys', [{target: figure(3), property: 'x'}, {target: figure(3), property: 'y'}, {target: figure(2), property: 'rotation'}]],
  ['addAnimationKeys', [{target: camera, property: 'scale', tick: 2, value: 1.5, interpolation: 'ease-in'}]],
  ['addAnimationKeys', [{target: camera, property: 'y', tick: 5, value: 10, interpolation: 'bezier', bezier: [0.1, 0.2, 0.3, 0.4]}]],
  ['addAnimationKeys', [{target: scene, property: 'backgroundId', tick: 1, value: 1}, {target: scene, property: 'color', tick: 1, value: null}]],
  ['addAnimationKeys', [{target: {kind: 'layer', id: 'layer-2'}, property: 'pose', tick: 2}, {target: {kind: 'layer', id: 'layer-2'}, property: 'pose', tick: 5, value: {frameId: 'frame-3'}}]],
  ['addAnimationKeys', []],
  ['addAnimationKeys', [{target: figure(1), property: 'scale', tick: 2, value: -1}]],
  ['addAnimationKeys', [{target: figure(1), property: 'thickness', tick: 2, value: 3}]],
  ['addAnimationKeys', [{target: figure(1), property: 'scale', tick: 2.5, value: 1}]],
  ['addAnimationKeys', [{target: figure(1), property: 'scale', tick: 2, value: 1, interpolation: 'wobbly'}]],
  ['addAnimationKeys', [{target: segment(1, 22), property: 'color', tick: 2, value: 0x1ff0000}]],
  ['addAnimationKey', figure(2), 'scale', 6, 1.4],
  ['addAnimationKey', segment(2, 11), 'color', null, 0xff0000],
  ['undo'], ['undo'], ['redo'],
], 'property-sheet.document.json');
scenario('property-locked-sheet', app, [
  ['addAnimationKeys', [{target: figure(3), property: 'scale', tick: 0, value: 1.5}]],
  ['addAnimationKeys', [{target: figure(1), property: 'scale', tick: 0, value: 1.5}]],
  ['setSceneColor', 0xff102030], ['setVfxParameter', figure(3), 'fx-any', 'radius', 1], ['setVfxParameter', figure(1), 'fx-any', 'radius', 1],
], 'sheet-locked.document.json');
scenario('scene-color-sheet', app, [
  ['setSceneColor', 0xff204060], ['@seek', 4], ['setSceneColor', 0xff406080, {indices: [0, 1]}], ['setSceneColor', -1], ['setSceneColor', 1.5],
  ['setSceneBackground', 1], ['setSceneBackground', 0, {indices: [1]}], ['setSceneBackground', 7],
  ['setBackgroundColor', 0xffff0000], ['setBackgroundColor', 'red'], ['setSceneColor', 0xff204060, {indices: [5]}],
  ['undo'], ['undo'], ['redo'],
], 'property-sheet.document.json');
scenario('figure-style-sheet', app, [
  ['@select', 1, -1], ['updateFigureStyle', {outlineWidth: 3}], ['updateFigureStyle', {outlineColor: '#ff8000', outlineOpacity: 0.5}],
  ['updateFigureStyle', {outlineWidth: 3}], ['updateFigureStyle', {outlineColor: [10, 20, 30]}], ['updateFigureStyle', {outlineColor: '#zz0000'}],
  ['updateFigureStyle', {bogus: 1}], ['undo'], ['redo'], ['@seek', 6], ['@select', 2, -1], ['updateFigureStyle', {outlineOpacity: 0.2}],
], 'property-sheet.document.json');
scenario('polygon-opacity-sheet', app, [
  ['@select', 1, -1], ['updatePolygon', 0, {opacity: 0.5}], ['@seek', 2], ['updatePolygon', 1, {opacity: 0.25}], ['updatePolygon', 0, {}],
  ['updatePolygon', 0, {opacity: 3}], ['undo'], ['redo'],
], 'polygons.document.json');
// Effects on a layer sheet: a blur on figure 1, a glow on its shin, a grade on the scene.
{
  let next = 0;
  const randomUUID = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`});
  const editor = open(JSON.parse(readFileSync(`${out}/property-sheet.document.json`, 'utf8')), app);
  editor.addVfx(figure(1), 'blur'); editor.addVfx(segment(1, 22), 'glow'); editor.addVfx(scene, 'grade');
  Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: randomUUID});
  writeFileSync(`${out}/property-vfx.document.json`, mirror(editor));
}
{
  const [blur, glow, grade] = [1, 2, 3].map(n => `fx-0000000000004000800000000000000${n}`);
  scenario('vfx-parameter-sheet', app, [
    ['@select', 1, -1], ['setVfxParameter', figure(1), blur, 'radius', 6], ['setVfxParameter', figure(1), blur, 'enabled', 0],
    ['setVfxParameter', figure(1), 'fx-none', 'radius', 6], ['setVfxParameter', figure(1), blur, 'bogus', 6], ['setVfxParameter', figure(1), blur, 'radius', 9999],
    ['setVfxParameter', segment(1, 22), glow, 'intensity', 2], ['setVfxParameter', scene, grade, 'contrast', 1.5], ['setVfxParameter', {kind: 'camera'}, grade, 'contrast', 1.5],
    ['setVfxParameter', figure(99), blur, 'radius', 1],
    ['@seek', 3],
    ['beginAnimationEdit', figure(1), `vfx1:blur:${blur}:radius`, {exactTarget: true}], ['previewAnimationEdit', 12], ['commitAnimationEdit'],
    ['beginAnimationEdit', figure(1), 'vfxScope', {exactTarget: true}], ['previewAnimationEdit', 1], ['commitAnimationEdit'],
    ['beginAnimationEdit', figure(1), 'vfxStack', {exactTarget: true}],
    ['previewAnimationEdit', [{version: 2, id: blur, type: 'blur', enabled: true, params: {radius: 4}}]], ['commitAnimationEdit'],
    ['undo'], ['undo'], ['redo'],
  ], 'property-vfx.document.json');
}
// The same commands on documents with property channels.
await import('./edit-scenarios-channels.mjs');
// The figure-range commands.
await import('./edit-scenarios-range.mjs');
