import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {adoptLayerSheet,drawingSheetPlan,drawingSheetPublish} from '../src/editor-layer-sheet.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {createLayerState} from '../src/layers.mjs';
import {sampleLayerSheet,validateLayerSheet,validateLayerSheetChanges} from '../src/layer-sheet.mjs';
import {snapshotPoseFrame} from '../src/pose-snapshot.mjs';
import {continuations,setContinuations} from '../src/movieclip-presence.mjs';

function fixture({layers=4,figures=8}={}){
  const report=emptyDocument(),figure=report.figure_types[0],state=createLayerState();
  state.order=Array.from({length:layers},(_,i)=>`layer-${i+1}`);
  state.byId=Object.fromEntries(state.order.map(id=>[id,{name:id,visible:true,locked:false}]));
  state.nextId=layers+1;
  for(let uid=1;uid<=figures;uid++)state.assignments[uid]=state.order[(uid-1)%layers];
  report._styk={...report._styk,layers:state};
  report.keyframes=[0,10,20,30,40].map(tick=>createFrame(Array.from({length:figures},(_,i)=>createObject(figure,i+1,100+tick+i,200)),10));
  return new Editor({demo:false,layerTimeline:true,propertyChannels:true}).load(report);
}

test('one layer key edit retains untouched keys and immutable history endpoints',()=>{
  const editor=fixture(),before=editor.report._styk.layerSheet,original=structuredClone(before),other=before.tracks['layer-2'];
  for(const track of Object.values(before.tracks))for(const key of track.keys)Object.freeze(key);
  editor.sheetInsertKey(['layer-1'],5);
  const changed=editor.report._styk.layerSheet.tracks['layer-1'];
  assert.equal(editor.report._styk.layerSheet.tracks['layer-2'],other);
  for(const key of before.tracks['layer-1'].keys.filter(key=>key.tick>=20))assert.equal(changed.keys.find(value=>value.id===key.id),key);
  assert.deepEqual(before,original);
  const after=editor.serialize();editor.undo();assert.equal(editor.report._styk.layerSheet,before);editor.redo();assert.deepEqual(editor.serialize(),after);
  editor.drawingResources.dispose();
});

test('retiming, easing and frame replacement copy frozen keys before mutation',()=>{
  const actions=[
    editor=>editor.sheetSetEasing(['layer-1'],10,10,{interpolation:'constant'}),
    editor=>editor.sheetInsertFrames(['layer-1'],10,3),
    editor=>editor.sheetRemoveFrames(['layer-1'],10,12),
    editor=>editor.sheetDuplicateFrameAfter(['layer-1'],10),
    editor=>editor.sheetMoveFrames(['layer-1'],10,20,5),
    editor=>editor.sheetMoveFrames(['layer-1'],10,20,5,{copy:true}),
    editor=>{editor.sheetCopyFrames(['layer-1'],0,10);editor.sheetPasteFrames(['layer-1'],15,{insert:true});},
  ];
  for(const action of actions){
    const editor=fixture(),before=editor.serialize(),state=editor.report._styk.layerSheet,original=structuredClone(state);
    for(const track of Object.values(state.tracks))for(const key of track.keys)Object.freeze(key);
    action(editor);assert.deepEqual(state,original);const after=editor.serialize();
    editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
    editor.drawingResources.dispose();
  }
});

test('materializing a retained key twice reuses its owned copy and source',()=>{
  const editor=fixture(),before=structuredClone(editor.report._styk.layerSheet),plan=drawingSheetPlan(editor,['layer-1']),retained=plan.get('layer-1').keys[0];
  const first=plan.materialize('layer-1',retained),second=plan.materialize('layer-1',retained);
  assert.equal(second,first);assert.equal(plan.sources.length,1);assert.equal(plan.get('layer-1').keys[0],first);
  assert.deepEqual(editor.report._styk.layerSheet,before);editor.drawingResources.dispose();
});

