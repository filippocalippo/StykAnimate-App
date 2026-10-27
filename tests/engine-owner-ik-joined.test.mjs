// IK settings on figures joined into an assembly run in the engine's session under the owner (D19): switching a
// controller on from nothing, its chain, stretch and bend, releasing, pinning again, turning its target, switching it
// off, and posing the limb. Each is answered by the session (nothing refused, nothing run in the editor) and undone
// and redone exactly. The gate found the first of them refused with "This edit is not supported for this project yet"
// on a large joined project. The expectations are stated here; nothing is compared with the editor alone.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const folder = new URL('../engine/tests/edit/', import.meta.url);
const text = editor => JSON.stringify(editor.report);
const controller = (editor, uid, handle) => editor.evaluatedFrame.objects.find(object => object.unique_id === uid)?._stykIK?.[handle];

/** The first document of a recorded tape: the joined fixture as a layer sheet, a joined 3D rig natively. */
const documents = [
  {name: 'ik-joined-sheet', uid: 3, joint: 1, handle: 34, options: {layerTimeline: true, propertyChannels: true}},
  {name: 'ik-spatial-joined-native', uid: 3, joint: 6, handle: 7, options: {layerTimeline: false, propertyChannels: false}},
];

for (const {name, uid, joint, handle, options} of documents) {
  test(`${name}: IK on a joined figure is set, posed, undone and redone by the session`, {skip: !engineBuilt}, async () => {
    const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder), 'utf8'));
    const document = JSON.parse(readFileSync(new URL(scenario.document, folder), 'utf8'));
    const {editor, owner} = await ownedEditor({demo: false, ...options}, document, {recorded: false});
    try {
      editor.select(uid, joint);
      const states = [text(editor)];
      const step = (label, run) => {
        run();
        states.push(text(editor));
        assert.notEqual(states.at(-1), states.at(-2), `${label} changed the document`);
      };
      step('switching it on', () => assert.equal(editor.setNodeIK({enabled: true}), true));
      const made = controller(editor, uid, handle);
      assert.ok(made?.enabled && made.pinned, 'switched on pinned where the limb is drawn');
      assert.ok(made.joinedFollowers && made.bendReference, 'the limb across the assembly is captured');
      step('posing the limb', () => {
        editor.beginDrag('Pose joint');
        editor.poseJoint(made.target.x - 40, made.target.y + 25);
        assert.equal(editor.commitDrag(), true);
      });
      assert.equal(controller(editor, uid, handle).target.x, made.target.x - 40, 'the target followed the pointer');
      step('a shorter chain', () => assert.equal(editor.setNodeIK({chainLength: 1}), true));
      step('stretching', () => assert.equal(editor.setNodeIK({allowStretch: true}), true));
      step('releasing it', () => assert.equal(editor.setNodeIK({pinned: false}), true));
      step('turning its target', () => assert.equal(editor.rotateIKTarget(0.4), true));
      assert.equal(controller(editor, uid, handle).target.rotation, 0.4);
      step('pinning it again', () => assert.equal(editor.setNodeIK({pinned: true}), true));
      step('switching it off', () => assert.equal(editor.setNodeIK({enabled: false}), true));
      assert.equal(controller(editor, uid, handle), undefined, 'a controller switched off is removed');
      assert.equal(editor.undoLabel, 'Configure IK');

      for (let at = states.length - 2; at >= 0; at--) {
        assert.equal(await editor.undo(), true);
        assert.equal(text(editor), states[at], `undo gives the document before step ${at + 1}`);
      }
      assert.equal(editor.canUndo, false);
      for (let at = 1; at < states.length; at++) {
        assert.equal(await editor.redo(), true);
        assert.equal(text(editor), states[at], `redo gives the document after step ${at}`);
      }
      assert.deepEqual(Object.keys(owner.refused), [], 'nothing was refused');
      assert.deepEqual(owner.refused, {}, 'the session refused nothing');
    } finally { owner.release(); }
  });
}

test('a controller that shares bones with another of the assembly is refused with the editor\'s own message', {skip: !engineBuilt}, async () => {
  const scenario = JSON.parse(readFileSync(new URL('ik-joined-sheet.scenario.json', folder), 'utf8'));
  const document = JSON.parse(readFileSync(new URL(scenario.document, folder), 'utf8'));
  const {editor, owner} = await ownedEditor({demo: false, layerTimeline: true, propertyChannels: true}, document, {recorded: false});
  try {
    editor.select(3, 0);
    const before = text(editor);
    assert.throws(() => editor.setNodeIK({enabled: true}), /IK chains cannot share bones/);
    assert.equal(text(editor), before, 'a refused setting changes nothing');
    assert.equal(editor.canUndo, false);
  } finally { owner.release(); }
});
