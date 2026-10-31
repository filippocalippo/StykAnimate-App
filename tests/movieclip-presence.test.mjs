import test from 'node:test';
import assert from 'node:assert/strict';
import {engineEditor, newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument,createFrame,createObject,defaultFigure} from '../src/demo.mjs';
import {movieclipFigure,validatePlayback} from '../src/movieclips.mjs';
import {continuations} from '../src/movieclip-presence.mjs';
import {presencePlayback} from './support/movieclip-playback.mjs';
import {sceneAt} from './support/engine-geometry.mjs';
import {movieclipInspector} from './support/control-views.mjs';
import {pivotDocument, figureDocument} from './support/engine-export.mjs';

function fixture({duration=12,clipDuration=8,fps=24,clipFps=24,empty=false}={}){
  const child=defaultFigure(),document={...emptyDocument(),fps:clipFps};
  document.keyframes=Array.from({length:clipDuration},(_,i)=>createFrame([createObject(child,1,200+i*9,250)]));
  const clip=movieclipFigure(2,'Walking clip',document,{duration:clipDuration,pivot:{x:200,y:250}});
  const report={...emptyDocument(),fps,figure_types:[defaultFigure(),clip]};
  const objects=()=>empty?[]:[createObject(clip,7,300,300,{_stykMovieclip:presencePlayback()})];
  report.keyframes=duration===1?[createFrame(objects())]:[createFrame(objects(),duration-1),createFrame(objects())];
  const e=engineEditor({demo:false,layerTimeline:true}, report);e.select(7);return e;
}
/** The frame the engine shows for the editor at tick `t` (its playhead stays where it was). */
function frame(e,t){const at=e.tick;e.seek(t,{allowBeyondEnd:true});const shown=e.evaluatedFrame;e.seek(at);return shown;}
const phase=(e,t,uid=7)=>frame(e,t).objects.find(o=>o.unique_id===uid)?._movieclipSample??null;
const phases=(e,n=12,uid=7)=>Array.from({length:n},(_,t)=>phase(e,t,uid));
/** The shapes the engine draws at tick `t`, movieclip contents included. */
const shape=(e,t)=>sceneAt(e,t).drawables.map(d=>[d.type,d.rgb,d.alpha,d.points.map(p=>[+p.x.toFixed(5),+p.y.toFixed(5)])]);
function closeShape(actual,expected){
  assert.equal(actual.length,expected.length);
  actual.forEach((value,i)=>{assert.deepEqual(value.slice(0,3),expected[i].slice(0,3));assert.equal(value[3].length,expected[i][3].length);value[3].forEach((point,j)=>point.forEach((v,k)=>assert.ok(Math.abs(v-expected[i][3][j][k])<.0001,`point ${i}/${j}/${k}: ${v} != ${expected[i][3][j][k]}`)));});
}
const structure=e=>JSON.stringify({duration:e.totalTicks,tracks:Object.fromEntries(Object.entries(e.report._styk.layerSheet.tracks).map(([id,t])=>[id,{end:t.end,keys:t.keys.map(k=>[k.id,k.tick,k.interpolation])}]))});
const reopen=e=>newOwnedEditor({demo:false,layerTimeline:true}).load(JSON.parse(JSON.stringify(e.report)));

test('inserting a long asset adds only current presence, with no source-length scene extension',()=>{
  const e=fixture({duration:1,clipDuration:80,empty:true}),before=e.totalTicks,undo=e._undo.length;
  e.addFigure(2);const uid=e.selectedUid;
  assert.equal(e.totalTicks,before);assert.equal(phase(e,0,uid),0);assert.equal(e.object._stykMovieclip.clock,'presence');
  assert.equal(e.object._stykMovieclip.end,undefined);assert.equal(e._undo.length,undo+1);
  for(let t=1;t<6;t++){e.sheetAppendFrame();assert.equal(e.selectedUid,uid);assert.equal(phase(e,t,uid),t);}
  e.undo();assert.equal(e.totalTicks,5);e.redo();assert.equal(phase(e,5,uid),5);
});