test('local publication skips unchanged key validation while explicit validation still traverses it',()=>{
  const editor=fixture(),key=editor.report._styk.layerSheet.tracks['layer-2'].keys.at(-1),easing=key.interpolation;
  // The engine validated the document as it opened it: the editor's own checks have not seen it yet.
  validateLayerSheet(editor.report);
  let reads=0;Object.defineProperty(key,'interpolation',{enumerable:true,configurable:true,get(){reads++;return easing;}});
  editor.sheetInsertKey(['layer-1'],5);
  assert.equal(reads,0,'An unrelated far-away key must not be revalidated by a local command.');
  editor.undo();editor.redo();editor.undo();editor.sheetInsertKey(['layer-1'],6);
  assert.equal(reads,0,'Undo/source-table removal must not force validation of unrelated imported keys.');
  validateLayerSheet(editor.report);assert.ok(reads>0,'Explicit document validation must remain complete.');
  editor.drawingResources.dispose();
});

test('incremental validation preserves global identities and rejects invalid candidates atomically',()=>{
  const editor=fixture(),report=editor.report,state=report._styk.layerSheet;
  const candidate=change=>{const sheet={...state,tracks:{...state.tracks,'layer-1':{...state.tracks['layer-1'],keys:state.tracks['layer-1'].keys.map(key=>({...key}))}}};change(sheet);return {...report,_styk:{...report._styk,layerSheet:sheet}};};
  const corruptions=[
    sheet=>{sheet.tracks['layer-1'].keys[0].id=state.tracks['layer-2'].keys[0].id;},
    sheet=>{sheet.nextId=1;},
    sheet=>{delete sheet.tracks.camera;},
    sheet=>{sheet.tracks['layer-1'].end=sheet.duration+1;},
    sheet=>{sheet.tracks['layer-1'].keys.reverse();},
    sheet=>{delete sheet.tracks['layer-1'].keys[0].sourceTick;sheet.tracks['layer-1'].keys[0].value={frameId:'missing'};},
  ];
  for(const corrupt of corruptions){
    const invalid=candidate(corrupt);
    assert.throws(()=>validateLayerSheetChanges(invalid,report));assert.throws(()=>validateLayerSheet(invalid));
    assert.equal(validateLayerSheetChanges(report,report),report,'A failed candidate must leave the last valid ID index intact.');
  }
  editor.drawingResources.dispose();
});

test('replacing the source dictionary forces validation of retained track references',()=>{
  const editor=fixture();editor.sheetInsertKey(['layer-1'],5);validateLayerSheet(editor.report);
  editor.report._styk.frameSources={};
  assert.throws(()=>validateLayerSheetChanges(editor.report,editor.report),/missing pose/i);
  editor.drawingResources.dispose();
});

test('replacing an existing source rechecks retained patch replacement identities',()=>{
  const editor=fixture();editor.sheetInsertKey(['layer-1'],5);
  const key=editor.report._styk.layerSheet.tracks['layer-1'].keys.find(key=>key.tick===5),id=key.value.frameId;
  key.movieclipPatches=[{uid:1,frameId:id,replacementUid:1}];validateLayerSheet(editor.report);
  const source=editor.report._styk.frameSources[id];editor.report._styk.frameSources[id]={...source,objects:source.objects.filter(object=>object.unique_id!==1)};
  assert.throws(()=>validateLayerSheetChanges(editor.report,editor.report),/replacement/i);
  assert.throws(()=>validateLayerSheet(editor.report),/replacement/i);
  editor.drawingResources.dispose();
});

test('shared native samples are partitioned once while preserving layer order, joins and continuations',()=>{
  const editor=fixture({layers:20,figures:200}),report=editor.report,native=structuredClone(report.keyframes[0]);
  native.object_draw_order=native.objects.map((_,i)=>i).reverse();
  native.objects[1].join={target_object_slot:0,target_unique_id:1,attachment:1};
  const original=structuredClone(native);
  const steps=report._styk.layers.order.map((id,i)=>({uid:i+1,typeId:1,playback:{clock:'presence'}}));setContinuations(native,steps);
  const owned=native.objects.filter(object=>report._styk.layers.assignments[object.unique_id]==='layer-1').map(object=>object.unique_id),pose=snapshotPoseFrame(native,owned);
  setContinuations(pose,steps.filter(step=>owned.includes(step.uid)));
  pose._styk={...pose._styk,frameId:'authored'};report._styk.frameSources={authored:pose};
  const track=report._styk.layerSheet.tracks['layer-1'];report._styk.layerSheet={...report._styk.layerSheet,tracks:{...report._styk.layerSheet.tracks,'layer-1':{...track,keys:[{...track.keys[0],sourceTick:undefined,value:{frameId:'authored'},interpolation:'constant'}]}}};
  let reads=0;const instrumented={...native,objects:native.objects.map(object=>new Proxy(object,{get(target,key,receiver){if(key==='unique_id')reads++;return Reflect.get(target,key,receiver);}}))};
  const sampled=sampleLayerSheet(report,0,{sampleLegacy:()=>instrumented,sampleNative:source=>source.keyframes[0],resolveGeometry:()=>{throw new Error('Unexpected geometry resolution.');}});
  assert.ok(reads<=200*8+20*3,`Shared-source composition used ${reads} identity reads.`);
  const expected=report._styk.layers.order.flatMap(id=>native.object_draw_order.map(slot=>native.objects[slot].unique_id).filter(uid=>report._styk.layers.assignments[uid]===id));
  assert.deepEqual(sampled.objects.map(object=>object.unique_id),expected);
  const child=sampled.objects.find(object=>object.unique_id===2);assert.equal(sampled.objects[child.join.target_object_slot].unique_id,1);
  assert.deepEqual(continuations(sampled),steps);assert.deepEqual(native.objects,original.objects);
  editor.drawingResources.dispose();
});

