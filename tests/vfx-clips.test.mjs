import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {initializeLayerSheet} from '../src/editor-layer-sheet.mjs';
import {vfxStack,vfxProperty,documentHasVfx} from '../src/vfx.mjs';
import {validateVfxClips,sampleVfxClip,clipContains,vfxRenderFrame} from '../src/vfx-clips.mjs';
import {connectedVfxGeometry} from '../src/vfx-connected.mjs';
import {snapshotPoseFrame} from '../src/pose-snapshot.mjs';
import {appendVfxRows,visibleVfxKeys} from '../src/vfx-clip-timeline.mjs';
import {filterVfxClips} from '../src/vfx-clip-inspector.mjs';
const target={kind:'figure',uid:1};
function fixture(sheet=true){const report=emptyDocument(),fig=report.figure_types[0];report.keyframes=[0,1,2].map(()=>createFrame([createObject(fig,1,120,180),createObject(fig,2,280,180)],10));const e=new Editor({demo:false}).load(report);if(sheet){initializeLayerSheet(e.report);e._invalidate({timing:true});}return e;}
test('extending a timed effect before its source preserves keyed animation and undo',()=>{
 const e=fixture(),id=e.addVfxClip(target,'glow',{start:10,duration:15}),fx=e.getVfxClips()[0].effects[0];
 for(const tick of [10,20,29])e.setVfxClipParameter(id,fx.id,'radius',tick,{key:true,tick});
 const property=vfxProperty('glow',fx.id,'radius');e.setVfxClipEasing(id,property,0,'ease-in');
 const before=e.report._styk.vfxClips,n=e._undo.length,samples=[10,15,20,24].map(tick=>e.sampleVfxClip(id,tick));
 e.trimVfxClipStart(id,4);const c=e.getVfxClips()[0];assert.deepEqual([c.start,c.duration,c.offset],[4,21,0]);
 assert.deepEqual(c.keys[property].map(k=>k.tick),[6,16,25]);assert.equal(c.keys[property][0].interpolation,'ease-in');
 assert.deepEqual([10,15,20,24].map(tick=>e.sampleVfxClip(id,tick)),samples);assert.equal(e.sampleVfxClip(id,4)[0].params.radius,10);
 validateVfxClips(structuredClone(e.report._styk.vfxClips));assert.equal(e._undo.length,n+1);const after=e.report._styk.vfxClips;e.undo();assert.equal(e.report._styk.vfxClips,before);e.redo();assert.equal(e.report._styk.vfxClips,after);
 e.trimVfxClipStart(id,8);assert.equal(e.getVfxClips()[0].keys,c.keys);e.trimVfxClipStart(id,4);assert.equal(e.getVfxClips()[0].keys,c.keys);
});
test('authored pose drafts invalidate composed effect geometry throughout a drag',()=>{
 const e=fixture();e.select(1);e.addVfxClip(target,'wave');const clips=e.report._styk.vfxClips;
 e.beginTranslationDrag();
 for(const delta of [10,30,-5]){
  vfxRenderFrame(e.report,e.evaluatedFrame); // Canvas controls read this before a move.
  e.moveSelection(delta,0,{fromStart:true});assert.equal(e.geometry.objects.get(0).root.x,120+delta);
 }
 e.commitDrag();assert.equal(e.geometry.objects.get(0).root.x,115);assert.equal(e.report._styk.vfxClips,clips);
 e.undo();assert.equal(e.geometry.objects.get(0).root.x,120);e.redo();assert.equal(e.geometry.objects.get(0).root.x,115);
});
for(const sheet of [false,true])test(`persistent effects sample every pose without authoring pose keys (${sheet})`,()=>{const e=fixture(sheet),poses=structuredClone(e.report.keyframes),id=e.addVfxClip(target,'glow');for(const tick of [0,5,12,29]){e.seek(tick);assert.equal(vfxStack(e.geometry.objects.get(0).obj)[0].type,'glow');assert.equal(vfxStack(e.evaluatedFrame.objects[0]).length,0);assert.equal(vfxStack(e.geometry.objects.get(1).obj).length,0);}assert.deepEqual(e.report.keyframes,poses);assert.ok(documentHasVfx(e.report));e.undo();assert.equal(e.getVfxClips().length,0);e.redo();const copy=new Editor({demo:false}).load(structuredClone(e.report));copy.seek(20);assert.equal(copy.getVfxClips()[0].id,id);assert.equal(vfxStack(copy.geometry.objects.get(0).obj).length,1);});
test('timed clips, fades, zero strength, trimming, keys and animation copy',()=>{const e=fixture(),id=e.addVfxClip(target,'tint',{start:4,duration:20}),effect=e.getVfxClips()[0].effects[0],property=vfxProperty('tint',effect.id,'mix');e.setVfxClipParameter(id,effect.id,'mix',0,{key:true,tick:4});e.setVfxClipParameter(id,effect.id,'mix',1,{key:true,tick:14});assert.equal(e.sampleVfxClip(id,9)[0].params.mix,.5);e.setVfxClip(id,{start:10});assert.equal(e.sampleVfxClip(id,15)[0].params.mix,.5);e.setVfxClip(id,{start:12,duration:18,offset:2});assert.equal(e.sampleVfxClip(id,15)[0].params.mix,.5);e.copyVfxClip(id);const pasted=e.pasteVfxClip(target,{start:40}),p=e.getVfxClips().find(c=>c.id===pasted);assert.notEqual(p.effects[0].id,effect.id);assert.equal(e.sampleVfxClip(pasted,43)[0].params.mix,.5);assert.equal(Object.values(p.keys)[0].length,2);e.setVfxClip(id,{strength:0});assert.ok(clipContains(e.getVfxClips()[0],15));e.setVfxClipEasing(pasted,Object.keys(p.keys)[0],0,'constant');assert.equal(e.sampleVfxClip(pasted,43)[0].params.mix,0);e.moveVfxClipKey(id,property,10,15);assert.equal(e.getVfxClips()[0].keys[property][1].tick,15);assert.throws(()=>e.moveVfxClipKey(id,property,15,0));});
test('effect preview is one undo step and Escape restores exact values',()=>{const e=fixture(),id=e.addVfxClip(target,'glow'),fx=e.getVfxClips()[0].effects[0],before=e.report._styk.vfxClips,n=e._undo.length;e.beginVfxClipEdit();for(let i=0;i<30;i++)e.setVfxClipParameter(id,fx.id,'radius',i);assert.equal(e._undo.length,n);e.cancelVfxClipEdit();assert.equal(e.report._styk.vfxClips,before);e.beginVfxClipEdit();e.setVfxClipParameter(id,fx.id,'radius',40);e.commitVfxClipEdit();assert.equal(e._undo.length,n+1);e.undo();assert.equal(e.report._styk.vfxClips,before);});

