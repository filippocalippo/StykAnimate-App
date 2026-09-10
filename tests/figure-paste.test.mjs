import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';

function fixture(mode='native', {frames=4, parts=4, definitions=1}={}) {
  const report=emptyDocument(),figure=report.figure_types[0];
  for(let i=1;i<definitions;i++)report.figure_types.push({...structuredClone(figure),figure_type_id:i+1});
  report.keyframes=Array.from({length:frames},(_,i)=>createFrame(Array.from({length:parts},(_,slot)=>
    createObject(figure,slot+1,100+i*10,200,{join:slot?{target_object_slot:slot-1,target_handle_id:1,target_unique_id:slot}:null})),5));
  const editor=new Editor({demo:false,layerTimeline:mode==='sheet'}).load(report);
  if(mode==='authored')editor.adoptNativePoseTrack({kind:'layer',id:'layer-1'});
  editor.selectConnected(1);return editor;
}
const poses=e=>structuredClone(e.selectionFrame.objects.map(({runtime_segments,_movieclipSample,...object})=>object));
const trap=(object,key)=>{
  const descriptor=Object.getOwnPropertyDescriptor(object,key);
  Object.defineProperty(object,key,{enumerable:true,configurable:true,get(){throw Error(`Unrelated ${key} was traversed`);}});
  return ()=>{if(descriptor)Object.defineProperty(object,key,descriptor);else delete object[key];};
};

for(const mode of ['native','authored','sheet'])test(`${mode}: paste across frames owns copied poses and records one exact undo`,()=>{
  const e=fixture(mode),native=e.report.keyframes.slice();
  e.copySelection();const clipboard=structuredClone(e._selectionClipboard.objects);
  e.selectFrame(1);const before=poses(e),count=e._undo.length,events=[];
  e.addEventListener('change',event=>{if(event.detail.kind==='edit')events.push(event.detail);});
  const copies=e.pasteSelection(),ids=copies.map(o=>o.unique_id),after=poses(e);
  assert.equal(copies.length,4);assert.equal(e._undo.length,count+1);assert.equal(events.length,1);
  assert.equal(e.undoLabel,'Paste figures');assert.equal(e._selectionClipboard.pastes,1);
  assert.equal(copies[0].root_x,clipboard[0].root_x+24);
  for(const child of copies.slice(1))assert.ok(ids.includes(e.selectionFrame.objects[child.join.target_object_slot].unique_id));
  assert.deepEqual(e._selectionClipboard.objects,clipboard);
  if(mode==='native')assert.strictEqual(e.frame.objects[0],native[1].objects[0]);
  else for(let i=0;i<native.length;i++)assert.strictEqual(e.report.keyframes[i],native[i]);
  e.undo();assert.deepEqual(poses(e),before);e.redo();assert.deepEqual(poses(e),after);
  const again=e.pasteSelection();assert.equal(again[0].root_x,clipboard[0].root_x+48);
  const reopened=new Editor({demo:false,layerTimeline:mode==='sheet'}).load(e.serialize());reopened.seek(e.tick);
  const geometry=editor=>[...buildGeometry(editor.report,editor.selectionFrame).objects.values()].map(g=>({uid:g.obj.unique_id,joints:[...g.joints]}));
  assert.deepEqual(geometry(reopened),geometry(e));validateScene(e.report);
});

for(const mode of ['native','authored','sheet'])for(const crossDocument of [false,true])test(`${mode}: ${crossDocument?'cross-project':'same-project'} paste never traverses unrelated library contents`,()=>{
  const e=fixture(mode,{definitions:80});
  e.copySelection();if(crossDocument)e.load(e.serialize());
  const library=e.report.figure_types.slice();
  const restore=library.slice(1).map(figure=>trap(figure,'image_assets'));
  try{
    e.pasteSelection();e.undo();e.redo();
    for(let i=0;i<library.length;i++)assert.strictEqual(e.report.figure_types[i],library[i]);
    assert.ok(e._undo.at(-1).bytes<100000,'History must contain changed assets and poses only.');
  }finally{restore.forEach(fn=>fn());}
});

test('copy excludes runtime caches before cloning and keeps unknown saved fields independent',()=>{
  const e=fixture();e.geometry;
  e.object.extension={nested:[1,2,3]};
  const restore=[trap(e.object,'runtime_segments'),trap(e.object,'_movieclipSample')];
  try{e.copySelection();e.copyFigure();}finally{restore.forEach(fn=>fn());}
  const clipboard=e._selectionClipboard??e._figureClipboard;
  const object=clipboard.objects?.[0]??clipboard.object;
  assert.deepEqual(object.extension,{nested:[1,2,3]});e.object.extension.nested[0]=999;
  assert.equal(object.extension.nested[0],1);assert.ok(!('runtime_segments' in object));assert.ok(!('_movieclipSample' in object));
});

