import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {connectedVfxGeometry,connectedVfxConflict} from '../src/vfx-connected.mjs';
import {createVfx,vfxStack,validateVfxOwner,vfxProperty} from '../src/vfx.mjs';
import {initializeLayerSheet} from '../src/editor-layer-sheet.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
function fixture(){
 const report=emptyDocument(),fig=report.figure_types[0];
 const objects=[1,2,3,4].map(id=>createObject(fig,id,120+id*20,180));
 objects[1].join={target_object_slot:0,target_unique_id:1,target_handle_id:1};
 objects[2].join={target_object_slot:1,target_unique_id:2,target_handle_id:1};
 report.keyframes=[createFrame(objects,10)];return report;
}
test('connected VFX isolate descendants once while retaining editable geometry and local effects',()=>{
 const report=fixture(),frame=report.keyframes[0],root=frame.objects[0];
 root._stykVfxScope=1;root._stykVfx={figure:[createVfx('outline','outer')]};frame.objects[1]._stykVfx={figure:[createVfx('glow','inner')]};
 const before=structuredClone(report),raw=buildGeometry(report,frame),view=connectedVfxGeometry(raw,frame,report);
 assert.deepEqual(view.orderedObjects.map(g=>g.obj.unique_id),[1,4]);
 const items=view.orderedObjects[0].drawables;assert.deepEqual(new Set(items.map(i=>i.obj.unique_id)),new Set([1,2,3]));
 assert.ok(items.every(i=>i._movieclipOwner.effects[0].id==='outer'));
 assert.ok(items.filter(i=>i.obj.unique_id===1).every(i=>!vfxStack(i.obj).length));
 assert.ok(items.filter(i=>i.obj.unique_id===2).every(i=>vfxStack(i.obj)[0].id==='inner'));
 assert.equal(view.objects.get(0).joints,raw.objects.get(0).joints);assert.equal(view.objects.get(1),raw.objects.get(1));
 assert.equal(connectedVfxGeometry(raw,frame,report),view);assert.deepEqual(report,before);
});
test('nested groups retain inner stacks and hidden descendants are excluded before filtering',()=>{
 const report=fixture(),frame=report.keyframes[0];
 for(const slot of [0,1]){frame.objects[slot]._stykVfxScope=1;frame.objects[slot]._stykVfx={figure:[createVfx('glow','fx'+slot)]};}
 const raw=buildGeometry(report,frame),view=connectedVfxGeometry(raw,frame,report);
 assert.equal(view.orderedObjects.length,2);assert.ok(view.orderedObjects[0].drawables.some(i=>i._movieclipInner?.owner.effects[0]?.id==='fx1'));
 const hidden=connectedVfxGeometry(raw,frame,report,new Set([3]));assert.ok(hidden.orderedObjects[0].drawables.every(i=>i.obj.unique_id!==3));
 assert.notEqual(view,hidden);
});
test('interleaved scope preserves native order, shared coordinates, history and editable identities',()=>{
 const report=fixture();report.keyframes[0].object_draw_order=[0,3,1,2];
 const editor=new Editor({demo:false}).load(report),before=editor.serialize();
 assert.equal(connectedVfxConflict(editor.evaluatedFrame,1),null);
 editor.setVfxScope({kind:'figure',uid:1},true);assert.equal(editor.animationValue({kind:'figure',uid:1},'vfxScope'),1);
 editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
 const clip=editor.addVfxClip({kind:'figure',uid:1},'tint');editor.setVfxClip(clip,{includeAttached:true});
 assert.equal(editor.getVfxClips().find(c=>c.id===clip).includeAttached,true);
 const frame=report.keyframes[0];frame.objects[0]._stykVfxScope=1;frame.objects[0]._stykVfx={figure:[createVfx('glow','fx')]};
 const original=structuredClone(report),raw=buildGeometry(report,frame),view=connectedVfxGeometry(raw,frame,report);
 assert.deepEqual(view.orderedObjects.map(g=>g.slot),[0,3,1]);assert.deepEqual(view.warnings,[]);
 const [back,foreign,front]=view.orderedObjects;
 assert.equal(foreign,raw.objects.get(3));assert.equal(back.drawables[0]._movieclipOwner,front.drawables[0]._movieclipOwner);
 assert.deepEqual(new Set(front.drawables.map(i=>i.obj.unique_id)),new Set([2,3]));
 assert.equal(view.objects.get(front.slot),front);assert.equal(view.connectedVfxAssemblies.get(0).length,back.drawables.length+front.drawables.length);
 assert.equal(connectedVfxGeometry(raw,frame,report),view);assert.deepEqual(report,original);
 const hidden=connectedVfxGeometry(raw,frame,report,new Set([2]));assert.ok(hidden.drawables.every(i=>i.obj.unique_id!==2));
 assert.deepEqual(hidden.orderedObjects.map(g=>g.slot),[0,3,2]);
});

test('nested interleaved assemblies retain each inner stack exactly once in each painter run',()=>{
 const report=fixture(),frame=report.keyframes[0];frame.object_draw_order=[2,3,1,0];
 for(const slot of [0,1]){frame.objects[slot]._stykVfxScope=1;frame.objects[slot]._stykVfx={figure:[createVfx('glow','fx'+slot)]};}
 const view=connectedVfxGeometry(buildGeometry(report,frame),frame,report);
 assert.deepEqual(view.orderedObjects.map(g=>g.slot),[2,3,0]);
 for(const item of view.drawables.filter(i=>i.obj.unique_id!==4)){
  assert.equal(item._movieclipOwner.effects[0].id,'fx0');
  if(item.obj.unique_id!==1)assert.equal(item._movieclipInner.owner.effects[0].id,'fx1');
 }
 assert.equal(new Set(view.orderedObjects.map(g=>g.slot)).size,view.orderedObjects.length);
});

