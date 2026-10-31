import test from 'node:test';
import assert from 'node:assert/strict';
import {engineEditor} from './support/owned-editor.mjs';
/** The frames of the layer sheet at these ticks, as the timeline chooses them. */
const sheetRange=(e,ticks)=>Object.assign([e.frameIndex],{sheetTicks:ticks});
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {presencePlayback} from './support/movieclip-playback.mjs';
import {poseObjectSignature} from './support/pose-snapshot.mjs';
import {validateLayerState} from '../src/layers.mjs';
import {validateLayerSheet} from '../src/layer-sheet.mjs';

function fixture({destination='new'}={}){
  const source=emptyDocument();source.keyframes=[createFrame([createObject(source.figure_types[0],1,100,100)],3),createFrame([createObject(source.figure_types[0],1,110,100)])];
  const clip=movieclipFigure(2,'Motion',source,{duration:4});
  const report=emptyDocument();report.figure_types.push(clip);
  report.keyframes=[0,10,20].map(x=>createFrame([createObject(report.figure_types[0],1,100+x,100),createObject(report.figure_types[0],2,200+x,100),createObject(clip,7,300+x,100,{_stykMovieclip:presencePlayback()})],10));
  const e=engineEditor({demo:false,layerTimeline:true}, report),second=e.createLayer('Second').id;
  e.assignFiguresToLayer([2],second);e.sheetInsertKey(['layer-1',second],0);
  const target=e.createLayer('Destination').id;
  if(destination!=='new')e.sheetInsertKey([target],0,{blank:true});
  if(destination==='hold')e.sheetSetDuration(21,target,0);
  e.reorderLayers([target,second,'layer-1']);return {e,target,second,source};
}
function samples(e,uids){const tick=e.tick,result=[];for(let t=0;t<e.totalTicks;t++){e.seek(t);const frame=e.evaluatedFrame;result.push(frame.objects.filter(o=>uids.includes(o.unique_id)).map(o=>[o.unique_id,poseObjectSignature(o,frame),o._movieclipSample]).sort((a,b)=>a[0]-b[0]));}e.seek(tick);return result;}
function checkState(e){validateLayerState(e.report._styk.layers);validateLayerSheet(e.report);for(let tick=0;tick<e.totalTicks;tick++){e.seek(tick);const ids=e.evaluatedFrame.objects.map(o=>o.unique_id);assert.equal(new Set(ids).size,ids.length);for(const uid of ids){assert.equal(e.getLayer(e.layerForUid(uid))?.kind,'layer');assert.ok(e.getLayerFigureUids(e.layerForUid(uid)).includes(uid));}}}
function history(e,before){const after=e.serialize();checkState(e);e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);checkState(engineEditor({demo:false,layerTimeline:true},after));}
function geometrySamples(e,uids){const tick=e.tick,result=[];for(let t=0;t<e.totalTicks;t++){e.seek(t);const frame=e.evaluatedFrame,geometry=e.geometry;result.push(frame.objects.filter(o=>uids.includes(o.unique_id)).map(o=>{
  const posed=geometry.objects.get(o.object_slot);return {uid:o.unique_id,points:[posed.root,...posed.segments.flatMap(s=>[s.start,s.end])].flatMap(p=>[p.x,p.y])};
}).sort((a,b)=>a.uid-b.uid));}e.seek(tick);return result;}
function equivalentGeometry(actual,expected){assert.equal(actual.length,expected.length);actual.forEach((frame,t)=>{assert.deepEqual(frame.map(o=>o.uid),expected[t].map(o=>o.uid));frame.forEach((o,i)=>o.points.forEach((v,j)=>assert.ok(Math.abs(v-expected[t][i].points[j])<1e-7,`tick ${t}, UID ${o.uid}, coordinate ${j}: ${v} != ${expected[t][i].points[j]}`)));});}

