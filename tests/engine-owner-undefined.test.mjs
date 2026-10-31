// A member of a patch that is `undefined` is not a value: the owner cannot say it in JSON, so it encodes it for the session
// (`styk-edit/src/args.rs`). Where the editor's command removed what the member names, the session removes it; everywhere else the
// member is absent; and no command ever stores the encoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rigExampleDocument} from '../src/rig-examples.mjs';
import {SESSION_COMMANDS} from '../src/engine/engine-commands.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';

const app = {demo: false, layerTimeline: true, propertyChannels: true};
const MARKER = '@undefined';

/** An editor the engine owns on a rig example, with the joint of the first figure selected. */
function rigged(name, joint) {
  const {editor, owner} = ownedEditorSync(app, rigExampleDocument(name), {recorded: false});
  editor.select(1, joint);
  return {editor, owner};
}
const rig = editor => editor.figure.segments[editor.selectedJoint]._stykRig;
const stored = (editor, owner) => [JSON.stringify(editor.report), owner.session().report_json()];
const noMarker = (editor, owner, message) => { for (const text of stored(editor, owner)) assert.ok(!text.includes(MARKER), message); };

test('every member of a rig behavior set to undefined is taken away, as the editor took it away', {skip: !engineBuilt}, () => {
  // [example, joint, the rig members the joint has]
  for (const [name, joint, members] of [
    ['perspective-conveyor-3d', 16, ['response', 'angleLock', 'orientation']],
    ['perspective-conveyor-3d', 2, ['stretch']],
    ['accordion-screen-3d', 6, ['follow', 'response']],
  ]) {
    for (const member of members) {
      const {editor, owner} = rigged(name, joint);
      const others = Object.keys(rig(editor)).filter(key => key !== member);
      assert.ok(Object.hasOwn(rig(editor), member), `${name} joint ${joint} has ${member}`);
      const entries = editor._undo.length;
      assert.equal(editor.setRigBehavior({[member]: undefined}), true, `${member} set to undefined`);
      assert.ok(!Object.hasOwn(rig(editor) ?? {}, member), `${name} joint ${joint}: ${member} is gone`);
      assert.deepEqual(Object.keys(rig(editor) ?? {}).sort(), others.sort(), 'the other members stay');
      assert.equal(editor._undo.length, entries + 1);
      assert.equal(editor.undoLabel, 'Edit rig behavior');
      noMarker(editor, owner, `${member} left the marker in the document`);
      editor.undo();
      assert.ok(Object.hasOwn(rig(editor), member), 'undone');
    }
  }
});

test('a member set to undefined inside a rig behavior removes the old one of that member alone', {skip: !engineBuilt}, () => {
  const {editor, owner} = rigged('accordion-screen-3d', 6);
  assert.deepEqual(rig(editor).response, {multiplier: 1});
  editor.setRigBehavior({response: {multiplier: undefined, mode: 'rigid'}});
  assert.deepEqual(rig(editor).response, {mode: 'rigid'}, 'the multiplier is gone, the mode is set');
  noMarker(editor, owner, 'the marker is not stored');
  // The connector is removed by deleting it, not by saying nothing: as the editor refuses it.
  const {editor: connected} = rigged('perspective-conveyor-3d', 2);
  assert.throws(() => connected.setRigBehavior({connector: undefined}), error => error.messageKey === 'errors.editorRigConstraints.deleteTheConnectorToRemoveItOrReconnect');
});

test('a figure field set to undefined is taken away, and nothing else of the figure changes', {skip: !engineBuilt}, () => {
  const {editor, owner} = ownedEditorSync(app, rigExampleDocument('solid-box-3d'), {recorded: false});
  editor.select(1, -1);
  editor.updateObject({_stykZIndex: 5});
  assert.equal(editor.object._stykZIndex, 5);
  const root = editor.object.root_x;
  editor.updateObject({_stykZIndex: undefined});
  assert.ok(!Object.hasOwn(editor.object, '_stykZIndex'), 'the stacking number is gone');
  assert.equal(editor.object.root_x, root);
  // A field set to nothing next to one that is set: the one is set, the other absent.
  editor.updateObject({root_x: root + 10, name: undefined});
  assert.equal(editor.object.root_x, root + 10);
  noMarker(editor, owner, 'the marker is not stored');
});

test('no command stores the encoding of a member set to undefined, whatever the patch it is given', {skip: !engineBuilt}, () => {
  const patch = () => ({
    x: undefined, name: undefined, color: undefined, opacity: undefined, field28: undefined, _stykZIndex: undefined, fps: undefined, enabled: undefined,
    response: undefined, stretch: undefined, follow: undefined, angleLock: undefined, anglePath: undefined, weighted: undefined, spatial: undefined,
    connector: undefined, orientation: undefined, params: {strength: undefined, other: 1}, nested: {y: undefined, z: 1},
  });
  const shapes = [(p) => [p], (p) => [1, p], (p) => ['layer-1', p], (p) => [1, 2, p], (p) => [[1], p], (p) => [p, p], (p) => [p, {indices: [0], label: 'x', ...p}]];
  const sent = new Set();
  for (const [example, joint] of [['solid-box-3d', 7], ['perspective-conveyor-3d', 16]]) {
    const {editor, owner} = ownedEditorSync(app, rigExampleDocument(example), {recorded: false, verify: false});
    for (const name of SESSION_COMMANDS) {
      for (const shape of shapes) {
        editor.select(1, joint);
        try { editor[name](...shape(patch())); sent.add(name); } catch { /* refused or invalid: nothing may be stored either */ }
      }
      for (const text of stored(editor, owner)) if (text.includes(MARKER)) assert.fail(`${name} stored the marker of a member set to undefined`);
    }
  }
  assert.ok(sent.size > 20, `the commands that took a patch: ${sent.size}`);
});