test('adopting a prepared sheet skips endpoint filtering and preserves publication and history',()=>{
  const [expected,adopted]=[fixture(),fixture()];
  for(const editor of [expected,adopted]){
    editor.report._styk.custom={note:'retained metadata',values:[1,2,3]};
    editor.report.keyframes[0].objects[0].custom={note:'retained pose'};
    editor.report._styk.layerSheet.tracks['layer-1'].keys[0].custom={note:'retained key'};
  }
  const before=adopted.serialize(),state=adopted.report._styk.layerSheet,unchanged=state.tracks['layer-2'];
  const events=[[],[]];
  for(const [index,editor] of [expected,adopted].entries())editor.addEventListener('change',event=>events[index].push(structuredClone(event.detail)));
  expected.sheetInsertKey(['layer-1'],5);
  const command=expected._undo.at(-1),sheet=command.after;
  const tracks=Object.fromEntries(Object.entries(sheet.tracks).filter(([id,track])=>track!==command.before.tracks[id]));
  const sources=Object.fromEntries(command.frameSourceChanges.map(change=>[change.id,change.after.value]));
  let filters=0;
  const keys=[state.tracks['layer-1'].keys,tracks['layer-1'].keys];
  for(const array of keys)Object.defineProperty(array,'filter',{configurable:true,value:function(...args){filters++;return Array.prototype.filter.apply(this,args);}});
  try{
    adoptLayerSheet(adopted,{sheet:{...sheet,tracks},trackOrder:Object.keys(sheet.tracks),layers:command.afterLayers,
      sources,nextFrame:expected._nextFrameIdentity},command.label);
  }finally{for(const array of keys)delete array.filter;}
  assert.equal(filters,0,'A prepared adoption has no imported endpoints left to materialize.');
  assert.equal(adopted.report._styk.layerSheet.tracks['layer-2'],unchanged);
  assert.deepEqual(adopted.serialize(),expected.serialize());
  assert.deepEqual(adopted._undo,expected._undo);
  assert.equal(adopted.historySize,expected.historySize);
  assert.deepEqual(adopted._selectionState(),expected._selectionState());
  assert.deepEqual(events[1],events[0]);
  for(const tick of [0,4,5,9,10,20]){
    expected.seek(tick);adopted.seek(tick);
    assert.deepEqual(adopted.evaluatedFrame,expected.evaluatedFrame);
    assert.deepEqual(adopted.geometry.drawables,expected.geometry.drawables);
  }
  expected.seek(0);adopted.seek(0);
  const after=adopted.serialize();
  for(const editor of [expected,adopted]){editor.select(1);editor.beginTranslationDrag('Cancelled move');editor.moveSelection(4,2);editor.cancelDrag();}
  assert.deepEqual(adopted.serialize(),after);assert.deepEqual(adopted._undo,expected._undo);
  adopted.undo();assert.deepEqual(adopted.serialize(),before);adopted.redo();assert.deepEqual(adopted.serialize(),after);
  const valid=adopted.serialize(),history=adopted.historySize,nextFrame=adopted._nextFrameIdentity;
  const invalid=structuredClone(adopted.report._styk.layerSheet);
  invalid.tracks['layer-1'].keys[0].id=invalid.tracks.camera.keys[0].id;
  assert.throws(()=>adoptLayerSheet(adopted,{sheet:invalid,trackOrder:Object.keys(invalid.tracks),layers:adopted.report._styk.layers,
    nextFrame},'Invalid prepared sheet'),/unique identities/i);
  assert.deepEqual(adopted.serialize(),valid);assert.equal(adopted.historySize,history);assert.equal(adopted._nextFrameIdentity,nextFrame);
  for(const editor of [expected,adopted])editor.drawingResources.dispose();
});

