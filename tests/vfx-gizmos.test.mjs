import test from 'node:test';
import assert from 'node:assert/strict';
import {VfxGizmos,vfxHandles,vfxHandleValues} from '../src/vfx-gizmos.mjs';
import {createVfx,VFX_REGISTRY} from '../src/vfx.mjs';

test('inactive VFX controls do not request scene evaluation or geometry',()=>{
  const gizmos=Object.create(VfxGizmos.prototype);
  gizmos.getOptions=()=>{throw new Error('Unexpected scene evaluation');};
  for(const inspector of [{visible:false},{visible:true,selectedEffect:()=>null},{visible:true,selectedEffect:()=>({effect:{enabled:false}})}]){
    gizmos.inspector=inspector;assert.equal(gizmos.control(),null);
  }
});

/** A gizmo over three drawables (figure 3 on a hidden layer; a movieclip instance has none) and an engine that says which figures figure 1's effects cover and what a clip paints. */
function measured(group,{hide=true,clips=[],extent=null,target={kind:'figure',uid:1}}={}){
  const item=(uid,x)=>({type:'line',thickness:2,obj:{unique_id:uid,scale:1},points:[{x,y:0},{x:x+10,y:10}]});
  const report={canvas_width:640,canvas_height:480,_styk:{layers:{defaultLayerId:'a',assignments:{1:'a',2:'a',3:'b'},byId:{a:{visible:true},b:{visible:!hide}}}}};
  const options={report,frame:{objects:[{unique_id:1,scale:2}]},geometry:{drawables:[...clips.includes(1)?[]:[item(1,0)],item(2,100),item(3,300)],objects:new Map(clips.map((uid,slot)=>[slot,{obj:{unique_id:uid},fig:{_styk:{movieclip:{}}}}]))},view:{x:0,y:0,scale:1},playing:false,vfxEnabled:true,resources:{}};
  const asked=[],extents=[];
  const editor={dragging:false,revision:1,tick:0,getLayer:()=>({locked:false}),layerForUid:()=>'a',_shown:{vfxGroup:uid=>{asked.push(uid);return group;},vfxExtent:uids=>{extents.push(uids);return extent;}}};
  const gizmos=Object.create(VfxGizmos.prototype);
  Object.assign(gizmos,{editor,getOptions:()=>options,inspector:{visible:true,selectedEffect:()=>({target,effect:{enabled:true,type:'glow',params:{}},includeAttached:true})}});
  return {control:gizmos.control(),asked,extents,gizmos,editor};
}

test('a figure that owns connected effects is measured with the visible figures the engine says they cover',()=>{
  const {control,asked}=measured([1,2,3]);
  // Items 1 and 2 span x 0..110; each is padded by half its stroke and 3.
  assert.deepEqual([control.bounds.x,control.bounds.width],[-4,118]);assert.equal(control.unit,2);
  assert.deepEqual(asked,[1]);
  assert.equal(measured([1,2,3],{hide:false}).control.bounds.width,318,'a figure on a visible layer is covered too');
});

test('a figure with no connected group is measured alone, and the engine is asked once per frame',()=>{
  const {control,gizmos,asked,editor}=measured(null);
  assert.equal(control.bounds.width,18);
  gizmos.control();gizmos.control();assert.deepEqual(asked,[1],'the answer is kept while the frame, the document and the playhead stay');
  editor.revision++;gizmos.control();assert.deepEqual(asked,[1,1]);
});

test('a segment effect on a movieclip instance measures that segment alone: the handle of a clip draws nothing, so no controls',()=>{
  const {control,extents}=measured(null,{clips:[1],extent:{x:10,y:20,width:100,height:200},target:{kind:'segment',uid:1,handleId:1,figureTypeId:7}});
  assert.equal(control,null);assert.deepEqual(extents,[],'the engine is not asked what the clip paints');
});

test('a movieclip instance is measured by what the engine says it paints, with the figures it covers',()=>{
  // Its geometry holds its handle alone: no drawable of figure 1. The engine measures the content.
  const alone=measured(null,{clips:[1],extent:{x:10,y:20,width:100,height:200}});
  assert.deepEqual(alone.control.bounds,{x:10,y:20,width:100,height:200});assert.deepEqual(alone.extents,[[1]]);
  // Figures that hang from it are measured with it.
  const grouped=measured([1,2],{clips:[1],extent:{x:-40,y:20,width:100,height:200}});
  assert.deepEqual([grouped.control.bounds.x,grouped.control.bounds.y,grouped.control.bounds.width,grouped.control.bounds.height],[-40,-4,154,224]);
  // The answer is kept while the frame, the document and the playhead stay.
  alone.gizmos.control();alone.gizmos.control();assert.equal(alone.extents.length,1);
  alone.editor.revision++;alone.gizmos.control();assert.equal(alone.extents.length,2);
  // A clip that paints nothing gives no controls; a figure that is no clip never asks.
  assert.equal(measured(null,{clips:[1],extent:null}).control,null);
  assert.deepEqual(measured(null).extents,[]);
});