test('insertion in the middle of a hold leaves its earlier frames untouched',()=>{
  const e=fixture({empty:true});e.sheetSetEasing(['layer-1'],0,11,{interpolation:'hold'});e.seek(4);e.addFigure(2);const uid=e.selectedUid;
  assert.equal(e.totalTicks,12);assert.equal(phase(e,3,uid),null);assert.equal(phase(e,4,uid),0);assert.equal(phase(e,5,uid),1);
});

test('gaps pause a stable instance, including multiple gaps and reverse/random seeking',()=>{
  const e=fixture();e.sheetClearFrames(['layer-1'],3);e.sheetClearFrames(['layer-1'],6,7);
  const expected=[0,1,2,null,3,4,null,null,5,6,7,0];
  assert.deepEqual(phases(e),expected);
  for(const t of [11,4,0,8,2,10,5])assert.equal(phase(e,t),expected[t]);
  assert.deepEqual(phases(reopen(e)),expected);
});

test('held and inserted output frames advance the clock; deleting time removes consumed steps',()=>{
  const e=fixture();assert.equal(phase(e,5),5);
  e.sheetInsertFrames(['layer-1'],3,2);assert.equal(e.totalTicks,14);assert.equal(phase(e,5),5);
  e.sheetRemoveFrames(['layer-1'],3,4);assert.equal(e.totalTicks,12);assert.equal(phase(e,5),5);
  e.sheetDuplicateFrameAfter(['layer-1'],2);assert.equal(phase(e,3),3);
});

test('playback controls never change scene duration or pose-key boundaries',()=>{
  const e=fixture(),before=structure(e);e.setMovieclipPlayback({speed:2,offset:1},{allFrames:true});
  assert.equal(structure(e),before);assert.deepEqual(phases(e,5),[1,3,5,7,1]);
  e.undo();assert.deepEqual(phases(e,5),[0,1,2,3,4]);e.redo();assert.equal(phase(e,3),7);
  const html=movieclipInspector(e,()=> '');assert.doesNotMatch(html,/Restart|Split here|data-movieclip-field="(?:start|end)"/);
  assert.throws(()=>validatePlayback({...presencePlayback(),end:5}),/membership/);
});

test('speed integration, different FPS, single frame, loops, once and final hold remain deterministic',()=>{
  const e=fixture({fps:48});e.setMovieclipPlayback({speed:.5},{allFrames:true});assert.equal(phase(e,6),1.5);
  e.setMovieclipPlayback({mode:'single',offset:3},{allFrames:true});assert.equal(phase(e,10),3);
  e.setMovieclipPlayback({mode:'hold',speed:10,offset:0},{allFrames:true});assert.equal(phase(e,10),7);
  e.setMovieclipPlayback({mode:'once'},{allFrames:true});assert.equal(phase(e,10),null);
});

test('removing inside a held exposure changes only that output frame',()=>{
  const e=fixture();e.sheetSetEasing(['layer-1'],0,11,{interpolation:'hold'});e.sheetInsertKey(['layer-1'],6);
  const before=shape(e,3),duration=e.totalTicks;e.seek(4);e.select(7);e.deleteSelection();
  assert.equal(e.totalTicks,duration);assert.deepEqual(shape(e,3),before);assert.deepEqual(phases(e,8),[0,1,2,3,null,4,5,6]);
  e.undo();assert.equal(phase(e,6),6);e.redo();assert.equal(phase(e,6),5);
});

test('removal preserves a deliberate reappearance after a missing frame',()=>{
  const e=fixture();e.sheetClearFrames(['layer-1'],5);e.seek(2);e.select(7);e.deleteSelection();
  assert.deepEqual(phases(e,8),[0,1,null,2,3,null,4,5]);
});

