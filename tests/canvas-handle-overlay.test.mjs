import test from 'node:test';
import assert from 'node:assert/strict';
import {CanvasHandleOverlay} from '../src/canvas-handle-overlay.mjs';

function surface() {
  const fills = [], clears = [];
  const context = {setTransform() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { fills.push(this.fillStyle); }, stroke() {}, save() {}, restore() {}, rect() {}, clip() {}, drawImage() {},
    clearRect(...rect) { clears.push(rect); }};
  return {width: 1, height: 1, getContext: () => context, fills, clears};
}
const handle = (uid, x, y, color) => ({uid, point: {x, y}, screenRadius: 5, color});
const grouped = groups => {
  const handles = groups.flatMap(group => group.handles); Object.defineProperty(handles, 'groups', {value: groups}); return handles;
};

test('unchanged overlays retain projected groups and offscreen handles issue no paint commands', () => {
  const raster = surface(), target = surface(), overlay = new CanvasHandleOverlay(raster);
  const groups = [{uid: 1, handles: [handle(1, 20, 20, '#ff0000')]},
    {uid: 2, handles: [handle(2, -100, 20, '#0000ff'), handle(2, 1000, 20, '#0000ff')]}];
  let projects = 0;
  const options = {width: 200, height: 100, projectionKey: 'view', project: point => { projects++; return point; }};
  const first = overlay.draw(target.getContext(), grouped(groups), options);
  assert.equal(first.visible, 1); assert.deepEqual(raster.fills, ['#ff0000']); assert.equal(projects, 3);
  raster.fills.length = 0; raster.clears.length = 0; projects = 0;
  const repeated = overlay.draw(target.getContext(), grouped(groups), options);
  assert.equal(repeated.regions, 0); assert.equal(projects, 0); assert.deepEqual(raster.fills, []); assert.deepEqual(raster.clears, []);
});

test('local pose damage restores overlapping groups in painter order and skips unrelated handles', () => {
  const raster = new Surface(), target = surface(), overlay = new CanvasHandleOverlay(raster);
  const bottom = {uid: 1, handles: [handle(1, 20, 20, '#ff0000')]},
    top = {uid: 2, handles: [handle(2, 22, 20, '#0000ff'), handle(2, 180, 80, '#0000ff')]};
  let projects = 0;
  const options = {width: 200, height: 100, projectionKey: 'view', project: point => { projects++; return point; }};
  overlay.draw(target.getContext(), grouped([bottom, top]), options);
  raster.fills.length = 0; projects = 0;
  const changed = {uid: 1, handles: [handle(1, 21, 21, '#ff8800')]};
  const result = overlay.draw(target.getContext(), grouped([changed, top]), options);
  assert.equal(result.full, false); assert.equal(result.regions, 1); assert.equal(projects, 1);
  // The region is repainted on the spare surface, then its pixels are copied over.
  assert.deepEqual(raster.fills, []); assert.deepEqual(overlay.spare.fills, ['#ff8800', '#0000ff']);
  assert.equal(raster.copies.at(-1)[0], overlay.spare);
  overlay.draw(target.getContext(), grouped([changed, top]), options);
  assert.equal(overlay.spare, null, 'A draw that repaints nothing lets the spare surface go');
});

test('rotation, DPR, style, native order and document lifetime invalidate the retained layer', () => {
  const raster = surface(), target = surface(), overlay = new CanvasHandleOverlay(raster),
    groups = [{uid: 1, handles: [handle(1, 20, 20, '#ff0000')]}, {uid: 2, handles: [handle(2, 22, 20, '#0000ff')]}];
  const options = {width: 200, height: 100, projectionKey: 'view', project: point => point};
  overlay.draw(target.getContext(), grouped(groups), options);
  assert.equal(overlay.draw(target.getContext(), grouped(groups), {...options, projectionKey: 'rotated'}).full, true);
  assert.equal(overlay.draw(target.getContext(), grouped(groups), {...options, dpr: 1.5}).full, true);
  assert.equal(raster.width, 300); assert.equal(raster.height, 150);
  assert.equal(overlay.draw(target.getContext(), grouped(groups), {...options, dpr: 1.5, outline: true}).full, true);
  assert.equal(overlay.draw(target.getContext(), grouped(groups.toReversed()), {...options, dpr: 1.5, outline: true}).full, true);
  overlay.clear(); assert.deepEqual(overlay.groups, []);
  assert.equal(overlay.draw(target.getContext(), grouped(groups), options).full, true);
});