test('spatial edits publish keyed values together, preserve easing and reject invalid pairs',()=>{
 const e=fixture(),id=e.addVfxClip(target,'shadow'),fx=e.getVfxClips()[0].effects[0],x=vfxProperty('shadow',fx.id,'offsetX');
 e.setVfxClipParameter(id,fx.id,'offsetX',5,{key:true,tick:5});e.setVfxClipEasing(id,x,5,'ease-in');e.seek(5);
 const before=e.report._styk.vfxClips,undo=e._undo.length;assert.throws(()=>e.setVfxClipParameters(id,fx.id,{offsetX:20,offsetY:Infinity}));assert.equal(e.report._styk.vfxClips,before);
 e.beginVfxClipEdit();for(let i=10;i<=30;i++)e.setVfxClipParameters(id,fx.id,{offsetX:i,offsetY:i});e.commitVfxClipEdit();
 assert.equal(e._undo.length,undo+1);assert.equal(e.getVfxClips()[0].keys[x][0].interpolation,'ease-in');assert.equal(e.sampleVfxClip(id)[0].params.offsetY,30);
 const after=e.report._styk.vfxClips;assert.equal(e.setVfxClipParameters(id,fx.id,{offsetX:30,offsetY:30}),false);assert.equal(e.report._styk.vfxClips,after);
 e.undo();assert.equal(e.report._styk.vfxClips,before);e.redo();assert.equal(e.report._styk.vfxClips,after);
});