test('breaking one held frame preserves every rendered frame, phase, length and undo',()=>{
  const e=fixture(),before=Array.from({length:12},(_,t)=>shape(e,t)),duration=e.totalTicks;
  e.seek(4);e.select(7);const count=e._undo.length,children=e.breakApartMovieclip();
  assert.ok(children.length);assert.equal(e._undo.length,count+1);assert.equal(e.totalTicks,duration);
  assert.equal(phase(e,4),null);assert.equal(phase(e,5),5);assert.equal(continuations(frame(e,4))[0].uid,7);
  for(let t=0;t<12;t++)closeShape(shape(e,t),before[t]);
  assert.deepEqual(phases(reopen(e)),phases(e));e.undo();assert.equal(phase(e,4),4);e.redo();assert.equal(phase(e,5),5);
});

/** The frames of the layer sheet at these ticks, as the timeline chooses them. */
const sheetRange=(e,ticks)=>Object.assign([e.frameIndex],{sheetTicks:ticks});

test('adjacent, first, last and out-of-order breaks keep child identities and future phases',async()=>{
  const e=fixture();let children;
  for(const t of [4,0,11,3,5]){e.seek(t);e.select(7);const next=e.breakApartMovieclip();if(children)assert.deepEqual(next,children);children=next;}
  assert.equal(e.totalTicks,12);assert.deepEqual(phases(e),[null,1,2,null,null,null,6,7,0,1,2,null]);
  e.seek(6);e.select(7);const before=Array.from({length:12},(_,t)=>shape(e,t));
  await e.bakeMovieclip();for(let t=0;t<12;t++)closeShape(shape(e,t),before[t]);assert.ok(phases(e).every(v=>v===null));
});

test('deleting all broken children does not undo the consumed playback step',()=>{
  const e=fixture();e.seek(3);e.select(7);e.breakApartMovieclip();e.deleteSelection();
  assert.equal(phase(e,4),4);assert.equal(phase(reopen(e),4),4);
});

test('same-layer frame copies continue identity; cross-layer range copies remap once with phase',()=>{
  const e=fixture();e.seek(4);e.select(7);e.breakApartMovieclip();
  e.sheetCopyFrames(['layer-1'],3,7);const layer=e.createLayer('Copy');e.sheetPasteFrames([layer.id],0);
  const copy=frame(e,0).objects.find(o=>o._stykMovieclip&&o.unique_id!==7).unique_id;
  assert.deepEqual(phases(e,5,copy),[3,null,5,6,7]);assert.equal(phase(e,5),5);
  assert.equal(continuations(frame(e,1)).find(step=>step.uid!==7).uid,copy);
  assert.deepEqual(phases(reopen(e),5,copy),[3,null,5,6,7]);
  e.sheetCopyFrames(['layer-1'],0,2);e.sheetPasteFrames(['layer-1'],8);
  assert.deepEqual(phases(e,12),[0,1,2,3,null,5,6,7,0,1,2,3]);
});

test('cross-project clipboard carries broken frames, definitions and reserved identities',()=>{
  const e=fixture();e.seek(3);e.select(7);e.breakApartMovieclip();e.sheetCopyFrames(['layer-1'],2,5);
  const target=fixture({empty:true});target._sheetClipboard=structuredClone(e._sheetClipboard);target.sheetPasteFrames(['layer-1'],0);
  const uid=frame(target,0).objects.find(o=>o._stykMovieclip).unique_id;
  assert.deepEqual(phases(target,4,uid),[2,null,4,5]);assert.deepEqual(phases(reopen(target),4,uid),[2,null,4,5]);
});

test('Duplicate starts at frame one; colliding single-figure paste retains the copied source phase',()=>{
  const e=fixture();e.seek(5);e.select(7);e.duplicateFigure();const duplicate=e.selectedUid;
  assert.notEqual(duplicate,7);assert.equal(phase(e,5,duplicate),0);assert.equal(phase(e,6,duplicate),1);assert.equal(phase(e,6),6);
  e.select(7);e.copySelection();e.pasteSelection();assert.notEqual(e.selectedUid,7);assert.notEqual(e.selectedUid,duplicate);assert.equal(phase(e,5,e.selectedUid),5);assert.equal(phase(e,5),5);
});

test('hidden layers and opacity do not pause authored membership',()=>{
  const e=fixture();e.setLayerVisible('layer-1',false);assert.equal(phase(e,6),6);e.setLayerVisible('layer-1',true);
  e.select(7);e.updateObject({field28:255});assert.equal(phase(e,6),6);
});

