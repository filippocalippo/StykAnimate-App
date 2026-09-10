import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {OnionSkinCache} from '../src/onion-skin.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = Array.from({length: 40}, (_, i) => createFrame(Array.from({length: 80}, (_, slot) => {
    const object = createObject(figure, slot + 1, 100 + slot * 20 + (slot < 2 ? i * 10 : 0), 250, {field28: 80});
    if (slot === 1) object.join = {target_object_slot: 0, target_handle_id: 1};
    return object;
  }), 3));
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(report);
  editor.seek(30); editor.select(1, 0);
  let built = 0;
  const cache = new OnionSkinCache({geometry(report, frame, incremental) {
    built += incremental ? incremental.dirtySlots.size : frame.objects.length;
    return buildGeometry(report, frame, incremental);
  }});
  const settings = normalizeEditorSettings();
  return {editor, cache, settings, built: () => built};
}
function parity(editor, cache, settings) {
  const fresh = new OnionSkinCache();
  assert.deepEqual(cache.get(editor, settings).map(s => s.geometry.drawables), fresh.get(editor, settings).map(s => s.geometry.drawables));
}

test('adjacent onion poses share static geometry and tinted artwork', () => {
  const {editor, cache, settings, built} = fixture();
  const first = cache.get(editor, settings), baseline = built();
  // First complete pose + only two moving joined objects in the other poses.
  assert.equal(baseline, 84);
  assert.equal(first[0].geometry.orderedObjects[2], first[1].geometry.orderedObjects[2]);
  editor.seek(33); const next = cache.get(editor, settings);
  assert.equal(built() - baseline, 4);
  assert.equal(next[0].geometry.orderedObjects[2], first[0].geometry.orderedObjects[2]);
  parity(editor, cache, settings);
});

test('node drags do zero ghost geometry work; commits and history retain unchanged neighbors', () => {
  const {editor, cache, settings, built} = fixture();
  const before = cache.get(editor, settings), baseline = built();
  editor.beginDrag();
  for (let i = 0; i < 30; i++) { editor.rotateJoint(.01); assert.equal(cache.get(editor, settings), before); }
  assert.equal(built(), baseline);
  editor.commitDrag(); const committed = cache.get(editor, settings);
  assert.equal(built(), baseline);
  for (let i = 0; i < before.length; i++) assert.equal(committed[i].geometry.orderedObjects[2], before[i].geometry.orderedObjects[2]);
  parity(editor, cache, settings);
  editor.undo(); cache.get(editor, settings); assert.equal(built(), baseline);
  editor.redo(); cache.get(editor, settings); assert.equal(built(), baseline);
});

test('editing a sampled pose or tween endpoint rebuilds only changed objects and attached descendants', () => {
  const {editor, cache, settings, built} = fixture();
  settings.onionMode = 'frames';
  const before = cache.get(editor, settings), baseline = built();
  editor.beginDrag(); editor.rotateJoint(.02); editor.commitDrag();
  const after = cache.get(editor, settings);
  assert.ok(built() - baseline <= 6);
  for (let i = 0; i < after.length; i++) {
    assert.notEqual(after[i].geometry.orderedObjects[0], before[i].geometry.orderedObjects[0]);
    assert.notEqual(after[i].geometry.orderedObjects[1], before[i].geometry.orderedObjects[1]);
    assert.equal(after[i].geometry.orderedObjects[2], before[i].geometry.orderedObjects[2]);
  }
  parity(editor, cache, settings);
});

test('shared-definition edits invalidate reused ghost artwork and history restores exact rendering', () => {
  const {editor, cache, settings} = fixture();
  const before = cache.get(editor, settings);
  editor.moveBuilderOrder({kind: 'segment', index: 0}, 'front');
  const after = cache.get(editor, settings);
  assert.notEqual(after[0].geometry.orderedObjects[2], before[0].geometry.orderedObjects[2]);
  parity(editor, cache, settings);
  editor.undo(); parity(editor, cache, settings);
  assert.deepEqual(cache.get(editor, settings).map(s => s.geometry.drawables), before.map(s => s.geometry.drawables));
});

test('scrubbing keeps cache residency bounded and revisiting warm frames does no geometry work', () => {
  const {editor, cache, settings, built} = fixture();
  for (let tick = 0; tick < 100; tick++) { editor.seek(tick); cache.get(editor, settings); }
  assert.ok(cache.samples.size <= 24);
  assert.ok(cache.retained.alternates.size <= cache.retained.maxAlternates);
  assert.ok(cache.retained.alternateDrawables <= cache.retained.maxAlternateDrawables);
  for (let tick = 27; tick < 36; tick++) { editor.seek(tick); cache.get(editor, settings); }
  const baseline = built();
  for (let i = 0; i < 60; i++) { editor.seek(27 + i % 9); cache.get(editor, settings); }
  assert.equal(built(), baseline);
  editor.load(emptyDocument()); cache.get(editor, settings);
  assert.equal(cache.retained.geometry, null); assert.equal(cache.samples.size, 0);
});
