import test from 'node:test';
import assert from 'node:assert/strict';
import {CanvasHandleOverlay} from '../src/canvas-handle-overlay.mjs';
import {HandleSprites} from '../src/canvas-handle-sprites.mjs';

class Surface {
  constructor(width = 1, height = 1) {
    this.width = width; this.height = height; this.fills = []; this.copies = []; this.clears = [];
    const surface = this;
    this.context = {setTransform() {}, beginPath() {}, arc() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, save() {}, restore() {},
      rect() {}, clip() {}, clearRect(...rect) { surface.clears.push(rect); }, fill() { surface.fills.push(this.fillStyle); },
      drawImage(...args) { surface.copies.push(args); }};
  }
  getContext() { return this.context; }
}
const surface = () => new Surface();
/** The fill colours of the handles stamped on `surface` from the overlay's atlas, in order. */
const stamped = (overlay, surface) => surface.copies.filter(([source]) => source === overlay.sprites.atlas)
  .map(([, x, y]) => overlay.sprites.lookAt(x, y).fill);
const forget = (...surfaces) => { for (const surface of surfaces) surface.fills.length = surface.copies.length = surface.clears.length = 0; };
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
  assert.equal(first.visible, 1); assert.deepEqual(stamped(overlay, raster), ['#ff0000']); assert.equal(projects, 3);
  forget(raster); projects = 0;
  const repeated = overlay.draw(target.getContext(), grouped(groups), options);
  assert.equal(repeated.regions, 0); assert.equal(projects, 0); assert.deepEqual(stamped(overlay, raster), []); assert.deepEqual(raster.clears, []);
});

test('local pose damage restores overlapping groups in painter order and skips unrelated handles', () => {
  const raster = surface(), target = surface(), overlay = new CanvasHandleOverlay(raster);
  const bottom = {uid: 1, handles: [handle(1, 20, 20, '#ff0000')]},
    top = {uid: 2, handles: [handle(2, 22, 20, '#0000ff'), handle(2, 180, 80, '#0000ff')]};
  let projects = 0;
  const options = {width: 200, height: 100, projectionKey: 'view', project: point => { projects++; return point; }};
  overlay.draw(target.getContext(), grouped([bottom, top]), options);
  forget(raster); projects = 0;
  const changed = {uid: 1, handles: [handle(1, 21, 21, '#ff8800')]};
  const result = overlay.draw(target.getContext(), grouped([changed, top]), options);
  assert.equal(result.full, false); assert.equal(result.regions, 1); assert.equal(projects, 1);
  assert.deepEqual(stamped(overlay, raster), ['#ff8800', '#0000ff']);
  // The damage is the old and new handle's square, widened by the outline and antialiasing, in whole backing pixels.
  assert.deepEqual(raster.clears, [[14, 14, 13, 13]]);
  for (const [, , , width, height, x, y] of raster.copies.filter(([source]) => source === overlay.sprites.atlas))
    assert.ok(x >= 14 && y >= 14 && x + width <= 27 && y + height <= 27, 'each stamp is cut to the damage');
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
  assert.deepEqual(stamped(overlay, raster), ['#0000ff']); assert.deepEqual(stamped(overlay, target), ['#ff0000']);
  forget(raster, target);
  translations.set(1, {x: 1000, y: 0});
  const changed = overlay.draw(target.getContext(), grouped(groups), options);
  assert.equal(changed.regions, 0); assert.deepEqual(stamped(overlay, raster), []); assert.deepEqual(stamped(overlay, target), []);
});