test('portable imports use the new clock and legacy documents keep their saved clocks',()=>{
  const e=fixture(),portable=figureDocument(e.report,{figureUid:7}),target=fixture({empty:true});target.seek(4);target.importFigure(portable);
  assert.equal(target.object._stykMovieclip.clock,'presence');assert.equal(target.object._movieclipSample,0);assert.equal(target.totalTicks,12);
  const legacy=engineEditor();legacy.select(1);legacy.createMovieclip({start:3,end:12});const uid=legacy.selectedUid,before=phases(legacy,20,uid);
  const loaded=reopen(legacy);assert.deepEqual(phases(loaded,20,uid),before);
});

test('nested cropped movieclips retain source phase before and after entering the nested editor',()=>{
  const e=fixture();e.sheetClearFrames(['layer-1'],2);const before=Array.from({length:12},(_,t)=>shape(e,t));e.seek(4);e.select(7);
  e.createMovieclip({start:4,end:9});const type=e.figure.figure_type_id;
  for(let t=0;t<12;t++)closeShape(shape(e,t),before[t]);
  e.enterMovieclip(type);const local=Array.from({length:5},(_,t)=>shape(e,t));
  for(let t=0;t<5;t++)closeShape(local[t],before[t+4]);
  e.leaveMovieclip({save:false});for(let t=0;t<12;t++)closeShape(shape(e,t),before[t]);
});

test('Pivot expansion agrees with every rendered frame after gaps and breaks',()=>{
  const e=fixture();e.sheetClearFrames(['layer-1'],2);e.seek(5);e.select(7);e.breakApartMovieclip();
  const flat=pivotDocument(e.report);for(let t=0;t<12;t++)closeShape(shape(flat,t),shape(e,t));
});

test('large held scenes keep the clock exact while seeking',()=>{
  const e=fixture();e.sheetInsertFrames(['layer-1'],5,50000);
  for(const t of [45000,0,30000,49999])assert.equal(phase(e,t),t%8);
});

test('Break Apart preserves an eased outer motion and unrelated figures on its layer',()=>{
  const e=engineEditor({layerTimeline:true,propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:30});const uid=e.selectedUid;
  e.seek(8);e.select(uid);e.moveSelection(70,20);e.seek(20);e.select(uid);e.moveSelection(-40,40);
  e.sheetSetEasing(['layer-1'],0,29,{interpolation:'auto'});
  const before=Array.from({length:e.totalTicks},(_,t)=>shape(e,t));e.seek(7);e.select(uid);e.breakApartMovieclip();
  for(let t=0;t<e.totalTicks;t++)closeShape(shape(e,t),before[t]);
});

test('playback changes, Make unique and failed edits preserve unrelated layer identities and history',()=>{
  const e=fixture(),layer=e.createLayer('Other');e.setActiveLayer(layer.id);e.addFigure(1);e.setLayerLocked(layer.id,true);
  const track=e.report._styk.layerSheet.tracks[layer.id];e.seek(3);e.select(7);e.setMovieclipPlayback({speed:3},{allFrames:true});assert.equal(e.report._styk.layerSheet.tracks[layer.id],track);
  const before=e.serialize();assert.throws(()=>e.setMovieclipPlayback({speed:0},{allFrames:true}));assert.deepEqual(e.serialize(),before);
  e.makeMovieclipUnique();assert.equal(phase(e,3,e.selectedUid),1);assert.equal(phase(e,3),null);assert.equal(phase(e,4),4);assert.equal(e.report._styk.layerSheet.tracks[layer.id],track);e.undo();assert.deepEqual(e.serialize(),before);
});

test('an empty clip can be broken without extending time or losing its consumed step',()=>{
  const e=fixture(),type=e.createEmptyMovieclip('Empty');e.seek(0);e.addFigure(type.figure_type_id);const uid=e.selectedUid;
  e.seek(3);e.select(uid);assert.deepEqual(e.breakApartMovieclip(),[]);assert.equal(e.totalTicks,12);assert.equal(phase(e,4,uid),0);assert.ok(continuations(frame(e,3)).some(step=>step.uid===uid));
});