test('interleaved effect coordinates follow translated, scaled, rotated and mirrored movieclips',()=>{
 const source=fixture(),frame=source.keyframes[0];frame.object_draw_order=[0,3,1,2];
 frame.objects[0]._stykVfxScope=1;frame.objects[0]._stykVfx={figure:[createVfx('wave','wave')]};
 const original=connectedVfxGeometry(buildGeometry(source,frame),frame,source),domain=original.drawables[0]._movieclipOwner.domainBounds;
 const figure=movieclipFigure(10,'Assembly',source,{duration:10}),report=emptyDocument();report.figure_types=[figure];
 report.keyframes=[createFrame([createObject(figure,10,400,300,{scale:2,angles:[Math.PI/2],image_text_flags:1})],10)];
 const geometry=buildGeometry(report,report.keyframes[0]),owners=geometry.drawables.map(i=>i._movieclipInner?.owner).filter(Boolean);
 assert.equal(new Set(owners).size,1);assert.equal(owners[0].scale,2);
 const actual=owners[0].domainBounds,expected={x:400+2*domain.y,y:300+2*domain.x,width:2*domain.height,height:2*domain.width};
 for(const key of Object.keys(expected))assert.ok(Math.abs(actual[key]-expected[key])<1e-8,`${key}: ${actual[key]} != ${expected[key]}`);
 assert.deepEqual(original.drawables[0]._movieclipOwner.domainBounds,domain);
});
test('scope uses native exposure history and survives reopening without changing joins',()=>{
 const editor=new Editor({demo:false}).load(fixture());initializeLayerSheet(editor.report);editor._invalidate({timing:true});
 const target={kind:'figure',uid:1},before=editor.serialize();editor.setVfxScope(target,true);
 assert.equal(editor.animationValue(target,'vfxScope'),1);editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
 const reopened=new Editor({demo:false}).load(editor.serialize());assert.equal(reopened.animationValue(target,'vfxScope'),1);assert.ok(reopened.evaluatedFrame.objects[1].join);
 assert.throws(()=>validateVfxOwner({_stykVfxScope:2}),/scope/);
});
test('VFX-only paste preserves identity, interpolates values and retains authored easing',()=>{
 const report=fixture();report.keyframes.push(structuredClone(report.keyframes[0]));
 const editor=new Editor({demo:false}).load(report);initializeLayerSheet(editor.report);editor._invalidate({timing:true});
 const target={kind:'figure',uid:1},layer=editor.layerForUid(1);editor.sheetSetEasing([layer],0,0,{interpolation:'linear'});
 const [id]=editor.addVfx(target,'glow');editor.setVfxParameter(target,id,'radius',4);
 const copied=structuredClone(editor.vfxEffects(target));editor.seek(10);editor.pasteVfx(target,copied);editor.setVfxParameter(target,id,'radius',24);
 editor.seek(5);assert.equal(editor.vfxEffects(target)[0].params.radius,14);
 editor.seek(10);const before=editor.serialize();copied[0].params.radius=40;editor.pasteVfx(target,copied);
 assert.equal(editor.vfxEffects(target).length,1);assert.equal(editor.vfxEffects(target)[0].id,id);editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
 editor.seek(5);assert.equal(editor.vfxEffects(target)[0].params.radius,22);
 const reopened=new Editor({demo:false}).load(editor.serialize());reopened.seek(5);assert.equal(reopened.vfxEffects(target)[0].params.radius,22);
 const duplicate=editor.duplicateVfx(target,id);assert.notEqual(duplicate,id);
});
test('legacy scalar channels do not override pasted values and retain their interpolation',()=>{
 const report=fixture();report.keyframes.push(structuredClone(report.keyframes[0]));const e=new Editor({demo:false}).load(report),target={kind:'figure',uid:1};
 const [id]=e.addVfx(target,'glow'),property=vfxProperty('glow',id,'radius');
 e.addAnimationKeys([{target,property,tick:0,value:4,interpolation:'linear',exactTarget:true}]);
 const stack=structuredClone(e.vfxEffects(target));stack[0].params.radius=24;e.seek(10);e.pasteVfx(target,stack);
 assert.equal(e.vfxEffects(target)[0].params.radius,24);e.seek(5);assert.equal(e.vfxEffects(target)[0].params.radius,14);
});
test('detaching a child changes assembly membership and excessive nested scope is rejected',()=>{
 const report=fixture(),frame=report.keyframes[0];frame.objects[0]._stykVfxScope=1;frame.objects[0]._stykVfx={figure:[createVfx('glow','fx')]};
 frame.objects[2].join=null;const view=connectedVfxGeometry(buildGeometry(report,frame),frame,report);
 assert.deepEqual(view.orderedObjects.map(g=>g.obj.unique_id),[1,3,4]);
 const fig=report.figure_types[0],objects=Array.from({length:17},(_,i)=>createObject(fig,i+1,100,100,{_stykVfxScope:1,join:i?{target_object_slot:i-1,target_unique_id:i,target_handle_id:0}:null}));
 assert.match(connectedVfxConflict(createFrame(objects),1),/16 nested/);
});