test('a pan moves the retained pixels, paints only the handles in the strips it brings into view and repaints once the view rests', () => {
  const raster = new Surface(), target = new Surface(), overlay = new CanvasHandleOverlay(raster);
  const handles = grouped([{uid: 1, handles: [handle(1, 2, 50, '#ff0000'), handle(1, 100, 50, '#00ff00'), handle(1, -20, 50, '#0000ff')]}]);
  const options = {width: 200, height: 100, projectionKey: 'view', dpr: 1};
  assert.equal(overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 0, 0]}).full, true);
  assert.deepEqual(stamped(overlay, raster), ['#ff0000', '#00ff00']);
  forget(raster);
  // Ten pixels right: the handle at -20 is still off the view; the one at 2, cut by the edge before, is painted again in the strip.
  const panned = overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 10, 0]});
  assert.equal(panned.full, false); assert.equal(panned.shifted, true); assert.equal(panned.settle, true);
  assert.equal(raster.copies[0][0], raster, 'The surface is drawn onto itself, moved'); assert.deepEqual(raster.copies[0].slice(1), [10, 0]);
  assert.deepEqual(stamped(overlay, raster), ['#ff0000'], 'Only the handle reaching into the new strip is stamped again');
  const strip = raster.copies.find(([source]) => source === overlay.sprites.atlas);
  assert.ok(strip[5] >= 0 && strip[5] + strip[7] <= 10, 'cut to the pixels of the strip');
  assert.deepEqual(raster.clears, [[0, 0, 10, 100]], 'only the strip is cleared');
  forget(raster);
  // Another twenty pixels: the handle at -20 comes into view, only it is stamped.
  const more = overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 30, 0]});
  assert.equal(more.shifted, true); assert.deepEqual(stamped(overlay, raster), ['#0000ff']);
  // A scale change is not a pan.
  assert.equal(overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 30, 0]}).full, true);
  forget(raster);
  overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 35.5, 0]});
  assert.deepEqual(stamped(overlay, raster), ['#0000ff'], 'a fractional pan moves by whole backing pixels (six) and stamps only the handle at -4 in the new strip');
  assert.equal(overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 35.5, 0]}).full, false, 'Only a rest repaints');
  const resting = overlay.draw(target.context, handles, {...options, matrix: [2, 0, 0, 2, 35.5, 0], rest: true});
  assert.equal(resting.full, true); assert.equal(resting.settle, false);
  assert.deepEqual(overlay.at, {x: 35.5, y: 0});
});

test('with few handles on the surface a pan repaints them, as before', () => {
  const raster = new Surface(), target = new Surface(), overlay = new CanvasHandleOverlay(raster, {panShiftFrom: 3});
  const handles = grouped([{uid: 1, handles: [handle(1, 20, 50, '#ff0000'), handle(1, 100, 50, '#00ff00')]}]);
  const options = {width: 200, height: 100, projectionKey: 'view'};
  overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 0, 0]});
  const panned = overlay.draw(target.context, handles, {...options, matrix: [1, 0, 0, 1, 10, 0]});
  assert.equal(panned.full, true); assert.equal(panned.shifted, false); assert.equal(panned.settle, false);
});

/** A canvas that records what is drawn on it, as [command, ...arguments]; shapes and line widths in backing pixels (the
 * transform applied, a scale and a translation). */
class Recorder {
  constructor(width = 1, height = 1) {
    this.width = width; this.height = height; this.ops = [];
    const ops = this.ops;
    let [scale, e, f] = [1, 0, 0];
    this.context = {
      setTransform: (a, b, c, d, x, y) => { [scale, e, f] = [a, x, y]; ops.push(['setTransform', a, b, c, d, x, y]); },
      clearRect: (...args) => ops.push(['clearRect', ...args]), save() {}, restore() {}, beginPath: () => ops.push(['beginPath']), moveTo() {},
      lineTo: (x, y) => ops.push(['lineTo', scale * x + e, scale * y + f]), closePath() {},
      arc: (x, y, radius) => ops.push(['arc', scale * x + e, scale * y + f, scale * radius]), drawImage: (...args) => ops.push(['drawImage', ...args]),
      fill() { ops.push(['fill', this.fillStyle]); }, stroke() { ops.push(['stroke', this.strokeStyle, scale * this.lineWidth]); },
    };
  }
  getContext() { return this.context; }
  named(name) { return this.ops.filter(op => op[0] === name); }
}
const paintRun = (sprites, target, list, options) =>
  sprites.paint(target.context, list.map(entry => entry.handle), list.map(entry => entry.x), list.map(entry => entry.y), list.length, options);

