import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {applyDocumentPatch} from '../src/engine/engine-patch.mjs';
import {engineBuilt, sessionFromDocument} from './support/engine-node.mjs';

const folder = new URL('../engine/tests/edit/', import.meta.url);
const documentText = report => JSON.stringify(report, (key, value) => key === 'runtime_segments' ? undefined : value);

test('applying a patch keeps unchanged records and the root', () => {
  const root = {a: {x: 1}, b: [{y: 1}, {y: 2}], c: {keep: true}};
  const {a, b, c} = root, second = b[1];
  assert.deepEqual(applyDocumentPatch(root, [{p: ['b', 0, 'y'], v: 5}, {p: ['a', 'z'], v: 2}]), ['b', 'a']);
  assert.equal(root.c, c); assert.notEqual(root.a, a); assert.notEqual(root.b, b); assert.equal(root.b[1], second);
  assert.deepEqual(a, {x: 1}, 'the record before is not changed');
  applyDocumentPatch(root, [{p: ['b'], a: [1, {v: {y: 9}}, 0]}, {p: ['c'], o: [['later', 1], ['keep']]}, {p: ['a', 'x'], x: 1}]);
  assert.equal(JSON.stringify(root), '{"a":{"z":2},"b":[{"y":2},{"y":9},{"y":5}],"c":{"later":1,"keep":true}}');
  assert.equal(root.b[0], second);
});

// Every recorded tape whose steps are plain calls: the engine's patches rebuild the
// editor's document at every step.
const viewOf = state => ({tick: state.tick, frameIndex: state.frameIndex, selectedUid: state.selectedUid ?? null, selectedUids: state.selectedUids ?? [],
  selectedJoint: state.selectedJoint ?? -1, ...Object.fromEntries(['activeLayerId', 'sheetSelection', 'polygonSelection', 'segmentIds', 'branch'].filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]))});
const tapes = readdirSync(folder).filter(name => name.endsWith('.reference.json')).sort();
test('engine patches rebuild every recorded document', {skip: !engineBuilt}, async () => {
  let checked = 0, steps = 0;
  for (const name of tapes) {
    const reference = JSON.parse(readFileSync(new URL(name, folder), 'utf8'));
    if (reference.initialHistory || reference.steps.slice(1).some(step => !Array.isArray(step.call) || (/^@/.test(step.call[0]) && !['@seek', '@select'].includes(step.call[0])) || step.interleavings?.length || step.boundsArgs)) continue;
    const first = reference.steps[0];
    const report = JSON.parse(first.document);
    const state = {...first.state, propertyChannels: Boolean(reference.editor?.propertyChannels), layerTimeline: Boolean(reference.editor?.layerTimeline), autoKey: Boolean(reference.editor?.autoKey)};
    let session;
    session = await sessionFromDocument(report, state);
    assert.equal(session.report_json(), first.document, `${reference.scenario}: the session starts from the exact document`);
    let expected = first.document, view = first.state;
    try {
      for (const step of reference.steps.slice(1)) {
        const [method, ...args] = step.call;
        const answer = JSON.parse(session.call(method.replace(/^@/, ''), JSON.stringify(args), JSON.stringify({...viewOf(view), autoKey: state.autoKey, patch: true, draws: step.draws ?? []})));
        view = answer.state ?? view;
        if (answer.status === 'unported') break;
        if (answer.patch) applyDocumentPatch(report, answer.patch);
        if (step.document) expected = step.document;
        const actual = documentText(report);
        if (actual !== expected) {
          let at = 0; while (actual[at] === expected[at]) at++;
          assert.fail(`${reference.scenario} step ${step.step} (${method}): at ${at} engine …${actual.slice(at - 80, at + 80)}… editor …${expected.slice(at - 80, at + 80)}… patch ${JSON.stringify(answer.patch).slice(0, 300)}`);
        }
        steps++;
      }
    } finally { session.free(); }
    checked++;
  }
  assert.ok(checked > 200, `checked ${checked} tapes`);
  console.log(`# ${checked} tapes, ${steps} steps`);
});