test('ordinary plans still materialize changed imported endpoints before publication',()=>{
  const editor=fixture(),before=editor.serialize(),plan=drawingSheetPlan(editor,['layer-1']);
  const key=plan.ownKey('layer-1',plan.get('layer-1').keys[1]);key.interpolation='constant';
  const materialize=plan.materialize;let calls=0;
  plan.materialize=(...args)=>{calls++;return materialize(...args);};
  drawingSheetPublish(editor,plan,'Change imported easing');
  assert.equal(calls,2);assert.equal(plan.sources.length,2);
  const changed=editor.report._styk.layerSheet.tracks['layer-1'].keys;
  assert.equal(changed[0].sourceTick,0);
  for(const endpoint of changed.slice(1,3)){
    assert.equal(Object.hasOwn(endpoint,'sourceTick'),false);assert.ok(endpoint.value.frameId);
  }
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
  editor.drawingResources.dispose();
});


function layerMembership(editor){
  return {
    counts:[...editor._layerUidCounts],seen:[...editor._layerSeenUids],
    layers:editor.getLayers(),
    groups:editor.report._styk.layers.order.map(id=>[id,[...editor._layerGroups.get(id)]]),
    uids:editor.report._styk.layers.order.map(id=>[id,editor.getLayerFigureUids(id)]),
  };
}
function sameSheetPublication(expected,adopted){
  assert.deepEqual(adopted.serialize(),expected.serialize());
  assert.deepEqual(layerMembership(adopted),layerMembership(expected));
  assert.deepEqual(adopted._undo,expected._undo);assert.deepEqual(adopted._redo,expected._redo);
  assert.equal(adopted.historySize,expected.historySize);assert.equal(adopted.layerRevision,expected.layerRevision);
  for(const key of ['revision','_revisionSerial','_savedRevision','dirty','_nextFrameIdentity','_nextUid'])
    assert.equal(adopted[key],expected[key],`Publication preserves ${key}, including when history is trimmed.`);
  assert.deepEqual(adopted._selectionState(),expected._selectionState());
  assert.deepEqual([...adopted._generatedFrameSources],[...expected._generatedFrameSources]);
}
// The real ordinary command builds the prepared payload. Native compact answers
// omit an unchanged layers value, so adoption passes its current object instead.
function adoptSheetPublication(expected,adopted,action,{sameLayers=true}={}){
  const record=expected._record,events=[[],[]];let command;
  const listeners=events.map(list=>event=>list.push(structuredClone(event.detail)));
  expected.addEventListener('change',listeners[0]);adopted.addEventListener('change',listeners[1]);
  expected._record=function(value){const result=record.call(this,value);command=value;return result;};
  try{
    action(expected);assert.equal(command?.kind,'layer-sheet');
    const sheet=command.after,tracks=Object.fromEntries(Object.entries(sheet.tracks).filter(([id,track])=>track!==command.before.tracks[id]));
    const payload=structuredClone({sheet:{...sheet,tracks},trackOrder:Object.keys(sheet.tracks),
      sources:Object.fromEntries(command.frameSourceChanges.map(change=>[change.id,change.after.value])),
      nextFrame:expected._nextFrameIdentity,definitions:command.assets?.figure_types?.added});
    if(sameLayers)assert.deepEqual(command.afterLayers,adopted.report._styk.layers,'Only unchanged prepared layers may be omitted.');
    payload.layers=sameLayers?adopted.report._styk.layers:structuredClone(command.afterLayers);
    adopted._nextUid=expected._nextUid;
    adoptLayerSheet(adopted,payload,command.label,{selection:structuredClone(command.beforeSelection),retainGeometry:command.retainGeometry});
  }finally{
    expected._record=record;expected.removeEventListener('change',listeners[0]);adopted.removeEventListener('change',listeners[1]);
  }
  assert.deepEqual(events[1],events[0]);sameSheetPublication(expected,adopted);return command;
}