test('handle stamps: one picture per look and quarter backing pixel, placed so its centre is the handle\'s to the quarter', () => {
  const sprites = new HandleSprites((width, height) => new Recorder(width, height)), target = new Recorder();
  const red = {screenRadius: 4.5, color: '#ff0000'}, blue = {screenRadius: 3, color: '#0000ff'};
  const run = [{handle: red, x: 10.25, y: 10}, {handle: red, x: 18.25, y: 26}, {handle: red, x: 10.1, y: 10.9}, {handle: blue, x: -2.6, y: 7.374}];
  for (const dpr of [1, 1.25, 2]) {
    target.ops.length = 0;
    paintRun(sprites, target, run, {dpr});
    const atlas = sprites.atlas, arcs = atlas.named('arc'), stamps = target.named('drawImage');
    assert.equal(stamps.length, 4); assert.ok(stamps.every(stamp => stamp[1] === atlas));
    // The first two share a picture: same look, whole backing pixels apart at each of these ratios.
    assert.deepEqual(stamps[0].slice(2, 4), stamps[1].slice(2, 4));
    assert.equal(arcs.length, 3, 'three pictures painted');
    assert.deepEqual(atlas.named('fill').map(op => op[1]), ['#ff0000', '#ff0000', '#0000ff'], 'each picture its own path');
    for (const [index, stamp] of stamps.entries()) {
      const [, , sx, sy, sw, sh, dx, dy, dw, dh] = stamp, {x, y} = run[index];
      assert.ok(Number.isInteger(dx) && Number.isInteger(dy), 'stamped at whole backing pixels');
      assert.deepEqual([dw, dh], [sw, sh], 'never resampled');
      const arc = arcs.find(op => op[1] >= sx && op[1] < sx + sw && op[2] >= sy && op[2] < sy + sh);
      assert.equal(dx + arc[1] - sx, Math.round(x * dpr * 4) / 4); assert.equal(dy + arc[2] - sy, Math.round(y * dpr * 4) / 4);
      assert.equal(arc[3], run[index].handle.screenRadius * dpr);
      // The picture holds the shape and its antialiasing.
      assert.ok(arc[1] - arc[3] - 1 >= sx && arc[1] + arc[3] + 1 <= sx + sw);
    }
    atlas.ops.length = 0;
    paintRun(sprites, target, run, {dpr});
    assert.deepEqual(atlas.ops, [], 'a second pass paints no picture');
  }
  assert.equal(sprites.resets, 3, 'each new device-pixel ratio starts the atlas again');
});

test('handle stamps: outlines and IK markers are part of the picture', () => {
  const sprites = new HandleSprites((width, height) => new Recorder(width, height)), target = new Recorder();
  const plain = {screenRadius: 4, color: '#ff0000'}, ik = {screenRadius: 4, color: '#ff0000', ik: true}, connector = {screenRadius: 5, color: '#ff0000', connector: true};
  paintRun(sprites, target, [{handle: plain, x: 5, y: 5}, {handle: ik, x: 20, y: 5}, {handle: connector, x: 40, y: 5}], {dpr: 1.5});
  assert.deepEqual(sprites.atlas.named('stroke'), [['stroke', '#0d99ff', 1.5]], 'without outlines only the IK marker is stroked');
  sprites.atlas.ops.length = 0;
  paintRun(sprites, target, [{handle: plain, x: 5, y: 5}, {handle: connector, x: 40, y: 5}], {dpr: 1.5, outline: true});
  assert.deepEqual(sprites.atlas.named('fill'), [['fill', '#ff0000'], ['fill', '#ff0000']]);
  assert.deepEqual(sprites.atlas.named('stroke'), [['stroke', '#000000', 1.5], ['stroke', '#000000', 1.5]]);
  assert.equal(sprites.atlas.named('arc').length, 1); assert.equal(sprites.atlas.named('lineTo').length, 3, 'the connector is a diamond');
});

