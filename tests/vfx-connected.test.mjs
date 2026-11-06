import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {connectedVfxConflict} from '../src/vfx-connected.mjs';
import {validateVfxOwner} from '../src/vfx.mjs';
function fixture(){
 const report=emptyDocument(),fig=report.figure_types[0];
 const objects=[1,2,3,4].map(id=>createObject(fig,id,120+id*20,180));
 objects[1].join={target_object_slot:0,target_unique_id:1,target_handle_id:1};
 objects[2].join={target_object_slot:1,target_unique_id:2,target_handle_id:1};
 report.keyframes=[createFrame(objects,10)];return report;
}
test('scope toggles with history, and an effect clip can include the attached figures',()=>{
 const report=fixture();report.keyframes[0].object_draw_order=[0,3,1,2];
 const editor=newOwnedEditor({demo:false,layerTimeline:true}).load(report),before=editor.serialize();
 assert.equal(connectedVfxConflict(editor.evaluatedFrame,1),null);
 editor.setVfxScope({kind:'figure',uid:1},true);assert.equal(editor.animationValue({kind:'figure',uid:1},'vfxScope'),1);
 editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
 const clip=editor.addVfxClip({kind:'figure',uid:1},'tint');editor.setVfxClip(clip,{includeAttached:true});
 assert.equal(editor.getVfxClips().find(c=>c.id===clip).includeAttached,true);
});

test('scope uses native exposure history and survives reopening without changing joins',()=>{
 const editor=newOwnedEditor({demo:false,layerTimeline:true}).load(fixture());
 const target={kind:'figure',uid:1},before=editor.serialize();editor.setVfxScope(target,true);
 assert.equal(editor.animationValue(target,'vfxScope'),1);editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
 const reopened=newOwnedEditor({demo:false}).load(editor.serialize());assert.equal(reopened.animationValue(target,'vfxScope'),1);assert.ok(reopened.evaluatedFrame.objects[1].join);
 assert.throws(()=>validateVfxOwner({_stykVfxScope:2}),/scope/);
});
test('VFX-only paste preserves identity, interpolates values and retains authored easing',()=>{
 const report=fixture();report.keyframes.push(structuredClone(report.keyframes[0]));
 const editor=newOwnedEditor({demo:false,layerTimeline:true}).load(report);
 const target={kind:'figure',uid:1},layer=editor.layerForUid(1);editor.sheetSetEasing([layer],0,0,{interpolation:'linear'});
 const [id]=editor.addVfx(target,'glow');editor.setVfxParameter(target,id,'radius',4);
 const copied=structuredClone(editor.vfxEffects(target));editor.seek(10);editor.pasteVfx(target,copied);editor.setVfxParameter(target,id,'radius',24);
 editor.seek(5);assert.equal(editor.vfxEffects(target)[0].params.radius,14);
 editor.seek(10);const before=editor.serialize();copied[0].params.radius=40;editor.pasteVfx(target,copied);
 assert.equal(editor.vfxEffects(target).length,1);assert.equal(editor.vfxEffects(target)[0].id,id);editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
 editor.seek(5);assert.equal(editor.vfxEffects(target)[0].params.radius,22);
 const reopened=newOwnedEditor({demo:false}).load(editor.serialize());reopened.seek(5);assert.equal(reopened.vfxEffects(target)[0].params.radius,22);
 const duplicate=editor.duplicateVfx(target,id);assert.notEqual(duplicate,id);
});
test('excessive nested scope is rejected',()=>{
 const report=fixture();
 const fig=report.figure_types[0],objects=Array.from({length:17},(_,i)=>createObject(fig,i+1,100,100,{_stykVfxScope:1,join:i?{target_object_slot:i-1,target_unique_id:i,target_handle_id:0}:null}));
 assert.match(connectedVfxConflict(createFrame(objects),1),/16 nested/);
});