test('editing a broken pose or changing playback after a break preserves the remaining curve',()=>{
  const e=fixture();e.seek(3);e.select(7);const children=e.breakApartMovieclip(),before=Array.from({length:12},(_,t)=>shape(e,t));
  e.moveSelection(30,20);for(let t=0;t<12;t++)if(t!==3)closeShape(shape(e,t),before[t]);
  e.seek(4);e.select(7);const structureBefore=structure(e);e.setMovieclipPlayback({speed:2},{allFrames:true});assert.equal(structure(e),structureBefore);
  assert.deepEqual(phases(e,8),[0,2,4,null,0,2,4,6]);assert.equal(frame(e,3).objects.find(o=>o.unique_id===children[0]).root_x,before[3][0][3][0][0]+30);
  e.makeMovieclipUnique();assert.equal(phase(reopen(e),4,e.selectedUid),0);assert.deepEqual(phases(reopen(e),8),[0,2,4,null,null,2,4,6]);
});

test('clearing, pasting over, and removing time at a broken frame restore the next frame correctly',()=>{
  for(const operation of ['clear','paste','remove']){
    const e=fixture();e.seek(3);e.select(7);e.breakApartMovieclip();
    if(operation==='clear'){e.sheetClearFrames(['layer-1'],3);assert.deepEqual(phases(e,6),[0,1,2,null,3,4]);}
    if(operation==='paste'){e.sheetCopyFrames(['layer-1'],0);e.sheetPasteFrames(['layer-1'],3);assert.deepEqual(phases(e,6),[0,1,2,3,4,5]);}
    if(operation==='remove'){e.sheetRemoveFrames(['layer-1'],3);assert.deepEqual(phases(e,6),[0,1,2,3,4,5]);}
    assert.deepEqual(phases(reopen(e),6),phases(e,6));
  }
});

test('several clips can break on the same frame without changing stacking or each other',()=>{
  const e=fixture();e.addFigure(2);const second=e.selectedUid,before=Array.from({length:12},(_,t)=>shape(e,t));
  for(const uid of [7,second]){e.seek(4);e.select(uid);e.breakApartMovieclip();}
  for(let t=0;t<12;t++)closeShape(shape(e,t),before[t]);assert.equal(phase(e,5,second),5);assert.equal(phase(e,5),5);
});

test('moving frames containing a break and copying only a broken frame keep valid sources and IDs',()=>{
  const e=fixture();e.seek(3);e.select(7);e.breakApartMovieclip();e.sheetMoveFrames(['layer-1'],3,4,2);
  assert.equal(phase(e,3),3);assert.equal(phase(e,5),null);assert.equal(phase(e,6),6);
  e.sheetCopyFrames(['layer-1'],5);const layer=e.createLayer('Broken copy');e.sheetPasteFrames([layer.id],0);
  const loaded=reopen(e);assert.ok(loaded._nextUid>Math.max(...continuations(frame(loaded,0)).map(step=>step.uid)));
  loaded.addFigure(2);assert.ok(loaded.selectedUid>7);reopen(loaded);
});

test('deleting a clip before its broken frame pauses one step and preserves the break',()=>{
  const e=fixture();e.seek(4);e.select(7);e.breakApartMovieclip();const broken=shape(e,4);e.seek(2);e.select(7);e.deleteSelection();
  assert.deepEqual(phases(e,8),[0,1,null,2,null,4,5,6]);closeShape(shape(e,4),broken);
});

test('moving a clip range to another layer preserves the later source phase and exact undo',()=>{
  const e=fixture(),layer=e.createLayer('Moved'),before=e.serialize();e.sheetTransferFrames(['layer-1'],[layer.id],3,6,3);
  const moved=frame(e,3).objects.find(object=>object._stykMovieclip&&object.unique_id!==7).unique_id;
  assert.deepEqual(phases(e,9),[0,1,2,null,null,null,null,7,0]);assert.equal(phase(e,3,moved),3);assert.equal(phase(e,6,moved),6);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(phase(reopen(e),7),7);
});