test('handle stamps: a full atlas starts again, and what one pass cannot fit is painted as paths in its place', () => {
  // Cells of 11 backing pixels (radius 4, no outline) and a gap: two a shelf, two shelves.
  const sprites = new HandleSprites((width, height) => new Recorder(width, height), {size: 24, limit: 24}), target = new Recorder();
  const look = color => ({screenRadius: 4, color});
  paintRun(sprites, target, ['#000001', '#000002', '#000003'].map((color, i) => ({handle: look(color), x: 10 * i, y: 0})), {dpr: 1});
  assert.equal(sprites.resets, 1);
  target.ops.length = 0;
  // Three more looks: the atlas is emptied once, then holds four of these five; the fifth is a path, in order.
  const run = ['#000004', '#000005', '#000006', '#000007', '#000008'].map((color, i) => ({handle: look(color), x: 10 * i, y: 0}));
  paintRun(sprites, target, run, {dpr: 1});
  assert.equal(sprites.resets, 2);
  assert.ok(sprites.atlas.named('clearRect').length >= 1, 'the atlas was emptied');
  const painted = target.ops.filter(op => op[0] === 'drawImage' || op[0] === 'fill');
  assert.deepEqual(painted.map(op => op[0]), ['drawImage', 'drawImage', 'drawImage', 'drawImage', 'fill']);
  assert.equal(painted[4][1], '#000008');
});

test('handle stamps: an atlas too small for one pass is made larger once, up to its limit', () => {
  const sprites = new HandleSprites((width, height) => new Recorder(width, height), {size: 24, limit: 48}), target = new Recorder();
  const run = Array.from({length: 9}, (_, i) => ({handle: {screenRadius: 4, color: `#00000${i}`}, x: 10 * i, y: 0}));
  paintRun(sprites, target, run, {dpr: 1});
  assert.equal(sprites.size, 48); assert.deepEqual([sprites.atlas.width, sprites.atlas.height], [48, 48]);
  assert.equal(target.named('fill').length, 0, 'every handle is stamped');
  assert.equal(target.named('drawImage').length, 9);
  // Sixteen cells now: seventeen looks in one pass leave the last one a path.
  target.ops.length = 0;
  paintRun(sprites, target, Array.from({length: 17}, (_, i) => ({handle: {screenRadius: 4, color: `#0000${(16 + i).toString(16)}`}, x: 10 * i, y: 0})), {dpr: 1});
  assert.equal(sprites.size, 48, 'never past its limit');
  assert.deepEqual(target.named('fill').map(op => op[1]), ['#000020']);
});

