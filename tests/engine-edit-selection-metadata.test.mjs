import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner, openingSession} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';
const input = JSON.parse(readFileSync(new URL('../engine/tests/edit/selection-metadata-plain-native.document.json', import.meta.url), 'utf8'));
const metadata = state => Object.fromEntries(['polygonSelection', 'segmentIds', 'branch'].filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));
/** The editor owned by the real engine, as the app has it. It records the state its session starts with and the view each call carries. */
function owned(editor) {
  const states = [], views = [];
  const opening = editor._opening, startSession = opening.startSession.bind(opening);
  opening.startSession = state => { states.push(structuredClone(state)); return startSession(state); };
  const start = target => {
    const session = openingSession(target);
    return new Proxy(session, {get: (held, name) => name === 'call'
      ? (method, args, view) => { views.push(JSON.parse(view)); return held.call(method, args, view); }
      : typeof held[name] === 'function' ? held[name].bind(held) : held[name]});
  };
  return {owner: installEngineOwner(editor, {start}), states, views};
}
test('a call made with optional selection open is refused and keeps the selection', {skip: !engineBuilt}, async () => {
  const editor = new Editor({demo: false}).load(structuredClone(input));editor.select(1, -1);
  const polygon = {uid: 1, index: 0, typeId: editor.figure.figure_type_id, future: {values: [7, 3]}};
  editor._restoreSelection({...editor._selectionState(), polygonSelection: polygon});
  const {owner, views} = owned(editor);
  const refused = () => assert.throws(() => editor.locateCamera(), error => error.messageKey === 'errors.engineOwner.notSupported');
  refused();assert.deepEqual(editor._selectionState().polygonSelection, polygon);
  assert.deepEqual(metadata(views[0]), {polygonSelection: polygon}, 'the view carries the selection metadata');
  assert.equal(owner.native, 0, 'optional selection readiness stays closed');assert.equal(owner.fallback, 0, 'a refusal never runs in the editor');
  assert.deepEqual(owner.refused, {'locateCamera: locateCamera with optional selection metadata': 1});
  refused();assert.deepEqual(editor._selectionState().polygonSelection, polygon);
  assert.equal(editor.canUndo, false);
  owner.release();
});
test('ordinary views omit optional selection fields', {skip: !engineBuilt}, async () => {
  const editor = new Editor({demo: false}).load(structuredClone(input));editor.select(1, -1);
  const {owner, states, views} = owned(editor);
  // A call the session answers on this document: the figures move as they would anywhere.
  editor.moveSelection(2, 1);assert.deepEqual(metadata(states[0]), {});assert.deepEqual(metadata(views[0]), {});
  assert.equal(Object.hasOwn(states[0], 'segmentIds'), false);assert.equal(Object.hasOwn(states[0], 'branch'), false);
  assert.deepEqual(editor._selectionState().polygonSelection ?? null, null);
  owner.release();
});
