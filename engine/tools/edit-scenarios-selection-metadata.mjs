// Optional selection state uses the real Editor owner; these replays make no
// selection-sensitive geometry-command admission. @selection/@restoreSelection
// are replay-only reads/restores of _selectionState/_restoreSelection.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open, nextKey, prune, documentOf, limb} from './fixture-kit.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const base = JSON.parse(readFileSync(`${out}/builder.document.json`, 'utf8'));
const others = documentOf([limb(), limb(), limb()], index => [480 + index * 80, 200]);
base.figure_types.push(...others.figure_types.map((figure, index) => ({...figure, figure_type_id: index + 2})));
base.keyframes[0].objects.push(...others.keyframes[0].objects.map((object, index) => ({...object, figure_type_id: index + 2, unique_id: index + 2, object_slot: index + 1})));
base.keyframes[0].object_draw_order = [0, 1, 2, 3];
base.keyframes[0].object_draw_order_unique_ids = [1, 2, 3, 4];
for (const kind of ['plain', 'layout', 'support', 'saved-layout', 'saved-support']) for (const mode of kind.startsWith('saved-') ? ['sheet', 'autokey-sheet'] : ['native', 'sheet', 'autokey-sheet']) {
  const options = mode === 'native' ? {} : {layerTimeline: true, propertyChannels: true, autoKey: mode === 'autokey-sheet'};
  let seed = open(structuredClone(base));
  seed.select(2);seed.joinTo(1, 22);seed.select(3);seed.joinTo(2, 33);seed.select(4);seed.joinTo(1, 44);
  seed.select(1, 1);
  if (kind !== 'plain') seed.setOrigin(22);
  if (kind.endsWith('support')) {
    seed.select(1, seed.figure.segments.findIndex(segment => segment.segment_id === 11));seed.deleteSingleSegment();
    seed.addPolygon([0, 22, 33]);seed.addPolygon([0, 33, 77]);
  }
  nextKey(seed, 6);seed.select(1);seed.moveSelection(16.125, -8.25);seed.setFrameDuration(6);seed.seek(0);
  if (kind.startsWith('saved-')) {
    seed = open(seed.report, {propertyChannels: true});
    seed.addAnimationKeys([{target: {kind: 'figure', uid: 1}, property: 'x', tick: 0, value: 300.25}, {target: {kind: 'figure', uid: 1}, property: 'x', tick: 8, value: 340.5}]);
  }
  const name = `selection-metadata-${kind}-${mode}`, document = `${name}.document.json`;
  const loaded = mirror(open(prune(seed.report), options));writeFileSync(`${out}/${document}`, loaded);
  const editor = open(JSON.parse(loaded), options);editor.autoKey = options.autoKey ?? false;
  const steps = [];let changed = 0;
  const run = (...step) => {
    steps.push(step);const before = mirror(editor);
    if (step[0] === '@restoreSelection') editor._restoreSelection(step[1]);
    else editor[step[0] === '@select' ? 'select' : step[0] === '@seek' ? 'seek' : step[0]](...step.slice(1));
    changed += before !== mirror(editor);steps.push(['@selection']);
  };
  run('@seek', 3.5);
  run('selectPolygon', 1, 0);run('selectMany', [1]);run('@seek', 2.25);
  let state = editor._selectionState();run('@restoreSelection', {...state, polygonSelection: {...state.polygonSelection, unknown: {label: 'polygon', nested: [1, 2]}}});
  run('setFPS', 31);run('@select', 2, 0);run('undo');run('redo');
  run('selectPolygon', 1, 1);run('selectPolygon', 999, 0);run('selectPolygon', 1, 999);
  run('toggleSegment', 999, 0); // Invalid toggle clears the polygon first.
  run('selectPolygon', 1, 2);run('toggleSegment', 1, 999);
  run('@select', 1, 0);run('toggleSegment', 1, 1);run('toggleSegment', 1, 2);
  run('setCanvasSize', 720, 480);run('@select', 4, -1);run('undo');run('redo');
  const ids = [...editor.selectedSegmentIds];state = editor._selectionState();
  run('@restoreSelection', {...state, segmentIds: [ids[1], 9999, ids[0], ids[1], ...ids.slice(2)]});
  run('toggleSegment', 1, 1);run('toggleSegment', 1, 0);run('toggleSegment', 1, 2);
  run('selectBranch', 1, 0);run('@select', 1, 0); // Existing branch selection short-circuits select.
  run('selectBranch', 1, 999); // Invalid branch clears only segment state.
  state = editor._selectionState();run('@restoreSelection', {...state, branch: {...state.branch, unknown: {label: 'branch', flags: [false, true]}}});
  run('updateProject', {fps: 47, canvas_width: 640, canvas_height: 400});run('selectMany', [4, 2, 1]);run('undo');run('redo');
  run('selectMany', [4, 4, 999, 2]);run('@seek', 6.5);run('@seek', 3.5);
  state = editor._selectionState();run('@restoreSelection', {...state, uid: 999, uids: [999, 1, 4, 1], joint: 1,
    polygonSelection: {uid: 1, index: 0, typeId: 999, unknown: 'invalid type'}, segmentIds: [999, 11], branch: {uid: 999, joint: 1, unknown: 'hidden'}});
  run('selectMany', [1]);run('@select', 1, -1);
  state = editor._selectionState();const figure = editor.figure;
  run('@restoreSelection', {...state, frameIndex: 99, tick: 99, uid: 1, uids: [1], joint: -1,
    activeLayerId: 'missing-layer', sheetSelection: {id: editor.activeLayerId, contents: false},
    polygonSelection: {uid: 1, index: 999, id: figure.polyfills[1].polyfill_id, typeId: figure.figure_type_id, unknown: 'stable id'}});
  run('setFPS', 48);run('@select', 2, -1);run('undo');run('redo');
  run('selectMany', []);run('@select', 1, -1);run('selectPolygon', 1, 0);
  state = editor._selectionState();run('@restoreSelection', {...state, segmentIds: [11, 22], branch: {uid: 1, joint: -1}});
  if (changed < 6) throw Error(`${name}: expected history mutations, got ${changed}`);
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor: options, steps}, null, 1) + '\n');
  console.log(`${name}: ${steps.length} steps, ${changed} document changes`);
}
