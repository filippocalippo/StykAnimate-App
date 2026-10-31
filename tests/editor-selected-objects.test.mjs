// Playback emits a change on every tick, and panels read `selectedObjects` on each (the library's save buttons): with nothing selected
// that must not build the frame on show, which is a full read from the engine per tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const sheet = JSON.parse(readFileSync(new URL('../engine/crates/styk-eval/tests/fixtures/channels/channels-pose.sheet.json', import.meta.url), 'utf8'));
const options = {demo: false, layerTimeline: true, propertyChannels: true};

test('selectedObjects with nothing selected does not read the frame on show', {skip: !engineBuilt}, async () => {
  const {editor} = await ownedEditor(options, sheet);
  let reads = 0;
  const shown = editor._shown, frame = shown.frame;
  shown.frame = (...args) => { reads++; return frame.apply(shown, args); };
  editor.select(null);
  reads = 0; // selecting is an edit, not a tick of playback
  for (let tick = 0; tick < 6; tick++) {
    editor.seek(tick, {evaluate: false});
    assert.deepEqual(editor.selectedObjects, []);
  }
  assert.equal(reads, 0, 'no frame was read for an empty selection');
  editor.seek(2, {evaluate: false});
  const uid = editor.evaluatedFrame.objects[0].unique_id;
  editor.select(uid, -1);
  assert.deepEqual(editor.selectedObjects.map(object => object.unique_id), [uid], 'a selection still finds its objects');
  assert.ok(reads > 0);
});