/** A control as VfxGizmos.control() gives it: the effect, its bounds and, for a figure's generated effect, its emitter. */
const controlOf=(type,params,{target={kind:'figure',uid:1},bounds={x:100,y:50,width:200,height:300},origin=null}={})=>({
  target,effect:{type,enabled:true,params:{...createVfx(type,'e').params,...params}},bounds,unit:1,origin,options:{report:{canvas_width:960,canvas_height:540}}});

test('a figure\'s generated effect is handled from where the engine emits it: the root, or the selected joint',()=>{
  // The figure's bounds centre is (200, 200); the engine emits particles from its root point.
  const root={x:150,y:320},control=controlOf('particles',{direction:0,speed:10},{origin:root});
  const {center,handles}=vfxHandles(control),spray=handles.find(h=>h.kind==='spray');
  assert.deepEqual(center,root);
  assert.deepEqual(spray.point,{x:root.x+60,y:root.y},'the spray line starts at the emitter');
  // Dragging the spray handle straight up from the emitter aims the particles straight up.
  assert.equal(vfxHandleValues(control,spray,{x:root.x,y:root.y-60}).direction,-90);
  // An explosion on a figure starts at the middle of what the figure draws, as the engine places it.
  assert.deepEqual(vfxHandles(controlOf('explosion',{},{origin:null})).center,{x:200,y:200});
});

test('a scene\'s generated effect is handled from its own stage position, not the middle of the stage',()=>{
  const stage={x:0,y:0,width:960,height:540},control=controlOf('particles',{x:.25,y:.75,direction:0,speed:10},{target:{kind:'scene'},bounds:stage});
  const {center,handles}=vfxHandles(control),spray=handles.find(h=>h.kind==='spray');
  assert.deepEqual(center,{x:240,y:405});
  // Dragging the spray handle to the emitter's right keeps the direction at 0: measured from the emitter, not (480, 270).
  const values=vfxHandleValues(control,spray,{x:center.x+90,y:center.y});
  assert.equal(values.direction,0);assert.equal(values.speed,15);
  // The position handle moves the emitter on the stage.
  const moved=vfxHandleValues(control,handles.find(h=>h.kind==='center'),{x:480,y:270});
  assert.deepEqual([moved.x,moved.y],[.5,.5]);
});

test('a dissolve\'s progress runs round a ring (it has no direction); a wipe moves along its angle',()=>{
  const control=controlOf('dissolve',{progress:.25}),{center,handles,ring}=vfxHandles(control),handle=handles.find(h=>h.kind==='progress');
  assert.ok(ring&&Math.abs(ring.progress-.25)<1e-9);
  assert.ok(Math.abs(handle.point.x-(center.x+ring.radius))<1e-9&&Math.abs(handle.point.y-center.y)<1e-9,'a quarter of the way round, from the top');
  assert.ok(Math.abs(vfxHandleValues(control,handle,{x:center.x,y:center.y+40}).progress-.5)<1e-9,'half way round is half dissolved');
  // Past the top the progress holds at its end rather than jumping to the other.
  const drag={progress:.95};assert.equal(vfxHandleValues(controlOf('dissolve',{progress:.95}),handle,{x:center.x+10,y:center.y-60},drag).progress,1);
  assert.equal(vfxHandleValues(controlOf('dissolve',{progress:.05}),handle,{x:center.x-10,y:center.y-60},{progress:.05}).progress,0);
  // A directional dissolve (when the registry has it) is a wipe along its angle across the artwork.
  if(VFX_REGISTRY.dissolve.params.directional){
    const wipe=controlOf('dissolve',{directional:1,angle:0,progress:.5}),{handles:[w]}=vfxHandles(wipe);
    assert.equal(w.kind,'wipe');assert.ok(Math.abs(vfxHandleValues(wipe,w,{x:300,y:200}).progress-1)<1e-9);
  }
});
