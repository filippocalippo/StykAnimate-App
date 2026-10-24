// Future-only property targets: use the editor's actual sheet publication and known rig data.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const input = JSON.parse(readFileSync(`${out}/origin-pose-support-native.document.json`, 'utf8'));
const rig = JSON.parse(JSON.parse(readFileSync(`${out}/rig-drag-sheet.reference.json`, 'utf8')).steps[0].document);
const figure = structuredClone(rig.figure_types[0]);figure.figure_type_id = 3;input.figure_types[2] = figure;
const pose = rig.keyframes[0].objects.find(object => object.figure_type_id === rig.figure_types[0].figure_type_id);
for (const frame of [...input.keyframes, ...Object.values(input._styk.frameSources ?? {})]) for (let slot = 0; slot < frame.objects.length; slot++) {
  if (frame.objects[slot].unique_id === 3) frame.objects[slot] = {...structuredClone(pose), figure_type_id: 3, unique_id: 3, object_slot: slot, join: null};
}
const native = open(input);native.select(3);native.deleteFigure();
const editor = {layerTimeline: true, propertyChannels: true}, sheet = open(JSON.parse(mirror(native)), editor);
if (sheet.evaluatedFrame.objects.some(object => object.unique_id === 3)) throw Error('Future-only rig present at current playhead');
const document = mirror(sheet);writeFileSync(`${out}/origin-future-rig-sheet.document.json`, document);
const oracle = open(JSON.parse(document), editor);oracle.addAnimationKey({kind: 'figure', uid: 3}, 'rotation', 8, .47);
if (mirror(oracle) === document) throw Error('Future-only rig key did not reach the editor target');
const oracleBatch = open(JSON.parse(document), editor);oracleBatch.addAnimationKeys([{target: {kind: 'figure', uid: 3}, property: 'rotation', tick: 8, value: .31}]);
if (mirror(oracleBatch) === document) throw Error('Future-only rig batch key did not reach the editor target');
const atFuture = open(JSON.parse(document), editor);atFuture.seek(8);
if (!snapshotPoseFrame(atFuture.evaluatedFrame).objects.some(object => object.unique_id === 3)) throw Error('Future-only rig absent at actual entry tick');
const joinedNative = open(JSON.parse(mirror(native)));joinedNative.seek(8);joinedNative.select(1);joinedNative.joinTo(3, 22);joinedNative.seek(0);
const joinedSheet = open(JSON.parse(mirror(joinedNative)), editor), joinedDocument = mirror(joinedSheet);
writeFileSync(`${out}/origin-future-rig-joined-sheet.document.json`, joinedDocument);
const joinedOracle = open(JSON.parse(joinedDocument), editor);joinedOracle.addAnimationKey({kind: 'figure', uid: 2}, 'x', 8, 410.75);
if (mirror(joinedOracle) === joinedDocument) throw Error('Future rig root not reached by joined child position');
const changing = JSON.parse(readFileSync(`${out}/origin-pose-support-native.document.json`, 'utf8'));
const nextDefinition = structuredClone(figure);nextDefinition.figure_type_id = 4;changing.figure_types.push(nextDefinition);
const futurePose = {...structuredClone(pose), figure_type_id: 4, unique_id: 3, object_slot: 2, join: null};
changing.keyframes[1].objects[2] = futurePose;
const changingSheet = open(changing, editor), changingDocument = mirror(changingSheet);
writeFileSync(`${out}/origin-changing-rig-sheet.document.json`, changingDocument);
const changingOracle = open(JSON.parse(changingDocument), editor);changingOracle.addAnimationKey({kind: 'figure', uid: 3}, 'rotation', 8, .43);
if (mirror(changingOracle) === changingDocument) throw Error('Changed future definition not reached by the editor property owner');
const plainInput = JSON.parse(document);for (const segment of plainInput.figure_types[2].segments) delete segment._stykRig;
const plainDocument = mirror(open(plainInput, editor));writeFileSync(`${out}/origin-future-plain-sheet.document.json`, plainDocument);
const steps = [
  ['@select', 1, -1], ['addAnimationKey', {kind: 'figure', uid: 3}, 'rotation', 8, .47], ['undo'], ['redo'],
  ['addAnimationKeys', [{target: {kind: 'figure', uid: 3}, property: 'x', tick: 8, value: 440.125}, {target: {kind: 'figure', uid: 3}, property: 'scale', tick: 8, value: .91}]], ['undo'], ['redo'],
  ['@seek', 8], ['addAnimationKeys', [{target: {kind: 'figure', uid: 3}, property: 'rotation'}]], ['undo'], ['redo'],
  ['beginAnimationEdit', {kind: 'figure', uid: 3}, 'rotation'], ['previewAnimationEdit', .38], ['cancelAnimationEdit'],
  ['@seek', 3.5], ['@seek', 0],
].flatMap(step => [step, ['@frame']]);
writeFileSync(`${out}/origin-channels-future-sheet.scenario.json`, JSON.stringify({name: 'origin-channels-future-sheet', document: 'origin-future-plain-sheet.document.json', editor, steps}, null, 1) + '\n');
console.log('Future-only rig/rig parent: editor mutation reachable at tick8; plain target recorder keeps supported future keys');