test('adjacent broken poses support exposure changes and interpolation as editable figures',()=>{
  const e=fixture();let child;
  for(const t of [3,4]){e.seek(t);e.select(7);[child]=e.breakApartMovieclip();}
  e.seek(4);e.select(child);e.moveSelection(100,0);
  const a=frame(e,3).objects.find(o=>o.unique_id===child).root_x,b=frame(e,4).objects.find(o=>o.unique_id===child).root_x;
  e.sheetInsertFrames(['layer-1'],4,2);e.sheetSetEasing(['layer-1'],3,3,{interpolation:'linear'});
  assert.ok(Math.abs(frame(e,4).objects.find(o=>o.unique_id===child).root_x-(a+(b-a)/3))<.0001);
  assert.equal(phase(e,7),7);assert.deepEqual(phases(reopen(e),9),phases(e,9));
});

test('breaking an attached clip preserves unrelated joins and detaches its attached child in place',()=>{
  const e=fixture();e.addFigure(1);const child=e.selectedUid;e.joinTo(7,0);e.addFigure(1);const sibling=e.selectedUid;e.addFigure(1);const tail=e.selectedUid;e.joinTo(sibling,1);
  const before=shape(e,3);e.seek(3);e.select(7);e.breakApartMovieclip();closeShape(shape(e,3),before);
  const result=frame(e,3),attached=result.objects.find(o=>o.unique_id===tail);
  assert.equal(result.objects[attached.join.target_object_slot].unique_id,sibling);assert.equal(result.objects.find(o=>o.unique_id===child).join,null);
  reopen(e);
});

test('repeated colliding pastes create fresh instances on the original layer and preserve existing poses',()=>{
  const e=fixture(),layer=e.createLayer('Other');e.copySelection();e.setActiveLayer(layer.id);
  const next=e._nextUid,ids=new Set([7]);
  for(const t of [5,5,1,9,1]){
    e.seek(t);const before=e.serialize(),history=e._undo.length;e.pasteSelection();const uid=e.selectedUid;
    assert.ok(!ids.has(uid));ids.add(uid);assert.equal(e.layerForUid(uid),'layer-1');assert.equal(e.object._movieclipSample,0);
    const objects=frame(e,t).objects;assert.equal(objects.find(o=>o.unique_id===7).root_x,300);assert.equal(new Set(objects.map(o=>o.unique_id)).size,objects.length);
    assert.equal(e._undo.length,history+1);const after=e.serialize();e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
  }
  assert.equal(e._nextUid,next+5);assert.deepEqual(phases(e,8),[0,1,2,3,4,5,6,7]);assert.deepEqual(phases(reopen(e),8),phases(e,8));
});

test('pasting into a held blank exposure never inserts the clip into its preceding frames',()=>{
  const e=fixture();e.copySelection();e.sheetClearFrames(['layer-1'],0,10);e.sheetSetEasing(['layer-1'],0,11,{interpolation:'hold'});
  e.seek(5);e.pasteSelection();assert.equal(e.selectedUid,7);assert.deepEqual(phases(e,8),[null,null,null,null,null,0,1,2]);assert.equal(e.totalTicks,12);
});

test('mixed movieclip paste retains absent identities while remapping collisions once per range',()=>{
 const e=fixture();e.addFigure(2);const second=e.selectedUid;e.selectMany([7,second]);e.copySelection();
 e.seek(4);e.select(second);e.deleteSelection();e.seek(6);e.select(second);e.deleteSelection();
 const before=e.serialize(),history=e._undo.length;
 const result=e.pasteFiguresInFrames(sheetRange(e,[4,6]));
 const fresh=result.insertedUids.find(uid=>uid!==second);assert.notEqual(fresh,7);assert.equal(result.insertedUids.length,2);
 for(const t of [4,6]){const ids=frame(e,t).objects.map(o=>o.unique_id);assert.ok(ids.includes(7)&&ids.includes(second)&&ids.includes(fresh));assert.equal(new Set(ids).size,ids.length);}
 assert.equal(e._undo.length,history+1);e.undo();assert.deepEqual(e.serialize(),before);e.redo();reopen(e);
});