test('a translation reuses the stationary layer and culls only the projected moving handles', () => {
  const raster = surface(), target = surface(), overlay = new CanvasHandleOverlay(raster);
  const groups = [{uid: 1, handles: [handle(1, 20, 20, '#ff0000')]}, {uid: 2, handles: [handle(2, 50, 20, '#0000ff')]}];
  const translations = new Map([[1, {x: 10, y: 0}]]),
    options = {width: 200, height: 100, projectionKey: 'view', project: point => point, translations};
  overlay.draw(target.getContext(), grouped(groups), options);
  assert.deepEqual(raster.fills, ['#0000ff']); assert.deepEqual(target.fills, ['#ff0000']);
  raster.fills.length = 0; target.fills.length = 0;
  translations.set(1, {x: 1000, y: 0});
  const changed = overlay.draw(target.getContext(), grouped(groups), options);
  assert.equal(changed.regions, 0); assert.deepEqual(raster.fills, []); assert.deepEqual(target.fills, []);
});

class Surface {
  constructor(width = 1, height = 1) {
    this.width = width; this.height = height; this.fills = []; this.copies = [];
    const surface = this;
    this.context = {setTransform() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, save() {}, restore() {},
      rect() {}, clip() {}, clearRect() {}, fill() { surface.fills.push(this.fillStyle); }, drawImage(...args) { surface.copies.push(args); }};
  }
  getContext() { return this.context; }
}

test('a pan moves the retained pixels, paints only the handles in the strips it brings into view and repaints once the view rests', () => {
  const raster = new Surface(), target = new Surface(), overlay = new CanvasHandleOverlay(raster);
  const handles = grouped([{uid: 1, handles: [handle(1, 2, 50, '#ff0000'), handle(1, 100, 50, '#00ff00'), handle(1, -20, 50, '#0000ff')]}]);
  const options = {width: 200, height: 100, projectionKey: 'view', dpr: 1};
  assert.equal(overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 0, 0]}).full, true);
  assert.deepEqual(raster.fills, ['#ff0000', '#00ff00']);
  raster.fills.length = 0; raster.copies.length = 0;
  // Ten pixels right: the handle at -20 is still off the view; the one at 2, cut by the edge before, is painted again in the strip.
  const panned = overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 10, 0]});
  assert.equal(panned.full, false); assert.equal(panned.shifted, true); assert.equal(panned.settle, true);
  assert.deepEqual(raster.fills, [], 'No retained handle is painted again');
  assert.equal(raster.copies[0][0], raster, 'The surface is drawn onto itself, moved'); assert.deepEqual(raster.copies[0].slice(1), [10, 0]);
  assert.deepEqual(overlay.spare.fills, ['#ff0000'], 'Only the handle reaching into the new strip is painted');
  overlay.spare.fills.length = 0;
  // Another twenty pixels: the handle at -20 comes into view, only it is painted (on the spare, then copied in).
  const more = overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 30, 0]});
  assert.equal(more.shifted, true); assert.deepEqual(overlay.spare.fills, ['#0000ff']); assert.deepEqual(raster.fills, []);
  // A scale change is not a pan.
  assert.equal(overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 30, 0]}).full, true);
  raster.fills.length = 0;
  overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 35.5, 0]});
  assert.deepEqual(raster.fills, []);
  assert.equal(overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 35.5, 0]}).full, false, 'Only a rest repaints');
  const resting = overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 35.5, 0], rest: true});
  assert.equal(resting.full, true); assert.equal(resting.settle, false); assert.equal(overlay.spare, null, 'The spare surface goes once the view rests');
  assert.deepEqual(overlay.at, {x: 35.5, y: 0});
});