for(const destination of ['new','short','hold'])for(const operation of ['add-range','paste-one','paste-group','paste-foreign-clip','import'])test(`${operation} inserts into ${destination} layer without changing existing ownership or poses`,()=>{
  const {e,target,source}=fixture({destination});
  if(operation==='paste-one'){e.select(1);e.copySelection();}
  if(operation==='paste-group'){e.selectMany([1,2]);e.copySelection();}
  if(operation==='paste-foreign-clip'){
    const donor=fixture().e;donor.select(7);donor.copySelection();e._selectionClipboard=donor._selectionClipboard;
  }
  const original=samples(e,[1,2,7]);e.seek(5);e.selectSheetLayer(target);const before=e.serialize(),next=e._nextUid;
  if(operation==='add-range')e.addFigureInFrames(1,sheetRange(e,[5]));
  else if(operation==='import')e.importFigure(source);
  else e.pasteSelection();
  e.seek(5);const added=e.evaluatedFrame.objects.filter(o=>o.unique_id>=next);assert.equal(added.length,operation==='paste-group'?2:1);
  for(const object of added)assert.equal(e.layerForUid(object.unique_id),target);
  assert.deepEqual(samples(e,[1,2,7]),original);history(e,before);
});
for(const target of ['scene','camera'])test(`range insertions while ${target} is active use a user layer`,()=>{
  const {e}=fixture();e.seek(5);e.setActiveLayer(target);const before=e.serialize();
  const {insertedUids}=e.addFigureInFrames(1,sheetRange(e,[5]));e.seek(5);
  assert.equal(e.layerForUid(insertedUids[0]),e.report._styk.layers.defaultLayerId);assert.ok(e.evaluatedFrame.objects.some(o=>o.unique_id===insertedUids[0]));history(e,before);
});
test('moving a patched movieclip preserves every pose and source phase',()=>{
  const {e,target}=fixture();e.seek(4);e.select(7);e.deleteSelection();
  const original=samples(e,[1,2,7]),before=e.serialize();e.assignFiguresToLayer([7],target);
  assert.equal(e.layerForUid(7),target);assert.deepEqual(samples(e,[1,2,7]),original);history(e,before);
});
test('deleting a layer with historical assignments leaves valid ownership and preserves other layers',()=>{
  const {e,target,second}=fixture();e.seek(0);e.addFigure();const removed=e.selectedUid;e.deleteSelection();
  assert.equal(e.report._styk.layers.assignments[removed],target);
  const original=samples(e,[1,2,7]),before=e.serialize(),tracks=e.report._styk.layerSheet.tracks;e.deleteLayer(target);
  assert.equal(e.report._styk.layerSheet.tracks['layer-1'],tracks['layer-1']);assert.equal(e.report._styk.layerSheet.tracks[second],tracks[second]);
  assert.deepEqual(samples(e,[1,2,7]),original);history(e,before);
});

test('moving into an occupied layer preserves independent curves, gaps and movieclip phases',()=>{
  const {e,second}=fixture();e.sheetSetEasing(['layer-1'],0,19,{interpolation:'auto'});
  e.sheetInsertFrames([second],5,4);e.sheetClearFrames([second],2,3);
  e.seek(4);e.select(7);e.deleteSelection();
  const original=samples(e,[1,2,7]),before=e.serialize();e.assignFiguresToLayer([7],second);
  assert.deepEqual(samples(e,[1,2,7]),original);history(e,before);
});

test('moving a short layer into a vacant longer layer preserves its absence and destination extent',()=>{
  const {e,target,second}=fixture({destination:'hold'});e.sheetRemoveFrames([second],7,29);
  const original=samples(e,[1,2,7]),before=e.serialize(),end=e.report._styk.layerSheet.tracks[target].end;
  e.assignFiguresToLayer([2],target);
  assert.deepEqual(samples(e,[1,2,7]),original);assert.equal(e.report._styk.layerSheet.tracks[target].end,end);history(e,before);
});

test('ordinary group duplicates retain their owners after changing the active layer',()=>{
  const {e,target,second}=fixture();e.seek(0);e.selectMany([1,2]);e.setActiveLayer(target);const before=e.serialize(),next=e._nextUid;
  e.duplicateSelection();const copies=e.evaluatedFrame.objects.filter(o=>o.unique_id>=next);assert.equal(copies.length,2);
  for(const object of copies)assert.equal(e.layerForUid(object.unique_id),object.root_x<150?'layer-1':second);history(e,before);
});

test('a timeline clipboard remains pasteable after its original figures move to another layer',()=>{
  const {e,target,second}=fixture();e.sheetCopyFrames([second],0,3);e.assignFiguresToLayer([2],target);
  const original=samples(e,[1,2,7]),before=e.serialize(),next=e._nextUid;e.sheetPasteFrames([second],5);e.seek(5);
  assert.ok(e.evaluatedFrame.objects.some(o=>o.unique_id===next));assert.equal(e.layerForUid(next),second);
  assert.equal(e.layerForUid(2),target);assert.deepEqual(samples(e,[1,2,7]),original);history(e,before);
});

for(const destination of ['scene','camera'])test(`timeline figure paste rejects ${destination} atomically`,()=>{
  const {e,second}=fixture();e.sheetCopyFrames([second],0,3);const before=e.serialize(),undo=e._undo.length;
  assert.throws(()=>e.sheetPasteFrames([destination],5),/user layer|track kind/i);
  assert.deepEqual(e.serialize(),before);assert.equal(e._undo.length,undo);
});
test('timeline paste rejects duplicate destination rows atomically',()=>{
  const {e,target,second}=fixture();e.sheetCopyFrames(['layer-1',second],0,3);const before=e.serialize();
  assert.throws(()=>e.sheetPasteFrames([target,target],5),/distinct|unique/i);assert.deepEqual(e.serialize(),before);
});

