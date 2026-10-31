// A project opened beside another (a tab) is owned by the engine like the first: its frame on show and geometry
// are the engine's, and so are the first project's again when its tab comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';

const doc = name => JSON.parse(readFileSync(new URL(`../engine/tests/edit/${name}.document.json`, import.meta.url), 'utf8'));
const engineGeometry = editor => {
  const group = editor.geometry?.objects?.values().next().value;
  return Boolean(editor._shown?.active) && Boolean(group) && 'bounds' in group;
};

test('a project opened in a tab beside another shows the engine\'s frame, and so does the first when it comes back', {skip: !engineBuilt}, async () => {
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(doc('startup'));
  const owner = installEngineOwner(editor);
  try {
    assert.ok(engineGeometry(editor), 'the first project');
    let first = null;
    await editor.loadAsync(doc('sheet-layers'), 'Second', {onDetach: session => { first = session; }});
    assert.ok(first, 'the first project rests in its tab');
    assert.ok(engineGeometry(editor), 'the second project');
    editor.select(editor.evaluatedFrame.objects[0].unique_id, -1); editor.moveSelection(5, 5);
    assert.deepEqual(owner.refused, {}, 'its edits run in the engine');
    editor.handOverDocument(() => {});
    editor.resumeDocument(first);
    assert.ok(engineGeometry(editor), 'the first project again');
  } finally { owner.release(); }
});