test('compact unchanged-layer adoption retains membership indexes through captures, paste and retiming',()=>{
  const [expected,adopted]=[fixture({layers:3,figures:6}),fixture({layers:3,figures:6})];
  for(const editor of [expected,adopted]){
    editor.report._styk.custom={note:'untouched metadata'};
    editor.report.keyframes[0].objects[0].custom={values:[3,7]};
  }
  const groups=adopted._layerGroups,layers=adopted.report._styk.layers,frames=adopted.report.keyframes,
    untouched=adopted.report._styk.layerSheet.tracks['layer-3'],arrays=new Map(layerMembership(adopted).uids);
  const actions=[editor=>editor.sheetInsertKey(['layer-1'],5),
    editor=>editor.sheetPasteFrames(['layer-1'],15,{insert:true}),
    editor=>editor.sheetMoveFrames(['layer-1'],5,10,2)];
  for(const editor of [expected,adopted])editor.sheetCopyFrames(['layer-1'],0,10);
  for(const action of actions){
    const revision=adopted.layerRevision;
    adoptSheetPublication(expected,adopted,action);
    assert.equal(adopted.layerRevision,revision+1);
    assert.equal(adopted._layerGroups,groups,'Existing source-count updates do not rebuild membership Sets.');
    for(const [id,values] of arrays)assert.equal(adopted.getLayerFigureUids(id),values,'Unchanged member arrays stay retained.');
    assert.equal(adopted.report._styk.layers,layers);assert.equal(adopted.report.keyframes,frames);
    assert.equal(adopted.report._styk.layerSheet.tracks['layer-3'],untouched);
  }
  const saved=adopted.serialize();
  for(const editor of [expected,adopted]){editor.select(1);editor.beginTranslationDrag();editor.moveSelection(4,2);editor.cancelDrag();}
  assert.deepEqual(adopted.serialize(),saved);sameSheetPublication(expected,adopted);
  for(const method of ['undo','redo']){expected[method]();adopted[method]();sameSheetPublication(expected,adopted);}
  for(const editor of [expected,adopted])editor.drawingResources.dispose();
});

test('changed-layer adoption reindexes new pasted identities and reordered layers',()=>{
  const [expected,adopted]=[fixture({layers:3,figures:6}),fixture({layers:3,figures:6})];
  for(const editor of [expected,adopted])editor.sheetCopyFrames(['layer-1'],0,10);
  const groups=adopted._layerGroups,arrays=new Map(layerMembership(adopted).uids),before=adopted.serialize();
  adoptSheetPublication(expected,adopted,editor=>editor.sheetPasteFrames(['layer-2'],5),{sameLayers:false});
  assert.notEqual(adopted._layerGroups,groups);
  for(const [id,values] of arrays)assert.notEqual(adopted.getLayerFigureUids(id),values,'Changed layers keep the complete index rebuild.');
  const added=adopted.getLayerFigureUids('layer-2').filter(uid=>uid>6);assert.ok(added.length>0);
  expected.undo();adopted.undo();sameSheetPublication(expected,adopted);assert.deepEqual(adopted.serialize(),before);
  expected.redo();adopted.redo();sameSheetPublication(expected,adopted);
  const priorGroups=adopted._layerGroups;
  adoptSheetPublication(expected,adopted,editor=>{
    const plan=drawingSheetPlan(editor,['layer-1']);plan.layers.order=plan.layers.order.slice().reverse();
    drawingSheetPublish(editor,plan,'Reorder prepared layers');
  },{sameLayers:false});
  assert.notEqual(adopted._layerGroups,priorGroups);
  assert.deepEqual(adopted.getLayers().filter(layer=>layer.kind==='layer').map(layer=>layer.id),['layer-3','layer-2','layer-1']);
  for(const method of ['undo','redo']){expected[method]();adopted[method]();sameSheetPublication(expected,adopted);}
  // Ordinary reorderLayers retains its groups; the next compact publication
  // must still follow the actual public layer/UID order, not Map key order.
  for(const editor of [expected,adopted])editor.reorderLayers(['layer-1','layer-3','layer-2']);
  adoptSheetPublication(expected,adopted,editor=>editor.sheetInsertKey(['layer-1'],7));
  for(const editor of [expected,adopted])editor.drawingResources.dispose();
});