test('moving figures to a layer in the background preserves the animation and supports history',async()=>{
  const {e,second}=fixture(),before=e.serialize(),original=samples(e,[1,2,7]);
  await e.assignFiguresToLayerAsync([7],second);
  assert.deepEqual(samples(e,[1,2,7]),original);history(e,before);
});

for(const operation of ['add','paste','range'])test(`${operation} beyond a populated short layer leaves its expired content absent`,()=>{
  const {e,second}=fixture();e.sheetRemoveFrames([second],2,29);e.seek(0);e.select(1);e.copySelection();
  const original=samples(e,[1,2,7]);e.seek(5);e.selectSheetLayer(second);const before=e.serialize();
  if(operation==='add')e.addFigure();else if(operation==='paste')e.pasteSelection();else e.addFigureInFrames(1,sheetRange(e,[5]));
  assert.deepEqual(samples(e,[1,2,7]),original);history(e,before);
});
test('deleting a layer clears assignments whose figures no longer have retained poses',()=>{
  const {e:source,target}=fixture(),document=source.serialize();document._styk.layers.assignments[123456]=target;
  const e=engineEditor({demo:false,layerTimeline:true}, document),before=e.serialize();
  e.deleteLayer(target);validateLayerState(e.report._styk.layers);history(e,before);
});

test('moving across layers preserves cross-layer attachment geometry',()=>{
  const {e,second}=fixture();e.seek(0);e.select(2);e.joinTo(1,1);e.sheetSetEasing(['layer-1'],0,19,{interpolation:'auto'});
  const original=geometrySamples(e,[1,2,7]),before=e.serialize();e.assignFiguresToLayer([1],second);
  equivalentGeometry(geometrySamples(e,[1,2,7]),original);history(e,before);
});

for(const childLayer of ['fallback','other'])test(`deleting a parent layer preserves attached figures on the ${childLayer} layer`,()=>{
  const report=emptyDocument(),figure=report.figure_types[0];report.keyframes=[0,1,2].map(index=>{
    const parent=createObject(figure,1,100+index*30,100),child=createObject(figure,2,300,100);
    parent.angles=parent.angles.map(a=>a+index*.4);child.angles=child.angles.map(a=>a+index*.4);child.join={target_object_slot:0,target_handle_id:1};
    return createFrame([parent,child,createObject(figure,3,500+index*10,300)],10);
  });
  const e=engineEditor({demo:false,layerTimeline:true}, report),second=e.createLayer('Fallback').id,third=e.createLayer('Other').id;
  e.assignFiguresToLayer([2],childLayer==='fallback'?second:third);e.assignFiguresToLayer([3],childLayer==='fallback'?third:second);
  const original=geometrySamples(e,[2,3]),before=e.serialize();e.deleteLayer('layer-1');
  equivalentGeometry(geometrySamples(e,[2,3]),original);history(e,before);
});

test('deleting layers preserves remaining movieclip patches and continuation phases',()=>{
  const {e,second}=fixture();e.seek(4);e.select(7);e.breakApartMovieclip();
  const kept=e.getLayerFigureUids('layer-1'),original=samples(e,kept),before=e.serialize();e.deleteLayer(second);
  assert.deepEqual(samples(e,kept),original);history(e,before);
});

for(const operation of ['range','group-paste','import','move','delete'])test(`locked layers reject ${operation} atomically`,()=>{
  const {e,target,source}=fixture();e.selectMany([1,2]);e.copySelection();e.selectSheetLayer(target);e.setLayerLocked(target,true);
  const before=e.serialize(),undo=e._undo.length;
  const execute=()=>{if(operation==='range')e.addFigureInFrames(1,sheetRange(e,[5]));else if(operation==='group-paste')e.pasteSelection();else if(operation==='import')e.importFigure(source);else if(operation==='move')e.assignFiguresToLayer([1],target);else e.deleteLayer(target);};
  assert.throws(execute,/Unlock/);assert.deepEqual(e.serialize(),before);assert.equal(e._undo.length,undo);
});

test('a sparse timeline paste preserves all interior poses and the source layer end',()=>{
  const {e,second,target}=fixture();e.sheetCopyFrames([second],0,29);const before=e.serialize(),next=e._nextUid;
  e.sheetPasteFrames([target],5);
  for(let tick=0;tick<35;tick++){
    e.seek(tick);const copy=e.evaluatedFrame.objects.find(o=>o.unique_id===next);
    if(tick>=5&&tick<26){assert.ok(copy,`copied pose at ${tick}`);assert.ok(Math.abs(copy.root_x-(200+tick-5))<1e-6);}
    else assert.equal(copy,undefined,`absence at ${tick}`);
  }
  history(e,before);
});
