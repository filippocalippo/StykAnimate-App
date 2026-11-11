import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {createVfx,vfxStack,vfxProperty,validateVfxStack,validateVfxValue,resolvedVfx,VFX_REGISTRY} from '../src/vfx.mjs';
import {VFX_PRESETS} from '../src/vfx-presets.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
function fixture(){const report=emptyDocument(),fig=report.figure_types[0];report.keyframes=[0,1,2].map(()=>createFrame([createObject(fig,1,120,180),createObject(fig,2,280,180)],10));return newOwnedEditor({demo:false,layerTimeline:true}).load(report);}
const target={kind:'figure',uid:1};
/** Keys the stack with `effect` added at the playhead: what `changeVfxStack(target,stack=>stack.push(effect))` does, with the stack as data. */
const pushVfx=(e,effect)=>e.addAnimationKey(target,'vfxStack',e.tick,validateVfxStack([...e.vfxEffects(target),effect]),{exactTarget:true});
test('registry validates effect payloads and rejects malformed/oversized values',()=>{assert.throws(()=>createVfx('bogus','fx1'));assert.throws(()=>validateVfxValue(vfxProperty('glow','fx1','radius'),Infinity));assert.throws(()=>validateVfxStack(Array.from({length:17},(_,i)=>createVfx('glow','f'+i))));assert.throws(()=>validateVfxStack([createVfx('glow','same'),createVfx('blur','same')]));});
test('effects survive edit/undo/reopen and isolate instances',()=>{const editor=fixture();editor.sheetInsertKey([editor.layerForUid(1)],10);editor.seek(10);const before=editor._undo.length,[id]=editor.addVfx(target,'glow');assert.equal(editor._undo.length,before+1);assert.equal(editor.vfxEffects(target)[0].id,id);assert.equal(vfxStack(editor.evaluatedFrame.objects[1]).length,0);editor.seek(5);assert.equal(editor.vfxEffects(target).length,0);editor.seek(10);editor.setVfxParameter(target,id,'radius',22);assert.equal(editor.vfxEffects(target)[0].params.radius,22);editor.undo();assert.equal(editor.vfxEffects(target)[0].params.radius,12);editor.redo();const reopened=newOwnedEditor({demo:false}).load(structuredClone(editor.report));reopened.seek(10);assert.equal(reopened.vfxEffects(target)[0].params.radius,22);validateAnimationDocument(editor.report);});
test('effect preview cancellation restores the original pose',()=>{const editor=fixture(),[id]=editor.addVfx(target,'tint');const property=vfxProperty('tint',id,'mix');editor.beginAnimationEdit(target,property,{exactTarget:true});editor.previewAnimationEdit(.8);assert.equal(editor.vfxEffects(target)[0].params.mix,.8);editor.cancelAnimationEdit();assert.equal(editor.vfxEffects(target)[0].params.mix,.5);});
test('held exposures use the same edit boundary as Properties without creating a VFX timeline',()=>{
 const e=fixture(true),layer=e.layerForUid(1);e.sheetSetEasing([layer],0,29,{interpolation:'constant'});const count=e.report._styk.layerSheet.tracks[layer].keys.length;
 e.seek(5);const [id]=e.addVfx(target,'glow');e.setVfxParameter(target,id,'radius',28);
 assert.equal(e.report._styk.layerSheet.tracks[layer].keys.length,count);assert.equal(e.report._styk.animation,undefined);
 e.seek(0);assert.equal(e.vfxEffects(target)[0].params.radius,28);e.undo();assert.equal(e.vfxEffects(target)[0].params.radius,12);
});
test('existing layer tween and frame insertion own effect timing',()=>{
 const e=fixture(true),layer=e.layerForUid(1),[id]=e.addVfx(target,'glow');
 const effect=structuredClone(e.vfxEffects(target)[0]);e.seek(10);pushVfx(e,effect);e.setVfxParameter(target,id,'radius',32);e.sheetSetEasing([layer],0,0,{interpolation:'linear'});
 e.seek(5);assert.equal(e.vfxEffects(target)[0].params.radius,22);
 e.sheetInsertFrames([layer],0,5);e.seek(10);assert.equal(e.vfxEffects(target)[0].params.radius,22);
});
test('effect order, duplicate, reset and presets use atomic document history',()=>{
 const e=fixture(true),[id]=e.addVfx(target,'glow');e.setVfxParameter(target,id,'radius',30);const duplicate=e.duplicateVfx(target,id);
 e.moveVfx(target,duplicate,-1);assert.equal(e.vfxEffects(target)[0].id,duplicate);e.resetVfx(target,duplicate);assert.equal(e.vfxEffects(target)[0].params.radius,12);
 const count=e._undo.length;e.applyVfxPreset([target,{kind:'figure',uid:2}],'Energy');assert.equal(e._undo.length,count+1);assert.equal(e.vfxEffects({kind:'figure',uid:2}).length,2);e.undo();assert.equal(e.vfxEffects({kind:'figure',uid:2}).length,0);
});
test('splitting a rig keeps effects on both physical pieces and undo restores ownership',()=>{
 const e=fixture(true);e.select(1,0);const original=e.figure.segments[0].segment_id,type=e.figure.figure_type_id,node={kind:'segment',uid:1,figureTypeId:type,handleId:original};
 e.addVfx(node,'tint');const before=e.serialize();e.splitSegment(.4);const added=e.figure.segments[0].segment_id;
 assert.notEqual(added,original);assert.equal(e.vfxEffects({...node,handleId:added})[0].type,'tint');assert.equal(e.vfxEffects(node)[0].type,'tint');e.undo();assert.deepEqual(e.serialize(),before);
});
test('legacy effects receive compatible defaults without mutating saved poses',()=>{
 const old={version:1,id:'old',type:'outline',enabled:true,params:{color:123,width:3,opacity:1}},snapshot=structuredClone(old),result=resolvedVfx(old);
 assert.equal(result.version,2);assert.equal(result.params.rounded,0);assert.equal(result.params.mode,0);assert.deepEqual(old,snapshot);assert.equal(resolvedVfx(old),result);
});
test('every VFX color supports bounded gradients, alpha, undo and native exposure interpolation',()=>{
 const paint={type:'linear',angle:90,stops:[{offset:0,color:[255,0,0],opacity:.4},{offset:1,color:[0,80,255],opacity:1}]};
 for(const [type,definition] of Object.entries(VFX_REGISTRY))for(const [param,d] of Object.entries(definition.params))if(d.type==='color')assert.deepEqual(validateVfxValue(vfxProperty(type,'test',param),paint),paint);
 const e=fixture(true),layer=e.layerForUid(1),[id]=e.addVfx(target,'glow');e.setVfxParameter(target,id,'color',paint);const before=e.serialize(),effect=structuredClone(e.vfxEffects(target)[0]);e.seek(10);pushVfx(e,effect);const next=structuredClone(paint);next.stops[0].color=[0,255,0];e.setVfxParameter(target,id,'color',next);e.sheetSetEasing([layer],0,0,{interpolation:'linear'});e.seek(5);assert.deepEqual(e.vfxEffects(target)[0].params.color.stops[0].color,[128,128,0]);
 const reopen=newOwnedEditor({demo:false}).load(structuredClone(e.report));reopen.seek(5);assert.deepEqual(reopen.vfxEffects(target),e.vfxEffects(target));assert.ok(before);
 assert.throws(()=>validateVfxValue(vfxProperty('glow',id,'color'),{...paint,stops:Array(33).fill(paint.stops[0])}));
});
test('presets validate, reordering is one history entry, and paste updates matching effect identities',()=>{
 const e=fixture(true);for(const [name,preset] of Object.entries(VFX_PRESETS)){const clean=fixture(true);clean.applyVfxPreset(target,name);assert.equal(clean.vfxEffects(target).length,preset.effects.length);validateVfxStack(clean.vfxEffects(target));}
 e.applyVfxPreset(target,'Power up');const old=e.vfxEffects(target).map(e=>e.id),history=e._undo.length;e.reorderVfx(target,old[0],1);assert.equal(e._undo.length,history+1);assert.deepEqual(e.vfxEffects(target).map(e=>e.id),old.toReversed());e.undo();assert.deepEqual(e.vfxEffects(target).map(e=>e.id),old);e.pasteVfx(target,e.vfxEffects(target));assert.equal(new Set(e.vfxEffects(target).map(e=>e.id)).size,2);
});
