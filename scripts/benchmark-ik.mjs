import {performance} from 'node:perf_hooks';
import {mkdir, writeFile} from 'node:fs/promises';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {ikLayout, solveObjectIK} from '../src/ik.mjs';

const document = emptyDocument(), figure = document.figure_types[0], base = figure.segments[0];
figure.segments = [
  {...base, segment_id: 1, parent_id: 0, length: 90, angle_rad: .8, aux_code: 0},
  {...base, segment_id: 2, parent_id: 1, length: 90, angle_rad: 2, aux_code: 0},
  {...base, segment_id: 3, parent_id: 2, length: 35, angle_rad: 0, aux_code: 0},
]; figure.segment_count = 3;
const objects = Array.from({length: 1000}, (_, i) => createObject(figure, i + 1, 300 + i * 3, 150));
document.keyframes = [createFrame(objects, 1)];
const editor = new Editor({demo: false}).load(document); editor.select(1, 1); editor.setNodeIK({enabled: true});
const object = editor.object, layout = ikLayout(figure), root = {x: object.root_x, y: object.root_y};
for (let i = 0; i < 1000; i++) solveObjectIK(figure, object, root, layout);
const solveSamples = [];
for (let batch = 0; batch < 100; batch++) {
  const start = performance.now();
  for (let i = 0; i < 100; i++) solveObjectIK(figure, object, {...root, x: root.x + Math.sin(i) * 10}, layout);
  solveSamples.push((performance.now() - start) / 100);
}
const geometry = editor.geometry, unrelated = geometry.objects.get(999), gestureSamples = [];
editor.select(1, -1); editor.beginTranslationDrag();
for (let i = 0; i < 160; i++) {
  const start = performance.now(); editor.moveSelection(Math.sin(i / 10) * 10, -10, {fromStart: true}); editor.geometry;
  if (i >= 40) gestureSamples.push(performance.now() - start);
}
const retained = editor.geometry.objects.get(999) === unrelated;
editor.commitDrag();
const stats = values => {const v = [...values].sort((a,b) => a-b); return {samples: v.length, p50_ms: v[Math.floor(v.length*.5)], p95_ms: v[Math.floor(v.length*.95)], max_ms: v.at(-1)};};
const joinedDocument = structuredClone(document);
for (const o of joinedDocument.keyframes[0].objects) delete o._stykIK;
const part = {...structuredClone(figure), figure_type_id: 2, segments: [
  {...figure.segments[0], segment_id:101,parent_id:0,length:60,angle_rad:1.8},
  {...figure.segments[2], segment_id:102,parent_id:101,length:30,angle_rad:0},
], segment_count:2};
joinedDocument.figure_types.push(part);
const child = createObject(part,1000,300,150); child.object_slot=999;
child.join={target_object_slot:0,target_unique_id:1,target_handle_id:1};
joinedDocument.keyframes[0].objects[999]=child;
const joinedEditor = new Editor({demo:false}).load(joinedDocument); joinedEditor.select(1000,0); joinedEditor.setNodeIK({enabled:true});
const joinedUnrelated=joinedEditor.geometry.objects.get(998), joinedSamples=[];
joinedEditor.select(1,-1); joinedEditor.beginTranslationDrag();
for(let i=0;i<160;i++){
  const start=performance.now();joinedEditor.moveSelection(Math.sin(i/10)*8,-5,{fromStart:true});joinedEditor.geometry;
  if(i>=40)joinedSamples.push(performance.now()-start);
}
const joinedRetained=joinedEditor.geometry.objects.get(998)===joinedUnrelated;
joinedEditor.commitDrag();
const result = {node: process.version, platform: process.platform, scope: 'CPU only; warmed solver and editor mutation + geometry. Excludes GPU and display.',
  analyticTwoBone: stats(solveSamples), rootDragIn1000FigureScene: stats(gestureSamples), joinedRootDragIn1000FigureScene:stats(joinedSamples), unrelatedGeometryRetained: retained, joinedUnrelatedGeometryRetained:joinedRetained};
if (!retained || !joinedRetained) throw new Error('An IK drag invalidated unrelated figure geometry.');
await mkdir('artifacts/ik', {recursive: true}); await writeFile('artifacts/ik/performance.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