test('single and range paste remap changed handles and detach a copied join whose handle was removed',()=>{
  for(const range of [false,true]){
    const e=fixture();e.copySelection();
    const figure=e.report.figure_types[0],old=structuredClone(figure.segments);
    figure.segments=old.filter(s=>s.segment_id!==1).map(s=>({...s,parent_id:s.parent_id===1?0:s.parent_id}));
    figure.segment_count=figure.segments.length;
    // Use a valid empty destination after the source definition changed.
    e.report.keyframes=[createFrame([])];e.load(e.report);
    // Retain same-document semantics for the copied definition snapshot.
    e._selectionClipboard.documentToken=e._documentToken;
    if(range)e.pasteFiguresInFrames([0]);else e.pasteSelection();
    for(const object of e.selectedObjects){assert.equal(object.join,null);assert.equal(object.angles.length,figure.segments.length);}
    validateScene(e.report);
  }
});

test('locked-layer and invalid-pose paste failures publish no IDs, assets, history, selection or paste count',()=>{
  for(const invalid of ['locked','pose','capacity']){
    const e=fixture('sheet');e.copySelection();
    if(invalid==='locked')e.setLayerLocked('layer-1',true);
    if(invalid==='pose')e._selectionClipboard.objects[0].root_x=NaN;
    if(invalid==='capacity')e._nextUid=0x7ffffffe;
    const before=e.serialize(),ids=e._nextUid,sources=e._nextFrameIdentity,count=e._undo.length,selection=e._selectionState();
    assert.throws(()=>e.pasteSelection());assert.deepEqual(e.serialize(),before);assert.equal(e._nextUid,ids);
    assert.equal(e._nextFrameIdentity,sources);assert.equal(e._undo.length,count);assert.equal(e._selectionClipboard.pastes,0);
    assert.deepEqual(e._selectionState(),selection);
  }
});

test('cross-project sheet assets survive later edits and two undo/redo cycles independently of history',()=>{
  const e=fixture('sheet');e.copySelection();e.load(emptyDocument());
  const before=e.serialize();e.pasteSelection();const after=e.serialize(),type=e.object.figure_type_id;
  e.select(e.selectedUid,0);assert.equal(e.updateSegment({thickness:19}),true);e.undo();e.undo();assert.deepEqual(e.serialize(),before);
  e.redo();assert.deepEqual(e.serialize(),after);e.redo();
  assert.equal(e.report.figure_types.find(f=>f.figure_type_id===type).segments[0].thickness,19);
  e.undo();e.undo();e.redo();assert.deepEqual(e.serialize(),after);
});

test('Simple working-frame paste can be discarded and its undo restores the copied figures',()=>{
  const e=fixture();e.enableFrameDrafts();e.copySelection();e.beginFrameDraft({mode:'add',index:1});
  const before=poses(e);e.pasteSelection();const after=poses(e);assert.equal(e.frameDraft.dirty,true);
  e.discardFrameDraft();assert.deepEqual(poses(e),before);e.undo();assert.deepEqual(poses(e),after);
});

test('pasting across layers preserves internal attachments and leaves unrelated tracks untouched',()=>{
  const e=fixture('sheet');const layer=e.createLayer('Child');e.assignFiguresToLayer([2,3,4],layer.id);
  e.selectConnected(1);e.copySelection();e.selectFrame(1);
  const before=e.report._styk.layerSheet,copy=e.pasteSelection(),geometry=buildGeometry(e.report,e.evaluatedFrame);
  assert.equal(e.layerForUid(copy[0].unique_id),'layer-1');assert.equal(e.layerForUid(copy[1].unique_id),layer.id);
  assert.strictEqual(e.report._styk.layerSheet.tracks.camera,before.tracks.camera);
  assert.strictEqual(e.report._styk.layerSheet.tracks.scene,before.tracks.scene);
  for(const child of copy.slice(1))assert.deepEqual(geometry.objects.get(child.object_slot).root,geometry.objects.get(child.join.target_object_slot).joints.get(child.join.target_handle_id));
});

for(const mode of ['native','sheet'])test(`${mode}: paste, undo and redo reuse unchanged geometry with exact fresh-build parity`,()=>{
  const e=fixture(mode);e.copySelection();
  const original=e.geometry,signature=g=>[...g.objects.values()].map(o=>({uid:o.obj.unique_id,joints:[...o.joints]})).sort((a,b)=>a.uid-b.uid);
  for(const operation of ['pasteSelection','undo','redo']){
    e[operation]();const actual=e.geometry;
    assert.strictEqual(actual.objects.get(0),original.objects.get(0));
    assert.deepEqual(signature(actual),signature(buildGeometry(e.report,e.evaluatedFrame)));
  }
});