test('a selection moved by one delta is a layer of its own: its pixels move, only strips are stamped, and the gesture\'s rest or end repaints', () => {
  const raster = new Surface(), target = new Surface(), overlay = new CanvasHandleOverlay(raster);
  const moving = {uid: 1, handles: [handle(1, 20, 50, '#ff0000'), handle(1, 100, 50, '#00ff00')]}, still = {uid: 2, handles: [handle(2, 60, 20, '#0000ff')]};
  const translations = new Map([[1, {x: 0, y: 0}]]);
  const options = {width: 200, height: 100, projectionKey: 'view', dpr: 1, matrix: [1, 0, 0, 1, 0, 0], translations};
  const first = overlay.draw(target.context, grouped([moving, still]), options);
  const layer = overlay.moving.surface;
  assert.deepEqual(stamped(overlay, raster), ['#0000ff'], 'the stationary layer leaves the moving figures out');
  assert.deepEqual(stamped(overlay, layer), ['#ff0000', '#00ff00'], 'the moving figures are painted on their own layer');
  assert.deepEqual(target.copies.map(([source]) => source), [raster, layer], 'the moving layer is drawn over the stationary one');
  assert.equal(first.settle, false);
  forget(raster, target, layer);
  // Dragged ten pixels right: the layer's pixels move, nothing is stamped (no handle reaches into the strip at the left).
  translations.set(1, {x: 10, y: 0});
  const dragged = overlay.draw(target.context, grouped([moving, still]), options);
  assert.deepEqual(stamped(overlay, raster), []); assert.deepEqual(stamped(overlay, layer), []);
  assert.equal(layer.copies[0][0], layer, 'the layer is drawn onto itself, moved'); assert.deepEqual(layer.copies[0].slice(1), [10, 0]);
  assert.equal(dragged.settle, true, 'moved pixels ask to be painted afresh once the gesture rests, as a pan does');
  forget(raster, target, layer);
  // A fractional delta moves the pixels by whole ones; the rest paints the layer afresh where asked.
  translations.set(1, {x: 12.4, y: 0});
  assert.equal(overlay.draw(target.context, grouped([moving, still]), options).settle, true);
  assert.deepEqual(overlay.moving.at, {x: 12, y: 0}, 'painted at the nearest whole backing pixel');
  forget(layer);
  overlay.draw(target.context, grouped([moving, still]), {...options, rest: true});
  assert.deepEqual(stamped(overlay, layer), ['#ff0000', '#00ff00']); assert.deepEqual(overlay.moving.at, {x: 12.4, y: 0});
  assert.deepEqual(stamped(overlay, raster), [], 'the stationary layer is not repainted');
  // Figures moved by different deltas are stamped over the picture, as before.
  forget(raster, target, layer);
  const apart = new Map([[1, {x: 5, y: 0}], [2, {x: 0, y: 5}]]);
  overlay.draw(target.context, grouped([moving, still]), {...options, translations: apart});
  assert.deepEqual(stamped(overlay, target), ['#ff0000', '#00ff00', '#0000ff']);
  // The gesture over, the layer is released and the figures are back on the stationary layer.
  forget(raster, target);
  overlay.draw(target.context, grouped([moving, still]), {...options, translations: undefined});
  assert.deepEqual(stamped(overlay, raster), ['#ff0000', '#00ff00', '#0000ff']);
  assert.equal(overlay.moving.key, null); assert.deepEqual([layer.width, layer.height], [1, 1]);
});

test('a zoom in progress stamps sizes rounded down to half a backing pixel, and the next pass that is not a zoom repaints them exact', () => {
  const raster = new Surface(), target = new Surface(), overlay = new CanvasHandleOverlay(raster);
  const sizes = [2.1, 2.4, 3.3, 3.74, 4.9, 5];
  const handles = grouped([{uid: 1, handles: sizes.map((screenRadius, i) => ({uid: 1, point: {x: 20 + 30 * i, y: 50}, screenRadius, color: '#ff0000'}))}]);
  const options = {width: 200, height: 100, projectionKey: 'view', matrix: [1, 0, 0, 1, 0, 0]};
  const radii = () => raster.copies.filter(([source]) => source === overlay.sprites.atlas).map(([, x, y]) => overlay.sprites.lookAt(x, y).radius);
  for (const dpr of [1, 1.5]) {
    forget(raster);
    const zooming = overlay.draw(target.context, handles, {...options, dpr, zooming: true});
    assert.equal(zooming.full, true); assert.equal(zooming.settle, true, 'a zoom asks to settle');
    const drawn = radii();
    assert.deepEqual(drawn, sizes.map(radius => Math.floor(radius * dpr * 2) / (2 * dpr)));
    assert.ok(drawn.every((radius, i) => radius <= sizes[i] && radius > sizes[i] - .5 / dpr), 'never larger than where a click finds the joint, and within half a backing pixel');
    forget(raster);
    const rested = overlay.draw(target.context, handles, {...options, dpr});
    assert.equal(rested.full, true); assert.equal(rested.settle, false); assert.deepEqual(radii(), sizes);
  }
});
