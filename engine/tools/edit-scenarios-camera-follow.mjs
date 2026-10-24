// The camera used by editing: authored camera, follow travel, then preset impulses.
// Record with the actual editor before porting, including edits invalidating the shared path.
import './v8-pin.mjs';
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {createCameraMotion} from '../../src/camera-motion.mjs';
const out = fileURLToPath(new URL('../tests/edit/', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const read = name => JSON.parse(readFileSync(`${out}${name}`, 'utf8'));
const write = (name, document) => writeFileSync(`${out}${name}.document.json`, JSON.stringify(document) + '\n');
const scenario = (name, editor, steps, document) => writeFileSync(`${out}${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');
const camera = ['@cameraAtTime'];
const at = ticks => ticks.flatMap(tick => [['@seek', tick], camera]);
const clip = (id, targets, start = 0, duration = 8, params = {}) => {
  const follow = createCameraMotion('follow', id, start, duration, {targets: targets.map(([uid, weight]) => ({uid, weight}))});
  return {...follow, params: {...follow.params, fadeIn: 0, fadeOut: 0, ...params}};
};

const joined = read('camera-chain.document.json');
joined._styk.cameraMotion = {version: 1, clips: [
  clip('follow-joined', [[2, 1], [3, .25]], 0, 8, {deadZone: .12, lookAhead: 3, lag: 2.5, zoomFit: .7, padding: .13, maxZoom: 3.7, offsetX: 17, offsetY: -9}),
  {...clip('follow-overlap', [[1, 1]], 2, 5, {followX: .65, followY: .35, strength: .8, lag: 0, zoomFit: 1, maxZoom: 2.3}), mutedRanges: [{start: 3, end: 4}]},
  {...clip('follow-disabled', [[1, 1]]), enabled: false},
  {...createCameraMotion('wobble', 'follow-wobble', 1, 6), params: {...createCameraMotion('wobble', 'unused').params, fadeIn: 0, fadeOut: 0, zoom: .14, phase: 37}},
]};
write('camera-follow-joined', joined);
const joinedFile = 'camera-follow-joined.document.json';
// Native read/handle commands have no native property channels. Camera-only edits remain a
// separate family; moving, turning and sizing ordinary figures continues to use their owner.
const handleSteps = [
  ...at([0, 2, 3, 4, 6, 1.5, 0]), ['@select', 1, 1], ['nudgeHandle', 3, -2], camera,
  ['nudgeHandle', 4, 1, {view: {scale: 1.7, rotation: -.3, flip: true}}], camera,
  ['nudgeHandle', 2, 2, {cameraEnabled: false}], ['@select', 1, -1], ['nudgeHandle', -3, 2], camera,
  ['@seek', 6], ['@select', 2, 1], ['nudgeHandle', 1, 3], camera, ['undo'], camera, ['redo'], camera,
  ['@select', 3, -1], ['moveSelection', 4, 3], ['rotateFigure', .13], ['scaleSelection', .85], ['centerFigure'], camera,
  ['beginTranslationDrag'], ['moveSelection', 5, -3, {fromStart: true}], camera, ['cancelDrag'], camera,
  ['undo'], ['undo'], ['redo'], camera,
];
scenario('camera-follow-handles-native', {}, handleSteps, joinedFile);
scenario('camera-follow-handles-sheet', app, [...handleSteps,
  ['setLayerVisible', 'camera', false], ['nudgeHandle', 1, 1], camera, ['setLayerVisible', 'camera', true],
  ['setCameraMotion', 'follow-joined', {params: {lookAhead: 0, lag: 8, deadZone: 0, followX: 0, zoomFit: 0}}], camera,
  ['setCameraMotion', 'follow-joined', {targets: [{uid: 99, weight: 1}]}], camera, ['undo'], camera,
], joinedFile);
scenario('camera-follow-commands-sheet', app, [
  ...at([4, 0]), ['copyCamera'], ['transformCamera', {x: 4, y: -2, scale: 1.1, angle_rad: .2}], camera,
  ['beginCameraDrag'], ['updateCameraDrag', {x: 12, scale: .8}], camera, ['updateCameraDrag', {angle_rad: -.1}, {fromStart: false}], camera, ['commitCameraDrag'], camera,
  ['beginCameraDrag'], ['updateCameraDrag', {y: 9}], camera, ['cancelCameraDrag'], camera,
  ['@seek', 3], ['setCameraValues', {angle_rad: .35, scale: .72}], camera, ['resetCamera'], camera, ['pasteCamera'], camera,
  ['@select', 1, -1], ['centerCamera'], ['centerCamera', 'x'], ['centerCamera', 'y', [0, 1]], ['centerCamera', 'bogus'], ['centerCamera', 'both', [99]],
  ['centerCamera', 'both', [0], {boundsOf: null}], ['centerCamera', 'both', [0], {boundsOf: 3}],
  ['undo'], camera, ['undo'], camera, ['redo'], camera,
], joinedFile);
scenario('camera-follow-bake-sheet', app, [
  ...at([0, 2, 3, 4, 6]), ['applyCameraToFigures', [0], {ticks: [6, 1, 3, 3, 4]}], camera,
  ...at([1, 3, 4, 6]), ['undo'], camera, ['redo'], camera, ['undo'],
  ['@seek', 2], ['applyCameraToFigures'], camera, ['undo'], camera,
  ['setLayerVisible', 'camera', false], ['applyCameraToFigures', [0], {ticks: [1, 2]}], ['setLayerVisible', 'camera', true],
  ['applyCameraToFigures', [0], {ticks: [1.5]}], ['applyCameraToFigures', [0], {ticks: [-1]}],
], joinedFile);
// The editor's default bounds callback returns x/y/width/height while centerCamera expects
// minX/minY/maxX/maxY: the default is a noop. The application's injected bounds function is
// a separate bridge. A noop still finishes an open gesture before validating frame indices.
scenario('camera-center-default-sheet', app, [
  ['@select', 1, -1], ['centerCamera'], ['centerCamera', 'x'], ['centerCamera', 'y', [0, 1]],
  ['beginCameraDrag'], ['updateCameraDrag', {x: 8}], ['centerCamera'], ['undo'], ['redo'],
  ['beginDrag', 'Move figures'], ['moveSelection', 3, 2], ['centerCamera', 'both', [99]], ['undo'],
  ['beginCameraDrag'], ['updateCameraDrag', {y: 4}], ['centerCamera', 'invalid'], ['cancelCameraDrag'],
  ['centerCamera', 'both', [0], {boundsOf: null}], ['centerCamera', 'both', [0], {boundsOf: {}}],
  ['selectMany', []], ['centerCamera', 'both', [99]],
], joinedFile);

// A layer-sheet target disappears then returns; weighted union, lookahead, spring and zoom
// clipping, mute boundaries and fractional reads. Scrubbing backward must reuse the same path.
const figures = JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/eval/follow-figures.json', import.meta.url), 'utf8'));
figures._styk.cameraMotion.clips.push({...clip('follow-overlap', [[3, .8], [2, 0]], 5, 30, {deadZone: .3, lookAhead: 7, zoomFit: 1, maxZoom: 1.2, lag: .3}), mutedRanges: [{start: 12, end: 16}]});
write('camera-follow-figures', figures);
scenario('camera-follow-path-sheet', app, [
  ...at([0, 1, 2, 2.5, 5, 11, 12, 15.5, 16, 19, 20, 22, 30, 35, 36, 39, 2, 33, 4]),
  ['@select', 1, -1], ['moveSelection', 11, -5], camera, ['undo'], camera, ['redo'], camera,
  ['setCameraMotion', 'follow-overlap', {enabled: false}], camera, ['undo'], camera,
  ['setCameraMotion', 'follow-overlap', {params: {maxZoom: 20, zoomFit: 1, offsetX: 250, offsetY: -130, followX: 0}}], camera,
  ...at([2, 18, 32, 6]),
], 'camera-follow-figures.document.json');

// Follow sampling includes the 3D target's existing projected segment and polygon bounds;
// joining 3D IK chains remains a separate editing port.
const spatial = JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/spatial/mesh-perspective.json', import.meta.url), 'utf8'));
spatial._styk.cameraMotion = {version: 1, clips: [clip('follow-spatial', [[1, 1]], 0, 16, {lookAhead: 2, deadZone: .07, zoomFit: .8, maxZoom: 4, lag: 3})]};
write('camera-follow-spatial', spatial);
scenario('camera-follow-spatial-sheet', app, [
  ['sheetSetDuration', 16], ...at([0, 3, 8, 15, 2]), ['@select', 1, -1], ['nudgeHandle', 3, -2], camera,
  ['rotateFigure', .14], camera, ['scaleSelection', 1.2], camera, ['moveSelection', -4, 6], camera,
  ['@seek', 4], ['applyCameraToFigures', [0], {ticks: [2, 4, 8]}], camera, ['undo'], camera, ['redo'], camera,
], 'camera-follow-spatial.document.json');