test('group reordering preserves parameter tables and supports undo, redo and locked layers',()=>{
 const e=fixture(),id=e.addVfxClip(target,'glow'),glow=e.getVfxClips()[0].effects[0].id,shadow=e.addVfxGroupEffect(id,'shadow');e.setVfxClipParameter(id,glow,'radius',30,{key:true});
 const before=e.report._styk.vfxClips,keys=e.getVfxClips()[0].keys;e.reorderVfxGroupEffect(id,glow,1);assert.deepEqual(e.getVfxClips()[0].effects.map(f=>f.id),[shadow,glow]);assert.equal(e.getVfxClips()[0].keys,keys);
 e.undo();assert.equal(e.report._styk.vfxClips,before);e.redo();e.setLayerLocked(e.layerForUid(1),true);const locked=e.report._styk.vfxClips;assert.throws(()=>e.reorderVfxGroupEffect(id,glow,0),/Unlock/);assert.equal(e.report._styk.vfxClips,locked);
});
test('scope composes all connected parts without copying effects onto them',()=>{const e=fixture();for(const frame of e.report.keyframes)frame.objects[1].join={target_object_slot:0,target_handle_id:1,target_unique_id:1};e._invalidate({timing:true});const id=e.addVfxClip(target,'outline');e.setVfxClip(id,{includeAttached:true});const view=connectedVfxGeometry(e.geometry,e.evaluatedFrame,e.report);assert.equal(view.orderedObjects.length,1);assert.equal(view.drawables[0]._movieclipOwner.effects.length,1);assert.equal(e.evaluatedFrame.objects[1]._stykVfx,undefined);});
test('scene snapshots exclude runtime effects',()=>{const e=fixture();e.addVfxClip({kind:'scene'},'tint');const frame=e.evaluatedFrame;assert.equal(vfxStack(frame).length,1);const saved=snapshotPoseFrame(frame);assert.equal(saved._vfxTimelineScene,undefined);assert.equal(saved._vfxTimelineTick,undefined);assert.equal(saved._stykVfx,undefined);});
test('twenty timed effects share one compact lane and order is independent of time',()=>{const e=fixture();for(let i=0;i<20;i++)e.addVfxClip(target,'glow',{start:i*10,duration:8});e._vfxTimelineVisible=true;const layer=e.getLayer(e.layerForUid(1)),rows=appendVfxRows([layer],e);assert.equal(rows.length,2);const first=e.getVfxClips()[0];e.setVfxClip(first.id,{start:250});assert.equal(e.getVfxClips()[0].id,first.id);e.moveVfxClipOrder(first.id,1);assert.equal(e.getVfxClips()[1].id,first.id);});
test('invalid state and locked edits fail atomically',()=>{const e=fixture(),id=e.addVfxClip(target,'glow'),before=e.report._styk.vfxClips;assert.throws(()=>e.setVfxClip(id,{duration:-1}));assert.equal(e.report._styk.vfxClips,before);const bad=structuredClone(before);bad.clips[0].target.uid=-1;assert.throws(()=>validateVfxClips(bad));e.setLayerLocked(e.layerForUid(1),true);assert.throws(()=>e.setVfxClip(id,{name:'Locked'}));assert.equal(e.report._styk.vfxClips,before);});

test('At playhead excludes the selected clip outside its range; All and Selected are explicit',()=>{
 const e=fixture(),always=e.addVfxClip(target,'glow'),timed=e.addVfxClip(target,'tint',{start:10,duration:10});
 const clips=e.getVfxClips(),ids=options=>filterVfxClips(clips,{selected:timed,...options}).map(c=>c.id);
 assert.deepEqual(ids({tick:9}),[always]);assert.deepEqual(ids({tick:10}),[always,timed]);assert.deepEqual(ids({tick:20}),[always]);
 assert.deepEqual(ids({view:'selected',tick:0}),[timed]);assert.deepEqual(ids({view:'all',query:'TINT'}),[timed]);
});
test('timeline shows only the primary selected figure and never adds parameter rows',()=>{
 const e=fixture(),id=e.addVfxClip(target,'glow'),c=e.getVfxClips()[0];e.setVfxClipParameter(id,c.effects[0].id,'radius',20,{key:true});
 const other=e.addVfxClip({kind:'figure',uid:2},'tint'),scene=e.addVfxClip({kind:'scene'},'blur');e._vfxTimelineVisible=true;e._vfxKeysVisible=true;e._selectedVfxClip=id;
 const rows=[e.getLayer('scene'),e.getLayer(e.layerForUid(1))],shown=()=>appendVfxRows(rows,e).filter(r=>r.kind==='vfx').flatMap(r=>r.clips.map(c=>c.id));
 assert.deepEqual(shown(),[id]);assert.equal(appendVfxRows(rows,e).some(r=>r.kind==='vfx-key'),false);
 e.select(2);assert.deepEqual(shown(),[other]);e.select(null);assert.deepEqual(shown(),[]);
 e._vfxTimelineScene=true;assert.deepEqual(shown(),[scene]);
});
test('At playhead filters inactive persistent effects by keyed strength and enabled state',()=>{
 const e=fixture(),id=e.addVfxClip(target,'glow'),fx=e.getVfxClips()[0].effects[0];
 e.setVfxClipParameter(id,fx.id,'effectStrength',0,{key:true,tick:0});e.setVfxClipParameter(id,fx.id,'effectStrength',1,{key:true,tick:10});
 const count=(tick,view)=>filterVfxClips(e.getVfxClips(),{tick,view,selected:id}).length;
 assert.equal(count(0),0);assert.equal(count(5),1);assert.equal(count(0,'selected'),1);
 e.setVfxClipParameter(id,fx.id,'enabled',0,{key:true,tick:20});assert.equal(count(25),0);
 e.setVfxClip(id,{enabled:false});assert.equal(count(25,'all'),1);assert.equal(count(25),0);
 // Switched off with its eye, a clip stays listed where it would play, so its eye can switch it back on.
 e.setVfxClip(id,{enabled:true});e.setVfxClipParameter(id,fx.id,'enabled',1,{key:true,tick:20});e.setVfxClip(id,{enabled:false});assert.equal(count(25),1);assert.equal(count(0),0);
});
test('inline diamonds move coincident keys atomically, preserve easing and undo together',()=>{
 const e=fixture(),id=e.addVfxClip(target,'glow'),fx=e.getVfxClips()[0].effects[0];
 for(const param of ['radius','intensity'])e.setVfxClipParameter(id,fx.id,param,1,{key:true,tick:5});
 const radius=vfxProperty('glow',fx.id,'radius');e.setVfxClipEasing(id,radius,5,'ease-in');e.setVfxClipParameter(id,fx.id,'radius',2,{key:true,tick:10});
 const before=e.report._styk.vfxClips,n=e._undo.length;assert.throws(()=>e.moveVfxClipKeys(id,5,10),/already exists/);assert.equal(e.report._styk.vfxClips,before);
 e.moveVfxClipKeys(id,5,7);assert.equal(e._undo.length,n+1);assert.ok(Object.values(e.getVfxClips()[0].keys).every(keys=>keys[0].tick===7));assert.equal(e.getVfxClips()[0].keys[radius][0].interpolation,'ease-in');
 e.undo();assert.equal(e.report._styk.vfxClips,before);e.deleteVfxClipKeys(id,5);assert.deepEqual(Object.keys(e.getVfxClips()[0].keys),[radius]);e.undo();assert.equal(e.report._styk.vfxClips,before);
});
test('key painting reads a bounded visible range and reuses projections after timing edits',()=>{
 let reads=0;const channel=Array.from({length:100000},(_,tick)=>({get tick(){reads++;return tick;}})),keys={radius:channel};
 const visible=visibleVfxKeys(keys,50000,51000,1);assert.ok(visible.length<=126);assert.ok(reads<3000,`Read ${reads} keys`);
 const before=reads;assert.equal(visibleVfxKeys(keys,50000,51000,1),visible);assert.equal(reads,before);
 assert.deepEqual(visibleVfxKeys({a:[{tick:1},{tick:7}],b:[{tick:1},{tick:5}]},0,10,14),[1,5,7]);
});

