import test from 'node:test';
import assert from 'node:assert/strict';
import {appBoundsMarker, markAppBounds} from '../src/engine/engine-edit-bounds.mjs';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {appBounds} from './support/edit-bounds-callbacks.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
test('an app-registered callback reaches the engine as a marker; any other callback has none', () => {
  const own = markAppBounds(() => { throw new Error('the engine measures the app callback itself'); }), other = () => null;
  assert.deepEqual(appBoundsMarker(own), {'@boundsCallback': 'app'});
  assert.equal(appBoundsMarker(other), undefined); assert.equal(appBoundsMarker({'@boundsCallback': 'app'}), undefined); assert.equal(appBoundsMarker(undefined), undefined);
});

test('recorded app bounds depend on hidden construction strokes, anchored media and effect reach', {skip: !engineBuilt}, () => {
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/measured-bounds-media.document.json', import.meta.url), 'utf8'));
  const {editor, owner} = ownedEditorSync({demo: false}, document, {recorded: false});
  try {
    const scene = editor.geometry;
    const hidden = scene.objects.get(0), media = scene.objects.get(2);
    const hiddenBox = appBounds()(hidden), visibleBox = appBounds()({...hidden, segments: hidden.segments.filter(item => item.seg.visible !== false)});
    assert.ok(hiddenBox.maxX > visibleBox.maxX + 100, 'fixture does not depend on the hidden endpoint');
    const full = appBounds()(media), noFx = appBounds({vfxBounds: false})(media);
    assert.ok(full.minX < noFx.minX && full.maxX > noFx.maxX, 'fixture does not depend on effect padding');
    const bare = {...media, segments: media.segments.map(item => item.type === 'image' ? {...item, asset: {...item.asset, display_width: 1, display_height: 1}} : item)};
    assert.notDeepEqual(appBounds()(bare), full, 'fixture does not depend on the anchored media extent');
  } finally { owner.release(); }
});
/** The editor owned by the real engine, as the app has it: the session its open started edits the document. */
const owned = editor => installEngineOwner(editor);
test('the engine measures the app\'s bounds callback itself; any other callback is refused', {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/measured-bounds.document.json', import.meta.url), 'utf8'));
  const outcomes = [];
  for (const app of [false, true]) {
    const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(structuredClone(document));
    const owner = owned(editor);
    editor.selectMany([1, 3]);
    const order = [], queries = appBounds();
    const boundsOf = entry => { order.push(entry.obj.unique_id); return queries(entry); };
    if (!app) {
      // A function that is not the app's marker is not data for the session: refused, never run in the editor.
      const before = JSON.stringify(editor.report);
      assert.throws(() => editor.alignFiguresInFrames('x', 'end', [0, 1], {boundsOf}), error => error.messageKey === 'errors.engineOwner.notSupported');
      assert.deepEqual(order, [], 'nothing measured the figures');
      assert.equal(owner.native, 0);
      assert.deepEqual(owner.refused, {'alignFiguresInFrames: arguments that are not plain data': 1});
      assert.equal(JSON.stringify(editor.report), before);
      owner.release();
      continue;
    }
    const result = editor.alignFiguresInFrames('x', 'end', [0, 1], {boundsOf: markAppBounds(boundsOf)});
    assert.deepEqual(result, {changedFrames: 2, changedTicks: [0, 6], insertedUids: []});
    assert.deepEqual(order, [], 'the engine did not call back'); assert.equal(owner.native, 1); assert.deepEqual(owner.refused, {}, 'the session refused nothing');
    outcomes.push(JSON.stringify(editor.report));
    owner.release();
  }
  assert.equal(outcomes.length, 1);
});
