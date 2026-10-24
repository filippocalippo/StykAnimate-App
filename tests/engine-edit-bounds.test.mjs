import test from 'node:test';
import assert from 'node:assert/strict';
import {appBoundsMarker, captureEditBounds, markAppBounds, MAX_BOUNDS_SAMPLES} from '../src/engine/engine-edit-bounds.mjs';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {appBounds} from '../engine/tools/edit-bounds-callbacks.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';
const editor = {tick: 3, frameIndex: 0, selectedUids: new Set([7, 2])};
const entry = {obj: {unique_id: 7}};
test('bounds bridge records existing requests once, preserves callback receiver and frame range properties', () => {
  const result = {minX: -4, minY: 3, maxX: 8, maxY: 9}, receiver = {}, range = Object.assign([0], {sheetTicks: [3, 6]});
  let calls = 0;
  const callback = function (given) { calls++; assert.equal(this, receiver); assert.equal(given, entry); return result; };
  const capture = captureEditBounds('centerCamera', ['both', range, {boundsOf: callback}], editor);
  assert.equal(calls, 0); assert.equal(capture.args[2].boundsOf.call(receiver, entry), result); assert.equal(calls, 1);
  const args = JSON.parse(capture.payload()), data = args[2].boundsOf['@measuredBounds'];
  assert.deepEqual(data.input, ['both', {'@array': [0], sheetTicks: [3, 6]}]);
  assert.deepEqual(data.samples, [{uid: 7, bounds: result}]); assert.deepEqual(data.selectedUids, [7, 2]);
});

test('an app-registered callback reaches the engine as a marker and is never run for it; any other callback is recorded', () => {
  const own = markAppBounds(() => { throw new Error('the engine measures the app callback itself'); }), other = () => null;
  assert.deepEqual(appBoundsMarker(own), {'@boundsCallback': 'app'});
  assert.equal(appBoundsMarker(other), undefined); assert.equal(appBoundsMarker({'@boundsCallback': 'app'}), undefined); assert.equal(appBoundsMarker(undefined), undefined);
  const args = ['x', 'start', {boundsOf: own, ticks: [1, 4]}], capture = captureEditBounds('alignSelection', args, editor);
  assert.equal(capture.args, args);
  assert.deepEqual(JSON.parse(capture.payload()), ['x', 'start', {boundsOf: {'@boundsCallback': 'app'}, ticks: [1, 4]}]);
  const recorded = captureEditBounds('alignSelection', ['x', 'start', {boundsOf: other}], editor);
  assert.notEqual(recorded.args[2].boundsOf, other); assert.ok(JSON.parse(recorded.payload())[2].boundsOf['@measuredBounds']);
});

test('recorded app bounds depend on hidden construction strokes, anchored media and effect reach', () => {
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/measured-bounds-media.document.json', import.meta.url), 'utf8'));
  const scene = new Editor({demo: false}).load(document).geometry;
  const hidden = scene.objects.get(0), media = scene.objects.get(2);
  const hiddenBox = appBounds()(hidden), visibleBox = appBounds()({...hidden, segments: hidden.segments.filter(item => item.seg.visible !== false)});
  assert.ok(hiddenBox.maxX > visibleBox.maxX + 100, 'fixture does not depend on the hidden endpoint');
  const full = appBounds()(media), noFx = appBounds({vfxBounds: false})(media);
  assert.ok(full.minX < noFx.minX && full.maxX > noFx.maxX, 'fixture does not depend on effect padding');
  const bare = {...media, segments: media.segments.map(item => item.type === 'image' ? {...item, asset: {...item.asset, display_width: 1, display_height: 1}} : item)};
  assert.notDeepEqual(appBounds()(bare), full, 'fixture does not depend on the anchored media extent');
});
test('nonplain results, getters, callback throws and oversized tapes keep callback behavior and refuse transport', () => {
  let reads = 0;
  const options = {get boundsOf() { reads++; return () => null; }};
  const accessor = captureEditBounds('centerCamera', ['x', [0], options], editor);
  assert.equal(reads, 0); assert.equal(accessor.args[2], options); assert.equal(accessor.payload(), null);
  for (const result of [Object.create({minX: 1}), 3, {get minX() { throw new Error('getter must not be read by capture'); }}]) {
    const capture = captureEditBounds('alignSelection', ['x', 'start', {boundsOf: () => result}], editor);
    assert.equal(capture.args[2].boundsOf(entry), result); assert.equal(capture.payload(), null);
  }
  const thrown = new Error('same callback error'), capture = captureEditBounds('centerCamera', ['x', [0], {boundsOf: () => { throw thrown; }}], editor);
  assert.throws(() => capture.args[2].boundsOf(entry), error => error === thrown); assert.equal(capture.payload(), null);
  const bounded = captureEditBounds('centerCamera', ['x', [0], {boundsOf: () => null}], editor);
  for (let n = 0; n <= MAX_BOUNDS_SAMPLES; n++) assert.equal(bounded.args[2].boundsOf(entry), null);
  assert.equal(bounded.payload(), null);
});

test('unsupported nested option data leaves getters, toJSON and the original call untouched', () => {
  let invoked = 0;
  const callback = () => null;
  for (const nested of [{get ticks() { invoked++; return []; }}, {toJSON() { invoked++; return null; }}, {data: 1n}]) {
    const args = ['both', [0], {boundsOf: callback, extra: nested}];
    const capture = captureEditBounds('centerCamera', args, editor);
    assert.equal(capture.args, args); assert.equal(capture.payload(), null);
  }
  assert.equal(invoked, 0);
});

/** The editor owned by the real engine, as the app has it: the session its open started edits the document. */
const owned = editor => installEngineOwner(editor);
test('the engine measures the app\'s bounds callback itself; any other callback is refused', {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/measured-bounds.document.json', import.meta.url), 'utf8'));
  const outcomes = [];
  for (const app of [false, true]) {
    const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(structuredClone(document));
    editor.selectMany([1, 3]);
    const owner = owned(editor), order = [], queries = appBounds();
    const boundsOf = entry => { order.push(entry.obj.unique_id); return queries(entry); };
    if (!app) {
      // A function that is not the app's marker is not data for the session: refused, never run in the editor.
      const before = JSON.stringify(editor.report);
      assert.throws(() => editor.alignFiguresInFrames('x', 'end', [0, 1], {boundsOf}), error => error.messageKey === 'errors.engineOwner.notSupported');
      assert.deepEqual(order, [], 'nothing measured the figures');
      assert.equal(owner.native, 0); assert.equal(owner.fallback, 0);
      assert.deepEqual(owner.refused, {'alignFiguresInFrames: arguments that are not plain data': 1});
      assert.equal(JSON.stringify(editor.report), before);
      owner.release();
      continue;
    }
    const result = editor.alignFiguresInFrames('x', 'end', [0, 1], {boundsOf: markAppBounds(boundsOf)});
    assert.deepEqual(result, {changedFrames: 2, changedTicks: [0, 6], insertedUids: []});
    assert.deepEqual(order, [], 'the engine did not call back'); assert.equal(owner.native, 1); assert.equal(owner.fallback, 0);
    outcomes.push(JSON.stringify(editor.report));
    owner.release();
  }
  assert.equal(outcomes.length, 1);
});
