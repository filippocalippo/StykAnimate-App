import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineBuilt, sessionFromDocument} from './support/engine-node.mjs';

const reference = () => JSON.parse(readFileSync(new URL('../engine/tests/edit/connected-selection-native.reference.json', import.meta.url), 'utf8'));

test('connected selection enforces host locks despite stale candidates, add and view', {skip: !engineBuilt}, async () => {
  const first = reference().steps[0];
  const session = await sessionFromDocument(JSON.parse(first.document), first.state);
  const call = (method, args, view = null) => JSON.parse(session.call(method, JSON.stringify(args), JSON.stringify(view)));
  const document = session.report_json(), revision = session.revision();
  try {
    call('selectMany', [[2,4]]);
    const corrected = JSON.parse(session.set_selection_locks(1, '[2]'));
    assert.deepEqual(corrected.selectedUids, [4]);
    const stale = {...first.state, selectedUid: 2, selectedUids: [2,4], selectionLocks: []};
    let answer = call('selectConnected', [1, {add: true, candidates: [1,2,3,999], selectionLocks: []}], stale);
    assert.equal(answer.status, 'ok');
    assert.deepEqual(answer.state.selectedUids, [4,1,3]);
    assert.deepEqual(answer.result.map(object => object.unique_id), [1,3,4]);
    assert.equal(answer.state.selectedUid, 1);
    answer = call('selectConnected', [1, {add: true, candidates: [1,2,3]}]);
    assert.deepEqual(answer.events, []);
    assert.throws(() => session.set_selection_locks(0, '[]'));
    assert.throws(() => session.set_selection_locks(1, '[]'));
    assert.deepEqual(JSON.parse(session.set_selection_locks(1, '[2,2]')).selectedUids, [4,1,3]);
    answer = call('selectConnected', [1, {add: true, candidates: null}], stale);
    assert.equal(answer.status, 'unported');
    assert.deepEqual(answer.state.selectedUids, [4]);
    assert.equal(session.report_json(), document);
    assert.equal(session.revision(), revision);
    assert.equal(session.can_undo(), false);
    // Only an explicit newer host policy can release the denied bridge.
    session.set_selection_locks(2, '[]');
    assert.deepEqual(call('selectConnected', [2]).state.selectedUids, [1,2,3]);
  } finally { session.free(); }
});

test('invalid lock updates do not consume a generation or clear the active mask', {skip: !engineBuilt}, async () => {
  const first = reference().steps[0];
  const session = await sessionFromDocument(JSON.parse(first.document), first.state);
  try {
    session.set_selection_locks(1, '[2]');
    for (const generation of [-1, 0.5, Infinity, NaN, 2**32]) assert.throws(() => session.set_selection_locks(generation, '[]'));
    for (const ids of ['null', '{}', '["2"]', '[2.5]', '[-1]', '[4294967296]', '[2, "3"]', 'invalid']) {
      assert.throws(() => session.set_selection_locks(2, ids));
    }
    const answer = JSON.parse(session.call('selectConnected', '[2]', 'null'));
    assert.deepEqual(answer.state.selectedUids, [1,3]);
    session.set_selection_locks(2, '[]');
    assert.deepEqual(JSON.parse(session.call('selectConnected', '[2]', 'null')).state.selectedUids, [1,2,3]);
  } finally { session.free(); }
});
