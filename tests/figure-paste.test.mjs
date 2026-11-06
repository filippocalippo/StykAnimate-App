import test from 'node:test';
import {pasteInFrames} from './support/figure-range.mjs';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

function fixture({frames=4, parts=4}={}) {
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:frames},(_,i)=>createFrame(Array.from({length:parts},(_,slot)=>
    createObject(figure,slot+1,100+i*10,200,{join:slot?{target_object_slot:slot-1,target_handle_id:1,target_unique_id:slot}:null})),5));
  const editor=open({demo:false,layerTimeline:true}, report);
  editor.selectConnected(1);return editor;
}
const poses=e=>structuredClone(e.selectionFrame.objects.map(({runtime_segments,_movieclipSample,...object})=>object));

test('paste across frames owns copied poses and records one exact undo',()=>{
  const e=fixture(),native=e.report.keyframes.slice();
  e.copySelection();const clipboard=structuredClone(e._selectionClipboard.objects);
  e.selectFrame(1);const before=poses(e),count=e._undo.length,events=[];
  e.addEventListener('change',event=>{if(event.detail.kind==='edit')events.push(event.detail);});
  const copies=e.pasteSelection(),ids=copies.map(o=>o.unique_id),after=poses(e);
  assert.equal(copies.length,4);assert.equal(e._undo.length,count+1);assert.equal(events.length,1);
  assert.equal(e.undoLabel,'Paste figures');assert.equal(e._selectionClipboard.pastes,1);
  assert.equal(copies[0].root_x,clipboard[0].root_x+24);
  for(const child of copies.slice(1))assert.ok(ids.includes(e.selectionFrame.objects[child.join.target_object_slot].unique_id));
  assert.deepEqual(e._selectionClipboard.objects,clipboard);
  for(let i=0;i<native.length;i++)assert.strictEqual(e.report.keyframes[i],native[i]);
  e.undo();assert.deepEqual(poses(e),before);e.redo();assert.deepEqual(poses(e),after);
  const again=e.pasteSelection();assert.equal(again[0].root_x,clipboard[0].root_x+48);
  const reopened=open({demo:false,layerTimeline:true},e.serialize());reopened.seek(e.tick);
  const geometry=editor=>[...editor.geometry.objects.values()].map(g=>({uid:g.obj.unique_id,joints:[...g.joints]}));
  assert.deepEqual(geometry(reopened),geometry(e));validateScene(e.report);
});

test('cross-project sheet assets survive later edits and two undo/redo cycles independently of history',()=>{
  const e=fixture();e.copySelection();e.load(emptyDocument());
  const before=e.serialize();e.pasteSelection();const after=e.serialize(),type=e.object.figure_type_id;
  e.select(e.selectedUid,0);assert.equal(e.updateSegment({thickness:19}),true);e.undo();e.undo();assert.deepEqual(e.serialize(),before);
  e.redo();assert.deepEqual(e.serialize(),after);e.redo();
  assert.equal(e.report.figure_types.find(f=>f.figure_type_id===type).segments[0].thickness,19);
  e.undo();e.undo();e.redo();assert.deepEqual(e.serialize(),after);
});

test('pasting a group uses the active layer, preserves attachments and leaves unrelated tracks untouched',()=>{
  const e=fixture();const layer=e.createLayer('Child');e.assignFiguresToLayer([2,3,4],layer.id);
  e.selectConnected(1);e.copySelection();e.selectFrame(1);
  const before=e.report._styk.layerSheet,copy=e.pasteSelection(),geometry=e.geometry;
  for(const object of copy)assert.equal(e.layerForUid(object.unique_id),layer.id);
  assert.strictEqual(e.report._styk.layerSheet.tracks['layer-1'],before.tracks['layer-1']);
  assert.strictEqual(e.report._styk.layerSheet.tracks.camera,before.tracks.camera);
  assert.strictEqual(e.report._styk.layerSheet.tracks.scene,before.tracks.scene);
  for(const child of copy.slice(1))assert.deepEqual(geometry.objects.get(child.object_slot).root,geometry.objects.get(child.join.target_object_slot).joints.get(child.join.target_handle_id));
});

test('default figure paste isolates builder edits, instance paste shares them',()=>{
  const e=fixture({parts:1});e.copySelection();
  const original=e.object.figure_type_id,before=poses(e),beforeFigures=structuredClone(e.report.figure_types);
  e.pasteSelection();const unique=e.object.figure_type_id;
  assert.notEqual(unique,original);const after=e.serialize();
  e.undo();assert.deepEqual(poses(e),before);assert.deepEqual(e.report.figure_types,beforeFigures);e.redo();assert.deepEqual(e.serialize(),after);
  e.select(e.selectedUid,0);e.updateSegment({thickness:37});
  assert.notEqual(e.report.figure_types.find(f=>f.figure_type_id===original).segments[0].thickness,37);
  e.pasteSelection();assert.notEqual(e.object.figure_type_id,unique);
  e.pasteSelection({pasteMode:'instance'});assert.equal(e.object.figure_type_id,original);
  e.select(e.selectedUid,0);e.updateSegment({thickness:41});
  assert.equal(e.report.figure_types.find(f=>f.figure_type_id===original).segments[0].thickness,41);
  validateScene(e.report);
});

test('range paste allocates one independent definition per copied type for the whole range',()=>{
  const e=fixture({parts:1});e.copySelection();const original=e.object.figure_type_id;
  const before=e.serialize();pasteInFrames(e, [1,2,3]);const after=e.serialize();
  const uid=e.selectedUid,types=[5,10,15].map(tick=>{e.seek(tick);return e.evaluatedFrame.objects.find(o=>o.unique_id===uid).figure_type_id;});
  assert.equal(new Set(types).size,1);assert.notEqual(types[0],original);
  assert.equal(e.report.figure_types.length,2);e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
});

test('a paste onto a locked layer fails and leaves the document, history and selection as they were',()=>{
  const e=fixture({parts:1});e.copySelection();e.setLayerLocked('layer-1',true);
  const before=e.serialize(),undo=e.undoLabel,selected=[...e.selectedUids];
  assert.throws(()=>e.pasteSelection());
  assert.deepEqual(e.serialize(),before);assert.equal(e.undoLabel,undo);assert.deepEqual([...e.selectedUids],selected);
});