test('capturing an animated movieclip preserves source effect time and isolates other targets',()=>{const e=fixture(false),id=e.addVfxClip(target,'tint',{start:4,duration:15}),fx=e.getVfxClips()[0].effects[0];e.setVfxClipParameter(id,fx.id,'mix',0,{key:true,tick:4});e.setVfxClipParameter(id,fx.id,'mix',1,{key:true,tick:14});e.select(1);const figure=e.createMovieclip({start:5,end:20,replace:false});const report={...e.report,figure_types:[figure],keyframes:[createFrame([createObject(figure,90,120,180,{_stykMovieclip:{start:0}})],15),createFrame([createObject(figure,90,120,180,{_stykMovieclip:{start:0}})],1)],_styk:{}};const nested=new Editor({demo:false}).load(report);nested.seek(4);const item=nested.geometry.drawables.find(i=>vfxStack(i.obj).length);assert.ok(item);assert.equal(vfxStack(item.obj)[0].params.mix,.5);});
test('untrusted validation rechecks changed payloads and simultaneous work stays bounded',()=>{const e=fixture(),id=e.addVfxClip(target,'glow'),state=structuredClone(e.report._styk.vfxClips);validateVfxClips(state);state.clips[0].strength=Infinity;assert.throws(()=>validateVfxClips(state));for(let i=1;i<64;i++)e.addVfxClip(target,'glow');assert.throws(()=>e.addVfxClip(target,'glow'),/simultaneous/);assert.equal(e.getVfxClips().length,64);});
test('local effects stay local when another clip covers attached parts',()=>{
 const e=fixture();for(const frame of e.report.keyframes)frame.objects[1].join={target_object_slot:0,target_handle_id:1,target_unique_id:1};e._invalidate({timing:true});
 const local=e.addVfxClip(target,'tint'),assembly=e.addVfxClip(target,'outline');e.setVfxClip(assembly,{includeAttached:true});
 const view=connectedVfxGeometry(e.geometry,e.evaluatedFrame,e.report),items=view.orderedObjects[0].drawables;
 assert.deepEqual(items[0]._movieclipOwner.effects.map(f=>f.type),['outline']);
 assert.deepEqual(vfxStack(items.find(i=>i.obj.unique_id===1).obj).map(f=>f.type),['tint']);
 assert.equal(vfxStack(items.find(i=>i.obj.unique_id===2).obj).length,0);
 e.setVfxClip(assembly,{enabled:false});assert.equal(e.getVfxClips()[0].id,local);assert.equal(connectedVfxGeometry(e.geometry,e.evaluatedFrame,e.report).orderedObjects.length,2);
});