test('a hidden completed instance still collides, and paste starts a visible copy without rewriting its clock',()=>{
 const e=fixture();e.setMovieclipPlayback({mode:'once'},{allFrames:true});e.copySelection();e.seek(9);
 assert.equal(phase(e,9),null);const before=e.serialize();e.pasteSelection();const uid=e.selectedUid;
 assert.notEqual(uid,7);assert.equal(phase(e,9,uid),0);assert.equal(phase(e,10,uid),1);assert.equal(phase(e,9),null);
 e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(phase(reopen(e),9,uid),0);
});

test('range paste reuses one movieclip identity and range delete removes only requested frames',()=>{
  const e=fixture();e.copySelection();e.sheetClearFrames(['layer-1'],0,11);
  e.pasteFiguresInFrames(sheetRange(e,[0,2,4]));assert.deepEqual(phases(e,6),[0,1,2,3,4,5]);
  e.select(7);const before=e.serialize();e.deleteFiguresInFrames(sheetRange(e,[1,3]));
  assert.deepEqual(phases(e,6),[0,null,1,null,2,3]);assert.deepEqual(phases(reopen(e),6),[0,null,1,null,2,3]);
  e.undo();assert.deepEqual(e.serialize(),before);
});

test('cut/paste moves presence without renaming it, and pasted mixed selections preserve joins',()=>{
  const e=fixture();e.addFigure(1);const child=e.selectedUid;e.joinTo(7,0);e.selectMany([7,child]);e.copySelection();
  e.seek(5);e.pasteSelection();const copy=e.selectedObjects.find(o=>o.figure_type_id!==2),parent=e.selectedObjects.find(o=>o.figure_type_id===2),result=frame(e,5);
  assert.notEqual(copy.figure_type_id,1);assert.notEqual(parent.unique_id,7);assert.notEqual(copy.unique_id,child);assert.equal(result.objects[copy.join.target_object_slot].unique_id,parent.unique_id);
  assert.equal(result.objects[result.objects.find(o=>o.unique_id===child).join.target_object_slot].unique_id,7);
  e.seek(2);e.select(7);e.cutSelection();assert.deepEqual(phases(e,5),[0,1,null,2,3]);
  e.seek(2);e.pasteSelection();assert.equal(e.selectedUid,7);assert.deepEqual(phases(e,5),[0,1,2,3,4]);reopen(e);
});

test('Duplicate selection and cross-document pastes allocate independent collision-free identities',()=>{
  const e=fixture();e.addFigure(2);const second=e.selectedUid;e.selectMany([7,second]);e.duplicateSelection();
  assert.ok(e.selectedObjects.every(o=>o.unique_id!==7&&o.unique_id!==second));assert.equal(new Set(frame(e,0).objects.map(o=>o.unique_id)).size,4);
  e.select(7);e.copySelection();const destination=fixture();destination._selectionClipboard=e._selectionClipboard;destination.seek(3);destination.pasteSelection();
  assert.notEqual(destination.selectedUid,7);assert.equal(phase(destination,3,destination.selectedUid),0);assert.equal(phase(destination,3),3);reopen(destination);
});

test('single-frame deletions handle scene edges, adjacent gaps, multiple clips and locks atomically',()=>{
  const e=fixture();e.addFigure(2);const second=e.selectedUid;
  for(const t of [0,11,4,3]){e.seek(t);e.selectMany([7,second]);e.deleteSelection();}
  assert.deepEqual(phases(e),[null,0,1,null,null,2,3,4,5,6,7,null]);assert.deepEqual(phases(e,12,second),[null,0,1,null,null,2,3,4,5,6,7,null]);
  const other=e.createLayer('Locked');e.setActiveLayer(other.id);e.seek(5);e.addFigure(2);const locked=e.selectedUid;e.setLayerLocked(other.id,true);
  e.selectMany([7,locked]);const before=e.serialize();assert.throws(()=>e.deleteSelection(),/Unlock/);assert.deepEqual(e.serialize(),before);reopen(e);
});

