// A movieclip made inside a movieclip retains the scene the outer clip retains, cut down to its figures. That older scene numbers its figures
// on its own: a figure of it with the number of the new clip's figure is not that figure, and the file must still open (a recorded run of ten
// calls, found by the movieclip fuzz, wrote a file refused with "Unknown figure or repeated object identity").
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {snapshotDocument} from '../src/engine/engine-owner.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';
import {openBytes} from '../src/engine/engine-open.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

const options = {demo: false, layerTimeline: true, propertyChannels: true};
const fixture = JSON.parse(readFileSync(new URL('../engine/tests/edit/sheet-movieclip.document.json', import.meta.url), 'utf8'));

/** The project file the editor saves. */
const saved = (editor, scopes) => makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(editor.report)], scopes, name: 'Saved'}}).bytes;
async function opens(bytes) {
  const opened = await openBytes(new Uint8Array(bytes), 'saved.styk', {layerTimeline: true});
  opened.dispose();
}

test('a movieclip made inside a movieclip made from nothing saves a file that opens', async () => {
  const {editor} = ownedEditorSync(options, fixture, {verify: false, recorded: false});
  editor.addCameraMotion('shake', {start: 1, duration: 13});
  editor.selectMany([4, 5]);
  editor.createMovieclip({start: 7, end: 11});
  editor.deleteSelection();
  const clip = editor.createMovieclip({});
  editor.copySelection();
  editor.pasteSelection();
  editor.enterMovieclip(clip.figure_type_id);
  editor.copySelection();
  editor.pasteSelection();
  editor.createMovieclip({});
  editor.leaveMovieclip();
  assert.equal(editor._movieclipScopes?.length ?? 0, 0, 'back in the project');
  await opens(saved(editor, []));
});
