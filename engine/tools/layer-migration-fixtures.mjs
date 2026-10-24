// Read-only native planning and actual async editor publication oracles (D15).
import {writeFileSync, mkdirSync} from 'node:fs';
import {documentOf, limb, open, nextKey} from './fixture-kit.mjs';
import {planLayerMembershipMigrationSteps, migrationPlanPayload} from '../../src/editor-layer-migration.mjs';
const out = new URL('../tests/layer-migration/', import.meta.url);
mkdirSync(out, {recursive: true});
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);
function fixture(joined) {
  const e = open(documentOf([limb(true), limb(), limb()], i => [200 + i * 160, 150]));
  if (joined) {e.select(2); e.joinTo(1, 22);}
  nextKey(e, 6); e.select(1); e.moveSelection(30, 5); e.select(3); e.moveSelection(-10, 4);
  e.createLayer('Destination'); e.createLayer('Unchanged'); e.assignFiguresToLayer([2], 'layer-2'); e.assignFiguresToLayer([3], 'layer-3');
  return e;
}
const pose = (e, layer, keys) => e.addAnimationKeys(keys.map(([tick, frame, interpolation = 'linear']) => ({target: {kind: 'layer', id: layer}, property: 'pose', tick,
  value: {frameId: frame === null ? null : e.getFrameId(frame)}, interpolation})));
for (const name of ['native-only', 'independent', 'joined-scalars', 'delete-default', 'dense-single-figure']) {
  const e = name === 'dense-single-figure' ? open(documentOf([Array.from({length: 6000}, (_, i) => [i + 1, 0, 30 + i % 8, .1 + i % 5 * .2])])) : fixture(name === 'joined-scalars');
  if (name === 'dense-single-figure') { nextKey(e, 3); e.select(1); e.moveSelection(12, 7); e.createLayer('Destination'); e.createLayer('Unchanged'); }
  if (name === 'dense-single-figure') { pose(e, 'layer-1', [[0, 0], [3, 1], [6, 0]]); }
  else if (name !== 'native-only') {
    pose(e, 'layer-1', [[0, 0], [4, null], [8, 1]]); pose(e, 'layer-2', [[0, 1, 'hold'], [5, 0], [10, 1]]); pose(e, 'layer-3', [[0, 0], [9, 1]]);
    e.addAnimationKeys([{target: {kind: 'figure', uid: 1}, property: 'rotation', tick: 0, value: .7}, {target: {kind: 'figure', uid: 1}, property: 'scale', tick: 0, value: 1.3},
      {target: {kind: 'figure', uid: 2}, property: 'opacity', tick: 0, value: .6}]);
  }
  const deleting = name === 'delete-default', uids = name === 'joined-scalars' ? [2] : [1], targetLayerId = name === 'joined-scalars' ? 'layer-1' : 'layer-2';
  const request = {uids, targetLayerId, nextFrameIdentity: e._nextFrameIdentity, ...(deleting ? {deletedLayerId: 'layer-1'} : {})};
  const document = json(e.report), revision = e.revision, initialState = {selection: e._selectionState(), layerRevision: e.layerRevision}, events = [], progress = [];
  e.addEventListener('change', event => events.push(event.detail));
  let payload;
  const planner = async params => {
    const iterator = planLayerMembershipMigrationSteps({report: e.report, _nextFrameIdentity: params.nextFrameIdentity}, params.uids, params.targetLayerId,
      {worker: true, deletedLayerId: params.deletedLayerId, maxSourceBytes: 128 * 1024 * 1024});
    for (;;) {const step = iterator.next(); if (step.done) return (payload = migrationPlanPayload(step.value)); progress.push(step.value);}
  };
  const result = deleting ? await e.deleteLayerAsync('layer-1', {targetLayerId, planMigration: async p => (await planner(p)).plan})
    : await e.assignFiguresToLayerAsync(uids, targetLayerId, {planMigration: async p => (await planner(p)).plan});
  const after = json(e.report), state = {revision: e.revision, nextFrameIdentity: e._nextFrameIdentity, undoLabel: e.undoLabel, canUndo: e.canUndo}, editEvents = events.slice();
  e.undo(); const undone = json(e.report); e.redo(); const redone = json(e.report);
  writeFileSync(new URL(`${name}.json`, out), json({name, document, revision, initialState, request, payload, progress: progress.filter(step => step.completed === step.total), command: {name: deleting ? 'deleteLayerAsync' : 'assignFiguresToLayerAsync', result,
    after, state, events: editEvents, undone, redone}}) + '\n');
}