test('compact publication preserves membership order through source GC, disappearance and reappearance',()=>{
  const [expected,adopted]=[fixture({layers:2,figures:2}),fixture({layers:2,figures:2})];
  const captured=[];
  for(const editor of [expected,adopted]){
    editor.historyLimit=0;
    const figure=editor.report.figure_types[0];
    captured.push([editor.captureFrameSource(createFrame([createObject(figure,77,150,200)])),
      editor.captureFrameSource(createFrame([createObject(figure,77,155,200)])),
      editor.captureFrameSource(createFrame([createObject(figure,88,160,200)]))]);
  }
  const groups=adopted._layerGroups,other=adopted.getLayerFigureUids('layer-2');
  const write=(uid,tick)=>editor=>{
    const plan=drawingSheetPlan(editor,['layer-1']);
    plan.write('layer-1',tick,createFrame([createObject(editor.report.figure_types[0],uid,180,210)]));
    drawingSheetPublish(editor,plan,'Keep one captured membership');
  };
  adoptSheetPublication(expected,adopted,write(77,5));
  assert.equal(adopted._layerGroups,groups);assert.equal(adopted.getLayerFigureUids('layer-2'),other);
  assert.deepEqual(adopted.getLayerFigureUids('layer-1'),[1,77]);assert.equal(adopted._layerUidCounts.get(77),1);
  assert.equal(adopted._layerUidCounts.has(88),false);assert.equal(adopted._undo.length,0);
  for(const [index,editor] of [expected,adopted].entries())for(const id of captured[index])assert.equal(Object.hasOwn(editor.report._styk.frameSources,id),false);
  for(const editor of [expected,adopted])editor.captureFrameSource(createFrame([createObject(editor.report.figure_types[0],88,190,215)]));
  const retained=adopted.getLayerFigureUids('layer-1');assert.deepEqual(retained,[1,77,88]);
  adoptSheetPublication(expected,adopted,write(88,7));
  assert.equal(adopted._layerGroups,groups);assert.equal(adopted.getLayerFigureUids('layer-1'),retained);
  assert.equal(adopted._layerUidCounts.get(88),1);assert.deepEqual(adopted.getLayerFigureUids('layer-1'),[1,77,88]);
  for(const editor of [expected,adopted])editor.drawingResources.dispose();
});

test('compact publication keeps history aliases and exact indexes when redo sources are retired',()=>{
  const [expected,adopted]=[fixture({layers:2,figures:4}),fixture({layers:2,figures:4})];
  for(const editor of [expected,adopted])editor.sheetCopyFrames(['layer-1'],0,10);
  adoptSheetPublication(expected,adopted,editor=>editor.sheetInsertKey(['layer-1'],5));
  const first=adopted._undo[0],history=JSON.stringify(first);
  adoptSheetPublication(expected,adopted,editor=>editor.sheetPasteFrames(['layer-2'],8),{sameLayers:false});
  expected.undo();adopted.undo();sameSheetPublication(expected,adopted);
  assert.ok(adopted._redo.length>0);
  adoptSheetPublication(expected,adopted,editor=>editor.sheetInsertKey(['layer-1'],7));
  assert.equal(adopted._redo.length,0);assert.equal(JSON.stringify(first),history,'Branch collection does not mutate retained command endpoints.');
  for(const method of ['undo','redo','undo','undo','redo','redo']){
    expected[method]();adopted[method]();sameSheetPublication(expected,adopted);
  }
  const valid=adopted.serialize(),members=layerMembership(adopted),revision=adopted.layerRevision,historySize=adopted.historySize,
    invalid=structuredClone(adopted.report._styk.layerSheet);
  invalid.tracks['layer-1'].keys[0].id=invalid.tracks.camera.keys[0].id;
  assert.throws(()=>adoptLayerSheet(adopted,{sheet:invalid,trackOrder:Object.keys(invalid.tracks),layers:adopted.report._styk.layers,
    nextFrame:adopted._nextFrameIdentity},'Invalid unchanged-layer sheet'),/unique identities/i);
  assert.deepEqual(adopted.serialize(),valid);assert.deepEqual(layerMembership(adopted),members);
  assert.equal(adopted.layerRevision,revision);assert.equal(adopted.historySize,historySize);
  for(const editor of [expected,adopted])editor.drawingResources.dispose();
});