test('Make unique separates only this frame, preserves its phase and joins, and subsequent copies keep the new ID',()=>{
  const e=fixture();e.addFigure(1);const child=e.selectedUid;e.joinTo(7,0);const before=Array.from({length:12},(_,t)=>shape(e,t));
  e.seek(4);e.select(7);const originalType=e.figure.figure_type_id,saved=e.serialize();e.makeMovieclipUnique();const uid=e.selectedUid,type=e.figure.figure_type_id;
  assert.notEqual(uid,7);assert.notEqual(type,originalType);assert.equal(phase(e,4,uid),4);assert.equal(phase(e,4),null);
  for(let t=0;t<12;t++)closeShape(shape(e,t),before[t]);
  const current=frame(e,4);assert.equal(current.objects[current.objects.find(o=>o.unique_id===child).join.target_object_slot].unique_id,uid);
  e.undo();assert.deepEqual(e.serialize(),saved);e.redo();assert.equal(phase(reopen(e),4,uid),4);
  e.select(uid);e.setMovieclipPlayback({speed:2},{allFrames:true});assert.equal(phase(e,5),5);assert.equal(frame(e,4).objects.find(o=>o.unique_id===uid)._stykMovieclip.speed,2);
  e.copySelection();e.seek(6);e.pasteSelection();assert.equal(e.selectedUid,uid);assert.equal(phase(e,6,uid),6);assert.equal(frame(e,6).objects.find(o=>o.unique_id===7).figure_type_id,originalType);reopen(e);
});

test('pasting clips alongside frame-only breaks preserves unrelated curves and editable children',()=>{
  const e=engineEditor({layerTimeline:true,propertyChannels:true});e.select(1);e.createMovieclip({start:0,end:30});const uid=e.selectedUid;
  e.seek(8);e.select(uid);e.moveSelection(70,20);e.seek(20);e.select(uid);e.moveSelection(-40,40);e.sheetSetEasing(['layer-1'],0,29,{interpolation:'auto'});
  e.seek(7);e.select(uid);e.breakApartMovieclip();const before=Array.from({length:e.totalTicks},(_,t)=>shape(e,t));
  const asset=e.createEmptyMovieclip('Other');e.seek(0);e.addFigure(asset.figure_type_id);const other=e.selectedUid;e.copySelection();
  // Empty assets produce no drawables, so every original curve must match.
  for(const t of [7,11,7]){e.seek(t);const present=e.evaluatedFrame.objects.some(o=>o.unique_id===other);e.pasteSelection();assert.equal(e.selectedUid===other,!present);}
  for(let t=0;t<e.totalTicks;t++)closeShape(shape(e,t),before[t]);reopen(e);
});

test('timing changes affect every pasted appearance, including clips present only in patches',()=>{
  const e=fixture({empty:true});e.addFigure(2);const uid=e.selectedUid;e.copySelection();e.sheetClearFrames(['layer-1'],0,11);
  for(const t of [2,4])e.sheetInsertKey(['layer-1'],t);
  for(const t of [0,2,4]){e.seek(t);e.pasteSelection();}
  e.setMovieclipPlayback({speed:2,offset:1},{allFrames:true});assert.deepEqual(phases(e,8,uid),[1,3,5,7,1,3,5,7]);
  const saved=e.serialize();e.undo();assert.deepEqual(phases(e,8,uid),[0,1,2,3,4,5,6,7]);e.redo();assert.deepEqual(e.serialize(),saved);reopen(e);
});

test('editing playback on the current pasted exposure works without adding timeline boundaries',()=>{
  const e=fixture();e.copySelection();e.sheetClearFrames(['layer-1'],0,11);e.seek(4);e.pasteSelection();const before=structure(e);
  e.setMovieclipPlayback({speed:2,offset:1});assert.equal(structure(e),before);assert.equal(phase(e,4),1);assert.equal(phase(e,6),5);
  e.undo();assert.equal(phase(e,6),2);e.redo();assert.equal(phase(reopen(e),6),5);
});

